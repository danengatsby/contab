'use strict';

const service = require('../microEligibilityService');
const contract = require('../apiContract');

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message, code: e.code || undefined, blockers: e.blockers || undefined });
    }
  };

  app.get('/api/fiscal/micro/eligibility', (req, res) => run(res,
    () => service.get(activeId(req), req.query.period || req.query.year)));

  app.put('/api/fiscal/micro/eligibility', (req, res) => run(res, () => {
    contract.assertSchema(contract.schemas.MicroEligibilityRevision, req.body, 'body');
    const result = service.save(activeId(req), req.body, req.user);
    logAudit('fiscal.micro.eligibility.revision', result.revision.id + ' · SHA-256 '
      + result.revision.hash + ' · ' + result.revision.reason, { req });
    return Object.assign({ ok: true }, result);
  }));
};
