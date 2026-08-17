'use strict';

// Declaratii fiscale in format PDF (recapitulatii D300/D112/D100, DU, F4109, dosar CM...).

const { C, clean, finish, header, newDoc, recapPdf, table } = require('./helpers');
const { fmt, fmtDate, periodLabel, round2 } = require('../util');

function vatPdf(res, company, vj) {
  const doc = newDoc(true);
  header(doc, company, 'Jurnale de TVA si decont (D300)', vj.period ? periodLabel(vj.period) : 'Cumulat');

  const cols = [
    { label: 'Data', key: 'data', width: 60 },
    { label: 'Document', key: 'document', width: 90 },
    { label: 'Partener', key: 'partener', width: 200, wrap: true },
    { label: 'Baza (lei)', key: 'baza', width: 90, align: 'right' },
    { label: 'TVA (lei)', key: 'tva', width: 90, align: 'right' },
    { label: 'Total (lei)', key: 'total', width: 90, align: 'right' },
  ];

  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text('Jurnal de vanzari (TVA colectata)');
  doc.moveDown(0.2);
  const vRows = vj.vanzari.map((r) => ({ data: fmtDate(r.data), document: r.document, partener: r.partener, baza: fmt(r.baza), tva: fmt(r.tva), total: fmt(r.total) }));
  vRows.push({ data: '', document: '', partener: 'TOTAL', baza: fmt(vj.totals.bazaV), tva: fmt(vj.totals.colectata), total: fmt(round2(vj.totals.bazaV + vj.totals.colectata)), _bold: true, _fill: C.zebra });
  table(doc, cols, vj.vanzari.length ? vRows : [{ data: '', document: '', partener: '(fara vanzari)', baza: '', tva: '', total: '' }]);

  doc.moveDown(0.6);
  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text('Jurnal de cumparari (TVA deductibila)');
  doc.moveDown(0.2);
  const cRows = vj.cumparari.map((r) => ({ data: fmtDate(r.data), document: r.document, partener: r.partener, baza: fmt(r.baza), tva: fmt(r.tva), total: fmt(r.total) }));
  cRows.push({ data: '', document: '', partener: 'TOTAL', baza: fmt(vj.totals.bazaC), tva: fmt(vj.totals.deductibila), total: fmt(round2(vj.totals.bazaC + vj.totals.deductibila)), _bold: true, _fill: C.zebra });
  table(doc, cols, vj.cumparari.length ? cRows : [{ data: '', document: '', partener: '(fara cumparari)', baza: '', tva: '', total: '' }]);

  doc.moveDown(0.6);
  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text('Decont TVA (D300)');
  doc.moveDown(0.2);
  const sumRows = [
    { k: 'TVA colectata (4427)', v: fmt(vj.totals.colectata) },
    { k: 'TVA deductibila (4426)', v: fmt(vj.totals.deductibila) },
    { k: vj.totals.deplata > 0 ? 'TVA DE PLATA (4423)' : 'TVA DE RECUPERAT (4424)', v: fmt(vj.totals.deplata > 0 ? vj.totals.deplata : vj.totals.derecuperat), _bold: true, _accent: true, _fill: C.zebra },
  ];
  table(doc, [{ label: 'Indicator', key: 'k', width: 300 }, { label: 'Suma (lei)', key: 'v', width: 120, align: 'right' }],
    sumRows.map((r) => ({ k: r.k, v: r.v, _bold: r._bold, _accent: r._accent, _fill: r._fill })));

  finish(doc, res, 'jurnale-tva-d300.pdf');
}

/** Raport recapitulativ generic: titlu + tabel indicator/valoare + nota. */

function d112Pdf(res, company, d) {
  recapPdf(res, company, {
    title: 'D112 (recapitulatie) — salarii si contributii', subtitle: periodLabel(d.period),
    filename: 'recap-d112.pdf',
    rows: [
      { k: 'Total salarii brute (641)', v: fmt(d.brut), _bold: true },
      { k: 'CAS 25% retinut (4315)', v: fmt(d.cas) },
      { k: 'CASS 10% retinut (4316)', v: fmt(d.cass) },
      { k: 'Impozit pe salarii 10% (444)', v: fmt(d.impozit) },
      { k: 'CAM 2,25% angajator (436)', v: fmt(d.cam) },
      { k: 'Salarii nete de plata (421)', v: fmt(d.net), _bold: true, _fill: C.zebra },
      { k: 'TOTAL DE VIRAT LA BUGET', v: fmt(d.totalBuget), _bold: true, _accent: true, _fill: C.zebra },
    ],
    note: 'Recapitulatie pentru declaratia D112. Depunerea efectiva (XML) si recipisa se obtin la ANAF/SPV.',
  });
}

