'use strict';

// Articole contabile — strat SUBTIRE peste src/entriesService.js: parseaza cererea, apeleaza
// serviciul (care valideaza, aplica gardele pe firma/perioada si scrie) si traduce erorile lui
// (`err.status`) in raspunsuri HTTP. Citirile raman pe vederea scoped (S). buildEntry si
// upsertPartner sunt infrastructura partajata (raman in server.js, folosite si de alte module)
// si se dau serviciului ca dependente.

const db = require('../db');
const acc = require('../accounting');
const recurring = require('../recurring');
const svc = require('../entriesService');
const { period: periodOf } = require('../util');

module.exports = function register(app, ctx) {
  const { S, activeId, canAccess, requireAdmin, logAudit, buildEntry, upsertPartner } = ctx;
  const deps = { buildEntry, upsertPartner };

  // Erorile de business poarta `status` (400/403/404); restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  app.post('/api/entries', (req, res) => run(res, () => {
    const r = svc.createEntry(activeId(req), req.body, deps);
    logAudit('entry.create', r.entry.tipNume + ' ' + (r.entry.document || ''), { req, firmaId: r.entry.firmaId });
    return { ok: true, entry: r.entry, stoc: r.stoc };
  }));

  app.get('/api/entries', (req, res) => {
    const { period } = req.query;
    let list = S(req).entries;
    if (period) list = list.filter((e) => (e.period || periodOf(e.data)) === period);
    res.json(acc.sortEntries(list));
  });

  app.delete('/api/entries/:id', (req, res) => run(res, () => {
    const r = svc.deleteEntry(req.params.id, activeId(req), (fid) => canAccess(req, fid));
    if (r.entry) logAudit('entry.delete', r.entry.tipNume + ' ' + (r.entry.document || ''), { req, firmaId: r.entry.firmaId });
    return { ok: true, removed: r.removed };
  }));

  // ───────────────────────── FACTURI RECURENTE ─────────────────────────
  app.get('/api/recurring', (req, res) => {
    const fid = activeId(req);
    res.json((db.get().recurringInvoices || []).filter((t) => t.firmaId === fid));
  });
  app.post('/api/recurring', (req, res) => run(res, () => {
    const r = svc.saveRecurring(activeId(req), req.body);
    logAudit('recurring.save', r.template.tip + ' (' + r.template.frecventa + ')', { req });
    return { ok: true, template: r.template };
  }));
  app.delete('/api/recurring/:id', (req, res) => run(res, () => {
    svc.deleteRecurring(activeId(req), req.params.id);
    logAudit('recurring.delete', req.params.id, { req });
    return { ok: true };
  }));
  app.get('/api/recurring/due', (req, res) => {
    const fid = activeId(req);
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    res.json({ period, due: recurring.dueForPeriod((db.get().recurringInvoices || []).filter((t) => t.firmaId === fid), period) });
  });
  app.post('/api/recurring/generate', (req, res) => run(res, () => {
    const r = svc.generateRecurring(activeId(req), req.query.period, deps);
    if (r.created.length) logAudit('recurring.generate', r.period + ': ' + r.created.length + ' generate', { req });
    return { ok: true, period: r.period, created: r.created.length, errors: r.errors, items: r.created };
  }));

  // Blocare/deblocare perioada (admin): seteaza luna pana la care e read-only (sau goleste pentru deblocare).
  app.post('/api/period-lock', requireAdmin, (req, res) => run(res, () => {
    const r = svc.setPeriodLock(activeId(req), (req.body || {}).lockedUntil);
    logAudit('perioada.lock', r.lockedUntil ? 'blocat pana la ' + r.lockedUntil : 'deblocat complet', { req });
    return { ok: true, lockedUntil: r.lockedUntil };
  }));

  // TVA la incasare: din suma bruta incasata/platita, calculeaza TVA exigibila si posteaza nota
  app.post('/api/tva-incasare/exigibilitate', (req, res) => run(res, () => {
    const r = svc.tvaExigibilitate(activeId(req), req.body, deps);
    logAudit('tva.exigibilitate', r.entry.tip + ' ' + r.tva, { req });
    return { ok: true, tva: r.tva, brut: r.brut, cota: r.cota, entry: r.entry };
  }));
};
