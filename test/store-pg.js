'use strict';

// Teste pentru stratul PostgreSQL INCREMENTAL (src/storePg.js): paritate cu store.js (SQLite) —
// scrieri per-rand (INSERT/UPDATE/DELETE doar pe ce s-a schimbat), nu DELETE+INSERT integral.
// Ruleaza DOAR cand exista o baza pg de test (CONTAB_PG_URL); altfel se sare (CI: job test-postgres).

if (!process.env.CONTAB_PG_URL) {
  // Mesajul spune explicit CE nu s-a verificat: `pg` e driverul din PRODUCTIE, iar restul suitei
  // ruleaza pe sqlite. Un „SARIT" neutru se citeste ca „nimic de facut" si lasa impresia falsa ca
  // `npm test` verde acopera productia.
  console.log('store-pg: SARIT — fara CONTAB_PG_URL. ATENTIE: `pg` e driverul din PRODUCTIE,');
  console.log('          iar restul suitei ruleaza pe sqlite. Reteta pg locala: vezi CLAUDE.md.');
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
    el.entries.push({ id: 'l0', firmaId: 1, period: '2026-01', data: '2026-01-15', lines: [{ debit: '5121', credit: '419', suma: 700 }] });
    store.persist(el); await store.flush();
    const sql = await store.linesTurnover(1, '2026-03');
    const ram = acc.accumulate(acc.allLines(acc.postedEntries({ entries: el.entries.filter((e) => e.firmaId === 1 && e.period === '2026-03') })));
    eq('rulaj SQL(entry_lines) = rulaj RAM(accumulate) pe firma 1', JSON.stringify(sql), JSON.stringify(ram));
    const sqlBefore = await store.linesTurnover(1, '2026-03', { before: true });
    const ramBefore = acc.accumulate(acc.allLines(acc.postedEntries({ entries: el.entries.filter((e) => e.firmaId === 1) }).filter((e) => (e.period || '') < '2026-03')));
    eq('rulaj SQL before = rulaj RAM beforePeriod (firma 1)', JSON.stringify(sqlBefore), JSON.stringify(ramBefore));
    ok('before include perioada anterioara (419 din 2026-01)', !!sqlBefore['419'] && !sql['419']);
    // fisa de cont: miscarile din SQL (linesForAccount) = miscarile din RAM (allLines filtrat pe cont)
    const sqlMoves = (await store.linesForAccount(1, '4111', '2026-03')).map((l) => l.debit + '/' + l.credit + '/' + l.suma);
    const ramMoves = acc.allLines(acc.postedEntries({ entries: el.entries.filter((e) => e.firmaId === 1 && e.period === '2026-03') }))
      .filter((l) => l.debit === '4111' || l.credit === '4111').map((l) => l.debit + '/' + l.credit + '/' + l.suma).sort();
    eq('miscari SQL(4111) = miscari RAM(4111) pe firma 1', sqlMoves.slice().sort().join('|'), ramMoves.join('|'));
    ok('fisa cont: ciorna l3 (5311/707) exclusa din miscari', !(await store.linesForAccount(1, '707', '2026-03')).some((l) => l.debit === '5311' || l.credit === '5311'));
    ok('ciorna l3 exclusa din rulajul SQL (5311 absent)', !sql['5311']);
    ok('izolare pe firma: 371 (firma 2) absent din rulajul firmei 1', !sql['371']);
    const t2 = await store.linesTurnover(2, '2026-03');
    ok('rulaj firma 2 vede 371/401', t2['371'] && t2['371'].d === 800 && t2['401'] && t2['401'].c === 800);
    el.entries = el.entries.filter((e) => e.id !== 'l2');
    store.persist(el); await store.flush();
    ok('dupa stergere l2: 5121 dispare din rulaj', !(await store.linesTurnover(1, '2026-03'))['5121']);
    const nLines = (await pool.query('SELECT COUNT(*) n FROM entry_lines')).rows[0].n;
    eq('entry_lines are exact liniile ramase (l0:1 + l1:2 + l3:1 + l4:1)', Number(nLines), 5);
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

  section('Colapsarea persistarilor in asteptare (contra acumularii in coada)');
  {
    // persist() FOTOGRAFIAZA sincron un snapshot COMPLET al colectiilor si il pune in coada async.
    // Fara colapsare, save-uri mai rapide decat comite baza acumuleaza snapshot-uri in RAM pana la
    // OOM (masurat: 800 de scrieri in 3s -> 475 MB). Cu colapsare, un `work` neinceput e inlocuit
    // de cel nou — sigur fiindca `snap` se actualizeaza doar dupa commit, deci cel nou e calculat
    // fata de ACELASI punct de plecare si il contine integral pe cel inlocuit.
    const cdb = base();
    for (let i = 0; i < 5; i += 1) cdb.entries.push(mkEntry('c' + i, 1, 10 + i));
    store.persist(cdb); await store.flush();
    eq('punct de plecare: 5 articole in baza', Number((await pool.query('SELECT COUNT(*) AS n FROM entries')).rows[0].n), 5);

    // rafala: 20 de persist-uri FARA await intre ele (exact tiparul care umplea coada)
    for (let i = 5; i < 25; i += 1) { cdb.entries.push(mkEntry('c' + i, 1, 10 + i)); store.persist(cdb); }
    await store.flush();

    // CE CONTEAZA: starea finala din baza == starea din memorie. Colapsarea sare peste persistari
    // intermediare, deci daca invariantul ar fi gresit, aici s-ar pierde articole.
    const nDb = Number((await pool.query('SELECT COUNT(*) AS n FROM entries')).rows[0].n);
    eq('dupa rafala, baza are toate cele 25 de articole', nDb, cdb.entries.length);
    const lipsa = (await pool.query('SELECT id FROM entries ORDER BY id')).rows.map((r) => r.id);
    ok('niciun id pierdut prin colapsare', cdb.entries.every((e) => lipsa.includes(e.id)));
    // proiectia derivata trebuie sa ramana coerenta cu blob-ul, nu doar numarul de randuri
    const nLinii = Number((await pool.query('SELECT COUNT(*) AS n FROM entry_lines')).rows[0].n);
    eq('proiectia de linii e coerenta cu articolele', nLinii, cdb.entries.reduce((s, e) => s + e.lines.length, 0));
    // rehidratarea din baza trebuie sa dea exact ce era in memorie
    const rehidratat = await store.hydrate();
    eq('hydrate dupa rafala intoarce toate articolele', rehidratat.entries.length, cdb.entries.length);

    // stergerea trebuie sa se propage si ea printr-o rafala colapsata
    cdb.entries = cdb.entries.filter((e) => e.id !== 'c7' && e.id !== 'c9');
    store.persist(cdb); store.persist(cdb); store.persist(cdb);
    await store.flush();
    eq('stergerile se propaga prin rafala', Number((await pool.query('SELECT COUNT(*) AS n FROM entries')).rows[0].n), cdb.entries.length);
    ok('randurile sterse chiar au disparut', (await pool.query("SELECT 1 FROM entries WHERE id IN ('c7','c9')")).rows.length === 0);

    section('Esec SQL propagat prin flush + recuperare la commit ulterior');
    // Rupe controlat o tabela: tranzactia trebuie sa dea ROLLBACK, iar flush() trebuie sa
    // RESPINGA promisiunea. Inainte, drain() inghitea eroarea si HTTP putea confirma succesul.
    await pool.query('ALTER TABLE partners RENAME TO partners_persist_failure');
    cdb.partners[1] = { RO123: { cui: 'RO123', name: 'Partener test' } };
    let persistError = null;
    try {
      store.persist(cdb);
      await store.flush();
    } catch (e) {
      persistError = e;
    } finally {
      await pool.query('ALTER TABLE partners_persist_failure RENAME TO partners');
    }
    ok('flush respinge promisiunea dupa ROLLBACK', persistError && /partners/.test(String(persistError.message)));
    ok('metricile retin esecul si starea nedurabila ca pending', store.queueStats().failStreak > 0 && !!store.queueStats().lastError && store.queueStats().pending);
    eq('ROLLBACK nu a scris partenerul', Number((await pool.query('SELECT COUNT(*) n FROM partners')).rows[0].n), 0);

    // Snapshotul persistat a ramas neatins: acelasi graf se poate fotografia din nou, iar primul
    // COMMIT reusit vindeca eroarea expusa de flush (fara restart pentru un incident tranzitoriu).
    store.persist(cdb); await store.flush();
    eq('persist ulterior recupereaza schimbarea', Number((await pool.query('SELECT COUNT(*) n FROM partners')).rows[0].n), 1);
    eq('commit reusit reseteaza seria de esecuri', store.queueStats().failStreak, 0);
  }

  section('Fencing HA: fiecare COMMIT cere lease + holder + generatie valabile');
  {
    await pool.query(`CREATE TABLE IF NOT EXISTS contab_ha_leases (
      name TEXT PRIMARY KEY, holder_id TEXT NOT NULL, instance_label TEXT NOT NULL,
      generation BIGINT NOT NULL, lease_until TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`);
    await pool.query('DELETE FROM contab_ha_leases WHERE name=$1', ['test-ha']);
    await pool.query(`INSERT INTO contab_ha_leases (name, holder_id, instance_label, generation, lease_until)
      VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 minute')`, ['test-ha', 'holder-a', 'node-a', 7]);
    const token = { name: 'test-ha', holderId: 'holder-a', generation: 7 };
    store.setHaFenceProvider(() => token);
    store.resetForLeadership();
    const hdb = base(); hdb.entries = [mkEntry('ha-1', 1, 10)];
    store.persist(hdb); await store.flush();
    ok('tokenul valid permite COMMIT-ul liderului', (await pool.query("SELECT 1 FROM entries WHERE id='ha-1'")).rows.length === 1);

    await pool.query("UPDATE contab_ha_leases SET lease_until=clock_timestamp() - interval '1 second' WHERE name='test-ha'");
    hdb.entries.push(mkEntry('ha-old-leader', 1, 20));
    store.persist(hdb);
    let fenced = null;
    try { await store.flush(); } catch (e) { fenced = e; }
    ok('lease-ul expirat respinge tranzactia cu un cod distinct', fenced && fenced.code === 'CONTAB_HA_FENCE_REJECTED');
    ok('fostul lider NU scrie randul dupa expirare', (await pool.query("SELECT 1 FROM entries WHERE id='ha-old-leader'")).rows.length === 0);
    store.setHaFenceProvider(null);
    store.resetForLeadership();
  }

  // ULTIMA sectiune (dupa conflict, persistenta ramane INGHETATA — nimic nu mai scrie dupa ea)
  section('Fencing multi-scriitor (dbEpoch): alt proces detectat -> refuz, nu clobber');
  {
    const fdb = base();
    fdb.entries = [mkEntry('f1', 1, 10)];
    store.resetDirty();
    store.persist(fdb); await store.flush();
    ok('inainte de conflict: persist normal functioneaza', store.written().includes('entries') && !store.conflicted());
    // simulez AL DOILEA scriitor: alt proces avanseaza dbEpoch + scrie un rand propriu
    {
      const cur = Number((await pool.query("SELECT value FROM meta WHERE key='dbEpoch'")).rows[0].value);
      await pool.query("UPDATE meta SET value = $1 WHERE key='dbEpoch'", [String(cur + 1)]);
      await pool.query('INSERT INTO entries (id, "firmaId", data) VALUES ($1, $2, $3)', ['strain-1', 2, JSON.stringify({ id: 'strain-1', firmaId: 2, lines: [] })]);
    }
    fdb.entries.push(mkEntry('f2', 1, 20));
    store.persist(fdb);
    let conflictError = null;
    try { await store.flush(); } catch (e) { conflictError = e; }
    ok('persist dupa alt scriitor -> conflict detectat (conflicted)', store.conflicted());
    ok('conflictul este propagat de flush', conflictError && conflictError.code === 'CONTAB_WRITER_CONFLICT');
    ok('randul scriitorului strain e intact', (await pool.query("SELECT 1 FROM entries WHERE id='strain-1'")).rows.length === 1);
    ok('scrierea noastra (f2) NU a intrat (rollback)', (await pool.query("SELECT 1 FROM entries WHERE id='f2'")).rows.length === 0);
    // inghetat: urmatorul persist e refuzat fara sa atinga baza
    fdb.entries.push(mkEntry('f3', 1, 30));
    store.persist(fdb);
    let frozenError = null;
    try { await store.flush(); } catch (e) { frozenError = e; }
    eq('persist ulterior refuzat (written gol, inghetat pana la restart)', store.written().length, 0);
    ok('flush ramane rosu cat timp persistenta este inghetata', frozenError && frozenError.code === 'CONTAB_WRITER_CONFLICT');
    ok('f3 NU a intrat in baza', (await pool.query("SELECT 1 FROM entries WHERE id='f3'")).rows.length === 0);
  }

  await pool.end(); await store.close();
  console.log('\n' + (fail ? '✗' : '✓') + ' ' + pass + ' verificari store-pg trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
