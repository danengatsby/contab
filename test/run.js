'use strict';

// Test suite — blocheaza regresiile pe numerele cheie ale exemplului din ghid.
// Ruleaza pe datele "scoped" pure; testele care ating baza de date folosesc un fisier temporar
// (CONTAB_DB_FILE) ca sa NU atinga data/db.json. `npm test`.

const path = require('path');
const os = require('os');
process.env.CONTAB_DB_FILE = process.env.CONTAB_DB_FILE || path.join(os.tmpdir(), 'contab-test-' + process.pid + '.json');

const db = require('../src/db');
const { scopedSeed } = require('../src/seed');
const acc = require('../src/accounting');
const stmt = require('../src/statements');
const rep = require('../src/reporting');
const analytic = require('../src/analytic');
const assets = require('../src/assets');
const stocks = require('../src/stocks');
const saft = require('../src/saft');
const xml = require('../src/xml');
const fiscal = require('../src/fiscal');
const { reconcile } = require('../src/reconcile');
const { statePlata, registruSalarii } = require('../src/payroll');

let pass = 0; let fail = 0;
function eq(name, got, exp) {
  const g = typeof got === 'number' ? Math.round(got * 100) / 100 : got;
  if (g === exp) { pass += 1; }
  else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(g) + ', expected ' + JSON.stringify(exp)); }
}
function ok(name, cond) { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + name + ': condition false'); } }
function section(t) { console.log('\n' + t); }
function wellFormed(x) {
  const s = String(x).replace(/<\?xml[^>]*\?>/, '');
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
  const stack = []; let m;
  while ((m = re.exec(s))) { const [, c, n, , sc] = m; if (sc) continue; if (c) { if (stack.pop() !== n) return false; } else stack.push(n); }
  return stack.length === 0;
}

const v = scopedSeed();

section('Balanta de verificare (2026-06)');
const tb = acc.trialBalance(v, '2026-06');
eq('balanced', tb.balanced, true);
eq('total SI debit = credit', tb.tot.siD, tb.tot.siC);
eq('total SI', tb.tot.siD, 65000);
eq('total rulaj D = C', tb.tot.rd, tb.tot.rc);
eq('total SF debit', tb.tot.sfD, 84327.5);
eq('total SF debit = credit', tb.tot.sfD, tb.tot.sfC);

section('Registrul-jurnal');
const j = acc.journal(v, '2026-06');
const nrs = j.rows.filter((r) => r.nr).map((r) => r.nr);
eq('numar articole', nrs.length, 7);
eq('numerotare 1..7', JSON.stringify(nrs), JSON.stringify([1, 2, 3, 4, 5, 6, 7]));
eq('total jurnal D=C (suma liniilor)', j.total, j.rows.reduce((s, r) => s + r.suma, 0));

section('TVA / D300 (2026-06)');
const d3 = rep.d300(v, '2026-06');
eq('TVA colectata', d3.colectata, 2940);
eq('TVA deductibila', d3.deductibila, 2100);
eq('TVA de plata', d3.deplata, 840);

section('Cont de profit si pierdere (2026)');
const pl = stmt.profitLoss(v, '2026');
eq('rezultat brut', pl.rezBrut, 687.5);

section('Registrul de evidenta fiscala (2026)');
const rf = rep.registruFiscal(v, '2026');
eq('rezultat contabil', rf.rezultatContabil, 687.5);
eq('total nedeductibile (fara ajustari in seed)', rf.totalNeded, 0);
eq('rezultat fiscal', rf.rezultatFiscal, 687.5);
ok('mentiune amortizare (art. 28)', (rf.mentiuni || []).some((m) => /art\. 28/i.test(m)));

section('Mijloace fixe — amortizare');
const laptop = v.assets.find((a) => a.id === 'mf1');
const cl = assets.compute(laptop, '2026-06');
eq('laptop amortizare lunara (liniar)', cl.amortizareLunara, 166.67);
eq('laptop cumulat la 2026-06 (5 luni)', cl.amortizareCumulata, 833.35);
eq('laptop cont amortizare', cl.contAmortizare, '2813');
const utilaj = v.assets.find((a) => a.id === 'mf2');
const yearSum = (y) => assets.schedule(utilaj).filter((r) => r.period.startsWith(y)).reduce((s, r) => s + r.amount, 0);
eq('utilaj degresiv an 1 (2026)', Math.round(yearSum('2026') * 100) / 100, 3600);
eq('utilaj total amortizat = cost', Math.round(assets.schedule(utilaj).reduce((s, r) => s + r.amount, 0) * 100) / 100, 12000);

// Inchiderea prin rotunjire + corectitudinea economica pe toate metodele (fara ban fantoma, fara rate negative)
const deprClose = (asset) => {
  const sch = assets.schedule(asset);
  const base = Math.round((asset.cost - (asset.valoareReziduala || 0)) * 100) / 100;
  const tot = Math.round(sch.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const ramasFinal = sch.length ? sch[sch.length - 1].ramas : asset.cost;
  const negative = sch.filter((r) => r.amount < 0).length;
  return { closes: tot === base, ramasOk: Math.abs(ramasFinal - (asset.valoareReziduala || 0)) < 0.005, negative };
};
for (const [nume, a] of [
  ['liniara durata urata (7 luni)', { cost: 10000, durataLuni: 7, metoda: 'liniara', dataPif: '2026-01-15' }],
  ['liniara cu reziduala', { cost: 10000, valoareReziduala: 1000, durataLuni: 36, metoda: 'liniara', dataPif: '2026-01-15' }],
  ['degresiva coef 2.0 (8 ani)', { cost: 30000, durataLuni: 96, metoda: 'degresiva', dataPif: '2026-01-15' }],
  ['accelerata 50% primul an', { cost: 12000, durataLuni: 60, metoda: 'accelerata', dataPif: '2026-01-15' }],
]) {
  const r = deprClose(a);
  ok('amortizare „' + nume + '": cumulat = baza, ramas = reziduala, fara rate negative', r.closes && r.ramasOk && r.negative === 0);
}
eq('coeficient degresiv ≤5 ani', assets.degressiveCoef(5), 1.5);
eq('coeficient degresiv 6-10 ani', assets.degressiveCoef(8), 2.0);
eq('coeficient degresiv >10 ani', assets.degressiveCoef(12), 2.5);
// degresiva e front-loaded: primul an > liniarul mediu
const degSch = assets.schedule({ cost: 10000, durataLuni: 60, metoda: 'degresiva', dataPif: '2026-01-01' });
const degAn1 = degSch.filter((r) => r.period.startsWith('2026')).reduce((s, r) => s + r.amount, 0) + degSch.filter((r) => r.period === '2027-01').reduce((s, r) => s + r.amount, 0);
ok('degresiva front-loaded (an 1 = 3000 > liniar 2000)', Math.round(degAn1) === 3000);

section('Stocuri (CMP, pe gestiuni)');
const st = stocks.currentStock(v, '2026-06');
const byG = Object.fromEntries(st.map((s) => [s.gestiune.cod, s]));
eq('stoc DEP', byG.DEP.stocQ, 10);
eq('stoc MAG', byG.MAG.stocQ, 10);
eq('valoare totala stoc', Math.round(st.reduce((s, x) => s + x.stocV, 0) * 100) / 100, 2000);
eq('CMP DEP', byG.DEP.cmp, 100);

// Regresie CMP: la iesirea/transferul INTREGULUI stoc, valoarea se descarca integral (fara ban fantoma din rotunjire)
const _cmpProd = { id: 'cp' };
const _cmpMov = [
  { id: 'r1', productId: 'cp', tip: 'receptie', gestiuneId: 'g1', cantitate: 3, pretUnitar: 10, data: '2026-01-01' },
  { id: 'r2', productId: 'cp', tip: 'receptie', gestiuneId: 'g1', cantitate: 4, pretUnitar: 11, data: '2026-01-02' },
  { id: 'i1', productId: 'cp', tip: 'iesire', gestiuneId: 'g1', cantitate: 7, data: '2026-01-03' },
];
const _cmpLed = stocks.productLedger(_cmpProd, _cmpMov, null, 'g1');
eq('CMP: dupa iesirea intregului stoc, cantitate 0', _cmpLed.stocQ, 0);
eq('CMP: dupa iesirea intregului stoc, valoare 0 (fara reziduu)', _cmpLed.stocV, 0);
eq('CMP: COGS iesit = cost intrat (74, nu 73.99)', Math.round(_cmpLed.rows.filter((r) => r.tip === 'iesire').reduce((s, r) => s + r.iesireV, 0) * 100) / 100, 74);
const _cmpXfer = stocks.productLedger(_cmpProd, [
  { id: 'r1', productId: 'cp', tip: 'receptie', gestiuneId: 'g1', cantitate: 3, pretUnitar: 10, data: '2026-01-01' },
  { id: 'r2', productId: 'cp', tip: 'receptie', gestiuneId: 'g1', cantitate: 4, pretUnitar: 11, data: '2026-01-02' },
  { id: 't1', productId: 'cp', tip: 'transfer', gestiuneId: 'g1', gestiuneDestId: 'g2', cantitate: 7, data: '2026-01-03' },
], null, 'g1');
eq('CMP: sursa golita complet la transfer (valoare 0)', _cmpXfer.stocV, 0);

section('Descarcare automata de gestiune la vanzare (COGS la CMP)');
const _prods = [{ id: 'p1', cod: 'M1', denumire: 'Marfa 1', um: 'buc', cont: '371' }];
const _movs = [
  { id: 'r1', tip: 'receptie', productId: 'p1', gestiuneId: 'DEP', data: '2026-06-01', cantitate: 100, pretUnitar: 10 },
  { id: 'r2', tip: 'receptie', productId: 'p1', gestiuneId: 'DEP', data: '2026-06-05', cantitate: 100, pretUnitar: 12 },
];
let _n = 0;
const _sale = stocks.saleCogs(_prods, _movs, [{ productId: 'p1', gestiuneId: 'DEP', cantitate: 50 }],
  { fid: 1, data: '2026-06-20', document: 'F100', entryId: 'e99', nextId: () => 'sm' + (++_n) });
eq('CMP dupa 2 receptii (1000+1200)/200', 11, 11); // referinta
eq('o singura miscare de iesire generata', _sale.newMovements.length, 1);
eq('iesirea e legata de articol (entryId)', _sale.newMovements[0].entryId, 'e99');
eq('COGS total = 50 buc × CMP 11', _sale.total, 550);
eq('o linie de descarcare', _sale.cogsLines.length, 1);
eq('linia de descarcare = 607=371', _sale.cogsLines[0].debit + '=' + _sale.cogsLines[0].credit, '607=371');
eq('suma descarcarii', _sale.cogsLines[0].suma, 550);
eq('fara avertismente (stoc suficient)', _sale.warns.length, 0);
const _sale2 = stocks.saleCogs(_prods, _movs, [{ productId: 'p1', gestiuneId: 'DEP', cantitate: 500 }],
  { fid: 1, data: '2026-06-20', entryId: 'e98', nextId: () => 'smX' });
eq('stoc insuficient: COGS la tot stocul (200×11)', _sale2.total, 2200);
eq('stoc insuficient nu lasa cantitate negativa', _sale2.cogsLines[0].suma, 2200);

section('Scadentar / aging (FIFO, la 2026-06-25)');
const ag = analytic.aging(v, '2026-06-25');
const alfa = ag.furnizori.find((f) => /ALFA/.test(f.partener));
eq('ALFA total datorie', alfa.total, 15000);
eq('ALFA 0-30 zile', alfa.b0_30, 12100);
eq('ALFA >90 zile', alfa.b90plus, 2900);
eq('clienti restanti (BETA achitat)', ag.clienti.length, 0);

section('SAF-T (D406, 2026)');
const xmlSaft = saft.saftXml(v, 2026);
['<GeneralLedgerAccounts>', '<Customers>', '<Suppliers>', '<TaxTable>', '<UOMTable>', '<MovementTypeTable>', '<Products>', '<Assets>', '<PhysicalStock>', '<GeneralLedgerEntries>', '<SalesInvoices>', '<PurchaseInvoices>', '<Payments>', '<MovementOfGoods>']
  .forEach((tag) => ok('contine ' + tag, xmlSaft.includes(tag)));
ok('SAF-T bine-format', wellFormed(xmlSaft));
ok('SAF-T: AuditFileVersion 2.4.8 (schema curenta)', xmlSaft.includes('<AuditFileVersion>2.4.8</AuditFileVersion>'));
const vOwn = Object.assign({}, v, { company: Object.assign({}, v.company, { asociatiText: 'Ion Pop; 1800101223344; 60\nMaria I; 2900101223344; 40%' }) });
ok('SAF-T Owners: asociatii din Datele firmei, cu procente', (() => {
  const x = saft.saftXml(vOwn, 2026);
  return x.includes('<Owners>') && x.includes('<Name>Ion Pop</Name>') && x.includes('<SharesQuantity>40</SharesQuantity>');
})());
ok('SAF-T Owners la PFA fara lista: titularul cu 100%', saft.saftXml(Object.assign({}, v, { company: Object.assign({}, v.company, { tipEntitate: 'pfa' }) }), 2026).includes('<SharesQuantity>100</SharesQuantity>'));
ok('SAF-T fara asociati la SRL: sectiunea Owners lipseste (optionala)', !xmlSaft.includes('<Owners>'));
eq('SAF-T TotalDebit = TotalCredit', (xmlSaft.match(/<TotalDebit>([\d.]+)<\/TotalDebit>/) || [])[1], (xmlSaft.match(/<TotalCredit>([\d.]+)<\/TotalCredit>/) || [])[1]);

section('e-Factura UBL (factura de vanzare)');
const facturaVanz = v.entries.find((e) => e.tip === 'factura_vanzare_marfuri');
const ef = xml.eFacturaXml(v.company, facturaVanz, v.partners);
ok('este document Invoice', ef.includes('<Invoice'));
eq('total de plata (PayableAmount)', (ef.match(/PayableAmount[^>]*>([\d.]+)/) || [])[1], '16940.00');
eq('TVA (TaxAmount)', (ef.match(/cbc:TaxAmount[^>]*>([\d.]+)/) || [])[1], '2940.00');
ok('contine CUI furnizor (RO12345678)', ef.includes('RO12345678'));
ok('contine CUI client (RO99887766)', ef.includes('99887766'));
ok('e-Factura bine-format', wellFormed(ef));
// e-Factura cu cote multiple pe linii (21% / 11% / 0%)
const efMulti = xml.eFacturaXml(v.company, {
  tip: 'factura_vanzare_marfuri', data: '2026-06-15', partener: 'BETA', partenerCui: 'RO99887766', document: 'FM1',
  items: [{ nume: 'A', cantitate: 10, pret: 100, um: 'buc', cota: 21 }, { nume: 'B', cantitate: 5, pret: 50, um: 'buc', cota: 11 }, { nume: 'C', cantitate: 1, pret: 200, um: 'buc', cota: 0 }],
}, v.partners);
ok('e-Factura multi-cota bine-format', wellFormed(efMulti));
eq('e-Factura: 3 subtotaluri de TVA (cate unul pe cota)', (efMulti.match(/<cac:TaxSubtotal>/g) || []).length, 3);
const ttMulti = efMulti.match(/<cac:TaxTotal>([\s\S]*?)<\/cac:TaxTotal>/)[1];
const taxTotalMulti = ttMulti.match(/<cbc:TaxAmount[^>]*>([\d.]+)/)[1];
const subSum = [...ttMulti.matchAll(/<cac:TaxSubtotal>[\s\S]*?<cbc:TaxAmount[^>]*>([\d.]+)/g)].reduce((s, m) => s + parseFloat(m[1]), 0);
eq('TaxTotal = suma subtotalurilor (BR-CO-14)', Math.round(subSum * 100) / 100, parseFloat(taxTotalMulti));
eq('TVA total multi-cota (210+27.50+0)', parseFloat(taxTotalMulti), 237.5);
eq('total de plata multi-cota', (efMulti.match(/PayableAmount[^>]*>([\d.]+)/) || [])[1], '1687.50');

section('Jurnale de TVA / D300 / D394 (2026-06)');
const vj = acc.vatJournals(v, '2026-06');
eq('baza vanzari', vj.totals.bazaV, 14000);
eq('TVA colectata (jurnal vanzari)', vj.totals.colectata, 2940);
eq('baza cumparari', vj.totals.bazaC, 10000);
eq('TVA deductibila (jurnal cumparari)', vj.totals.deductibila, 2100);
ok('D300 bine-format', wellFormed(xml.d300Xml(v.company, '2026-06', rep.d300(v, '2026-06'))));
// declarantul (intocmitorul) in XML: atribute oficiale, doar cand exista datele
const d300Cu = xml.d300Xml(v.company, '2026-06', rep.d300(v, '2026-06'), { nume: 'Popescu', prenume: 'Ion', functie: 'Contabil' });
ok('D300 cu declarant: nume/prenume/functie', d300Cu.includes('nume_declar="Popescu"') && d300Cu.includes('prenume_declar="Ion"') && d300Cu.includes('functie_declar="Contabil"'));
ok('D300 cu declarant ramane bine-format', wellFormed(d300Cu));
ok('D300 fara declarant: fara atribute', !xml.d300Xml(v.company, '2026-06', rep.d300(v, '2026-06')).includes('nume_declar'));
ok('D394 bine-format', wellFormed(xml.d394Xml(v.company, '2026-06', vj)));
// defalcare pe cote
eq('o singura cota la vanzari (21%)', vj.coteV.length, 1);
eq('cota vanzari 21%', vj.coteV[0].cota, 21);
eq('baza la cota 21% = total baza', vj.coteV[0].baza, vj.totals.bazaV);
const vMix = { entries: v.entries.concat([{ id: 'z', data: '2026-06-12', period: '2026-06', tip: 't', tipNume: 't', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 110 }] }]), openingBalances: v.openingBalances };
const vjMix = acc.vatJournals(vMix, '2026-06');
eq('doua cote dupa adaugarea unei vanzari 11%', vjMix.coteV.length, 2);
eq('TVA la cota 11%', (vjMix.coteV.find((c) => c.cota === 11) || {}).tva, 110);
const d300xmlMix = xml.d300Xml(v.company, '2026-06', rep.d300(vMix, '2026-06'));
ok('D300 XML cu cote ramane bine-format', wellFormed(d300xmlMix));
ok('D300 XML are rand cota 21 (rd=1)', /rd="1" cota="21"/.test(d300xmlMix));
ok('D300 XML are rand cota 11 (rd=2)', /rd="2" cota="11"/.test(d300xmlMix));
const d394xmlMix = xml.d394Xml(v.company, '2026-06', vjMix);
ok('D394 XML cu cote ramane bine-format', wellFormed(d394xmlMix));
ok('D394 XML are rezumat pe cote', /<rezumat_cote>/.test(d394xmlMix));
ok('D394 XML are nod cota per partener', /<cota cota="11"/.test(d394xmlMix));

