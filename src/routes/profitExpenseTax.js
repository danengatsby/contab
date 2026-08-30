'use strict';

const db = require('../db');
const permissions = require('../permissions');
const contract = require('../apiContract');
const taxonomy = require('../profitExpenseTaxonomy');

function fail(status, message) { const error = new Error(message); error.status = status; throw error; }

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;
  const run = (res, fn) => {
    try { res.json(fn()); } catch (error) {
      if (!error.status) throw error;
      res.status(error.status).json({ error: error.message, code: error.code || undefined, details: error.details || undefined });
    }
  };
  const context = (req) => {
    const fid = activeId(req); const firma = db.getFirma(fid);
    permissions.assert(req.user, fid, 'fiscal.manage', firma);
    return { fid, data: db.get() };
  };
  const findEntry = (state, id) => {
    const entry = (state.data.entries || []).find((row) => Number(row.firmaId) === Number(state.fid)
      && String(row.id) === String(id));
    if (!entry) fail(404, 'Articolul contabil nu exista in firma activa.');
    return entry;
  };

  app.get('/api/fiscal/profit-expense/taxonomy', (req, res) => {
    res.json({ accounts: taxonomy.ACCOUNTS, categories: taxonomy.clientCategories() });
  });

  app.patch('/api/entries/:id/fiscal-taxonomy/profit-expense', (req, res) => run(res, () => {
    const state = context(req); const entry = findEntry(state, req.params.id);
    contract.assertSchema(contract.schemas.ProfitExpenseTreatment, req.body, 'body');
    const normalized = taxonomy.normalizeItem(req.body, entry);
    for (const documentId of normalized.evidenceDocumentIds) {
      if (!(state.data.documents || []).some((doc) => Number(doc.firmaId) === Number(state.fid)
        && String(doc.id) === String(documentId))) {
        fail(400, 'Documentul justificativ ' + documentId + ' nu exista in firma activa.');
      }
    }
    const previousItems = entry.fiscalTaxonomy && entry.fiscalTaxonomy.profitExpense
      && Array.isArray(entry.fiscalTaxonomy.profitExpense.items)
      ? entry.fiscalTaxonomy.profitExpense.items : [];
    const previous = previousItems.find((item) => Number(item.lineIndex) === normalized.lineIndex
      && String(item.account) === normalized.account) || null;
    const current = Object.assign({}, normalized, { classifiedAt: new Date().toISOString(),
      classifiedBy: req.user.id, classifiedByName: req.user.username || '' });
    const items = previousItems.filter((item) => !(Number(item.lineIndex) === normalized.lineIndex
      && String(item.account) === normalized.account)).concat(current)
      .sort((a, b) => Number(a.lineIndex) - Number(b.lineIndex) || String(a.account).localeCompare(String(b.account)));
    entry.fiscalTaxonomy = Object.assign({}, entry.fiscalTaxonomy, { profitExpense: { version: 1, items } });
    entry.fiscalTaxonomyHistory = Array.isArray(entry.fiscalTaxonomyHistory) ? entry.fiscalTaxonomyHistory : [];
    entry.fiscalTaxonomyHistory.push({ tax: 'profit-expense', at: current.classifiedAt, by: req.user.id,
      byName: req.user.username || '', lineIndex: current.lineIndex, account: current.account,
      previous, current, reason: current.reason });
    db.save();
    logAudit('fiscal.profit-expense.taxonomy.updated', entry.id + ' · linia ' + current.lineIndex
      + ' · ' + current.account + ' · ' + current.category, { req });
    return { ok: true, entryId: entry.id, treatment: current,
      review: taxonomy.analyze(db.scoped(state.fid).entries, String(entry.period || entry.data || '').slice(0, 4)) };
  }));
};
