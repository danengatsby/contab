'use strict';

// Teste pentru stratul PostgreSQL INCREMENTAL (src/storePg.js): paritate cu store.js (SQLite) —
// scrieri per-rand (INSERT/UPDATE/DELETE doar pe ce s-a schimbat), nu DELETE+INSERT integral.
// Ruleaza DOAR cand exista o baza pg de test (CONTAB_PG_URL); altfel se sare (CI: job test-postgres).

if (!process.env.CONTAB_PG_URL) {
  console.log('store-pg: SARIT (fara CONTAB_PG_URL — baza pg de test)');
  process.exit(0);
}

const { Pool } = require('pg');
const store = require('../src/storePg');
const { ARRAY_COLLS } = require('../src/store');

let pass = 0; let fail = 0;
function eq(name, got, exp) { if (got === exp) pass += 1; else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(exp)); } }
function ok(name, cond) { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + name); } }
function section(t) { console.log('\n' + t); }

function base() {
  const d = { partners: {}, openingBalances: {}, settings: {}, firmaActiva: 1, seq: 1, schemaVersion: 0 };
  for (const c of ARRAY_COLLS) d[c.key] = [];
  return d;
}
function mkEntry(id, firmaId, suma) { return { id, firmaId, tip: 'x', suma: suma || 0, lines: [{ debit: '5121', credit: '4111', suma: suma || 0 }] }; }

(async () => {
  const pool = new Pool({ connectionString: process.env.CONTAB_PG_URL });
  await store.open();
  // izolare: goleste tabelele (baza de test e partajata cu suita http)
  for (const c of ARRAY_COLLS) await pool.query('TRUNCATE ' + c.key.toLowerCase() + ' RESTART IDENTITY');
  await pool.query('TRUNCATE partners'); await pool.query('TRUNCATE opening_balances'); await pool.query('DELETE FROM meta');
  store.resetDirty();

  section('Persist initial + no-op');
  const db = base();
  db.entries = [mkEntry('e1', 1, 10), mkEntry('e2', 1, 20), mkEntry('e3', 2, 30)];
  db.audit = [{ id: 1, firmaId: 1, action: 'creare' }];
  db.seq = 7;
  store.persist(db); await store.flush();
  ok('persist scrie entries', store.written().includes('entries'));
  ok('persist scrie audit', store.written().includes('audit'));
  ok('persist scrie meta', store.written().includes('meta'));
  ok('persist NU scrie o colectie goala (products)', !store.written().includes('products'));
  store.persist(db); await store.flush();
  eq('persist fara schimbari -> zero scrieri', store.written().length, 0);

  section('Update / insert / delete incremental — doar colectia atinsa');
  db.entries[1].suma = 999;
  store.persist(db); await store.flush();
  eq('update 1 entry -> se scrie doar entries', store.written().join(','), 'entries');
  db.audit.push({ id: 2, firmaId: 1, action: 'modificare' });
  store.persist(db); await store.flush();
  eq('adaugare in audit -> se scrie doar audit', store.written().join(','), 'audit');
  db.seq = 8;
  store.persist(db); await store.flush();
  eq('schimbarea seq -> se scrie doar meta', store.written().join(','), 'meta');

  section('Incremental real: randurile neschimbate NU se rescriu (rowid stabil)');
  const rid = async (id) => { const r = await pool.query('SELECT rowid FROM entries WHERE id=$1', [id]); return r.rows[0] && Number(r.rows[0].rowid); };
  const e1Before = await rid('e1'); const e3Before = await rid('e3');
  db.entries.push(mkEntry('e4', 1, 40)); // insert
  store.persist(db); await store.flush();
  eq('insert e4 -> doar entries', store.written().join(','), 'entries');
  ok('e1 nu a fost rescris (rowid stabil)', (await rid('e1')) === e1Before);
  ok('e3 nu a fost rescris (rowid stabil)', (await rid('e3')) === e3Before);
  ok('e4 exista', (await rid('e4')) != null);
  db.entries = db.entries.filter((e) => e.id !== 'e3'); // delete
  store.persist(db); await store.flush();
  eq('delete e3 -> doar entries', store.written().join(','), 'entries');
  ok('e3 sters din tabel', (await rid('e3')) == null);
  ok('e1 tot stabil dupa delete', (await rid('e1')) === e1Before);

  section('Fidelitate hydrate <-> persist');
  const h = await store.hydrate({ settings: {} });
  eq('hydrate: 3 entries (e1,e2,e4)', (h.entries || []).length, 3);
  ok('hydrate: e2 are suma modificata 999', (h.entries || []).some((e) => e.id === 'e2' && e.suma === 999));

  await pool.end(); await store.close();
  console.log('\n' + (fail ? '✗' : '✓') + ' ' + pass + ' verificari store-pg trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