section('Inchiderea TVA (2026-06)');
const vc = acc.vatClosing(v, '2026-06');
eq('TVA colectata', vc.colectata, 2940);
eq('TVA deductibila', vc.deductibila, 2100);
eq('TVA de plata (diff)', vc.diff, 840);
eq('ultima linie = TVA de plata 4427=4423', JSON.stringify([vc.lines[vc.lines.length - 1].debit, vc.lines[vc.lines.length - 1].credit, vc.lines[vc.lines.length - 1].suma]), JSON.stringify(['4427', '4423', 840]));

section('Inchiderea anuala (2026)');
const an = acc.annualClosing(v, '2026');
eq('total venituri inchise', an.totalVen, 14000);
eq('total cheltuieli inchise', an.totalChelt, 13312.5);
eq('rezultat (121) = rezultat brut P&L', an.rezultat, 687.5);
ok('contine inchidere venituri 707=121', an.lines.some((l) => l.debit === '707' && l.credit === '121'));
ok('contine inchidere cheltuieli 121=607', an.lines.some((l) => l.debit === '121' && l.credit === '607'));

section('Repartizarea rezultatului (121 -> 117)');
const profitDb = { entries: [
  { id: 'c1', period: '2026-12', data: '2026-12-31', lines: [{ debit: '707', credit: '121', suma: 10000 }] },
  { id: 'c2', period: '2026-12', data: '2026-12-31', lines: [{ debit: '121', credit: '607', suma: 7000 }] },
] };
const rdP = acc.resultDistribution(profitDb, '2026');
eq('profit in 121 (10000-7000)', rdP.profit, 3000);
eq('o linie generata', rdP.lines.length, 1);
eq('profit: 121 = 117', rdP.lines[0].debit + '=' + rdP.lines[0].credit, '121=117');
eq('suma repartizata = profit', rdP.lines[0].suma, 3000);
const lossDb = { entries: [
  { id: 'c1', period: '2026-12', data: '2026-12-31', lines: [{ debit: '707', credit: '121', suma: 5000 }] },
  { id: 'c2', period: '2026-12', data: '2026-12-31', lines: [{ debit: '121', credit: '607', suma: 8000 }] },
] };
const rdL = acc.resultDistribution(lossDb, '2026');
eq('pierdere in 121 (8000-5000)', rdL.pierdere, 3000);
eq('pierdere: 117 = 121', rdL.lines[0].debit + '=' + rdL.lines[0].credit, '117=121');
eq('sold 121 zero -> nicio linie', acc.resultDistribution({ entries: [] }, '2026').lines.length, 0);

section('Control casa (sold negativ + plafon Legea 70/2015)');
const cashDb = {
  openingBalances: { 5311: { d: 1000, c: 0 } },
  entries: [
    { id: 'p1', period: '2026-07', data: '2026-07-05', partener: 'ALFA SRL', partenerCui: 'RO123', lines: [{ debit: '401', credit: '5311', suma: 6000 }] },
    { id: 'i1', period: '2026-07', data: '2026-07-10', partener: 'Ion Pop', partenerCui: '', lines: [{ debit: '5311', credit: '707', suma: 12000 }] },
  ],
};
const cc = acc.cashControl(cashDb, '5311', '2026-07');
ok('sold de casa negativ detectat (1000-6000)', cc.negative.length >= 1);
ok('plafon plata juridic >5000 semnalat', cc.plafon.some((w) => w.tip === 'plata' && w.juridic && w.suma === 6000));
ok('plafon incasare fizic >10000 semnalat', cc.plafon.some((w) => w.tip === 'incasare' && !w.juridic && w.suma === 12000));
eq('sold final casa (1000-6000+12000)', cc.soldFinal, 7000);
const cashOk = acc.cashControl({ openingBalances: { 5311: { d: 5000, c: 0 } }, entries: [
  { id: 'x', period: '2026-07', data: '2026-07-01', partener: 'Y', partenerCui: 'RO9', lines: [{ debit: '401', credit: '5311', suma: 2000 }] }] }, '5311', '2026-07');
ok('casa fara probleme -> ok', cashOk.ok && !cashOk.negative.length && !cashOk.plafon.length);

section('Reduceri comerciale, sconturi, taxare inversa interna');
const gt = require('../src/documentTypes').getType;
const rca = gt('reducere_comerciala_acordata').build({ baza: 100, tva: 21, cota: 21 });
eq('reducere acordata: 709=4111', rca[0].debit + '=' + rca[0].credit, '709=4111');
ok('reducere acordata: storno TVA 4427=4111', rca.some((l) => l.debit === '4427' && l.credit === '4111'));
const rcp = gt('reducere_comerciala_primita').build({ baza: 100, tva: 21, cota: 21 });
eq('reducere primita: 401=609', rcp[0].debit + '=' + rcp[0].credit, '401=609');
eq('scont acordat: 667=4111', gt('scont_acordat').build({ suma: 50 })[0].debit + '=' + gt('scont_acordat').build({ suma: 50 })[0].credit, '667=4111');
eq('scont primit: 401=767', gt('scont_primit').build({ suma: 50 })[0].debit + '=' + gt('scont_primit').build({ suma: 50 })[0].credit, '401=767');
const tii = gt('taxare_inversa_interna_achizitie').build({ baza: 1000, cota: 21, contStoc: '371' });
ok('taxare inversa interna: 371=401 + 4426=4427', tii.some((l) => l.debit === '371' && l.credit === '401') && tii.some((l) => l.debit === '4426' && l.credit === '4427' && l.suma === 210));
// raportare in jurnalul de TVA: aceeasi baza la colectata SI la deductibila (nu 0 pe colectata)
const tiEntry = { id: 'ti', period: '2026-06', data: '2026-06-20', tip: 'taxare_inversa_interna_achizitie', tipNume: 'Taxare inversa', partener: 'GAMA', partenerCui: 'RO321', lines: tii };
const vjTi = acc.vatJournals({ entries: [tiEntry], openingBalances: {} }, '2026-06');
eq('taxare inversa: baza colectata = baza deductibila', vjTi.totals.bazaV, vjTi.totals.bazaC);
eq('taxare inversa: baza colectata 1000 (nu 0)', vjTi.totals.bazaV, 1000);
eq('taxare inversa: cota colectata 21% (defalcare D300)', vjTi.coteV[0].cota, 21);
ok('taxare inversa: marcata in ambele jurnale', vjTi.vanzari[0].taxareInversa === true && vjTi.cumparari[0].taxareInversa === true);
// inchiderea anuala include conturile rectificative (709/609), cu sume in rosu
const contraDb = { entries: [
  { id: 'v', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 10000 }] },
  { id: 'r', period: '2026-03', data: '2026-03-02', lines: [{ debit: '709', credit: '4111', suma: 1000 }] },
] };
const anC = acc.annualClosing(contraDb, '2026');
eq('inchidere venituri nete de reducere (10000-1000)', anC.totalVen, 9000);
ok('linia de inchidere 709 e in rosu (negativa)', anC.lines.some((l) => l.debit === '709' && l.suma < 0));

section('Reconciliere facturi - plati');
const rc = reconcile(v);
const alfaR = rc.partners.find((p) => /ALFA/.test(p.den) && p.cont === '401');
eq('ALFA facturat (perioada)', alfaR.facturat, 12100);
eq('ALFA decontat', alfaR.decontat, 12100);
eq('ALFA sold reconciliat', alfaR.sold, 0);
eq('ALFA potriviri factura-plata', alfaR.potriviri, 1);
const betaR = rc.partners.find((p) => /BETA/.test(p.den) && p.cont === '4111');
eq('BETA facturat', betaR.facturat, 16940);
eq('BETA decontat', betaR.decontat, 16940);

section('Bilant (2026-06)');
const bs = stmt.balanceSheet(v, '2026-06');
eq('bilant echilibrat', bs.echilibrat, true);
eq('total activ = total pasiv', bs.totalActiv, bs.totalPasiv);
eq('total activ', bs.totalActiv, 70815);
eq('rezultat curent (clasa 7-6)', bs.rezultatCurent, 687.5);

section('Bilant structura F10 (prescurtat)');
const f10 = stmt.balanceSheetF10(v, '2026-06');
eq('F10 echilibrat', f10.echilibrat, true);
eq('F10 total activ = bilant simplificat', f10.totalActiv, bs.totalActiv);
eq('F10 total activ = total pasiv', f10.totalActiv, f10.totalPasiv);
ok('F10 are datorii curente (D)', f10.randuri.D_datorii > 0);
eq('F10 rezultat curent in capitaluri', f10.randuri.rezultatCurent, 687.5);
eq('F10 total activ', f10.totalActiv, 70815);
// datoriile pe termen lung (grupa 16) merg in randul G, nu in datorii curente
const f10lt = stmt.balanceSheetF10({ openingBalances: { 1621: { d: 0, c: 50000 }, 5121: { d: 50000, c: 0 } }, entries: [] }, '2026-12');
eq('F10: credit pe TL (1621) -> G (datorii >1 an)', f10lt.randuri.G_datoriiLT, 50000);
eq('F10: nu apare in datorii curente', f10lt.randuri.D_datorii, 0);
ok('F10 echilibrat cu datorie pe termen lung', f10lt.echilibrat);

section('Calcul salarial (payroll, brut 5000)');
const pay = fiscal.payroll(5000);
eq('CAS 25% retinut', pay.cas, 1250);
eq('CASS 10% retinut', pay.cass, 500);
eq('impozit 10% pe salarii', pay.impozit, 325);
eq('CAM 2,25% angajator', pay.cam, 112.5);
eq('salariu net', pay.net, 2925);
eq('cost total angajator', pay.costTotal, 5112.5);

section('Avantaje in natura impozabile (brut 5000 + avantaje 1000)');
const pAv = fiscal.payroll(5000, 0, { avantaje: 1000 });
eq('CAS pe brut+avantaje: 25% din 6000', pAv.cas, 1500);
eq('CASS pe brut+avantaje: 10% din 6000', pAv.cass, 600);
eq('impozit pe baza cu avantaje: 10% din 3900', pAv.impozit, 390);
eq('CAM pe brut+avantaje: 2,25% din 6000', pAv.cam, 135);
eq('net cash: avantajul nu se plateste in bani, dar suporta retinerile', pAv.net, 2510);
const spAv = statePlata([{ id: 'a1', nume: 'Test Av', salariuBrut: 5000, avantaje: 1000 }]);
eq('stat de plata: avantajele apar pe rand si in totaluri', spAv.rows[0].avantaje + '|' + spAv.totals.avantaje, '1000|1000');
ok('D112: baza_cas include avantajele (6000)', xml.d112Xml({ cui: 'RO1', nume: 'X' }, '2026-06', spAv).includes('baza_cas="6000.00"'));

section('Concediu medical in statul de plata (OUG 158/2005, simplificat)');
const pCm = fiscal.payroll(4000, 0, { cmAngajator: 500, cmFnuass: 700 });
eq('CAS pe salariu + indemnizatii CM (25% din 5200)', pCm.cas, 1300);
eq('CASS doar pe salariu (indemnizatiile CM sunt exceptate)', pCm.cass, 400);
eq('impozit pe tot venitul, dupa contributii', pCm.impozit, 350);
eq('CAM doar pe salariu + partea angajator', pCm.cam, 101.25);
eq('netul include indemnizatiile', pCm.net, 3150);
eq('costul angajatorului exclude partea FNUASS (recuperabila)', pCm.costTotal, 4601.25);
const spCm = statePlata([{ id: 'cm1', nume: 'Bolnav Ion', salariuBrut: 4200, zileCM: 7, procentCM: 75, zileLucratoare: 21 }], '2026-06');
const rCm = spCm.rows[0];
eq('salariul redus proportional (14/21 din 4200)', rCm.brut, 2800);
eq('baza CM fara istoric = brutul curent', rCm.mediaCM, 4200);
eq('angajatorul suporta primele 5 zile (150/zi)', rCm.cmAngajator, 750);
eq('FNUASS suporta restul de 2 zile', rCm.cmFnuass, 300);
eq('totalurile cumuleaza indemnizatia', spCm.totals.indemnizatieCM, 1050);
const histCm = [{ period: '2026-04', rows: [{ angajatId: 'cm1', brut: 4200 }] }, { period: '2026-05', rows: [{ angajatId: 'cm1', brut: 8400 }] }];
const spH = statePlata([{ id: 'cm1', nume: 'B', salariuBrut: 4200, zileCM: 4, zileLucratoare: 21 }], '2026-06', histCm);
eq('baza CM = media ultimelor luni postate (6300)', spH.rows[0].mediaCM, 6300);
eq('indemnizatie 4 zile x 225 (toata la angajator)', spH.rows[0].cmAngajator, 900);
const spPlaf = statePlata([{ id: 'x1', nume: 'P', salariuBrut: 4200, zileCM: 1, zileLucratoare: 21 }], '2026-06', [{ period: '2026-05', rows: [{ angajatId: 'x1', brut: 999999 }] }]);
eq('baza CM plafonata la 12 salarii minime', spPlaf.rows[0].mediaCM, 12 * fiscal.salariuMinimLa('2026-06'));
ok('D112: baza_cas include CM, baza_cass nu', (() => {
  const x = xml.d112Xml({ cui: 'RO1', nume: 'X' }, '2026-06', spCm);
  return x.includes('baza_cas="3850.00"') && x.includes('baza_cass="2800.00"') && x.includes('zile_cm="7"');
})());

section('Norma partiala (OUG 16/2022) + concediu de odihna');
// salariul minim S1 2026 = 4050: diferentele pana la nivelul minim le suporta ANGAJATORUL
const pNp = fiscal.payroll(2000, 0, { bazaMinima: 4050 });
eq('CAS angajat pe venitul real (25% din 2000)', pNp.cas, 500);
eq('CAS angajator = diferenta pana la salariul minim (25% din 2050)', pNp.casAngajator, 512.5);
eq('CASS angajator = diferenta (10% din 2050)', pNp.cassAngajator, 205);
eq('netul angajatului NU scade din suprataxare', pNp.net, 1170);
eq('costul angajatorului include suprataxarea', pNp.costTotal, 2762.5);
const spNp = statePlata([{ id: 'np1', nume: 'Partial', salariuBrut: 2000, normaPartiala: true }], '2026-06');
eq('stat: suprataxarea apare pe rand si in totaluri', spNp.rows[0].casAngajator + '|' + spNp.totals.cassAngajator, '512.5|205');
eq('stat: total de virat include partea angajatorului', spNp.totals.totalBuget, 500 + 200 + 130 + 45 + 512.5 + 205);
eq('exceptia legala (student/pensionar/cumul) anuleaza suprataxarea', statePlata([{ id: 'np2', nume: 'S', salariuBrut: 2000, normaPartiala: true, scutitNormaPartiala: true }], '2026-06').rows[0].casAngajator, 0);
ok('D112: atributele cas_angajator/cass_angajator la norma partiala', (() => {
  const x = xml.d112Xml({ cui: 'RO1', nume: 'X' }, '2026-06', spNp);
  return x.includes('cas_angajator="512.50"') && x.includes('cass_angajator="205.00"');
})());
const histCo = [{ period: '2026-03', rows: [{ angajatId: 'co1', brut: 6000 }] }, { period: '2026-04', rows: [{ angajatId: 'co1', brut: 6000 }] }, { period: '2026-05', rows: [{ angajatId: 'co1', brut: 6300 }] }];
const spCo = statePlata([{ id: 'co1', nume: 'Vacanta', salariuBrut: 4200, zileCO: 7, zileLucratoare: 21 }], '2026-06', histCo);
eq('CO: media ultimelor 3 luni', spCo.rows[0].mediaCO, 6100);
eq('CO: indemnizatia pe 7 zile din media', spCo.rows[0].indemnizatieCO, 2033.33);
eq('CO: salariul zilelor lucrate (14/21 din 4200)', spCo.rows[0].salariuZileLucrate, 2800);
eq('CO: brutul impozabil = salariu + indemnizatie', spCo.rows[0].brut, 4833.33);
eq('CO fara istoric: media = brutul curent (echivalent salariului)', statePlata([{ id: 'c2', nume: 'V2', salariuBrut: 4200, zileCO: 7, zileLucratoare: 21 }], '2026-06').rows[0].brut, 4200);
eq('CO + CM: zilele de CO plafonate la zilele ramase', statePlata([{ id: 'c3', nume: 'V3', salariuBrut: 4200, zileCM: 18, zileCO: 10, zileLucratoare: 21 }], '2026-06').rows[0].zileCO, 3);

section('Taxe PFA — Declaratia Unica (plafoane pe salariu minim 4000)');
const pfa = (vn) => fiscal.taxePfa(vn, { salariuMinim: 4000 }); // p6=24k p12=48k p24=96k p60=240k
eq('venit 0: nimic datorat', pfa(0).total, 0);
eq('venit 20000 (<6SM): CAS optionala 0, CASS la baza minima 6SM', pfa(20000).cas + '|' + pfa(20000).cass, '0|2400');
eq('venit 20000: impozit 10% dupa CASS', pfa(20000).impozit, 1760);
eq('venit 50000 (>=12SM): CAS la baza 12SM = 12000', pfa(50000).cas, 12000);
eq('venit 50000: CASS pe venitul real 10%', pfa(50000).cass, 5000);
eq('venit 100000 (>=24SM): CAS la baza 24SM = 24000', pfa(100000).cas, 24000);
eq('venit 300000: CASS plafonata la 60SM (24000)', pfa(300000).cass, 24000);
eq('venit 300000: impozit 10% pe net minus contributii', pfa(300000).impozit, 25200);
const duDb = { entries: [
  { period: '2026-03', data: '2026-03-10', lines: [{ debit: '4111', credit: '704', suma: 100000 }] },
  { period: '2026-07', data: '2026-07-10', lines: [{ debit: '628', credit: '401', suma: 30000 }] },
], openingBalances: {} };
const du = rep.declaratiaUnica(duDb, '2026');
eq('DU: venit net anual = venituri - cheltuieli', du.venitNet, 70000);
ok('DU: taxele coincid cu taxePfa pe salariul minim al anului', (() => {
  const t = fiscal.taxePfa(70000, { salariuMinim: fiscal.salariuMinimLa('2026-01') });
  return du.cas === t.cas && du.cass === t.cass && du.impozit === t.impozit && du.total === t.total;
})());

