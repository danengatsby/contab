'use strict';

// Joburile periodice ale aplicatiei (backup zilnic, digestul cu termene fiscale, resetul
// contului demo, igiena rate-limit, auto-poll SPV) — scoase din server.js. Modulele simple
// sunt require-uite direct; prin ctx vin doar dependintele legate de starea aplicatiei:
// doBackup/resetDemo (intoarse de modulele de rute) si map-urile de rate-limit din authRoutes.

const db = require('./db');
const log = require('./log');
const metrics = require('./metrics');
const uploadGuard = require('./uploadGuard');
const anaf = require('./anaf');
const bnr = require('./bnr');
const { pollSpv } = require('./anafService');
const { sendDeadlineDigests, sendNotifMail } = require('./notify');
const { pruneLoginAttempts } = require('./session');
const auditLog = require('./auditLog');
const { trackServerError } = require('./serverErrors');

// Ruleaza un job periodic cu plasa de siguranta: o eroare in callback (ex. un db.save() care
// arunca) e prinsa si logata — nu doboara procesul si nu impiedica rulele urmatoare.
// SI SINCRONA, SI ASINCRONA: `try/catch` singur nu vede o promisiune respinsa, deci un job async
// care uita `.catch()` ar fi murit TACUT. Joburile de azi (spv-poll, curs-bnr) isi trateaza corect
// promisiunile, deci plasa nu schimba nimic pentru ele — dar siguranta nu are voie sa depinda de
// memoria autorului urmator. Precedentul e real: `loginAttempts is not defined` a rulat din ora in
// ora ~24h in productie (14-15 iulie) fara ca cineva sa afle.
// Intervalele sunt unref() si tinute in `handles`: joburile nu au voie sa tina procesul in viata
// (serverul traieste prin app.listen) si nici sa supravietuiasca unui stop() — altfel un test sau
// un embedding care porneste joburile ar atarna la nesfarsit dupa inchiderea serverului.
const handles = [];
function esecJob(label, e, unde) {
  metrics.jobError(label, (e && e.message) || e);
  log.error('eroare in job periodic' + (unde ? ' (' + unde + ')' : ''), { job: label, err: e });
  try { trackServerError({ method: 'JOB', originalUrl: label }, e); } catch (_) { /* ignora */ }
}
function safeInterval(label, fn, ms) {
  const t = setInterval(() => {
    metrics.jobTick(label); // starea job-urilor apare in /api/metrics (admin)
    try {
      const r = fn();
      if (r && typeof r.then === 'function') r.catch((e) => esecJob(label, e, 'async'));
    } catch (e) {
      esecJob(label, e);
    }
  }, ms);
  if (t.unref) t.unref();
  handles.push(t);
  return t;
}

/**
 * Decizia de alerta pentru coada de persistenta — PURA, ca sa poata fi testata pe fiecare caz
 * (jobul de deasupra pastreaza doar efectele: log + email). Ordinea conteaza: inghetarea prin
 * conflict de scriitor e cea mai grava (nimic nu se mai scrie pana la restart), apoi intarzierea
 * (scrieri care traiesc doar in RAM), apoi esecurile repetate.
 */
function persistVerdict(s, opts) {
  const o = opts || {};
  const lagMs = o.lagMs || 60000;
  const fails = o.fails || 3;
  const kb = Math.round((s.pendingBytes || 0) / 1024);
  if (s.conflicted) return { alert: true, cod: 'conflict', motiv: 'persistenta INGHETATA (alt proces a scris in baza — conflict dbEpoch); e nevoie de restart' };
  if (s.pending && s.pendingAgeMs >= lagMs) {
    return { alert: true, cod: 'intarziere', motiv: 'scrieri necomise de ' + Math.round(s.pendingAgeMs / 1000) + 's (' + kb + ' KB in RAM)' };
  }
  if ((s.failStreak || 0) >= fails) return { alert: true, cod: 'esecuri', motiv: s.failStreak + ' esecuri consecutive de scriere' };
  return { alert: false, cod: null, motiv: null };
}

/** Opreste toate joburile pornite; intoarce cate intervale a curatat (idempotent). */
function stop() {
  let n = 0;
  while (handles.length) { clearInterval(handles.pop()); n += 1; }
  return n;
}

