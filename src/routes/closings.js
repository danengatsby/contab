'use strict';

// Inchideri fiscale — strat SUBTIRE peste src/closingsService.js: parseaza cererea, apeleaza
// serviciul si traduce erorile lui (`err.status`) in raspunsuri HTTP. Serviciul intoarce
// `posted`; mesajele istorice de no-op si auditul (doar cand s-a scris o nota) raman aici.
// Preview-urile (citiri pure) apeleaza direct modulul contabil.

const acc = require('../accounting');
const svc = require('../closingsService');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  // Erorile de business poarta `status` (400/403); restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  app.post('/api/close-vat', (req, res) => run(res, () => {
    const r = svc.closeVat(activeId(req), req.query.period);
    logAudit('inchidere.tva', req.query.period + ' (perioada blocata)', { req });
    return { ok: true, result: r.result, lockedUntil: r.lockedUntil, message: r.posted ? undefined : 'Fara TVA de regularizat; perioada a fost blocata.' };
  }));

  app.post('/api/close-year', (req, res) => run(res, () => {
    const r = svc.closeYear(activeId(req), req.query.year);
    if (!r.posted) return { ok: true, message: 'Nimic de inchis.', result: r.result };
    logAudit('inchidere.an', req.query.year, { req });
    return { ok: true, result: r.result };
  }));

  // Impozit pe profit — calcul cu ajustari fiscale (nedeductibile, deduceri, pierdere reportata) + 691 = 4411.
  const taxSrc = (req) => Object.assign({}, req.query, req.body || {});
  app.get('/api/profit-tax-preview', (req, res) => run(res, () => {
    const year = req.query.year || new Date().getFullYear();
    return acc.profitTax(S(req), year, svc.profitTaxOptions(activeId(req), taxSrc(req), year));
  }));
  app.post('/api/close-profit-tax', (req, res) => run(res, () => {
    const year = req.query.year || (req.body || {}).year;
    const r = svc.closeProfitTax(activeId(req), taxSrc(req), year);
    if (!r.posted) return { ok: true, message: 'Profit impozabil 0 sau pierdere — niciun impozit. Pierdere fiscala de reportat: ' + r.result.pierdereDeReportat + ' lei.', result: r.result };
    logAudit('impozit.profit', year + ': ' + r.result.impozit, { req });
    return { ok: true, result: r.result };
  }));

  // Repartizarea rezultatului: 121 -> 117 (profit) sau 117 -> 121 (pierdere)
  app.get('/api/distribute-preview', (req, res) => {
    res.json(acc.resultDistribution(S(req), req.query.year || String(new Date().getFullYear())));
  });
  app.post('/api/distribute-result', (req, res) => run(res, () => {
    const year = req.query.year;
    const r = svc.distributeResult(activeId(req), year);
    if (!r.posted) return { ok: true, message: 'Soldul contului 121 este zero — nimic de repartizat.', result: r.result };
    logAudit('repartizare.rezultat', year + ' ' + (r.result.profit ? 'profit ' + r.result.profit : 'pierdere ' + r.result.pierdere), { req });
    return { ok: true, result: r.result };
  }));
};