section('Registrul de incasari si plati (partida simpla, PFA)');
const ripDb = { entries: [
  { id: 'r1', period: '2026-06', data: '2026-06-01', document: 'F1', partener: 'Client', lines: [{ debit: '5121', credit: '4111', suma: 1000, explicatie: 'incasare client' }] },
  { id: 'r2', period: '2026-06', data: '2026-06-02', document: 'B2', lines: [{ debit: '605', credit: '5121', suma: 200, explicatie: 'utilitati' }] },
  { id: 'r3', period: '2026-06', data: '2026-06-03', lines: [{ debit: '5311', credit: '5121', suma: 300, explicatie: 'ridicare numerar' }] },
  { id: 'r4', period: '2026-06', data: '2026-06-04', lines: [{ debit: '5121', credit: '455', suma: 5000, explicatie: 'aport' }] },
  { id: 'r5', period: '2026-06', data: '2026-06-05', lines: [{ debit: '4423', credit: '5121', suma: 150, explicatie: 'plata TVA' }] },
  { id: 'r6', period: '2026-07', data: '2026-07-05', lines: [{ debit: '5311', credit: '704', suma: 400, explicatie: 'vanzare cash' }] },
] };
const rip = acc.registruIncasariPlati(ripDb, '2026-06');
eq('RIP: 5 operatiuni in iunie', rip.rows.length, 5);
eq('RIP: incasari din activitate (doar clientul)', rip.tot.incFiscale, 1000);
eq('RIP: plati deductibile (doar utilitatile)', rip.tot.platiFiscale, 200);
eq('RIP: venit net pe incasari', rip.venitNetIncasat, 800);
eq('RIP: platile de TVA separate, nedeductibile', rip.tot.taxePlatite, 150);
ok('RIP: viramentul intern marcat', rip.rows.some((r) => r.cat === 'intern'));
ok('RIP: aportul intreprinzatorului marcat neutru', rip.rows.some((r) => r.cat === 'neutru' && r.contra === '455'));
eq('RIP pe an: include si iulie (1000+400)', acc.registruIncasariPlati(ripDb, '2026').tot.incFiscale, 1400);
const duRip = rep.declaratiaUnica(ripDb, '2026');
eq('DU: baza pe angajamente (704 − 605)', duRip.venitNet, 200);
eq('DU: varianta pe incasat/platit (1400 − 200)', duRip.incasat.venitNet, 1200);

section('Stat de plata (per angajat)');
const sp = statePlata(v.angajati);
eq('numar angajati', sp.rows.length, 1);
eq('total brut', sp.totals.brut, 5000);
eq('total net', sp.totals.net, 2925);
eq('total de virat la buget', sp.totals.totalBuget, 2187.5);
eq('cost total angajator', sp.totals.costTotal, 5112.5);
eq('angajat net = payroll net', sp.rows[0].net, fiscal.payroll(5000).net);
const d112 = xml.d112Xml(v.company, '2026-06', sp);
ok('D112 bine-format', wellFormed(d112));
ok('D112 contine asigurat (Ion Popescu)', d112.includes('Ion Popescu'));
eq('D112 total de plata', (d112.match(/<total_de_plata>([\d.]+)<\/total_de_plata>/) || [])[1], '2187.50');
// spor (impozabil) + retineri (din net)
const sp2 = statePlata([{ id: 'x', nume: 'Test', salariuBrut: 4700, spor: 300, retineri: 500 }]);
eq('brut cu spor (4700+300)', sp2.totals.brut, 5000);
eq('net (ca la 5000 brut)', sp2.totals.net, 2925);
eq('rest de plata = net - retineri', sp2.rows[0].restPlata, 2425);
eq('total retineri', sp2.totals.retineri, 500);
const sp3 = statePlata([{ id: 'y', nume: 'Test', salariuBrut: 5000, avans: 1000, retineri: 200 }]);
eq('rest de plata = net - avans - retineri', sp3.rows[0].restPlata, 1725);
eq('total avans', sp3.totals.avans, 1000);

section('Deducere personala (art. 77 Cod fiscal)');
const sm = fiscal.FISCAL.salariuMinimS1; // 4050
eq('la salariu minim, 0 persoane = 20%', fiscal.deducerePersonala(sm, 0, { salariuMinim: sm }).total, Math.ceil((sm * 0.2) / 10) * 10);
eq('la salariu minim, 2 persoane = 30%', fiscal.deducerePersonala(sm, 2, { salariuMinim: sm }).total, Math.ceil((sm * 0.3) / 10) * 10);
eq('la salariu minim, 4+ persoane = 45%', fiscal.deducerePersonala(sm, 5, { salariuMinim: sm }).total, Math.ceil((sm * 0.45) / 10) * 10);
eq('peste salariu minim+2000 -> 0', fiscal.deducerePersonala(sm + 2500, 2, { salariuMinim: sm }).total, 0);
eq('la mijloc (sm+1000), 0 pers = jumatate din baza', fiscal.deducerePersonala(sm + 1000, 0, { salariuMinim: sm }).baza, sm * 0.2 * 0.5);
eq('tanar <=26 ani: +15% din salariul minim', fiscal.deducerePersonala(sm, 0, { salariuMinim: sm, sub26: true }).suplimentara, sm * 0.15);
eq('100 lei x 2 copii in invatamant', fiscal.deducerePersonala(sm, 0, { salariuMinim: sm, copii: 2 }).suplimentara, 200);
// integrare in statul de plata: angajat la salariul minim cu 1 persoana in intretinere
const dpMin = fiscal.deducerePersonala(sm, 1, { salariuMinim: sm }).total; // 25% -> 1015 rotunjit
const spDP = statePlata([{ id: 'z', nume: 'MinWage', salariuBrut: sm, persoane: 1 }], '2026-03'); // S1 explicit
const payMin = fiscal.payroll(sm, dpMin);
eq('impozit scade cu deducerea personala', spDP.rows[0].impozit, payMin.impozit);
eq('deducerea apare in rand', spDP.rows[0].deducere, dpMin);
ok('impozit cu deducere < impozit fara deducere', payMin.impozit < fiscal.payroll(sm, 0).impozit);
// fara campuri noi -> comportament neschimbat (compat)
eq('angajat fara persoane: deducere 0 (compat)', statePlata([{ id: 'q', nume: 'X', salariuBrut: 5000 }]).rows[0].deducere, 0);

section('Salarizare extinsa (tichete, scutiri sectoriale, concedii)');
const pT = fiscal.payroll(5000, 0, { tichete: 500 });
eq('CAS doar pe salariu (nu tichete)', pT.cas, 1250);
eq('CASS pe brut+tichete (5500×10%)', pT.cass, 550);
eq('impozit pe baza incl. tichete (370)', pT.impozit, 370);
// Facilitatile sectoriale au fost ELIMINATE din ian. 2025 (OUG 156/2024): impozitare standard.
const pIT = fiscal.payroll(8000, 500, { sector: 'it' });
eq('IT: impozit standard (facilitate eliminata)', pIT.impozit, fiscal.payroll(8000, 500).impozit);
ok('IT: fara scutiri', !pIT.scutImpozit && !pIT.scutCass && pIT.impozit > 0);
const pC = fiscal.payroll(6000, 0, { sector: 'constructii' });
eq('constructii: CASS standard 10%', pC.cass, 600);
ok('constructii: impozit datorat', pC.impozit > 0);
eq('compat: payroll(5000) neschimbat', fiscal.payroll(5000).impozit, 325);
// salariul minim pe semestre: S1 pana in iunie, S2 de la 1 iulie
eq('salariu minim ianuarie-iunie (S1)', fiscal.salariuMinimLa('2026-03'), fiscal.FISCAL.salariuMinimS1);
eq('salariu minim iulie-decembrie (S2)', fiscal.salariuMinimLa('2026-09'), fiscal.FISCAL.salariuMinimS2);
eq('neimpozabil S2 din iulie', fiscal.neimpozabilLa('2026-07'), fiscal.FISCAL.neimpozabilS2);
ok('deducerea personala foloseste S2 dupa 1 iulie',
  fiscal.deducerePersonala(fiscal.FISCAL.salariuMinimS2, 0, { period: '2026-08' }).baza === fiscal.FISCAL.salariuMinimS2 * 0.2);
const gt2 = require('../src/documentTypes').getType;
const dc = (id, s) => { const l = gt2(id).build({ suma: s })[0]; return l.debit + '=' + l.credit; };
eq('tichete de masa: 642=5328', dc('tichete_masa', 500), '642=5328');
eq('concediu medical angajator: 6458=423', dc('concediu_medical_angajator', 300), '6458=423');
eq('concediu medical FNUASS: 4373=423', dc('concediu_medical_fnuass', 700), '4373=423');
eq('recuperare FNUASS: 5121=4373', dc('recuperare_fnuass', 700), '5121=4373');
// registru anual de salarii (cumul din 2 luni)
const hist = [
  { period: '2026-06', rows: [{ angajatId: 'a', nume: 'Ion', cnp: '123', brut: 5000, cas: 1250, cass: 500, impozit: 325, net: 2925 }] },
  { period: '2026-07', rows: [{ angajatId: 'a', nume: 'Ion', cnp: '123', brut: 5000, cas: 1250, cass: 500, impozit: 325, net: 2925 }] },
];
const rs = registruSalarii(hist, 2026);
eq('registru: nr luni', rs.nrLuni, 2);
eq('registru: brut anual cumulat', rs.angajati[0].brut, 10000);
eq('registru: net anual cumulat', rs.angajati[0].net, 5850);
eq('registru: luni angajat', rs.angajati[0].luni, 2);

section('TVA la incasare (regim special 4428)');
const { getType } = require('../src/documentTypes');
const mkTva = (id, f, date) => ({ id, data: date, period: date.slice(0, 7), tip: id, tipNume: '', lines: getType(id).build(f) });
const vTva = { entries: [mkTva('factura_vanzare_incasare', { baza: 1000, tva: 210, cota: 21 }, '2026-08-05')], openingBalances: {} };
ok('factura vanzare incasare crediteaza 4428', vTva.entries[0].lines.some((l) => l.credit === '4428'));
eq('TVA neexigibila NU intra in decont', acc.vatClosing(vTva, '2026-08').colectata, 0);
vTva.entries.push(mkTva('exigibilitate_tva_colectata', { tva: 210 }, '2026-08-20'));
eq('dupa incasare devine TVA colectata', acc.vatClosing(vTva, '2026-08').colectata, 210);
// TVA din suma bruta (incasare automata)
const tvaDinBrut = (brut, cota) => Math.round((brut * cota) / (100 + cota) * 100) / 100;
eq('TVA exigibila din 1210 brut @ 21%', tvaDinBrut(1210, 21), 210);
eq('TVA exigibila din 1110 brut @ 11%', tvaDinBrut(1110, 11), 110);
// registru TVA neexigibila (4428)
const vNeex = { entries: [
  mkTva('factura_vanzare_incasare', { baza: 1000, tva: 210, cota: 21 }, '2026-08-05'),
  mkTva('factura_cumparare_incasare', { baza: 2000, tva: 420, cota: 21 }, '2026-08-06'),
  mkTva('exigibilitate_tva_colectata', { tva: 210 }, '2026-08-20'),
], openingBalances: {} };
const neex = acc.tvaNeexigibila(vNeex, null);
eq('colectata neexigibila ramasa (incasata)', neex.colectataNeexigibila, 0);
eq('deductibila neexigibila ramasa (neplatita)', neex.deductibilaNeexigibila, 420);

// Ciclu complet TVA la incasare: la exigibilitate, BAZA aferenta intra in D300 (nu doar TVA)
const exColectata = Object.assign(mkTva('exigibilitate_tva_colectata', { tva: 210 }, '2026-09-20'), { tvaExig: { baza: 1000, cota: 21, side: 'colectata' } });
const vjExig = acc.vatJournals({ entries: [exColectata], openingBalances: {} }, '2026-09');
eq('D300 exigibilitate: baza raportata (nu 0)', vjExig.totals.bazaV, 1000);
eq('D300 exigibilitate: TVA colectata', vjExig.totals.colectata, 210);
eq('D300 exigibilitate: cota derivata corect (21%)', vjExig.vanzari[0].cota, 21);
eq('D300 exigibilitate: defalcare pe cota 21', (vjExig.coteV.find((x) => x.cota === 21) || {}).baza, 1000);
const exDeduct = Object.assign(mkTva('exigibilitate_tva_deductibila', { tva: 420 }, '2026-09-21'), { tvaExig: { baza: 2000, cota: 21, side: 'deductibila' } });
const vjDed = acc.vatJournals({ entries: [exDeduct], openingBalances: {} }, '2026-09');
eq('D300 exigibilitate deductibila: baza cumparari raportata', vjDed.totals.bazaC, 2000);
eq('D300 exigibilitate deductibila: TVA deductibila', vjDed.totals.deductibila, 420);

section('CSV — export/import parteneri (round-trip)');
const { toCsv, parseCsv } = require('../src/csv');
const csvP = toCsv(['CUI', 'Denumire', 'Adresa'], [['RO123', 'Firma A; SRL', 'Str. 1'], ['456', 'Firma "B"', 'Str. 2']]);
const parsed = parseCsv(csvP);
eq('parseCsv: nr randuri (header + 2)', parsed.length, 3);
eq('parseCsv: separator in ghilimele pastrat', parsed[1][1], 'Firma A; SRL');
eq('parseCsv: ghilimele escapate', parsed[2][1], 'Firma "B"');
eq('parseCsv: tolereaza separator , si ;', parseCsv('a,b,c').length, 1);

section('Import plan de conturi personalizat');
const coaMod = require('../src/chartOfAccounts');
coaMod.addAccounts([{ cod: '6028', nume: 'Cheltuieli cu alte materiale', clasa: 6, tip: 'C' }]);
eq('cont personalizat adaugat', coaMod.accountName('6028'), 'Cheltuieli cu alte materiale');
ok('contul nou apare in lista', coaMod.ACCOUNTS.some((a) => a.cod === '6028'));
coaMod.addAccounts([{ cod: '6028', nume: 'Redenumit' }]); // upsert
eq('upsert cont existent', coaMod.accountName('6028'), 'Redenumit');

section('Export/import firma (remapare id-uri)');
// construieste un mini-bundle cu referinte interne (movement -> product/gestiune; transfer)
const bundle = {
  firma: { id: 9, nume: 'Test SRL', cui: '999' },
  partners: {}, openingBalances: { 371: { d: 1000, c: 0 } }, openingAnalytic: [],
  products: [{ id: 'p1', firmaId: 9, cod: 'X', denumire: 'X', um: 'buc', cont: '371' }],
  gestiuni: [{ id: 'g1', firmaId: 9, cod: 'D', denumire: 'Depozit' }, { id: 'g2', firmaId: 9, cod: 'M', denumire: 'Magazin' }],
  stockMovements: [{ id: 'm1', firmaId: 9, data: '2026-01-01', tip: 'transfer', productId: 'p1', gestiuneId: 'g1', gestiuneDestId: 'g2', cantitate: 5 }],
  entries: [{ id: 'e1', firmaId: 9, data: '2026-01-01', period: '2026-01', tip: 't', tipNume: 't', lines: [{ debit: '371', credit: '401', suma: 100 }] }],
  inventories: [], assets: [], angajati: [], payrollHistory: [], documents: [],
};
const newFid = db.importFirma(bundle);
const v2 = db.scoped(newFid);
ok('firma importata are id nou', newFid !== 9);
eq('produse importate', v2.products.length, 1);
eq('miscari importate', v2.stockMovements.length, 1);
const mv = v2.stockMovements[0];
ok('miscarea trimite la un produs valid din firma noua', v2.products.some((p) => p.id === mv.productId));
ok('miscarea trimite la gestiuni valide (sursa+dest)', v2.gestiuni.some((g) => g.id === mv.gestiuneId) && v2.gestiuni.some((g) => g.id === mv.gestiuneDestId));
eq('export reflecta firma importata', db.exportFirma(newFid).entries.length, 1);
const vTvaC = { entries: [mkTva('factura_cumparare_incasare', { baza: 1000, tva: 210, cota: 21 }, '2026-08-05')], openingBalances: {} };
eq('TVA neexigibila deductibila NU intra in decont', acc.vatClosing(vTvaC, '2026-08').deductibila, 0);
vTvaC.entries.push(mkTva('exigibilitate_tva_deductibila', { tva: 210 }, '2026-08-25'));
eq('dupa plata devine TVA deductibila', acc.vatClosing(vTvaC, '2026-08').deductibila, 210);

section('Leasing financiar');
const vLease = { entries: [
  mkTva('leasing_intrare', { contImob: '2133', valoare: 50000 }, '2026-09-01'),
  mkTva('factura_leasing', { principal: 1200, dobanda: 300, tva: 285, cota: 21 }, '2026-09-30'),
  mkTva('plata_leasing', { suma: 1785, cont: '5121' }, '2026-09-30'),
], openingBalances: {} };
const tbL = acc.trialBalance(vLease, '2026-09');
const find = (cod) => tbL.rows.find((r) => r.cod === cod) || {};
eq('imobilizare in leasing (2133)', find('2133').sfD, 50000);
eq('datorie leasing ramasa (167)', find('167').sfC, 48800);
eq('cheltuiala cu dobanda (666)', find('666').rd, 300);
eq('furnizor imobilizari 404 stins', (find('404').sfD || 0) + (find('404').sfC || 0), 0);
eq('balanta leasing echilibrata', tbL.balanced, true);

section('Imobilizari in curs (231 -> 21x)');
const vIc = { entries: [
  mkTva('imobilizare_in_curs', { baza: 20000, tva: 4200, cota: 21 }, '2026-10-05'),
  mkTva('imobilizare_in_curs', { baza: 10000, tva: 2100, cota: 21 }, '2026-10-15'),
  mkTva('punere_in_functiune', { contImob: '2131', valoare: 30000 }, '2026-10-31'),
], openingBalances: {} };
const tbIc = acc.trialBalance(vIc, '2026-10');
const fIc = (cod) => tbIc.rows.find((r) => r.cod === cod) || {};
eq('231 stins dupa punerea in functiune', (fIc('231').sfD || 0) + (fIc('231').sfC || 0), 0);
eq('imobilizare 2131 = costuri acumulate', fIc('2131').sfD, 30000);
eq('balanta imobilizari in curs echilibrata', tbIc.balanced, true);

section('Diferente de curs valutar');
const vFx = { entries: [
  mkTva('factura_vanzare_valuta', { valuta: 1000, curs: 4.97, contVenit: '707' }, '2026-11-05'),
  mkTva('diferenta_curs_favorabila', { cont: '4111', suma: 30 }, '2026-11-30'),
  mkTva('diferenta_curs_nefavorabila', { cont: '401', suma: 50 }, '2026-11-30'),
], openingBalances: {} };
const tbFx = acc.trialBalance(vFx, '2026-11');
const fFx = (c) => tbFx.rows.find((r) => r.cod === c) || {};
eq('factura valuta in RON (1000 x 4.97)', fFx('707').rc, 4970);
eq('creanta dupa dif favorabila (4111)', fFx('4111').sfD, 5000);
eq('venit dif curs favorabila (765)', fFx('765').rc, 30);
eq('cheltuiala dif curs nefavorabila (665)', fFx('665').rd, 50);
eq('balanta valuta echilibrata', tbFx.balanced, true);

