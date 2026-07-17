'use strict';

// Documente de gestiune: situatii de stoc, fisa de magazie, inventariere, NIR, bon consum, aviz.

const { C, clean, finish, header, newDoc, table } = require('./helpers');
const { fmt, fmtDate, round2 } = require('../util');

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


module.exports = { stocksPdf, stockLedgerPdf, inventoryListPdf, inventoryPvPdf, nirPdf, bonConsumPdf, avizPdf };
