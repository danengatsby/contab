'use strict';

// Registre si jurnale (jurnal, cartea mare, balanta, fise, casa, inventar...) — vezi index.js.

const { C, clean, finish, header, newDoc, recapPdf, table } = require('./helpers');
const { fmt, fmtDate, periodLabel, round2 } = require('../util');

function journalPdf(res, company, data) {
  const doc = newDoc(true);
  header(doc, company, 'Registrul-jurnal', data.period ? periodLabel(data.period) : 'Toate inregistrarile');
  const rows = data.rows.map((r) => ({
    nr: r.nr || '', data: fmtDate(r.data), document: r.document,
    explicatie: r.explicatie, debit: r.debit, credit: r.credit, suma: fmt(r.suma),
  }));
  rows.push({ nr: '', data: '', document: '', explicatie: 'TOTAL', debit: '', credit: '', suma: fmt(data.total), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Nr', key: 'nr', width: 34, align: 'center' },
    { label: 'Data', key: 'data', width: 58 },
    { label: 'Document', key: 'document', width: 78 },
    { label: 'Explicatie', key: 'explicatie', width: 288, wrap: true },
    { label: 'Cont D', key: 'debit', width: 55, align: 'center' },
    { label: 'Cont C', key: 'credit', width: 55, align: 'center' },
    { label: 'Suma (lei)', key: 'suma', width: 80, align: 'right' },
  ], rows);
  finish(doc, res, 'registru-jurnal.pdf');
}

function ledgerPdf(res, company, accounts, period) {
  const doc = newDoc(true);
  header(doc, company, 'Cartea mare', period ? periodLabel(period) : 'Toate inregistrarile');
  for (const a of accounts) {
    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11)
      .text(clean(a.cod + ' — ' + a.nume), doc.page.margins.left, doc.y + 6);
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5)
      .text('Sold initial: D ' + fmt(a.siD) + '  /  C ' + fmt(a.siC));
    doc.moveDown(0.2);
    const rows = a.moves.map((m) => ({
      data: fmtDate(m.data), explicatie: m.explicatie,
      debit: m.debit ? fmt(m.debit) : '', credit: m.credit ? fmt(m.credit) : '',
    }));
    rows.push({ data: '', explicatie: 'Rulaj perioada', debit: fmt(a.rd), credit: fmt(a.rc), _bold: true, _fill: C.zebra });
    rows.push({ data: '', explicatie: 'Sold final', debit: fmt(a.sfD), credit: fmt(a.sfC), _bold: true, _accent: true });
    table(doc, [
      { label: 'Data', key: 'data', width: 60 },
      { label: 'Explicatie', key: 'explicatie', width: 360, wrap: true },
      { label: 'Debit', key: 'debit', width: 90, align: 'right' },
      { label: 'Credit', key: 'credit', width: 90, align: 'right' },
    ], rows);
    doc.moveDown(0.5);
  }
  finish(doc, res, 'cartea-mare.pdf');
}