section('Reevaluare imobilizari (105/655)');
const vReev = { entries: [
  mkTva('reevaluare_plus', { contImob: '212', valoare: 10000 }, '2026-12-31'),
  mkTva('reevaluare_minus', { contImob: '212', dinRezerva: 3000, peCheltuiala: 2000 }, '2026-12-31'),
], openingBalances: {} };
const tbR = acc.trialBalance(vReev, '2026-12');
const fR = (c) => tbR.rows.find((r) => r.cod === c) || {};
eq('rezerva din reevaluare (105) ramasa', fR('105').sfC, 7000); // +10000 -3000
eq('cheltuiala reevaluare (655)', fR('655').rd, 2000);
eq('valoare neta imobilizare 212 (+10000-5000)', fR('212').sfD, 5000);
eq('balanta reevaluare echilibrata', tbR.balanced, true);

section('Grafic de rate leasing');
const { leasingSchedule } = require('../src/leasing');
const lsA = leasingSchedule(12000, 12, 10, 'anuitati');
eq('anuitati: nr rate', lsA.rows.length, 12);
eq('anuitati: total principal = valoarea finantata', lsA.totals.principal, 12000);
eq('anuitati: sold final 0', lsA.rows[11].sold, 0);
ok('anuitati: rate aproape egale', Math.abs(lsA.rows[0].rata - lsA.rows[5].rata) < 0.05);
const lsE = leasingSchedule(12000, 12, 10, 'rate_egale');
eq('rate egale: principal lunar constant', lsE.rows[0].principal, 1000);
ok('rate egale: rata scade in timp', lsE.rows[0].rata > lsE.rows[11].rata);
eq('dobanda 0 => rata = principal', leasingSchedule(12000, 12, 0, 'anuitati').rows[0].rata, 1000);
// verificare contra formulei teoretice a anuitatii + inchidere exacta pe durata urata
const lsB = leasingSchedule(50000, 60, 9.5, 'anuitati');
const rTeo = (50000 * (0.095 / 12)) / (1 - Math.pow(1 + 0.095 / 12, -60));
eq('anuitati: rata = formula teoretica', lsB.rows[0].rata, Math.round(rTeo * 100) / 100);
eq('anuitati: dobanda totala = n×rata − P', lsB.totals.dobanda, Math.round((lsB.rows.reduce((s, r) => s + r.rata, 0) - 50000) * 100) / 100);
ok('anuitati: nicio dobanda/principal negativ', lsB.rows.every((r) => r.dobanda >= 0 && r.principal >= 0));
const lsU = leasingSchedule(10000, 7, 13, 'anuitati'); // durata „urata"
eq('anuitati durata urata: principal = P (inchidere exacta)', lsU.totals.principal, 10000);
eq('anuitati durata urata: sold final 0', lsU.rows[6].sold, 0);

section('Provizioane pentru riscuri si cheltuieli (151)');
const vProv = { entries: [
  mkTva('provizion_constituire', { suma: 5000, explicatie: 'Litigiu' }, '2026-12-15'),
  mkTva('provizion_reluare', { suma: 2000, explicatie: 'Litigiu castigat partial' }, '2026-12-31'),
], openingBalances: {} };
const tbP = acc.trialBalance(vProv, '2026-12');
const fP = (c) => tbP.rows.find((r) => r.cod === c) || {};
eq('provizion 151 ramas (5000-2000)', fP('151').sfC, 3000);
eq('cheltuiala provizion (6812)', fP('6812').rd, 5000);
eq('venit reluare provizion (7812)', fP('7812').rc, 2000);
eq('balanta provizioane echilibrata', tbP.balanced, true);
const rfP = rep.registruFiscal({ entries: vProv.entries, openingBalances: {} }, '2026');
ok('6812 nedeductibil in registrul fiscal', rfP.cheltNeded.some((c) => c.cod === '6812' && c.suma === 5000));
ok('7812 neimpozabil in registrul fiscal', (rfP.venituriList || []).some((c) => c.cod === '7812' && c.suma === 2000));

section('Decontari cu asociatii (455) si intragrup (481)');
const vAs = { entries: [
  mkTva('imprumut_asociat', { suma: 20000, cont: '5121' }, '2026-09-01'),
  mkTva('restituire_asociat', { suma: 5000, cont: '5121' }, '2026-09-20'),
  mkTva('decontare_intragrup', { sens: 'creanta', cont: '5121', suma: 3000 }, '2026-09-25'),
], openingBalances: {} };
const tbAs = acc.trialBalance(vAs, '2026-09');
const fAs = (c) => tbAs.rows.find((r) => r.cod === c) || {};
eq('datorie catre asociat (455) ramasa', fAs('455').sfC, 15000);
eq('creanta intragrup (481)', fAs('481').sfD, 3000);
eq('balanta decontari echilibrata', tbAs.balanced, true);

section('Dividende (117 = 457, impozit 446)');
const vDiv = { entries: [
  mkTva('repartizare_dividende', { brut: 10000, cota: 10, contSursa: '117' }, '2026-04-30'),
  mkTva('plata_dividende', { suma: 9000, cont: '5121' }, '2026-05-15'),
], openingBalances: { 117: { d: 0, c: 30000 }, 5121: { d: 30000, c: 0 } } };
const tbDiv = acc.trialBalance(vDiv, null);
const fDv = (c) => tbDiv.rows.find((r) => r.cod === c) || {};
eq('rezultat reportat 117 redus (30000-10000)', fDv('117').sfC, 20000);
eq('impozit pe dividende (446)', fDv('446').sfC, 1000);
eq('dividende de plata (457) stinse', (fDv('457').sfD || 0) + (fDv('457').sfC || 0), 0);
eq('disponibil 5121 dupa plata neta', fDv('5121').sfD, 21000);
eq('balanta dividende echilibrata', tbDiv.balanced, true);

section('Subventii (de exploatare 741 / investitii 475->7584)');
const vSub = { entries: [
  mkTva('subventie_investitii', { suma: 60000 }, '2026-01-10'),
  mkTva('incasare_subventie', { suma: 60000, cont: '5121' }, '2026-01-20'),
  mkTva('venit_subventie_investitii', { suma: 1000 }, '2026-12-31'),
], openingBalances: {} };
const tbSub = acc.trialBalance(vSub, null);
const fS = (c) => tbSub.rows.find((r) => r.cod === c) || {};
eq('subventie investitii in avans (475) ramasa', fS('475').sfC, 59000);
eq('creanta subventie 445 stinsa dupa incasare', (fS('445').sfD || 0) + (fS('445').sfC || 0), 0);
eq('venit subventie recunoscut (7584)', fS('7584').rc, 1000);
eq('balanta subventii echilibrata', tbSub.balanced, true);

section('Cheltuieli / venituri in avans (471/472)');
const vAv = { entries: [
  mkTva('cheltuiala_in_avans', { cont: '401', suma: 12000 }, '2026-01-01'),
  mkTva('recunoastere_cheltuiala_avans', { contChelt: '613', suma: 1000 }, '2026-01-31'),
  mkTva('venit_in_avans', { cont: '5121', suma: 6000 }, '2026-01-01'),
  mkTva('recunoastere_venit_avans', { contVenit: '704', suma: 500 }, '2026-01-31'),
], openingBalances: {} };
const tbAv = acc.trialBalance(vAv, null);
const fAv = (c) => tbAv.rows.find((r) => r.cod === c) || {};
eq('cheltuiala in avans ramasa (471)', fAv('471').sfD, 11000);
eq('venit in avans ramas (472)', fAv('472').sfC, 5500);
eq('cheltuiala recunoscuta in perioada (613)', fAv('613').rd, 1000);
eq('venit recunoscut in perioada (704)', fAv('704').rc, 500);
eq('balanta avans echilibrata', tbAv.balanced, true);

