'use strict';

// Suprafața operațională a motorului fiscal: registrele persistente sunt administrate separat,
// iar evaluarea este read-only și întoarce decizia verificabilă, fără să posteze nimic.

const db = require('../db');
const fiscal = require('../fiscal');
const facts = require('../fiscalFacts');
const policies = require('../fiscalAutonomyPolicy');
const fiscalProfile = require('../fiscalProfile');
const permissions = require('../permissions');
const contract = require('../apiContract');

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;
  function actor(req, fid) {
    return { actorId: req.user && req.user.id, username: req.user && req.user.username,
      role: permissions.roleFor(req.user, fid, db.getFirma(fid)) || '' };
  }
  function manage(req, res, fid) {
    try { permissions.assert(req.user, fid, 'fiscal.manage', db.getFirma(fid)); return true; }
    catch (e) { res.status(e.status || 403).json({ error: e.message, permission: e.permission }); return false; }
  }

  app.get('/api/fiscal-engine/facts', (req, res) => {
    const fid = activeId(req); const subject = String(req.query.subject || ''); const key = String(req.query.key || '');
    const rows = (db.get().fiscalFacts || []).filter((row) => String(row.firmaId) === String(fid)
      && (!subject || row.subject === subject) && (!key || row.key === key));
    const asOf = String(req.query.asOf || '');
    return res.json({ rows, resolution: asOf && key ? facts.resolve(rows, {
      firmaId: fid, subject: subject || 'company', key, asOf,
    }) : null });
  });

  app.post('/api/fiscal-engine/facts', (req, res) => {
    const fid = activeId(req); if (!manage(req, res, fid)) return;
    try {
      contract.assertSchema(contract.schemas.FiscalFactInput, req.body || {});
      const rec = facts.append(db.get(), Object.assign({}, req.body || {}, {
        firmaId: fid, recordedBy: actor(req, fid),
      }), { nextId: db.nextId });
      logAudit('fiscal.fact.recorded', rec.key + ' · ' + rec.subject + ' · ' + rec.hash, { req });
      db.save(); return res.status(201).json({ fact: rec });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  });

  app.get('/api/fiscal-engine/autonomy-policy', (req, res) => {
    const fid = activeId(req); const at = new Date(req.query.at || new Date().toISOString()).toISOString();
    const rows = (db.get().fiscalAutonomyPolicies || []).filter((row) => String(row.firmaId) === String(fid));
    return res.json({ rows, active: policies.activeFor(db.get(), fid, at) });
  });

  app.post('/api/fiscal-engine/autonomy-policy', (req, res) => {
    const fid = activeId(req); if (!manage(req, res, fid)) return;
    try {
      contract.assertSchema(contract.schemas.FiscalAutonomyPolicyInput, req.body || {});
      const policy = policies.append(db.get(), Object.assign({}, req.body || {}, {
        firmaId: fid, authorizedBy: actor(req, fid), authorizedAt: new Date().toISOString(),
      }), { nextId: db.nextId });
      logAudit('fiscal.autonomy-policy.authorized', policy.id + ' v' + policy.version + ' · ' + policy.hash, { req });
      db.save(); return res.status(201).json({ policy });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  });

  app.post('/api/fiscal-engine/evaluate', (req, res) => {
    const fid = activeId(req); const body = req.body || {}; const asOf = String(body.asOf || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !String(body.ruleId || '').trim()) {
      return res.status(400).json({ error: 'Evaluarea cere ruleId și data asOf (YYYY-MM-DD).' });
    }
    try {
      contract.assertSchema(contract.schemas.FiscalEvaluationInput, body);
      const at = new Date().toISOString();
      const policy = policies.activeFor(db.get(), fid, at);
      const graph = db.get(); const company = db.getFirma(fid);
      const profileSnapshot = fiscalProfile.declarationSnapshot({ company, firmaId: fid,
        fiscalProfileHistory: graph.fiscalProfileHistory || [] }, asOf, {
        angajati: (graph.angajati || []).filter((row) => String(row.firmaId) === String(fid)),
      });
      const decision = fiscal.evaluateTreatmentForAutonomy(asOf, String(body.ruleId), {}, {
        factRegistry: graph.fiscalFacts || [], firmaId: fid,
        factSubject: String(body.subject || 'company'), asOf,
        autonomyPolicy: policy,
        autonomyContext: { at, operation: String(body.operation || body.ruleId),
          partnerId: String(body.partnerId || ''),
          documentType: String(body.documentType || ''), documents: body.documents || [],
          dependencies: { fiscalProfileHash: profileSnapshot.hash } },
      });
      return res.json({ decision });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  });

  app.post('/api/fiscal-engine/counterfactual', (req, res) => {
    const fid = activeId(req); const body = req.body || {}; const asOf = String(body.asOf || '');
    const change = body.change || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !String(body.ruleId || '').trim()
        || !String(change.fact || '').trim() || !Object.prototype.hasOwnProperty.call(change, 'value')) {
      return res.status(400).json({ error: 'Analiza contrafactuală cere ruleId, asOf și change { fact, value }.' });
    }
    try {
      contract.assertSchema(contract.schemas.FiscalCounterfactualInput, body);
      const options = { factRegistry: db.get().fiscalFacts || [], firmaId: fid,
        factSubject: String(body.subject || 'company'), asOf };
      const baseline = fiscal.evaluateTreatment(asOf, String(body.ruleId), {}, options);
      if (!baseline.result || baseline.resultStatus === 'NEDETERMINABIL') {
        return res.status(422).json({ error: 'Analiza contrafactuală cere o decizie de bază determinabilă.',
          code: 'FISCAL_COUNTERFACTUAL_BASELINE_UNDETERMINED', decision: baseline });
      }
      const counterfactual = fiscal.counterfactualTreatment(asOf, String(body.ruleId), baseline.facts,
        { fact: String(change.fact), value: change.value }, { factEvidence: baseline.factEvidence });
      return res.json({ baselineDecisionId: baseline.decisionId, counterfactual });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  });
};
