'use strict';

// Inchideri fiscale — strat SUBTIRE peste src/closingsService.js: parseaza cererea, apeleaza
// serviciul si traduce erorile lui (`err.status`) in raspunsuri HTTP. Serviciul intoarce
// `posted`; mesajele istorice de no-op si auditul (doar cand s-a scris o nota) raman aici.
// Preview-urile (citiri pure) apeleaza direct modulul contabil.

const acc = require('../accounting');
const svc = require('../closingsService');
const annualClose = require('../annualClose');
const annualInventory = require('../annualInventory');
const db = require('../db');
const permissions = require('../permissions');
const dosarAnual = require('../dosarAnual');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit, wrap } = ctx;

  // Erorile de business poarta `status` (400/403); restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  app.post('/api/close-vat', (req, res) => run(res, () => {
    const r = svc.closeVat(activeId(req), req.query.period);
    if (r.posted) logAudit('regularizare.tva', req.query.period, { req });
    return { ok: true, result: r.result, lockedUntil: r.lockedUntil,
      message: r.posted ? undefined : 'Fara TVA de regularizat; perioada ramane deschisa.' };
  }));

  app.get('/api/annual-close', (req, res) => run(res, () => {
    const fid = activeId(req); const year = req.query.year || String(new Date().getFullYear());
    const result = annualClose.status(db.get(), S(req), year);
    result.permission = permissions.verdict(req.user, fid, 'annual.manage', db.getFirma(fid));
    return result;
  }));

  app.post('/api/annual-inventory-control', (req, res) => run(res, () => {
    const fid = activeId(req); const year = (req.body || {}).year || req.query.year;
    permissions.assert(req.user, fid, 'annual.manage', db.getFirma(fid));
    annualInventory.save(db.getFirma(fid), year, (req.body || {}).control, req.user);
    logAudit('inventar.anual.matrice', String(year), { req });
    db.save();
    return { ok: true, inventoryMatrix: annualInventory.evaluate(S(req), year) };
  }));

  app.post('/api/annual-inventory-control/approve', (req, res) => run(res, () => {
    const fid = activeId(req); const year = (req.body || {}).year || req.query.year;
    permissions.assert(req.user, fid, 'annual.manage', db.getFirma(fid));
    annualInventory.approve(S(req), year, req.user);
    logAudit('inventar.anual.aprobare', String(year), { req });
    db.save();
    return { ok: true, inventoryMatrix: annualInventory.evaluate(S(req), year) };
  }));

  app.post('/api/close-year', (req, res) => run(res, () => {
    const fid = activeId(req); permissions.assert(req.user, fid, 'annual.manage', db.getFirma(fid));
    const r = svc.closeYear(fid, req.query.year);
    if (!r.posted) return { ok: true, idempotent: !!r.idempotent,
      message: r.idempotent ? 'Închiderea anuală este deja consemnată.' : 'Nimic de închis; exercițiul a fost consemnat fără notă.',
      result: r.result, adjustmentPeriod: r.adjustmentPeriod };
    logAudit('inchidere.an', req.query.year, { req });
    return { ok: true, result: r.result, adjustmentPeriod: r.adjustmentPeriod };
  }));

  // Impozit pe profit — calcul cu ajustari fiscale (nedeductibile, deduceri, pierdere reportata) + 691 = 4411.
  const taxSrc = (req) => Object.assign({}, req.query, req.body || {});
  app.get('/api/profit-tax-preview', (req, res) => run(res, () => {
    const year = req.query.year || new Date().getFullYear();
    return acc.profitTax(S(req), year, svc.profitTaxOptions(activeId(req), taxSrc(req), year));
  }));
  app.post('/api/close-profit-tax', (req, res) => run(res, () => {
    const year = req.query.year || (req.body || {}).year;
    const fid = activeId(req); permissions.assert(req.user, fid, 'annual.manage', db.getFirma(fid));
    const r = svc.closeProfitTax(fid, taxSrc(req), year);
    if (!r.posted) return { ok: true, idempotent: !!r.idempotent,
      message: r.idempotent ? 'Impozitul pe profit anual este deja consemnat.' : 'Profit impozabil 0 sau pierdere — niciun impozit. Pierdere fiscala de reportat: ' + r.result.pierdereDeReportat + ' lei.',
      result: r.result, adjustmentPeriod: r.adjustmentPeriod };
    logAudit('impozit.profit', year + ': ' + r.result.impozit, { req });
    return { ok: true, result: r.result, adjustmentPeriod: r.adjustmentPeriod };
  }));

  // Repartizarea rezultatului: 121 -> 117 (profit) sau 117 -> 121 (pierdere)
  app.get('/api/distribute-preview', (req, res) => {
    res.json(acc.resultDistribution(S(req), req.query.year || String(new Date().getFullYear())));
  });
  app.post('/api/distribute-result', wrap(async (req, res) => {
    try {
      const year = req.query.year;
      const fid = activeId(req); permissions.assert(req.user, fid, 'annual.manage', db.getFirma(fid));
      const body = req.body || {};
      const r = svc.distributeResult(fid, year, body.data || req.query.data, body.aga);
      if (r.posted) logAudit('repartizare.rezultat', year + ' la ' + r.data + ', AGA nr. ' + r.aga.numar + ': '
        + (r.result.profit ? 'profit ' + r.result.profit : 'pierdere ' + r.result.pierdere), { req });
      let archive = null;
      try {
        const annual = annualClose.status(db.get(), S(req), year);
        if (annual.sePoateFinaliza) {
          const sealed = await dosarAnual.seal(db.get(), S(req), year, { uploadDir: db.UPLOAD_DIR,
            nextId: db.nextId, userId: req.user && req.user.id, username: req.user && req.user.username });
          if (sealed.created) { db.save(); logAudit('dosar.anual.sigilat', year + ' v' + sealed.row.version, { req }); }
          archive = { sealed: true, created: sealed.created, version: sealed.row.version, zipSha256: sealed.row.zipSha256 };
        }
      } catch (e) { archive = { sealed: false, error: e.message || String(e) }; }
      return res.json({ ok: true, idempotent: !!r.idempotent,
        message: r.posted ? undefined : (r.idempotent ? 'Repartizarea rezultatului este deja consemnată.' : 'Soldul contului 121 este zero — nimic de repartizat.'),
        result: r.result, data: r.data, aga: r.aga, archive });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }));
};
