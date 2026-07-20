'use strict';

// Teste pentru stratul SQLite incremental (src/store.js): scrieri per-rand (INSERT/UPDATE/DELETE
// doar pe ce s-a schimbat), fidelitatea hydrate<->persist, pastrarea ordinii, fallback sigur la
// id-uri duplicate si rescrierea completa dupa resetDirty. Ruleaza pe un fisier SQLite temporar.

const os = require('os');
const path = require('path');
const fs = require('fs');
const store = require('../src/store');

let pass = 0; let fail = 0;
function eq(name, got, exp) { if (got === exp) pass += 1; else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(exp)); } }
function ok(name, cond) { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + name); } }
function section(t) { console.log('\n' + t); }

const FILE = path.join(os.tmpdir(), 'contab-store-' + process.pid + '.sqlite');
function rm() { for (const f of [FILE, FILE + '-wal', FILE + '-shm']) { try { fs.unlinkSync(f); } catch (_) { /* nu exista */ } } }
rm();

function base() {
  const d = { partners: {}, openingBalances: {}, settings: {}, firmaActiva: 1, seq: 1 };
  for (const c of store.ARRAY_COLLS) d[c.key] = [];
  return d;
}
function mkEntry(id, firmaId, suma) { return { id, firmaId, tip: 'x', suma: suma || 0, lines: [{ debit: '5121', credit: '4111', suma: suma || 0 }] }; }
const DEF = { settings: {} };

store.open(FILE);
ok('fisier proaspat -> isEmpty', store.isEmpty());

section('Persist initial + no-op');
const db = base();
db.entries = [mkEntry('e1', 1, 10), mkEntry('e2', 1, 20), mkEntry('e3', 2, 30)];
db.audit = [{ id: 1, firmaId: 1, action: 'creare' }];
db.seq = 7;
store.persist(db);
ok('persist scrie entries', store.written().includes('entries'));
ok('persist scrie audit', store.written().includes('audit'));
ok('persist scrie meta', store.written().includes('meta'));
ok('persist NU scrie o colectie goala (products)', !store.written().includes('products'));
store.persist(db);
eq('persist fara schimbari -> zero scrieri', store.written().length, 0);

section('Update incremental — doar colectia atinsa');
db.entries[1].suma = 999;
store.persist(db);
eq('update 1 entry -> se scrie doar entries', store.written().join(','), 'entries');
db.audit.push({ id: 2, firmaId: 1, action: 'modificare' });
store.persist(db);
eq('adaugare in audit -> se scrie doar audit', store.written().join(','), 'audit');
db.seq = 8;
store.persist(db);
eq('schimbarea seq -> se scrie doar meta', store.written().join(','), 'meta');

section('Hydrate reflecta fidel starea');
const h = store.hydrate(DEF);
eq('hydrate: numar entries', h.entries.length, 3);
eq('hydrate: valoarea actualizata', h.entries.find((e) => e.id === 'e2').suma, 999);
eq('hydrate: ordinea pastrata', h.entries.map((e) => e.id).join(','), 'e1,e2,e3');
eq('hydrate: seq', h.seq, 8);
eq('hydrate: audit', h.audit.length, 2);
store.persist(h);
eq('persist imediat dupa hydrate -> zero scrieri (snapshot initializat)', store.written().length, 0);

section('Delete incremental — restul raman, ordinea se pastreaza');
h.entries = h.entries.filter((e) => e.id !== 'e1');
store.persist(h);
eq('stergere -> doar entries', store.written().join(','), 'entries');
const h2 = store.hydrate(DEF);
eq('dupa stergere: numar', h2.entries.length, 2);
eq('dupa stergere: ordinea ramasa', h2.entries.map((e) => e.id).join(','), 'e2,e3');
eq('dupa stergere: valoarea pastrata', h2.entries.find((e) => e.id === 'e2').suma, 999);

section('Insert incremental');
h2.entries.push(mkEntry('e9', 1, 90));
store.persist(h2);
const h3 = store.hydrate(DEF);
eq('dupa insert: numar', h3.entries.length, 3);
eq('dupa insert: la coada', h3.entries.map((e) => e.id).join(','), 'e2,e3,e9');

section('Partners (rescriere completa, portita de amprenta)');
h3.partners = { 1: { '12345': { cui: '12345', den: 'ACME' } } };
store.persist(h3);
ok('schimbarea partners -> se scrie partners', store.written().includes('partners'));
ok('partners nu atinge entries', !store.written().includes('entries'));
const h3p = store.hydrate(DEF);
eq('hydrate partners', h3p.partners['1']['12345'].den, 'ACME');

section('Fallback sigur la id duplicat (fara pierdere de date)');
h3p.entries.push(Object.assign({}, h3p.entries[0])); // duplica id-ul primului entry
store.persist(h3p);
const h4 = store.hydrate(DEF);
eq('id duplicat -> toate randurile pastrate (rescriere completa)', h4.entries.length, 4);