function d300Pdf(res, company, d) {
  const rows = [];
  for (const c of (d.coteV || [])) rows.push({ k: '  Livrari ' + (c.cota ? c.cota + '%' : 'scutite/0%') + ' — baza / TVA', v: fmt(c.baza) + ' / ' + fmt(c.tva) });
  rows.push({ k: 'Total baza vanzari', v: fmt(d.bazaV) });
  rows.push({ k: 'TVA colectata (4427)', v: fmt(d.colectata), _bold: true });
  for (const c of (d.coteC || [])) rows.push({ k: '  Achizitii ' + (c.cota ? c.cota + '%' : 'scutite/0%') + ' — baza / TVA', v: fmt(c.baza) + ' / ' + fmt(c.tva) });
  rows.push({ k: 'Total baza cumparari', v: fmt(d.bazaC) });
  rows.push({ k: 'TVA deductibila (4426)', v: fmt(d.deductibila), _bold: true });
  rows.push({ k: d.deplata > 0 ? 'TVA DE PLATA (4423)' : 'TVA DE RECUPERAT (4424)', v: fmt(d.deplata > 0 ? d.deplata : d.derecuperat), _bold: true, _accent: true, _fill: C.zebra });
  recapPdf(res, company, {
    title: 'D300 (recapitulatie) — decont TVA', subtitle: periodLabel(d.period),
    filename: 'recap-d300.pdf', rows,
    note: 'Recapitulatie pentru decontul D300, cu defalcare pe cote (21% / 11% / scutit). Depunerea efectiva (XML) si recipisa se obtin la ANAF/SPV.',
  });
}

function d100Pdf(res, company, d) {
  recapPdf(res, company, {
    title: 'D100 (recapitulatie) — impozit microintreprindere', subtitle: periodLabel(d.period),
    filename: 'recap-d100.pdf',
    rows: [
      { k: 'Venituri totale (baza)', v: fmt(d.venit), _bold: true },
      { k: 'Cota impozit micro', v: d.cota + '%' },
      { k: 'IMPOZIT DE PLATA', v: fmt(d.impozit), _bold: true, _accent: true, _fill: C.zebra },
      ...(d.venitAn != null ? [{ k: 'Venituri cumulate an (control plafon micro)', v: fmt(d.venitAn) + ' / ' + fmt(d.plafonMicroLei) }] : []),
    ],
    note: 'Estimare informativa la cota de ' + d.cota + '%. Cota efectiva si baza depind de regimul firmei (micro vs profit).'
      + ((d.avertismente || []).length ? ' ATENTIE: ' + d.avertismente.join(' ') : ''),
  });
}

/** F4109 — Declaratie privind neutilizarea aparatului de marcat electronic fiscal (o luna).
 *  d = { period, aparate: [{ serie, nrOrdine }] }. Formular pe propria raspundere. */

/** D394 (recapitulatie) — lista B2B pe partener, cota si tip de operatiune.
 *
 *  De ce exista: D394 pleaca la ANAF ca XML, dar e tocmai declaratia unde ochiul unui contabil
 *  prinde greselile — un partener lipsa, un CUI gresit, o cota amestecata, un total care nu se
 *  potriveste cu jurnalul. Pana acum se putea depune fara sa poata fi citita.
 *
 *  `ops` vine din `xml.d394Operatiuni` — ACEEASI agregare din care se compune XML-ul, nu una
 *  paralela: doua motoare pe aceeasi lege se contrazic garantat.
 */
