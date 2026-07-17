'use strict';

// Salarizare: stat de plata, fluturas, registrul de salarii, adeverinta de venit.

const { C, clean, finish, header, newDoc, recapPdf, table } = require('./helpers');
const { fmt, periodLabel, round2 } = require('../util');

function statePlataPdf(res, company, sp, period) {
  const doc = newDoc(true);
  header(doc, company, 'Stat de plata', period ? periodLabel(period) : '');
  const rows = sp.rows.map((r, i) => ({
    nr: String(i + 1), nume: r.nume, cnp: r.cnp, functie: r.functie,
    brut: fmt(r.brut), cas: fmt(r.cas), cass: fmt(r.cass), imp: fmt(r.impozit), net: fmt(r.net), cam: fmt(r.cam),
  }));
  const t = sp.totals;
  rows.push({ nr: '', nume: 'TOTAL', cnp: '', functie: '', brut: fmt(t.brut), cas: fmt(t.cas), cass: fmt(t.cass), imp: fmt(t.impozit), net: fmt(t.net), cam: fmt(t.cam), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Nr', key: 'nr', width: 28, align: 'center' },
    { label: 'Nume', key: 'nume', width: 130, wrap: true },
    { label: 'CNP', key: 'cnp', width: 96 },
    { label: 'Functie', key: 'functie', width: 90, wrap: true },
    { label: 'Brut', key: 'brut', width: 66, align: 'right' },
    { label: 'CAS 25%', key: 'cas', width: 60, align: 'right' },
    { label: 'CASS 10%', key: 'cass', width: 60, align: 'right' },
    { label: 'Impozit', key: 'imp', width: 56, align: 'right' },
    { label: 'Net', key: 'net', width: 66, align: 'right' },
    { label: 'CAM 2,25%', key: 'cam', width: 62, align: 'right' },
  ], rows);
  doc.moveDown(0.5);
  doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('Total de virat la buget (CAS + CASS + impozit + CAM): ' + fmt(t.totalBuget) + ' lei. Cost total angajator: ' + fmt(t.costTotal) + ' lei.');
  finish(doc, res, 'stat-plata.pdf');
}

function fluturasPdf(res, company, r, period) {
  const doc = newDoc(false);
  header(doc, company, 'Fluturas de salariu', period ? periodLabel(period) : '');
  doc.fillColor(C.ink).font('Helvetica').fontSize(10);
  doc.text('Angajat: ' + clean(r.nume) + (r.functie ? '  (' + clean(r.functie) + ')' : ''));
  if (r.cnp) doc.text('CNP: ' + clean(r.cnp));
  doc.moveDown(0.5);
  const rows = [];
  if (r.spor) { rows.push({ k: 'Salariu de baza', v: fmt(round2(r.brut - r.spor)) }); rows.push({ k: '+ Spor', v: fmt(r.spor) }); }
  if (r.zileCM || r.zileCO) {
    rows.push({ k: 'Salariu aferent zilelor lucrate', v: fmt(r.salariuZileLucrate != null ? r.salariuZileLucrate : r.brut) });
    if (r.zileCO) rows.push({ k: '+ Indemnizatie concediu de odihna (' + r.zileCO + ' zile, media 3 luni ' + fmt(r.mediaCO) + ')', v: fmt(r.indemnizatieCO) });
    rows.push({ k: 'Total brut impozabil', v: fmt(r.brut), _bold: true });
  } else {
    rows.push({ k: 'Salariu brut', v: fmt(r.brut), _bold: true });
  }
  if (r.zileCM) {
    rows.push({ k: '+ Indemnizatie CM angajator (' + Math.min(5, r.zileCM) + ' zile, ' + (r.procentCM || 75) + '% din media ' + fmt(r.mediaCM) + ')', v: fmt(r.cmAngajator) });
    if (r.cmFnuass) rows.push({ k: '+ Indemnizatie CM FNUASS (' + Math.max(0, r.zileCM - 5) + ' zile)', v: fmt(r.cmFnuass) });
  }
  if (r.normaPartiala && (r.casAngajator || r.cassAngajator)) rows.push({ k: 'Norma partiala: CAS+CASS pana la salariul minim, suportate de ANGAJATOR', v: fmt(round2((r.casAngajator || 0) + (r.cassAngajator || 0))) });
  if (r.avantaje) rows.push({ k: '+ Avantaje in natura impozabile (nu se platesc in bani)', v: fmt(r.avantaje) });
  rows.push({ k: '- CAS 25% (contributie asigurari sociale)', v: fmt(r.cas) });
  rows.push({ k: '- CASS 10% (contributie asigurari sociale de sanatate)', v: fmt(r.cass) });
  if (r.neimpozabil) rows.push({ k: '  din care neimpozabil', v: fmt(r.neimpozabil) });
  rows.push({ k: '- Impozit pe venit 10%', v: fmt(r.impozit) });
  rows.push({ k: '= Salariu net', v: fmt(r.net), _bold: true });
  if (r.avans) rows.push({ k: '- Avans acordat', v: fmt(r.avans) });
  if (r.retineri) rows.push({ k: '- Retineri (popriri / terti)', v: fmt(r.retineri) });
  rows.push({ k: '= REST DE PLATA', v: fmt(r.restPlata), _bold: true, _accent: true, _fill: C.zebra });
  rows.push({ k: 'Contributie angajator: CAM 2,25%', v: fmt(r.cam) });
  rows.push({ k: 'Cost total angajator', v: fmt(r.costTotal), _bold: true });
  recapPdf(res, company, {
    title: 'Fluturas de salariu', subtitle: clean(r.nume) + (period ? ' — ' + periodLabel(period) : ''),
    filename: 'fluturas-' + (r.nume || 'salariu').replace(/[^\w-]/g, '_') + '.pdf', rows,
    colName: 'Element', colVal: 'Suma (lei)',
    note: 'Calcul conform parametrilor fiscali curenti (CAS 25%, CASS 10%, impozit 10%, CAM 2,25% angajator). Semnatura angajat: ____________________',
  });
}

