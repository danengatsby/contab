'use strict';

// Strat relational PostgreSQL (pg, async). Acelasi layout ca src/store.js (SQLite):
const { stringifyDb } = require('./util');
// tabele reale per-colectie cu coloane id/"firmaId" indexate + coloana `data` JSONB
// pentru restul campurilor. Aplicatia lucreaza tot pe graful in memorie: `hydrate()`
// il construieste din tabele, `persist(db)` il scrie inapoi.
//
// Deosebirea fata de SQLite: clientul pg e asincron, dar save()-ul aplicatiei e sincron.
// persist() FOTOGRAFIAZA sincron colectiile murdare (serializare + amprenta) si pune
// aplicarea SQL intr-o COADA seriala (o singura tranzactie in zbor la un moment dat,
// in ordinea apelurilor). La esec, amprentele raman neschimbate -> urmatorul save()
// reincearca aceleasi colectii. flush() (apelat la oprire) asteapta golirea cozii.
//
// Conexiunea: CONTAB_PG_URL (connection string) sau, implicit, socketul local
// /var/run/postgresql cu autentificare peer (rolul = utilizatorul OS) si baza
// PGDATABASE || 'contab'.

const crypto = require('crypto');
const { Pool } = require('pg');
const { ARRAY_COLLS, PROJECTIONS } = require('./store'); // sursa unica a listei de colectii + registrul de proiectii (identice cu SQLite)

let pool = null;
let queue = Promise.resolve(); // coada seriala de tranzactii persist
// Dirty-tracking, ca in store.js (SQLite): colectiile cu `id` primesc INSERT/UPDATE/DELETE per rand
// (diff fata de `snap`), nu DELETE+INSERT integral. `snap[colectie]` = Map(id -> json persistat la
// ultimul commit reusit. Restul (colectii fara id, partners/opening/meta) raman pe rescriere completa
// portita de amprenta (`lastHash`). Starea se actualizeaza DOAR dupa commit -> esec = retry idempotent.
let snap = {};     // { [colectie hasId]: Map(id -> json) }
let lastHash = {}; // amprenta pt colectiile rescrise integral
let lastWritten = [];

function sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function asInt(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function firmaOf(c, item) { return c.firma && item && item.firmaId != null ? asInt(item.firmaId) : null; }

async function open() {
  if (pool) return pool;
  pool = new Pool(
    process.env.CONTAB_PG_URL
      ? { connectionString: process.env.CONTAB_PG_URL }
      : { host: process.env.PGHOST || '/var/run/postgresql', database: process.env.PGDATABASE || 'contab' }
  );
  pool.on('error', (e) => console.error('[contab] pg pool:', e.message));
  await schema();
  return pool;
}

async function schema() {
  for (const c of ARRAY_COLLS) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${c.key.toLowerCase()} (
      rowid BIGSERIAL PRIMARY KEY,
      id TEXT,
      "firmaId" INTEGER,
      data JSONB NOT NULL
    )`);
    if (c.firma) await pool.query(`CREATE INDEX IF NOT EXISTS idx_${c.key.toLowerCase()}_firma ON ${c.key.toLowerCase()}("firmaId")`);
    if (c.hasId) await pool.query(`CREATE INDEX IF NOT EXISTS idx_${c.key.toLowerCase()}_id ON ${c.key.toLowerCase()}(id)`);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS partners (
    "firmaId" INTEGER NOT NULL, cui TEXT NOT NULL, data JSONB NOT NULL,
    PRIMARY KEY ("firmaId", cui)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS opening_balances (
    "firmaId" INTEGER NOT NULL, cont TEXT NOT NULL, d DOUBLE PRECISION DEFAULT 0, c DOUBLE PRECISION DEFAULT 0,
    PRIMARY KEY ("firmaId", cont)
  )`);
  await pool.query('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value JSONB)');
  // proiectie normalizata a liniilor (interogabila in SQL); derivata din blob-ul entries
  await pool.query(`CREATE TABLE IF NOT EXISTS entry_lines (
    rowid BIGSERIAL PRIMARY KEY,
    entry_id TEXT NOT NULL, "firmaId" INTEGER, period TEXT, status TEXT, seq INTEGER,
    debit TEXT, credit TEXT, suma DOUBLE PRECISION DEFAULT 0, explicatie TEXT
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_entry_lines_entry ON entry_lines(entry_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_entry_lines_firma ON entry_lines("firmaId", period)');
  // proiectie normalizata a documentelor (metadate interogabile + text pentru cautare SQL)
  await pool.query(`CREATE TABLE IF NOT EXISTS documents_meta (
    doc_id TEXT PRIMARY KEY, "firmaId" INTEGER, "fileName" TEXT, "uploadedAt" TEXT, "spvMsgId" TEXT,
    "textLen" INTEGER DEFAULT 0, text TEXT
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_documents_meta_firma ON documents_meta("firmaId", "uploadedAt")');
  // proiectie audit APPEND-ONLY, durabila (decuplata de plafonul RAM); PK pe audit_id (dedup)
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
    audit_id TEXT PRIMARY KEY, "firmaId" INTEGER, ts TEXT, "userId" TEXT, username TEXT,
    action TEXT, detail TEXT, "viaAdmin" TEXT
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_log_firma ON audit_log("firmaId", ts)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)');
}

/** Baza e proaspata (fara date persistate)? */
async function isEmpty() {
  const r = await pool.query('SELECT COUNT(*) AS n FROM meta');
  return !r.rows[0] || Number(r.rows[0].n) === 0;
}

/** Reseteaza starea persistata -> urmatorul persist rescrie tot (dupa hydrate/restore). */
function resetDirty() { snap = {}; lastHash = {}; }

/** Aplica un set de colectii fotografiate, intr-o singura tranzactie. */
async function applyWork(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const w of work) {
      if (w.kind === 'incr') {
        // diff per rand: sterge randurile schimbate/scoase, apoi (re)insereaza cele curente.
        // delete-then-insert = idempotent (sigur si daca un persist concurent a rescris deja randul).
        const t = w.c.key.toLowerCase();
        const upserts = w.inserts.concat(w.updates);
        const delIds = upserts.map((r) => r.id).concat(w.deletes);
        if (delIds.length) await client.query(`DELETE FROM ${t} WHERE id = ANY($1::text[])`, [delIds]);
        if (upserts.length) {
          await client.query(
            `INSERT INTO ${t} (id, "firmaId", data)
             SELECT x.id, x."firmaId", x.data FROM jsonb_to_recordset($1::jsonb) AS x(id TEXT, "firmaId" INTEGER, data JSONB)`,
            [stringifyDb(upserts)]
          );
        }
        for (const p of PROJECTIONS) if (p.coll === w.c.key) await projectInto(client, p, w);
      } else if (w.kind === 'array') {
        const t = w.c.key.toLowerCase();
        await client.query(`DELETE FROM ${t}`);
        if (w.items.length) {
          // un singur INSERT per colectie, din snapshotul JSON (rowid pastreaza ordinea)
          await client.query(
            `INSERT INTO ${t} (id, "firmaId", data)
             SELECT x.id, x."firmaId", x.data FROM jsonb_to_recordset($1::jsonb) AS x(id TEXT, "firmaId" INTEGER, data JSONB)`,
            [w.json]
          );
        }
        for (const p of PROJECTIONS) if (p.coll === w.c.key) await projectInto(client, p, w);
      } else if (w.kind === 'partners') {
        await client.query('DELETE FROM partners');
        await client.query(
          `INSERT INTO partners ("firmaId", cui, data)
           SELECT x."firmaId", x.cui, x.data FROM jsonb_to_recordset($1::jsonb) AS x("firmaId" INTEGER, cui TEXT, data JSONB)`,
          [w.json]
        );
      } else if (w.kind === 'opening') {
        await client.query('DELETE FROM opening_balances');
        await client.query(
          `INSERT INTO opening_balances ("firmaId", cont, d, c)
           SELECT x."firmaId", x.cont, x.d, x.c FROM jsonb_to_recordset($1::jsonb) AS x("firmaId" INTEGER, cont TEXT, d DOUBLE PRECISION, c DOUBLE PRECISION)`,
          [w.json]
        );
      } else if (w.kind === 'meta') {
        for (const [k, v] of w.entries) {
          await client.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Fotografiaza sincron colectiile schimbate de la ultimul persist si pune scrierea
 * in coada seriala. Intoarce promisiunea cozii (rutele sincrone o ignora; flush() o asteapta).
 */
function persist(db) {
  const work = [];
  for (const c of ARRAY_COLLS) {
    const arr = Array.isArray(db[c.key]) ? db[c.key] : [];

    // Colectiile cu `id`: diff incremental per rand fata de snapshot-ul persistat.
    if (c.hasId) {
      const cur = new Map();      // id -> json (pt. diff + snapshot)
      const rowById = new Map();  // id -> { id, firmaId, data } (pt. INSERT)
      let bad = false;
      for (const item of arr) {
        const key = item && item.id != null ? String(item.id) : null;
        if (key == null || cur.has(key)) { bad = true; break; } // id lipsa/duplicat -> rescriere completa
        cur.set(key, stringifyDb(item));
        rowById.set(key, { id: key, firmaId: firmaOf(c, item), data: item });
      }
      const prev = snap[c.key];
      if (!bad && prev !== undefined) {
        const inserts = []; const updates = []; const deletes = [];
        for (const [id, json] of cur) {
          const before = prev.get(id);
          if (before === undefined) inserts.push(rowById.get(id));
          else if (before !== json) updates.push(rowById.get(id));
        }
        for (const id of prev.keys()) if (!cur.has(id)) deletes.push(id);
        if (inserts.length || updates.length || deletes.length) work.push({ kind: 'incr', c, inserts, updates, deletes, cur, snapKey: c.key, name: c.key.toLowerCase() });
        continue;
      }
      if (!bad && prev === undefined && cur.size === 0) { snap[c.key] = cur; continue; } // colectie goala: fixeaza snapshot
      // fallback: fara snapshot (init) SAU id-uri stricate -> rescriere completa + (re)initializare snapshot
      const rows = arr.map((item) => ({ id: item && item.id != null ? String(item.id) : null, firmaId: firmaOf(c, item), data: item }));
      work.push({ kind: 'array', c, items: rows, json: stringifyDb(rows), cur, snapKey: c.key, name: c.key.toLowerCase() });
      continue;
    }

    // Colectii fara `id` (openingAnalytic, customAccounts): rescriere completa portita de amprenta.
    const rows = arr.map((item) => ({ id: null, firmaId: firmaOf(c, item), data: item }));
    const json = stringifyDb(rows);
    const h = sha(json);
    if (lastHash['a:' + c.key] !== h) work.push({ kind: 'array', c, items: rows, json, h, hk: 'a:' + c.key, name: c.key.toLowerCase() });
  }
  {
    const rows = [];
    for (const fid of Object.keys(db.partners || {})) {
      const byCui = db.partners[fid] || {};
      for (const cui of Object.keys(byCui)) rows.push({ firmaId: asInt(fid), cui: String(cui), data: byCui[cui] });
    }
    const json = stringifyDb(rows);
    const h = sha(stringifyDb(db.partners || {}));
    if (lastHash.partners !== h) work.push({ kind: 'partners', json, h, hk: 'partners', name: 'partners' });
  }
  {
    const rows = [];
    for (const fid of Object.keys(db.openingBalances || {})) {
      const byCont = db.openingBalances[fid] || {};
      for (const cont of Object.keys(byCont)) {
        const v = byCont[cont] || {};
        rows.push({ firmaId: asInt(fid), cont: String(cont), d: Number(v.d) || 0, c: Number(v.c) || 0 });
      }
    }
    const json = stringifyDb(rows);
    const h = sha(stringifyDb(db.openingBalances || {}));
    if (lastHash.opening !== h) work.push({ kind: 'opening', json, h, hk: 'opening', name: 'opening_balances' });
  }
  {
    const h = sha(stringifyDb({ s: db.settings || {}, f: db.firmaActiva, q: db.seq, v: db.schemaVersion != null ? db.schemaVersion : 0 }));
    if (lastHash.meta !== h) {
      work.push({
        kind: 'meta', h, hk: 'meta', name: 'meta',
        entries: [
          ['settings', stringifyDb(db.settings || {})],
          ['firmaActiva', stringifyDb(db.firmaActiva != null ? db.firmaActiva : 1)],
          ['seq', stringifyDb(db.seq != null ? db.seq : 1)],
          ['schemaVersion', stringifyDb(db.schemaVersion != null ? db.schemaVersion : 0)],
        ],
      });
    }
  }

  if (!work.length) { lastWritten = []; return queue; } // nimic schimbat -> nicio tranzactie

  queue = queue
    .then(() => applyWork(work))
    .then(() => {
      // starea persistata se actualizeaza DOAR dupa commit reusit (esec -> retry idempotent la urmatorul save)
      for (const w of work) {
        if (w.snapKey) snap[w.snapKey] = w.cur;   // colectii cu id: snapshot per rand
        else if (w.hk) lastHash[w.hk] = w.h;       // colectii fara id + partners/opening/meta
      }
      lastWritten = work.map((w) => w.name);
    })
    .catch((e) => {
      console.error('[contab] persist PostgreSQL ESUAT (se reincearca la urmatorul save):', e.message);
    });
  return queue;
}

/** Sincronizeaza o proiectie (din PROJECTIONS) pentru work-ul colectiei sursa (in aceeasi tranzactie). */
async function projectInto(client, p, w) {
  const rows = [];
  const insertCols = p.cols.map((c) => (/[A-Z]/.test(c) ? '"' + c + '"' : c)).join(', '); // "firmaId","fileName"... citate
  if (p.append) {
    // APPEND-ONLY (audit): insereaza doar randuri noi (ON CONFLICT DO NOTHING), nu sterge niciodata.
    const src = w.kind === 'incr' ? w.inserts.concat(w.updates) : w.items; // deletes (plafonate) IGNORATE
    for (const r of src) for (const pr of p.rows(r.id, r.firmaId, r.data)) rows.push(pr);
    if (rows.length) {
      await client.query(
        `INSERT INTO ${p.table} (${insertCols}) SELECT ${p.pgSelect} FROM jsonb_to_recordset($1::jsonb) AS x(${p.pgRecordset}) ON CONFLICT (${p.idCol}) DO NOTHING`,
        [stringifyDb(rows)]
      );
    }
    return;
  }
  // OGLINDA (entries/documents): reflecta exact starea din RAM.
  if (w.kind === 'incr') {
    const upserts = w.inserts.concat(w.updates); // [{id, firmaId, data}]
    const ids = upserts.map((r) => r.id).concat(w.deletes);
    for (const r of upserts) for (const pr of p.rows(r.id, r.firmaId, r.data)) rows.push(pr);
    if (ids.length) await client.query(`DELETE FROM ${p.table} WHERE ${p.idCol} = ANY($1::text[])`, [ids]);
  } else { // 'array' = rescriere completa a colectiei sursa
    await client.query(`DELETE FROM ${p.table}`);
    for (const r of w.items) for (const pr of p.rows(r.id, r.firmaId, r.data)) rows.push(pr);
  }
  if (rows.length) {
    await client.query(
      `INSERT INTO ${p.table} (${insertCols}) SELECT ${p.pgSelect} FROM jsonb_to_recordset($1::jsonb) AS x(${p.pgRecordset})`,
      [stringifyDb(rows)]
    );
  }
}

/** Rulajul pe conturi calculat DIRECT in SQL din entry_lines (doar articole postate), pentru o firma
 *  si optional o perioada (YYYY sau YYYY-MM). Intoarce { cont: { d, c } } — aceeasi forma ca
 *  accounting.accumulate. Demonstreaza calcul analitic fara a incarca graful in RAM. */
async function linesTurnover(firmaId, period, opts) {
  const acc = {};
  const bump = (cont, side, s) => { if (cont == null) return; acc[cont] = acc[cont] || { d: 0, c: 0 }; acc[cont][side] += s; };
  const params = [asInt(firmaId), 'postat'];
  let where = '"firmaId" = $1 AND (status IS NULL OR status = $2)';
  if (opts && opts.before) { if (period) { params.push(period); where += ' AND period < $3'; } } // rulaj INAINTE de perioada
  else if (period) { params.push(String(period).length === 4 ? period + '-%' : period); where += String(period).length === 4 ? ' AND period LIKE $3' : ' AND period = $3'; }
  const dq = await pool.query(`SELECT debit AS cont, SUM(suma) AS s FROM entry_lines WHERE ${where} AND debit IS NOT NULL GROUP BY debit`, params);
  const cq = await pool.query(`SELECT credit AS cont, SUM(suma) AS s FROM entry_lines WHERE ${where} AND credit IS NOT NULL GROUP BY credit`, params);
  for (const r of dq.rows) bump(r.cont, 'd', Number(r.s) || 0);
  for (const r of cq.rows) bump(r.cont, 'c', Number(r.s) || 0);
  return acc;
}

/** Statistici pe documente calculate in SQL din documents_meta (fara graful in RAM), per firma. */
async function documentsStats(firmaId) {
  const r = await pool.query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE "textLen" > 0) AS cutext, COUNT(*) FILTER (WHERE "spvMsgId" IS NOT NULL) AS dinspv
     FROM documents_meta WHERE "firmaId" = $1`, [asInt(firmaId)]
  );
  const x = r.rows[0] || {};
  return { total: Number(x.total) || 0, cuText: Number(x.cutext) || 0, dinSpv: Number(x.dinspv) || 0 };
}

/** Cautare documente in SQL (nume fisier sau text extras), per firma. Fara a incarca graful in RAM. */
async function documentsSearch(firmaId, q, limit) {
  const like = '%' + String(q || '').toLowerCase() + '%';
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const r = await pool.query(
    `SELECT doc_id, "fileName", "uploadedAt" FROM documents_meta
     WHERE "firmaId" = $1 AND (LOWER("fileName") LIKE $2 OR LOWER(text) LIKE $2) ORDER BY "uploadedAt" DESC LIMIT $3`,
    [asInt(firmaId), like, lim]
  );
  return r.rows.map((x) => ({ id: x.doc_id, fileName: x.fileName, uploadedAt: x.uploadedAt }));
}

/** Jurnalul de audit DURABIL (append-only) interogat in SQL: numar total (per firma optional).
 *  Decuplat de plafonul RAM -> total poate depasi CONTAB_AUDIT_MAX. */
async function auditCount(firmaId) {
  const r = firmaId == null
    ? await pool.query('SELECT COUNT(*) AS n FROM audit_log')
    : await pool.query('SELECT COUNT(*) AS n FROM audit_log WHERE "firmaId" = $1', [asInt(firmaId)]);
  return Number(r.rows[0] && r.rows[0].n) || 0;
}
async function auditRecent(opts) {
  const o = opts || {};
  const cond = []; const params = [];
  if (o.firmaId != null) { params.push(asInt(o.firmaId)); cond.push('"firmaId" = $' + params.length); }
  if (o.action) { params.push(String(o.action)); cond.push('action = $' + params.length); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  params.push(Math.min(1000, Math.max(1, Number(o.limit) || 100)));
  const r = await pool.query(`SELECT audit_id, "firmaId", ts, "userId", username, action, detail, "viaAdmin" FROM audit_log ${where} ORDER BY ts DESC LIMIT $${params.length}`, params);
  return r.rows.map((x) => ({ id: x.audit_id, firmaId: x.firmaId, ts: x.ts, userId: x.userId, username: x.username, action: x.action, detail: x.detail, viaAdmin: x.viaAdmin }));
}

/** Colectiile scrise la ultimul persist reusit (diagnostic). */
function written() { return lastWritten.slice(); }

/** Asteapta golirea cozii de scrieri (inainte de backup / la oprire). */
function flush() { return queue; }

/** Reconstruieste graful in memorie din tabele (forma identica cu cea folosita de aplicatie). */
async function hydrate(defaults) {
  const db = {};
  for (const c of ARRAY_COLLS) {
    const r = await pool.query(`SELECT data FROM ${c.key.toLowerCase()} ORDER BY rowid`);
    db[c.key] = r.rows.map((x) => x.data);
  }
  db.partners = {};
  for (const r of (await pool.query('SELECT "firmaId", cui, data FROM partners')).rows) {
    if (!db.partners[r.firmaId]) db.partners[r.firmaId] = {};
    db.partners[r.firmaId][r.cui] = r.data;
  }
  db.openingBalances = {};
  for (const r of (await pool.query('SELECT "firmaId", cont, d, c FROM opening_balances')).rows) {
    if (!db.openingBalances[r.firmaId]) db.openingBalances[r.firmaId] = {};
    db.openingBalances[r.firmaId][r.cont] = { d: r.d, c: r.c };
  }
  const meta = {};
  for (const r of (await pool.query('SELECT key, value FROM meta')).rows) meta[r.key] = r.value;
  db.settings = meta.settings || (defaults ? JSON.parse(JSON.stringify(defaults.settings)) : {});
  db.firmaActiva = meta.firmaActiva != null ? meta.firmaActiva : 1;
  db.seq = meta.seq != null ? meta.seq : 1;
  if (meta.schemaVersion != null) db.schemaVersion = meta.schemaVersion;
  return db;
}

async function close() {
  if (!pool) return;
  try { await flush(); } catch (_) { /* ignora */ }
  const p = pool; pool = null;
  try { await p.end(); } catch (_) { /* ignora */ }
}

module.exports = { open, schema, isEmpty, persist, hydrate, close, resetDirty, written, flush, linesTurnover, documentsStats, documentsSearch, auditCount, auditRecent };
