'use strict';

// Situatii financiare (P&L, bilant, fluxuri, capitaluri, note) + setul complet F10/F20/F30/F40.

const { C, clean, finish, header, newDoc, table } = require('./helpers');
const { fmt, periodLabel } = require('../util');

// Cont de profit si pierdere pe structura oficiala F20, doua coloane (precedent / curent).
// `cur`/`prev` = profitLossF20 pe anul curent/precedent; `detail` = profitLoss(an curent) pentru detalierea pe conturi.
function plBody(doc, cur, prev, detail) {
  const Y0 = String(Number(cur.year) - 1);
  const R = (ind, key, opt) => Object.assign({ ind, prev: prev ? fmt(prev[key]) : '-', val: fmt(cur[key]) }, opt || {});
  const rows = [
    R('1. Cifra de afaceri neta', 'cifraAfaceri'),
    R('2. Variatia stocurilor / productia imobilizata', 'venitProductie'),
    R('3. Alte venituri din exploatare', 'alteVenitExpl'),
    R('VENITURI DIN EXPLOATARE - TOTAL', 'venitExpl', { _bold: true, _fill: C.zebra }),
    R('4. Cheltuieli cu materii prime, marfuri, utilitati', 'cheltMateriale'),
    R('5. Cheltuieli cu personalul', 'cheltPersonal'),
    R('6. Ajustari de valoare (amortizari)', 'amortizare'),
    R('7. Alte cheltuieli de exploatare', 'alteCheltExpl'),
    R('CHELTUIELI DIN EXPLOATARE - TOTAL', 'cheltExpl', { _bold: true, _fill: C.zebra }),
    R('REZULTAT DIN EXPLOATARE', 'rezExpl', { _accent: true, _bold: true, _fill: C.zebra }),
    R('8. Venituri financiare', 'venitFin'),
    R('9. Cheltuieli financiare', 'cheltFin'),
    R('REZULTAT FINANCIAR', 'rezFin', { _bold: true, _fill: C.zebra }),
    R('VENITURI TOTALE', 'venitTotal', { _bold: true }),
    R('CHELTUIELI TOTALE', 'cheltTotal', { _bold: true }),
    R('REZULTAT BRUT', 'rezBrut', { _bold: true, _fill: C.zebra }),
    R('10. Impozit pe profit / venit', 'impozit'),
    R('REZULTATUL NET AL EXERCITIULUI', 'rezNet', { _accent: true, _bold: true, _fill: C.zebra }),
  ];
  table(doc, [
    { label: 'Indicator', key: 'ind', width: 300 },
    { label: 'Ex. precedent ' + Y0, key: 'prev', width: 100, align: 'right' },
    { label: 'Ex. curent ' + cur.year, key: 'val', width: 100, align: 'right' },
  ], rows);
  doc.moveDown(0.5);
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
    .text('Structura F20 prescurtat (OMFP 1802/2014). Randurile "Alte..." sunt reziduale; totalurile coincid cu rulajul claselor 6 si 7. Ciorna - validati cu DUKIntegrator inainte de depunere.', { width: 500 });

  if (detail) {
    doc.moveDown(0.8);
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text('Detaliere venituri (clasa 7)');
    doc.moveDown(0.2);
    table(doc, [
      { label: 'Cont', key: 'cod', width: 60 },
      { label: 'Denumire', key: 'nume', width: 320, wrap: true },
      { label: 'Suma', key: 'suma', width: 120, align: 'right' },
    ], detail.detaliiVenituri.map((d) => ({ cod: d.cod, nume: d.nume, suma: fmt(d.suma) })));

    doc.moveDown(0.8);
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text('Detaliere cheltuieli (clasa 6)');
    doc.moveDown(0.2);
    table(doc, [
      { label: 'Cont', key: 'cod', width: 60 },
      { label: 'Denumire', key: 'nume', width: 320, wrap: true },
      { label: 'Suma', key: 'suma', width: 120, align: 'right' },
    ], detail.detaliiCheltuieli.map((d) => ({ cod: d.cod, nume: d.nume, suma: fmt(d.suma) })));
  }
}

function plPdf(res, company, cur, prev, detail) {
  const doc = newDoc(false);
  header(doc, company, 'Cont de profit si pierdere (F20)', 'Exercitiul ' + cur.year);
  plBody(doc, cur, prev, detail);
  finish(doc, res, 'cont-profit-pierdere-f20.pdf');
}

// Bilant pe structura oficiala F10, doua coloane (inceput / sfarsit de exercitiu).
// `cur`/`prev` = balanceSheetF10 la 31 dec. an curent/precedent; `detail` = balanceSheet(an curent) pentru soldurile pe conturi.