function registruSalariiPdf(res, company, rs) {
  const doc = newDoc(false);
  header(doc, company, 'Registrul anual de salarii', 'Exercitiul ' + rs.year + ' (' + rs.nrLuni + ' luni inregistrate)');
  const rows = rs.angajati.map((e, i) => ({
    nr: String(i + 1), nume: e.nume, cnp: e.cnp, luni: String(e.luni),
    brut: fmt(e.brut), cas: fmt(e.cas), cass: fmt(e.cass), imp: fmt(e.impozit), net: fmt(e.net),
  }));
  const t = rs.totals;
  rows.push({ nr: '', nume: 'TOTAL', cnp: '', luni: '', brut: fmt(t.brut), cas: fmt(t.cas), cass: fmt(t.cass), imp: fmt(t.impozit), net: fmt(t.net), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Nr', key: 'nr', width: 28, align: 'center' },
    { label: 'Nume', key: 'nume', width: 130, wrap: true },
    { label: 'CNP', key: 'cnp', width: 100 },
    { label: 'Luni', key: 'luni', width: 38, align: 'right' },
    { label: 'Brut anual', key: 'brut', width: 76, align: 'right' },
    { label: 'CAS', key: 'cas', width: 60, align: 'right' },
    { label: 'CASS', key: 'cass', width: 60, align: 'right' },
    { label: 'Impozit', key: 'imp', width: 56, align: 'right' },
    { label: 'Net anual', key: 'net', width: 76, align: 'right' },
  ], rows);
  if (!rs.angajati.length) doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('Nicio luna inregistrata pentru acest an. Inregistreaza statele de plata lunare in tab-ul Salarizare.');
  finish(doc, res, 'registru-salarii-' + rs.year + '.pdf');
}

function adeverintaPdf(res, company, e, year) {
  const doc = newDoc(false);
  header(doc, company, 'Adeverinta de venit', 'Exercitiul ' + year);
  doc.fillColor(C.ink).font('Helvetica').fontSize(11);
  doc.moveDown(0.5);
  doc.text('Se adevereste prin prezenta ca ' + clean(e.nume) + (e.cnp ? ', CNP ' + clean(e.cnp) : '')
    + (e.functie ? ', avand functia de ' + clean(e.functie) : '') + ', este salariat al ' + clean(company.nume)
    + (company.cui ? ' (CUI ' + clean(company.cui) + ')' : '') + ' si a realizat in anul ' + year
    + ' venituri din salarii dupa cum urmeaza:', { align: 'justify' });
  doc.moveDown(0.5);
  table(doc, [
    { label: 'Indicator', key: 'k', width: 330 },
    { label: 'Suma (lei)', key: 'v', width: 150, align: 'right' },
  ], [
    { k: 'Numar de luni lucrate', v: String(e.luni) },
    { k: 'Venit brut anual', v: fmt(e.brut), _bold: true },
    { k: 'CAS retinut (25%)', v: fmt(e.cas) },
    { k: 'CASS retinut (10%)', v: fmt(e.cass) },
    { k: 'Impozit pe venit (10%)', v: fmt(e.impozit) },
    { k: 'Venit net anual', v: fmt(e.net), _bold: true, _accent: true, _fill: C.zebra },
  ]);
  doc.moveDown(1);
  doc.fillColor(C.ink).font('Helvetica').fontSize(10)
    .text('Prezenta adeverinta a fost eliberata pentru a-i servi la institutiile care o solicita (banca, autoritati etc.).');
  doc.moveDown(1.5);
  doc.fillColor(C.muted).fontSize(9)
    .text('Administrator: ____________________          Intocmit (contabil): ____________________          Data: ____________');
  finish(doc, res, 'adeverinta-venit-' + (e.nume || '').replace(/[^\w-]/g, '_') + '-' + year + '.pdf');
}


module.exports = { statePlataPdf, fluturasPdf, registruSalariiPdf, adeverintaPdf };