function trialBalancePdf(res, company, tb) {
  const doc = newDoc(true);
  header(doc, company, 'Balanta de verificare', tb.period ? periodLabel(tb.period) : 'Cumulat');
  const rows = tb.rows.map((r) => ({
    cod: r.cod, nume: r.nume,
    siD: fmt(r.siD), siC: fmt(r.siC), rd: fmt(r.rd), rc: fmt(r.rc),
    tsD: fmt(r.tsD), tsC: fmt(r.tsC), sfD: fmt(r.sfD), sfC: fmt(r.sfC),
  }));
  rows.push({
    cod: '', nume: 'TOTAL',
    siD: fmt(tb.tot.siD), siC: fmt(tb.tot.siC), rd: fmt(tb.tot.rd), rc: fmt(tb.tot.rc),
    tsD: fmt(tb.tot.tsD), tsC: fmt(tb.tot.tsC), sfD: fmt(tb.tot.sfD), sfC: fmt(tb.tot.sfC),
    _bold: true, _fill: C.zebra,
  });
  table(doc, [
    { label: 'Cont', key: 'cod', width: 45 },
    { label: 'Denumire', key: 'nume', width: 175, wrap: true },
    { label: 'SI D', key: 'siD', width: 62, align: 'right' },
    { label: 'SI C', key: 'siC', width: 62, align: 'right' },
    { label: 'Rulaj D', key: 'rd', width: 62, align: 'right' },
    { label: 'Rulaj C', key: 'rc', width: 62, align: 'right' },
    { label: 'Sume D', key: 'tsD', width: 62, align: 'right' },
    { label: 'Sume C', key: 'tsC', width: 62, align: 'right' },
    { label: 'SF D', key: 'sfD', width: 62, align: 'right' },
    { label: 'SF C', key: 'sfC', width: 62, align: 'right' },
  ], rows);
  doc.moveDown(0.5);
  doc.fillColor(tb.balanced ? C.accent : C.danger).font('Helvetica-Bold').fontSize(10)
    .text(tb.balanced ? 'Balanta se inchide: cele patru egalitati sunt respectate.'
      : 'ATENTIE: balanta NU se inchide - exista o eroare de inregistrare.');
  finish(doc, res, 'balanta-de-verificare.pdf');
}

// Cont de profit si pierdere pe structura oficiala F20, doua coloane (precedent / curent).
// `cur`/`prev` = profitLossF20 pe anul curent/precedent; `detail` = profitLoss(an curent) pentru detalierea pe conturi.

/** Fisa de cont: miscarile unui cont cu contul corespondent si soldul curent. */
function fisaContPdf(res, company, fc) {
  const doc = newDoc(true);
  header(doc, company, 'Fisa de cont ' + fc.cont, (fc.nume || '') + (fc.period ? '  •  ' + periodLabel(fc.period) : '  •  toate perioadele'));
  doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('Sold initial: ' + fmt(fc.siInitial) + ' lei');
  doc.moveDown(0.3);
  const rows = fc.rows.map((r) => ({
    data: fmtDate(r.data), document: r.document, explicatie: (r.partener ? r.partener + ' — ' : '') + (r.explicatie || ''),
    corespondent: r.corespondent, d: r.d ? fmt(r.d) : '', c: r.c ? fmt(r.c) : '', sold: fmt(r.sold),
  }));
  rows.push({ data: '', document: '', explicatie: 'Rulaje perioada / Sold final', corespondent: '', d: fmt(fc.rd), c: fmt(fc.rc), sold: fmt(fc.sfFinal), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Data', key: 'data', width: 55 },
    { label: 'Document', key: 'document', width: 75 },
    { label: 'Explicatie', key: 'explicatie', width: 250, wrap: true },
    { label: 'Cont coresp.', key: 'corespondent', width: 60 },
    { label: 'Debit', key: 'd', width: 75, align: 'right' },
    { label: 'Credit', key: 'c', width: 75, align: 'right' },
    { label: 'Sold', key: 'sold', width: 80, align: 'right' },
  ], rows);
  finish(doc, res, 'fisa-cont-' + fc.cont + '.pdf');
}

/** Situatia aprovizionarilor: receptiile perioadei, cu recapitulatie pe furnizor. */

