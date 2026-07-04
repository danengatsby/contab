'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { fmt, fmtDate, periodLabel, round2, sumaInLitere } = require('./util');

// Logo-ul firmei (optional): incarcat in Setari -> Date firma, stocat in uploads/.
// Rezolvarea cai se face aici ca sa nu depindem de server in restul functiilor.
function logoPath(company) {
  if (!company || !company.logoFile) return null;
  try {
    const safe = String(company.logoFile).replace(/[^a-zA-Z0-9._-]/g, '');
    if (!/\.(png|jpe?g)$/i.test(safe)) return null; // PDFKit accepta doar PNG/JPEG
    const p = path.join(require('./db').UPLOAD_DIR, safe);
    return fs.existsSync(p) ? p : null;
  } catch (e) { return null; }
}

/** Inlocuieste diacriticele si caracterele neacceptate de fonturile standard. */
function clean(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[ăâ]/g, 'a').replace(/[ĂÂ]/g, 'A')
    .replace(/[îí]/g, 'i').replace(/[ÎÍ]/g, 'I')
    .replace(/[șşśš]/g, 's').replace(/[ȘŞŚŠ]/g, 'S')
    .replace(/[țţ]/g, 't').replace(/[ȚŢ]/g, 'T')
    .replace(/[“”„]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-')
    // pastreaza doar caractere imprimabile Latin-1
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

const C = {
  ink: '#1a1a2e',
  muted: '#555',
  line: '#cfd3dc',
  head: '#2b3a67',
  headText: '#ffffff',
  zebra: '#f3f5fa',
  accent: '#0b6e4f',
  danger: '#b00020',
};

function newDoc(landscape) {
  return new PDFDocument({
    size: 'A4',
    layout: landscape ? 'landscape' : 'portrait',
    margins: { top: 48, bottom: 48, left: 40, right: 40 },
    bufferPages: true,
    info: { Title: 'Document contabil', Author: 'Contabo' },
  });
}

function header(doc, company, title, subtitle) {
  const left = doc.page.margins.left;
  if (company) doc._company = company; // pentru footer (subsol personalizat)
  const accent = (company && /^#[0-9a-fA-F]{6}$/.test(company.accentColor || '')) ? company.accentColor : C.accent;
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(15).text(clean(title), left, 40);
  if (subtitle) doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(clean(subtitle), left, doc.y + 1);
  doc.moveDown(0.2);
  const right = doc.page.width - doc.page.margins.right;
  doc.fillColor(C.muted).font('Helvetica').fontSize(9);
  let cy = 40;
  const lp = logoPath(company);
  if (lp) {
    try { doc.image(lp, right - 130, 34, { fit: [130, 38] }); cy = 78; } catch (e) { /* logo corupt -> fara logo */ }
  }
  doc.text(clean(company.nume || ''), left, cy, { width: right - left, align: 'right' });
  const meta = [company.cui ? 'CUI ' + company.cui : '', company.regCom || ''].filter(Boolean).join('  •  ');
  if (meta) doc.text(clean(meta), left, doc.y, { width: right - left, align: 'right' });
  const contact = [company.iban ? 'IBAN ' + company.iban : '', company.telefon || '', company.email || ''].filter(Boolean).join('  •  ');
  if (contact) doc.text(clean(contact), left, doc.y, { width: right - left, align: 'right' });
  doc.moveDown(0.6);
  doc.strokeColor(accent).lineWidth(1.6).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
  doc.moveDown(0.6);
  return doc.y;
}

/**
 * Tabel generic.
 * columns: [{ label, width, align, key }]
 * rows: [{ key: value, _bold, _accent, _fill }]
 */
function table(doc, columns, rows, startY) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const scale = (right - left) / totalW;
  columns.forEach((c) => { c._w = c.width * scale; });

  let y = startY != null ? startY : doc.y;
  const rowH = 16;
  const bottom = doc.page.height - doc.page.margins.bottom;

  function drawHead() {
    doc.rect(left, y, right - left, rowH + 2).fill(C.head);
    doc.fillColor(C.headText).font('Helvetica-Bold').fontSize(8.5);
    let x = left;
    for (const c of columns) {
      doc.text(clean(c.label), x + 4, y + 4, { width: c._w - 8, align: c.align || 'left', lineBreak: false });
      x += c._w;
    }
    y += rowH + 2;
  }

  drawHead();
  doc.font('Helvetica').fontSize(8.5);
  let zebra = false;
  for (const r of rows) {
    // estimeaza inaltimea (explicatii lungi pot ocupa 2 randuri)
    let h = rowH;
    for (const c of columns) {
      const txt = clean(r[c.key] != null ? r[c.key] : '');
      if (c.wrap && txt) {
        const hh = doc.heightOfString(txt, { width: c._w - 8 });
        h = Math.max(h, hh + 6);
      }
    }
    if (y + h > bottom) { doc.addPage(); y = doc.page.margins.top; drawHead(); doc.font('Helvetica').fontSize(8.5); }

    if (r._fill || zebra) doc.rect(left, y, right - left, h).fill(r._fill || C.zebra);
    doc.fillColor(r._accent ? C.accent : C.ink).font(r._bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    let x = left;
    for (const c of columns) {
      const val = r[c.key];
      const txt = clean(val != null ? val : '');
      doc.text(txt, x + 4, y + 4, { width: c._w - 8, align: c.align || 'left', lineBreak: !!c.wrap });
      x += c._w;
    }
    doc.strokeColor(C.line).lineWidth(0.5).moveTo(left, y + h).lineTo(right, y + h).stroke();
    y += h;
    zebra = !zebra;
  }
  doc.y = y + 6;
  return y;
}

function footer(doc) {
  const range = doc.bufferedPageRange();
  const note = (doc._company && doc._company.pdfFooter) ? clean(String(doc._company.pdfFooter)).slice(0, 200) : '';
  // intocmitorul (datele personale ale utilizatorului abonat) — pe fiecare pagina
  const who = (doc._company && doc._company._intocmit) ? clean('Intocmit: ' + String(doc._company._intocmit)).slice(0, 120) : '';
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const b = doc.page.margins.bottom;
    const w = doc.page.width;
    if (note) doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(note, 40, doc.page.height - b + 4, { width: w - 80, align: 'center', lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.5);
    if (who) doc.text(who, 40, doc.page.height - b + 4, { width: w - 260, align: 'left', lineBreak: false });
    doc.text('Generat de Contabo • cifre conform inregistrarilor din aplicatie',
      40, doc.page.height - b + 14, { align: 'left', lineBreak: false });
    doc.text('Pagina ' + (i + 1) + ' / ' + range.count,
      w - 140, doc.page.height - b + 14, { width: 100, align: 'right', lineBreak: false });
  }
}

function finish(doc, res, filename) {
  footer(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
  doc.pipe(res);
  doc.end();
}

// ───────────────────────────── RAPOARTE ─────────────────────────────

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
function recapPdf(res, company, opts) {
  const doc = newDoc(false);
  header(doc, company, opts.title, opts.subtitle);
  table(doc, [
    { label: opts.colName || 'Indicator', key: 'k', width: 330 },
    { label: opts.colVal || 'Suma (lei)', key: 'v', width: 150, align: 'right' },
  ], opts.rows);
  if (opts.note) {
    doc.moveDown(0.6);
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(clean(opts.note));
  }
  finish(doc, res, opts.filename || 'raport.pdf');
}

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

function registruFiscalPdf(res, company, rf) {
  const pctTxt = (c) => c.pct < 100 ? ' (' + c.pct + '% din ' + fmt(c.baza) + ')' : '';
  const rows = [
    { k: 'Rezultatul contabil (brut)', v: fmt(rf.rezultatContabil), _bold: true },
  ];
  rf.cheltNeded.forEach((c) => rows.push({ k: '+ ' + c.cod + ' ' + c.nume + pctTxt(c), v: fmt(c.suma) }));
  rows.push({ k: '+ Total cheltuieli nedeductibile', v: fmt(rf.totalNeded), _bold: true });
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
function invoiceData(entry, partners) {
  let baza = 0; let tva = 0;
  for (const l of entry.lines) {
    if (Number(String(l.credit)[0]) === 7) baza = round2(baza + l.suma);
    if (Number(String(l.debit)[0]) === 7) baza = round2(baza - l.suma);
    if (l.credit === '4427' || l.credit === '4428') tva = round2(tva + l.suma);
    if (l.debit === '4427' || l.debit === '4428') tva = round2(tva - l.suma);
  }
  const total = round2(baza + tva);
  const cui = String(entry.partenerCui || '').replace(/^ro/i, '');
  const cli = (partners && partners[cui]) || {};
  return { baza, tva, total, cui, cli };
}

/** Tabelul de articole al facturii (liniile detaliate sau un singur rand cu explicatia). */
function invoiceItemsTable(doc, entry, baza) {
  const items = (entry.items && entry.items.length) ? entry.items : null;
  if (items) {
    table(doc, [
      { label: 'Nr', key: 'nr', width: 28 },
      { label: 'Denumire', key: 'nume', width: 197, wrap: true },
      { label: 'Cant.', key: 'cant', width: 50, align: 'right' },
      { label: 'UM', key: 'um', width: 40 },
      { label: 'Pret', key: 'pret', width: 65, align: 'right' },
      { label: 'Cota', key: 'cota', width: 45, align: 'right' },
      { label: 'Valoare', key: 'val', width: 75, align: 'right' },
    ], items.map((it, i) => ({ nr: String(i + 1), nume: clean(it.nume), cant: fmt(it.cantitate), um: it.um || 'buc', pret: fmt(it.pret), cota: (it.cota || 0) + '%', val: fmt(round2(it.cantitate * it.pret)) })));
  } else {
    table(doc, [
      { label: 'Denumire', key: 'nume', width: 360, wrap: true },
      { label: 'Valoare', key: 'val', width: 140, align: 'right' },
    ], [{ nume: clean(entry.explicatie || entry.tipNume || 'Produse / servicii'), val: fmt(baza) }]);
  }
  return items;
}

/** Factura PDF — model selectabil per firma (Setari -> Datele firmei) sau per tiparire (?layout=):
 *  clasic (implicit), compact (A5, pentru facturi simple) si detaliat (blocuri furnizor/cumparator,
 *  recapitulatie TVA pe cote, suma in litere, semnaturi). */
function facturaPdf(res, company, entry, partners, layout) {
  const cerut = layout || (company && company.pdfLayout) || 'clasic';
  const model = ['clasic', 'compact', 'detaliat'].includes(cerut) ? cerut : 'clasic';
  const d = invoiceData(entry, partners);
  if (model === 'compact') return facturaCompactPdf(res, company, entry, d);
  if (model === 'detaliat') return facturaDetaliatPdf(res, company, entry, d);
  // ── model clasic ──
  const doc = newDoc(false);
  header(doc, company, 'FACTURA', (entry.document ? 'Nr. ' + entry.document + '    ' : '') + 'Data: ' + fmtDate(entry.data));
  doc.moveDown(0.4);
  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(10).text('Cumparator');
  doc.fillColor(C.ink).font('Helvetica').fontSize(10);
  doc.text(clean(d.cli.den || entry.partener || '-'));
  if (d.cui) doc.text('CUI: ' + d.cui);
  const adr = [d.cli.adresa, d.cli.oras, d.cli.judet].filter(Boolean).join(', ');
  if (adr) doc.text(clean(adr));
  doc.moveDown(0.6);
  invoiceItemsTable(doc, entry, d.baza);
  doc.moveDown(0.6);
  const rt = (label, val, bold) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? C.accent : C.ink).text(label + ':  ' + fmt(val) + ' lei', { align: 'right' }); };
  rt('Valoare fara TVA', d.baza);
  rt('TVA', d.tva);
  rt('TOTAL DE PLATA', d.total, true);
  finish(doc, res, 'factura-' + clean(String(entry.document || entry.id)) + '.pdf');
}

/** Model COMPACT: A5, antet minim, articole condensate — pentru facturi simple / bonuri. */
function facturaCompactPdf(res, company, entry, d) {
  const doc = new PDFDocument({
    size: 'A5', layout: 'portrait',
    margins: { top: 26, bottom: 34, left: 26, right: 26 },
    bufferPages: true, info: { Title: 'Factura', Author: 'Contabo' },
  });
  doc._company = company;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const accent = (company && /^#[0-9a-fA-F]{6}$/.test(company.accentColor || '')) ? company.accentColor : C.accent;
  const lp = logoPath(company);
  if (lp) { try { doc.image(lp, right - 80, 22, { fit: [80, 26] }); } catch (e) { /* logo corupt */ } }
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(13).text('FACTURA ' + clean(entry.document || ''), left, 24);
  doc.fillColor(C.muted).font('Helvetica').fontSize(8).text('Data: ' + fmtDate(entry.data), left, doc.y + 1);
  doc.moveDown(0.4);
  doc.strokeColor(accent).lineWidth(1.2).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
  doc.moveDown(0.4);
  doc.fontSize(8).fillColor(C.ink);
  doc.font('Helvetica-Bold').text('Furnizor: ', left, doc.y, { continued: true }).font('Helvetica')
    .text(clean(company.nume || '') + (company.cui ? ' • CUI ' + clean(company.cui) : ''));
  doc.font('Helvetica-Bold').text('Cumparator: ', { continued: true }).font('Helvetica')
    .text(clean(d.cli.den || entry.partener || '-') + (d.cui ? ' • CUI ' + d.cui : ''));
  doc.moveDown(0.5);
  const items = (entry.items && entry.items.length) ? entry.items : null;
  if (items) {
    table(doc, [
      { label: 'Denumire', key: 'nume', width: 150, wrap: true },
      { label: 'Cant.', key: 'cant', width: 40, align: 'right' },
      { label: 'Pret', key: 'pret', width: 50, align: 'right' },
      { label: 'Valoare', key: 'val', width: 55, align: 'right' },
    ], items.map((it) => ({ nume: clean(it.nume), cant: fmt(it.cantitate), pret: fmt(it.pret), val: fmt(round2(it.cantitate * it.pret)) })));
  } else {
    table(doc, [
      { label: 'Denumire', key: 'nume', width: 220, wrap: true },
      { label: 'Valoare', key: 'val', width: 75, align: 'right' },
    ], [{ nume: clean(entry.explicatie || entry.tipNume || 'Produse / servicii'), val: fmt(d.baza) }]);
  }
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(9).fillColor(C.ink).text('Valoare: ' + fmt(d.baza) + ' lei   •   TVA: ' + fmt(d.tva) + ' lei', left, doc.y, { width: right - left, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(accent).text('TOTAL: ' + fmt(d.total) + ' lei', left, doc.y + 2, { width: right - left, align: 'right' });
  finish(doc, res, 'factura-' + clean(String(entry.document || entry.id)) + '.pdf');
}

/** Model DETALIAT: blocuri furnizor/cumparator complete, recapitulatie TVA pe cote,
 *  suma in litere si zone de semnaturi. */
function facturaDetaliatPdf(res, company, entry, d) {
  const doc = newDoc(false);
  header(doc, company, 'FACTURA', (entry.document ? 'Seria/Nr. ' + entry.document + '    ' : '') + 'Data: ' + fmtDate(entry.data));
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const colW = (right - left - 20) / 2;
  const y0 = doc.y + 4;
  const bloc = (x, titlu, rows) => {
    doc.fillColor(C.head).font('Helvetica-Bold').fontSize(10).text(titlu, x, y0);
    doc.fillColor(C.ink).font('Helvetica').fontSize(9);
    let yy = doc.y + 2;
    for (const r of rows.filter(Boolean)) { doc.text(clean(r), x, yy, { width: colW }); yy = doc.y; }
    return yy;
  };
  const yF = bloc(left, 'Furnizor', [
    company.nume,
    company.cui ? 'CUI: ' + company.cui : '',
    company.regCom ? 'Reg. Com.: ' + company.regCom : '',
    [company.adresa, company.oras, company.judet].filter(Boolean).join(', '),
    company.iban ? 'IBAN: ' + company.iban + (company.banca ? ' (' + company.banca + ')' : '') : '',
    [company.telefon, company.email].filter(Boolean).join(' • '),
  ]);
  const yC = bloc(left + colW + 20, 'Cumparator', [
    d.cli.den || entry.partener || '-',
    d.cui ? 'CUI: ' + d.cui : '',
    [d.cli.adresa, d.cli.oras, d.cli.judet].filter(Boolean).join(', '),
    d.cli.tara && d.cli.tara !== 'RO' ? 'Tara: ' + d.cli.tara : '',
  ]);
  doc.y = Math.max(yF, yC) + 10;
  doc.x = left;
  const items = invoiceItemsTable(doc, entry, d.baza);
  // recapitulatie TVA pe cote (din liniile detaliate sau cota dedusa din totaluri)
  const cote = {};
  if (items) {
    for (const it of items) {
      const b = round2(it.cantitate * it.pret); const k = it.cota || 0;
      cote[k] = cote[k] || { baza: 0, tva: 0 };
      cote[k].baza = round2(cote[k].baza + b);
      cote[k].tva = round2(cote[k].tva + round2((b * (it.cota || 0)) / 100));
    }
  } else {
    const cota = d.baza > 0 ? Math.round((d.tva / d.baza) * 100) : 0;
    cote[cota] = { baza: d.baza, tva: d.tva };
  }
  doc.moveDown(0.5);
  doc.fillColor(C.head).font('Helvetica-Bold').fontSize(10).text('Recapitulatie TVA', left, doc.y);
  doc.moveDown(0.2);
  table(doc, [
    { label: 'Cota TVA', key: 'cota', width: 80 },
    { label: 'Baza', key: 'baza', width: 110, align: 'right' },
    { label: 'TVA', key: 'tva', width: 110, align: 'right' },
  ], Object.keys(cote).sort((a, b) => b - a).map((k) => ({ cota: k + '%', baza: fmt(cote[k].baza), tva: fmt(cote[k].tva) })));
  doc.moveDown(0.5);
  const rt = (label, val, bold) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? C.accent : C.ink).text(label + ':  ' + fmt(val) + ' lei', left, doc.y, { width: right - left, align: 'right' }); };
  rt('Valoare fara TVA', d.baza);
  rt('TVA', d.tva);
  rt('TOTAL DE PLATA', d.total, true);
  doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('adica (in litere): ' + sumaInLitere(d.total), left, doc.y + 2, { width: right - left, align: 'right' });
  doc.moveDown(1.4);
  const ys = doc.y;
  doc.fillColor(C.muted).font('Helvetica').fontSize(9);
  doc.text('Semnatura si stampila furnizorului', left, ys);
  doc.text('___________________________', left, ys + 26);
  doc.text('Semnatura de primire', left + colW + 20, ys);
  doc.text('___________________________', left + colW + 20, ys + 26);
  finish(doc, res, 'factura-' + clean(String(entry.document || entry.id)) + '.pdf');
}

/** Chitanta pentru o incasare in numerar (531x), cu suma in litere si numar din seria CH. */
function chitantaPdf(res, company, entry, suma, nr) {
  const doc = newDoc(false);
  header(doc, company, 'CHITANTA', 'Seria/Nr. ' + (nr || entry.chitantaNr || '-') + '    Data: ' + fmtDate(entry.data));
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.y + 10;
  let y = top + 18;
  const row = (label, value, bold) => {
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(label, left + 18, y);
    doc.fillColor(C.ink).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 13 : 11)
      .text(clean(value), left + 18, doc.y + 2, { width: right - left - 36 });
    y = doc.y + 12;
  };
  row('Am primit de la', entry.partener || '-');
  if (entry.partenerCui) row('CUI / CNP', entry.partenerCui);
  row('Suma de', fmt(suma) + ' lei — adica ' + sumaInLitere(suma), true);
  row('Reprezentand', entry.explicatie || entry.tipNume || (entry.document ? 'c/v ' + entry.document : 'contravaloare produse / servicii'));
  doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('Casier,', right - 170, y + 6);
  doc.text('(semnatura si stampila)', right - 170, y + 34);
  const boxH = (y + 56) - top;
  doc.roundedRect(left, top, right - left, boxH, 8).lineWidth(1.2).strokeColor(C.head).stroke();
  doc.y = top + boxH + 14;
  doc.fillColor(C.muted).font('Helvetica').fontSize(8)
    .text('Chitanta insoteste inregistrarea contabila ' + clean(String(entry.id)) + ' (' + clean(entry.tipNume || '') + ') din registrul de casa.', left, doc.y);
  finish(doc, res, 'chitanta-' + clean(String(nr || entry.chitantaNr || entry.id)) + '.pdf');
}

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
function roman(n) { return ['', 'I', 'II', 'III', 'IV', 'V', 'VI'][n] || String(n); }

function notePdf(res, company, entry) {
  const doc = newDoc(false);
  header(doc, company, 'Nota contabila', (entry.nrJurnal ? 'Nr. ' + entry.nrJurnal + ' din registrul-jurnal · ' : '') + (entry.tipNume || ''));
  doc.fillColor(C.ink).font('Helvetica').fontSize(10);
  if (entry.nrJurnal) doc.text('Nr. inregistrare (registrul-jurnal): ' + entry.nrJurnal);
  doc.text('Data: ' + fmtDate(entry.data));
  if (entry.document) doc.text('Document: ' + clean(entry.document));
  if (entry.partener) doc.text('Partener: ' + clean(entry.partener));
  if (entry.explicatie) doc.text('Explicatie: ' + clean(entry.explicatie));
  doc.moveDown(0.5);
  const rows = entry.lines.map((l) => ({
    debit: l.debit, credit: l.credit, explicatie: l.explicatie, suma: fmt(l.suma),
  }));
  const total = entry.lines.reduce((s, l) => s + l.suma, 0);
  rows.push({ debit: '', credit: '', explicatie: 'TOTAL', suma: fmt(total), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Cont debitor', key: 'debit', width: 80, align: 'center' },
    { label: 'Cont creditor', key: 'credit', width: 80, align: 'center' },
    { label: 'Explicatie', key: 'explicatie', width: 250, wrap: true },
    { label: 'Suma (lei)', key: 'suma', width: 90, align: 'right' },
  ], rows);
  finish(doc, res, 'nota-contabila.pdf');
}

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

function stocksPdf(res, company, stock, asOf) {
  const doc = newDoc(false);
  header(doc, company, 'Situatia stocurilor', 'La ' + (asOf || ''));
  const rows = stock.map((s) => ({
    gest: (s.gestiune && s.gestiune.cod) || '', cod: s.product.cod, den: s.product.denumire, cont: s.product.cont || '371', um: s.product.um || 'buc',
    q: fmt(s.stocQ), cmp: fmt(s.cmp), val: fmt(s.stocV),
  }));
  const totV = stock.reduce((t, s) => t + s.stocV, 0);
  rows.push({ gest: '', cod: '', den: 'TOTAL VALOARE STOC', cont: '', um: '', q: '', cmp: '', val: fmt(round2(totV)), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Gestiune', key: 'gest', width: 64 },
    { label: 'Cod', key: 'cod', width: 80 },
    { label: 'Denumire', key: 'den', width: 150, wrap: true },
    { label: 'Cont', key: 'cont', width: 46, align: 'center' },
    { label: 'UM', key: 'um', width: 40, align: 'center' },
    { label: 'Cantitate', key: 'q', width: 66, align: 'right' },
    { label: 'CMP', key: 'cmp', width: 66, align: 'right' },
    { label: 'Valoare', key: 'val', width: 78, align: 'right' },
  ], rows);
  finish(doc, res, 'situatia-stocurilor.pdf');
}

function stockLedgerPdf(res, company, ledger) {
  const doc = newDoc(true);
  header(doc, company, 'Fisa de magazie', ledger.product.cod + ' - ' + ledger.product.denumire + ' (' + (ledger.product.um || 'buc') + ')');
  const rows = ledger.rows.map((r) => ({
    data: fmtDate(r.data), tip: r.tip, doc: r.document,
    intrareQ: r.intrareQ || '', intrareV: r.intrareV ? fmt(r.intrareV) : '',
    iesireQ: r.iesireQ || '', iesireV: r.iesireV ? fmt(r.iesireV) : '',
    stocQ: r.stocQ, cmp: fmt(r.cmp), stocV: fmt(r.stocV),
  }));
  rows.push({ data: '', tip: 'STOC FINAL', doc: '', intrareQ: '', intrareV: '', iesireQ: '', iesireV: '', stocQ: ledger.stocQ, cmp: fmt(ledger.cmp), stocV: fmt(ledger.stocV), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Data', key: 'data', width: 66, align: 'center' },
    { label: 'Tip', key: 'tip', width: 70 },
    { label: 'Document', key: 'doc', width: 90 },
    { label: 'Intrare Q', key: 'intrareQ', width: 64, align: 'right' },
    { label: 'Intrare val.', key: 'intrareV', width: 76, align: 'right' },
    { label: 'Iesire Q', key: 'iesireQ', width: 64, align: 'right' },
    { label: 'Iesire val.', key: 'iesireV', width: 76, align: 'right' },
    { label: 'Stoc Q', key: 'stocQ', width: 60, align: 'right' },
    { label: 'CMP', key: 'cmp', width: 66, align: 'right' },
    { label: 'Stoc val.', key: 'stocV', width: 80, align: 'right' },
  ], rows);
  finish(doc, res, 'fisa-magazie-' + ledger.product.cod + '.pdf');
}

function inventoryListPdf(res, company, data) {
  const doc = newDoc(true);
  header(doc, company, 'Lista de inventariere', (data.gestiune || '') + ' — la ' + (data.asOf || ''));
  const rows = data.lines.map((l, i) => ({
    nr: String(i + 1), cod: l.product.cod, den: l.product.denumire, um: l.product.um || 'buc',
    scrQ: fmt(l.scripticQty), cmp: fmt(l.cmp), scrV: fmt(l.scripticVal),
    fapt: '', dif: '',
  }));
  const totV = data.lines.reduce((t, l) => t + l.scripticVal, 0);
  rows.push({ nr: '', cod: '', den: 'TOTAL VALOARE SCRIPTICA', um: '', scrQ: '', cmp: '', scrV: fmt(round2(totV)), fapt: '', dif: '', _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Nr', key: 'nr', width: 32, align: 'center' },
    { label: 'Cod', key: 'cod', width: 90 },
    { label: 'Denumire', key: 'den', width: 170, wrap: true },
    { label: 'UM', key: 'um', width: 40, align: 'center' },
    { label: 'Stoc scriptic', key: 'scrQ', width: 78, align: 'right' },
    { label: 'CMP', key: 'cmp', width: 64, align: 'right' },
    { label: 'Valoare scriptica', key: 'scrV', width: 90, align: 'right' },
    { label: 'Stoc faptic', key: 'fapt', width: 78, align: 'right' },
    { label: 'Diferenta', key: 'dif', width: 70, align: 'right' },
  ], rows);
  doc.moveDown(1);
  doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('Comisia de inventariere: ____________________    Gestionar: ____________________    Data: ____________');
  finish(doc, res, 'lista-inventariere.pdf');
}

function inventoryPvPdf(res, company, iv) {
  const doc = newDoc(true);
  header(doc, company, 'Proces-verbal de inventariere', iv.gestiuneCod + ' ' + iv.gestiuneDen + ' — la ' + iv.data);
  if (iv.status === 'stornat') {
    doc.fillColor(C.danger).font('Helvetica-Bold').fontSize(13).text('STORNAT la ' + (iv.stornoData || '') + (iv.stornoOperator ? ' de ' + clean(iv.stornoOperator) : ''), { align: 'right' });
    doc.moveDown(0.2);
  }
  const rows = iv.lines.map((l, i) => ({
    nr: String(i + 1), cod: l.cod, den: l.denumire, um: l.um,
    scr: fmt(l.scriptic), fapt: fmt(l.faptic),
    dif: (l.diff > 0 ? '+' : '') + fmt(l.diff),
    cmp: fmt(l.cmp),
    val: l.tip === 'ok' ? '' : (l.diff > 0 ? '+' : '-') + fmt(l.valoare),
    obs: l.tip === 'plus' ? 'plus (371=758)' : l.tip === 'minus' ? (l.imputat ? 'lipsa imputata' : 'lipsa (60x=371)') : 'OK',
  }));
  table(doc, [
    { label: 'Nr', key: 'nr', width: 30, align: 'center' },
    { label: 'Cod', key: 'cod', width: 84 },
    { label: 'Denumire', key: 'den', width: 150, wrap: true },
    { label: 'UM', key: 'um', width: 38, align: 'center' },
    { label: 'Scriptic', key: 'scr', width: 64, align: 'right' },
    { label: 'Faptic', key: 'fapt', width: 64, align: 'right' },
    { label: 'Diferenta', key: 'dif', width: 64, align: 'right' },
    { label: 'CMP', key: 'cmp', width: 56, align: 'right' },
    { label: 'Valoare dif.', key: 'val', width: 76, align: 'right' },
    { label: 'Observatii', key: 'obs', width: 110 },
  ], rows);
  doc.moveDown(0.5);
  const sum = [
    { k: 'Total plusuri de inventar (371 = 758)', v: fmt(iv.totalPlus) },
    { k: 'Total minusuri/lipsuri (60x = 371)', v: fmt(iv.totalMinus) },
    { k: 'Total imputat gestionarului (4282 = 7588 + 4427)', v: fmt(iv.totalImputat) },
  ];
  table(doc, [
    { label: 'Rezultatul inventarierii', key: 'k', width: 360 },
    { label: 'Valoare (lei)', key: 'v', width: 140, align: 'right' },
  ], sum.map((r) => ({ ...r, _bold: true })), doc.y);
  doc.moveDown(1.2);
  doc.fillColor(C.muted).font('Helvetica').fontSize(9)
    .text('Operator (a inregistrat): ' + (iv.operator || '—') + '      Gestionar (' + (iv.gestionar || '—') + '): ____________________      Comisia: ____________________      Data: ' + iv.data);
  finish(doc, res, 'proces-verbal-inventar-' + iv.id + '.pdf');
}

function nirPdf(res, company, data) {
  const doc = newDoc(false);
  header(doc, company, 'Nota de intrare-receptie', 'si constatare de diferente' + (data.serieNr ? '   ·   Serie/Nr: ' + data.serieNr : ''));
  doc.fillColor(C.ink).font('Helvetica').fontSize(10);
  doc.text('Document (factura/aviz): ' + clean(data.document || '-'));
  doc.text('Furnizor: ' + clean(data.furnizor || '-'));
  doc.text('Gestiune: ' + clean(data.gestiune || '-') + '        Data receptiei: ' + fmtDate(data.data));
  if (data.operator) doc.text('Operator: ' + clean(data.operator));
  doc.moveDown(0.5);
  const rows = data.lines.map((l, i) => ({
    nr: String(i + 1), cod: l.cod, den: l.denumire, um: l.um || 'buc',
    cant: fmt(l.cantitate), pret: fmt(l.pret), val: fmt(l.valoare),
  }));
  rows.push({ nr: '', cod: '', den: 'TOTAL', um: '', cant: '', pret: '', val: fmt(round2(data.total)), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Nr', key: 'nr', width: 32, align: 'center' },
    { label: 'Cod', key: 'cod', width: 90 },
    { label: 'Denumire produs', key: 'den', width: 170, wrap: true },
    { label: 'UM', key: 'um', width: 44, align: 'center' },
    { label: 'Cantitate', key: 'cant', width: 70, align: 'right' },
    { label: 'Pret unitar', key: 'pret', width: 76, align: 'right' },
    { label: 'Valoare', key: 'val', width: 80, align: 'right' },
  ], rows);
  doc.moveDown(1.2);
  doc.fillColor(C.muted).font('Helvetica').fontSize(9)
    .text('Comisia de receptie: ____________________      Gestionar: ____________________      Data: ' + fmtDate(data.data));
  finish(doc, res, 'nir-' + (data.document || 'receptie').replace(/[^\w-]/g, '_') + '.pdf');
}

function bonConsumPdf(res, company, data) {
  const doc = newDoc(false);
  header(doc, company, 'Bon de consum', data.serieNr ? 'Serie/Nr: ' + data.serieNr : '');
  doc.fillColor(C.ink).font('Helvetica').fontSize(10);
  if (data.document) doc.text('Document: ' + clean(data.document));
  doc.text('Gestiune: ' + clean(data.gestiune || '-') + '        Data: ' + fmtDate(data.data));
  if (data.operator) doc.text('Operator: ' + clean(data.operator));
  doc.moveDown(0.5);
  const rows = data.lines.map((l, i) => ({
    nr: String(i + 1), cod: l.cod, den: l.denumire, um: l.um || 'buc',
    cant: fmt(l.cantitate), pret: fmt(l.cmp), val: fmt(l.valoare),
  }));
  rows.push({ nr: '', cod: '', den: 'TOTAL', um: '', cant: '', pret: '', val: fmt(round2(data.total)), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Nr', key: 'nr', width: 32, align: 'center' },
    { label: 'Cod', key: 'cod', width: 90 },
    { label: 'Denumire produs', key: 'den', width: 170, wrap: true },
    { label: 'UM', key: 'um', width: 44, align: 'center' },
    { label: 'Cantitate', key: 'cant', width: 70, align: 'right' },
    { label: 'Pret (CMP)', key: 'pret', width: 76, align: 'right' },
    { label: 'Valoare', key: 'val', width: 80, align: 'right' },
  ], rows);
  doc.moveDown(1.2);
  doc.fillColor(C.muted).font('Helvetica').fontSize(9)
    .text('Predat (gestionar): ____________________      Primit: ____________________      Aprobat: ____________________');
  finish(doc, res, 'bon-consum-' + (data.document || 'iesire').replace(/[^\w-]/g, '_') + '.pdf');
}

function avizPdf(res, company, data) {
  const doc = newDoc(false);
  header(doc, company, 'Aviz de insotire a marfii', data.serieNr ? 'Serie/Nr: ' + data.serieNr : '');
  doc.fillColor(C.ink).font('Helvetica').fontSize(10);
  if (data.document) doc.text('Document: ' + clean(data.document));
  doc.text('Expeditor: ' + clean(data.expeditor || company.nume || '-'));
  doc.text('Destinatar: ' + clean(data.destinatar || '-'));
  doc.text('Data: ' + fmtDate(data.data) + (data.operator ? '        Intocmit de: ' + clean(data.operator) : ''));
  doc.moveDown(0.5);
  const rows = data.lines.map((l, i) => ({
    nr: String(i + 1), cod: l.cod, den: l.denumire, um: l.um || 'buc',
    cant: fmt(l.cantitate), pret: fmt(l.cmp), val: fmt(l.valoare),
  }));
  rows.push({ nr: '', cod: '', den: 'TOTAL', um: '', cant: '', pret: '', val: fmt(round2(data.total)), _bold: true, _fill: C.zebra });
  table(doc, [
    { label: 'Nr', key: 'nr', width: 32, align: 'center' },
    { label: 'Cod', key: 'cod', width: 90 },
    { label: 'Denumire marfa', key: 'den', width: 170, wrap: true },
    { label: 'UM', key: 'um', width: 44, align: 'center' },
    { label: 'Cantitate', key: 'cant', width: 70, align: 'right' },
    { label: 'Pret (CMP)', key: 'pret', width: 76, align: 'right' },
    { label: 'Valoare', key: 'val', width: 80, align: 'right' },
  ], rows);
  doc.moveDown(1.2);
  doc.fillColor(C.muted).font('Helvetica').fontSize(9)
    .text('Semnatura expeditor: ____________________      Delegat (mijloc transport): ____________________      Semnatura primire: ____________________');
  finish(doc, res, 'aviz-' + (data.document || 'transfer').replace(/[^\w-]/g, '_') + '.pdf');
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
  rows.push({ k: r.zileCM ? 'Salariu aferent zilelor lucrate' : 'Salariu brut', v: fmt(r.brut), _bold: true });
  if (r.zileCM) {
    rows.push({ k: '+ Indemnizatie CM angajator (' + Math.min(5, r.zileCM) + ' zile, ' + (r.procentCM || 75) + '% din media ' + fmt(r.mediaCM) + ')', v: fmt(r.cmAngajator) });
    if (r.cmFnuass) rows.push({ k: '+ Indemnizatie CM FNUASS (' + Math.max(0, r.zileCM - 5) + ' zile)', v: fmt(r.cmFnuass) });
  }
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

module.exports = {
  clean, journalPdf, ledgerPdf, trialBalancePdf, plPdf, balanceSheetPdf, notePdf, vatPdf,
  d112Pdf, d300Pdf, d100Pdf, declaratiaUnicaPdf, obligatiiPdf, registruInventarPdf, registruFiscalPdf, analyticPdf,
  cashBookPdf, cashValutaPdf, notesPdf, cashFlowPdf, equityPdf, setStatementsPdf, facturaPdf, chitantaPdf, fisaContPdf, registruIncasariPlatiPdf, aprovizionariPdf, consumuriPdf, assetsRegisterPdf, assetFisaPdf, stocksPdf, stockLedgerPdf, inventoryListPdf, inventoryPvPdf, nirPdf, bonConsumPdf, avizPdf, docRegisterPdf, agingPdf, statePlataPdf, fluturasPdf, registruSalariiPdf, adeverintaPdf, leasingSchedulePdf,
};