const D394_TIPURI = {
  L: 'Livrari taxabile',
  V: 'Livrari cu taxare inversa (art. 331)',
  A: 'Achizitii taxabile',
  C: 'Achizitii cu taxare inversa (art. 331)',
  N: 'Achizitii de la persoane fizice (fila de carnet)',
};
function d394Pdf(res, company, d) {
  const doc = newDoc(true);
  header(doc, company, 'D394 (recapitulatie) — declaratie informativa', periodLabel(d.period));

  const cols = [
    { label: 'CUI / CNP', key: 'cui', width: 110 },
    { label: 'Partener', key: 'den', width: 250, wrap: true },
    { label: 'Cota', key: 'cota', width: 55, align: 'right' },
    { label: 'Facturi', key: 'nr', width: 65, align: 'right' },
    { label: 'Baza (lei)', key: 'baza', width: 100, align: 'right' },
    { label: 'TVA (lei)', key: 'tva', width: 100, align: 'right' },
  ];

  const ops = d.ops || [];
  let totalBaza = 0; let totalTva = 0; let totalFacturi = 0;
  for (const tip of ['L', 'V', 'A', 'C', 'N']) {
    const ale = ops.filter((o) => o.tip === tip);
    if (!ale.length) continue;
    let bz = 0; let tv = 0; let nr = 0;
    const randuri = ale
      .sort((a, b) => String(a.den || '').localeCompare(String(b.den || '')) || a.cota - b.cota)
      .map((o) => {
        bz = round2(bz + o.baza); tv = round2(tv + o.tva); nr += o.nr;
        return { cui: o.cui || '—', den: clean(o.den || '(fara denumire)'), cota: o.cota + '%', nr: String(o.nr), baza: fmt(o.baza), tva: fmt(o.tva) };
      });
    randuri.push({ cui: '', den: 'TOTAL ' + D394_TIPURI[tip].toUpperCase(), cota: '', nr: String(nr), baza: fmt(bz), tva: fmt(tv), _bold: true, _fill: C.zebra });
    totalBaza = round2(totalBaza + bz); totalTva = round2(totalTva + tv); totalFacturi += nr;

    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text(tip + ' — ' + D394_TIPURI[tip]);
    doc.moveDown(0.2);
    table(doc, cols, randuri);
    doc.moveDown(0.5);
  }

  if (!ops.length) {
    doc.fillColor(C.head).font('Helvetica').fontSize(10)
      .text('Nicio operatiune B2B cu partener identificat prin CUI in perioada aleasa.');
    doc.moveDown(0.5);
  }

  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text('Control');
  doc.moveDown(0.2);
  table(doc, [{ label: 'Indicator', key: 'k', width: 320 }, { label: 'Valoare', key: 'v', width: 140, align: 'right' }], [
    { k: 'Parteneri distincti in declaratie', v: String(new Set(ops.map((o) => o.cui)).size) },
    { k: 'Facturi raportate (total)', v: String(totalFacturi) },
    { k: 'Baza totala (lei)', v: fmt(totalBaza), _bold: true },
    { k: 'TVA totala (lei)', v: fmt(totalTva), _bold: true, _accent: true, _fill: C.zebra },
  ]);

  doc.moveDown(0.4);
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
    .text(clean('Recapitulatie informativa, generata din aceleasi operatiuni ca XML-ul D394. '
      + 'Sumele din declaratia depusa se rotunjesc la LEI INTREGI, deci pot diferi cu bani fata de tabelele de mai sus. '
      + 'Valideaza XML-ul cu DUKIntegrator inainte de depunere.'), { width: 700 });

  finish(doc, res, 'recap-d394.pdf');
}

/** D406 / SAF-T (recapitulatie) — ce CANTITATE de date pleaca si care sunt totalurile de control.
 *  Fisierul oficial are zeci de mii de linii; un om nu-l citeste, dar poate verifica daca numarul
 *  de conturi, parteneri si articole are sens pentru anul lui — si daca totalul se potriveste. */
function saftPdf(res, company, d) {
  recapPdf(res, company, {
    title: 'D406 / SAF-T (recapitulatie) — continutul fisierului',
    subtitle: 'Exercitiul ' + d.year,
    filename: 'recap-saft.pdf',
    rows: [
      { k: 'Conturi cu rulaj sau sold (Master Files)', v: String(d.accounts) },
      { k: 'Clienti', v: String(d.customers) },
      { k: 'Furnizori', v: String(d.suppliers) },
      { k: 'Produse in nomenclator', v: String(d.products) },
      { k: 'Mijloace fixe', v: String(d.assets) },
      { k: 'Articole contabile (General Ledger)', v: String(d.entries), _bold: true },
      { k: 'Facturi de vanzare', v: String(d.salesInvoices) },
      { k: 'Facturi de cumparare', v: String(d.purchaseInvoices) },
      { k: 'Incasari si plati', v: String(d.payments) },
      { k: 'Miscari de stoc', v: String(d.stockMovements) },
      { k: 'TOTAL RULAJ (suma liniilor, lei)', v: fmt(d.totalDebit), _bold: true, _accent: true, _fill: C.zebra },
    ],
    note: 'Recapitulatie a continutului, nu a formei: structura fisierului se verifica cu DUKIntegrator (D406). '
      + 'Un numar care nu are sens pentru anul tau (zero facturi, zero parteneri) inseamna ca lipsesc date, nu ca fisierul e gresit.',
  });
}

/** F4109 — Declaratie privind neutilizarea aparatului de marcat electronic fiscal (o luna).
 *  d = { period, aparate: [{ serie, nrOrdine }] }. Formular pe propria raspundere. */
