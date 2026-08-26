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
const { sendList, ABS_MAX } = require('../paginate');
const { period: periodOf } = require('../util');

module.exports = function register(app, ctx) {
  const { S, activeId, canAccess, requireAdmin, logAudit, buildEntry, composeEntry, upsertPartner } = ctx;
  const deps = (req) => ({
    buildEntry, upsertPartner, actor: req.user,
    // `db.pushEntry` cere explicit aceasta dovada pentru orice override. Callback-ul scrie in
    // jurnalul durabil fail-closed; absenta/esecul lui opreste postarea, nu doar auditul.
    auditDuplicateOverride: (info) => logAudit('entry.duplicate.override', JSON.stringify({
      entryId: info.entryId, duplicateId: info.duplicateId,
      duplicateDocument: info.duplicateDocument, keys: info.keys, reason: info.reason,
    }), { req, firmaId: info.firmaId }),
  });

  // Previzualizarea articolului din formular, INAINTE de salvare. Trece prin exact aceeasi
  // compunere ca salvarea (composeEntry), deci arata si regulile pe care o replica in frontend
  // nu le putea sti: auto50, pro-rata firmei, TVA la incasare, conturile inexistente in plan,
  // perioada blocata. Nu scrie nimic si nu consuma un id.
  app.post('/api/preview', (req, res) => {
    const { tip, fields } = req.body || {};
    if (!tip) return res.status(400).json({ error: 'Lipseste tipul de document.' });
    let e;
    try {
      e = composeEntry(tip, fields || {}, null, activeId(req));
    } catch (err) {
      // Un articol inca incomplet NU e o eroare: e starea normala cat timp se completeaza
      // formularul. Raspundem 200 cu motivul, ca sa nu poluam metricile la fiecare tasta.
      return res.json({ ok: false, mesaj: err.message });
    }
    const total = e.lines.reduce((s, l) => s + l.suma, 0);
    return res.json({ ok: true, tipNume: e.tipNume, lines: e.lines, total: Math.round(total * 100) / 100 });
  });

  // Erorile de business poarta `status` (400/403/404); restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({
        error: e.message,
        ...(e.code ? { code: e.code } : {}),
        ...(e.duplicateId ? { duplicateId: e.duplicateId } : {}),
        ...(Array.isArray(e.duplicateKeys) ? { duplicateKeys: e.duplicateKeys } : {}),
      });
    }
  };

  app.post('/api/entries', (req, res) => run(res, () => {
    const r = svc.createEntry(activeId(req), req.body, deps(req));
    logAudit('entry.create', r.entry.tipNume + ' ' + (r.entry.document || ''), { req, firmaId: r.entry.firmaId });
    return { ok: true, entry: r.entry, stoc: r.stoc };
  }));

  app.get('/api/entries', (req, res) => {
    // ?period=YYYY-MM (luna exacta) sau ?period=YYYY (tot anul). Fara parametru intoarce tot —
    // compatibil, dar clientul cere pe ANI (la volume mari, "tot" inseamna zeci de MB).
    const { period } = req.query;
    let list = S(req).entries;
    if (period) {
      const anual = /^\d{4}$/.test(period);
      list = list.filter((e) => {
        const p = e.period || periodOf(e.data);
        return anual ? String(p).startsWith(period + '-') : p === period;
      });
    }
    // period-scoping e mecanismul principal (clientul cere pe an/luna); sendList adauga garda de
    // OOM (plafon absolut) + paginare optionala ?limit/?offset pentru cine cere colectia intreaga.
    sendList(req, res, acc.sortEntries(list), { label: '/api/entries' });
  });

  app.delete('/api/entries/:id', (req, res) => run(res, () => {
    const r = svc.deleteEntry(req.params.id, activeId(req), (fid) => canAccess(req, fid));
    // in spiritul jurnalului append-only: stergerea (permisa doar in perioade deschise)
    // pastreaza in audit INTREAGA inregistrare — reconstructibila, nu doar un titlu
    if (r.entry) logAudit('entry.delete', r.entry.tipNume + ' ' + (r.entry.document || '') + ' :: ' + JSON.stringify(r.entry), { req, firmaId: r.entry.firmaId });
    return { ok: true, removed: r.removed };
  }));

  // STORNO generic: corectie reversibila a oricarui articol (reversare debit<->credit, legata),
  // intr-o perioada deschisa. Alternativa DOCUMENTATA la stergere pentru date deja postate.
  app.post('/api/entries/:id/storno', (req, res) => run(res, () => {
    const r = svc.stornoEntry(req.params.id, activeId(req), (fid) => canAccess(req, fid), (req.body || {}).data, req.user);
    logAudit('entry.storno', 'articol ' + r.original.id + ' (' + r.original.tipNume + ' ' + (r.original.document || '') + ') -> nota storno ' + r.storno.id, { req, firmaId: r.storno.firmaId });
    return { ok: true, storno: r.storno, original: { id: r.original.id, stornat: true, stornoBy: r.storno.id } };
  }));

  // Tranzitie de stare in fluxul contabil: ciorna -> validat -> aprobat -> postat (POST {status}).
  // Doar articolele postate intra in contabilitate; postarea verifica perioada deschisa.
  app.post('/api/entries/:id/status', (req, res) => run(res, () => {
    const r = svc.setEntryStatus(req.params.id, activeId(req), (fid) => canAccess(req, fid), (req.body || {}).status, req.user);
    logAudit('entry.status', 'articol ' + r.entry.id + ' -> ' + r.status, { req, firmaId: r.entry.firmaId });
    return { ok: true, id: r.entry.id, status: r.status };
  }));

  // ───────────────────────── FACTURI RECURENTE ─────────────────────────
  app.get('/api/recurring', (req, res) => {
    const fid = activeId(req);
    sendList(req, res, (db.get().recurringInvoices || []).filter((t) => t.firmaId === fid), { label: 'recurring' });
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
    // Colectia e ambalata intr-un obiect ({ period, due }), deci nu poate trece prin sendList
    // fara sa schimbe forma raspunsului. Plafonam lista cu ACELASI plafon si semnalam taierea.
    const due = recurring.dueForPeriod((db.get().recurringInvoices || []).filter((t) => t.firmaId === fid), period);
    if (due.length > ABS_MAX) res.setHeader('X-Rows-Truncated', String(due.length));
    res.json({ period, due: due.slice(0, ABS_MAX) });
  });
  app.post('/api/recurring/generate', (req, res) => run(res, () => {
    const r = svc.generateRecurring(activeId(req), req.query.period, deps(req));
    if (r.created.length) logAudit('recurring.generate', r.period + ': ' + r.created.length + ' generate', { req });
    return { ok: true, period: r.period, created: r.created.length, errors: r.errors, items: r.created };
  }));

  // Blocare/deblocare perioada (admin): seteaza luna pana la care e read-only (sau goleste pentru deblocare).
  app.post('/api/period-lock', requireAdmin, (req, res) => run(res, () => {
    const b = req.body || {};
    const r = svc.setPeriodLock(activeId(req), b.lockedUntil, b.motiv);
    logAudit(r.override ? 'perioada.override' : 'perioada.lock',
      (r.lockedUntil ? 'blocat pana la ' + r.lockedUntil : 'deblocat complet')
      + (r.override ? ' — motiv: ' + r.motiv : ''), { req });
    return { ok: true, lockedUntil: r.lockedUntil, override: r.override };
  }));

  // TVA la incasare: din suma bruta incasata/platita, calculeaza TVA exigibila si posteaza nota
  app.post('/api/tva-incasare/exigibilitate', (req, res) => run(res, () => {
    const r = svc.tvaExigibilitate(activeId(req), req.body, deps(req));
    logAudit('tva.exigibilitate', r.entry.tip + ' ' + r.tva, { req });
    return { ok: true, tva: r.tva, brut: r.brut, cota: r.cota, entry: r.entry };
  }));
};
