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
let commits = 0;      // tranzactii comise (paritate de contract cu storePg.queueStats)
let lastCommitAt = null;
let snap = {};        // { [colectie hasId]: Map(id -> json) } — starea persistata, per rand
let lastHash = {};    // amprenta ultimei stari persistate pt. colectiile rescrise integral
let forceFull = false; // dupa resetDirty(): urmatorul persist rescrie tot (init/restore)
let lastWritten = []; // colectiile scrise la ultimul persist (pentru diagnostic/teste)
// FENCING multi-scriitor: `dbEpoch` (meta) e versiunea bazei, verificata si avansata in ACEEASI
// tranzactie cu fiecare persist. Daca alt proces a scris intre timp (epoch avansat), scrierea
// noastra ar suprascrie randurile lui pornind din RAM invechit -> se REFUZA (fail-loud, inghetat),
// nu se reincearca. Completeaza lock-ul single-instance local (lifecycle) peste masini/DB partajat.
let epoch = 0;         // versiunea la ultimul commit reusit al ACESTUI proces
let conflictedFlag = false; // detectat alt scriitor -> toate persist-urile urmatoare refuzate
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
  { key: 'closings', firma: true, hasId: true },
];

// PROIECTII NORMALIZATE: tabele derivate din blob-uri, scrise tranzactional in aceeasi tranzactie cu
// colectia-sursa (blob-ul ramane sursa de adevar; hydrate NU le foloseste). Permit interogari SQL fara
// a incarca graful in RAM. Fiecare proiectie: colectia-sursa -> functie care intoarce randurile.
// Registrul e SURSA UNICA (folosit identic de SQLite si PostgreSQL).
function entryLineRows(id, firmaId, entry) {
  const lines = (entry && entry.lines) || [];
  const period = entry ? (entry.period || String(entry.data || '').slice(0, 7)) : '';
  const status = entry && entry.status ? String(entry.status) : null;
  const data = entry && entry.data != null ? String(entry.data) : null;
  const document = entry && entry.document != null ? String(entry.document) : null;
  const partener = entry && entry.partener != null ? String(entry.partener) : null;
  const tipNume = String((entry && entry.tipNume) || ''); // niciodata NULL (NULL = rand pre-migrare -> backfill)
  return lines.map((l, i) => ({
    entry_id: String(id), firmaId: firmaId != null ? firmaId : null, period, status, seq: i,
    data, document, partener, tipNume,
    debit: l && l.debit != null ? String(l.debit) : null,
    credit: l && l.credit != null ? String(l.credit) : null,
    suma: Number(l && l.suma) || 0,
    // acelasi lant de fallback ca accounting.allLines (echivalenta cu calea RAM)
    explicatie: String((l && l.explicatie) || (entry && entry.explicatie) || ''),
  }));
}
function documentMetaRow(id, firmaId, doc) {
  const text = doc && typeof doc.text === 'string' ? doc.text : '';
  return [{
    doc_id: String(id), firmaId: firmaId != null ? firmaId : null,
    fileName: doc && doc.fileName != null ? String(doc.fileName) : null,
    uploadedAt: doc && doc.uploadedAt != null ? String(doc.uploadedAt) : null,
    spvMsgId: doc && doc.spvMsgId != null ? String(doc.spvMsgId) : null,
    textLen: text.length,
    text: text.slice(0, 20000),
  }];
}

function auditRow(id, firmaId, rec) {
  return [{
    audit_id: String(id), firmaId: firmaId != null ? firmaId : null,
    ts: rec && rec.ts != null ? String(rec.ts) : null,
    userId: rec && rec.userId != null ? String(rec.userId) : null,
    username: rec && rec.username != null ? String(rec.username) : null,
    action: rec && rec.action != null ? String(rec.action) : null,
    detail: rec && rec.detail != null ? String(rec.detail) : null,
    viaAdmin: rec && rec.viaAdmin != null ? String(rec.viaAdmin) : null,
  }];
}

