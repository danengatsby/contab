'use strict';

const db = require('../db');
const openItems = require('../openItems');
const { validIsoDate } = require('../util');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;
  const run = (res, fn) => { try { res.json(fn()); } catch (e) { if (!e.status) throw e; res.status(e.status).json({ error: e.message }); } };

  app.get('/api/open-items', (req, res) => run(res, () => {
    const r = openItems.registry(S(req), req.query.asOf || null);
    let rows = req.query.all === '1' ? r.documents : r.openDocuments;
    if (req.query.sens === 'creanta' || req.query.sens === 'datorie') rows = rows.filter((x) => x.sens === req.query.sens);
    if (req.query.status) rows = rows.filter((x) => x.status === req.query.status);
    // Corpul pastreaza totalurile si controlul; paginarea listei se aplica manual pentru acelasi
    // contract ca sendList, fara sa pierdem metadatele registrului intr-un array gol.
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 10000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    return { asOf: r.asOf, totals: r.totals, problems: r.problems, count: rows.length,
      documents: rows.slice(offset, offset + limit), payments: r.openPayments, allocations: r.allocations };
  }));

  app.get('/api/open-items/reconciliation', (req, res) => run(res, () => {
    const control = openItems.ledgerReconciliation(S(req), req.query.asOf || null);
    const history = (S(req).openItemReconciliations || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 31);
    return { ...control, history };
  }));

  // Metadatele economice ale creantei/datoriei nu schimba articolul contabil; pot fi completate
  // si dupa blocarea lunii, dar fiecare versiune ramane pe articol si in audit.
  app.patch('/api/open-items/:entryId', (req, res) => run(res, () => {
    const b = req.body || {}; const d = db.get(); const fid = activeId(req);
    const entry = (d.entries || []).find((e) => Number(e.firmaId) === Number(fid) && String(e.id) === String(req.params.entryId));
    if (!entry) { const e = new Error('Document inexistent.'); e.status = 404; throw e; }
    const exists = openItems.registry(S(req), null).documents.some((x) => String(x.id) === String(entry.id));
    if (!exists) { const e = new Error('Articolul nu genereaza o creanta sau datorie in registrul documentelor deschise.'); e.status = 400; throw e; }
    const old = Object.assign({}, entry.openItem || {});
    const dueDate = b.dueDate == null ? (old.dueDate || '') : String(b.dueDate || '');
    if (dueDate && !validIsoDate(dueDate)) { const e = new Error('Scadenta trebuie sa fie o data calendaristica reala YYYY-MM-DD.'); e.status = 400; throw e; }
    // PATCH inseamna modificare partiala: absenta campului pastreaza valoarea existenta; sirul
    // gol o sterge explicit. Varianta veche transforma ambele cazuri in null si pierdea termenul
    // contractual cand utilizatorul schimba doar litigiul sau scadenta.
    const term = !Object.prototype.hasOwnProperty.call(b, 'contractualTermDays')
      ? (old.contractualTermDays == null ? null : Number(old.contractualTermDays))
      : (b.contractualTermDays === '' || b.contractualTermDays === null ? null : Number(b.contractualTermDays));
    if (term != null && (!Number.isInteger(term) || term < 0 || term > 36500)) { const e = new Error('Termenul contractual trebuie sa fie intre 0 si 36500 de zile.'); e.status = 400; throw e; }
    if (b.disputeSince != null && b.disputeSince !== '' && !validIsoDate(String(b.disputeSince))) {
      const e = new Error('Data inceperii litigiului trebuie sa fie YYYY-MM-DD.'); e.status = 400; throw e;
    }
    const probability = !Object.prototype.hasOwnProperty.call(b, 'collectionProbability')
      ? (old.collectionProbability == null ? null : Number(old.collectionProbability))
      : (b.collectionProbability === '' || b.collectionProbability === null ? null : Number(b.collectionProbability));
    if (probability != null && (!Number.isFinite(probability) || probability < 0 || probability > 100)) {
      const e = new Error('Probabilitatea de încasare trebuie să fie între 0 și 100%.'); e.status = 400; throw e;
    }
    const forecastDelayDays = !Object.prototype.hasOwnProperty.call(b, 'forecastDelayDays')
      ? (Number(old.forecastDelayDays) || 0) : Number(b.forecastDelayDays || 0);
    if (!Number.isInteger(forecastDelayDays) || forecastDelayDays < 0 || forecastDelayDays > 365) {
      const e = new Error('Întârzierea estimată trebuie să fie un număr întreg între 0 și 365 zile.'); e.status = 400; throw e;
    }
    const tri = (value, old) => value === true ? true : value === false ? false : value === null ? null : old;
    const next = Object.assign({}, old, {
      dueDate: dueDate || null, dueSource: dueDate ? (b.dueSource || old.dueSource || 'manual') : null,
      contractualTermDays: term,
      dispute: tri(b.dispute, old.dispute),
      disputeSince: b.disputeSince ? String(b.disputeSince) : (b.dispute === false ? null : old.disputeSince || null),
      disputeReference: b.disputeReference == null ? String(old.disputeReference || '') : String(b.disputeReference).slice(0, 200),
      affiliated: tri(b.affiliated, old.affiliated), guaranteed: tri(b.guaranteed, old.guaranteed),
      guaranteeDetails: b.guaranteeDetails == null ? String(old.guaranteeDetails || '') : String(b.guaranteeDetails).slice(0, 300),
      collectionProbability: probability, forecastDelayDays,
      updatedAt: new Date().toISOString(), updatedBy: req.user && req.user.id || null,
    });
    const comparable = (x) => JSON.stringify(Object.assign({}, x, { updatedAt: undefined, updatedBy: undefined }));
    if (comparable(old) === comparable(next)) return { ok: true, idempotent: true, openItem: old };
    const reason = String(b.reason || '').trim();
    if (reason.length < 5) { const e = new Error('Modificarea scadentei sau a incadrarii creantei cere un motiv (minimum 5 caractere).'); e.status = 400; throw e; }
    entry.openItemHistory = Array.isArray(entry.openItemHistory) ? entry.openItemHistory : [];
    entry.openItemHistory.push({ at: next.updatedAt, by: next.updatedBy, username: req.user && req.user.username || '', reason: reason.slice(0, 300), old, next });
    entry.openItem = next;
    logAudit('open-item.metadata', entry.id + ' ' + (entry.document || '') + ' — ' + reason.slice(0, 300), { req, firmaId: fid });
    db.save();
    return { ok: true, openItem: next };
  }));

  // Inlocuieste SETUL de alocari explicite al unei plati. Implementarea este append-only:
  // versiunile vechi se revoca, nu se sterg, iar retry-ul identic nu mai scrie/auditeaza.
  app.post('/api/open-items/allocate', (req, res) => run(res, () => {
    const b = req.body || {}; const fid = activeId(req); const d = db.get();
    let requested = Array.isArray(b.allocations) ? b.allocations : [];
    if (!requested.length && Array.isArray(b.invoiceIds)) requested = b.invoiceIds.map((id) => ({ documentId: String(id), amount: null }));
    const r = openItems.replaceAllocations(d, fid, String(b.paymentId || ''), requested, req.user, db.nextId);
    if (!r.idempotent) {
      logAudit('open-item.allocate', String(b.paymentId) + ' -> ' + r.allocations.map((a) => a.documentId + ':' + a.amount).join(', '), { req, firmaId: fid });
      db.save();
    }
    return { ok: true, idempotent: !!r.idempotent, paymentId: String(b.paymentId || ''), allocations: r.allocations };
  }));

  app.get('/api/open-items/:entryId/history', (req, res) => run(res, () => {
    const entry = (db.get().entries || []).find((e) => Number(e.firmaId) === Number(activeId(req))
      && String(e.id) === String(req.params.entryId));
    if (!entry) { const e = new Error('Document inexistent.'); e.status = 404; throw e; }
    return { entryId: entry.id, current: entry.openItem || null,
      versions: Array.isArray(entry.openItemHistory) ? entry.openItemHistory.slice().reverse() : [] };
  }));
};
