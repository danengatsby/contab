'use strict';

const db = require('../db');
const permissions = require('../permissions');
const classification = require('../cashFlowClassification');
const contract = require('../apiContract');

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;

  app.get('/api/cash-flow/classification', (req, res) => {
    const firma = db.getFirma(activeId(req));
    res.json({
      categories: classification.CATEGORIES,
      defaults: classification.DEFAULT_RULES,
      config: classification.normalizeConfig(firma && firma.cashFlowClassification),
    });
  });

  app.put('/api/cash-flow/classification', (req, res) => {
    try {
      const fid = activeId(req); const firma = db.getFirma(fid);
      permissions.assert(req.user, fid, 'treasury.approve', firma);
      contract.assertSchema(contract.schemas.CashFlowClassification, req.body, 'body');
      const config = classification.normalizeConfig(req.body);
      firma.cashFlowClassification = config;
      db.save();
      logAudit('cashflow.classification.updated', config.rules.length + ' reguli · prag '
        + config.materialityAmount + ' lei / ' + config.materialityPercent + '%', { req });
      res.json({ ok: true, config });
    } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  });
};
