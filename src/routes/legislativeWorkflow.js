'use strict';

const db = require('../db');
const workflow = require('../legislativeWorkflow');
const fiscal = require('../fiscal');

module.exports = function register(app, ctx) {
  const { requireAdmin, logAudit } = ctx;
  const human = (req) => ({ actorId: req.user && req.user.id,
    username: req.user && req.user.username, role: 'administrator', kind: 'human' });

  app.get('/api/legislative-workflow', requireAdmin, (req, res) => {
    return res.json({ stages: workflow.STAGES, rows: db.get().legislativeChanges || [] });
  });

  app.post('/api/legislative-workflow/detect', requireAdmin, (req, res) => {
    try {
      const rec = workflow.create(db.get(), Object.assign({}, req.body || {}, { actor: human(req) }),
        { nextId: db.nextId });
      logAudit('fiscal.legislation.detected', rec.id + ' · ' + rec.chainHash, { req, firmaId: null });
      db.save(); return res.status(201).json({ change: rec });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  });

  app.post('/api/legislative-workflow/advance', requireAdmin, (req, res) => {
    const body = req.body || {};
    const rec = (db.get().legislativeChanges || []).find((row) => String(row.id) === String(body.id || ''));
    if (!rec) return res.status(404).json({ error: 'Dosarul legislativ nu există.' });
    try {
      if (String(body.stage || '') === 'published') {
        const publication = body.evidence && body.evidence.publication || {};
        const ruleSet = fiscal.ruleSetById(String(publication.ruleSetId || ''));
        if (!ruleSet || ruleSet.hash !== String(publication.ruleSetHash || '')
            || ruleSet.validFrom !== String(publication.validFrom || '')) {
          const error = new Error('Publicarea cere un FiscalRuleSet deja înregistrat, cu același hash și interval.');
          error.status = 409; error.code = 'LEGISLATIVE_RULESET_NOT_REGISTERED'; throw error;
        }
      }
      const event = workflow.advance(rec, String(body.stage || ''), body.evidence, human(req));
      logAudit('fiscal.legislation.' + event.stage, rec.id + ' · ' + event.hash, { req, firmaId: null });
      db.save(); return res.json({ change: rec, event });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  });
};
