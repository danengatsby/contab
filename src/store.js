'use strict';

// Strat relational SQLite (node:sqlite, sincron — se potriveste cu modelul sincron al aplicatiei).
// Tabele reale per-colectie, cu coloane id/firmaId indexate (interogabile in SQL) + o coloana
// `data` JSON pentru restul campurilor. Aplicatia continua sa lucreze pe graful in memorie:
// `hydrate()` construieste obiectul din tabele, `persist(db)` il scrie inapoi intr-o tranzactie.

// Ascunde avertismentul "SQLite is experimental" ca sa nu polueze logurile pm2.
const _emitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (String(w).includes('SQLite is an experimental')) return;
  return _emitWarning.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

// Dirty-tracking: amprenta ultimei stari persistate, per colectie. La save() rescriem DOAR
// colectiile a caror amprenta s-a schimbat (de obicei 2-3, nu toate 14+).
let lastHash = {};
let lastWritten = []; // colectiile scrise la ultimul persist (pentru diagnostic/teste)
function sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

// Colectii-array: { cheie, are firmaId?, are camp id? } -> fiecare devine un tabel.
const ARRAY_COLLS = [
  { key: 'users', firma: false, hasId: true },
  { key: 'firme', firma: false, hasId: true },
  { key: 'documents', firma: true, hasId: true },
  { key: 'entries', firma: true, hasId: true },
  { key: 'assets', firma: true, hasId: true },
  { key: 'angajati', firma: true, hasId: true },
  { key: 'payrollHistory', firma: true, hasId: true },
  { key: 'products', firma: true, hasId: true },
  { key: 'gestiuni', firma: true, hasId: true },
  { key: 'stockMovements', firma: true, hasId: true },
  { key: 'inventories', firma: true, hasId: true },
  { key: 'openingAnalytic', firma: true, hasId: false },
  { key: 'audit', firma: true, hasId: true },
  { key: 'customAccounts', firma: false, hasId: false },
  { key: 'messages', firma: false, hasId: true },
  { key: 'recurringInvoices', firma: true, hasId: true },
  { key: 'recipes', firma: true, hasId: true },
  { key: 'budgets', firma: true, hasId: true },
];

let sdb = null;

function open(file) {
  if (sdb) return sdb;
  sdb = new DatabaseSync(file);
  sdb.exec('PRAGMA journal_mode = WAL');
  sdb.exec('PRAGMA busy_timeout = 5000');
  sdb.exec('PRAGMA foreign_keys = ON');
  schema();
  return sdb;
}

function schema() {
  for (const c of ARRAY_COLLS) {
    sdb.exec(`CREATE TABLE IF NOT EXISTS ${c.key} (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT,
      firmaId INTEGER,
      data TEXT NOT NULL
    )`);
    if (c.firma) sdb.exec(`CREATE INDEX IF NOT EXISTS idx_${c.key}_firma ON ${c.key}(firmaId)`);
    if (c.hasId) sdb.exec(`CREATE INDEX IF NOT EXISTS idx_${c.key}_id ON ${c.key}(id)`);
  }
  sdb.exec(`CREATE TABLE IF NOT EXISTS partners (
    firmaId INTEGER NOT NULL, cui TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (firmaId, cui)
  )`);
  sdb.exec(`CREATE TABLE IF NOT EXISTS opening_balances (
    firmaId INTEGER NOT NULL, cont TEXT NOT NULL, d REAL DEFAULT 0, c REAL DEFAULT 0,
    PRIMARY KEY (firmaId, cont)
  )`);
  sdb.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
}

/** Baza e proaspata (fara date persistate)? */
function isEmpty() {
  const r = sdb.prepare('SELECT COUNT(*) AS n FROM meta').get();
  return !r || r.n === 0;
}

