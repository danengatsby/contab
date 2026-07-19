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
const { pollSpv } = require('./anafService');
const { sendDeadlineDigests, sendNotifMail } = require('./notify');
const { pruneLoginAttempts } = require('./session');
const { trackServerError } = require('./serverErrors');

// Ruleaza un job periodic cu plasa de siguranta: o eroare SINCRONA in callback (ex. un db.save()
// care arunca) e prinsa si logata — nu doboara procesul si nu impiedica rulele urmatoare. Erorile
// ASINCRONE raman tratate pe .catch-ul promisiunilor din interior (retea/ANAF/SMTP).
// Intervalele sunt unref() si tinute in `handles`: joburile nu au voie sa tina procesul in viata
// (serverul traieste prin app.listen) si nici sa supravietuiasca unui stop() — altfel un test sau
// un embedding care porneste joburile ar atarna la nesfarsit dupa inchiderea serverului.
const handles = [];
function safeInterval(label, fn, ms) {
  const t = setInterval(() => {
    metrics.jobTick(label); // starea job-urilor apare in /api/metrics (admin)
    try { fn(); }
    catch (e) {
      metrics.jobError(label, e.message || e);
      log.error('eroare in job periodic', { job: label, err: e });
      try { trackServerError({ method: 'JOB', originalUrl: label }, e); } catch (_) { /* ignora */ }
    }
  }, ms);
  if (t.unref) t.unref();
  handles.push(t);
  return t;
}

/** Opreste toate joburile pornite; intoarce cate intervale a curatat (idempotent). */
function stop() {
  let n = 0;
  while (handles.length) { clearInterval(handles.pop()); n += 1; }
  return n;
}

function start(ctx) {
  const { doBackup, resetDemo, registerAttempts, forgotAttempts } = ctx;

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
    uploadGuard.pruneRateBuckets(now); // bucket-urile de upload/export per utilizator
  }, 3600 * 1000);

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
  // nu descoperita din restarturi. Email cel mult o data pe zi (acelasi tipar ca alerta 5xx).
  const MEM_WARN_MB = Number(process.env.CONTAB_MEM_WARN_MB || 700);
  let lastMemAlert = 0;
  safeInterval('memory-watch', () => {
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    metrics.jobResult('memory-watch', rssMb + ' MB (prag ' + MEM_WARN_MB + ')');
    if (rssMb < MEM_WARN_MB) return;
    log.error('memorie ridicata', { rssMb, pragMb: MEM_WARN_MB });
    const now = Date.now();
    if (now - lastMemAlert > 24 * 3600 * 1000) {
      lastMemAlert = now;
      sendNotifMail(process.env.CONTAB_BACKUP_EMAIL_TO || '', '[Contab] ATENTIE: memorie ridicata',
        'RSS ' + rssMb + ' MB (prag ' + MEM_WARN_MB + ' MB; pm2 restarteaza la max_memory_restart).\n'
        + 'Verifica /api/metrics (admin) si pm2 logs contab.').catch(() => {});
    }
  }, 5 * 60 * 1000);

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

  return { stop };
}

module.exports = { start, stop };
