'use strict';

const fs = require('fs');
const path = require('path');

function backupDir(dataDir) {
  const dir = path.join(dataDir, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* best-effort */ }
  return dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Igiena data/: sterge backup-urile ad-hoc `db.json.bak-*` din radacina data/ peste ultimele
 * `keep` (dupa data modificarii). NU atinge `db.pre-*.json` — acelea sunt backup-uri UNICE de
 * migrare (rollback) si trebuie pastrate. Best-effort. Configurabil prin CONTAB_BACKUP_KEEP_ADHOC.
 */
function pruneStrayBackups(dataDir, keep) {
  const max = keep || 10;
  let files;
  try { files = fs.readdirSync(dataDir); } catch (_) { return { removed: 0 }; }
  const stray = files
    .filter((f) => /^db\.json\.bak-/.test(f))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dataDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // cele mai noi primele
  let removed = 0;
  for (const s of stray.slice(max)) { try { fs.unlinkSync(path.join(dataDir, s.name)); removed += 1; } catch (_) { /* ignora */ } }
  return { removed, kept: Math.min(stray.length, max) };
}

/** Copiile create inainte de inlocuirea unei firme la import. Sunt plasa de siguranta
 * pe termen scurt, nu arhiva permanenta de date personale. */
function prunePreRestoreBackups(dataDir, keep) {
  const max = keep || 10;
  const dir = backupDir(dataDir);
  let list;
  try {
    list = fs.readdirSync(dir)
      .filter((f) => /^pre-restore-firma\d+-\d+\.json$/.test(f))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) { return { removed: 0, kept: 0 }; }
  let removed = 0;
  for (const x of list.slice(max)) { try { fs.unlinkSync(path.join(dir, x.name)); removed += 1; } catch (_) { /* best-effort */ } }
  return { removed, kept: Math.min(list.length, max) };
}

/** Copiaza db.json intr-o arhiva datata; pastreaza ultimele `keep` copii. */
function backupNow(dbFile, dataDir, keep) {
  if (!fs.existsSync(dbFile)) throw new Error('Baza de date nu exista inca.');
  const dir = backupDir(dataDir);
  const name = 'db-' + stamp() + '.json';
  fs.copyFileSync(dbFile, path.join(dir, name));
  try { fs.chmodSync(path.join(dir, name), 0o600); } catch (_) { /* best-effort */ }
  const list = listBackups(dataDir);
  const max = keep || 30;
  for (const b of list.slice(max)) { try { fs.unlinkSync(path.join(dir, b.name)); } catch (_) { /* ignora */ } }
  // igiena radacinii data/: nu lasa backup-urile ad-hoc db.json.bak-* sa se acumuleze la nesfarsit
  try { pruneStrayBackups(dataDir, Number(process.env.CONTAB_BACKUP_KEEP_ADHOC) || 10); } catch (_) { /* ignora */ }
  try { prunePreRestoreBackups(dataDir, Number(process.env.CONTAB_BACKUP_KEEP_PRE_RESTORE) || 10); } catch (_) { /* ignora */ }
  return { name, count: Math.min(list.length, max) };
}

/** Lista copiilor (cea mai noua prima). */
function listBackups(dataDir) {
  const dir = backupDir(dataDir);
  return fs.readdirSync(dir)
    .filter((f) => /^db-.*\.json$/.test(f))
    .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function backupPath(dataDir, name) {
  const safe = path.basename(String(name)); // previne traversarea de cale
  if (!/^db-.*\.json$/.test(safe)) return null;
  const p = path.join(backupDir(dataDir), safe);
  return fs.existsSync(p) ? p : null;
}

/**
 * Arhiva completa pentru dezastru (full-YYYYMMDD-HHMMSS.zip): db.json + instantaneu
 * consistent al bazei SQLite (VACUUM INTO, sigur sub WAL) + documentele din uploads/.
 * Pastreaza ultimele `keep` arhive. Restaurare: db.json prin Setari -> Backup -> Restaureaza,
 * fisierele din uploads/ inapoi in data/uploads/.
 */
function fullBackup(dbFile, dataDir, keep) {
  const AdmZip = require('adm-zip');
  const dir = backupDir(dataDir);
  const ts = stamp();
  const name = 'full-' + ts + '.zip';
  const zip = new AdmZip();
  if (fs.existsSync(dbFile)) zip.addLocalFile(dbFile, '', 'db.json');

  const driver = (process.env.CONTAB_DB_DRIVER || 'sqlite').toLowerCase();

  // instantaneu SQLite — best-effort (db.json ramane autoritar pentru restaurare).
  // Sarit pe driverul pg: un contab.sqlite ramas de la instalarea veche ar fi invechit.
  const sqliteFile = path.join(dataDir, 'contab.sqlite');
  let snap = null;
  if (driver !== 'pg' && driver !== 'postgres' && fs.existsSync(sqliteFile)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      snap = path.join(dir, '.snapshot-' + ts + '.sqlite');
      if (fs.existsSync(snap)) fs.unlinkSync(snap); // VACUUM INTO cere destinatie inexistenta
      const src = new DatabaseSync(sqliteFile, { readOnly: true });
      try { src.exec("VACUUM INTO '" + snap.replace(/'/g, "''") + "'"); } finally { src.close(); }
      zip.addLocalFile(snap, '', 'contab.sqlite');
    } catch (_) { snap = null; }
  }

  // dump nativ PostgreSQL — best-effort (db.json ramane autoritar pentru restaurare)
  let pgDump = null;
  if (driver === 'pg' || driver === 'postgres') {
    try {
      const { spawnSync } = require('child_process');
      pgDump = path.join(dir, '.snapshot-' + ts + '.sql');
      const args = process.env.CONTAB_PG_URL
        ? ['--dbname=' + process.env.CONTAB_PG_URL, '-f', pgDump]
        : ['-d', process.env.PGDATABASE || 'contab', '-f', pgDump];
      const rc = spawnSync('pg_dump', args, { encoding: 'utf8', timeout: 5 * 60 * 1000 });
      if (rc.status === 0 && fs.existsSync(pgDump)) zip.addLocalFile(pgDump, '', 'contab.sql');
      else pgDump = null;
    } catch (_) { pgDump = null; }
  }

  const uploads = path.join(dataDir, 'uploads');
  if (fs.existsSync(uploads)) zip.addLocalFolder(uploads, 'uploads');
  // jurnalul de audit DURABIL (append-only) — proba pentru control intern, offsite cu backupul
  const auditDir = path.join(dataDir, 'audit');
  if (fs.existsSync(auditDir)) zip.addLocalFolder(auditDir, 'audit');
  zip.writeZip(path.join(dir, name));
  try { fs.chmodSync(path.join(dir, name), 0o600); } catch (_) { /* best-effort */ }
  if (snap) { try { fs.unlinkSync(snap); } catch (_) { /* ignora */ } }
  if (pgDump) { try { fs.unlinkSync(pgDump); } catch (_) { /* ignora */ } }

  // rotatie arhive complete
  const zips = fs.readdirSync(dir)
    .filter((f) => /^full-.*\.zip$/.test(f))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const z of zips.slice(keep || 14)) { try { fs.unlinkSync(path.join(dir, z.name)); } catch (_) { /* ignora */ } }

  return { name, path: path.join(dir, name), size: fs.statSync(path.join(dir, name)).size };
}

/** Arhivele complete (full-*.zip) din data/backups, cele mai noi primele. Folosita de drill-ul
 *  nativ (la cerere si periodic): amandoua vor „ultima arhiva", si nu are voie sa fie doua reguli. */
function listFullArchives(dataDir) {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^full-.*\.zip$/.test(f))
    .map((f) => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** Verificarea RESTAURABILITATII unei arhive complete: se deschide, db.json trebuie sa fie
 *  JSON valid cu lista de firme, iar instantaneul sqlite sa fie prezent si nenul. Ruleaza
 *  dupa fiecare backup — un backup care nu se poate restaura e doar zgomot pe disc. */
function verifyArchive(zipPath) {
  const AdmZip = require('adm-zip');
  try {
    const zip = new AdmZip(zipPath);
    const je = zip.getEntry('db.json');
    if (!je) return { ok: false, motiv: 'db.json lipseste din arhiva' };
    const d = JSON.parse(zip.readAsText(je));
    if (!Array.isArray(d.firme)) return { ok: false, motiv: 'db.json nu contine lista de firme' };
    const sq = zip.getEntry('contab.sqlite');
    const size = fs.statSync(zipPath).size;
    return { ok: true, firme: d.firme.length, sqlite: !!(sq && sq.header.size > 0), size };
  } catch (e) { return { ok: false, motiv: e.message }; }
}

module.exports = { backupNow, listBackups, backupPath, fullBackup, pruneStrayBackups, prunePreRestoreBackups, verifyArchive, listFullArchives };