function cashBookPdf(res, company, cb) {
  const doc = newDoc(true);
  const isCasa = String(cb.cont).startsWith('53');
  header(doc, company, (isCasa ? 'Registru de casa' : 'Jurnal de banca') + ' — ' + cb.cont, cb.nume + (cb.period ? '  •  ' + periodLabel(cb.period) : ''));
  doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('Sold initial: ' + fmt(cb.siInitial) + ' lei');
  doc.moveDown(0.3);
  const rows = cb.rows.map((r) => ({
    data: fmtDate(r.data), document: r.document, explicatie: (r.partener ? r.partener + ' — ' : '') + r.explicatie,
    incasare: r.incasare ? fmt(r.incasare) : '', plata: r.plata ? fmt(r.plata) : '', sold: fmt(r.sold),
  }));
  rows.push({ data: '', document: '', explicatie: 'Rulaje perioada / Sold final', incasare: fmt(cb.rd), plata: fmt(cb.rc), sold: fmt(cb.sfFinal), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Data', key: 'data', width: 60 },
    { label: 'Document', key: 'document', width: 80 },
    { label: 'Explicatie', key: 'explicatie', width: 280, wrap: true },
    { label: 'Incasari', key: 'incasare', width: 80, align: 'right' },
    { label: 'Plati', key: 'plata', width: 80, align: 'right' },
    { label: 'Sold', key: 'sold', width: 80, align: 'right' },
  ], rows);
  finish(doc, res, 'jurnal-' + cb.cont + '.pdf');
}

/** Registrul-jurnal de incasari si plati (partida simpla, PFA — OMFP 170/2015). */

// Registru de casa in valuta (cont 5314), cu coloane in valuta si in lei.
function cashValutaPdf(res, company, reg) {
  const doc = newDoc(true); // landscape (multe coloane)
  header(doc, company, 'Registru de casa in valuta (5314)', (reg.moneda || '') + (reg.period ? ' - ' + periodLabel(reg.period) : ''));
  doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('Sold initial in lei: ' + fmt(reg.siLei) + ' lei');
  doc.moveDown(0.3);
  const rows = reg.rows.map((r) => ({
    data: r.data, document: r.document, explicatie: clean(r.explicatie).slice(0, 40), moneda: r.moneda, curs: r.curs ? fmt(r.curs) : '',
    incVal: r.incasareVal ? fmt(r.incasareVal) : '', platVal: r.plataVal ? fmt(r.plataVal) : '',
    incLei: r.incasareLei ? fmt(r.incasareLei) : '', platLei: r.plataLei ? fmt(r.plataLei) : '',
    soldVal: fmt(r.soldVal), soldLei: fmt(r.soldLei),
  }));
  rows.push({ data: '', document: '', explicatie: 'TOTAL / SOLD FINAL', moneda: reg.moneda, curs: '',
    incVal: fmt(reg.rdVal), platVal: fmt(reg.rcVal), incLei: fmt(reg.rdLei), platLei: fmt(reg.rcLei),
    soldVal: fmt(reg.soldFinalVal), soldLei: fmt(reg.soldFinalLei), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Data', key: 'data', width: 60 },
    { label: 'Document', key: 'document', width: 70 },
    { label: 'Explicatie', key: 'explicatie', width: 150, wrap: true },
    { label: 'Mon.', key: 'moneda', width: 40 },
    { label: 'Curs', key: 'curs', width: 55, align: 'right' },
    { label: 'Incasari val.', key: 'incVal', width: 70, align: 'right' },
    { label: 'Plati val.', key: 'platVal', width: 65, align: 'right' },
    { label: 'Sold val.', key: 'soldVal', width: 70, align: 'right' },
    { label: 'Incasari lei', key: 'incLei', width: 70, align: 'right' },
    { label: 'Plati lei', key: 'platLei', width: 65, align: 'right' },
    { label: 'Sold lei', key: 'soldLei', width: 70, align: 'right' },
  ], rows);
  finish(doc, res, 'registru-casa-valuta.pdf');
}

// Set complet de situatii financiare anuale intr-un singur PDF: F20 + F10 + Note explicative.

