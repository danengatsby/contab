'use strict';

// Export CSV (compatibil Excel: separator ; + BOM UTF-8) pentru registre, jurnale de TVA,
// balanta, cartea mare, analitic, parteneri, stocuri, aging si intrastat.
// Modul de rute: register(app, ctx). sendCsv (helperul comun) traieste aici.

const { round2 } = require('../util');
const { toCsv } = require('../csv');
const acc = require('../accounting');
const stocks = require('../stocks');
const rep = require('../reporting');
const { analyticBalance, aging } = require('../analytic');

module.exports = function register(app, ctx) {
  const { S } = ctx;

  function sendCsv(res, filename, str) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(str);
  }
  app.get('/csv/stock-movements', (req, res) => {
    const rows = stocks.movementsList(S(req), req.query.period || null).map((m) => [m.data, m.tip, m.gestiuneCod, m.gestiuneDestCod || '', m.cod, m.denumire, m.cantitate, m.um, m.pretUnitar || '', m.document || '', m.operator || '']);
    sendCsv(res, 'miscari-stoc.csv', toCsv(['Data', 'Tip', 'Gestiune', 'Gestiune dest', 'Cod', 'Denumire', 'Cantitate', 'UM', 'Pret', 'Document', 'Operator'], rows));
  });
  app.get('/csv/stocks', (req, res) => {
    const rows = stocks.currentStock(S(req), req.query.asOf || null, req.query.gestiune || null).map((s) => [s.gestiune.cod, s.product.cod, s.product.denumire, s.product.cont || '371', s.stocQ, s.product.um || 'buc', s.cmp, s.stocV]);
    sendCsv(res, 'stocuri.csv', toCsv(['Gestiune', 'Cod', 'Denumire', 'Cont', 'Cantitate', 'UM', 'CMP', 'Valoare'], rows));
  });
  app.get('/csv/journal', (req, res) => {
    const j = acc.journal(S(req), req.query.period || null);
    const rows = j.rows.map((r) => [r.nr || '', r.data || '', r.document || '', r.explicatie || '', r.debit, r.credit, r.suma]);
    sendCsv(res, 'registru-jurnal.csv', toCsv(['Nr', 'Data', 'Document', 'Explicatie', 'Cont debitor', 'Cont creditor', 'Suma'], rows));
  });
  app.get('/csv/vat-sales', (req, res) => {
    const vS = S(req); const vj = acc.vatJournals(vS, acc.vatPeriod(vS.company, req.query.period || null));
    const rows = vj.vanzari.map((r) => [r.data, r.document || '', r.partener || '', r.cui || '', r.cota ? r.cota + '%' : 'scutit', r.baza, r.tva, r.total, r.taxareInversa ? 'taxare inversa' : '']);
    rows.push(['', '', 'TOTAL', '', '', vj.totals.bazaV, vj.totals.colectata, round2(vj.totals.bazaV + vj.totals.colectata), '']);
    sendCsv(res, 'jurnal-vanzari.csv', toCsv(['Data', 'Document', 'Partener', 'CUI', 'Cota', 'Baza', 'TVA', 'Total', 'Observatii'], rows));
  });
  app.get('/csv/vat-purchases', (req, res) => {
    const vP = S(req); const vj = acc.vatJournals(vP, acc.vatPeriod(vP.company, req.query.period || null));
    const rows = vj.cumparari.map((r) => [r.data, r.document || '', r.partener || '', r.cui || '', r.cota ? r.cota + '%' : 'scutit', r.baza, r.tva, r.total, r.taxareInversa ? 'taxare inversa' : '']);
    rows.push(['', '', 'TOTAL', '', '', vj.totals.bazaC, vj.totals.deductibila, round2(vj.totals.bazaC + vj.totals.deductibila), '']);
    sendCsv(res, 'jurnal-cumparari.csv', toCsv(['Data', 'Document', 'Partener', 'CUI', 'Cota', 'Baza', 'TVA', 'Total', 'Observatii'], rows));
  });
  app.get('/csv/balance', (req, res) => {
    const tb = acc.trialBalance(S(req), req.query.period || null);
    const rows = tb.rows.map((r) => [r.cod, r.nume, r.siD, r.siC, r.rd, r.rc, r.tsD, r.tsC, r.sfD, r.sfC]);
    rows.push(['', 'TOTAL', tb.tot.siD, tb.tot.siC, tb.tot.rd, tb.tot.rc, tb.tot.tsD, tb.tot.tsC, tb.tot.sfD, tb.tot.sfC]);
    sendCsv(res, 'balanta.csv', toCsv(['Cont', 'Denumire', 'SI Debit', 'SI Credit', 'Rulaj Debit', 'Rulaj Credit', 'TSD', 'TSC', 'SF Debit', 'SF Credit'], rows));
  });
  app.get('/csv/ledger', (req, res) => {
    const led = acc.ledger(S(req), req.query.period || null);
    const rows = [];
    for (const a of led) {
      rows.push([a.cod, a.nume, '', '', 'Sold initial', a.siD || '', a.siC || '']);
      for (const m of a.moves) rows.push([a.cod, a.nume, m.data, m.document || '', m.explicatie || '', m.debit || '', m.credit || '']);
      rows.push([a.cod, a.nume, '', '', 'Sold final', a.sfD || '', a.sfC || '']);
    }
    sendCsv(res, 'cartea-mare.csv', toCsv(['Cont', 'Denumire', 'Data', 'Document', 'Explicatie', 'Debit', 'Credit'], rows));
  });
  app.get('/csv/analytic', (req, res) => {
    const rows = [];
    for (const s of analyticBalance(S(req))) for (const r of s.rows) rows.push([s.synth, s.nume, r.analitic, r.den, r.cui || '', r.siD || '', r.siC || '', r.rd || '', r.rc || '', r.sfD || '', r.sfC || '']);
    sendCsv(res, 'balanta-analitica.csv', toCsv(['Cont sintetic', 'Denumire', 'Analitic', 'Partener/Eticheta', 'CUI', 'SI Debit', 'SI Credit', 'Rulaj Debit', 'Rulaj Credit', 'SF Debit', 'SF Credit'], rows));
  });
  app.get('/csv/partners', (req, res) => {
    const rows = Object.values(S(req).partners || {}).map((p) => [p.cui, p.den || '', p.adresa || '', p.oras || '', p.judet || '', p.tara || '', p.tip || '']);
    sendCsv(res, 'parteneri.csv', toCsv(['CUI', 'Denumire', 'Adresa', 'Oras', 'Judet', 'Tara', 'Tip'], rows));
  });
  app.get('/csv/aging', (req, res) => {
    const a = aging(S(req), req.query.asOf || null);
    const rows = [];
    const add = (tip, list) => list.forEach((x) => rows.push([tip, x.partener, x.cui || '', x.total, x.b0_30, x.b31_60, x.b61_90, x.b90plus]));
    add('Creanta', a.clienti); add('Datorie', a.furnizori);
    sendCsv(res, 'aging.csv', toCsv(['Tip', 'Partener', 'CUI', 'Total', '0-30 zile', '31-60 zile', '61-90 zile', 'peste 90 zile'], rows));
  });

  app.get('/csv/intrastat', (req, res) => {
    const d = rep.intrastat(S(req), req.query.period || null);
    const rows = d.rows.map((r) => [r.flux, r.tara, r.codNC || '', r.natura || '', r.conditie || '', r.masaNeta, r.valoare, r.nrop]);
    sendCsv(res, 'intrastat.csv', toCsv(['Flux', 'Tara', 'Cod NC8', 'Natura tranzactiei', 'Conditie livrare', 'Masa neta (kg)', 'Valoare (lei)', 'Nr. operatiuni'], rows));
  });
};
