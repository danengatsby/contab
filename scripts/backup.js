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
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* ignora */ }
})();

// Ascunde avertismentul "SQLite is experimental" (ca in src/store.js) — nu polua backup.log.
const _emitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (String(w).includes('SQLite is an experimental')) return;
  return _emitWarning.call(process, w, ...rest);
};

const backup = require('../src/backup');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
  const payload = {
    from: 'Contab backup <comenzi@poetio.site>',
    to: [EMAIL_TO],
    subject: `[Contab backup] ${path.basename(zipPath)} (${sizeLabel})`,
    text: 'Backup zilnic Contab (contabo.space): db.json + contab.sqlite + uploads/.\n'
      + 'Restaurare: dezarhiveaza; db.json -> Setari -> Backup -> Restaureaza; uploads/* -> data/uploads/.\n',
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
async function alertEmail(subiect, text) {
  if (!EMAIL_TO || !RESEND_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json', 'User-Agent': 'contab-backup-script/1.0' },
      body: JSON.stringify({ from: 'Contab backup <comenzi@poetio.site>', to: [EMAIL_TO], subject: subiect, text }),
    });
  } catch (_) { /* alerta e best-effort */ }
}

async function main() {
  // 1) copia db.json (formatul asteptat de UI-ul Setari -> Backup)
  const r = backup.backupNow(DB_FILE, DATA_DIR, KEEP);
  log('Contab backup OK:', r.name, '(pastrate', r.count + ')');

  // 2) arhiva completa (db + sqlite + uploads)
  const f = backup.fullBackup(DB_FILE, DATA_DIR, KEEP_FULL);
  const sizeLabel = (f.size / 1024 / 1024).toFixed(1) + 'MB';
  log('Arhiva completa OK:', f.name, '(' + sizeLabel + ')');

  // 2b) VERIFICAREA restaurabilitatii: arhiva se deschide si contine o baza valida.
  //     Starea se persista pentru dashboardul /api/metrics (ultimul backup RESTAURABIL).
  const veri = backup.verifyArchive(f.path);
  fs.writeFileSync(path.join(DATA_DIR, 'backups', 'last-backup.json'), JSON.stringify({
    ts: new Date().toISOString(), name: f.name, ok: veri.ok, firme: veri.firme, sqlite: veri.sqlite, size: f.size, motiv: veri.motiv,
  }));
  if (!veri.ok) {
    warn('Verificare arhiva ESUATA:', veri.motiv);
    await alertEmail('[Contab backup] ARHIVA NERESTAURABILA: ' + f.name, 'Verificarea a esuat: ' + veri.motiv);
    process.exit(1);
  }
  log('Verificare arhiva OK:', veri.firme, 'firme, sqlite:', veri.sqlite);

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
    if (enc.status === 0) { offsitePath = encPath; log('Offsite criptat:', path.basename(encPath)); }
    else warn('Criptarea offsite a esuat (se trimite necriptat):', (enc.stderr || enc.error || '').toString().slice(0, 200));
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
  if (RCLONE_REMOTE) {
    offsiteConfigured = true;
    const { spawnSync } = require('child_process');
    const rc = spawnSync('rclone', ['copy', offsitePath, RCLONE_REMOTE], { encoding: 'utf8', timeout: 10 * 60 * 1000 });
    if (rc.error) warn('Offsite rclone ESUAT:', rc.error.message);
    else if (rc.status !== 0) warn('Offsite rclone ESUAT:', (rc.stderr || '').slice(0, 300));
    else { offsiteOk = true; log('Offsite rclone OK ->', RCLONE_REMOTE); }
  }
  if (offsitePath !== f.path) { try { fs.unlinkSync(offsitePath); } catch (_) { /* best effort */ } }
  if (!offsiteConfigured) warn('ATENTIE: nicio copie offsite configurata (CONTAB_BACKUP_EMAIL_TO / RCLONE_REMOTE).');
  else if (!offsiteOk) process.exitCode = 1; // offsite configurat dar esuat -> semnaleaza in cron log
}

main().catch(async (e) => {
  warn('Contab backup ESUAT:', e.message);
  await alertEmail('[Contab backup] ESUAT', 'Backupul zilnic a esuat: ' + e.message);
  process.exit(1);
});