/** Registrul-jurnal de incasari si plati (partida simpla, PFA — OMFP 170/2015). */
function registruIncasariPlatiPdf(res, company, r) {
  const doc = newDoc(true);
  const CAT = { fiscal: 'activitate', intern: 'virament intern', neutru: 'neutru (aport/credit)', taxe: 'taxe (nedeductibil)' };
  header(doc, company, 'Registrul-jurnal de incasari si plati',
    (r.period ? (String(r.period).length === 4 ? 'Anul ' + r.period : periodLabel(r.period)) : 'Toate perioadele') + '  •  partida simpla (PFA)');
  const rows = r.rows.map((x) => ({
    nr: String(x.nr), data: fmtDate(x.data), document: x.document, explicatie: x.explicatie, cat: CAT[x.cat] || x.cat,
    incN: x.incNumerar ? fmt(x.incNumerar) : '', incB: x.incBanca ? fmt(x.incBanca) : '',
    plN: x.platiNumerar ? fmt(x.platiNumerar) : '', plB: x.platiBanca ? fmt(x.platiBanca) : '',
  }));
  rows.push({ nr: '', data: '', document: '', explicatie: 'TOTALURI', cat: '', incN: fmt(r.tot.incNumerar), incB: fmt(r.tot.incBanca), plN: fmt(r.tot.platiNumerar), plB: fmt(r.tot.platiBanca), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Nr', key: 'nr', width: 28 },
    { label: 'Data', key: 'data', width: 52 },
    { label: 'Document', key: 'document', width: 70 },
    { label: 'Explicatie', key: 'explicatie', width: 200, wrap: true },
    { label: 'Fel operatiune', key: 'cat', width: 78 },
    { label: 'Incasari numerar', key: 'incN', width: 68, align: 'right' },
    { label: 'Incasari banca', key: 'incB', width: 68, align: 'right' },
    { label: 'Plati numerar', key: 'plN', width: 68, align: 'right' },
    { label: 'Plati banca', key: 'plB', width: 68, align: 'right' },
  ], rows);
  doc.moveDown(0.5);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10)
    .text('Incasari din activitate: ' + fmt(r.tot.incFiscale) + ' lei   •   Plati deductibile: ' + fmt(r.tot.platiFiscale)
      + ' lei   •   VENIT NET PE INCASARI: ' + fmt(r.venitNetIncasat) + ' lei', doc.page.margins.left, doc.y);
  doc.fillColor(C.muted).font('Helvetica').fontSize(8.5)
    .text('Viramentele interne, aporturile/retragerile intreprinzatorului si creditele nu sunt venituri/cheltuieli; platile de TVA si impozit pe venit ('
      + fmt(r.tot.taxePlatite) + ' lei) nu sunt deductibile. Clasificarea e orientativa — verifica pozitiile atipice cu contabilul.', doc.page.margins.left, doc.y + 4);
  finish(doc, res, 'registru-incasari-plati.pdf');
}

/** Fisa de cont: miscarile unui cont cu contul corespondent si soldul curent. */

function registruInventarPdf(res, company, ri) {
  const doc = newDoc(false);
  header(doc, company, 'Registrul-inventar (solduri finale)', ri.asOf ? 'La data de ' + periodLabel(ri.asOf) : 'Cumulat');
  const rows = ri.rows.map((r) => ({ cod: r.cod, nume: r.nume, sfD: r.sfD ? fmt(r.sfD) : '', sfC: r.sfC ? fmt(r.sfC) : '' }));
  rows.push({ cod: '', nume: 'TOTAL', sfD: fmt(ri.tot.sfD), sfC: fmt(ri.tot.sfC), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Cont', key: 'cod', width: 55 },
    { label: 'Denumire', key: 'nume', width: 305, wrap: true },
    { label: 'Sold D', key: 'sfD', width: 70, align: 'right' },
    { label: 'Sold C', key: 'sfC', width: 70, align: 'right' },
  ], rows);
  finish(doc, res, 'registru-inventar.pdf');
}

