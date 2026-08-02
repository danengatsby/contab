'use strict';

// Backup zilnic Contab (rulat din cron, 03:30):
//   1. copiaza data/db.json in data/backups/db-YYYYMMDD-HHMMSS.json (pastreaza ultimele 30)
//   2. arhiva completa full-YYYYMMDD-HHMMSS.zip: db.json + contab.sqlite (instantaneu
//      consistent) + uploads/ (documentele justificative scanate) — pastreaza ultimele 14
//   3. copie OFFSITE a arhivei complete (discul local nu e suficient pentru date contabile):
//      email cu atasament prin Resend si/sau rclone, dupa configurare.
//
// Configurare prin .env (din radacina proiectului) sau variabile de mediu:
//   CONTAB_BACKUP_KEEP        cate copii db-*.json se pastreaza      (implicit 30)
//   CONTAB_BACKUP_KEEP_FULL   cate arhive full-*.zip se pastreaza    (implicit 14)
//   CONTAB_BACKUP_EMAIL_TO    destinatarul email al arhivei          (gol = fara email)
//   RESEND_API_KEY            cheia API Resend pentru trimitere
//   RCLONE_REMOTE             destinatie rclone, ex. "b2:bucket/contab" (gol = fara rclone)
//
// Restaurare dupa dezastru: dezarhivezi full-*.zip -> db.json se incarca din
// Setari -> Backup -> Restaureaza (sau se copiaza in data/), uploads/* inapoi in data/uploads/.

const fs = require('fs');
const path = require('path');

// Incarca .env (aceeasi conventie ca server.js) — pentru RESEND_API_KEY etc.
(() => {
  try {
    const p = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      // `in`, nu adevar-valoare — aceeasi semantica cu loadDotEnv din src/bootstrap.js (referinta).
      // Cu `!process.env[...]`, o variabila setata explicit la GOL era considerata absenta si .env
      // castiga: `CONTAB_BACKUP_EMAIL_TO= node scripts/backup.js` trimitea totusi emailul, fiindca
      // adresa venea din .env. O incercare „fara efecte" avea efecte.
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* ignora */ }
})();

// Ascunde avertismentul "SQLite is experimental" (ca in src/store.js) — nu polua backup.log.
const _emitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (String(w).includes('SQLite is an experimental')) return;
  return _emitWarning.call(process, w, ...rest);
};

const offsite = require(require('path').join(__dirname, '..', 'src', 'offsite'));
const backup = require('../src/backup');
// Acelasi expeditor ca al aplicatiei, dar fara dependinta de baza de date (scriptul ruleaza din
// cron si lucreaza pe fisiere). Important: verifica raspunsul si arunca daca emailul nu a plecat.
const { sendResend } = require('../src/resend');

// CONTAB_DATA_DIR, ca in src/db.js. Inainte era o cale FIXA catre data/ din repo, desi
// CONTAB_DB_FILE era respectat — deci o rulare „pe date temporare" citea baza din /tmp, dar scria
// arhivele, marcajul si rotatia in data/ REAL. E fix capcana din care s-a nascut pana de backup
// de 7 zile: fisiere lasate in data/ de un proces rulat ca root. Un script de backup trebuie sa
// poata fi incercat fara sa atinga productia.
const DATA_DIR = process.env.CONTAB_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.CONTAB_DB_FILE || path.join(DATA_DIR, 'db.json');
const KEEP = Number(process.env.CONTAB_BACKUP_KEEP) || 30;
const KEEP_FULL = Number(process.env.CONTAB_BACKUP_KEEP_FULL) || 14;
const EMAIL_TO = process.env.CONTAB_BACKUP_EMAIL_TO || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const RCLONE_REMOTE = process.env.RCLONE_REMOTE || '';
const MAX_EMAIL_BYTES = 20 * 1024 * 1024; // peste 20MB nu se ataseaza la email — treci pe rclone

function log(...a) { console.log(new Date().toISOString(), ...a); }
function warn(...a) { console.error(new Date().toISOString(), ...a); }