// Registru de proiectii. `cols` = coloanele (in ordine) pt SQLite; `pgRecordset`/`pgSelect` = spec.
// jsonb_to_recordset + lista de SELECT pt PostgreSQL (cu "firmaId" citat). `rows(id,firmaId,obj)`
// intoarce 0..N randuri (o linie -> N; un document -> 1). `append:true` = APPEND-ONLY: insereaza doar
// randuri noi (dedup pe id), nu sterge NICIODATA -> proiectia e durabila, decuplata de plafonul RAM
// (pt audit: baza vie e plafonata, dar tabelul audit_log pastreaza totul). Ordinea coloanelor identica.
const PROJECTIONS = [
  {
    coll: 'entries', table: 'entry_lines', idCol: 'entry_id', rows: entryLineRows,
    cols: ['entry_id', 'firmaId', 'period', 'status', 'seq', 'data', 'document', 'partener', 'tipNume', 'debit', 'credit', 'suma', 'explicatie'],
    pgSelect: 'x.entry_id, x."firmaId", x.period, x.status, x.seq, x.data, x.document, x.partener, x."tipNume", x.debit, x.credit, x.suma, x.explicatie',
    pgRecordset: 'entry_id TEXT, "firmaId" INTEGER, period TEXT, status TEXT, seq INTEGER, data TEXT, document TEXT, partener TEXT, "tipNume" TEXT, debit TEXT, credit TEXT, suma DOUBLE PRECISION, explicatie TEXT',
  },
  {
    coll: 'documents', table: 'documents_meta', idCol: 'doc_id', rows: documentMetaRow,
    cols: ['doc_id', 'firmaId', 'fileName', 'uploadedAt', 'spvMsgId', 'textLen', 'text'],
    pgSelect: 'x.doc_id, x."firmaId", x."fileName", x."uploadedAt", x."spvMsgId", x."textLen", x.text',
    pgRecordset: 'doc_id TEXT, "firmaId" INTEGER, "fileName" TEXT, "uploadedAt" TEXT, "spvMsgId" TEXT, "textLen" INTEGER, text TEXT',
  },
  {
    coll: 'audit', table: 'audit_log', idCol: 'audit_id', rows: auditRow, append: true,
    cols: ['audit_id', 'firmaId', 'ts', 'userId', 'username', 'action', 'detail', 'viaAdmin'],
    pgSelect: 'x.audit_id, x."firmaId", x.ts, x."userId", x.username, x.action, x.detail, x."viaAdmin"',
    pgRecordset: 'audit_id TEXT, "firmaId" INTEGER, ts TEXT, "userId" TEXT, username TEXT, action TEXT, detail TEXT, "viaAdmin" TEXT',
  },
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
  // proiectie normalizata a liniilor (interogabila in SQL); derivata din blob-ul entries
  sdb.exec(`CREATE TABLE IF NOT EXISTS entry_lines (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL, firmaId INTEGER, period TEXT, status TEXT, seq INTEGER,
    data TEXT, document TEXT, partener TEXT, tipNume TEXT,
    debit TEXT, credit TEXT, suma REAL DEFAULT 0, explicatie TEXT
  )`);
  // migrare aditiva pt tabelele entry_lines create inainte de coloanele data/document/partener/tipNume
  for (const col of ['data TEXT', 'document TEXT', 'partener TEXT', 'tipNume TEXT']) {
    try { sdb.exec('ALTER TABLE entry_lines ADD COLUMN ' + col); } catch (_) { /* coloana exista deja */ }
  }
  // BACKFILL (conditionat pe date, fara marker): randurile proiectate inainte de coloanele noi au
  // NULL in `data`/`tipNume` (proiectia noua scrie mereu tipNume >= '') -> reproiecteaza integral
  // din blob-ul entries. Idempotent: dupa backfill nu mai exista NULL. Pe DB proaspat -> no-op.
  if (sdb.prepare('SELECT 1 AS x FROM entry_lines WHERE data IS NULL OR tipNume IS NULL LIMIT 1').get()) {
    sdb.exec('DELETE FROM entry_lines');
    const p = PROJECTIONS.find((x) => x.coll === 'entries');
    const insB = sdb.prepare(`INSERT INTO entry_lines (${p.cols.join(', ')}) VALUES (${p.cols.map(() => '?').join(', ')})`);
    for (const r of sdb.prepare('SELECT id, firmaId, data FROM entries').all()) {
      let e; try { e = JSON.parse(r.data); } catch (_) { continue; }
      for (const lr of p.rows(r.id, r.firmaId, e)) insB.run(...p.cols.map((c) => lr[c]));
    }
  }
  sdb.exec('CREATE INDEX IF NOT EXISTS idx_entry_lines_entry ON entry_lines(entry_id)');
  sdb.exec('CREATE INDEX IF NOT EXISTS idx_entry_lines_firma ON entry_lines(firmaId, period)');
  sdb.exec('CREATE INDEX IF NOT EXISTS idx_entry_lines_debit ON entry_lines(firmaId, debit)');
  sdb.exec('CREATE INDEX IF NOT EXISTS idx_entry_lines_credit ON entry_lines(firmaId, credit)');
  // proiectie normalizata a documentelor (metadate interogabile + text pentru cautare SQL)
  sdb.exec(`CREATE TABLE IF NOT EXISTS documents_meta (
    doc_id TEXT PRIMARY KEY, firmaId INTEGER, fileName TEXT, uploadedAt TEXT, spvMsgId TEXT,
    textLen INTEGER DEFAULT 0, text TEXT
  )`);
  sdb.exec('CREATE INDEX IF NOT EXISTS idx_documents_meta_firma ON documents_meta(firmaId, uploadedAt)');
  // proiectie audit APPEND-ONLY, durabila (decuplata de plafonul RAM); PK pe audit_id (dedup)
  sdb.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    audit_id TEXT PRIMARY KEY, firmaId INTEGER, ts TEXT, userId TEXT, username TEXT,
    action TEXT, detail TEXT, viaAdmin TEXT
  )`);
  sdb.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_firma ON audit_log(firmaId, ts)');
  sdb.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)');
}

/** Sincronizeaza o proiectie (din PROJECTIONS) pentru work-ul colectiei sursa (in aceeasi tranzactie). */
function syncProjection(p, w) {
  // APPEND-ONLY (audit): insereaza doar randuri noi (OR IGNORE pe id), nu sterge niciodata.
  if (p.append) {
    const ins = sdb.prepare(`INSERT OR IGNORE INTO ${p.table} (${p.cols.join(', ')}) VALUES (${p.cols.map(() => '?').join(', ')})`);
    const src = w.kind === 'full' ? w.items : w.inserts.concat(w.updates); // deletes (plafonate) IGNORATE
    for (const row of src) { const obj = JSON.parse(row[2]); for (const r of p.rows(row[0], row[1], obj)) ins.run(...p.cols.map((c) => r[c])); }
    return;
  }
  // OGLINDA (entries/documents): reflecta exact starea din RAM (delete-then-insert + full-DELETE).
  const del = sdb.prepare(`DELETE FROM ${p.table} WHERE ${p.idCol} = ?`);
  const ins = sdb.prepare(`INSERT INTO ${p.table} (${p.cols.join(', ')}) VALUES (${p.cols.map(() => '?').join(', ')})`);
  const put = (row) => { // row = [id, firmaId, json]
    del.run(row[0]);
    const obj = JSON.parse(row[2]);
    for (const r of p.rows(row[0], row[1], obj)) ins.run(...p.cols.map((c) => r[c]));
  };
  if (w.kind === 'full') { sdb.exec(`DELETE FROM ${p.table}`); for (const row of w.items) put(row); }
  else { for (const id of w.deletes) del.run(id); for (const row of w.inserts) put(row); for (const row of w.updates) put(row); }
}

/** Jurnalul de audit DURABIL (append-only) interogat in SQL: numar total + eventual pe firma/actiune.
 *  Decuplat de plafonul RAM -> total poate depasi CONTAB_AUDIT_MAX. */
function auditCount(firmaId) {
  if (firmaId == null) return Number(sdb.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n) || 0;
  return Number(sdb.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE firmaId = ?').get(asInt(firmaId)).n) || 0;
}
function auditRecent(opts) {
  const o = opts || {};
  const cond = []; const params = [];
  if (o.firmaId != null) { cond.push('firmaId = ?'); params.push(asInt(o.firmaId)); }
  if (o.action) { cond.push('action = ?'); params.push(String(o.action)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  params.push(Math.min(1000, Math.max(1, Number(o.limit) || 100)));
  return sdb.prepare(`SELECT audit_id, firmaId, ts, userId, username, action, detail, viaAdmin FROM audit_log ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params).map((r) => ({ id: r.audit_id, firmaId: r.firmaId, ts: r.ts, userId: r.userId, username: r.username, action: r.action, detail: r.detail, viaAdmin: r.viaAdmin }));
}

