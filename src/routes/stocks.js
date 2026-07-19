'use strict';

// Rutele de stocuri — strat SUBTIRE peste src/stocksService.js: parseaza cererea, apeleaza
// serviciul (care valideaza, aplica regulile si scrie) si traduce erorile lui (`err.status`)
// in raspunsuri HTTP. Autorizarea pe firma e impusa in serviciu (reqFirma + cautari doar in
// firma data), nu doar aici. Citirile raman pe vederea scoped (S). Export CSV, seriile de
// documente si PDF-urile de stoc (NIR/bon/aviz) raman deocamdata in server.js.

const stocks = require('../stocks');
const svc = require('../stocksService');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  // Erorile de business poarta `status` (400/403/404); restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };
  const operator = (req) => (req.user && req.user.username) || '';

  // ── nomenclator produse ──
  app.get('/api/products', (req, res) => res.json(S(req).products));
  app.post('/api/products', (req, res) => run(res, () => {
    const r = svc.upsertProduct(activeId(req), req.body);
    if (r.created) logAudit('product.create', r.product.cod + ' ' + r.product.denumire, { req });
    return { ok: true, product: r.product };
  }));
  app.post('/api/products/import', (req, res) => run(res, () => {
    const r = svc.importProducts(activeId(req), (req.body || {}).csv);
    logAudit('products.import', r.importati + ' produse', { req });
    return { ok: true, importati: r.importati };
  }));
  app.delete('/api/products/:id', (req, res) => run(res, () => {
    svc.deleteProduct(activeId(req), req.params.id);
    return { ok: true };
  }));
  // dezactivare/reactivare (soft-delete corect contabil pentru produse cu istoric)
  app.post('/api/products/:id/active', (req, res) => run(res, () => {
    const r = svc.setProductActive(activeId(req), req.params.id, (req.body || {}).activ !== false);
    return { ok: true, product: r.product };
  }));

  // ── preluare stoc initial ──
  app.get('/api/stocks/initial-check', (req, res) => res.json({ totaluri: svc.initialTotals(S(req)) }));
  app.post('/api/stocks/import-initial', (req, res) => run(res, () => {
    const r = svc.importInitialStock(activeId(req), operator(req), req.body);
    logAudit('stocks.importInitial', r.importate + ' pozitii stoc initial la ' + (req.body || {}).data, { req });
    return { ok: true, importate: r.importate, produseNoi: r.produseNoi, gestiuniNoi: r.gestiuniNoi, erori: r.erori, totaluri: r.totaluri };
  }));

  // ── gestiuni (depozite) ──
  app.get('/api/gestiuni', (req, res) => res.json(S(req).gestiuni));
  app.post('/api/gestiuni', (req, res) => run(res, () => {
    const r = svc.upsertGestiune(activeId(req), req.body);
    if (r.created) logAudit('gestiune.create', r.gestiune.cod + ' ' + r.gestiune.denumire, { req });
    return { ok: true, gestiune: r.gestiune };
  }));
  app.delete('/api/gestiuni/:id', (req, res) => run(res, () => {
    svc.deleteGestiune(activeId(req), req.params.id);
    return { ok: true };
  }));

  // ── miscari de stoc + nota contabila ──
  app.get('/api/stock-movements', (req, res) => sendList(req, res, stocks.movementsList(S(req), req.query.period || null), { label: '/api/stock-movements' }));
  app.post('/api/stock-movements', (req, res) => run(res, () => {
    const r = svc.addMovement(activeId(req), operator(req), req.body);
    logAudit('stock.move', r.movement.tip + ' ' + r.movement.cantitate, { req });
    return { ok: true, movement: r.movement };
  }));
  app.delete('/api/stock-movements/:id', (req, res) => run(res, () => {
    svc.deleteMovement(activeId(req), req.params.id);
    return { ok: true };
  }));
  app.post('/api/stock-movements/:id/post', (req, res) => run(res, () => {
    const r = svc.postMovement(activeId(req), req.params.id);
    logAudit('stoc.descarcare', r.tipNume + ' ' + r.suma, { req });
    return { ok: true, entry: r.entry };
  }));

  // ── inventariere ──
  app.get('/api/inventory', (req, res) => {
    if (!req.query.gestiune) return res.status(400).json({ error: 'Alege o gestiune.' });
    res.json(stocks.inventoryList(S(req), req.query.gestiune, req.query.asOf || null));
  });
  app.post('/api/inventory', (req, res) => run(res, () => {
    const r = svc.createInventory(activeId(req), operator(req), req.body);
    logAudit('inventar', r.inv.gestiuneCod + ' ' + r.inv.data + ' (+' + r.result.plusuri.length + '/-' + r.result.minusuri.length + ')', { req });
    return { ok: true, id: r.inv.id, result: r.result };
  }));
  app.get('/api/inventories', (req, res) => res.json(
    (S(req).inventories || []).slice().sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .map((iv) => ({ id: iv.id, gestiuneCod: iv.gestiuneCod, gestiuneDen: iv.gestiuneDen, data: iv.data, ts: iv.ts, operator: iv.operator || '', status: iv.status || 'activ', stornoData: iv.stornoData || null, totalPlus: iv.totalPlus, totalMinus: iv.totalMinus, totalImputat: iv.totalImputat, nrPlus: iv.lines.filter((l) => l.tip === 'plus').length, nrMinus: iv.lines.filter((l) => l.tip === 'minus').length })),
  ));
  app.post('/api/inventories/:id/storno', (req, res) => run(res, () => {
    const r = svc.stornoInventory(activeId(req), operator(req), req.params.id, (req.body || {}).data);
    logAudit('inventar.storno', r.iv.gestiuneCod + ' ' + r.iv.data, { req });
    return { ok: true, stornoEntries: r.stornoEntries };
  }));

  // ── stoc curent / fisa de magazie ──
  app.get('/api/stocks', (req, res) => res.json(stocks.currentStock(S(req), req.query.asOf || null, req.query.gestiune || null)));
  app.get('/api/stocks/:id/ledger', (req, res) => {
    const v = S(req);
    const p = v.products.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Produs inexistent.' });
    res.json(stocks.productLedger(p, v.stockMovements, req.query.asOf || null, req.query.gestiune || null));
  });

};