/** Trimite arhiva ca atasament prin API-ul Resend (expeditor: domeniul verificat poetio.site). */
async function emailArchive(zipPath, sizeLabel) {
  // Instructiunile de restaurare CALATORESC cu arhiva, deci trebuie sa fie corecte tocmai in
  // situatia in care aplicatia (si serverul) nu mai exista. Doua greseli reparate aici: textul
  // spunea „contab.sqlite" desi instalarea e pe PostgreSQL de pe 2026-07-14 (arhiva contine
  // `contab.sql`), si nu pomenea deloc descifrarea — dupa activarea CONTAB_BACKUP_KEY atasamentul
  // e `.zip.enc`, iar un „dezarhiveaza" pe el esueaza fara sa spuna de ce.
  const criptat = zipPath.endsWith('.enc');
  const pasi = (criptat
    ? ['1. Descifreaza (cere CONTAB_BACKUP_KEY, tinuta SEPARAT de aceasta cutie postala):',
      '   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \\',
      `     -in ${path.basename(zipPath)} -out ${path.basename(zipPath).replace(/\.enc$/, '')} -pass env:CONTAB_BACKUP_KEY`,
      '2. Dezarhiveaza fisierul .zip rezultat.']
    : ['1. Dezarhiveaza arhiva.'])
    .concat([
      '3. db.json    -> Setari -> Backup -> Restaureaza (sau restaurare nativa din contab.sql).',
      '4. uploads/*  -> data/uploads/',
      '5. audit/*    -> data/audit/   (jurnalul append-only, proba durabila)',
    ]);
  const payload = {
    from: 'Contab backup <comenzi@poetio.site>',
    to: [EMAIL_TO],
    subject: `[Contab backup] ${path.basename(zipPath)} (${sizeLabel})`,
    text: 'Backup zilnic Contab (contabo.space): db.json + contab.sql (dump PostgreSQL) + uploads/ + audit/.\n'
      + (criptat ? 'Arhiva e CRIPTATA (AES-256).\n' : 'ATENTIE: arhiva NU e criptata.\n')
      + '\nRestaurare:\n' + pasi.join('\n') + '\n',
    attachments: [{
      filename: path.basename(zipPath),
      content: fs.readFileSync(zipPath).toString('base64'),
    }],
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + RESEND_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'contab-backup-script/1.0', // WAF-ul Resend respinge agentii impliciti
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok || !body.includes('"id"')) throw new Error('Resend ' + res.status + ': ' + body.slice(0, 200));
}

/** Alerta text (fara atasament) cand backupul sau verificarea esueaza. */
// Ultima alerta care NU a putut pleca (motivul). Ajunge in marcajul last-backup.json, deci in
// /api/metrics si in raportul zilnic: daca insusi canalul de alerta e cazut, trebuie sa ramana
// o urma pe care o vede altcineva — altfel tacerea seamana leit cu „totul e in regula".
let alertaEsuata = null;

async function alertEmail(subiect, text) {
  if (!EMAIL_TO || !RESEND_KEY) {
    alertaEsuata = 'necofigurat: ' + (!EMAIL_TO ? 'CONTAB_BACKUP_EMAIL_TO' : 'RESEND_API_KEY') + ' lipseste';
    warn('ALERTA NETRIMISA (' + alertaEsuata + '):', subiect);
    return;
  }
  try {
    // sendResend ARUNCA daca emailul nu a plecat. Varianta de dinainte ignora `r.ok`, deci un 401
    // (cheie revocata) sau 403 (domeniu neverificat) trecea drept succes si alerta disparea.
    await sendResend(RESEND_KEY, {
      from: 'Contab backup <comenzi@poetio.site>', to: EMAIL_TO, subject: subiect, text,
      ua: 'contab-backup-script/1.0',
    });
  } catch (e) {
    alertaEsuata = String(e.message || e).slice(0, 200);
    // Nu putem trimite email — tocmai asta a esuat. Ramane stderr (cron/MAILTO il prinde) plus
    // marcajul de stare de mai jos.
    warn('ALERTA NU A PLECAT:', alertaEsuata, '| subiect:', subiect);
  }
}