/** Statistici pe documente calculate in SQL din documents_meta (fara graful in RAM), per firma. */
function documentsStats(firmaId) {
  const r = sdb.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN textLen > 0 THEN 1 ELSE 0 END), 0) AS cuText, COALESCE(SUM(CASE WHEN spvMsgId IS NOT NULL THEN 1 ELSE 0 END), 0) AS dinSpv FROM documents_meta WHERE firmaId = ?').get(asInt(firmaId));
  return { total: Number(r.total) || 0, cuText: Number(r.cuText) || 0, dinSpv: Number(r.dinSpv) || 0 };
}

/** Cautare documente in SQL (nume fisier sau text extras), per firma. Fara a incarca graful in RAM. */
function documentsSearch(firmaId, q, limit) {
  const like = '%' + String(q || '').toLowerCase() + '%';
  const rows = sdb.prepare(`SELECT doc_id, fileName, uploadedAt FROM documents_meta
    WHERE firmaId = ? AND (LOWER(fileName) LIKE ? OR LOWER(text) LIKE ?) ORDER BY uploadedAt DESC LIMIT ?`)
    .all(asInt(firmaId), like, like, Math.min(200, Math.max(1, Number(limit) || 50)));
  return rows.map((r) => ({ id: r.doc_id, fileName: r.fileName, uploadedAt: r.uploadedAt }));
}

