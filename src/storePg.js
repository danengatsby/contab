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
const { ARRAY_COLLS } = require('./store'); // sursa unica a listei de colectii (identica cu SQLite)

let pool = null;
let queue = Promise.resolve(); // coada seriala de tranzactii persist
let lastHash = {}; // dirty-tracking per colectie, ca in store.js
let lastWritten = [];

function sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function asInt(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

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
}

/** Baza e proaspata (fara date persistate)? */
async function isEmpty() {
  const r = await pool.query('SELECT COUNT(*) AS n FROM meta');
  return !r.rows[0] || Number(r.rows[0].n) === 0;
}

/** Reseteaza amprentele -> urmatorul persist rescrie tot (dupa hydrate/restore). */
function resetDirty() { lastHash = {}; }

/** Aplica un set de colectii fotografiate, intr-o singura tranzactie. */
async function applyWork(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const w of work) {
      if (w.kind === 'array') {
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
    const rows = arr.map((item) => ({
      id: c.hasId && item && item.id != null ? String(item.id) : null,
      firmaId: c.firma && item && item.firmaId != null ? asInt(item.firmaId) : null,
      data: item,
    }));
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
    const h = sha(stringifyDb({ s: db.settings || {}, f: db.firmaActiva, q: db.seq }));
    if (lastHash.meta !== h) {
      work.push({
        kind: 'meta', h, hk: 'meta', name: 'meta',
        entries: [
          ['settings', stringifyDb(db.settings || {})],
          ['firmaActiva', stringifyDb(db.firmaActiva != null ? db.firmaActiva : 1)],
          ['seq', stringifyDb(db.seq != null ? db.seq : 1)],
        ],
      });
    }
  }

  if (!work.length) return queue; // nimic schimbat -> nicio tranzactie

  queue = queue
    .then(() => applyWork(work))
    .then(() => {
      // amprentele se actualizeaza DOAR dupa commit reusit (esec -> retry la urmatorul save)
      for (const w of work) lastHash[w.hk] = w.h;
      lastWritten = work.map((w) => w.name);
    })
    .catch((e) => {
      console.error('[contab] persist PostgreSQL ESUAT (se reincearca la urmatorul save):', e.message);
    });
  return queue;
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
  return db;
}

async function close() {
  if (!pool) return;
  try { await flush(); } catch (_) { /* ignora */ }
  const p = pool; pool = null;
  try { await p.end(); } catch (_) { /* ignora */ }
}

module.exports = { open, schema, isEmpty, persist, hydrate, close, resetDirty, written, flush };
