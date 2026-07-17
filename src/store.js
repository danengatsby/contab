'use strict';

// Strat relational SQLite (node:sqlite, sincron — se potriveste cu modelul sincron al aplicatiei).
//
// DEPENDENTA PE API EXPERIMENTAL, tinuta sub control prin trei plase:
//  1. suprafata folosita e mica si enumerata intr-un test de CONTRACT (test/store.js):
//     new DatabaseSync(file[, {readOnly}]), exec, prepare -> run/get/all, close, PRAGMA,
//     tranzactii prin exec(BEGIN/COMMIT/ROLLBACK); orice schimbare la un upgrade de Node
//     pica testul cu nume clar — si la `prestart`, deci inainte de pornirea serverului;
//  2. utilizarea e izolata: acest fisier + snapshotul VACUUM INTO din src/backup.js
//     (care are deja fallback gratios); schimbul pe better-sqlite3 (API sincron compatibil)
//     ar atinge doar aceste doua locuri;
//  3. productia ruleaza pe PostgreSQL (CONTAB_DB_DRIVER=pg) — nu e expusa deloc;
//     sqlite e implicitul pentru dev/teste, iar json ramane rollback.
const { stringifyDb } = require('./util');
// Tabele reale per-colectie, cu coloane id/firmaId indexate (interogabile in SQL) + o coloana
// `data` JSON pentru restul campurilor. Aplicatia continua sa lucreze pe graful in memorie:
// `hydrate()` construieste obiectul din tabele, `persist(db)` il scrie inapoi intr-o tranzactie.

// Ascunde DOAR avertismentul "SQLite is experimental" ca sa nu polueze logurile pm2
// (restul avertismentelor trec nefiltrate).
const _emitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (String(w).includes('SQLite is an experimental')) return;
  return _emitWarning.call(process, w, ...rest);
};
// node:sqlite exista abia din Node 22.5 (sub flag pana la 22.13/23.4); pe Node mai vechi
// require-ul arunca o eroare criptica DESI sqlite e driverul IMPLICIT. Garda de mai jos
// transforma caderea intr-un mesaj actionabil (cerinta de Node + driverele alternative).
function checkSqlite(mod, version) {
  if (mod && mod.DatabaseSync) return mod;
  throw new Error('Driverul sqlite are nevoie de node:sqlite (DatabaseSync), indisponibil pe Node '
    + (version || process.version) + '. Cerinta: Node >= 22.13 (sau 22.5+ pornit cu --experimental-sqlite). '
    + 'Alternative: CONTAB_DB_DRIVER=pg (PostgreSQL) sau CONTAB_DB_DRIVER=json (rollback).');
}
let sqliteMod = null;
try { sqliteMod = require('node:sqlite'); } catch (e) { /* modul absent (Node < 22.5) -> mesajul gardei */ }
const { DatabaseSync } = checkSqlite(sqliteMod);
const crypto = require('crypto');

// ── Dirty-tracking ──
// Colectiile cu `id` (entries, audit, stockMovements…) cresc nelimitat, deci NU le mai rescriem
// integral la fiecare save(). `snap[colectie]` = Map(id -> JSON persistat la ultimul commit); la
// persist calculam diferenta fata de memorie si aplicam DOAR randurile schimbate (INSERT/UPDATE/
// DELETE per id). Colectiile fara `id` (openingAnalytic, customAccounts) + partners/opening/meta
// raman pe rescriere completa, dar doar cand amprenta (`lastHash`) lor s-a schimbat.
let snap = {};        // { [colectie hasId]: Map(id -> json) } — starea persistata, per rand
let lastHash = {};    // amprenta ultimei stari persistate pt. colectiile rescrise integral
let forceFull = false; // dupa resetDirty(): urmatorul persist rescrie tot (init/restore)
let lastWritten = []; // colectiile scrise la ultimul persist (pentru diagnostic/teste)
function sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
const EMPTY = new Map();

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
  { key: 'declarations', firma: true, hasId: true },
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
function firmaOf(c, item) { return c.firma && item && item.firmaId != null ? asInt(item.firmaId) : null; }