function registruFiscalPdf(res, company, rf) {
  const pctTxt = (c) => c.pct < 100 ? ' (' + c.pct + '% din ' + fmt(c.baza) + ')' : '';
  const rows = [
    { k: 'Rezultatul contabil (brut)', v: fmt(rf.rezultatContabil), _bold: true },
  ];
  rf.cheltNeded.forEach((c) => rows.push({ k: '+ ' + c.cod + ' ' + c.nume + pctTxt(c), v: fmt(c.suma) }));
  rows.push({ k: '+ Total cheltuieli nedeductibile', v: fmt(rf.totalNeded), _bold: true });
  // Randurile CU PLAFON: se arata baza si partea deductibila, altfel nedeductibilul pare arbitrar
  // si revizorul nu poate reface calculul din document.
  (rf.ajustariPlafon || []).forEach((a) => rows.push({
    k: '+ ' + a.regula + ' (' + a.temei + ' — cheltuit ' + fmt(a.cheltuit) + ', deductibil ' + fmt(a.plafon) + ')',
    v: fmt(a.nedeductibil),
  }));
  if ((rf.ajustariPlafon || []).length) rows.push({ k: '+ Total depasiri de plafon', v: fmt(rf.totalPlafoane), _bold: true });
  (rf.venituriList || []).forEach((c) => rows.push({ k: '- ' + c.cod + ' ' + c.nume + pctTxt(c), v: fmt(c.suma) }));
  rows.push({ k: '- Total venituri neimpozabile', v: fmt(rf.venituriNeimpozabile), _bold: true });
  rows.push({ k: '= REZULTATUL FISCAL', v: fmt(rf.rezultatFiscal), _bold: true, _fill: C.zebra });
  rows.push({ k: 'Impozit pe profit ' + rf.rateProfit + '%', v: fmt(rf.impozitProfit), _bold: true, _accent: true, _fill: C.zebra });
  rows.push({ k: '(comparativ) Impozit micro 1% din venituri', v: fmt(rf.impozitMicro) });
  const note = 'Trecerea de la rezultatul contabil la cel fiscal (art. 25-28 Cod fiscal). '
    + (rf.mentiuni && rf.mentiuni.length ? rf.mentiuni.join(' ') + ' ' : '')
    + 'Deductibilitatile sunt orientative; verificati conditiile concrete cu un contabil autorizat.';
  recapPdf(res, company, {
    title: 'Registrul de evidenta fiscala', subtitle: 'Exercitiul ' + rf.year,
    filename: 'registru-fiscal.pdf', rows, note,
  });
}

function analyticPdf(res, company, sections) {
  const doc = newDoc(true);
  header(doc, company, 'Balanta analitica pe partener', 'Conturi de terti');
  for (const s of sections) {
    if (doc.y > doc.page.height - 150) doc.addPage();
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text(clean(s.synth + ' — ' + s.nume), doc.page.margins.left, doc.y + 6);
    doc.moveDown(0.2);
    const rows = s.rows.map((r) => ({
      analitic: r.analitic, den: r.den + (r.cui ? ' (' + r.cui + ')' : ''),
      siD: r.siD ? fmt(r.siD) : '', siC: r.siC ? fmt(r.siC) : '', rd: fmt(r.rd), rc: fmt(r.rc),
      sfD: r.sfD ? fmt(r.sfD) : '', sfC: r.sfC ? fmt(r.sfC) : '',
    }));
    rows.push({
      analitic: '', den: 'TOTAL ' + s.synth, siD: fmt(s.totalSiD), siC: fmt(s.totalSiC),
      rd: fmt(s.totalRd), rc: fmt(s.totalRc), sfD: fmt(s.totalSfD), sfC: fmt(s.totalSfC), _bold: true, _fill: C.zebra,
    });
    table(doc, [
      { label: 'Analitic', key: 'analitic', width: 58 },
      { label: 'Partener', key: 'den', width: 175, wrap: true },
      { label: 'SI D', key: 'siD', width: 60, align: 'right' },
      { label: 'SI C', key: 'siC', width: 60, align: 'right' },
      { label: 'Rulaj D', key: 'rd', width: 62, align: 'right' },
      { label: 'Rulaj C', key: 'rc', width: 62, align: 'right' },
      { label: 'SF D', key: 'sfD', width: 60, align: 'right' },
      { label: 'SF C', key: 'sfC', width: 60, align: 'right' },
    ], rows);
    if (!s.concorda) {
      doc.fillColor(C.danger).font('Helvetica').fontSize(8).text('Atentie: suma soldurilor analitice nu concorda cu soldul sintetic initial.');
    }
    doc.moveDown(0.4);
  }
  finish(doc, res, 'balanta-analitica.pdf');
}