// Bilant pe structura oficiala F10, doua coloane (inceput / sfarsit de exercitiu).
// `cur`/`prev` = balanceSheetF10 la 31 dec. an curent/precedent; `detail` = balanceSheet(an curent) pentru soldurile pe conturi.
function bilantBody(doc, cur, prev, detail) {
  const yr = cur.asOf ? String(cur.asOf).slice(0, 4) : '';
  const Y0 = String(Number(yr) - 1);
  const r = cur.randuri; const r0 = prev ? prev.randuri : null;
  const R = (ind, key, opt) => Object.assign({ ind, prev: r0 ? fmt(r0[key]) : '-', val: fmt(r[key]) }, opt || {});
  const RT = (ind, curv, prevv, opt) => Object.assign({ ind, prev: prevv == null ? '-' : fmt(prevv), val: fmt(curv) }, opt || {});
  const rows = [
    R('A. Active imobilizate', 'A', { _bold: true, _fill: C.zebra }),
    R('   Imobilizari necorporale', 'A_necorp'),
    R('   Imobilizari corporale', 'A_corp'),
    R('   Imobilizari financiare', 'A_financ'),
    R('B. Active circulante', 'B', { _bold: true, _fill: C.zebra }),
    R('   Stocuri', 'B_stocuri'),
    R('   Creante', 'B_creante'),
    R('   Investitii pe termen scurt', 'B_investTS'),
    R('   Casa si conturi la banci', 'B_casa'),
    R('C. Cheltuieli in avans', 'C_cheltAvans'),
    RT('TOTAL ACTIV (A+B+C)', cur.totalActiv, prev ? prev.totalActiv : null, { _accent: true, _bold: true, _fill: C.zebra }),
    R('D. Datorii ce trebuie platite intr-un an (curente)', 'D_datorii'),
    R('E. Active circulante nete', 'E_activeCircNete'),
    R('F. Total active minus datorii curente', 'F_totalMinusDat'),
    R('G. Datorii ce trebuie platite peste un an', 'G_datoriiLT'),
    R('H. Provizioane', 'H_provizioane'),
    R('I. Venituri in avans', 'I_venitAvans'),
    R('J. Capital si rezerve (capitaluri proprii)', 'J_capital', { _bold: true, _fill: C.zebra }),
    R('   din care rezultatul exercitiului', 'rezultatCurent'),
    RT('TOTAL PASIV (J+D+G+H+I)', cur.totalPasiv, prev ? prev.totalPasiv : null, { _accent: true, _bold: true, _fill: C.zebra }),
  ];
  table(doc, [
    { label: 'Indicator', key: 'ind', width: 300 },
    { label: 'Inceput ex. ' + Y0, key: 'prev', width: 100, align: 'right' },
    { label: 'Sfarsit ex. ' + yr, key: 'val', width: 100, align: 'right' },
  ], rows);
  doc.moveDown(0.5);
  doc.fillColor(cur.echilibrat ? C.accent : C.danger).font('Helvetica-Bold').fontSize(10)
    .text(cur.echilibrat ? 'Activ = Pasiv: bilantul este echilibrat.'
      : 'ATENTIE: Activ diferit de Pasiv.');
  doc.moveDown(0.4);
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
    .text('Structura F10 prescurtat (OMFP 1802/2014), doua coloane: sold la inceputul si la sfarsitul exercitiului. Ciorna - validati cu DUKIntegrator inainte de depunere.', { width: 500 });

  if (detail) {
    doc.moveDown(0.8);
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text('Detaliere solduri finale pe conturi (' + yr + ')');
    doc.moveDown(0.2);
    table(doc, [
      { label: 'Cont', key: 'cod', width: 55 },
      { label: 'Denumire', key: 'nume', width: 305, wrap: true },
      { label: 'Sold D', key: 'd', width: 70, align: 'right' },
      { label: 'Sold C', key: 'c', width: 70, align: 'right' },
    ], detail.detalii.map((d) => ({
      cod: d.cod, nume: d.nume,
      d: d.net > 0 ? fmt(d.net) : '', c: d.net < 0 ? fmt(-d.net) : '',
    })));
  }
}

function balanceSheetPdf(res, company, cur, prev, detail) {
  const doc = newDoc(false);
  header(doc, company, 'Bilant (F10 prescurtat)', cur.asOf ? 'La data de ' + periodLabel(cur.asOf) : 'Cumulat');
  bilantBody(doc, cur, prev, detail);
  finish(doc, res, 'bilant-f10.pdf');
}

