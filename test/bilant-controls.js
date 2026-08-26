'use strict';

const bil = require('../src/bilant');
const { bilantXml } = require('../src/xml');

let passed = 0; let failed = 0;
function ok(name, value) { if (value) passed += 1; else { failed += 1; console.error('  ✗ ' + name); } }
function eq(name, got, expected) { ok(name + ': got ' + got + ', expected ' + expected, got === expected); }
function metadata(view, year, account, fields, id) {
  const row = bil.metadataRecord(view, 1, Object.assign({ year, account,
    reason: 'Clasificare confirmata prin documentele contractuale' }, fields),
  { id: 7, username: 'expert' }, id);
  view.balanceSheetMappings.push(row); return row;
}

console.log('\nBilanț F10 — mapare, ajustări și reconciliere fail-closed');

const ambiguous = {
  firmaId: 1, entries: [], balanceSheetMappings: [], balanceSheetAdjustments: [],
  openingBalances: {
    1012: { d: 0, c: 2000 }, 1621: { d: 0, c: 1000 },
    5121: { d: 2000, c: 0 }, 471: { d: 1000, c: 0 },
  },
};
let R = bil.f10At(ambiguous, 2026, 0);
eq('grupa 16 nu este presupusa integral pe termen lung', R['016'] || 0, 0);
eq('471 nu este presupus integral curent', R['011'] || 0, 0);
ok('raportul enumera toate conturile ambigue si valorile lor', R.mappingReport.unmapped.length === 2
  && R.mappingReport.unmapped.some((x) => x.account === '1621' && x.value === -1000)
  && R.mappingReport.unmapped.some((x) => x.account === '471' && x.value === 1000));

metadata(ambiguous, '2026', '1621', { currentPortion: 400, affiliation: 'none' }, 'bsm-1');
metadata(ambiguous, '2026', '471', { currentPortion: 250, affiliation: 'none' }, 'bsm-2');
R = bil.f10At(ambiguous, 2026, 0);
eq('1621: portiunea curenta merge la datorii sub un an', R['013'], 400);
eq('1621: restul merge la datorii peste un an', R['016'], 600);
eq('471: portiunea curenta merge sub un an', R['011'], 250);
eq('471: restul merge peste un an', R['012'], 750);
eq('clasificarea explicita reconciliaza F10', bil.verificaRezidual(R).rezidual, 0);

const affiliated = { entries: [], openingBalances: { 1012: { d: 0, c: 1000 },
  4111: { d: 600, c: 0 }, 5121: { d: 400, c: 0 } }, balanceSheetMappings: [], balanceSheetAdjustments: [] };
metadata(affiliated, '2026', '4111', { affiliation: 'affiliate' }, 'bsm-a');
const RC = bil.f10CompletAt(affiliated, 2026, 0);
eq('creanta afiliata este evidentiata pe randul dedicat', RC['032'], 600);
eq('creanta afiliata nu ramane pe randul comercial general', RC['031'] || 0, 0);

const plView = { openingBalances: {}, balanceSheetMappings: [], balanceSheetAdjustments: [], entries: [
  { id: 'sale', data: '2026-03-01', period: '2026-03', lines: [{ debit: '4111', credit: '707', suma: 100 }] },
] };
metadata(plView, '2026', '707', { f20DetailLine: '301', affiliation: 'none' }, 'bsm-f20');
eq('metadatele alimenteaza randul F20 „din care”', bil.f20Micro(plView, 2026)['301'], 100);

const artificial = { entries: [{ id: 'capital', data: '2026-01-02', period: '2026-01',
  lines: [{ debit: '5121', credit: '1012', suma: 30000 }] }], openingBalances: {},
balanceSheetMappings: [], balanceSheetAdjustments: [] };
const before = bil.f10At(artificial, 2026, 5000);
eq('diferenta este raportata', bil.verificaRezidual(before).rezidual, -5000);
eq('117 nu este modificat automat', before['042'] || 0, 0);
let mismatch = false;
try { bil.adjustmentRecord(artificial, 1, { year: 2026, scope: 'prescurtat', row: '042', amount: 5000,
  reason: 'Ajustare de reconciliere aprobata explicit', sourceHash: '0'.repeat(64) },
{ id: 7, username: 'expert' }, 'bsa-bad'); } catch (e) { mismatch = e.code === 'BILANT_ADJUSTMENT_SOURCE_MISMATCH'; }
ok('aprobatorul trebuie sa confirme hash-ul sursei exacte', mismatch);
const adj = bil.adjustmentRecord(artificial, 1, { year: 2026, scope: 'prescurtat', row: '042', amount: 5000,
  reason: 'Ajustare de reconciliere aprobata explicit', sourceHash: bil.sourceHash(artificial, 2026) },
{ id: 7, username: 'expert' }, 'bsa-ok');
artificial.balanceSheetAdjustments.push(adj);
const after = bil.f10At(artificial, 2026, 5000);
eq('ajustarea aprobata reconciliaza fara articol contabil', bil.verificaRezidual(after).rezidual, 0);
ok('registrul expune motivul, aprobatorul si SHA-256', after.mappingReport.adjustments.applied[0].reason
  && after.mappingReport.adjustments.applied[0].approvedBy.username === 'expert'
  && /^[0-9a-f]{64}$/.test(after.mappingReport.adjustments.applied[0].hash));
artificial.entries.push({ id: 'change', data: '2026-02-01', period: '2026-02',
  lines: [{ debit: '5121', credit: '1012', suma: 1 }] });
const stale = bil.f10At(artificial, 2026, 5000);
ok('schimbarea balantei expira automat aprobarea ajustarii', stale.mappingReport.adjustments.stale.length === 1
  && stale.mappingReport.adjustments.applied.length === 0);

const company = { nume: 'TEST SRL', cui: '123', judet: 'B', adresa: 'Bucuresti', telefon: '021',
  caen: '6201', formaProprietate: '35', administrator: 'ADMIN', intocmitNume: 'EXPERT',
  intocmitCalitate: '21', intocmitNr: '1', auditStatut: '3' };
const blocked = bil.situatii({ firmaId: 1, entries: [], openingBalances: ambiguous.openingBalances,
  balanceSheetMappings: [], balanceSheetAdjustments: [] }, company, 2026, 'micro');
ok('reconcilierea F10-balanță-F20 este blocanta', !blocked.reconciliere.ok && blocked.blocaje.length > 0);
let xmlBlocked = false;
try { bilantXml(blocked); } catch (e) { xmlBlocked = e.code === 'BILANT_RECONCILIATION_FAILED'; }
ok('serializerul XML refuza direct situatia nereconciliata', xmlBlocked);

console.log('\n' + (failed ? '✗' : '✓') + ' ' + passed + ' verificari bilant trecute, ' + failed + ' esuate.');
if (failed) process.exit(1);