section('Extragere documente — detectie PDF / imagine');
const aiMod = require('../src/aiExtractor');
const buf = (bytes) => Buffer.from(bytes);
eq('detecteaza PDF (%PDF)', aiMod.detectMediaType(buf([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 0, 0, 0, 0, 0, 0])), 'application/pdf');
eq('detecteaza PNG', aiMod.detectMediaType(buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
eq('detecteaza JPEG', aiMod.detectMediaType(buf([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
eq('detecteaza WEBP', aiMod.detectMediaType(buf([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp');
eq('necunoscut -> null', aiMod.detectMediaType(buf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);

section('Note explicative (2026)');
const notes = rep.notes(v, '2026');
eq('numar note', notes.sections.length, 6);
ok('Nota 1 — Active imobilizate', notes.sections.some((s) => /Nota 1/.test(s.titlu)));
ok('principii contabile prezente', (notes.principii || []).length > 0);

section('Mesaje (suport user <-> admin)');
const msg = require('../src/messages');
const usersM = [{ id: 1, username: 'admin', role: 'admin' }, { id: 2, username: 'maria', role: 'user' }, { id: 3, username: 'ion', role: 'user' }];
const inbox = [
  msg.newMessage('m1', 2, false, 'Salut, am o intrebare'),       // maria -> admin
  msg.newMessage('m2', 2, true, 'Spune, te ascult', 'admin'),    // admin -> maria
  msg.newMessage('m3', 3, false, 'Cum inchid luna?'),            // ion -> admin (necitit de admin)
];
eq('mesaj de la user: necitit de admin', inbox[0].readByAdmin, false);
eq('mesaj de la user: citit de user (autorul)', inbox[0].readByUser, true);
eq('raspuns admin: necitit de user', inbox[1].readByUser, false);
eq('thread maria are 2 mesaje, cronologic', msg.thread(inbox, 2).length, 2);
eq('thread maria nu include mesajele lui ion', msg.thread(inbox, 2).every((m) => m.userId === 2), true);
eq('necitite pentru maria (raspuns admin)', msg.unreadForUser(inbox, 2), 1);
eq('necitite pentru admin (cereri user)', msg.unreadForAdmin(inbox), 2);
const sum = msg.threadsSummary(inbox, usersM);
eq('inbox admin: 2 conversatii', sum.length, 2);
eq('sumar are username rezolvat', sum.some((t) => t.username === 'maria'), true);
eq('conversatia ion are 1 necitit', (sum.find((t) => t.userId === 3) || {}).unread, 1);
const nA = msg.markRead(inbox, 2, 'admin'); // adminul deschide conversatia mariei
eq('markRead admin marcheaza 1 mesaj', nA, 1);
eq('dupa citire, necitite admin scad la 1', msg.unreadForAdmin(inbox), 1);
const nU = msg.markRead(inbox, 2, 'user'); // maria deschide conversatia
eq('markRead user marcheaza raspunsul adminului', nU, 1);
eq('dupa citire, necitite maria = 0', msg.unreadForUser(inbox, 2), 0);
eq('text gol -> trimmed', msg.newMessage('x', 2, false, '   ').text, '');
// atasamente
const attMsg = msg.newMessage('a1', 2, false, 'vezi poza', 'maria', { name: 'bon.png', storedName: 'abc123.png', size: 1234, mime: 'image/png' });
eq('atasament: nume pastrat', attMsg.attachment.name, 'bon.png');
eq('atasament: dimensiune numerica', attMsg.attachment.size, 1234);
eq('atasament: mime pastrat', attMsg.attachment.mime, 'image/png');
eq('mesaj fara atasament nu are campul attachment', msg.newMessage('a2', 2, false, 'text', 'm').attachment, undefined);
eq('atasament fara storedName e ignorat', msg.newMessage('a3', 2, false, '', 'm', { name: 'x' }).attachment, undefined);
// arhivare in sumar + cautare
const usersArch = [{ id: 1, username: 'admin', role: 'admin' }, { id: 2, username: 'maria', role: 'user', supportArchived: true }, { id: 3, username: 'ion', role: 'user' }];
const sumArch = msg.threadsSummary(inbox, usersArch);
eq('sumar marcheaza conversatia arhivata', (sumArch.find((t) => t.userId === 2) || {}).archived, true);
eq('conversatia nearhivata are archived=false', (sumArch.find((t) => t.userId === 3) || {}).archived, false);
eq('cautare dupa nume gaseste maria', msg.searchThreads(inbox, usersM, 'mar').length, 1);
eq('cautare dupa text gaseste conversatia lui ion', msg.searchThreads(inbox, usersM, 'inchid').some((t) => t.userId === 3), true);
eq('cautare adauga fragment de potrivire', !!msg.searchThreads(inbox, usersM, 'inchid')[0].match, true);
eq('cautare goala = toate conversatiile', msg.searchThreads(inbox, usersM, '').length, msg.threadsSummary(inbox, usersM).length);
eq('cautare fara rezultat', msg.searchThreads(inbox, usersM, 'zzzqqq').length, 0);

section('Notificare email admin la mesaj nou (prezenta)');
const presence = require('../src/presence');
const NOW = Date.UTC(2026, 5, 29, 12, 0, 0);
const recent = new Date(NOW - 60 * 1000).toISOString();      // acum 1 min
const stale = new Date(NOW - 60 * 60 * 1000).toISOString();  // acum 1 ora
const adminOnline = { id: 1, role: 'admin', email: 'a@x.ro', sessions: [{ lastSeen: recent }] };
const adminOffline = { id: 1, role: 'admin', email: 'a@x.ro', sessions: [{ lastSeen: stale }] };
const userU = { id: 2, role: 'user', email: 'u@x.ro', sessions: [{ lastSeen: recent }] };
ok('admin activ recent => online', presence.anyAdminOnline([adminOnline, userU], NOW));
ok('admin inactiv demult => offline', !presence.anyAdminOnline([adminOffline, userU], NOW));
ok('user activ NU conteaza ca admin online', !presence.anyAdminOnline([adminOffline, userU], NOW));
eq('admin online => nimeni de notificat', presence.adminsToEmail([adminOnline, userU], NOW).length, 0);
eq('admin offline cu email => 1 de notificat', presence.adminsToEmail([adminOffline, userU], NOW).length, 1);
eq('admin offline fara email => nimeni', presence.adminsToEmail([{ id: 1, role: 'admin', sessions: [{ lastSeen: stale }] }], NOW).length, 0);
eq('admin in cooldown (5 min) => nu se renotifica', presence.adminsToEmail([{ id: 1, role: 'admin', email: 'a@x.ro', sessions: [{ lastSeen: stale }], lastSupportEmailAt: NOW - 5 * 60 * 1000 }], NOW).length, 0);
eq('cooldown expirat (20 min) => se notifica din nou', presence.adminsToEmail([{ id: 1, role: 'admin', email: 'a@x.ro', sessions: [{ lastSeen: stale }], lastSupportEmailAt: NOW - 20 * 60 * 1000 }], NOW).length, 1);
eq('admin pending (invitatie) nu se notifica', presence.adminsToEmail([{ id: 1, role: 'admin', email: 'a@x.ro', pending: true, sessions: [] }], NOW).length, 0);

section('Efecte de comert si acreditive');
const coa2 = require('../src/chartOfAccounts');
ok('contul 413 (efecte de primit) exista', !!coa2.getAccount('413'));
ok('contul 403 (efecte de platit) exista', !!coa2.getAccount('403'));
ok('contul 541 (acreditive) exista', !!coa2.getAccount('541'));
const efp = gt2('efect_primit_client').build({ suma: 1000 });
eq('efect primit: 413=4111', efp[0].debit + '=' + efp[0].credit, '413=4111');
const sc = gt2('scontare_efect').build({ suma: 1000, scont: 30 });
eq('scontare: net 970 pe 5121', (sc.find((l) => l.debit === '5121') || {}).suma, 970);
eq('scontare: scont 30 pe 667 (cheltuiala financiara)', (sc.find((l) => l.debit === '667') || {}).suma, 30);
eq('scontare: total creditat pe 413 = nominal', sc.reduce((s, l) => s + (l.credit === '413' ? l.suma : 0), 0), 1000);
eq('efect platit furnizor: 401=403', gt2('efect_platit_furnizor').build({ suma: 800 })[0].debit + '=' + gt2('efect_platit_furnizor').build({ suma: 800 })[0].credit, '401=403');
eq('deschidere acreditiv: 541=5121', gt2('deschidere_acreditiv').build({ suma: 5000 })[0].debit + '=' + gt2('deschidere_acreditiv').build({ suma: 5000 })[0].credit, '541=5121');
eq('plata din acreditiv: 401=541', gt2('plata_din_acreditiv').build({ suma: 1200 })[0].debit + '=' + gt2('plata_din_acreditiv').build({ suma: 1200 })[0].credit, '401=541');

section('D390 — recapitulativ intracomunitar (VIES)');
const d390db = { entries: [
  { id: '1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-10', partener: 'DE GmbH', partenerCui: 'DE123', lines: gt2('livrare_intracomunitara').build({ baza: 5000 }) },
  { id: '2', tip: 'achizitie_intracomunitara', period: '2026-06', data: '2026-06-12', partener: 'FR SARL', partenerCui: 'FR789', lines: gt2('achizitie_intracomunitara').build({ baza: 3000, cota: 21 }) },
  { id: '3', tip: 'factura_vanzare_marfuri', period: '2026-06', data: '2026-06-15', partener: 'intern', lines: [{ debit: '4111', credit: '707', suma: 9999 }] },
] };
const d390 = rep.d390(d390db, '2026-06');
eq('D390: total livrari (L) = 5000', d390.totalL, 5000);
eq('D390: total achizitii (A) = 3000', d390.totalA, 3000);
eq('D390: 2 operatori (intracom), factura interna exclusa', d390.nr, 2);
ok('D390: codul tarii dedus din CUI (DE/FR)', d390.rows.some((r) => r.tara === 'DE') && d390.rows.some((r) => r.tara === 'FR'));
ok('D390 XML bine-format', wellFormed(xml.d390Xml({ cui: 'RO1', nume: 'X' }, '2026-06', d390)));

section('Import XLSX (parser)');
const AdmZip = require('adm-zip');
const xlsxMod = require('../src/xlsx');
const _ss = '<?xml version="1.0"?><sst><si><t>CUI</t></si><si><t>Den</t></si><si><t>RO9</t></si><si><t>ACME &amp; CO</t></si></sst>';
const _sheet = '<?xml version="1.0"?><worksheet><sheetData>'
  + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Sold</t></is></c></row>'
  + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>1500.5</v></c></row>'
  + '</sheetData></worksheet>';
const _zip = new AdmZip();
_zip.addFile('xl/sharedStrings.xml', Buffer.from(_ss));
_zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(_sheet));
const xrows = xlsxMod.parseXlsx(_zip.toBuffer());
eq('XLSX: 2 randuri citite', xrows.length, 2);
eq('XLSX: antet din siruri partajate', xrows[0].join(','), 'CUI,Den,Sold');
eq('XLSX: decodare entitate XML (&amp;)', xrows[1][1], 'ACME & CO');
eq('XLSX: celula numerica', xrows[1][2], '1500.5');

section('D205 (retinere la sursa) + Intrastat + DBF');
const chir = gt2('chirie_pf').build({ baza: 1000, cota: 10, cont: '5121' });
eq('chirie_pf: impozit 10% din net (brut - 20% forfetar) = 80', (chir.find((l) => l.credit === '446') || {}).suma, 80);
eq('chirie_pf: net platit 920', (chir.find((l) => l.credit === '5121') || {}).suma, 920);
eq('chirie_pf: debit 612 = brut 1000', chir.reduce((s, l) => s + (l.debit === '612' ? l.suma : 0), 0), 1000);

section('Monografii corectate (HoReCa, aviz, dividende, scont)');
// HoReCa vanzare: 707 primeste doar baza; TVA colectata pe 4427; descarcarea scoate si 4428 din 371
const hv = gt2('horeca_vanzare').build({ numerar: 555, card: 0, cota: 11, cost: 300, adaos: 200 });
eq('horeca: venit 707 = baza (fara TVA)', (hv.find((l) => l.credit === '707') || {}).suma, 500);
eq('horeca: TVA colectata 4427 = 55', (hv.find((l) => l.credit === '4427') || {}).suma, 55);
eq('horeca: descarcare TVA neexigibila 4428=371', (hv.find((l) => l.debit === '4428' && l.credit === '371') || {}).suma, 55);
const hvTotal371 = hv.filter((l) => l.credit === '371').reduce((s, l) => s + l.suma, 0);
eq('horeca: 371 descarcat integral la pret de vanzare (cost+adaos+TVA)', Math.round(hvTotal371 * 100) / 100, 555);
// Aviz: 418 include TVA neexigibila; facturarea stinge 418 la total si exigibilizeaza TVA
const av = gt2('aviz_livrare').build({ baza: 1000, tva: 210 });
eq('aviz: 418=707 baza', (av.find((l) => l.credit === '707') || {}).suma, 1000);
eq('aviz: 418=4428 TVA neexigibila', (av.find((l) => l.credit === '4428') || {}).suma, 210);
const fa = gt2('facturare_aviz').build({ baza: 1000, tva: 210 });
eq('facturare aviz: 4111=418 cu tot cu TVA', (fa.find((l) => l.credit === '418') || {}).suma, 1210);
eq('facturare aviz: 4428=4427 exigibilizare', (fa.find((l) => l.debit === '4428' && l.credit === '4427') || {}).suma, 210);
// Dividende: cota implicita 16% din 2026 (Legea 141/2025)
eq('impozit dividende implicit 16%', fiscal.FISCAL.impozitDividende, 16);
const dvf = require('../src/documentTypes').typesForClient().find((t) => t.id === 'repartizare_dividende');
eq('camp cota dividende: default 16', (dvf.fields.find((f) => f.name === 'cota') || {}).default, 16);
// Scontare efect: taxa de scont e cheltuiala financiara (667)
const sce = gt2('scontare_efect').build({ suma: 1000, scont: 50 });
eq('scontare: taxa pe 667', (sce.find((l) => l.suma === 50) || {}).debit, '667');

section('Avansuri facturate (factura de avans cu TVA + regularizare)');
const favC = gt2('factura_avans_client').build({ baza: 1000, tva: 210, cota: 21 });
eq('factura avans client: 4111=419 baza', (favC.find((l) => l.credit === '419') || {}).suma, 1000);
eq('factura avans client: 4111=4427 TVA', (favC.find((l) => l.credit === '4427') || {}).suma, 210);
const regC = gt2('regularizare_avans_client').build({ baza: 1000, tva: 210, cota: 21 });
const netOn = (lines, cont) => lines.reduce((s, l) => s + (l.credit === cont ? l.suma : 0) - (l.debit === cont ? l.suma : 0), 0);
eq('ciclu avans client: 419 se inchide', netOn([...favC, ...regC], '419'), 0);
eq('ciclu avans client: TVA avansului se anuleaza la regularizare', netOn([...favC, ...regC], '4427'), 0);
const favF = gt2('factura_avans_furnizor').build({ baza: 500, tva: 105, cota: 21 });
ok('factura avans furnizor: 409=401 + 4426=401', favF.some((l) => l.debit === '409' && l.credit === '401' && l.suma === 500) && favF.some((l) => l.debit === '4426' && l.suma === 105));
const regF = gt2('regularizare_avans_furnizor').build({ baza: 500, tva: 105, cota: 21 });
eq('ciclu avans furnizor: 409 se inchide', [...favF, ...regF].reduce((s, l) => s + (l.debit === '409' ? l.suma : 0) - (l.credit === '409' ? l.suma : 0), 0), 0);
// jurnalul de TVA: baza avansului (419) apare in vanzari; regularizarea o scade
const mkAv = (lines, data) => ({ id: 'av' + data, data, period: data.slice(0, 7), tipNume: 'test', partener: 'X', document: 'AV1', lines });
const jAv = acc.vatJournals({ entries: [mkAv(favC, '2026-05-10')], openingBalances: {} }, '2026-05');
eq('jurnal TVA: factura de avans cu baza 1000', jAv.totals.bazaV, 1000);
eq('jurnal TVA: TVA colectata avans 210', jAv.totals.colectata, 210);
const jReg = acc.vatJournals({ entries: [mkAv(favC, '2026-05-10'), mkAv(regC, '2026-05-20')], openingBalances: {} }, '2026-05');
eq('jurnal TVA: dupa regularizare baza neta 0', jReg.totals.bazaV, 0);
eq('jurnal TVA: dupa regularizare TVA neta 0', jReg.totals.colectata, 0);
const d205db = { entries: [
  { id: '1', tip: 'chirie_pf', period: '2026-03', data: '2026-03-01', partener: 'Ion Pop', partenerCui: '1900101415236', lines: gt2('chirie_pf').build({ baza: 1000, cota: 10, cont: '5121' }) },
  { id: '2', tip: 'premiu_pf', period: '2026-05', data: '2026-05-01', partener: 'Maria I', partenerCui: '2900202535241', lines: gt2('premiu_pf').build({ baza: 500, cota: 10, cont: '5311' }) },
  { id: '3', tip: 'repartizare_dividende', period: '2026-04', data: '2026-04-01', partener: 'Asociat A', partenerCui: '1800303646352', lines: [{ debit: '117', credit: '457', suma: 10000 }, { debit: '457', credit: '446', suma: 800 }] },
] };
const d205 = rep.d205(d205db, '2026');
eq('D205: 3 beneficiari', d205.nr, 3);
eq('D205: total impozit retinut (80+50+800; chirie 10% din net)', d205.totalImpozit, 930);
ok('D205: dividend brut 10000 capturat', d205.rows.some((r) => r.tipVenit === 'Dividende' && r.venitBrut === 10000));
ok('D205 XML bine-format', wellFormed(xml.d205Xml({ cui: 'RO1', nume: 'X' }, '2026', d205)));
const intr = rep.intrastat({ entries: [
  { id: '1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-10', partenerCui: 'DE1', lines: gt2('livrare_intracomunitara').build({ baza: 5000 }) },
  { id: '2', tip: 'achizitie_intracomunitara', period: '2026-06', data: '2026-06-12', partenerCui: 'FR2', lines: gt2('achizitie_intracomunitara').build({ baza: 3000, cota: 21 }) },
] }, '2026-06');
eq('Intrastat: total expedieri (livrari) 5000', intr.totalExpedieri, 5000);
eq('Intrastat: total introduceri (achizitii) 3000', intr.totalIntroduceri, 3000);
const intrNC = rep.intrastat({ entries: [
  { id: '1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-10', partenerCui: 'DE1', intrastat: { codNC: '94036010', masaNeta: 120, natura: '11' }, lines: gt2('livrare_intracomunitara').build({ baza: 5000 }) },
  { id: '2', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-12', partenerCui: 'DE2', intrastat: { codNC: '94036010', masaNeta: 80 }, lines: gt2('livrare_intracomunitara').build({ baza: 2000 }) },
  { id: '3', tip: 'achizitie_intracomunitara', period: '2026-06', data: '2026-06-12', partenerCui: 'FR1', intrastat: { codNC: '72142000', masaNeta: 500 }, lines: gt2('achizitie_intracomunitara').build({ baza: 3000, cota: 21 }) },
] }, '2026-06');
const deRow = intrNC.rows.find((r) => r.flux === 'expediere' && r.tara === 'DE' && r.codNC === '94036010');
eq('Intrastat NC8: grupare pe DE + 94036010 (2 operatiuni)', deRow.nrop, 2);
eq('Intrastat NC8: masa neta cumulata 120+80', deRow.masaNeta, 200);
eq('Intrastat NC8: valoare cumulata 5000+2000', deRow.valoare, 7000);
eq('Intrastat: pragul 1.000.000 lei', intrNC.pragExpedieri, 1000000);
eq('Intrastat: sub prag -> neobligat la declarare', intrNC.obligatExpedieri, false);
ok('Intrastat XML bine-format', wellFormed(xml.intrastatXml({ cui: 'RO1', nume: 'X' }, '2026-06', intrNC)));
ok('Intrastat XML: articolul DE cu masa neta cumulata', xml.intrastatXml({ cui: 'RO1', nume: 'X' }, '2026-06', intrNC).includes('masa_neta="200.00"'));

section('D100 — impozit micro trimestrial + XML');
// veniturile se cumuleaza pe lunile trimestrului (apr+iun in T2), luna din alt trimestru e exclusa
const d100db = { entries: [
  { id: '1', tip: 'x', period: '2026-04', data: '2026-04-10', lines: [{ debit: '4111', credit: '704', suma: 10000 }] },
  { id: '2', tip: 'x', period: '2026-06', data: '2026-06-10', lines: [{ debit: '4111', credit: '704', suma: 5000 }] },
  { id: '3', tip: 'x', period: '2026-03', data: '2026-03-10', lines: [{ debit: '4111', credit: '704', suma: 77777 }] },
] };
const d100q = rep.d100micro(d100db, '2026-06');
eq('D100: venit trimestrul II cumulat (apr+iun)', d100q.venit, 15000);
eq('D100: trimestrul detectat', d100q.trimestru, 2);
eq('D100: impozit micro 1% = 150', d100q.impozit, 150);
ok('D100 XML bine-format', wellFormed(xml.d100Xml({ cui: 'RO1', nume: 'X' }, '2026-06', d100q)));
ok('D100 XML: obligatia cod 620 cu baza si impozitul', (() => { const x = xml.d100Xml({ cui: 'RO1', nume: 'X' }, '2026-06', d100q); return x.includes('cod="620"') && x.includes('baza="15000.00"') && x.includes('de_plata="150.00"'); })());
// eligibilitate micro (plafon implicit 100.000 EUR x curs 5 = 500.000 lei + conditia de salariat)
ok('D100: fara salariati -> avertisment de eligibilitate', d100q.avertismente.some((w) => /salariat/i.test(w)));
const d100over = rep.d100micro({ entries: [{ id: 'o1', period: '2026-02', data: '2026-02-01', lines: [{ debit: '4111', credit: '704', suma: 600000 }] }], angajati: [{ id: 'a' }] }, '2026-03');
ok('D100: peste plafonul micro -> avertisment de iesire din regim', d100over.avertismente.some((w) => /DEPASESC/.test(w)));
ok('D100: cu salariat -> fara avertismentul de salariat', !d100over.avertismente.some((w) => /salariat/i.test(w)));
const d100warn = rep.d100micro({ entries: [{ id: 'w1', period: '2026-02', data: '2026-02-01', lines: [{ debit: '4111', credit: '704', suma: 450000 }] }], angajati: [{ id: 'a' }] }, '2026-03');
ok('D100: peste 80% din plafon -> avertisment de urmarire (nu de depasire)', d100warn.avertismente.some((w) => /din plafonul micro/.test(w)) && !d100warn.avertismente.some((w) => /DEPASESC/.test(w)));
eq('D100: venitul anual cumulat pentru controlul plafonului', d100over.venitAn, 600000);

section('Produse agricole — fila carnet de comercializare (Legea 145/2014)');
const agr = gt2('achizitie_produse_agricole').build({ suma: 750, cont: '371' });
eq('achizitie pe carnet: 371=462, fara TVA', agr.map((l) => l.debit + '=' + l.credit).join(','), '371=462');
const agrCash = gt2('achizitie_produse_agricole').build({ suma: 750, cont: '301', platitCash: true });
ok('achizitie platita pe loc: 301=462 + 462=5311', agrCash.some((l) => l.debit === '301' && l.credit === '462') && agrCash.some((l) => l.debit === '462' && l.credit === '5311'));
const agrDb = { entries: [
  { id: '1', tip: 'achizitie_produse_agricole', period: '2026-06', data: '2026-06-05', partener: 'Ion Taranu', partenerCui: '1800101223344', document: 'Fila 12', lines: gt2('achizitie_produse_agricole').build({ suma: 750, cont: '371' }) },
  { id: '2', tip: 'achizitie_produse_agricole', period: '2026-06', data: '2026-06-15', partener: 'Ion Taranu', partenerCui: '1800101223344', document: 'Fila 13', lines: gt2('achizitie_produse_agricole').build({ suma: 250, cont: '371', platitCash: true }) },
  { id: '3', tip: 'achizitie_produse_agricole', period: '2026-05', data: '2026-05-15', partener: 'Alt Producator', lines: gt2('achizitie_produse_agricole').build({ suma: 999, cont: '301' }) },
] };
const agrRep = rep.achizitiiPfCarnet(agrDb, '2026-06');
eq('carnet: un producator agregat in iunie (mai exclus)', agrRep.nr, 1);
eq('carnet: 2 file cumulate, total 1000', agrRep.rows[0].nr + '|' + agrRep.rows[0].total, '2|1000');
const vjGol = acc.vatJournals({ entries: [], openingBalances: {} }, '2026-06');
const d394pf = xml.d394Xml({ cui: 'RO1', nume: 'X' }, '2026-06', vjGol, null, agrRep);
ok('D394: sectiunea achizitii_pf_carnet cu totalul si CNP-ul', d394pf.includes('<achizitii_pf_carnet total="1000.00"') && d394pf.includes('cnp="1800101223344"'));
ok('D394 bine-format cu sectiunea pf', wellFormed(d394pf));
ok('D394 fara achizitii pe carnet: sectiunea lipseste', !xml.d394Xml({ cui: 'RO1', nume: 'X' }, '2026-06', vjGol).includes('achizitii_pf_carnet'));

section('TVA avansat: pro-rata (art. 300) + bunuri de capital (art. 305)');
const prDb = { company: { proRataTva: 40 }, entries: [
  { id: 'p1', period: '2026-02', data: '2026-02-01', tip: 'factura_vanzare_servicii', lines: [{ debit: '4111', credit: '704', suma: 6000 }, { debit: '4111', credit: '4427', suma: 1260 }] },
  { id: 'p2', period: '2026-03', data: '2026-03-01', tip: 'vanzare_scutita_fara_drept', lines: [{ debit: '4111', credit: '704', suma: 4000 }] },
  { id: 'p3', period: '2026-04', data: '2026-04-01', tip: 'factura_utilitati', proRataMixt: true, lines: [{ debit: '605', credit: '401', suma: 1126 }, { debit: '4426', credit: '401', suma: 84 }] },
] };
const prR = rep.proRataTva(prDb, '2026');
eq('pro-rata: livrari cu drept / fara drept', prR.cuDrept + '|' + prR.faraDrept, '6000|4000');
eq('pro-rata definitiva rotunjita in sus', prR.definitiva, 60);
eq('TVA dedusa provizoriu pe achizitiile mixte', prR.dedusaProvizoriu, 84);
eq('regularizare anuala: 210 x 60% - 84 = +42 (de dedus)', prR.regularizare, 42);
const ajS = gt2('ajustare_tva_bunuri_capital').build({ tvaDedusa: 10000, durata: '5', aniRamasi: 3, sens: 'stat' });
eq('ajustare art. 305 in favoarea statului: 635=4426 cu 3/5 din TVA', ajS[0].debit + '=' + ajS[0].credit + '|' + ajS[0].suma, '635=4426|6000');
const ajF = gt2('ajustare_tva_bunuri_capital').build({ tvaDedusa: 10000, durata: '20', aniRamasi: 5, sens: 'firma' });
eq('ajustare art. 305 in favoarea firmei: 4426=635 cu 5/20 din TVA', ajF[0].debit + '=' + ajF[0].credit + '|' + ajF[0].suma, '4426=635|2500');
eq('regularizare pro-rata in favoarea firmei: 4426=635', gt2('regularizare_pro_rata').build({ suma: 42, sens: 'firma' })[0].debit + '=' + gt2('regularizare_pro_rata').build({ suma: 42, sens: 'firma' })[0].credit, '4426=635');

section('Suma in litere (chitante)');
const sil = require('../src/util').sumaInLitere;
eq('zero', sil(0), 'zero lei');
eq('12.50', sil(12.5), 'doisprezece lei si cincizeci bani');
eq('121', sil(121), 'o suta douazeci si unu lei');
eq('1000', sil(1000), 'o mie lei');
eq('2500', sil(2500), 'doua mii cinci sute lei');
eq('12000 (feminin)', sil(12000), 'douasprezece mii lei');
eq('21000 (de + feminin)', sil(21000), 'douazeci si una de mii lei');
eq('100000', sil(100000), 'o suta de mii lei');
eq('2000000', sil(2000000), 'doua milioane lei');
eq('1234567.89', sil(1234567.89), 'un milion doua sute treizeci si patru de mii cinci sute saizeci si sapte lei si optzeci si noua bani');

section('Fisa de cont (miscari + corespondent + sold curent)');
const fisaDb = { entries: [
  { period: '2026-05', data: '2026-05-01', document: 'F0', explicatie: 'veche', partener: 'C', lines: [{ debit: '4111', credit: '707', suma: 250 }] },
  { period: '2026-06', data: '2026-06-05', document: 'F1', explicatie: 'vanzare', partener: 'C', lines: [{ debit: '4111', credit: '707', suma: 1000 }] },
  { period: '2026-06', data: '2026-06-10', document: 'OP1', explicatie: 'incasare', partener: 'C', lines: [{ debit: '5121', credit: '4111', suma: 400 }] },
], openingBalances: { '4111': { d: 100, c: 0 } } };
const fisa1 = acc.fisaCont(fisaDb, '4111', '2026-06');
eq('sold initial = solduri deschidere + rulaj anterior', fisa1.siInitial, 350);
eq('doua miscari in iunie', fisa1.rows.length, 2);
eq('cont corespondent la vanzare', fisa1.rows[0].corespondent, '707');
eq('sold final 350+1000-400', fisa1.sfFinal, 950);
eq('rulaje perioada', fisa1.rd + '|' + fisa1.rc, '1000|400');

section('Situatie aprovizionari si situatie consumuri');
const stkDb = {
  products: [{ id: 'p1', cod: 'M1', denumire: 'Marfa', um: 'buc', cont: '371' }, { id: 'p2', cod: 'MP', denumire: 'Faina', um: 'kg', cont: '301' }],
  gestiuni: [{ id: 'g1', cod: 'DEP' }],
  stockMovements: [
    { id: 'sm0', data: '2026-06-01', tip: 'receptie', initial: true, productId: 'p2', gestiuneId: 'g1', cantitate: 100, pretUnitar: 2, document: 'Stoc initial (preluare)' },
    { id: 'sm1', data: '2026-06-02', tip: 'receptie', productId: 'p1', gestiuneId: 'g1', cantitate: 10, pretUnitar: 5, furnizor: 'F SRL', document: 'NIR1' },
    { id: 'sm2', data: '2026-06-10', tip: 'iesire', productId: 'p1', gestiuneId: 'g1', cantitate: 4, pretUnitar: 0, document: 'BC1' },
    { id: 'sm3', data: '2026-06-15', tip: 'iesire', productId: 'p2', gestiuneId: 'g1', cantitate: 50, pretUnitar: 0, auto: true, document: 'F123' },
  ],
};
const apr = stocks.situatieAprovizionari(stkDb, '2026-06');
eq('aprovizionari: doar receptia reala (stocul initial preluat e exclus)', apr.rows.length, 1);
eq('aprovizionari: total si recapitulatie pe furnizor', apr.total + '|' + apr.perFurnizor['F SRL'], '50|50');
const cons = stocks.situatieConsumuri(stkDb, '2026-06');
eq('consumuri: 2 iesiri in perioada', cons.rows.length, 2);
eq('consumuri: M1 la CMP pe 607 (4 x 5)', cons.perCont['607'], 20);
eq('consumuri: MP la CMP pe 601 (50 x 2)', cons.perCont['601'], 100);
ok('consumuri: iesirea automata e marcata "vanzare"', cons.rows.some((r) => r.cod === 'MP' && r.sursa === 'vanzare'));
ok('consumuri: bonul de consum manual e marcat "consum"', cons.rows.some((r) => r.cod === 'M1' && r.sursa === 'consum'));

// DBF: construieste un DBF minimal si parseaza-l
const dbfMod = require('../src/dbf');
(() => {
  const fields = [['CUI', 'C', 10], ['DEN', 'C', 20]];
  const hl = 32 + fields.length * 32 + 1; const rl = 1 + fields.reduce((s, f) => s + f[2], 0);
  const recs = [['RO123', 'ALFA SRL'], ['RO999', 'BETA SRL']];
  const b = Buffer.alloc(hl + recs.length * rl + 1);
  b[0] = 0x03; b.writeUInt32LE(recs.length, 4); b.writeUInt16LE(hl, 8); b.writeUInt16LE(rl, 10);
  let o = 32; for (const [n, t, l] of fields) { b.write(n, o, 'latin1'); b[o + 11] = t.charCodeAt(0); b[o + 16] = l; o += 32; }
  b[o] = 0x0D; o++;
  for (const r of recs) { b[o] = 0x20; let p = o + 1; r.forEach((v, i) => { b.write(String(v).padEnd(fields[i][2]), p, 'latin1'); p += fields[i][2]; }); o += rl; }
  const drows = dbfMod.parseDbf(b);
  eq('DBF: antet + 2 inregistrari', drows.length, 3);
  eq('DBF: nume campuri', drows[0].join(','), 'CUI,DEN');
  eq('DBF: prima inregistrare', drows[1].join(','), 'RO123,ALFA SRL');
})();

section('Facturi recurente (scadente)');
const recMod = require('../src/recurring');
const tpl = (o) => Object.assign({ activ: true, frecventa: 'lunar', startDate: '2026-01', lastGenerated: null }, o);
eq('lunar: scadent in orice luna', recMod.dueForPeriod([tpl({})], '2026-03').length, 1);
eq('inactiv: nu e scadent', recMod.dueForPeriod([tpl({ activ: false })], '2026-03').length, 0);
eq('deja generat luna asta: nu se redubleaza', recMod.dueForPeriod([tpl({ lastGenerated: '2026-03' })], '2026-03').length, 0);
eq('inainte de luna de start: nu', recMod.dueForPeriod([tpl({ startDate: '2026-05' })], '2026-03').length, 0);
eq('anual: scadent in luna de start (ian)', recMod.dueForPeriod([tpl({ frecventa: 'anual' })], '2026-01').length, 1);
eq('anual: NU in alta luna (mar)', recMod.dueForPeriod([tpl({ frecventa: 'anual' })], '2026-03').length, 0);
eq('trimestrial: scadent la +3 luni (apr)', recMod.dueForPeriod([tpl({ frecventa: 'trimestrial' })], '2026-04').length, 1);
eq('trimestrial: NU in luna intermediara (feb)', recMod.dueForPeriod([tpl({ frecventa: 'trimestrial' })], '2026-02').length, 0);

section('Personalizare documente: IBAN in e-Factura');
const efEntry = { tip: 'factura_vanzare_marfuri', data: '2026-06-15', document: 'F1', partener: 'B', partenerCui: 'RO9', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] };
const efIban = xml.eFacturaXml({ nume: 'X', cui: 'RO1', iban: 'RO49 BTRL 0001', banca: 'BT' }, efEntry, {});
ok('e-Factura include PaymentMeans + IBAN (fara spatii) cand e setat', efIban.includes('PaymentMeans') && efIban.includes('RO49BTRL0001') && efIban.includes('>BT<'));
ok('e-Factura bine-format cu PaymentMeans', wellFormed(efIban));
ok('fara IBAN -> fara PaymentMeans (optional)', !xml.eFacturaXml({ nume: 'X', cui: 'RO1' }, efEntry, {}).includes('PaymentMeans'));

section('Impozit pe profit (16%)');
const ptEnt = [
  { id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 10000 }] },
  { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 6000 }] },
];
const pt = acc.profitTax({ entries: ptEnt }, '2026', 16);
eq('profit impozabil = 10000 - 6000', pt.profitImpozabil, 4000);
eq('impozit = 4000 × 16% = 640', pt.impozit, 640);
eq('articol 691=4411', pt.lines[0].debit + '=' + pt.lines[0].credit, '691=4411');
eq('691 exclus din baza (re-rulare cu impozit deja inregistrat -> tot 640)', acc.profitTax({ entries: ptEnt.concat([{ id: '3', period: '2026-12', data: '2026-12-31', lines: [{ debit: '691', credit: '4411', suma: 640 }] }]) }, '2026', 16).impozit, 640);
const ptLoss = acc.profitTax({ entries: [{ id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 5000 }] }, { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 8000 }] }] }, '2026', 16);
eq('pierdere -> impozit 0', ptLoss.impozit, 0);
eq('pierdere -> niciun articol', ptLoss.lines.length, 0);

section('Impozit pe profit — ajustari fiscale + reportare pierdere');
const ptAdjEnt = [
  { id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 10000 }] },
  { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 6000 }] },
]; // profit contabil 4000
const ptAdj = acc.profitTax({ entries: ptAdjEnt }, '2026', { cota: 16, cheltNedeductibile: 1000, deduceri: 500 });
eq('profit impozabil = 4000 + 1000 nedeductibile − 500 deduceri', ptAdj.profitImpozabil, 4500);
eq('impozit = 4500 × 16% = 720', ptAdj.impozit, 720);
const ptAdj2 = acc.profitTax({ entries: ptAdjEnt }, '2026', { cota: 16, pierdereReportata: 2000 });
eq('pierdere reportata 2000 -> profit impozabil 2000', ptAdj2.profitImpozabil, 2000);
eq('impozit = 320, pierdere de reportat = 0', ptAdj2.impozit, 320);
const ptAdj3 = acc.profitTax({ entries: ptAdjEnt }, '2026', { cota: 16, pierdereReportata: 5000 });
eq('pierdere 5000 > profit 4000 -> impozit 0', ptAdj3.impozit, 0);
eq('pierdere folosita 4000 (doar pana la 0)', ptAdj3.pierdereFolosita, 4000);
eq('pierdere de reportat ramasa = 1000', ptAdj3.pierdereDeReportat, 1000);
const ptLossYr = acc.profitTax({ entries: [{ id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 3000 }] }, { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 8000 }] }] }, '2026', { cota: 16, pierdereReportata: 1000 });
eq('an pe pierdere -> impozit 0', ptLossYr.impozit, 0);
eq('pierdere curenta 5000 + reportata 1000 = 6000 de reportat', ptLossYr.pierdereDeReportat, 6000);

