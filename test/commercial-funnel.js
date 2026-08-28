'use strict';

// Funnelul trebuie sa ramana agregat, idempotent pe entitati si complet separat de registrul IP.
// Testul lucreaza numai pe un graf in memorie; nu atinge baza si nu porneste serverul.

const funnel = require('../src/commercialFunnel');

let pass = 0; let fail = 0;
const ok = (name, cond) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + name); } };
const count = (snapshot, id) => (snapshot.stages.find((s) => s.id === id) || {}).count;

console.log('Funnel comercial agregat (fara tracking anonim)');
funnel._resetDirty();

const graph = { settings: {} };
const page = { method: 'GET', path: '/', headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' } };
ok('pagina publica reusita se numara', funnel.noteLanding(graph, page, 200) === true);
ok('resursa/API nu se numara ca vizita', funnel.noteLanding(graph,
  { method: 'GET', path: '/api/plans', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } }, 200) === false);
ok('raspunsul esuat nu se numara', funnel.noteLanding(graph, page, 500) === false);
ok('robotul declarat nu se numara comercial', funnel.noteLanding(graph,
  { method: 'GET', path: '/prezentare.html', headers: { accept: 'text/html', 'user-agent': 'ExampleBot/1.0' } }, 200) === false);

funnel.record(graph, 'demo', { at: '2026-08-28T10:00:00.000Z' });
const user = { id: 7, username: 'client' };
ok('inscrierea se marcheaza prima data', funnel.markEntity(graph, user, 'signup', { at: '2026-08-28T10:05:00.000Z' }) === true);
ok('retry-ul aceleiasi inscrieri este idempotent', funnel.markEntity(graph, user, 'signup') === false);
const firm = { id: 3, nume: 'Exemplu' };
funnel.markEntity(graph, firm, 'company_configured', { at: '2026-08-28T10:10:00.000Z' });
funnel.markEntity(graph, firm, 'first_document', { at: '2026-08-28T10:15:00.000Z' });
funnel.markEntity(graph, firm, 'first_month_closed', { at: '2026-08-28T10:20:00.000Z' });
funnel.markEntity(graph, firm, 'payment', { at: '2026-08-28T10:25:00.000Z' });
ok('etapele unice raman o singura conversie per firma', funnel.markEntity(graph, firm, 'payment') === false);
ok('entitatile demo nu polueaza conversiile', funnel.markEntity(graph, { id: 9, username: 'demo' }, 'signup') === false);
ok('clonele de exercitiu nu polueaza conversiile', funnel.markEntity(graph, { id: 10, test: true }, 'first_document') === false);

const snap = funnel.snapshot(graph, { days: null, now: '2026-08-28T12:00:00.000Z' });
ok('toate cele sapte etape sunt expuse', snap.stages.length === 7);
ok('numarul de inscrieri este idempotent', count(snap, 'signup') === 1);
ok('prima luna inchisa este vizibila', count(snap, 'first_month_closed') === 1);
ok('plata foloseste inscrierea ca baza comerciala', snap.stages.find((s) => s.id === 'payment').base === 'signup');
ok('contractul declara explicit ca vizitele nu sunt unice', snap.privacy.uniqueVisitors === false);
const persisted = JSON.stringify(graph.settings.commercialFunnel);
ok('agregatul nu contine IP, user-agent sau identificator anonim', !/\bip\b|user.?agent|visitor.?id|cookie/i.test(persisted));
ok('o schimbare ramane murdara pana la persistare', funnel.isDirty() === true);
funnel.markPersisted();
ok('marcarea persistarii curata starea', funnel.isDirty() === false);

const ranged = { settings: {} };
funnel.record(ranged, 'demo', { at: '2026-01-01T00:00:00.000Z' });
funnel.record(ranged, 'demo', { at: '2026-08-28T00:00:00.000Z' });
const last30 = funnel.snapshot(ranged, { days: 30, now: '2026-08-28T12:00:00.000Z' });
ok('intervalul de 30 zile exclude evenimentele vechi', count(last30, 'demo') === 1);
ok('totalul de la activare pastreaza ambele evenimente', count(funnel.snapshot(ranged, { days: null }), 'demo') === 2);

console.log((fail ? '✗ ' : '✓ ') + pass + ' verificari funnel trecute, ' + fail + ' esuate.\n');
process.exit(fail ? 1 : 0);
