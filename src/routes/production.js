'use strict';

// Rutele de productie si retete (BOM): obtinerea de produse finite din consum de materiale
// (buildProduction din src/production), raportul de productie si CRUD retete.
// Modul de rute: register(app, ctx).

const db = require('../db');
const { period: periodOf, validIsoDate, roundQty } = require('../util');
const production = require('../production');
const stocks = require('../stocks');
const coa = require('../chartOfAccounts');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  function doProduction(req, res, order, document, data) {
    const d = db.get(); const fid = activeId(req); const v = S(req);
    if (!validIsoDate(data)) return res.status(400).json({ error: 'Data productiei trebuie sa fie o data calendaristica valida (YYYY-MM-DD).' });
    const firma = db.getFirma(fid) || {};
    if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) return res.status(400).json({ error: 'Perioada ' + periodOf(data) + ' este inchisa (blocata pana la ' + firma.lockedUntil + ').' });
    let r;
    try {
      r = production.buildProduction(v.products, v.stockMovements, order, { fid, data,
        document: document || '', nextId: () => db.nextId('sm'), metoda: stocks.metodaFirma(v) });
    } catch (e) { return res.status(400).json({ error: e.message }); }
    if (r.lipsuri.length) return res.status(409).json({ error: 'Stoc insuficient pentru productie: '
      + r.lipsuri.map((x) => x.denumire + ' — lipsa ' + x.lipsa).join('; ') + '.' });
    const drift = stocks.valuationDrift(v, r.newMovements);
    if (drift) return res.status(409).json({ error: 'Productia retroactiva ar recalcula iesirea deja postata '
      + drift.movementId + ' (' + drift.data + '). Storneaza si reia documentele in ordine cronologica.' });
    if (!r.lines.length) return res.status(400).json({ error: 'Nimic de inregistrat — verifica produsul finit, cantitatea si costul.' });
    for (const ln of r.lines) if (!coa.getAccount(ln.debit) || !coa.getAccount(ln.credit)) return res.status(400).json({ error: 'Cont inexistent in plan: ' + ln.debit + '/' + ln.credit });
    const entry = {
      id: db.nextId('e'), firmaId: fid, data, period: periodOf(data), tip: 'productie', tipNume: 'Productie (obtinere produse finite)',
      partener: '', document: document || 'Bon productie', explicatie: 'Consum materiale + obținere produse finite', fileId: null, system: false, lines: r.lines,
    };
    r.newMovements.forEach((m) => { m.entryId = entry.id; d.stockMovements.push(m); });
    entry.stocMovementIds = r.newMovements.map((m) => m.id);
    db.pushEntry(entry, { context: 'productie' });
    logAudit('productie', 'cost obtinut ' + r.valoareObtinuta, { req });
    db.save();
    res.json({ ok: true, entry, costMateriale: r.costMateriale, valoareObtinuta: r.valoareObtinuta, warns: r.warns });
  }
  app.post('/api/production', (req, res) => {
    const b = req.body || {};
    const data = b.data || new Date().toISOString().slice(0, 10);
    doProduction(req, res, {
      productId: b.productId, gestiuneId: b.gestiuneId || null, cantitate: b.cantitate, costUnitar: b.costUnitar,
      materiale: Array.isArray(b.materiale) ? b.materiale : [],
    }, b.document || '', data);
  });
  app.get('/api/production-report', (req, res) => res.json(production.productionReport(S(req), req.query.period || null)));

  // ── Retete / BOM stocate ──
  app.get('/api/recipes', (req, res) => {
    const fid = activeId(req);
    sendList(req, res, (db.get().recipes || []).filter((t) => t.firmaId === fid), { label: 'recipes' });
  });
  app.post('/api/recipes', (req, res) => {
    const b = req.body || {};
    if (!b.nume || !b.productId) return res.status(400).json({ error: 'Completeaza numele retetei si produsul finit.' });
    const d = db.get(); const fid = activeId(req);
    const t = b.id && (d.recipes || []).find((x) => x.id === b.id && x.firmaId === fid);
    const rec = t || { id: db.nextId('bom'), firmaId: fid, createdAt: new Date().toISOString() };
    Object.assign(rec, {
      nume: String(b.nume), productId: b.productId, gestiuneId: b.gestiuneId || null,
      cantitateBaza: Number(b.cantitateBaza) > 0 ? roundQty(b.cantitateBaza) : 1,
      costUnitar: Number(b.costUnitar) || 0,
      materiale: (Array.isArray(b.materiale) ? b.materiale : []).filter((m) => m && m.productId && Number(m.cantitate) > 0)
        .map((m) => ({ productId: m.productId, gestiuneId: m.gestiuneId || null, cantitate: roundQty(m.cantitate) })),
    });
    if (!t) d.recipes.push(rec);
    logAudit('reteta.save', rec.nume, { req });
    db.save();
    res.json({ ok: true, recipe: rec });
  });
  app.delete('/api/recipes/:id', (req, res) => {
    const d = db.get(); const fid = activeId(req);
    d.recipes = (d.recipes || []).filter((t) => !(t.id === req.params.id && t.firmaId === fid));
    logAudit('reteta.delete', req.params.id, { req });
    db.save();
    res.json({ ok: true });
  });
  app.post('/api/recipes/:id/produce', (req, res) => {
    const b = req.body || {}; const fid = activeId(req);
    const rec = (db.get().recipes || []).find((t) => t.id === req.params.id && t.firmaId === fid);
    if (!rec) return res.status(404).json({ error: 'Reteta inexistenta.' });
    const data = b.data || new Date().toISOString().slice(0, 10);
    const order = production.expandRecipe(rec, b.cantitate, b.costUnitar);
    doProduction(req, res, order, b.document || ('Bon productie ' + rec.nume), data);
  });
};