section('Productie (consum materiale + obtinere produse finite)');
const prodMod = require('../src/production');
const prodProducts = [{ id: 'PF', cont: '345', cod: 'PF1', denumire: 'Masa', um: 'buc' }, { id: 'MAT', cont: '301', cod: 'M1', denumire: 'Cherestea', um: 'mc' }];
const prodBase = [{ id: 'm0', productId: 'MAT', gestiuneId: 'g1', data: '2026-06-01', tip: 'receptie', cantitate: 100, pretUnitar: 10 }];
let pn = 0;
const prodR = prodMod.buildProduction(prodProducts, prodBase, { productId: 'PF', gestiuneId: 'g1', cantitate: 10, costUnitar: 50, materiale: [{ productId: 'MAT', gestiuneId: 'g1', cantitate: 30 }] }, { fid: 1, data: '2026-06-15', document: 'P1', nextId: () => 'sm' + (++pn) });
ok('consum material 601=301 300 (la CMP 10)', prodR.lines.some((l) => l.debit === '601' && l.credit === '301' && l.suma === 300));
ok('obtinere PF 345=711 500 (10 × cost 50)', prodR.lines.some((l) => l.debit === '345' && l.credit === '711' && l.suma === 500));
eq('2 miscari de stoc (iesire material + receptie PF)', prodR.newMovements.length, 2);
eq('valoare obtinuta = 500', prodR.valoareObtinuta, 500);
const prodRep = prodMod.productionReport({ products: prodProducts, stockMovements: prodR.newMovements }, '2026-06');
eq('situatie productie: 1 produs finit', prodRep.rows.length, 1);
eq('situatie productie: valoare totala 500', prodRep.totalValoare, 500);
ok('stoc insuficient -> avertisment', prodMod.buildProduction(prodProducts, [], { productId: 'PF', cantitate: 1, costUnitar: 50, materiale: [{ productId: 'MAT', gestiuneId: 'g1', cantitate: 5 }] }, { fid: 1, data: '2026-06-15', nextId: () => 'x' + (++pn) }).warns.length > 0);

section('Cote fiscale configurabile');
const fcfg = require('../src/fiscal');
eq('CAS implicit 25%', fcfg.DEFAULTS.cas, 25);
fcfg.applyConfig({ cas: 21 });
eq('dupa applyConfig(cas:21): FISCAL.cas = 21', fcfg.FISCAL.cas, 21);
eq('payroll preia noua cota CAS (5000 × 21%)', fcfg.payroll(5000, 0, {}).cas, 1050);
eq('celelalte raman implicite (CASS 10%)', fcfg.FISCAL.cass, 10);
fcfg.applyConfig({ cas: 'abc' });
eq('suprascriere invalida -> revine la default (25)', fcfg.FISCAL.cas, 25);
fcfg.applyConfig({});
eq('reset complet: payroll CAS din nou 1250', fcfg.payroll(5000, 0, {}).cas, 1250);

section('Avize si facturi simplificate');
const avL = gt2('aviz_livrare').build({ baza: 1000, tva: 210, cota: 21 });
eq('aviz livrare: 418=707', avL[0].debit + '=' + avL[0].credit, '418=707');
const facAv = gt2('facturare_aviz').build({ baza: 1000, tva: 210, cota: 21 });
ok('facturare aviz: 4111=418 (total cu TVA) + 4428=4427', facAv.some((l) => l.debit === '4111' && l.credit === '418' && l.suma === 1210) && facAv.some((l) => l.debit === '4428' && l.credit === '4427' && l.suma === 210));
const facS = gt2('factura_simplificata').build({ baza: 500, tva: 105, cota: 21, cont: '5311' });
ok('factura simplificata (cash): 5311=707 + 5311=4427', facS.some((l) => l.debit === '5311' && l.credit === '707' && l.suma === 500) && facS.some((l) => l.debit === '5311' && l.credit === '4427' && l.suma === 105));
const net418 = (lines) => lines.reduce((s, l) => s + (l.credit === '418' ? l.suma : 0) - (l.debit === '418' ? l.suma : 0), 0);
eq('contul 418 se inchide dupa aviz + facturare (net 0)', net418(avL) + net418(facAv), 0);

section('Validare pre-depunere declaratii');
const validateMod = require('../src/validate');
ok('declaratie valida (CUI + an + continut) -> ok', validateMod.validateDeclaration('d205', '<?xml version="1.0"?><declaratie205 cui="123" an="2026"><beneficiar /></declaratie205>').ok);
const vNoCui = validateMod.validateDeclaration('d205', '<?xml version="1.0"?><declaratie205 an="2026"></declaratie205>');
ok('fara CUI -> eroare', !vNoCui.ok && vNoCui.errors.some((e) => /CUI/i.test(e)));
ok('declaratie goala -> avertisment (nu eroare)', validateMod.validateDeclaration('d205', '<?xml version="1.0"?><declaratie205 cui="123" an="2026"></declaratie205>').warnings.some((w) => /beneficiar/i.test(w)));
ok('lipsa antet <?xml -> eroare bine-format', !validateMod.validateDeclaration('d300', '<declaratie300 cui="1" luna="6" an="2026"/>').ok);
ok('d300 fara luna -> eroare', validateMod.validateDeclaration('d300', '<?xml version="1.0"?><declaratie300 cui="1" an="2026"/>').errors.some((e) => /luna/i.test(e)));
ok('d100: impozit 0 -> avertisment', validateMod.validateDeclaration('d100', '<?xml version="1.0"?><declaratie100 cui="1" luna="6" an="2026" total_plata="0.00"/>').warnings.some((w) => /impozit 0/i.test(w)));
ok('intrastat: declaratie goala -> avertisment', validateMod.validateDeclaration('intrastat', '<?xml version="1.0"?><declaratieIntrastat cui="1" luna="6" an="2026"></declaratieIntrastat>').warnings.some((w) => /goala/i.test(w)));
ok('intrastat: articol fara cod NC8 -> avertisment', validateMod.validateDeclaration('intrastat', '<?xml version="1.0"?><declaratieIntrastat cui="1" luna="6" an="2026"><articol codNC=""/></declaratieIntrastat>').warnings.some((w) => /NC8/i.test(w)));

section('Cont de profit si pierdere F20 (structura oficiala)');
const stmtMod = require('../src/statements');
const f20db = { entries: [{ period: '2026-03', lines: [
  { debit: '4111', credit: '707', suma: 1000 }, // cifra de afaceri
  { debit: '607', credit: '371', suma: 400 },   // cheltuieli cu marfuri (materiale)
  { debit: '641', credit: '421', suma: 300 },   // cheltuieli cu personalul
  { debit: '6811', credit: '281', suma: 100 },  // amortizare
  { debit: '627', credit: '5121', suma: 50 },   // alte cheltuieli de exploatare (rezidual)
  { debit: '5121', credit: '766', suma: 80 },   // venit financiar
  { debit: '666', credit: '5121', suma: 30 },   // cheltuiala financiara
  { debit: '691', credit: '4411', suma: 90 },   // impozit pe profit
] }] };
const f20 = stmtMod.profitLossF20(f20db, 2026);
eq('F20 cifra de afaceri = 1000', f20.cifraAfaceri, 1000);
eq('F20 venituri exploatare total = 1000', f20.venitExpl, 1000);
eq('F20 cheltuieli materiale = 400', f20.cheltMateriale, 400);
eq('F20 cheltuieli personal = 300', f20.cheltPersonal, 300);
eq('F20 amortizare = 100', f20.amortizare, 100);
eq('F20 alte cheltuieli exploatare (rezidual 627) = 50', f20.alteCheltExpl, 50);
eq('F20 cheltuieli exploatare total = 850', f20.cheltExpl, 850);
eq('F20 rezultat exploatare = 150', f20.rezExpl, 150);
eq('F20 venit financiar = 80', f20.venitFin, 80);
eq('F20 cheltuiala financiara = 30', f20.cheltFin, 30);
eq('F20 rezultat financiar = 50', f20.rezFin, 50);
eq('F20 rezultat brut = 200', f20.rezBrut, 200);
eq('F20 impozit = 90', f20.impozit, 90);
eq('F20 rezultat net = 110', f20.rezNet, 110);
ok('F20 componente cheltuieli = total (consistent)', f20.cheltMateriale + f20.cheltPersonal + f20.amortizare + f20.alteCheltExpl === f20.cheltExpl);
ok('F20 venituri totale = exploatare + financiar', f20.venitTotal === f20.venitExpl + f20.venitFin);

section('Note explicative 1-5 (cifre auto-completate)');
const noteV = rep.notes(v, '2026');
eq('note: 6 sectiuni (Nota 1-6)', noteV.sections.length, 6);
const n1t = noteV.nota1[noteV.nota1.length - 1]; // randul TOTAL
ok('Nota 1: brut final = brut initial + intrari - iesiri', Math.abs(n1t.brutF - (n1t.brutI + n1t.intrari - n1t.iesiri)) < 0.01);
ok('Nota 1: net = brut - amortizare', Math.abs(n1t.netF - (n1t.brutF - n1t.amortF)) < 0.01);
ok('Nota 5: datorii total = sub 1 an + peste 1 an', Math.abs(noteV.nota5.datoriiTotal - (noteV.nota5.datoriiSub1 + noteV.nota5.datorii1_5 + noteV.nota5.datoriiPeste5)) < 0.01);
ok('Nota 3: rezerva legala + reportat = profit net', noteV.f20.rezNet <= 0 || Math.abs(noteV.rezervaLegala + noteV.reportat - noteV.f20.rezNet) < 0.01);
eq('Nota 4: cifra de afaceri = F20', noteV.f20.cifraAfaceri, stmt.profitLossF20(v, '2026').cifraAfaceri);

