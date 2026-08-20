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
  // Identificarea angajatului merge prin `intro`, NU pe un document propriu: `recapPdf` isi face
  // singur documentul si il inchide, deci un `newDoc()` de aici ar ramane orfan si tot ce s-ar
  // scrie pe el s-ar pierde — asa s-a si intamplat, iar fluturasul a circulat fara CNP si fara
  // functie. Numele scapase doar fiindca ajunge separat, prin `subtitle`.
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
    const certificate = Array.isArray(r.certificateCM) && r.certificateCM.length
      ? r.certificateCM : [r];
    for (const c of certificate) {
      const numarCertificat = clean([c.serieCM, c.numarCM].filter(Boolean).join(' / '));
      const identificare = 'cod ' + (c.codIndemnizatieCM || '01')
        + (numarCertificat ? ', ' + numarCertificat : '');
      rows.push({ k: '+ Indemnizatie CM angajator (' + identificare + '; '
        + (c.zileCMAngajator || 0) + ' zile, ' + (c.procentCM || 75)
        + '% din media zilnica ' + fmt(c.mediaZilnicaCM) + ')',
      v: fmt(c.cmAngajatorCurent != null ? c.cmAngajatorCurent : c.cmAngajator) });
      if (c.zileNeplatiteCM) rows.push({ k: '  Zi lucratoare neplatita (OUG 91/2025)', v: String(c.zileNeplatiteCM) });
      if (c.cmFnuassCurent != null ? c.cmFnuassCurent : c.cmFnuass) rows.push({ k: '+ Indemnizatie CM FNUASS ('
        + Math.max(0, (c.zilePlatiteCM || 0) - (c.zileCMAngajator || 0)) + ' zile; '
        + identificare + ')',
      v: fmt(c.cmFnuassCurent != null ? c.cmFnuassCurent : c.cmFnuass) });
      if (c.cmDiferentaAngajator || c.cmDiferentaFnuass) rows.push({
        k: '+ Diferenta CM recalculata pentru luna anterioara (' + identificare + ')',
        v: fmt(round2((c.cmDiferentaAngajator || 0) + (c.cmDiferentaFnuass || 0))),
      });
    }
  }
  if (r.normaPartiala && (r.casAngajator || r.cassAngajator)) rows.push({ k: 'Norma partiala: CAS+CASS pana la salariul minim, suportate de ANGAJATOR', v: fmt(round2((r.casAngajator || 0) + (r.cassAngajator || 0))) });
  if (r.avantaje) rows.push({ k: '+ Avantaje in natura impozabile (nu se platesc in bani)', v: fmt(r.avantaje) });
  // Art. 76 alin. (4^1): fiecare categorie pe randul ei, cu limita ei. Un total ar fi ilizibil —
  // angajatul nu ar putea vedea DE CE i s-a impozitat un abonament, iar fluturasul e exact locul
  // unde se contesta asa ceva.
  for (const b of r.beneficii || []) {
    const lim = b.limitaIndividuala == null ? 'fara limita proprie' : 'limita ' + fmt(b.limitaIndividuala);
    rows.push({ k: '+ ' + clean(b.nume) + ' (' + b.temei + ', ' + lim + ')', v: fmt(b.acordat) });
    if (b.impozabil > 0) {
      const cauza = b.pesteIndividual > 0 && b.pestePlafon > 0 ? 'peste limita proprie si peste plafonul de 33%'
        : b.pesteIndividual > 0 ? (b.motiv ? clean(b.motiv) : 'peste limita proprie')
          : 'peste plafonul de 33% din salariul de baza';
      rows.push({ k: '   din care IMPOZABIL — ' + cauza, v: fmt(b.impozabil) });
    }
  }
  if (r.beneficiiAcordate > 0) {
    rows.push({ k: 'Plafon 33% din salariul de baza (art. 76 alin. (4^1)): ' + fmt(r.beneficiiPlafon)
      + ' — neimpozabil ' + fmt(r.beneficiiNeimpozabile) + ', ramas ' + fmt(r.beneficiiRamas),
    v: fmt(r.beneficiiImpozabile), _bold: !!r.beneficiiDepasit });
    if (r.beneficiiCursNecesar) rows.push({
      k: 'Curs EUR plafoane anuale: ' + fmt(r.cursEurBeneficii) + ' ('
        + (r.cursEurBeneficiiSursa === 'bnr' ? 'BNR ' + clean(r.cursEurBeneficiiData) : 'provizoriu') + ')',
      v: '',
    });
    if (r.beneficiiOrdineNecesara) rows.push({
      k: 'Ordine plafon 33% confirmata de angajator: '
        + (r.beneficiiOrdineConfirmata ? 'DA' : 'NU'),
      v: clean((r.ordineBeneficii || []).join(' > ')),
    });
  }
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
    intro: [
      'Angajat: ' + clean(r.nume) + (r.functie ? '  (' + clean(r.functie) + ')' : ''),
      r.cnp ? 'CNP: ' + clean(r.cnp) : null,
    ],
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