function f4109Pdf(res, company, d) {
  const doc = newDoc(false);
  header(doc, company, 'DECLARATIE (F4109)', 'Neutilizarea aparatelor de marcat electronice fiscale — ' + periodLabel(d.period));
  const left = doc.page.margins.left; const right = doc.page.width - doc.page.margins.right;
  doc.moveDown(0.4);
  doc.fillColor(C.ink).font('Helvetica').fontSize(10);
  const cui = String(company.cui || '').replace(/^ro/i, '');
  doc.text('Subscrisa ' + clean(company.nume || '') + ', cu sediul in ' + clean([company.adresa, company.oras, company.judet].filter(Boolean).join(', ') || '-')
    + ', cod de identificare fiscala ' + cui + (company.regCom ? ', inregistrata la Registrul Comertului cu nr. ' + clean(company.regCom) : '') + ',', { align: 'justify' });
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').text('declar pe propria raspundere', { continued: true }).font('Helvetica')
    .text(' ca aparatele de marcat electronice fiscale detinute nu au fost utilizate in perioada de raportare ' + periodLabel(d.period) + ':');
  doc.moveDown(0.4);
  const aparate = (d.aparate && d.aparate.length) ? d.aparate : [{ serie: '(completeaza seria fiscala)', nrOrdine: '' }];
  table(doc, [
    { label: 'Nr. crt.', key: 'nr', width: 60 },
    { label: 'Seria fiscala a aparatului de marcat', key: 'serie', width: 300 },
    { label: 'Nr. de ordine / NUI', key: 'nrOrdine', width: 140 },
  ], aparate.map((a, i) => ({ nr: String(i + 1), serie: clean(a.serie || ''), nrOrdine: clean(a.nrOrdine || '') })));
  doc.moveDown(0.8);
  doc.fillColor(C.muted).font('Helvetica').fontSize(9)
    .text('Declaratia se depune pentru fiecare luna in care aparatul de marcat electronic fiscal nu a fost utilizat (OpANAF — formular F4109). '
      + 'Genereaza-o pentru luna respectiva, semneaza-o si depune-o electronic, prin SPV. Cunosc prevederile Codului penal privind falsul in declaratii.', { width: right - left });
  doc.moveDown(1.2);
  const ys = doc.y;
  doc.fillColor(C.ink).font('Helvetica').fontSize(9);
  doc.text('Data: ' + fmtDate(new Date().toISOString().slice(0, 10)), left, ys);
  doc.text('Reprezentant legal,', right - 200, ys);
  doc.text('___________________________', right - 200, ys + 26);
  finish(doc, res, 'f4109-' + d.period + '.pdf');
}

/** Dosar de recuperare a indemnizatiilor de concediu medical de la FNUASS (o luna).
 *  d = { period, rows: [{ nume, cnp, zileCM, mediaCM, cmAngajator, cmFnuass }], totalAngajator, totalFnuass }. */

/** Dosar de recuperare a indemnizatiilor de concediu medical de la FNUASS (o luna).
 *  d = { period, rows: [{ nume, cnp, zileCM, mediaCM, cmAngajator, cmFnuass }], totalAngajator, totalFnuass }. */
function dosarCmPdf(res, company, d) {
  const doc = newDoc(true);
  header(doc, company, 'Dosar recuperare concedii medicale (FNUASS)', periodLabel(d.period));
  doc.fillColor(C.muted).font('Helvetica').fontSize(9)
    .text('Situatia indemnizatiilor de concediu medical si a sumelor de recuperat de la Fondul National Unic de Asigurari Sociale de Sanatate (OUG 158/2005).');
  doc.moveDown(0.3);
  const rows = (d.rows || []).map((r) => ({
    nume: clean(r.nume), cnp: clean(r.cnp || ''), zile: String(r.zileCM || 0), media: fmt(r.mediaCM || 0),
    ang: fmt(r.cmAngajator || 0), fnuass: fmt(r.cmFnuass || 0), total: fmt(round2((r.cmAngajator || 0) + (r.cmFnuass || 0))),
  }));
  rows.push({ nume: 'TOTAL', cnp: '', zile: '', media: '', ang: fmt(d.totalAngajator || 0), fnuass: fmt(d.totalFnuass || 0), total: fmt(round2((d.totalAngajator || 0) + (d.totalFnuass || 0))), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Angajat', key: 'nume', width: 150, wrap: true },
    { label: 'CNP', key: 'cnp', width: 110 },
    { label: 'Zile CM', key: 'zile', width: 55, align: 'right' },
    { label: 'Baza (media)', key: 'media', width: 80, align: 'right' },
    { label: 'Suportat angajator', key: 'ang', width: 90, align: 'right' },
    { label: 'De recuperat FNUASS', key: 'fnuass', width: 95, align: 'right' },
    { label: 'Total indemnizatie', key: 'total', width: 90, align: 'right' },
  ], rows);
  doc.moveDown(0.5);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11)
    .text('SUMA DE RECUPERAT DE LA FNUASS: ' + fmt(d.totalFnuass || 0) + ' lei', doc.page.margins.left, doc.y);
  doc.fillColor(C.muted).font('Helvetica').fontSize(8.5)
    .text('Primele 5 zile lucratoare ale fiecarui concediu medical sunt suportate de angajator (cont 6458); restul se suporta din FNUASS si se recupereaza (cont 4373). '
      + 'Dosarul de recuperare se depune la casa de asigurari de sanatate, insotit de cererea de restituire si certificatele medicale.', doc.page.margins.left, doc.y + 4);
  finish(doc, res, 'dosar-cm-' + d.period + '.pdf');
}