/** Reseteaza starea persistata -> urmatorul persist rescrie tot (dupa hydrate/restore). */
function resetDirty() { snap = {}; lastHash = {}; forceFull = true; }

/**
 * Scrie in tabele DOAR ce s-a schimbat de la ultimul persist, intr-o singura tranzactie (atomic,
 * durabil prin WAL). Colectiile cu `id` primesc INSERT/UPDATE/DELETE per rand (diff fata de snap);
 * restul se rescriu integral doar daca amprenta lor s-a schimbat. Nimic schimbat -> zero I/O.
 */
function persist(db) {
  const full = forceFull;
  const work = [];

  // ── 1) Colectiile-array: diff incremental (hasId) sau rescriere completa (fara id / forceFull) ──
  for (const c of ARRAY_COLLS) {
    const arr = Array.isArray(db[c.key]) ? db[c.key] : [];

    if (c.hasId && !full) {
      // Construieste starea curenta cheiata pe id; id lipsa/duplicat -> cade pe rescriere completa.
      const cur = new Map();   // id -> json (pt. diff + snapshot)
      const fid = new Map();   // id -> firmaId (pt. coloana indexata)
      let bad = false;
      for (const item of arr) {
        const key = item && item.id != null ? String(item.id) : null;
        if (key == null || cur.has(key)) { bad = true; break; }
        cur.set(key, stringifyDb(item));
        fid.set(key, firmaOf(c, item));
      }
      if (!bad) {
        const prev = snap[c.key];
        if (prev === undefined) {
          // fara snapshot (colectie noua): daca e goala, fixeaza snapshot gol si mergi mai departe;
          // altfel se rescrie integral mai jos, ca sa initializam corect tabelul + snapshot-ul.
          if (cur.size === 0) { snap[c.key] = cur; continue; }
        } else {
          const inserts = []; const updates = [];
          for (const [id, json] of cur) {
            const before = prev.get(id);
            if (before === undefined) inserts.push([id, fid.get(id), json]);
            else if (before !== json) updates.push([id, fid.get(id), json]);
          }
          const deletes = [];
          for (const id of prev.keys()) if (!cur.has(id)) deletes.push(id);
          if (inserts.length || updates.length || deletes.length) work.push({ kind: 'incr', c, inserts, updates, deletes, snap: cur });
          continue;
        }
      }
      // fallback: id-uri stricate SAU initializare fara snapshot -> rescriere completa
      const items = arr.map((it) => [String(it.id), firmaOf(c, it), stringifyDb(it)]);
      const m = new Map(); for (const it of items) if (it[0] != null) m.set(it[0], it[2]);
      work.push({ kind: 'full', c, items, snap: m });
      continue;
    }

    // hasId:false, sau forceFull: rescriere completa, portita de amprenta (lastHash).
    const items = arr.map((it) => [c.hasId && it && it.id != null ? String(it.id) : null, firmaOf(c, it), stringifyDb(it)]);
    const h = sha(items.map((x) => x[2]).join(''));
    if (full || lastHash['a:' + c.key] !== h) {
      const w = { kind: 'full', c, items };
      if (c.hasId) { const m = new Map(); for (const it of items) if (it[0] != null) m.set(it[0], it[2]); w.snap = m; }
      else { w.h = h; w.hk = 'a:' + c.key; }
      work.push(w);
    }
  }

  // ── 2) Mapari cheiate (partners/opening) + meta: rescriere completa portita de amprenta ──
  const ph = sha(stringifyDb(db.partners || {}));
  if (full || lastHash.partners !== ph) work.push({ kind: 'partners', h: ph, hk: 'partners' });
  const oh = sha(stringifyDb(db.openingBalances || {}));
  if (full || lastHash.opening !== oh) work.push({ kind: 'opening', h: oh, hk: 'opening' });
  const mh = sha(stringifyDb({ s: db.settings || {}, f: db.firmaActiva, q: db.seq, v: db.schemaVersion != null ? db.schemaVersion : 0 }));
  if (full || lastHash.meta !== mh) work.push({ kind: 'meta', h: mh, hk: 'meta' });

  lastWritten = [];
  if (!work.length) { forceFull = false; return; } // nimic schimbat -> zero scrieri pe disc

  // ── 3) Aplica intr-o tranzactie ──
  sdb.exec('BEGIN');
  try {
    for (const w of work) {
      if (w.kind === 'full') {
        sdb.exec(`DELETE FROM ${w.c.key}`);
        if (w.items.length) {
          const ins = sdb.prepare(`INSERT INTO ${w.c.key} (id, firmaId, data) VALUES (?, ?, ?)`);
          for (const it of w.items) ins.run(it[0], it[1], it[2]);
        }
        lastWritten.push(w.c.key);
      } else if (w.kind === 'incr') {
        const t = w.c.key;
        if (w.deletes.length) { const del = sdb.prepare(`DELETE FROM ${t} WHERE id = ?`); for (const id of w.deletes) del.run(id); }
        if (w.inserts.length) { const ins = sdb.prepare(`INSERT INTO ${t} (id, firmaId, data) VALUES (?, ?, ?)`); for (const r of w.inserts) ins.run(r[0], r[1], r[2]); }
        if (w.updates.length) { const upd = sdb.prepare(`UPDATE ${t} SET firmaId = ?, data = ? WHERE id = ?`); for (const r of w.updates) upd.run(r[1], r[2], r[0]); }
        lastWritten.push(t);
      } else if (w.kind === 'partners') {
        sdb.exec('DELETE FROM partners');
        const ins = sdb.prepare('INSERT INTO partners (firmaId, cui, data) VALUES (?, ?, ?)');
        for (const fid of Object.keys(db.partners || {})) {
          const byCui = db.partners[fid] || {};
          for (const cui of Object.keys(byCui)) ins.run(asInt(fid), String(cui), stringifyDb(byCui[cui]));
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
        insM.run('settings', stringifyDb(db.settings || {}));
        insM.run('firmaActiva', stringifyDb(db.firmaActiva != null ? db.firmaActiva : 1));
        insM.run('seq', stringifyDb(db.seq != null ? db.seq : 1));
        insM.run('schemaVersion', stringifyDb(db.schemaVersion != null ? db.schemaVersion : 0));
        lastWritten.push('meta');
      }
    }
    sdb.exec('COMMIT');
  } catch (e) {
    sdb.exec('ROLLBACK');
    throw e;
  }
  // ── 4) Actualizeaza starea persistata (snapshot / amprente) DOAR dupa commit reusit ──
  for (const w of work) {
    if (w.snap) snap[w.c.key] = w.snap;   // colectii cu id (incr/full)
    if (w.hk) lastHash[w.hk] = w.h;       // colectii fara id + partners/opening/meta
  }
  forceFull = false;
}

/** Colectiile scrise la ultimul persist (diagnostic). */
function written() { return lastWritten.slice(); }

/** Reconstruieste graful in memorie din tabele (forma identica cu cea folosita de aplicatie). */
function hydrate(defaults) {
  const db = {};
  snap = {}; // starea persistata pornita din tabele: primul persist va scrie doar diferentele (ex. normalizari migrate)
  for (const c of ARRAY_COLLS) {
    const rows = sdb.prepare(`SELECT data FROM ${c.key} ORDER BY rowid`).all();
    db[c.key] = rows.map((r) => JSON.parse(r.data));
    if (c.hasId) {
      const m = new Map();
      // Snapshot re-serializat din obiectul parsat -> se potriveste exact cu stringifyDb din persist.
      for (const it of db[c.key]) if (it && it.id != null) m.set(String(it.id), stringifyDb(it));
      snap[c.key] = m;
    }
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
  if (meta.schemaVersion != null) db.schemaVersion = meta.schemaVersion;
  return db;
}

function close() { if (sdb) { try { sdb.close(); } catch (_) { /* ignore */ } sdb = null; } }

module.exports = { open, schema, isEmpty, persist, hydrate, close, resetDirty, written, ARRAY_COLLS, checkSqlite };