/** Rulajul pe conturi calculat DIRECT in SQL din entry_lines (doar articole postate), pentru o firma
 *  si optional o perioada (YYYY sau YYYY-MM). Intoarce { cont: { d, c } } — aceeasi forma ca
 *  accounting.accumulate. Demonstreaza calcul analitic fara a incarca graful in RAM. */
function linesTurnover(firmaId, period, opts) {
  const acc = {};
  const bump = (cont, side, s) => { if (cont == null) return; acc[cont] = acc[cont] || { d: 0, c: 0 }; acc[cont][side] += s; };
  let where = 'firmaId = ? AND (status IS NULL OR status = ?)';
  const params = [asInt(firmaId), 'postat'];
  if (opts && opts.before) { if (period) { where += ' AND period < ?'; params.push(period); } } // rulaj INAINTE de perioada (solduri initiale)
  else if (period) { if (String(period).length === 4) { where += ' AND period LIKE ?'; params.push(period + '-%'); } else { where += ' AND period = ?'; params.push(period); } }
  for (const r of sdb.prepare(`SELECT debit AS cont, SUM(suma) AS s FROM entry_lines WHERE ${where} AND debit IS NOT NULL GROUP BY debit`).all(...params)) bump(r.cont, 'd', Number(r.s) || 0);
  for (const r of sdb.prepare(`SELECT credit AS cont, SUM(suma) AS s FROM entry_lines WHERE ${where} AND credit IS NOT NULL GROUP BY credit`).all(...params)) bump(r.cont, 'c', Number(r.s) || 0);
  return acc;
}

/** TOATE liniile perioadei, DIRECT din SQL (entry_lines) — pentru registrul-jurnal si cartea mare
 *  fara a itera graful. Doar articole postate. Ordinea finala (data + id natural) se face in
 *  apelant (localeCompare numeric nu se reproduce in SQL). Perioada YYYY sau YYYY-MM. */
function linesForPeriod(firmaId, period) {
  const params = [asInt(firmaId), 'postat'];
  let where = 'firmaId = ? AND (status IS NULL OR status = ?)';
  if (period) { if (String(period).length === 4) { where += ' AND period LIKE ?'; params.push(period + '-%'); } else { where += ' AND period = ?'; params.push(period); } }
  return sdb.prepare(`SELECT entry_id, seq, data, document, partener, tipNume, explicatie, debit, credit, suma FROM entry_lines WHERE ${where}`)
    .all(...params).map((r) => ({ entry_id: r.entry_id, seq: r.seq, data: r.data, document: r.document, partener: r.partener, tipNume: r.tipNume, explicatie: r.explicatie, debit: r.debit, credit: r.credit, suma: Number(r.suma) || 0 }));
}

/** Miscarile unui cont in perioada, DIRECT din SQL (entry_lines), ordonate cronologic — pentru fisa de
 *  cont fara a itera graful. Doar articole postate. Perioada YYYY sau YYYY-MM. */