function notesBody(doc, n) {
  for (const s of n.sections) {
    if (doc.y > doc.page.height - 130) doc.addPage();
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text(clean(s.titlu), doc.page.margins.left, doc.y + 6);
    doc.moveDown(0.2);
    if (s.tabel) {
      const total = 500; const first = Math.round(total * 0.30);
      const w = (s.tabel.cols.length - 1) || 1;
      const cols = s.tabel.cols.map((c, i) => ({ label: c.label, key: c.k, width: i === 0 ? first : Math.round((total - first) / w), align: c.num ? 'right' : 'left' }));
      const rows = s.tabel.rows.map((row) => {
        const o = { _bold: row._bold };
        for (const c of s.tabel.cols) o[c.k] = c.num ? (row[c.k] == null ? '—' : fmt(row[c.k])) : (row[c.k] == null ? '' : String(row[c.k]));
        return o;
      });
      table(doc, cols, rows);
    } else {
      const rows = s.linii.map((l) => ({ k: l.k, v: l.v == null ? '—' : (l.raw ? String(l.v) : fmt(l.v)), _bold: l._bold }));
      table(doc, [{ label: 'Indicator', key: 'k', width: 360 }, { label: 'Valoare', key: 'v', width: 140, align: 'right' }], rows);
    }
    doc.moveDown(0.4);
  }
  if (doc.y > doc.page.height - 160) doc.addPage();
  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text('Nota 7 — Principii si politici contabile', doc.page.margins.left, doc.y + 6);
  doc.moveDown(0.2);
  doc.fillColor(C.ink).font('Helvetica').fontSize(9.5);
  n.principii.forEach((p) => doc.text('•  ' + clean(p), { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }));
}

function notesPdf(res, company, n) {
  const doc = newDoc(false);
  header(doc, company, 'Note explicative la situatiile financiare', 'Exercitiul ' + n.year);
  notesBody(doc, n);
  finish(doc, res, 'note-explicative.pdf');
}

// Factura emisa (document vizual pentru client), generata din articolul contabil.
/** Datele comune ale facturii: baza/TVA/total din linii + clientul din nomenclator. */

// Situatia fluxurilor de trezorerie (F30), metoda directa.
function cashFlowBody(doc, cf) {
  const R = (ind, val, opt) => Object.assign({ ind, val: fmt(val) }, opt || {});
  const rows = [
    R('FLUXURI DIN ACTIVITATEA DE EXPLOATARE', '', { _bold: true, _fill: C.zebra }),
    R('   Incasari de la clienti', cf.ex_clienti),
    R('   Plati catre furnizori si angajati', cf.ex_furnizoriAngajati),
    R('   Plati impozite, taxe si TVA', cf.ex_impozite),
    R('   Dobanzi platite', cf.ex_dobanzi),
    R('   Alte incasari/plati din exploatare', cf.ex_altele),
    R('   Numerar net din exploatare', cf.ex_net, { _accent: true, _bold: true }),
    R('FLUXURI DIN ACTIVITATEA DE INVESTITIE', '', { _bold: true, _fill: C.zebra }),
    R('   Plati/incasari privind imobilizarile', cf.inv_imobilizari),
    R('   Dobanzi si dividende incasate', cf.inv_dobanziDiv),
    R('   Numerar net din investitie', cf.inv_net, { _accent: true, _bold: true }),
    R('FLUXURI DIN ACTIVITATEA DE FINANTARE', '', { _bold: true, _fill: C.zebra }),
    R('   Credite/imprumuturi (trageri minus rambursari)', cf.fin_credite),
    R('   Aporturi de capital', cf.fin_capital),
    R('   Dividende platite', cf.fin_dividende),
    R('   Numerar net din finantare', cf.fin_net, { _accent: true, _bold: true }),
    R('VARIATIA NETA A NUMERARULUI', cf.variatie, { _bold: true, _fill: C.zebra }),
    R('Numerar la inceputul exercitiului', cf.numerarInitial),
    R('Numerar la sfarsitul exercitiului', cf.numerarFinal, { _bold: true }),
  ];
  table(doc, [
    { label: 'Element', key: 'ind', width: 400 },
    { label: 'Suma (lei)', key: 'val', width: 100, align: 'right' },
  ], rows);
  doc.moveDown(0.4);
  doc.fillColor(cf.echilibrat ? C.accent : C.danger).font('Helvetica-Bold').fontSize(9)
    .text(cf.echilibrat
      ? 'Control: variatia numerarului = numerar final - numerar initial (' + fmt(cf.variatieControl) + ').'
      : 'ATENTIE: variatia calculata difera de variatia soldurilor de numerar.');
  doc.moveDown(0.2);
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
    .text('Metoda directa (OMFP 1802/2014). Valorile pozitive = incasari, negative = plati.', { width: 500 });
}