function start(ctx) {
  const { doBackup, resetDemo, registerAttempts, forgotAttempts, clientErrAttempts } = ctx;

  // Backup automat zilnic (daca e activat)
  safeInterval('backup', () => {
    const s = db.get().settings.backup || {};
    if (s.auto === false) return;
    const last = s.lastAt ? Date.parse(s.lastAt) : 0;
    if (Date.now() - last >= 24 * 3600 * 1000) {
      try { const r = doBackup(); metrics.jobResult('backup', r.name); console.log('Backup automat:', r.name); }
      catch (e) { metrics.jobError('backup', e.message); console.error('Backup:', e.message); }
    }
  }, 3600 * 1000); // verifica din ora in ora

  // Digest zilnic cu termenele fiscale: o singura data pe zi, dupa ora 07:00 (ora serverului)
  safeInterval('digest-termene', () => {
    const d = db.get();
    const today = new Date().toISOString().slice(0, 10);
    const s = d.settings.deadlineDigest || (d.settings.deadlineDigest = {});
    if (s.lastDate === today || new Date().getHours() < 7) return;
    s.lastDate = today;
    db.save();
    sendDeadlineDigests()
      .then((r) => {
        metrics.jobResult('digest-termene', r.sent.length + ' trimise' + (r.errors.length ? ', ' + r.errors.length + ' erori' : ''));
        if (r.sent.length || r.errors.length) console.log('Digest termene:', r.sent.length, 'trimise', r.errors.length ? ('; erori: ' + r.errors.join(' | ')) : '');
      })
      .catch((e) => { metrics.jobError('digest-termene', e.message); console.error('Digest termene:', e.message); });
  }, 15 * 60 * 1000);

  // Reset zilnic al contului demo (dupa ora 04:00): junk-ul vizitatorilor dispare peste noapte
  safeInterval('demo-reset', () => {
    const d = db.get();
    const today = new Date().toISOString().slice(0, 10);
    const s = d.settings.demoReset || (d.settings.demoReset = {});
    if (s.lastDate === today || new Date().getHours() < 4) return;
    s.lastDate = today;
    try { const r = resetDemo(); if (r.ok) { metrics.jobResult('demo-reset', 'resetat din snapshot'); console.log('Demo resetat din snapshot.'); } db.save(); }
    catch (e) { metrics.jobError('demo-reset', e.message); console.error('Demo reset:', e.message); }
  }, 15 * 60 * 1000);

  // Igiena rate-limit: fara curatare, map-urile ar creste nelimitat (cate o intrare per IP esuat)
  safeInterval('rate-limit-hygiene', () => {
    const now = Date.now();
    pruneLoginAttempts(now); // loginAttempts traieste in src/session.js (incapsulat)
    for (const [k, r] of registerAttempts) { if (r.reset < now) registerAttempts.delete(k); }
    for (const [k, r] of forgotAttempts) { if (r.reset < now) forgotAttempts.delete(k); }
    for (const [k, r] of (clientErrAttempts || [])) { if (r.reset < now) clientErrAttempts.delete(k); }
    uploadGuard.pruneRateBuckets(now); // bucket-urile de upload/export per utilizator
  }, 3600 * 1000);

  // Vizitatorii site-ului (src/visitors.js): agregatul din memorie se coboara in baza la un minut,
  // si DOAR daca s-a schimbat ceva. Aici e tot pretul functiei — calea cererii ramane fara I/O.
  // Un `db.save()` per cerere ar fi costat O(colectie) de fiecare data (docs/scalare-crestere.md).
  //
  // `db.save(['visitors'])`: mutarea muta EXACT o colectie, si o stim din doua randuri mai sus —
  // exact cazul pentru care exista indiciul. Fara el, jobul platea diff-ul pe TOATA baza (~101 ms
  // la 80.000 de articole) din minut in minut, in gol: costul crestea cu baza, desi lucrarea lui
  // ramane de cateva sute de randuri. Vezi src/persistPlan.js pentru plasa care margineste
  // greseala daca cineva mai adauga vreodata o scriere in acest bloc.
  safeInterval('visitors-flush', () => {
    const vis = require('./visitors');
    vis.curata();                       // retentie: inregistrarile vechi ies inainte de a fi scrise
    const lista = vis.toPersist();
    if (!lista) return;                 // nimic nou -> nicio scriere, nicio colectie marcata murdara
    const d = db.get();
    d.visitors = lista;
    db.save(['visitors']);
    metrics.jobResult('visitors-flush', lista.length + ' adrese');
  }, 60 * 1000);

  // Igiena uploads (zilnic): staging-urile de import ramase dupa un crash se sterg
  // (gunoi cert, peste 24h); fisierele ORFANE doar se numara si se vad in /api/metrics
  // (ops) — stergerea lor ramane decizia operatorului.
  safeInterval('uploads-hygiene', () => {
    const uh = require('./uploadsHygiene');
    const sterse = uh.sweepStaging(db.UPLOAD_DIR);
    const rap = uh.orphanReport(db.get(), db.UPLOAD_DIR);
    metrics.jobResult('uploads-hygiene', sterse + ' staging sterse; ' + rap.orfane + '/' + rap.total + ' fisiere orfane');
    if (sterse || rap.orfane) console.log('[uploads-hygiene]', sterse, 'staging sterse;', rap.orfane, 'orfane din', rap.total);
  }, 24 * 3600 * 1000);

  // Veghe pe memorie: avertizeaza INAINTE ca pm2 sa ucida procesul la max_memory_restart.
  // Baza in RAM e prin design (graful de date e minuscul; RSS-ul e dominat de runtime) —
  // o crestere sustinuta peste prag inseamna leak sau varfuri repetate si trebuie VAZUTA,
  // nu descoperita din restarturi. Pragul si plafonul vin din metrics (o singura sursa, ca
  // metrica si alerta sa nu spuna cifre diferite). Email cel mult o data pe zi (tiparul alertei 5xx).
  const { MEM_WARN_MB, MEM_LIMIT_MB } = metrics;
  let lastMemAlert = 0;
  safeInterval('memory-watch', () => {
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    const pct = Math.round((rssMb / MEM_LIMIT_MB) * 100);
    metrics.jobResult('memory-watch', rssMb + ' MB = ' + pct + '% din plafonul pm2 (' + MEM_LIMIT_MB + ' MB), prag ' + MEM_WARN_MB);
    if (rssMb < MEM_WARN_MB) return;
    log.error('memorie ridicata', { rssMb, pragMb: MEM_WARN_MB, plafonMb: MEM_LIMIT_MB, pct });
    const now = Date.now();
    if (now - lastMemAlert > 24 * 3600 * 1000) {
      lastMemAlert = now;
      sendNotifMail(process.env.CONTAB_BACKUP_EMAIL_TO || '', '[Contab] ATENTIE: memorie ridicata (' + pct + '% din plafonul pm2)',
        'RSS ' + rssMb + ' MB — ' + pct + '% din plafonul pm2 de ' + MEM_LIMIT_MB + ' MB (prag de avertizare ' + MEM_WARN_MB + ' MB).\n'
        + 'La atingerea plafonului pm2 restarteaza procesul, posibil in mijlocul unei cereri.\n'
        + 'Verifica /api/metrics (admin, campurile process.memory*) si pm2 logs contab.\n'
        + 'Daca plafonul pm2 s-a schimbat, actualizeaza CONTAB_PM2_MAX_MB (fisierul ecosystem.config.js\n'
        + 'e doar o declaratie: `pm2 restart` NU il reaplica — verifica cu `pm2 jlist`).').catch(() => {});
    }
  }, 5 * 60 * 1000);

  // Veghe pe INTARZIEREA BUCLEI DE EVENIMENTE. Procesul e unul singur, deci o bucata de munca
  // sincrona opreste toate cererile, nu doar pe a ei — iar in durata pe ruta asta apare ca „totul
  // a fost lent atunci", fara vinovat. Alerta se uita pe FEREASTRA scursa (metrics.lagRoll o
  // inchide si porneste alta): un varf de acum trei zile n-are voie sa tina alarma pornita.
  // Se raporteaza p99 si max, nu media: un blocaj de o secunda intr-un minut linistit lasa media
  // aproape neatinsa — exact cazul pe care jobul trebuie sa-l vada.
  const LAG_WARN_MS = metrics.LAG_WARN_MS; // o singura sursa, ca alerta si metrica sa nu difere
  let lastLagAlert = 0;
  safeInterval('lag-watch', () => {
    const s = metrics.lagRoll();
    metrics.jobResult('lag-watch', 'p99 ' + s.p99Ms + ' ms, varf ' + s.maxMs + ' ms in ultimele '
      + s.fereastraSec + 's (prag ' + LAG_WARN_MS + ', varf de la pornire ' + s.maxTotalMs + ')');
    if (s.maxMs < LAG_WARN_MS) return;
    log.error('bucla de evenimente blocata', { p99Ms: s.p99Ms, maxMs: s.maxMs, pragMs: LAG_WARN_MS, fereastraSec: s.fereastraSec });
    const now = Date.now();
    if (now - lastLagAlert > 24 * 3600 * 1000) {
      lastLagAlert = now;
      sendNotifMail(process.env.CONTAB_BACKUP_EMAIL_TO || '', '[Contab] ATENTIE: bucla de evenimente blocata (' + s.maxMs + ' ms)',
        'Bucla a stat blocata pana la ' + s.maxMs + ' ms (p99 ' + s.p99Ms + ' ms) in ultimele ' + s.fereastraSec + ' secunde,\n'
        + 'peste pragul de ' + LAG_WARN_MS + ' ms. Cat tine blocajul, TOATE cererile asteapta, oricat de ieftine ar fi.\n\n'
        + 'Suspecti obisnuiti, in ordinea probabilitatii:\n'
        + '  • backupul zilnic — pg_dump si arhivarea ruleaza SINCRON, in acest proces;\n'
        + '  • o rafala de autentificari (scrypt costa ~30 ms de bucla blocata fiecare);\n'
        + '  • un export/raport mare, sau serializarea bazei la save() pe o firma voluminoasa.\n\n'
        + 'Verifica /api/metrics (admin): campul `lag` si rutele cu maxMs mare in aceeasi fereastra.\n'
        + 'Pragul se schimba din CONTAB_LAG_WARN_MS.').catch(() => {});
    }
  }, 60 * 1000);

  // Veghe pe JURNALUL DE AUDIT DURABIL (data/audit/*.ndjson). E proba de control intern, si e
  // singurul lucru care justifica plafonul din baza vie: `logAudit` roleste d.audit la
  // CONTAB_AUDIT_MAX linistit TOCMAI fiindca proba ramane pe disc. Daca scrierea nu mai merge,
  // afirmatia aceea devine falsa — si devenea falsa in TACERE: append e best-effort (corect: nu
  // rupe cererea) si avertizeaza o singura data pana la urmatorul succes (corect: nu inunda
  // logul), dar cele doua impreuna insemnau o linie in log si apoi nimic, la nesfarsit.
  //
  // Doua semnale, fiindca raspund la intrebari diferite:
  //   - SONDA: se mai poate scrie ACUM? (raspunde inainte sa avem un eveniment de consemnat)
  //   - CONTORUL: au esuat scrieri de la ultima verificare? (fereastra, nu cumulat de la pornire —
  //     altfel o defectiune trecatoare ar tine alarma aprinsa pana la restart)
  let auditEsecuriVazute = 0;
  let lastAuditAlert = 0;
  safeInterval('audit-watch', () => {
    const s = metrics.auditSnapshot();
    const noi = s.esecuri - auditEsecuriVazute;
    auditEsecuriVazute = s.esecuri;
    const p = auditLog.probeWritable();
    metrics.jobResult('audit-watch', p.ok
      ? 'scriibil (' + s.scrise + ' scrise, ' + s.esecuri + ' esecuri de la pornire)'
      : 'NESCRIIBIL: ' + p.motiv);
    if (p.ok && noi <= 0) return;
    const motiv = !p.ok
      ? 'jurnalul nu se poate scrie: ' + p.motiv
      : noi + ' scrieri esuate de la ultima verificare (ultima eroare: ' + s.lastError + ')';
    log.error('jurnal de audit durabil', { motiv, scrise: s.scrise, esecuri: s.esecuri, sondaOk: p.ok });
    const now = Date.now();
    if (now - lastAuditAlert > 24 * 3600 * 1000) {
      lastAuditAlert = now;
      sendNotifMail(process.env.CONTAB_BACKUP_EMAIL_TO || '', '[Contab] ATENTIE: jurnalul de audit durabil nu se scrie',
        motiv + '.\n\n'
        + 'Jurnalul din data/audit/*.ndjson e proba de control intern si e inclus in backupul zilnic.\n'
        + 'Cat timp nu se scrie, actiunile raman doar in baza vie, care se roleste la '
        + (Number(process.env.CONTAB_AUDIT_MAX) || 20000) + ' de inregistrari — deci proba chiar se pierde.\n\n'
        + 'Cauza cea mai frecventa: un fisier audit-YYYY-MM.ndjson ramas de la un proces rulat sub alt\n'
        + 'utilizator (root), pe care procesul aplicatiei nu-l mai poate deschide. Verifica\n'
        + '`ls -l ' + auditLog.auditDir() + '` si proprietarul fisierului lunii curente.\n'
        + 'Starea completa: /api/metrics (admin), campul `audit`.').catch(() => {});
    }
  }, 5 * 60 * 1000);

  // Veghe pe COADA DE PERSISTENTA. Pe pg, save() fotografiaza sincron dar COMITE asincron: cat timp
  // lucrarea asteapta, scrierile traiesc doar in RAM (nedurabile) si tin ocupat un snapshot al
  // colectiilor schimbate. O coada care nu se goleste = baza lenta, cazuta sau blocata — si e
  // exact drumul catre plafonul pm2. Pe sqlite persist e sincron, deci semnalul e mereu zero;
  // jobul ramane pornit fara cost (contract unic, fara ramuri pe driver).
  const PERSIST_LAG_MS = Number(process.env.CONTAB_PERSIST_LAG_MS) || 60 * 1000;
  const PERSIST_FAILS = Number(process.env.CONTAB_PERSIST_FAILS) || 3;
  let lastPersistAlert = 0;
  safeInterval('persist-watch', () => {
    const s = db.persistStats();
    const kb = Math.round((s.pendingBytes || 0) / 1024);
    metrics.jobResult('persist-watch', s.pending
      ? 'IN ASTEPTARE de ' + Math.round(s.pendingAgeMs / 1000) + 's (' + kb + ' KB retinuti)'
      : 'la zi (' + s.commits + ' scrieri comise' + (s.failStreak ? ', ' + s.failStreak + ' esecuri consecutive' : '') + ')');
    const verdict = persistVerdict(s, { lagMs: PERSIST_LAG_MS, fails: PERSIST_FAILS });
    if (!verdict.alert) return;
    const motiv = verdict.motiv;
    log.error('coada de persistenta', { motiv, pendingAgeMs: s.pendingAgeMs, pendingBytes: s.pendingBytes, failStreak: s.failStreak, conflicted: s.conflicted });
    const now = Date.now();
    if (now - lastPersistAlert > 24 * 3600 * 1000) {
      lastPersistAlert = now;
      sendNotifMail(process.env.CONTAB_BACKUP_EMAIL_TO || '', '[Contab] ATENTIE: coada de persistenta (' + s.driver + ')',
        'Backlog la scrierea in baza: ' + motiv + '.\n'
        + 'Ultima scriere comisa: ' + (s.lastCommitAt || 'niciuna de la pornire') + '.\n'
        + (s.lastError ? 'Ultima eroare: ' + s.lastError.msg + ' (' + s.lastError.at + ')\n' : '')
        + 'Cat timp coada nu se goleste, datele scrise traiesc DOAR in RAM (se pierd la restart)\n'
        + 'si consuma memorie catre plafonul pm2. Verifica PostgreSQL si /api/metrics (campul persist).').catch(() => {});
    }
  }, 60 * 1000);

  // Job periodic: descarca automat recipisele — SPV per-firma, doar firmele cu autoPoll bifat
  safeInterval('spv-poll', () => {
    const vreoFirma = db.get().firme.some((f) => f.anaf && f.anaf.autoPoll && anaf.connected(f.anaf));
    if (vreoFirma) {
      pollSpv({ auto: true })
        .then((r) => {
          metrics.jobResult('spv-poll', 'verificate ' + r.checked + ', descarcate ' + r.downloaded);
          if (r.downloaded) console.log('Auto-poll SPV: ' + r.downloaded + ' recipise descarcate');
        })
        .catch((e) => { metrics.jobError('spv-poll', e.message || e); console.error('Auto-poll SPV:', e.message || e); });
    }
  }, 15 * 60 * 1000);

  // Cursul BNR: o data la 6 ore. BNR publica o singura data pe zi (in jurul pranzului), deci mai
  // des n-ar aduce nimic; mai rar ar rata ziua curenta cand serverul a fost oprit. Esecul feed-ului
  // e AVERTISMENT, nu eroare: cursul tastat manual ramane calea de rezerva, deci nimic nu se
  // blocheaza daca BNR e indisponibil.
  safeInterval('curs-bnr', () => {
    bnr.fetchDaily()
      .then((randuri) => {
        const d = db.get();
        d.cursuriBnr = Array.isArray(d.cursuriBnr) ? d.cursuriBnr : [];
        const r = bnr.upsertRates(d.cursuriBnr, randuri);
        if (r.adaugate || r.actualizate) db.save();
        metrics.jobResult('curs-bnr', 'zile noi ' + r.adaugate + ', actualizate ' + r.actualizate);
      })
      .catch((e) => {
        metrics.jobError('curs-bnr', e.message || e);
        console.warn('Curs BNR indisponibil (se foloseste cursul tastat manual):', e.message || e);
      });
  }, 6 * 60 * 60 * 1000);

  return { stop };
}

// `safeInterval` e exportat pentru teste (ca `persistVerdict`): plasa de siguranta e chiar
// proprietatea de verificat, iar prin `start()` ar cere pornirea tuturor joburilor reale.
module.exports = { start, stop, persistVerdict, safeInterval };
