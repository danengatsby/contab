'use strict';

// Rutele contractelor de leasing — strat SUBTIRE peste src/leasingService.js: parseaza cererea,
// apeleaza serviciul (care valideaza si impune autorizarea pe firma) si traduce erorile lui
// (`err.status`) in raspunsuri HTTP.
//
// `/api/leasing-schedule` (calculatorul fara stare, cu parametrii in query) ramane in
// src/routes/assets.js, neatins: e util pentru o simulare inainte de a exista un contract.

const svc = require('../leasingService');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;

  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  app.get('/api/leasing-contracts', (req, res) => run(res, () => svc.list(activeId(req))));

  app.post('/api/leasing-contracts', (req, res) => run(res, () => {
    const r = svc.upsert(activeId(req), req.body);
    logAudit(r.created ? 'leasing.create' : 'leasing.update',
      r.contract.denumire + ' (' + r.contract.principal + ' lei / ' + r.contract.months + ' rate)', { req });
    return { ok: true, contract: r.contract };
  }));

  app.delete('/api/leasing-contracts/:id', (req, res) => run(res, () => {
    const r = svc.remove(activeId(req), req.params.id);
    logAudit('leasing.delete', r.contract.denumire, { req });
    return { ok: true };
  }));

  app.get('/api/leasing-contracts/:id/schedule', (req, res) => run(res, () => svc.schedule(activeId(req), req.params.id)));

  // Rata unei luni — exact cifrele cerute de `factura_leasing`. Formularul o cheama la alegerea
  // contractului si a lunii, si isi completeaza singur principalul, dobanda si TVA-ul.
  app.get('/api/leasing-contracts/:id/rata', (req, res) => run(res, () => svc.installment(activeId(req), req.params.id, req.query.period)));

  return { sendList };
};