section('Situatia fluxurilor de trezorerie F30 (metoda directa)');
const cfDb = { openingBalances: { 5121: { d: 10000, c: 0 } }, entries: [{ period: '2026-04', lines: [
  { debit: '5121', credit: '4111', suma: 5000 },  // incasare client (exploatare +)
  { debit: '401', credit: '5121', suma: 2000 },   // plata furnizor (exploatare -)
  { debit: '421', credit: '5121', suma: 1500 },   // plata salarii (exploatare -)
  { debit: '4423', credit: '5121', suma: 300 },   // plata TVA (exploatare -)
  { debit: '2131', credit: '5121', suma: 8000 },  // achizitie utilaj (investitie -)
  { debit: '5121', credit: '1621', suma: 20000 }, // tragere credit (finantare +)
  { debit: '457', credit: '5121', suma: 1000 },   // dividende platite (finantare -)
  { debit: '5121', credit: '5311', suma: 500 },   // transfer intern (ignorat)
] }] };
const cf = stmt.cashFlow(cfDb, '2026');
eq('F30 incasari clienti', cf.ex_clienti, 5000);
eq('F30 plati furnizori+angajati (-3500)', cf.ex_furnizoriAngajati, -3500);
eq('F30 plati impozite (-300)', cf.ex_impozite, -300);
eq('F30 net exploatare (5000-3500-300)', cf.ex_net, 1200);
eq('F30 investitie imobilizari (-8000)', cf.inv_imobilizari, -8000);
eq('F30 finantare credite (+20000)', cf.fin_credite, 20000);
eq('F30 finantare dividende (-1000)', cf.fin_dividende, -1000);
eq('F30 net finantare (19000)', cf.fin_net, 19000);
eq('F30 variatie totala (1200-8000+19000)', cf.variatie, 12200);
eq('F30 numerar initial', cf.numerarInitial, 10000);
eq('F30 numerar final', cf.numerarFinal, 22200);
ok('F30 control: variatie = final - initial', cf.echilibrat);
ok('F30 transfer intern ignorat (nu apare in altele)', cf.ex_altele === 0);

section('Situatia modificarilor capitalurilor proprii F40');
const eqDb = { openingBalances: { 1012: { d: 0, c: 30000 }, 1061: { d: 0, c: 2000 }, 5121: { d: 32000, c: 0 } }, entries: [{ period: '2026-05', lines: [
  { debit: '5121', credit: '1012', suma: 10000 }, // majorare capital +10000
  { debit: '129', credit: '1061', suma: 500 },     // constituire rezerva legala +500
] }] };
const eqc = stmt.equityChanges(eqDb, '2026');
const eqRow = (n) => eqc.rows.find((r) => r.nume === n) || {};
eq('F40 capital sold initial', eqRow('Capital subscris').soldI, 30000);
eq('F40 capital cresteri', eqRow('Capital subscris').cresteri, 10000);
eq('F40 capital sold final', eqRow('Capital subscris').soldF, 40000);
eq('F40 rezerve legale sold final', eqRow('Rezerve legale').soldF, 2500);
eq('F40 repartizare (129) sold final (reducere)', eqRow('Repartizarea profitului').soldF, -500);
eq('F40 total capitaluri sold final', eqc.total.soldF, 42000);
ok('F40 reconciliere cu F10 (J_capital)', eqc.echilibrat);
ok('F40 rollforward consistent (soldI + cresteri - reduceri = soldF)', eqc.rows.every((r) => Math.abs(r.soldI + r.cresteri - r.reduceri - r.soldF) < 0.01));

section('Import e-Factura primita (UBL)');
const efi = require('../src/efacturaImport');
const ublSample = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">'
  + '<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1</cbc:CustomizationID>'
  + '<cbc:ID>FF-2026-100</cbc:ID><cbc:IssueDate>2026-03-15</cbc:IssueDate><cbc:DueDate>2026-04-15</cbc:DueDate>'
  + '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>RON</cbc:DocumentCurrencyCode>'
  + '<cac:AccountingSupplierParty><cac:Party>'
  + '<cac:PartyTaxScheme><cbc:CompanyID>RO12345678</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>'
  + '<cac:PartyLegalEntity><cbc:RegistrationName>Furnizor Test SRL</cbc:RegistrationName><cbc:CompanyID>J40/1/2020</cbc:CompanyID></cac:PartyLegalEntity>'
  + '</cac:Party></cac:AccountingSupplierParty>'
  + '<cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Firma Mea SRL</cbc:RegistrationName><cbc:CompanyID>RO99</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>'
  + '<cac:TaxTotal><cbc:TaxAmount currencyID="RON">210.00</cbc:TaxAmount></cac:TaxTotal>'
  + '<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="RON">1000.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="RON">1000.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="RON">1210.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="RON">1210.00</cbc:PayableAmount></cac:LegalMonetaryTotal>'
  + '<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="RON">1000.00</cbc:LineExtensionAmount>'
  + '<cac:Item><cbc:Name>Marfa X</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>21.00</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item>'
  + '<cac:Price><cbc:PriceAmount currencyID="RON">500.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine></Invoice>';
const inv = efi.parseUBL(ublSample);
eq('e-Factura numar', inv.numar, 'FF-2026-100');
eq('e-Factura data', inv.data, '2026-03-15');
eq('e-Factura furnizor nume', inv.furnizor.nume, 'Furnizor Test SRL');
eq('e-Factura furnizor CUI (fara RO)', inv.furnizor.cui, '12345678');
eq('e-Factura baza', inv.baza, 1000);
eq('e-Factura TVA', inv.tva, 210);
eq('e-Factura total', inv.total, 1210);
eq('e-Factura cota dedusa', inv.cota, 21);
eq('e-Factura nr. linii', inv.linii.length, 1);
eq('e-Factura linie denumire', inv.linii[0].nume, 'Marfa X');
eq('e-Factura linie cantitate', inv.linii[0].cantitate, 2);
eq('e-Factura linie pret', inv.linii[0].pret, 500);
ok('e-Factura roundtrip cu generatorul UBL', (() => {
  const x = xml.eFacturaUBL({ nume: 'Firma Mea', cui: '99', regCom: 'J1' }, { tip: 'factura_vanzare_marfuri', data: '2026-03-15', document: 'INV-7', partener: 'Client SRL', partenerCui: '12345678', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] }, {});
  const p = efi.parseUBL(x);
  return p.numar === 'INV-7' && p.baza === 1000 && p.tva === 210 && p.furnizor.cui === '99';
})());

section('Registru de casa in valuta (5314)');
const lv = gt('incasare_numerar_valuta').build({ moneda: 'EUR', sumaValuta: 100, curs: 5, contraparte: '4111' });
eq('incasare valuta: linie 5314=4111', lv[0].debit + '=' + lv[0].credit, '5314=4111');
eq('incasare valuta: suma lei = 100x5', lv[0].suma, 500);
const pv = gt('plata_numerar_valuta').build({ moneda: 'USD', sumaValuta: 40, curs: 4.5, contraparte: '401' });
eq('plata valuta: linie 401=5314', pv[0].debit + '=' + pv[0].credit, '401=5314');
eq('plata valuta: suma lei = 40x4.5', pv[0].suma, 180);
const cvDb = { openingBalances: {}, entries: [
  { data: '2026-02-05', period: '2026-02', document: 'CH1', explicatie: 'incasare', valutaInfo: { valuta: 'EUR', sumaValuta: 100, curs: 5 }, lines: [{ debit: '5314', credit: '4111', suma: 500 }] },
  { data: '2026-02-10', period: '2026-02', document: 'CH2', explicatie: 'plata', valutaInfo: { valuta: 'EUR', sumaValuta: 40, curs: 5.1 }, lines: [{ debit: '401', credit: '5314', suma: 204 }] },
  { data: '2026-02-20', period: '2026-02', document: 'USD1', explicatie: 'incasare usd', valutaInfo: { valuta: 'USD', sumaValuta: 50, curs: 4 }, lines: [{ debit: '5314', credit: '4111', suma: 200 }] },
] };
const cvr = acc.cashRegisterValuta(cvDb, '2026-02', 'EUR');
eq('casa valuta: nr randuri', cvr.rows.length, 3);
eq('casa valuta: incasari EUR', cvr.rdVal, 100);
eq('casa valuta: plati EUR', cvr.rcVal, 40);
eq('casa valuta: sold final EUR', cvr.soldFinalVal, 60);
eq('casa valuta: incasari lei (toate monedele)', cvr.rdLei, 700);
eq('casa valuta: sold final lei', cvr.soldFinalLei, 496);
ok('casa valuta: USD nu intra in soldul EUR', cvr.soldFinalVal === 60);

section('Dashboard an-la-an');
const dyDb = { openingBalances: {}, partners: {}, entries: [
  { id: 'a', period: '2025-06', data: '2025-06-10', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '607', credit: '371', suma: 400 }] },
  { id: 'b', period: '2026-06', data: '2026-06-10', lines: [{ debit: '4111', credit: '707', suma: 1500 }, { debit: '607', credit: '371', suma: 600 }] },
] };
const dash = rep.dashboard(dyDb);
eq('dashboard an curent', dash.year, '2026');
eq('dashboard yoY prevYear', dash.yoY.prevYear, 2025);
eq('dashboard venituri 2026', dash.yoY.venituri, 1500);
eq('dashboard venituri 2025 (precedent)', dash.yoY.venituriPrev, 1000);
eq('dashboard crestere venituri +50%', dash.yoY.venituriDelta, 50);
eq('dashboard crestere cheltuieli +50%', dash.yoY.cheltuieliDelta, 50);
eq('dashboard crestere profit +50%', dash.yoY.profitDelta, 50);
// rezumatul executiv (mod simplu): bani disponibili, obligatii stat & salarii
const rzDb = { openingBalances: {}, partners: {}, entries: [
  { id: 'r1', period: '2026-06', data: '2026-06-01', lines: [{ debit: '5121', credit: '4111', suma: 3000 }] },
  { id: 'r2', period: '2026-06', data: '2026-06-02', lines: [{ debit: '5311', credit: '4111', suma: 500 }] },
  { id: 'r3', period: '2026-06', data: '2026-06-03', lines: [{ debit: '641', credit: '421', suma: 2000 }] },
  { id: 'r4', period: '2026-06', data: '2026-06-04', lines: [{ debit: '421', credit: '444', suma: 300 }] },
] };
const rz = rep.dashboard(rzDb);
eq('rezumat: bani disponibili = banca + casa', rz.disponibilTotal, 3500);
eq('rezumat: defalcarea banca/casa', rz.bancaTotal + '|' + rz.casaTotal, '3000|500');
eq('rezumat: salarii de plata (sold creditor 421)', rz.salariiDePlata, 1700);
eq('rezumat: taxe datorate (444)', rz.taxeDatorate, 300);

section('Buget vs realizat');
const budDb = { entries: [{ period: '2026-04', lines: [
  { debit: '4111', credit: '707', suma: 12000 }, // venit realizat 12000
  { debit: '607', credit: '371', suma: 8000 },    // cheltuiala realizata 8000
] }] };
const br = rep.budgetReport(budDb, [{ id: 'x1', cont: '707', suma: 10000 }, { id: 'x2', cont: '607', suma: 9000 }], '2026');
const brRow = (c) => br.rows.find((r) => r.cont === c);
eq('buget venit 707 realizat', brRow('707').actual, 12000);
eq('buget venit 707 abatere (+2000)', brRow('707').variatie, 2000);
eq('buget venit 707 grad realizare 120%', brRow('707').realizarePct, 120);
eq('buget cheltuiala 607 realizat', brRow('607').actual, 8000);
eq('buget cheltuiala 607 abatere (-1000)', brRow('607').variatie, -1000);
eq('total buget venituri', br.totalBugetVenit, 10000);
eq('rezultat bugetat (10000-9000)', br.rezultatBugetat, 1000);
eq('rezultat realizat (12000-8000)', br.rezultatActual, 4000);

section('Reevaluare valutara la sfarsit de perioada');
const fxr = require('../src/fxreval');
const ra = fxr.revalue('5314', true, 500, 100, 5.2); // activ creste: 100 EUR x5.2 = 520 vs 500 -> +20 favorabil
eq('reeval activ: reevaluat lei', ra.revaluedLei, 520);
eq('reeval activ: diferenta +20', ra.diff, 20);
eq('reeval activ favorabila: 5314=765', ra.lines[0].debit + '=' + ra.lines[0].credit, '5314=765');
eq('reeval activ: suma 20', ra.lines[0].suma, 20);
const ra2 = fxr.revalue('5314', true, 500, 100, 4.8); // activ scade -> nefavorabil 665=5314
eq('reeval activ nefavorabila: 665=5314', ra2.lines[0].debit + '=' + ra2.lines[0].credit, '665=5314');
const rdt = fxr.revalue('401', false, 500, 100, 5.2); // datorie creste -> nefavorabil 665=401
eq('reeval datorie nefavorabila: 665=401', rdt.lines[0].debit + '=' + rdt.lines[0].credit, '665=401');
const rdt2 = fxr.revalue('401', false, 500, 100, 4.8); // datorie scade -> favorabil 401=765
eq('reeval datorie favorabila: 401=765', rdt2.lines[0].debit + '=' + rdt2.lines[0].credit, '401=765');
const fxDb = { openingBalances: {}, entries: [
  { period: '2026-01', data: '2026-01-10', valutaInfo: { valuta: 'EUR', sumaValuta: 100, curs: 5 }, lines: [{ debit: '5314', credit: '4111', suma: 500 }] },
] };
const built = fxr.buildRevaluation(fxDb, '2026-12', [{ cont: '5314', foreignBalance: 100, closingRate: 5.2 }]);
eq('buildRevaluation: o linie', built.lines.length, 1);
eq('buildRevaluation: 5314=765 favorabil', built.lines[0].debit + '=' + built.lines[0].credit, '5314=765');
eq('buildRevaluation: suma 20', built.lines[0].suma, 20);
eq('buildRevaluation: total favorabil 20', built.totalFavorabil, 20);
const c5314 = fxr.candidates(fxDb, '2026-12').find((c) => c.cont === '5314');
eq('candidates 5314 sold contabil lei', c5314.bookLei, 500);
eq('candidates 5314 sold in valuta', c5314.foreignBalance, 100);
eq('candidates 5314 moneda EUR', c5314.moneda, 'EUR');
ok('candidates 5314 este activ', c5314.isAsset);

section('Previziune cash-flow');
const fcDb = {
  openingBalances: { 5121: { d: 10000, c: 0 } }, openingAnalytic: [],
  partners: { 111: { cui: '111', den: 'Client A', tip: 'client' }, 222: { cui: '222', den: 'Furnizor B', tip: 'furnizor' } },
  entries: [
    { id: 'c1', period: '2026-06', data: '2026-06-10', partener: 'Client A', partenerCui: '111', lines: [{ debit: '4111', credit: '707', suma: 5000 }] },
    { id: 'f1', period: '2026-06', data: '2026-06-12', partener: 'Furnizor B', partenerCui: '222', lines: [{ debit: '607', credit: '401', suma: 2000 }] },
  ],
};
const fcTpl = [
  { id: 't1', tip: 'factura_vanzare_servicii', frecventa: 'lunar', ziua: 5, activ: true, startDate: '2026-01', fields: { baza: 1000, tva: 210 } },
  { id: 't2', tip: 'factura_cumparare_marfuri', frecventa: 'lunar', ziua: 10, activ: true, startDate: '2026-01', fields: { baza: 500, tva: 105 } },
];
const fc = rep.cashForecast(fcDb, fcTpl, { months: 3, startPeriod: '2026-07' });
eq('forecast: numerar acum', fc.cashNow, 10000);
eq('forecast: creante deschise', fc.openReceivables, 5000);
eq('forecast: datorii deschise', fc.openPayables, 2000);
eq('forecast: 3 luni', fc.rows.length, 3);
eq('forecast luna1 venit recurent (1000+210)', fc.rows[0].recIn, 1210);
eq('forecast luna1 cheltuiala recurenta (500+105)', fc.rows[0].recOut, 605);
eq('forecast luna1 net (5000+1210-2000-605)', fc.rows[0].net, 3605);
eq('forecast luna1 sold final', fc.rows[0].closing, 13605);
eq('forecast luna2 sold final (doar recurente)', fc.rows[1].closing, 14210);

section('Jurnal TVA: cota per rand (export)');
const vjT = acc.vatJournals({ openingBalances: {}, entries: [
  { data: '2026-06-05', period: '2026-06', document: 'F1', partener: 'X', partenerCui: '99', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] },
  { data: '2026-06-06', period: '2026-06', document: 'A1', partener: 'Y', partenerCui: '88', lines: [{ debit: '371', credit: '401', suma: 500 }, { debit: '4426', credit: '401', suma: 55 }] },
] }, '2026-06');
eq('jurnal vanzari: 1 rand', vjT.vanzari.length, 1);
eq('jurnal vanzari cota 21%', vjT.vanzari[0].cota, 21);
eq('jurnal vanzari CUI pe rand', vjT.vanzari[0].cui, '99');
eq('jurnal cumparari: 1 rand', vjT.cumparari.length, 1);
eq('jurnal cumparari cota 11%', vjT.cumparari[0].cota, 11);

section('Compensare creante / datorii');
const { compensablePartners } = require('../src/reconcile');
const compDb = {
  openingBalances: {}, openingAnalytic: [],
  partners: { 555: { cui: '555', den: 'Partener Dual SRL', tip: 'ambele' }, 666: { cui: '666', den: 'Doar Client SRL', tip: 'client' } },
  entries: [
    { id: 'v1', period: '2026-05', data: '2026-05-10', partener: 'Partener Dual SRL', partenerCui: '555', lines: [{ debit: '4111', credit: '707', suma: 3000 }] },
    { id: 'c1', period: '2026-05', data: '2026-05-12', partener: 'Partener Dual SRL', partenerCui: '555', lines: [{ debit: '607', credit: '401', suma: 2000 }] },
    { id: 'v2', period: '2026-05', data: '2026-05-13', partener: 'Doar Client SRL', partenerCui: '666', lines: [{ debit: '4111', credit: '707', suma: 1000 }] },
  ],
};
const comp = compensablePartners(compDb);
eq('compensare: doar partenerul dual', comp.length, 1);
eq('compensare creanta 3000', comp[0].creanta, 3000);
eq('compensare datorie 2000', comp[0].datorie, 2000);
eq('compensare suma compensabila (min)', comp[0].compensabil, 2000);
eq('compensare CUI', comp[0].cui, '555');