function linesForAccount(firmaId, cont, period) {
  const params = [asInt(firmaId), 'postat'];
  let where = 'firmaId = ? AND (status IS NULL OR status = ?)';
  if (period) { if (String(period).length === 4) { where += ' AND period LIKE ?'; params.push(period + '-%'); } else { where += ' AND period = ?'; params.push(period); } }
  where += ' AND (debit = ? OR credit = ?)'; params.push(String(cont), String(cont));
  return sdb.prepare(`SELECT data, document, partener, explicatie, debit, credit, suma FROM entry_lines WHERE ${where} ORDER BY data, seq`)
    .all(...params).map((r) => ({ data: r.data, document: r.document, partener: r.partener, explicatie: r.explicatie, debit: r.debit, credit: r.credit, suma: Number(r.suma) || 0 }));
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

/** Starea „cozii" de persistenta pe SQLite: persist() e SINCRON, deci nu exista niciodata ceva
 *  in asteptare. Exista ca sa aiba apelantii (metrici, jobul de veghe) un contract unic, fara
 *  ramuri pe driver — iar `pendingAgeMs: 0` e adevarul, nu o valoare de umplutura. */
function queueStats() {
  return {
    driver: 'sqlite', pending: false, pendingAgeMs: 0, pendingBytes: 0, draining: false,
    commits, failStreak: 0, lastCommitAt, lastError: null, conflicted: conflictedFlag,
  };
}

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

  // Inghetat dupa un conflict de scriitor: RAM-ul nostru e invechit fata de baza — orice scriere
  // ar suprascrie datele celuilalt proces. Esec zgomotos, nu corupere tacuta.
  if (conflictedFlag) {
    const e = new Error('Persistenta blocata: alt proces a scris in baza (conflict dbEpoch). Reporneste procesul ca sa rehidrateze starea curenta.');
    e.code = 'CONTAB_WRITER_CONFLICT';
    throw e;
  }

  // ── 3) Aplica intr-o tranzactie ──
  sdb.exec('BEGIN');
  try {
    // FENCING: verifica si avanseaza dbEpoch in aceeasi tranzactie cu datele.
    const er = sdb.prepare("SELECT value FROM meta WHERE key = 'dbEpoch'").get();
    const curEpoch = er ? Number(JSON.parse(er.value)) : 0;
    if (curEpoch !== epoch) {
      const e = new Error('Conflict de scriitor: dbEpoch in baza este ' + curEpoch + ', procesul curent are ' + epoch + ' — alt proces a scris intre timp.');
      e.code = 'CONTAB_WRITER_CONFLICT';
      throw e;
    }
    sdb.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('dbEpoch', stringifyDb(epoch + 1));
    for (const w of work) {
      if (w.kind === 'full') {
        sdb.exec(`DELETE FROM ${w.c.key}`);
        if (w.items.length) {
          const ins = sdb.prepare(`INSERT INTO ${w.c.key} (id, firmaId, data) VALUES (?, ?, ?)`);
          for (const it of w.items) ins.run(it[0], it[1], it[2]);
        }
        for (const p of PROJECTIONS) if (p.coll === w.c.key) syncProjection(p, w);
        lastWritten.push(w.c.key);
      } else if (w.kind === 'incr') {
        const t = w.c.key;
        if (w.deletes.length) { const del = sdb.prepare(`DELETE FROM ${t} WHERE id = ?`); for (const id of w.deletes) del.run(id); }
        if (w.inserts.length) { const ins = sdb.prepare(`INSERT INTO ${t} (id, firmaId, data) VALUES (?, ?, ?)`); for (const r of w.inserts) ins.run(r[0], r[1], r[2]); }
        if (w.updates.length) { const upd = sdb.prepare(`UPDATE ${t} SET firmaId = ?, data = ? WHERE id = ?`); for (const r of w.updates) upd.run(r[1], r[2], r[0]); }
        for (const p of PROJECTIONS) if (p.coll === w.c.key) syncProjection(p, w);
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
    if (e && e.code === 'CONTAB_WRITER_CONFLICT') {
      conflictedFlag = true; // ingheata scrierile: RAM-ul e invechit, reincercarea ar suprascrie
      console.error('[contab] CONFLICT DE SCRIITOR (sqlite): ' + e.message);
    }
    throw e;
  }
  epoch += 1; // versiunea avansata odata cu commit-ul
  commits += 1; lastCommitAt = new Date().toISOString();
  // ── 4) Actualizeaza starea persistata (snapshot / amprente) DOAR dupa commit reusit ──
  for (const w of work) {
    if (w.snap) snap[w.c.key] = w.snap;   // colectii cu id (incr/full)
    if (w.hk) lastHash[w.hk] = w.h;       // colectii fara id + partners/opening/meta
  }
  forceFull = false;
}

/** A fost detectat alt scriitor (persistenta inghetata)? Diagnostic pentru metrici/teste. */
function conflicted() { return conflictedFlag; }

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
  epoch = Number(meta.dbEpoch) || 0; // sincronizeaza fence-ul cu versiunea persistata
  db.settings = meta.settings || (defaults ? JSON.parse(JSON.stringify(defaults.settings)) : {});
  db.firmaActiva = meta.firmaActiva != null ? meta.firmaActiva : 1;
  db.seq = meta.seq != null ? meta.seq : 1;
  if (meta.schemaVersion != null) db.schemaVersion = meta.schemaVersion;
  return db;
}

function close() { if (sdb) { try { sdb.close(); } catch (_) { /* ignore */ } sdb = null; } }

module.exports = { open, schema, isEmpty, persist, hydrate, close, resetDirty, written, queueStats, ARRAY_COLLS, PROJECTIONS, entryLineRows, documentMetaRow, auditRow, linesTurnover, linesForAccount, linesForPeriod, documentsStats, documentsSearch, auditCount, auditRecent, conflicted, checkSqlite };