function agingPdf(res, company, a) {
  const doc = newDoc(true);
  header(doc, company, 'Vechimea soldurilor (aging)', 'Scadentar clienti / furnizori la ' + (a.asOf || ''));
  const block = (titlu, list, tot, lbl) => {
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(11).text(clean(titlu), doc.page.margins.left, doc.y + 6);
    doc.moveDown(0.2);
    const rows = list.map((x) => ({ partener: x.partener + (x.cui ? ' (' + x.cui + ')' : ''), total: fmt(x.total), b1: fmt(x.b0_30), b2: fmt(x.b31_60), b3: fmt(x.b61_90), b4: fmt(x.b90plus) }));
    rows.push({ partener: 'TOTAL ' + lbl, total: fmt(tot.total), b1: fmt(tot.b0_30), b2: fmt(tot.b31_60), b3: fmt(tot.b61_90), b4: fmt(tot.b90plus), _bold: true, _fill: C.zebra });
    table(doc, [
      { label: 'Partener', key: 'partener', width: 280, wrap: true },
      { label: 'Total', key: 'total', width: 90, align: 'right' },
      { label: '0-30 zile', key: 'b1', width: 80, align: 'right' },
      { label: '31-60 zile', key: 'b2', width: 80, align: 'right' },
      { label: '61-90 zile', key: 'b3', width: 80, align: 'right' },
      { label: 'peste 90 zile', key: 'b4', width: 90, align: 'right' },
    ], rows);
    doc.moveDown(0.6);
  };
  block('Creante (clienti / debitori) — de incasat', a.clienti, a.totalClienti, 'creante');
  block('Datorii (furnizori / creditori) — de platit', a.furnizori, a.totalFurnizori, 'datorii');
  doc.fillColor(C.muted).font('Helvetica').fontSize(8).text('Vechimea se determina prin stingerea FIFO a facturilor cu incasarile/platile (facturile cele mai vechi se sting primele).');
  finish(doc, res, 'aging.pdf');
}

/** Situatia aprovizionarilor: receptiile perioadei, cu recapitulatie pe furnizor. */
function aprovizionariPdf(res, company, s) {
  const doc = newDoc(true);
  header(doc, company, 'Situatia aprovizionarilor', s.period ? periodLabel(s.period) : 'toate perioadele');
  const rows = s.rows.map((r) => ({
    data: fmtDate(r.data), furnizor: r.furnizor, document: r.document, produs: r.cod + ' ' + r.denumire,
    gest: r.gestiune, cant: fmt(r.cantitate) + ' ' + r.um, pret: fmt(r.pretUnitar), val: fmt(r.valoare),
  }));
  rows.push({ data: '', furnizor: '', document: '', produs: 'TOTAL APROVIZIONARI', gest: '', cant: '', pret: '', val: fmt(s.total), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Data', key: 'data', width: 55 },
    { label: 'Furnizor', key: 'furnizor', width: 110, wrap: true },
    { label: 'Document', key: 'document', width: 80 },
    { label: 'Produs', key: 'produs', width: 170, wrap: true },
    { label: 'Gestiune', key: 'gest', width: 55 },
    { label: 'Cantitate', key: 'cant', width: 70, align: 'right' },
    { label: 'Pret unitar', key: 'pret', width: 65, align: 'right' },
    { label: 'Valoare', key: 'val', width: 75, align: 'right' },
  ], rows);
  const furn = Object.keys(s.perFurnizor).sort();
  if (furn.length > 1) {
    doc.moveDown(0.6);
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(10).text('Recapitulatie pe furnizori', doc.page.margins.left, doc.y);
    doc.moveDown(0.2);
    table(doc, [
      { label: 'Furnizor', key: 'f', width: 300 },
      { label: 'Valoare', key: 'v', width: 100, align: 'right' },
    ], furn.map((f) => ({ f: clean(f), v: fmt(s.perFurnizor[f]) })));
  }
  finish(doc, res, 'situatie-aprovizionari.pdf');
}