section('resetDirty -> rescriere completa');
store.resetDirty();
h4.entries = [mkEntry('z1', 1, 5)];
h4.audit = [];
store.persist(h4);
ok('resetDirty rescrie tot', store.written().includes('entries'));
const h5 = store.hydrate(DEF);
eq('dupa resetDirty: entries inlocuite', h5.entries.map((e) => e.id).join(','), 'z1');
eq('dupa resetDirty: audit golit', h5.audit.length, 0);

section('Persistenta schemaVersion (migrari DB) — round-trip meta');
{
  const dv = base();
  dv.schemaVersion = 7; // valoare arbitrara ca sa nu se confunde cu implicitul
  dv.users = [{ id: 'u1', username: 'x' }];
  store.resetDirty();
  store.persist(dv);
  const hy = store.hydrate({ settings: {} });
  eq('schemaVersion supravietuieste persist -> hydrate', hy.schemaVersion, 7);
}

section('Proiectie normalizata entry_lines + rulaj SQL = rulaj RAM');
{
  const acc = require('../src/accounting');
  store.resetDirty();
  const el = base();
  el.entries = [
    { id: 'l1', firmaId: 1, period: '2026-03', data: '2026-03-10', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] },
    { id: 'l2', firmaId: 1, period: '2026-03', data: '2026-03-20', lines: [{ debit: '5121', credit: '4111', suma: 500 }] },
    { id: 'l3', firmaId: 1, period: '2026-03', data: '2026-03-21', status: 'ciorna', lines: [{ debit: '5311', credit: '707', suma: 999 }] }, // ciorna: exclusa
    { id: 'l4', firmaId: 2, period: '2026-03', data: '2026-03-15', lines: [{ debit: '371', credit: '401', suma: 800 }] }, // alta firma
  ];
  store.persist(el);
  // rulajul din SQL (entry_lines) trebuie sa fie IDENTIC cu cel din RAM (accounting.accumulate pe postate)
  el.entries.push({ id: 'l0', firmaId: 1, period: '2026-01', data: '2026-01-15', lines: [{ debit: '5121', credit: '419', suma: 700 }] }); // perioada ANTERIOARA
  store.persist(el);
  const sql = store.linesTurnover(1, '2026-03');
  const ram = acc.accumulate(acc.allLines(acc.postedEntries({ entries: el.entries.filter((e) => e.firmaId === 1 && e.period === '2026-03') })));
  eq('rulaj SQL(entry_lines) = rulaj RAM(accumulate) pe firma 1', JSON.stringify(sql), JSON.stringify(ram));
  // modul `before`: rulajul INAINTE de perioada (soldurile initiale) — trebuie sa fie egal cu RAM
  const sqlBefore = store.linesTurnover(1, '2026-03', { before: true });
  const ramBefore = acc.accumulate(acc.allLines(acc.postedEntries({ entries: el.entries.filter((e) => e.firmaId === 1) }).filter((e) => (e.period || '') < '2026-03')));
  eq('rulaj SQL before = rulaj RAM beforePeriod (firma 1)', JSON.stringify(sqlBefore), JSON.stringify(ramBefore));
  ok('before include perioada anterioara (419 din 2026-01)', !!sqlBefore['419'] && !sql['419']);
  ok('ciorna l3 exclusa din rulajul SQL (contul 5311 absent)', !sql['5311']);
  ok('izolare pe firma: contul 371 (firma 2) absent din rulajul firmei 1', !sql['371']);
  ok('rulaj firma 2 vede 371/401', (() => { const t = store.linesTurnover(2, '2026-03'); return t['371'] && t['371'].d === 800 && t['401'] && t['401'].c === 800; })());
  // stergerea unui articol propaga in entry_lines
  el.entries = el.entries.filter((e) => e.id !== 'l2');
  store.persist(el);
  ok('dupa stergere l2: contul 5121 dispare din rulaj', !store.linesTurnover(1, '2026-03')['5121']);
}

section('Proiectie normalizata documents_meta + cautare/stats SQL');
{
  store.resetDirty();
  const dm = base();
  dm.documents = [
    { id: 'd1', firmaId: 1, fileName: 'factura-101.pdf', uploadedAt: '2026-03-10T10:00:00Z', text: 'Factura catre ACME cu TVA' },
    { id: 'd2', firmaId: 1, fileName: 'chitanta.pdf', uploadedAt: '2026-03-11T10:00:00Z', text: '' },
    { id: 'd3', firmaId: 2, fileName: 'contract.pdf', uploadedAt: '2026-03-12T10:00:00Z', text: 'contract prestari' },
  ];
  store.persist(dm);
  const st = store.documentsStats(1);
  eq('documente firma 1: total 2, cu text 1', st.total + '/' + st.cuText, '2/1');
  ok('cautare pe TEXT extras ("acme") -> gaseste d1', store.documentsSearch(1, 'acme').some((r) => r.id === 'd1'));
  ok('cautare pe nume fisier ("factura") -> gaseste d1', store.documentsSearch(1, 'factura').some((r) => r.id === 'd1'));
  ok('izolare pe firma: "contract" (firma 2) NU apare la firma 1', store.documentsSearch(1, 'contract').length === 0);
  ok('firma 2 gaseste contractul', store.documentsSearch(2, 'contract').some((r) => r.id === 'd3'));
  dm.documents = dm.documents.filter((d) => d.id !== 'd1');
  store.persist(dm);
  eq('dupa stergere d1: total firma 1 scade la 1', store.documentsStats(1).total, 1);
  ok('proiectia scrisa doar la persist-ul documentelor (nu la entries)', store.written().join(',') === 'documents');
}

