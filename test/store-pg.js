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

  section('Proiectie normalizata entry_lines + rulaj SQL = rulaj RAM');
  {
    const acc = require('../src/accounting');
    for (const t of ARRAY_COLLS) await pool.query('TRUNCATE ' + t.key.toLowerCase() + ' RESTART IDENTITY');
    await pool.query('TRUNCATE entry_lines RESTART IDENTITY');
    store.resetDirty();
    const el = base();
    el.entries = [
      { id: 'l1', firmaId: 1, period: '2026-03', data: '2026-03-10', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] },
      { id: 'l2', firmaId: 1, period: '2026-03', data: '2026-03-20', lines: [{ debit: '5121', credit: '4111', suma: 500 }] },
      { id: 'l3', firmaId: 1, period: '2026-03', data: '2026-03-21', status: 'ciorna', lines: [{ debit: '5311', credit: '707', suma: 999 }] },
      { id: 'l4', firmaId: 2, period: '2026-03', data: '2026-03-15', lines: [{ debit: '371', credit: '401', suma: 800 }] },
    ];
    store.persist(el); await store.flush();
    const sql = await store.linesTurnover(1, '2026-03');
    const ram = acc.accumulate(acc.allLines(acc.postedEntries({ entries: el.entries.filter((e) => e.firmaId === 1) })));
    eq('rulaj SQL(entry_lines) = rulaj RAM(accumulate) pe firma 1', JSON.stringify(sql), JSON.stringify(ram));
    ok('ciorna l3 exclusa din rulajul SQL (5311 absent)', !sql['5311']);
    ok('izolare pe firma: 371 (firma 2) absent din rulajul firmei 1', !sql['371']);
    const t2 = await store.linesTurnover(2, '2026-03');
    ok('rulaj firma 2 vede 371/401', t2['371'] && t2['371'].d === 800 && t2['401'] && t2['401'].c === 800);
    el.entries = el.entries.filter((e) => e.id !== 'l2');
    store.persist(el); await store.flush();
    ok('dupa stergere l2: 5121 dispare din rulaj', !(await store.linesTurnover(1, '2026-03'))['5121']);
    const nLines = (await pool.query('SELECT COUNT(*) n FROM entry_lines')).rows[0].n;
    eq('entry_lines are exact liniile ramase (l1:2 + l3:1 + l4:1)', Number(nLines), 4);
  }

  section('Proiectie normalizata documents_meta + cautare/stats SQL');
  {
    for (const t of ARRAY_COLLS) await pool.query('TRUNCATE ' + t.key.toLowerCase() + ' RESTART IDENTITY');
    await pool.query('TRUNCATE documents_meta'); await pool.query('TRUNCATE entry_lines');
    store.resetDirty();
    const dm = base();
    dm.documents = [
      { id: 'd1', firmaId: 1, fileName: 'factura-101.pdf', uploadedAt: '2026-03-10T10:00:00Z', text: 'Factura catre ACME cu TVA' },
      { id: 'd2', firmaId: 1, fileName: 'chitanta.pdf', uploadedAt: '2026-03-11T10:00:00Z', text: '' },
      { id: 'd3', firmaId: 2, fileName: 'contract.pdf', uploadedAt: '2026-03-12T10:00:00Z', text: 'contract prestari' },
    ];
    store.persist(dm); await store.flush();
    const st = await store.documentsStats(1);
    eq('documente firma 1: total 2, cu text 1', st.total + '/' + st.cuText, '2/1');
    ok('cautare pe TEXT extras ("acme") -> gaseste d1', (await store.documentsSearch(1, 'acme')).some((r) => r.id === 'd1'));
    ok('cautare pe nume fisier ("factura") -> gaseste d1', (await store.documentsSearch(1, 'factura')).some((r) => r.id === 'd1'));
    ok('izolare pe firma: "contract" (firma 2) NU apare la firma 1', (await store.documentsSearch(1, 'contract')).length === 0);
    ok('firma 2 gaseste contractul', (await store.documentsSearch(2, 'contract')).some((r) => r.id === 'd3'));
    dm.documents = dm.documents.filter((d) => d.id !== 'd1');
    store.persist(dm); await store.flush();
    eq('dupa stergere d1: total firma 1 scade la 1', (await store.documentsStats(1)).total, 1);
    const nDocs = (await pool.query('SELECT COUNT(*) n FROM documents_meta')).rows[0].n;
    eq('documents_meta are exact d2+d3', Number(nDocs), 2);
  }

  section('Proiectie audit APPEND-ONLY (durabila, decuplata de plafonul RAM)');
  {
    for (const t of ARRAY_COLLS) await pool.query('TRUNCATE ' + t.key.toLowerCase() + ' RESTART IDENTITY');
    await pool.query('TRUNCATE audit_log');
    store.resetDirty();
    const au = base();
    for (let i = 1; i <= 5; i++) au.audit.push({ id: i, ts: '2026-03-0' + i + 'T10:00:00Z', firmaId: 1, userId: 1, username: 'admin', action: 'login', detail: 'ev' + i });
    store.persist(au); await store.flush();
    eq('audit_log dupa 5 evenimente', await store.auditCount(), 5);
    au.audit = au.audit.slice(-2);
    au.audit.push({ id: 6, ts: '2026-03-06T10:00:00Z', firmaId: 1, userId: 1, username: 'admin', action: 'entry.create', detail: 'ev6' });
    au.audit.push({ id: 7, ts: '2026-03-07T10:00:00Z', firmaId: 2, userId: 2, username: 'x', action: 'login', detail: 'ev7' });
    store.persist(au); await store.flush();
    eq('audit_log NU se plafoneaza: toate cele 7 (durabil)', await store.auditCount(), 7);
    eq('numararea pe firma 1', await store.auditCount(1), 6);
    eq('blob audit (mirror RAM, plafonat) = 4 vs audit_log durabil = 7', (await pool.query('SELECT COUNT(*) n FROM audit')).rows[0].n + '/' + (await store.auditCount()), '4/7');
    eq('filtrare pe actiune login', (await store.auditRecent({ action: 'login' })).map((r) => Number(r.id)).sort((a, b) => a - b).join(','), '1,2,3,4,5,7');
    store.persist(au); await store.flush();
    eq('re-persist nu dubleaza (ON CONFLICT DO NOTHING)', await store.auditCount(), 7);
  }

  await pool.end(); await store.close();
  console.log('\n' + (fail ? '✗' : '✓') + ' ' + pass + ' verificari store-pg trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