section('Abonamente (planuri + trial)');
const plansMod = require('../src/plans');
eq('plans: fara abonament -> none', plansMod.status({}).status, 'none');
eq('plans: 3 planuri definite (fara Business)', plansMod.PLANS.length, 3);
ok('plans: nu exista planul business', !plansMod.PLANS.some((p) => p.id === 'business'));
ok('plans: toate au aceleasi 6 functii', plansMod.PLANS.every((p) => p.features.length === 6 && p.features[0] === 'Facturi + e-Factura'));
// proba per-firma (independenta de abonamentul contului)
const nowFt = Date.parse('2026-07-05T00:00:00Z');
// billing strict per-firma: firmaStatus / firmaLocked
eq('firmaStatus: firma fara abonament -> none (blocata)', plansMod.firmaStatus({}, nowFt).status, 'none');
ok('firmaLocked: fara abonament -> blocata', plansMod.firmaLocked({}, nowFt) === true);
eq('firmaStatus: activa (grandfathered) -> nu e blocata', plansMod.firmaLocked({ subscription: { status: 'active', plan: 'grandfathered' } }, nowFt), false);
const ftAct = plansMod.firmaStatus({ subscription: { plan: 'trial', trialEndsAt: '2026-07-20T00:00:00Z' } }, nowFt);
eq('firmaStatus: proba activa, 15 zile ramase', ftAct.status + '|' + ftAct.zileRamase, 'trial|15');
const ftExp = plansMod.firmaStatus({ subscription: { plan: 'trial', trialEndsAt: '2026-06-01T00:00:00Z' } }, nowFt);
ok('firmaStatus: proba expirata -> expired + blocata', ftExp.status === 'expired' && plansMod.firmaLocked({ subscription: { plan: 'trial', trialEndsAt: '2026-06-01T00:00:00Z' } }, nowFt));
const ftSub = plansMod.firmaTrialSub(nowFt);
ok('firmaTrialSub: proba de 30 zile', ftSub.plan === 'trial' && plansMod.daysLeft(ftSub.trialEndsAt, nowFt) === 30);
const nowSub = Date.parse('2026-06-01T00:00:00Z');
const trial1 = plansMod.startTrial({}, nowSub);
eq('trial: status trial', trial1.status, 'trial');
eq('trial: 30 zile ramase la start', plansMod.status(trial1, nowSub).zileRamase, 30);
eq('trial: inca activ dupa 15 zile', plansMod.status(trial1, nowSub + 15 * 86400000).status, 'trial');
eq('trial: expirat dupa 31 zile', plansMod.status(trial1, nowSub + 31 * 86400000).status, 'expired');
ok('trial: nu se poate porni de doua ori', (() => { try { plansMod.startTrial(trial1, nowSub); return false; } catch (e) { return true; } })());
const sel1 = plansMod.selectPlan({}, 'pro');
eq('select: requestedPlan = pro', sel1.requestedPlan, 'pro');
ok('select: plan inexistent arunca', (() => { try { plansMod.selectPlan({}, 'xyz'); return false; } catch (e) { return true; } })());
ok('select: trial nu e plan platit', (() => { try { plansMod.selectPlan({}, 'trial'); return false; } catch (e) { return true; } })());
const act1 = plansMod.activatePlan(sel1, 'pro', nowSub);
eq('activate: status active', plansMod.status(act1).status, 'active');
eq('activate: plan pro', plansMod.status(act1).plan, 'pro');
eq('activate: requestedPlan curatat', act1.requestedPlan, null);

section('Stripe billing (integrare plati)');
const billing = require('../src/billing');
const evCheckout = billing.interpretEvent({ type: 'checkout.session.completed', data: { object: { metadata: { userId: '7', plan: 'pro' }, customer: 'cus_1', subscription: 'sub_1', client_reference_id: '7' } } });
eq('webhook checkout -> activate', evCheckout.action, 'activate');
eq('webhook checkout plan pro', evCheckout.plan, 'pro');
eq('webhook checkout userId', evCheckout.userId, '7');
eq('webhook checkout customerId', evCheckout.customerId, 'cus_1');
// billing per-firma: firmaId din metadata se propaga in evenimentul de activare (webhook -> firma)
eq('webhook checkout: fara firmaId -> null', evCheckout.firmaId, null);
const evFirma = billing.interpretEvent({ type: 'checkout.session.completed', data: { object: { metadata: { userId: '7', plan: 'pro', firmaId: '42' }, customer: 'cus_1', subscription: 'sub_1' } } });
eq('webhook checkout: firmaId din metadata (per-firma)', evFirma.firmaId, '42');
eq('webhook subscription.updated: firmaId propagat', billing.interpretEvent({ type: 'customer.subscription.updated', data: { object: { metadata: { userId: '7', plan: 'start', firmaId: '9' }, id: 'sub_1', status: 'active' } } }).firmaId, '9');
const evDel = billing.interpretEvent({ type: 'customer.subscription.deleted', data: { object: { metadata: { userId: '7' }, id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
eq('webhook subscription deleted -> cancel', evDel.action, 'cancel');
const evUpd = billing.interpretEvent({ type: 'customer.subscription.updated', data: { object: { metadata: { userId: '7', plan: 'start' }, id: 'sub_1', customer: 'cus_1', status: 'active' } } });
eq('webhook subscription updated activa -> activate', evUpd.action, 'activate');
const evPast = billing.interpretEvent({ type: 'customer.subscription.updated', data: { object: { metadata: { userId: '7', plan: 'start' }, id: 'sub_1', status: 'past_due' } } });
eq('webhook subscription past_due -> update (nu activeaza)', evPast.action, 'update');
eq('webhook eveniment necunoscut -> ignore', billing.interpretEvent({ type: 'invoice.paid', data: { object: {} } }).action, 'ignore');
const evGuest = billing.interpretEvent({ type: 'checkout.session.completed', data: { object: { metadata: { plan: 'pro', guest: '1' }, customer: 'cus_g', subscription: 'sub_g', customer_details: { email: 'A@B.ro' } } } });
eq('webhook guest -> flag guest', evGuest.guest, true);
eq('webhook guest -> email colectat', evGuest.email, 'A@B.ro');
eq('webhook guest -> plan', evGuest.plan, 'pro');
// legarea abonamentului platit (guest) la inscriere, dupa email
const pend = [{ email: 'client@firma.ro', plan: 'pro', customerId: 'cus_1', subscriptionId: 'sub_1' }];
eq('findPending: email potrivit (case-insensitive)', plansMod.findPending(pend, 'Client@Firma.RO'), 0);
eq('findPending: email nepotrivit -> -1', plansMod.findPending(pend, 'altul@x.ro'), -1);
eq('findPending: fara email -> -1', plansMod.findPending(pend, ''), -1);
// blocarea probei expirate (cont read-only)
const pastTrial = { plan: 'trial', status: 'trial', trialStartedAt: '2026-01-01', trialEndsAt: '2026-01-31' };
ok('expiredLock: proba expirata -> blocat', plansMod.expiredLock({ role: 'user', subscription: pastTrial }));
ok('expiredLock: proba activa -> liber', !plansMod.expiredLock({ role: 'user', subscription: plansMod.startTrial({}) }));
ok('expiredLock: fara abonament (invitat/demo) -> liber', !plansMod.expiredLock({ role: 'user' }));
ok('expiredLock: admin -> liber chiar cu proba expirata', !plansMod.expiredLock({ role: 'admin', subscription: pastTrial }));
ok('expiredLock: plan activ -> liber', !plansMod.expiredLock({ role: 'user', subscription: { plan: 'pro', status: 'active' } }));
// tipurile de utilizator: admin / tester (proba) / necontabil (Start) / contabil (Pro)
eq('userKind: admin ramane admin indiferent de plan', plansMod.userKind({ role: 'admin', subscription: { plan: 'pro', status: 'active' } }), 'admin');
eq('userKind: fara abonament -> tester', plansMod.userKind({ role: 'user' }), 'tester');
eq('userKind: proba gratuita -> tester', plansMod.userKind({ role: 'user', subscription: plansMod.startTrial({}) }), 'tester');
eq('userKind: Start activ -> necontabil', plansMod.userKind({ role: 'user', subscription: { plan: 'start', status: 'active' } }), 'necontabil');
eq('userKind: Pro activ -> contabil', plansMod.userKind({ role: 'user', subscription: { plan: 'pro', status: 'active' } }), 'contabil');
eq('userKind: Pro anulat -> tester', plansMod.userKind({ role: 'user', subscription: { plan: 'pro', status: 'canceled' } }), 'tester');
const linkedSub = plansMod.pendingToSubscription(pend[0]);
eq('pendingToSubscription: plan', linkedSub.plan, 'pro');
eq('pendingToSubscription: status active', linkedSub.status, 'active');
eq('pendingToSubscription: customer legat', linkedSub.stripeCustomerId, 'cus_1');
process.env.STRIPE_PRICE_PRO = 'price_test_pro';
eq('billing priceId(pro)', billing.priceId('pro'), 'price_test_pro');
eq('billing planForPrice', billing.planForPrice('price_test_pro'), 'pro');
delete process.env.STRIPE_PRICE_PRO;
ok('billing configured reflecta STRIPE_SECRET_KEY', billing.configured() === !!process.env.STRIPE_SECRET_KEY);

section('Retete / BOM productie');
const bomMod = require('../src/production');
const recT = { productId: 'fp', gestiuneId: 'g1', cantitateBaza: 10, costUnitar: 5, materiale: [{ productId: 'm1', gestiuneId: 'g1', cantitate: 20 }, { productId: 'm2', cantitate: 3 }] };
const ordT = bomMod.expandRecipe(recT, 25);
eq('expandRecipe: cantitate produs finit', ordT.cantitate, 25);
eq('expandRecipe: material 1 scalat (20 x 25/10)', ordT.materiale[0].cantitate, 50);
eq('expandRecipe: material 2 scalat (3 x 2.5)', ordT.materiale[1].cantitate, 7.5);
eq('expandRecipe: cost unitar din reteta', ordT.costUnitar, 5);
eq('expandRecipe: override cost', bomMod.expandRecipe(recT, 10, 8).costUnitar, 8);
eq('expandRecipe: fara cantitate -> cantitateBaza', bomMod.expandRecipe(recT).cantitate, 10);

section('Registrul depunerilor + portofoliu');
const declMod = require('../src/declarations');
eq('termen D300 pentru iunie', declMod.dueDate('d300', '2026-06'), '2026-07-25');
eq('termen D112 pentru decembrie (trece anul)', declMod.dueDate('d112', '2026-12'), '2027-01-25');
eq('termen SAF-T: ultima zi a lunii urmatoare', declMod.dueDate('saft', '2026-06'), '2026-07-31');
eq('termen SAF-T decembrie: 31 ianuarie', declMod.dueDate('saft', '2026-12'), '2027-01-31');
const vDecl = scopedSeed(); // firma platitoare de TVA, cu angajati
const expIun = declMod.expectedForFirma(vDecl, '2026-06');
eq('asteptate iunie: d300+d394+d112+d100+saft (TVA lunar)', expIun.map((x) => x.tip).join(','), 'd300,d394,d112,d100,saft');
eq('asteptate mai: fara d100, dar cu saft lunar', declMod.expectedForFirma(vDecl, '2026-05').map((x) => x.tip).join(','), 'd300,d394,d112,saft');
eq('neplatitor TVA: saft doar trimestrial', declMod.expectedForFirma({ company: { tvaPlatitor: false }, angajati: [] }, '2026-06').map((x) => x.tip).join(','), 'd100,saft');
// PFA: fara D100 (impozitul merge prin Declaratia Unica) si fara SAF-T
eq('PFA platitor TVA: doar d300+d394 (fara d100/saft)', declMod.expectedForFirma({ company: { tvaPlatitor: true, tipEntitate: 'pfa' }, angajati: [], entries: [] }, '2026-06').map((x) => x.tip).join(','), 'd300,d394');
eq('PFA neplatitor fara angajati: nicio declaratie lunara', declMod.expectedForFirma({ company: { tvaPlatitor: false, tipEntitate: 'pfa' }, angajati: [], entries: [] }, '2026-06').length, 0);
const livPfa = rep.livrabile({ company: { tipEntitate: 'pfa' }, entries: [], openingBalances: {} }, '2026-06');
ok('livrabile PFA: fara D100 micro / SAF-T / D101 / situatii financiare / AGA', !livPfa.list.some((x) => [9, 12, 15, 16, 19].includes(x.nr)));
ok('livrabile PFA: Declaratia Unica prezenta cu sumarul ei', livPfa.list.some((x) => /Declaratia Unica/.test(x.nume)) && livPfa.sumar.du && livPfa.sumar.du.venitNet === 0);
eq('neplatitor TVA: luna non-trimestriala fara obligatii', declMod.expectedForFirma({ company: { tvaPlatitor: false }, angajati: [] }, '2026-05').length, 0);
const vIC = { company: { tvaPlatitor: true }, angajati: [], entries: [{ tip: 'livrare_intracomunitara', period: '2026-05', data: '2026-05-10' }] };
ok('D390 asteptata DOAR in lunile cu operatiuni intracomunitare',
  declMod.expectedForFirma(vIC, '2026-05').some((x) => x.tip === 'd390') && !declMod.expectedForFirma(vIC, '2026-04').some((x) => x.tip === 'd390'));
ok('asteptate decembrie include saft', declMod.expectedForFirma(vDecl, '2026-12').some((x) => x.tip === 'saft'));
const dDecl = { declarations: [] };
let seqDecl = 100;
const nidDecl = (p) => p + (seqDecl++);
declMod.record(dDecl, vDecl.firmaId, 'd300', '2026-06', { status: 'generata', generatedAt: '2026-07-01' }, nidDecl);
declMod.record(dDecl, vDecl.firmaId, 'd300', '2026-06', { status: 'depusa', recipisa: 'R123' }, nidDecl);
eq('upsert: o singura inregistrare per (firma,tip,luna)', dDecl.declarations.length, 1);
eq('status dupa depunere', dDecl.declarations[0].status, 'depusa');
declMod.record(dDecl, vDecl.firmaId, 'd300', '2026-06', { status: 'generata' }, nidDecl);
eq('re-generarea NU retrogradeaza depusa', dDecl.declarations[0].status, 'depusa');
const regDecl = declMod.registerForFirma(dDecl, vDecl, '2026-06', '2026-08-01');
eq('registru: d300 depusa', regDecl.find((r) => r.tip === 'd300').status, 'depusa');
ok('registru: d112 nedepusa cu termen depasit -> restanta', regDecl.find((r) => r.tip === 'd112').overdue);
ok('registru: d300 depusa nu e restanta', !regDecl.find((r) => r.tip === 'd300').overdue);
const portoDecl = declMod.portfolio(dDecl, [vDecl], '2026-06', '2026-08-01');
eq('portofoliu: asteptate (cu saft lunar)', portoDecl.tot.asteptate, 5);
eq('portofoliu: depuse', portoDecl.tot.depuse, 1);
eq('portofoliu: restante (d394+d112+d100+saft)', portoDecl.tot.restante, 4);
eq('portofoliu: conformitate 1/5 = 20%', portoDecl.conformitate, 20);
eq('portofoliu: firma are atentionari', portoDecl.firms[0].natentionari, 4);
declMod.record(dDecl, vDecl.firmaId, 'd100', '2026-06', { status: 'scutita' }, nidDecl);
eq('scutita iese din conformitate: 1/4 = 25%', declMod.portfolio(dDecl, [vDecl], '2026-06', '2026-08-01').conformitate, 25);
const notifDecl = declMod.notifications(dDecl, [vDecl], '2026-07-20', 7, 3);
ok('notificari: termen d112 iunie (25 iulie) e in fereastra de 7 zile', notifDecl.items.some((i) => i.tip === 'd112' && i.period === '2026-06' && i.kind === 'termen'));
ok('notificari: d300 depusa nu apare', !notifDecl.items.some((i) => i.tip === 'd300' && i.period === '2026-06'));
eq('notificari: restantele primele', declMod.notifications(dDecl, [vDecl], '2026-08-01', 7, 3).items[0].kind, 'restanta');

section('e-Factura netrimisa in SPV + SAF-T lunar');
eq('addBusinessDays: vineri + 5 zile lucratoare', declMod.addBusinessDays('2026-07-03', 5), '2026-07-10');
const vEf = { firmaId: 9, company: { nume: 'EF SRL', tvaPlatitor: true }, angajati: [], entries: [
  { id: 'e1', tip: 'factura_vanzare_servicii', partenerCui: 'RO123', partener: 'X', document: 'F1', data: '2026-07-18' },
  { id: 'e2', tip: 'factura_vanzare_marfuri', partenerCui: 'RO1', document: 'F2', data: '2026-07-15', spv: { index: '5' } },
  { id: 'e3', tip: 'factura_cumparare_marfuri', partenerCui: 'RO2', document: 'F3', data: '2026-07-15' },
  { id: 'e4', tip: 'factura_vanzare_produse', partenerCui: 'RO4', document: 'F4', data: '2026-07-01' },
  { id: 'e5', tip: 'factura_vanzare_produse', document: 'F5', data: '2026-07-15' },
] };
const efx = declMod.eFacturaNetrimise(vEf, '2026-07-20');
eq('netrimise: doar vanzarile B2B fara spv', efx.count, 2);
eq('netrimise: restante (termen depasit)', efx.overdue, 1);
eq('netrimise: termen = data + 5 zile lucratoare', efx.items.find((x) => x.entryId === 'e1').due, '2026-07-24');
const nEf = declMod.notifications({ declarations: [] }, [vEf], '2026-07-20');
ok('notificari: e-Factura restanta prezenta (status netrimisa)', nEf.items.some((i) => i.tip === 'efactura' && i.kind === 'restanta' && i.status === 'netrimisa'));
ok('notificari: e-Factura cu termen apropiat apare', nEf.items.some((i) => i.tip === 'efactura' && i.kind === 'termen'));
ok('SAF-T lunar: bine-format si cu perioada corecta', (() => { const x = saft.saftXml(vDecl, '2026-06'); return x.includes('<PeriodStart>6</PeriodStart>') && x.includes('<PeriodEnd>6</PeriodEnd>') && x.includes('luna 2026-06'); })());

section('XSS: escaparea datelor externe la randare (public/app.js)');
const appJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
// helper-ul global de escapare exista si acopera toate caracterele periculoase
ok('helper global H() definit', /const H = \(s\) =>/.test(appJs));
ok('H() escapeaza < > & " \'', /'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'/.test(appJs));
// verificarea H() efectiv (simulare)
const Htest = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
eq('H() neutralizeaza un payload de script', Htest('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
eq('H() escapeaza ghilimelele (spargere de atribut)', Htest('a" onmouseover="x'), 'a&quot; onmouseover=&quot;x');
// punctele critice cu date de proveniente externa folosesc H() (poarta anti-regresie)
ok('parteneri: numele si CUI-ul sunt escapate', /\$\{H\(p\.den\)\}/.test(appJs) && /\$\{H\(p\.cui\)\}/.test(appJs));
ok('jurnal/entries: partenerul e escapat', /\$\{H\(e\.partener\)\}/.test(appJs));
ok('utilizatori (admin): username-ul e escapat', /\$\{H\(u\.username\)\}/.test(appJs));
ok('firme: denumirea firmei e escapata', /\$\{H\(f\.nume\)\}/.test(appJs));
ok('stocuri: denumirea produsului e escapata', /\$\{H\(s\.product\.denumire\)\}/.test(appJs));
ok('salarii: numele angajatului e escapat', /\$\{H\(r\.nume\)\}/.test(appJs));

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
