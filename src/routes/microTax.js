'use strict';

const crypto = require('crypto');
const db = require('../db');
const permissions = require('../permissions');
const micro = require('../impozitMicro');
const { validPeriod, round2 } = require('../util');
const contract = require('../apiContract');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function reasonOf(body) {
  const reason = String(body && body.reason || '').trim();
  if (reason.length < 5 || reason.length > 500) fail(400, 'Motivul trebuie sa aiba 5-500 caractere.');
  return reason;
}

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };
  const context = (req) => {
    const fid = activeId(req); const firma = db.getFirma(fid);
    permissions.assert(req.user, fid, 'fiscal.manage', firma);
    return { fid, firma, data: db.get() };
  };
  const findEntry = (state, id) => {
    const entry = (state.data.entries || []).find((e) => Number(e.firmaId == null ? state.data.firmaActiva : e.firmaId) === Number(state.fid)
      && String(e.id) === String(id));
    if (!entry) fail(404, 'Articolul contabil nu exista in firma activa.');
    return entry;
  };

  app.get('/api/fiscal/micro/taxonomy', (req, res) => {
    const v = db.scoped(activeId(req)); const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : null;
    const entries = v.entries.filter((e) => !year || String(e.period || e.data || '').startsWith(year));
    res.json({ categories: micro.TAXONOMY, rows: micro.taxonomyForEntries(entries) });
  });

  app.patch('/api/entries/:id/fiscal-taxonomy/micro', (req, res) => run(res, () => {
    const state = context(req); const entry = findEntry(state, req.params.id);
    contract.assertSchema(contract.schemas.MicroTaxonomy, req.body, 'body');
    const normalized = micro.normalizeTaxonomy(req.body, entry);
    const at = new Date().toISOString(); const previous = entry.fiscalTaxonomy && entry.fiscalTaxonomy.micro || null;
    entry.fiscalTaxonomy = Object.assign({}, entry.fiscalTaxonomy, { micro: normalized });
    entry.fiscalTaxonomyHistory = Array.isArray(entry.fiscalTaxonomyHistory) ? entry.fiscalTaxonomyHistory : [];
    entry.fiscalTaxonomyHistory.push({ tax: 'micro', at, by: req.user.id, byName: req.user.username || '',
      previous, current: normalized, reason: normalized.reason });
    db.save();
    logAudit('fiscal.micro.taxonomy.updated', entry.id + ' · ' + normalized.code + ' · ' + normalized.amount + ' lei', { req });
    return { ok: true, entryId: entry.id, taxonomy: normalized };
  }));

  app.delete('/api/entries/:id/fiscal-taxonomy/micro', (req, res) => run(res, () => {
    const state = context(req); const entry = findEntry(state, req.params.id); const reason = reasonOf(req.body);
    contract.assertSchema(contract.schemas.Reason, req.body, 'body');
    const previous = entry.fiscalTaxonomy && entry.fiscalTaxonomy.micro;
    if (!previous) fail(404, 'Articolul nu are taxonomie fiscala micro.');
    entry.fiscalTaxonomyHistory = Array.isArray(entry.fiscalTaxonomyHistory) ? entry.fiscalTaxonomyHistory : [];
    entry.fiscalTaxonomyHistory.push({ tax: 'micro', at: new Date().toISOString(), by: req.user.id,
      byName: req.user.username || '', previous, current: null, reason });
    delete entry.fiscalTaxonomy.micro;
    db.save();
    logAudit('fiscal.micro.taxonomy.removed', entry.id + ' · ' + reason, { req });
    return { ok: true, entryId: entry.id };
  }));

  app.get('/api/fiscal/micro/adjustments', (req, res) => {
    const firma = db.getFirma(activeId(req)); const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : null;
    const rows = (firma && Array.isArray(firma.microTaxAdjustments) ? firma.microTaxAdjustments : [])
      .filter((x) => !year || String(x.period).startsWith(year))
      .slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ rows, active: rows.filter((x) => x.active !== false) });
  });

  app.post('/api/fiscal/micro/adjustments', (req, res) => run(res, () => {
    const state = context(req); const body = req.body || {};
    contract.assertSchema(contract.schemas.MicroAdjustment, body, 'body');
    const period = String(body.period || '');
    if (!validPeriod(period)) fail(400, 'Perioada ajustarii trebuie sa fie YYYY-MM.');
    const direction = String(body.direction || '');
    if (!['add', 'subtract'].includes(direction)) fail(400, 'Sensul ajustarii trebuie sa fie add sau subtract.');
    const amount = round2(Number(body.amount));
    if (!(amount > 0) || amount > 1e12) fail(400, 'Suma ajustarii trebuie sa fie pozitiva.');
    const category = String(body.category || '').trim(); const legalBasis = String(body.legalBasis || '').trim();
    const reason = reasonOf(body);
    if (!category || category.length > 160) fail(400, 'Completeaza categoria ajustarii (maxim 160 caractere).');
    if (!legalBasis || legalBasis.length > 160) fail(400, 'Completeaza temeiul legal (maxim 160 caractere).');
    const entry = body.entryId ? findEntry(state, body.entryId) : null;
    if (entry && String(entry.period || entry.data || '').slice(0, 7) !== period) fail(400, 'Perioada ajustarii trebuie sa coincida cu perioada articolului legat.');
    state.firma.microTaxAdjustments = Array.isArray(state.firma.microTaxAdjustments) ? state.firma.microTaxAdjustments : [];
    const row = { id: 'mta-' + crypto.randomUUID(), period, entryId: entry && entry.id || null,
      direction, amount, category, legalBasis, reason, active: true, createdAt: new Date().toISOString(),
      createdBy: req.user.id, createdByName: req.user.username || '' };
    state.firma.microTaxAdjustments.push(row); db.save();
    logAudit('fiscal.micro.adjustment.created', row.id + ' · ' + period + ' · ' + direction + ' ' + amount + ' lei', { req });
    return { ok: true, adjustment: row };
  }));

  app.post('/api/fiscal/micro/adjustments/:id/revoke', (req, res) => run(res, () => {
    const state = context(req); const reason = reasonOf(req.body);
    contract.assertSchema(contract.schemas.Reason, req.body, 'body');
    const row = (state.firma.microTaxAdjustments || []).find((x) => String(x.id) === String(req.params.id));
    if (!row) fail(404, 'Ajustarea fiscala nu exista.');
    if (row.active === false) return { ok: true, adjustment: row, idempotent: true };
    row.active = false; row.revokedAt = new Date().toISOString(); row.revokedBy = req.user.id;
    row.revokedByName = req.user.username || ''; row.revokeReason = reason;
    db.save();
    logAudit('fiscal.micro.adjustment.revoked', row.id + ' · ' + reason, { req });
    return { ok: true, adjustment: row, idempotent: false };
  }));
};