section('Proiectie audit APPEND-ONLY (durabila, decuplata de plafonul RAM)');
{
  // firmaId 99 izoleaza acest test de audit-ul acumulat in sectiunile anterioare (audit_log e append-only)
  store.resetDirty();
  const au = base();
  for (let i = 101; i <= 105; i++) au.audit.push({ id: i, ts: '2026-03-' + i + 'T10:00:00Z', firmaId: 99, userId: 1, username: 'admin', action: 'ev_login', detail: 'ev' + i });
  store.persist(au);
  eq('audit_log firma 99 dupa 5 evenimente', store.auditCount(99), 5);
  // simuleaza PLAFONAREA bazei vii: RAM pastreaza doar ultimele 2 + apar 2 noi
  au.audit = au.audit.slice(-2);
  au.audit.push({ id: 106, ts: '2026-03-106T10:00:00Z', firmaId: 99, userId: 1, username: 'admin', action: 'ev_create', detail: 'ev106' });
  au.audit.push({ id: 107, ts: '2026-03-107T10:00:00Z', firmaId: 98, userId: 2, username: 'x', action: 'ev_login', detail: 'ev107' });
  store.persist(au);
  eq('audit_log NU se plafoneaza: firma 99 pastreaza toate cele 6 (durabil)', store.auditCount(99), 6);
  eq('alta firma (98) are 1 eveniment', store.auditCount(98), 1);
  eq('filtrare firma+actiune (99, ev_login) -> id 101..105', store.auditRecent({ firmaId: 99, action: 'ev_login' }).map((r) => r.id).sort().join(','), '101,102,103,104,105');
  // re-persist idempotent: acelasi audit nu se dubleaza (dedup pe id)
  store.persist(au);
  eq('re-persist nu dubleaza (dedup pe id)', store.auditCount(99), 6);
}

store.close();
rm();

// ── Contractul node:sqlite (API experimental Node): exact suprafata folosita de src/store.js
// si src/backup.js, enumerata explicit. Daca un upgrade de Node schimba API-ul, pica ACEST
// test cu nume clar (nu un test de persistenta cu simptom obscur) — si pica la `prestart`,
// deci INAINTE ca serverul sa porneasca pe noul Node. Planul de schimb e in antetul store.js.
section('Contract node:sqlite (suprafata API folosita)');
{
  const { DatabaseSync } = require('node:sqlite');
  const f = path.join(os.tmpdir(), 'contab-contract-' + process.pid + '.sqlite');
  const rmC = () => { for (const x of [f, f + '-wal', f + '-shm', f + '.copy']) { try { fs.unlinkSync(x); } catch (_) { /* nu exista */ } } };
  rmC();
  const c = new DatabaseSync(f);
  ok('constructor + exec(PRAGMA journal_mode=WAL)', (() => { c.exec('PRAGMA journal_mode = WAL'); return true; })());
  c.exec('PRAGMA busy_timeout = 5000'); c.exec('PRAGMA foreign_keys = ON');
  c.exec('CREATE TABLE t (id TEXT PRIMARY KEY, data TEXT)');
  const ins = c.prepare('INSERT INTO t (id, data) VALUES (?, ?)');
  ok('prepare(...).run cu parametri pozitionali', (() => { ins.run('1', '{"a":1}'); ins.run('2', '{"a":2}'); return true; })());
  eq('prepare(...).get intoarce randul ca obiect', c.prepare('SELECT data FROM t WHERE id = ?').get('1').data, '{"a":1}');
  eq('prepare(...).all intoarce toate randurile', c.prepare('SELECT id FROM t ORDER BY id').all().length, 2);
  // tranzactii prin exec (BEGIN/COMMIT/ROLLBACK) — exact cum face persist()
  c.exec('BEGIN'); ins.run('3', '{}'); c.exec('ROLLBACK');
  eq('ROLLBACK anuleaza scrierea din tranzactie', c.prepare('SELECT COUNT(*) AS n FROM t').get().n, 2);
  c.exec('BEGIN'); ins.run('3', '{}'); c.exec('COMMIT');
  eq('COMMIT pastreaza scrierea', c.prepare('SELECT COUNT(*) AS n FROM t').get().n, 3);
  // readOnly + VACUUM INTO — folosite de snapshotul din src/backup.js (fullBackup)
  const ro = new DatabaseSync(f, { readOnly: true });
  ok('deschidere readOnly + VACUUM INTO (snapshot de backup)', (() => { ro.exec("VACUUM INTO '" + (f + '.copy').replace(/'/g, "''") + "'"); return fs.existsSync(f + '.copy'); })());
  ro.close();
  c.close();
  ok('close() inchide fara eroare', true);
  rmC();
}

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari store trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
