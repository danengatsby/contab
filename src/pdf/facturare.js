'use strict';

// Documente per inregistrare: factura (compact/detaliat, e-Factura layout), chitanta, nota contabila.

const { C, clean, finish, header, logoPath, newDoc, table } = require('./helpers');
const { fmt, fmtDate, round2, sumaInLitere } = require('../util');
const PDFDocument = require('pdfkit');

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

// Situatia fluxurilor de trezorerie, metoda directa (nu formularul ANAF „F30" = Date informative).

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


module.exports = { invoiceData, invoiceItemsTable, facturaPdf, facturaCompactPdf, facturaDetaliatPdf, chitantaPdf, notePdf };
