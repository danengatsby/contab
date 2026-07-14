'use strict';

const fs = require('fs');
const path = require('path');

function backupDir(dataDir) {
  const dir = path.join(dataDir, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Copiaza db.json intr-o arhiva datata; pastreaza ultimele `keep` copii. */
function backupNow(dbFile, dataDir, keep) {
  if (!fs.existsSync(dbFile)) throw new Error('Baza de date nu exista inca.');
  const dir = backupDir(dataDir);
  const name = 'db-' + stamp() + '.json';
  fs.copyFileSync(dbFile, path.join(dir, name));
  const list = listBackups(dataDir);
  const max = keep || 30;
  for (const b of list.slice(max)) { try { fs.unlinkSync(path.join(dir, b.name)); } catch (_) { /* ignora */ } }
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
  zip.writeZip(path.join(dir, name));
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

module.exports = { backupNow, listBackups, backupPath, fullBackup };