/** Declaratia Unica (PFA, sistem real) — estimarea venitului net si a taxelor anuale. */

/** Declaratia Unica (PFA, sistem real) — estimarea venitului net si a taxelor anuale. */
function declaratiaUnicaPdf(res, company, d) {
  recapPdf(res, company, {
    title: 'Declaratia Unica (estimare) — taxe PFA, sistem real', subtitle: 'Anul ' + d.year,
    filename: 'declaratia-unica-' + d.year + '.pdf',
    rows: [
      { k: 'Venituri din activitate', v: fmt(d.venituri) },
      { k: '- Cheltuieli deductibile', v: fmt(d.cheltuieli) },
      { k: '= VENIT NET ANUAL', v: fmt(d.venitNet), _bold: true, _fill: C.zebra },
      { k: 'CAS 25% (baza: ' + (d.bazaCas ? fmt(d.bazaCas) : 'sub plafonul de 12 salarii minime — optionala') + ')', v: fmt(d.cas) },
      { k: 'CASS 10% (baza: ' + fmt(d.bazaCass) + ', intre 6 si 60 salarii minime)', v: fmt(d.cass) },
      { k: 'Impozit pe venit 10% (dupa deducerea CAS si CASS)', v: fmt(d.impozit) },
      { k: 'TOTAL TAXE DE PLATA (Declaratia Unica)', v: fmt(d.total), _bold: true, _accent: true, _fill: C.zebra },
      ...(d.incasat ? [
        { k: 'Varianta pe INCASAT / PLATIT (partida simpla)', v: '', _bold: true, _fill: C.zebra },
        { k: 'Incasari din activitate − plati deductibile', v: fmt(d.incasat.incasari) + ' − ' + fmt(d.incasat.plati) },
        { k: 'Venit net pe incasari', v: fmt(d.incasat.venitNet), _bold: true },
        { k: 'Total taxe pe varianta incasata (CAS+CASS+impozit)', v: fmt(d.incasat.total), _bold: true },
      ] : []),
    ],
    note: 'Estimare pe salariul minim de ' + fmt(d.salariuMinim) + ' lei (plafoane: 6 SM = ' + fmt(d.plafon6) + ', 12 SM = ' + fmt(d.plafon12)
      + ', 24 SM = ' + fmt(d.plafon24) + ', 60 SM = ' + fmt(d.plafon60) + '). Declaratia Unica se depune personal, din SPV. '
      + 'Optiunile individuale (baza CAS mai mare, alte venituri asigurate, scutiri) pot modifica sumele — verifica-le cu contabilul tau.',
  });
}

function obligatiiPdf(res, company, o) {
  const rows = o.items.map((i) => ({ k: i.cont + ' ' + i.nume, v: fmt(i.suma) }));
  rows.push({ k: 'TOTAL DE PLATA LA ANAF', v: fmt(o.total), _bold: true, _accent: true, _fill: C.zebra });
  recapPdf(res, company, {
    title: 'Situatia sumelor de plata la ANAF', subtitle: periodLabel(o.period),
    filename: 'obligatii-anaf.pdf', rows,
    note: 'Solduri creditoare ale conturilor de datorii fiscale la sfarsitul perioadei. Termenele depind de regimul firmei.',
  });
}


module.exports = { vatPdf, d112Pdf, d300Pdf, d100Pdf, d394Pdf, saftPdf, f4109Pdf, dosarCmPdf, declaratiaUnicaPdf, obligatiiPdf };
