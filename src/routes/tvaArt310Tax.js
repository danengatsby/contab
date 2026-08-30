'use strict';

const db = require('../db');
const permissions = require('../permissions');
const taxonomy = require('../tvaArt310');

function fail(status, message) { const error = new Error(message); error.status = status; throw error; }

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;
  const run = (res, fn) => {
    try { res.json(fn()); } catch (error) {
      if (!error.status) throw error;
      res.status(error.status).json({ error: error.message, code: error.code || undefined });
    }
  };

  app.get('/api/fiscal/tva-art310/taxonomy', (_req, res) => {
    res.json({ categories: taxonomy.clientCategories() });
  });

  app.patch('/api/entries/:id/fiscal-taxonomy/tva-art310', (req, res) => run(res, () => {
    const fid = activeId(req); const firma = db.getFirma(fid);
    permissions.assert(req.user, fid, 'fiscal.manage', firma);
    const entry = (db.get().entries || []).find((row) => Number(row.firmaId) === Number(fid)
      && String(row.id) === String(req.params.id));
    if (!entry) fail(404, 'Articolul contabil nu exista in firma activa.');

    const previous = entry.fiscalTaxonomy && entry.fiscalTaxonomy.tvaArt310 || null;
    const normalized = taxonomy.normalizeManual(req.body);
    const current = Object.assign({}, normalized, { classifiedAt: new Date().toISOString(),
      classifiedBy: req.user.id, classifiedByName: req.user.username || '' });
    entry.fiscalTaxonomy = Object.assign({}, entry.fiscalTaxonomy, { tvaArt310: current });
    entry.fiscalTaxonomyHistory = Array.isArray(entry.fiscalTaxonomyHistory) ? entry.fiscalTaxonomyHistory : [];
    entry.fiscalTaxonomyHistory.push({ tax: 'tva-art310', at: current.classifiedAt, by: req.user.id,
      byName: req.user.username || '', previous, current, reason: current.reason });
    db.save();
    logAudit('fiscal.tva-art310.taxonomy.updated', entry.id + ' · ' + current.category
      + ' · ' + current.amount + ' lei', { req, firmaId: fid });
    return { ok: true, entryId: entry.id, treatment: current,
      review: taxonomy.analyze(db.scoped(fid).entries, String(entry.period || entry.data || '').slice(0, 4)) };
  }));
};
