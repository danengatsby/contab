'use strict';

// Mijloace fixe: registrul imobilizarilor, fisa mijlocului fix, graficul de leasing.

const { C, clean, finish, header, newDoc, table } = require('./helpers');
const { fmt, fmtDate, round2 } = require('../util');

function assetsRegisterPdf(res, company, register, asOf) {
  const doc = newDoc(true);
  header(doc, company, 'Registrul mijloacelor fixe', 'Valori la ' + (asOf || ''));
  const rows = register.map((a) => ({
    den: a.denumire, cont: a.cont + '/' + a.calc.contAmortizare, pif: fmtDate(a.dataPif),
    durata: String(a.durataLuni), cost: fmt(a.cost), lunara: fmt(a.calc.amortizareLunara),
    cumulat: fmt(a.calc.amortizareCumulata), ramas: fmt(a.calc.valoareRamasa),
    status: a.status === 'casat' ? 'casat' : 'activ',
  }));
  const tot = register.reduce((s, a) => ({ cost: s.cost + a.cost, cum: s.cum + a.calc.amortizareCumulata, ram: s.ram + a.calc.valoareRamasa }), { cost: 0, cum: 0, ram: 0 });
  rows.push({ den: 'TOTAL', cont: '', pif: '', durata: '', cost: fmt(round2(tot.cost)), lunara: '', cumulat: fmt(round2(tot.cum)), ramas: fmt(round2(tot.ram)), status: '', _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Denumire', key: 'den', width: 180, wrap: true },
    { label: 'Cont/Amort.', key: 'cont', width: 80, align: 'center' },
    { label: 'Data PIF', key: 'pif', width: 66, align: 'center' },
    { label: 'Durata', key: 'durata', width: 44, align: 'right' },
    { label: 'Cost', key: 'cost', width: 78, align: 'right' },
    { label: 'Amort./luna', key: 'lunara', width: 70, align: 'right' },
    { label: 'Amort. cumulata', key: 'cumulat', width: 84, align: 'right' },
    { label: 'Val. ramasa', key: 'ramas', width: 78, align: 'right' },
    { label: 'Stare', key: 'status', width: 48, align: 'center' },
  ], rows);
  finish(doc, res, 'registru-mijloace-fixe.pdf');
}

function assetFisaPdf(res, company, data) {
  const { asset, calc, schedule } = data;
  const doc = newDoc(false);
  header(doc, company, 'Fisa mijlocului fix', clean(asset.denumire));
  const info = [
    { k: 'Denumire', v: asset.denumire },
    { k: 'Cont imobilizare', v: asset.cont + (asset.contNume ? ' ' + asset.contNume : '') },
    { k: 'Cont amortizare', v: calc.contAmortizare },
    { k: 'Furnizor', v: (asset.furnizor || '-') + (asset.cui ? ' (' + asset.cui + ')' : '') },
    { k: 'Data achizitiei', v: fmtDate(asset.dataAchizitie || asset.dataPif) },
    { k: 'Data punerii in functiune', v: fmtDate(asset.dataPif) },
    { k: 'Valoare de intrare (cost)', v: fmt(asset.cost) + ' lei' },
    { k: 'Valoare reziduala', v: fmt(asset.valoareReziduala || 0) + ' lei' },
    { k: 'Durata normala de functionare', v: asset.durataLuni + ' luni (' + round2(asset.durataLuni / 12) + ' ani)' },
    { k: 'Metoda de amortizare', v: ({ liniara: 'Liniara', degresiva: 'Degresiva (AD)', accelerata: 'Accelerata' })[asset.metoda] || 'Liniara' },
    { k: 'Amortizare lunara', v: fmt(calc.amortizareLunara) + ' lei' },
    { k: 'Luni amortizate / total', v: calc.luniAmortizate + ' / ' + calc.durataLuni },
    { k: 'Amortizare cumulata', v: fmt(calc.amortizareCumulata) + ' lei' },
    { k: 'Valoare ramasa de amortizat', v: fmt(calc.valoareRamasa) + ' lei' },
    { k: 'Stare', v: asset.status === 'casat' ? 'Casat la ' + fmtDate(asset.dataCasare) : 'In functiune' },
  ];
  table(doc, [
    { label: 'Element', key: 'k', width: 230 },
    { label: 'Valoare', key: 'v', width: 285 },
  ], info);
  doc.moveDown(0.6);
  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text('Plan de amortizare (liniar)', doc.page.margins.left, doc.y);
  doc.moveDown(0.2);
  table(doc, [
    { label: 'Luna', key: 'period', width: 90, align: 'center' },
    { label: 'Amortizare', key: 'amount', width: 140, align: 'right' },
    { label: 'Amortizare cumulata', key: 'cumulat', width: 150, align: 'right' },
    { label: 'Valoare ramasa', key: 'ramas', width: 135, align: 'right' },
  ], schedule.map((r) => ({ period: r.period, amount: fmt(r.amount), cumulat: fmt(r.cumulat), ramas: fmt(r.ramas) })));
  finish(doc, res, 'fisa-mf-' + asset.id + '.pdf');
}

function leasingSchedulePdf(res, company, s) {
  const doc = newDoc(false);
  header(doc, company, 'Grafic de rate leasing', (s.method === 'rate_egale' ? 'Rate de capital egale' : 'Anuitati constante')
    + ' - ' + fmt(s.principal) + ' lei / ' + s.months + ' luni / ' + s.annualRatePct + '% pe an');
  const rows = s.rows.map((r) => ({ luna: String(r.luna), rata: fmt(r.rata), principal: fmt(r.principal), dobanda: fmt(r.dobanda), sold: fmt(r.sold) }));
  rows.push({ luna: 'TOTAL', rata: fmt(s.totals.rata), principal: fmt(s.totals.principal), dobanda: fmt(s.totals.dobanda), sold: '', _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Luna', key: 'luna', width: 60, align: 'center' },
    { label: 'Rata', key: 'rata', width: 110, align: 'right' },
    { label: 'Principal (167)', key: 'principal', width: 110, align: 'right' },
    { label: 'Dobanda (666)', key: 'dobanda', width: 110, align: 'right' },
    { label: 'Sold ramas', key: 'sold', width: 110, align: 'right' },
  ], rows);
  finish(doc, res, 'grafic-leasing.pdf');
}


module.exports = { assetsRegisterPdf, assetFisaPdf, leasingSchedulePdf };
