'use strict';

// Documente de gestiune (PDF/JSON): situatiile de stoc (stoc curent, aprovizionari, consumuri,
// inventar + proces-verbal), seriile de documente (NIR/BC/AVIZ/CH), registrul documentelor de
// stoc si documentele numerotate NIR (receptie) / bon de consum / aviz de insotire, plus fisa
// de magazie a produsului si nota contabila in PDF. Modul de rute: register(app, ctx).
// Rutele raman bogate doar in PREZENTARE (asamblarea payload-ului PDF); scrierile — seriile de
// documente si numerotarea — stau in src/stocksService.js, sub garda de firma (reqFirma).

const db = require('../db');
const pdf = require('../pdf');
const stocks = require('../stocks');
const acc = require('../accounting');
const { round2 } = require('../util');
const svc = require('../stocksService');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, canAccess } = ctx;

  // Erorile de business poarta `status`; restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { const out = fn(); if (out !== undefined) res.json(out); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  // ── Situatii de stoc (PDF/JSON) ──
  app.get('/pdf/stocks', (req, res) => {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
    pdf.stocksPdf(res, S(req).company, stocks.currentStock(S(req), asOf), asOf);
  });
  // Situatia aprovizionarilor (receptii pe furnizori) si a consumurilor (iesiri la CMP pe cont)
  app.get('/api/aprovizionari', (req, res) => res.json(stocks.situatieAprovizionari(S(req), req.query.period || null)));
  app.get('/pdf/aprovizionari', (req, res) => pdf.aprovizionariPdf(res, S(req).company, stocks.situatieAprovizionari(S(req), req.query.period || null)));
  app.get('/api/consumuri', (req, res) => res.json(stocks.situatieConsumuri(S(req), req.query.period || null)));
  app.get('/pdf/consumuri', (req, res) => pdf.consumuriPdf(res, S(req).company, stocks.situatieConsumuri(S(req), req.query.period || null)));
  app.get('/pdf/inventory', (req, res) => {
    const v = S(req);
    const g = v.gestiuni.find((x) => x.id === req.query.gestiune);
    if (!g) return res.status(400).send('Alege o gestiune');
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
    pdf.inventoryListPdf(res, v.company, { gestiune: g.cod + ' — ' + g.denumire, asOf, lines: stocks.inventoryList(v, g.id, asOf) });
  });
  app.get('/pdf/inventory-pv/:id', (req, res) => {
    const iv = (S(req).inventories || []).find((x) => x.id === req.params.id);
    if (!iv) return res.status(404).send('Proces-verbal inexistent');
    pdf.inventoryPvPdf(res, S(req).company, iv);
  });

  // ── Serii de documente (NIR/BC/AVIZ/CH) ──
  app.get('/api/doc-series', (req, res) => run(res, () => svc.docSeries(activeId(req))));
  app.post('/api/doc-series', (req, res) => run(res, () => {
    const r = svc.updateDocSeries(activeId(req), req.body);
    return { ok: true, series: r.series };
  }));

  // ── Registrul documentelor de stoc + documentele numerotate ──
  app.get('/api/doc-register', (req, res) => sendList(req, res, svc.buildDocRegister(S(req)), { label: 'doc-register' }));
  app.get('/pdf/doc-register', (req, res) => pdf.docRegisterPdf(res, S(req).company, svc.buildDocRegister(S(req))));

  app.get('/pdf/nir', (req, res) => {
    const v = S(req);
    const byId = new Map(v.products.map((p) => [p.id, p]));
    const gById = new Map(v.gestiuni.map((g) => [g.id, g]));
    const recs = stocks.sortMov(v.stockMovements.filter((m) => m.tip === 'receptie'
      && (req.query.document ? m.document === req.query.document : m.id === req.query.id)
      && (!req.query.gestiune || m.gestiuneId === req.query.gestiune)));
    if (!recs.length) return res.status(404).send('Receptie inexistenta');
    const g = gById.get(recs[0].gestiuneId);
    const lines = recs.map((m) => {
      const p = byId.get(m.productId) || {};
      return { cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc', cantitate: m.cantitate, pret: m.pretUnitar, valoare: Math.round(m.cantitate * m.pretUnitar * 100) / 100 };
    });
    pdf.nirPdf(res, v.company, {
      serieNr: svc.assignDocNumber(activeId(req), 'NIR', recs),
      document: recs[0].document, furnizor: recs[0].furnizor || '', gestiune: g ? g.cod + ' — ' + g.denumire : '',
      data: recs[0].data, operator: recs[0].operator || '', lines, total: lines.reduce((s, l) => s + l.valoare, 0),
    });
  });
  app.get('/pdf/bon-consum', (req, res) => {
    const v = S(req);
    const byId = new Map(v.products.map((p) => [p.id, p]));
    const gById = new Map(v.gestiuni.map((g) => [g.id, g]));
    const isd = stocks.sortMov(v.stockMovements.filter((m) => m.tip === 'iesire'
      && (req.query.document ? m.document === req.query.document : m.id === req.query.id)
      && (!req.query.gestiune || m.gestiuneId === req.query.gestiune)));
    if (!isd.length) return res.status(404).send('Iesire inexistenta');
    const g = gById.get(isd[0].gestiuneId);
    const lines = isd.map((m) => {
      const p = byId.get(m.productId) || {};
      const valoare = round2(stocks.movementValue(p, v.stockMovements, m.id)); // valoare la CMP
      const cmp = m.cantitate > 0 ? round2(valoare / m.cantitate) : 0;
      return { cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc', cantitate: m.cantitate, cmp, valoare };
    });
    pdf.bonConsumPdf(res, v.company, {
      serieNr: svc.assignDocNumber(activeId(req), 'BC', isd),
      document: isd[0].document, gestiune: g ? g.cod + ' — ' + g.denumire : '',
      data: isd[0].data, operator: isd[0].operator || '', lines, total: lines.reduce((s, l) => s + l.valoare, 0),
    });
  });
  app.get('/pdf/aviz', (req, res) => {
    const v = S(req);
    const byId = new Map(v.products.map((p) => [p.id, p]));
    const gById = new Map(v.gestiuni.map((g) => [g.id, g]));
    const trs = stocks.sortMov(v.stockMovements.filter((m) => m.tip === 'transfer'
      && (req.query.document ? m.document === req.query.document : m.id === req.query.id)));
    if (!trs.length) return res.status(404).send('Transfer inexistent');
    const src = gById.get(trs[0].gestiuneId); const dst = gById.get(trs[0].gestiuneDestId);
    const nm = (g) => g ? (v.company.nume || '') + ' — gestiune ' + g.cod + ' ' + g.denumire : '';
    const lines = trs.map((m) => {
      const p = byId.get(m.productId) || {};
      const valoare = round2(stocks.movementValue(p, v.stockMovements, m.id)); // valoare la CMP-ul sursei
      const cmp = m.cantitate > 0 ? round2(valoare / m.cantitate) : 0;
      return { cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc', cantitate: m.cantitate, cmp, valoare };
    });
    pdf.avizPdf(res, v.company, {
      serieNr: svc.assignDocNumber(activeId(req), 'AVIZ', trs),
      document: trs[0].document, expeditor: nm(src), destinatar: nm(dst),
      data: trs[0].data, operator: trs[0].operator || '', lines, total: lines.reduce((s, l) => s + l.valoare, 0),
    });
  });
  app.get('/pdf/stock-ledger/:id', (req, res) => {
    const v = S(req);
    const p = v.products.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).send('Produs inexistent');
    pdf.stockLedgerPdf(res, v.company, stocks.productLedger(p, v.stockMovements, req.query.asOf || null, req.query.gestiune || null));
  });
  app.get('/pdf/note/:id', (req, res) => {
    const e = db.get().entries.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).send('Nota inexistenta');
    const fid = e.firmaId || db.firmaActiva();
    if (!canAccess(req, fid)) return res.status(404).send('Nota inexistenta'); // izolare multi-firma
    const nr = acc.journalNr(db.scoped(fid), e.id);
    pdf.notePdf(res, db.getFirma(fid) || {}, Object.assign({ nrJurnal: nr }, e));
  });
};