async function main() {
  // 1) copia db.json (formatul asteptat de UI-ul Setari -> Backup)
  const r = backup.backupNow(DB_FILE, DATA_DIR, KEEP);
  log('Contab backup OK:', r.name, '(pastrate', r.count + ')');

  // 2) arhiva completa (db + sqlite + uploads)
  const f = backup.fullBackup(DB_FILE, DATA_DIR, KEEP_FULL);
  const sizeLabel = (f.size / 1024 / 1024).toFixed(1) + 'MB';
  log('Arhiva completa OK:', f.name, '(' + sizeLabel + ')');

  // 2b) VERIFICAREA restaurabilitatii, in DOUA straturi:
  //   - STRUCTURAL (verifyArchive): arhiva se deschide, db.json valid cu firme, sqlite prezent;
  //   - DRILL de restaurare (restoreDrill): extrage db.json si verifica COERENTA CONTABILA in
  //     izolare — invariantul partidei duble (Σdebit == Σcredit) pe fiecare firma. Automatizeaza
  //     exercitiul manual trimestrial din MONITORING.md. Starea (ambele) se persista pentru
  //     /api/metrics (ops.ultimulBackup) si e vizibila in raportul zilnic.
  // Starea drill-ului nativ PG e citita AICI (inaintea lui scrieMarcaj, care o include in marcaj)
  // ca sa nu cada primul apel in TDZ; rularea propriu-zisa vine mai jos, dupa celelalte verificari.
  const PG_DRILL_DAYS = Number(process.env.CONTAB_PG_DRILL_DAYS || 7);
  const drillMarkPath = path.join(DATA_DIR, 'backups', 'last-pg-drill.json');
  let pgDrill = null;
  const ultimulPgDrill = (() => {
    try { return JSON.parse(fs.readFileSync(drillMarkPath, 'utf8')); } catch (_) { return null; }
  })();
  const veri = backup.verifyArchive(f.path);
  const drill = require('../src/restoreDrill').drillArchive(f.path);
  // Marcajul de stare e util (il citeste /api/metrics si raportul zilnic), dar e cel mai PUTIN
  // important pas de aici. Scrierea lui NU are voie sa opreasca ce urmeaza: verificarea, drill-ul
  // si mai ales trimiterea OFFSITE — un backup care ramane pe server nu apara de pierderea
  // serverului. S-a intamplat: un fisier ramas root-owned a facut writeFileSync sa arunce EACCES,
  // iar copia offsite n-a mai plecat SAPTE ZILE (19-25 iulie 2026), cu backup-urile locale create
  // in continuare — deci aparent totul era in regula.
  // Se rescrie dupa fiecare alerta, ca `alertaEsuata` sa fie la zi: daca insusi canalul de alerta
  // e cazut, urma trebuie sa ramana undeva ce se vede din afara.
  // Forma COMPACTA a starii drill-ului nativ pentru marcaj: `randuri` (harta pe colectii) e utila
  // in last-pg-drill.json, dar ar umfla marcajul citit de /api/metrics la fiecare cerere.
  const rezumatPgDrill = (x) => (x ? {
    ok: !!x.ok, sarit: !!x.sarit, motiv: x.motiv || null,
    firme: x.firme, totalEntries: x.totalEntries, durataMs: x.durataMs, ts: x.ts, arhiva: x.arhiva,
  } : null);
  const scrieMarcaj = () => {
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'backups', 'last-backup.json'), JSON.stringify({
        ts: new Date().toISOString(), name: f.name, ok: veri.ok, firme: veri.firme, sqlite: veri.sqlite, size: f.size, motiv: veri.motiv,
        drill: { ok: drill.ok, nrFirme: drill.nrFirme, totalEntries: drill.totalEntries, motiv: drill.motiv },
        pgDrill: rezumatPgDrill(pgDrill || ultimulPgDrill),
        alertaEsuata,
      }));
    } catch (e) {
      warn('Marcajul last-backup.json nu s-a putut scrie:', e.message, '— backupul CONTINUA (verificare, drill, offsite).');
    }
  };
  scrieMarcaj();
  if (!veri.ok) {
    warn('Verificare arhiva ESUATA:', veri.motiv);
    await alertEmail('[Contab backup] ARHIVA NERESTAURABILA: ' + f.name, 'Verificarea a esuat: ' + veri.motiv);
    scrieMarcaj(); // alerta poate sa nu fi plecat — lasa urma inainte de a iesi
    process.exit(1);
  }
  log('Verificare arhiva OK:', veri.firme, 'firme, sqlite:', veri.sqlite);
  if (!drill.ok) {
    warn('Drill de restaurare ESUAT:', drill.motiv);
    await alertEmail('[Contab backup] DRILL RESTAURARE ESUAT: ' + f.name,
      'Arhiva se deschide, dar datele restaurate NU sunt coerente contabil: ' + drill.motiv
      + '\nVerifica integritatea bazei inainte ca backupurile sa se roteasca.');
    scrieMarcaj(); // alerta poate sa nu fi plecat — lasa urma inainte de a iesi
    process.exit(1);
  }
  log('Drill restaurare OK:', drill.nrFirme, 'firme coerente,', drill.totalEntries, 'articole (balanta echilibrata).');

  // 2c) DRILL NATIV PostgreSQL: restaureaza efectiv `contab.sql` intr-o baza TEMPORARA si verifica
  // ce a iesit (rejucare fara erori, coerenta contabila, echivalenta cu db.json din aceeasi arhiva).
  // Pana acum dump-ul nativ era doar PRODUS, niciodata rejucat — se putea strica in tacere.
  // Ruleaza cel mult o data la CONTAB_PG_DRILL_DAYS zile (implicit 7): e mai scump decat restul si
  // dump-ul nu se schimba structural de la o zi la alta. Se sare curat pe sqlite (fara contab.sql)
  // sau daca `psql` lipseste — un pas care nu poate rula nu are voie sa pice backupul.
  const scadent = !ultimulPgDrill || !ultimulPgDrill.ts
    || (Date.now() - Date.parse(ultimulPgDrill.ts)) >= PG_DRILL_DAYS * 24 * 3600 * 1000;
  if (scadent) {
    pgDrill = await require('../src/pgRestoreDrill').runPgDrill({ zipPath: f.path });
    pgDrill.ts = new Date().toISOString();
    pgDrill.arhiva = f.name;
    try { fs.writeFileSync(drillMarkPath, JSON.stringify(pgDrill)); }
    catch (e) { warn('Marcajul last-pg-drill.json nu s-a putut scrie:', e.message); }
    if (pgDrill.sarit) log('Drill nativ PostgreSQL: nu se aplica —', pgDrill.motiv);
    else if (pgDrill.neverificabil) {
      // Exista dump, dar nu-l putem rejuca: NU e „nu se aplica". Alerta, dar fara exit 1 —
      // backupul in sine e bun, iar cauza e de INFRASTRUCTURA (drepturi, unelte lipsa).
      warn('Drill nativ PostgreSQL NEVERIFICABIL:', pgDrill.motiv);
      await alertEmail('[Contab backup] restaurarea nativa PG ramane NEVERIFICATA',
        'Arhiva contine contab.sql, dar drill-ul nu a putut rula: ' + pgDrill.motiv + '\n\n'
        + 'Backupul e in regula si restaurarea prin db.json ramane verificata — dar calea NATIVA\n'
        + '(cea rapida, la dezastru) nu e probata de nimeni. Repara cauza de mai sus.');
    } else if (!pgDrill.ok) {
      warn('Drill nativ PostgreSQL ESUAT:', pgDrill.motiv);
      await alertEmail('[Contab backup] RESTAURARE NATIVA PG ESUATA: ' + f.name,
        'Dump-ul contab.sql din arhiva NU s-a putut restaura intr-o baza temporara, sau datele\n'
        + 'rezultate nu sunt bune: ' + pgDrill.motiv + '\n\n'
        + 'db.json din aceeasi arhiva a trecut verificarile, deci restaurarea prin JSON ramane\n'
        + 'posibila — dar calea NATIVA (cea rapida, la dezastru) nu e utilizabila. Verifica\n'
        + 'versiunea pg_dump fata de serverul PostgreSQL si spatiul pe disc.');
      scrieMarcaj();
      // NU `process.exit(1)` aici. Varianta veche oprea rularea pe loc, iar pasul urmator e
      // COPIA OFFSITE — deci un esec de VERIFICARE anula PROTECTIA. S-a intamplat pe
      // 2026-07-28: drill-ul a picat (rolul pg lipsea sub cron) si arhiva zilei n-a plecat
      // nicaieri, desi trecuse si verificarea arhivei si drill-ul pe db.json.
      // Diferenta fata de cele doua iesiri de mai sus e reala: acolo ARHIVA e nefolosibila, deci
      // nu are rost (si e inselator) s-o trimiti. Aici arhiva e BUNA — doar calea nativa, care e
      // o cale de restaurare SECUNDARA, nu se poate proba. Rularea continua si se marcheaza ca
      // nereusita prin exitCode, care ajunge in logul cron si in raportul zilnic.
      process.exitCode = 1;
    } else {
      log('Drill nativ PostgreSQL OK: baza temporara', pgDrill.dbTemp, '—', pgDrill.firme, 'firme,',
        pgDrill.totalEntries, 'articole, echivalenta cu db.json, in', pgDrill.durataMs + 'ms.');
    }
  } else {
    log('Drill nativ PostgreSQL: nu e scadent (ultimul la', ultimulPgDrill.ts + ', la fiecare', PG_DRILL_DAYS, 'zile).');
  }

  // 3) offsite — email si/sau rclone; esecul unuia nu opreste restul.
  //    Cu CONTAB_BACKUP_KEY setat, copia OFFSITE pleaca CRIPTATA (AES-256, openssl);
  //    restaurare: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in f.zip.enc -out f.zip -pass env:CONTAB_BACKUP_KEY
  let offsitePath = f.path;
  const BK_KEY = process.env.CONTAB_BACKUP_KEY || '';
  if (BK_KEY) {
    const { spawnSync } = require('child_process');
    const encPath = f.path + '.enc';
    const enc = spawnSync('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-in', f.path, '-out', encPath, '-pass', 'env:CONTAB_BACKUP_KEY'],
      { env: Object.assign({}, process.env, { CONTAB_BACKUP_KEY: BK_KEY }), timeout: 5 * 60 * 1000 });
    if (enc.status !== 0) {
      // FAIL-CLOSED, deliberat. Varianta veche trimitea NECRIPTAT cand criptarea esua — adica
      // exact cand ceva nu era in regula, datele fiscale plecau in clar, cu un simplu avertisment
      // in log. O cheie configurata e o CERINTA, nu o preferinta.
      throw new Error('Criptarea offsite a esuat, iar CONTAB_BACKUP_KEY e setat: '
        + (enc.stderr || enc.error || '').toString().slice(0, 200)
        + ' — copia offsite NU a fost trimisa (refuz deliberat de a trimite in clar).');
    }
    // Verificare de ROUND-TRIP inainte de urcare: o arhiva criptata care nu se poate descifra e o
    // arhiva pierduta, si s-ar afla abia la dezastru. „N-am putut verifica" nu e „e bine".
    const probaPath = encPath + '.proba';
    const dec = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-in', encPath, '-out', probaPath, '-pass', 'env:CONTAB_BACKUP_KEY'],
      { env: Object.assign({}, process.env, { CONTAB_BACKUP_KEY: BK_KEY }), timeout: 5 * 60 * 1000 });
    let identic = false;
    try {
      identic = dec.status === 0
        && require('crypto').createHash('sha256').update(fs.readFileSync(probaPath)).digest('hex')
         === require('crypto').createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
    } catch (_) { identic = false; }
    try { fs.unlinkSync(probaPath); } catch (_) { /* best effort */ }
    if (!identic) throw new Error('Arhiva criptata NU se descifreaza inapoi la original — copia offsite a fost oprita.');
    offsitePath = encPath;
    log('Offsite criptat si verificat (round-trip):', path.basename(encPath));
  }
  let offsiteOk = false, offsiteConfigured = false;
  if (EMAIL_TO) {
    offsiteConfigured = true;
    if (!RESEND_KEY) {
      warn('Offsite email: CONTAB_BACKUP_EMAIL_TO setat dar RESEND_API_KEY lipseste — sarit.');
    } else if (f.size > MAX_EMAIL_BYTES) {
      warn('Offsite email: arhiva are', sizeLabel, '— prea mare pentru email; configureaza RCLONE_REMOTE.');
    } else {
      try { await emailArchive(offsitePath, sizeLabel); offsiteOk = true; log('Offsite email OK ->', EMAIL_TO); }
      catch (e) { warn('Offsite email ESUAT:', e.message); }
    }
  }
  // Stocare obiect S3-compatibila (Backblaze B2 / Hetzner / MinIO / R2), semnata nativ — fara
  // rclone, care nici nu e instalat pe server. E destinatia RECOMANDATA: emailul are limita de
  // dimensiune si trece datele printr-o cutie postala terta.
  const offCfg = offsite.fromEnv(process.env);
  if (offsite.configured(offCfg)) {
    offsiteConfigured = true;
    try {
      const buf = fs.readFileSync(offsitePath);
      const cheie = (offCfg.prefix ? offCfg.prefix.replace(/\/$/, '') + '/' : '') + path.basename(offsitePath);
      await offsite.putObject(offCfg, cheie, buf);
      // Verificare ca ce s-a urcat e ce am trimis: descarcam si comparam amprenta. O urcare
      // „reusita" care a truncat fisierul arata identic in log cu una buna.
      const inapoi = await offsite.getObject(offCfg, cheie);
      const h = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
      if (h(inapoi) !== h(buf)) throw new Error('obiectul descarcat inapoi difera de cel urcat');
      offsiteOk = true;
      log('Offsite S3 OK ->', offCfg.bucket + '/' + cheie, '(' + sizeLabel + ', verificat)');
    } catch (e) { warn('Offsite S3 ESUAT:', e.message); }
  }
  if (RCLONE_REMOTE) {
    offsiteConfigured = true;
    const { spawnSync } = require('child_process');
    const rc = spawnSync('rclone', ['copy', offsitePath, RCLONE_REMOTE], { encoding: 'utf8', timeout: 10 * 60 * 1000 });
    if (rc.error) warn('Offsite rclone ESUAT:', rc.error.message);
    else if (rc.status !== 0) warn('Offsite rclone ESUAT:', (rc.stderr || '').slice(0, 300));
    else { offsiteOk = true; log('Offsite rclone OK ->', RCLONE_REMOTE); }
  }
  if (offsitePath !== f.path) { try { fs.unlinkSync(offsitePath); } catch (_) { /* best effort */ } }
  if (!offsiteConfigured) warn('ATENTIE: nicio copie offsite configurata. Recomandat: stocare obiect '
    + '(CONTAB_OFFSITE_ENDPOINT/BUCKET/KEY/SECRET) + criptare (CONTAB_BACKUP_KEY). '
    + 'Alternative: CONTAB_BACKUP_EMAIL_TO (limitat ca dimensiune), RCLONE_REMOTE (cere rclone instalat).');
  // O copie care a PLECAT, dar in clar, nu mai trece tacut (vezi offsite.confidentialityWarning).
  const avertismentConf = offsite.confidentialityWarning({ sent: offsiteOk, encrypted: !!BK_KEY, viaEmail: !!EMAIL_TO });
  if (avertismentConf) warn(avertismentConf);
  else if (!offsiteOk) process.exitCode = 1; // offsite configurat dar esuat -> semnaleaza in cron log
  if (alertaEsuata) {
    scrieMarcaj();               // urma ramane vizibila in /api/metrics si in raportul zilnic
    process.exitCode = 1;        // canalul de alerta e cazut: rularea NU e „complet reusita"
  }
}

main().catch(async (e) => {
  warn('Contab backup ESUAT:', e.message);
  await alertEmail('[Contab backup] ESUAT', 'Backupul zilnic a esuat: ' + e.message);
  process.exit(1);
});