function asInt(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/** Reseteaza amprentele -> urmatorul persist rescrie tot (dupa hydrate/restore). */
function resetDirty() { lastHash = {}; }

/**
 * Scrie in tabele DOAR colectiile schimbate de la ultimul persist, intr-o singura tranzactie
 * (atomic, durabil prin WAL). Daca nimic nu s-a schimbat, nu face niciun I/O.
 */
function persist(db) {
  // 1) serializeaza si calculeaza amprentele; aduna doar ce s-a schimbat
  const work = [];
  for (const c of ARRAY_COLLS) {
    const arr = Array.isArray(db[c.key]) ? db[c.key] : [];
    const items = arr.map((item) => [
      c.hasId && item && item.id != null ? String(item.id) : null,
      c.firma && item && item.firmaId != null ? asInt(item.firmaId) : null,
      JSON.stringify(item),
    ]);
    const h = sha(items.map((x) => x[2]).join(''));
    if (lastHash['a:' + c.key] !== h) work.push({ kind: 'array', c, items, h, hk: 'a:' + c.key });
  }
  const ph = sha(JSON.stringify(db.partners || {}));
  if (lastHash.partners !== ph) work.push({ kind: 'partners', h: ph, hk: 'partners' });
  const oh = sha(JSON.stringify(db.openingBalances || {}));
  if (lastHash.opening !== oh) work.push({ kind: 'opening', h: oh, hk: 'opening' });
  const mh = sha(JSON.stringify({ s: db.settings || {}, f: db.firmaActiva, q: db.seq }));
  if (lastHash.meta !== mh) work.push({ kind: 'meta', h: mh, hk: 'meta' });

  lastWritten = [];
  if (!work.length) return; // nimic schimbat -> zero scrieri pe disc

  // 2) aplica intr-o tranzactie
  sdb.exec('BEGIN');
  try {
    for (const w of work) {
      if (w.kind === 'array') {
        sdb.exec(`DELETE FROM ${w.c.key}`);
        if (w.items.length) {
          const ins = sdb.prepare(`INSERT INTO ${w.c.key} (id, firmaId, data) VALUES (?, ?, ?)`);
          for (const it of w.items) ins.run(it[0], it[1], it[2]);
        }
        lastWritten.push(w.c.key);
      } else if (w.kind === 'partners') {
        sdb.exec('DELETE FROM partners');
        const ins = sdb.prepare('INSERT INTO partners (firmaId, cui, data) VALUES (?, ?, ?)');
        for (const fid of Object.keys(db.partners || {})) {
          const byCui = db.partners[fid] || {};
          for (const cui of Object.keys(byCui)) ins.run(asInt(fid), String(cui), JSON.stringify(byCui[cui]));
        }
        lastWritten.push('partners');
      } else if (w.kind === 'opening') {
        sdb.exec('DELETE FROM opening_balances');
        const ins = sdb.prepare('INSERT INTO opening_balances (firmaId, cont, d, c) VALUES (?, ?, ?, ?)');
        for (const fid of Object.keys(db.openingBalances || {})) {
          const byCont = db.openingBalances[fid] || {};
          for (const cont of Object.keys(byCont)) {
            const v = byCont[cont] || {};
            ins.run(asInt(fid), String(cont), Number(v.d) || 0, Number(v.c) || 0);
          }
        }
        lastWritten.push('opening_balances');
      } else if (w.kind === 'meta') {
        const insM = sdb.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        insM.run('settings', JSON.stringify(db.settings || {}));
        insM.run('firmaActiva', JSON.stringify(db.firmaActiva != null ? db.firmaActiva : 1));
        insM.run('seq', JSON.stringify(db.seq != null ? db.seq : 1));
        lastWritten.push('meta');
      }
    }
    sdb.exec('COMMIT');
  } catch (e) {
    sdb.exec('ROLLBACK');
    throw e;
  }
  // 3) actualizeaza amprentele DOAR dupa commit reusit
  for (const w of work) lastHash[w.hk] = w.h;
}

/** Colectiile scrise la ultimul persist (diagnostic). */
function written() { return lastWritten.slice(); }

/** Reconstruieste graful in memorie din tabele (forma identica cu cea folosita de aplicatie). */
function hydrate(defaults) {
  const db = {};
  for (const c of ARRAY_COLLS) {
    const rows = sdb.prepare(`SELECT data FROM ${c.key} ORDER BY rowid`).all();
    db[c.key] = rows.map((r) => JSON.parse(r.data));
  }
  db.partners = {};
  for (const r of sdb.prepare('SELECT firmaId, cui, data FROM partners').all()) {
    if (!db.partners[r.firmaId]) db.partners[r.firmaId] = {};
    db.partners[r.firmaId][r.cui] = JSON.parse(r.data);
  }
  db.openingBalances = {};
  for (const r of sdb.prepare('SELECT firmaId, cont, d, c FROM opening_balances').all()) {
    if (!db.openingBalances[r.firmaId]) db.openingBalances[r.firmaId] = {};
    db.openingBalances[r.firmaId][r.cont] = { d: r.d, c: r.c };
  }
  const meta = {};
  for (const r of sdb.prepare('SELECT key, value FROM meta').all()) meta[r.key] = JSON.parse(r.value);
  db.settings = meta.settings || (defaults ? JSON.parse(JSON.stringify(defaults.settings)) : {});
  db.firmaActiva = meta.firmaActiva != null ? meta.firmaActiva : 1;
  db.seq = meta.seq != null ? meta.seq : 1;
  return db;
}

function close() { if (sdb) { try { sdb.close(); } catch (_) { /* ignore */ } sdb = null; } }

module.exports = { open, schema, isEmpty, persist, hydrate, close, resetDirty, written, ARRAY_COLLS };