/** Situatia consumurilor: iesirile din gestiune la CMP, cu totaluri pe contul de descarcare. */

/** Situatia consumurilor: iesirile din gestiune la CMP, cu totaluri pe contul de descarcare. */
function consumuriPdf(res, company, s) {
  const doc = newDoc(true);
  header(doc, company, 'Situatia consumurilor si iesirilor din gestiune', s.period ? periodLabel(s.period) : 'toate perioadele');
  const rows = s.rows.map((r) => ({
    data: fmtDate(r.data), document: r.document, produs: r.cod + ' ' + r.denumire, gest: r.gestiune,
    cant: fmt(r.cantitate) + ' ' + r.um, cont: r.cont, sursa: r.sursa, val: fmt(r.valoare),
  }));
  rows.push({ data: '', document: '', produs: 'TOTAL IESIRI (la CMP)', gest: '', cant: '', cont: '', sursa: '', val: fmt(s.total), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Data', key: 'data', width: 55 },
    { label: 'Document', key: 'document', width: 90 },
    { label: 'Produs', key: 'produs', width: 180, wrap: true },
    { label: 'Gestiune', key: 'gest', width: 55 },
    { label: 'Cantitate', key: 'cant', width: 70, align: 'right' },
    { label: 'Cont desc.', key: 'cont', width: 55 },
    { label: 'Sursa', key: 'sursa', width: 55 },
    { label: 'Valoare', key: 'val', width: 75, align: 'right' },
  ], rows);
  const conturi = Object.keys(s.perCont).sort();
  if (conturi.length) {
    doc.moveDown(0.6);
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(10).text('Recapitulatie pe conturi de descarcare', doc.page.margins.left, doc.y);
    doc.moveDown(0.2);
    table(doc, [
      { label: 'Cont', key: 'c', width: 80 },
      { label: 'Valoare', key: 'v', width: 100, align: 'right' },
    ], conturi.map((c) => ({ c, v: fmt(s.perCont[c]) })));
  }
  finish(doc, res, 'situatie-consumuri.pdf');
}

function docRegisterPdf(res, company, list) {
  const doc = newDoc(true);
  header(doc, company, 'Registrul documentelor de stoc emise', 'NIR / bon de consum / aviz');
  const rows = list.map((r) => ({
    tip: r.tip, nr: r.serieNr, data: fmtDate(r.data), gest: r.gestiune, ref: r.document, linii: String(r.nrLinii), val: fmt(r.valoare), op: r.operator,
  }));
  const tot = list.reduce((s, r) => s + r.valoare, 0);
  rows.push({ tip: '', nr: '', data: '', gest: '', ref: 'TOTAL', linii: '', val: fmt(round2(tot)), op: '', _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Tip document', key: 'tip', width: 120 },
    { label: 'Serie/Nr', key: 'nr', width: 110 },
    { label: 'Data', key: 'data', width: 70, align: 'center' },
    { label: 'Gestiune', key: 'gest', width: 70 },
    { label: 'Referinta', key: 'ref', width: 110 },
    { label: 'Linii', key: 'linii', width: 44, align: 'right' },
    { label: 'Valoare', key: 'val', width: 84, align: 'right' },
    { label: 'Operator', key: 'op', width: 90 },
  ], rows);
  finish(doc, res, 'registru-documente-stoc.pdf');
}


module.exports = { journalPdf, ledgerPdf, trialBalancePdf, fisaContPdf, cashBookPdf, cashValutaPdf, registruIncasariPlatiPdf, registruInventarPdf, registruFiscalPdf, analyticPdf, agingPdf, aprovizionariPdf, consumuriPdf, docRegisterPdf };