function cashFlowPdf(res, company, cf) {
  const doc = newDoc(false);
  header(doc, company, 'Situatia fluxurilor de trezorerie (F30)', 'Exercitiul ' + cf.year);
  cashFlowBody(doc, cf);
  finish(doc, res, 'flux-trezorerie-f30.pdf');
}

// Situatia modificarilor capitalurilor proprii (F40).

// Situatia modificarilor capitalurilor proprii (F40).
function equityBody(doc, eq) {
  const Y0 = String(Number(eq.year) - 1);
  const rows = eq.rows.map((r) => ({ nume: r.nume, soldI: fmt(r.soldI), cresteri: fmt(r.cresteri), reduceri: fmt(r.reduceri), soldF: fmt(r.soldF) }));
  rows.push({ nume: 'TOTAL CAPITALURI PROPRII', soldI: fmt(eq.total.soldI), cresteri: fmt(eq.total.cresteri), reduceri: fmt(eq.total.reduceri), soldF: fmt(eq.total.soldF), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Element al capitalului propriu', key: 'nume', width: 200 },
    { label: 'Sold 01.01.' + eq.year, key: 'soldI', width: 80, align: 'right' },
    { label: 'Cresteri', key: 'cresteri', width: 75, align: 'right' },
    { label: 'Reduceri', key: 'reduceri', width: 75, align: 'right' },
    { label: 'Sold 31.12.' + eq.year, key: 'soldF', width: 80, align: 'right' },
  ], rows);
  doc.moveDown(0.4);
  doc.fillColor(eq.echilibrat ? C.accent : C.danger).font('Helvetica-Bold').fontSize(9)
    .text(eq.echilibrat
      ? 'Control: total capitaluri proprii = capitalurile din bilantul F10 (' + fmt(eq.capitalPropriiF10) + ').'
      : 'ATENTIE: totalul difera de capitalurile din F10 (' + fmt(eq.capitalPropriiF10) + ').');
  doc.moveDown(0.2);
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
    .text('Cresteri = rulaj creditor; Reduceri = rulaj debitor in cursul exercitiului. Ex. precedent: ' + Y0 + '.', { width: 500 });
}

function equityPdf(res, company, eq) {
  const doc = newDoc(false);
  header(doc, company, 'Situatia modificarilor capitalurilor proprii (F40)', 'Exercitiul ' + eq.year);
  equityBody(doc, eq);
  finish(doc, res, 'modificari-capital-f40.pdf');
}

// Registru de casa in valuta (cont 5314), cu coloane in valuta si in lei.

function roman(n) { return ['', 'I', 'II', 'III', 'IV', 'V', 'VI'][n] || String(n); }

// Set complet de situatii financiare anuale intr-un singur PDF: F20 + F10 + Note explicative.
function setStatementsPdf(res, company, data) {
  const doc = newDoc(false);
  const yr = data.f20cur.year;
  header(doc, company, 'Situatii financiare anuale', 'Exercitiul ' + yr);
  doc.moveDown(0.3);
  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(13).text('I. Contul de profit si pierdere (F20)', doc.page.margins.left, doc.y + 4);
  doc.moveDown(0.3);
  plBody(doc, data.f20cur, data.f20prev, data.plDetail);

  doc.addPage();
  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(13).text('II. Bilant (F10 prescurtat)', doc.page.margins.left, doc.y);
  doc.moveDown(0.3);
  bilantBody(doc, data.f10cur, data.f10prev, data.bsDetail);

  let n = 2;
  if (data.cashFlow) {
    n++;
    doc.addPage();
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(13).text(roman(n) + '. Situatia fluxurilor de trezorerie (F30)', doc.page.margins.left, doc.y);
    doc.moveDown(0.3);
    cashFlowBody(doc, data.cashFlow);
  }
  if (data.equity) {
    n++;
    doc.addPage();
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(13).text(roman(n) + '. Situatia modificarilor capitalurilor proprii (F40)', doc.page.margins.left, doc.y);
    doc.moveDown(0.3);
    equityBody(doc, data.equity);
  }

  n++;
  doc.addPage();
  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(13).text(roman(n) + '. Note explicative', doc.page.margins.left, doc.y);
  doc.moveDown(0.3);
  notesBody(doc, data.notes);

  finish(doc, res, 'situatii-financiare-' + yr + '.pdf');
}


module.exports = { plBody, plPdf, bilantBody, balanceSheetPdf, notesBody, notesPdf, cashFlowBody, cashFlowPdf, equityBody, equityPdf, roman, setStatementsPdf };
