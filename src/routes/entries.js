'use strict';

// Articole contabile (entries): creare (cu descarcare automata de gestiune la CMP din liniile
// de stoc), listare, stergere (cu garda pe perioada inchisa), facturi recurente (sabloane +
// generare pe perioada), blocarea/deblocarea perioadei (admin) si TVA la incasare (exigibilitate).
// Modul de rute: register(app, ctx). buildEntry/upsertPartner sunt infrastructura partajata,
// primite prin ctx (raman in server.js, exportate si folosite de alte module).

const db = require('../db');
const coa = require('../chartOfAccounts');
const acc = require('../accounting');
const stocks = require('../stocks');
const recurring = require('../recurring');
const { round2, period: periodOf } = require('../util');

module.exports = function register(app, ctx) {
  const { S, activeId, canAccess, requireAdmin, logAudit, buildEntry, upsertPartner } = ctx;

  app.post('/api/entries', (req, res) => {
    const { tip, fields, fileId, spvMsgId } = req.body || {};
    const f = Object.assign({}, fields || {});
    const stocLines = Array.isArray(f.stoc) ? f.stoc.filter((s) => s && s.productId && Number(s.cantitate) > 0) : [];
    if (stocLines.length) f.cost = 0; // descarcarea vine din stoc (la CMP), nu din campul manual — evita dubla inregistrare
    let entry;
    try { entry = buildEntry(tip, f, fileId, activeId(req)); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (spvMsgId) entry.spvImport = { msgId: spvMsgId, at: new Date().toISOString() };
    const d = db.get();
    const fid = activeId(req);
    // Descarcare automata de gestiune din liniile de stoc (cost marfa vanduta la CMP)
    let stocInfo = null;
    if (stocLines.length) {
      const v = S(req);
      let r;
      try { r = stocks.saleCogs(v.products, v.stockMovements, stocLines, { fid, data: entry.data, document: entry.document, entryId: entry.id, nextId: () => db.nextId('sm') }); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      for (const ln of r.cogsLines) {
        if (!coa.getAccount(ln.debit) || !coa.getAccount(ln.credit)) return res.status(400).json({ error: 'Cont de descarcare inexistent in plan: ' + ln.debit + '/' + ln.credit });
      }
      for (const mv of r.newMovements) d.stockMovements.push(mv);
      for (const ln of r.cogsLines) entry.lines.push(ln);
      entry.stocMovementIds = r.newMovements.map((m) => m.id);
      stocInfo = { cogsTotal: r.total, warns: r.warns, movements: r.newMovements.length };
    }
    d.entries.push(entry);
    upsertPartner(fid, entry);
    logAudit('entry.create', entry.tipNume + ' ' + (entry.document || ''), { req, firmaId: entry.firmaId });
    db.save();
    res.json({ ok: true, entry, stoc: stocInfo });
  });

  app.get('/api/entries', (req, res) => {
    const { period } = req.query;
    let list = S(req).entries;
    if (period) list = list.filter((e) => (e.period || periodOf(e.data)) === period);
    res.json(acc.sortEntries(list));
  });

  // ───────────────────────── FACTURI RECURENTE ─────────────────────────
  app.get('/api/recurring', (req, res) => {
    const fid = activeId(req);
    res.json((db.get().recurringInvoices || []).filter((t) => t.firmaId === fid));
  });
  app.post('/api/recurring', (req, res) => {
    const b = req.body || {};
    if (!b.tip) return res.status(400).json({ error: 'Alege tipul de document.' });
    const d = db.get(); const fid = activeId(req);
    const t = b.id && (d.recurringInvoices || []).find((x) => x.id === b.id && x.firmaId === fid);
    const rec = t || { id: db.nextId('rec'), firmaId: fid, createdAt: new Date().toISOString() };
    Object.assign(rec, {
      tip: String(b.tip), partener: b.partener || '', cuiPartener: b.cuiPartener || '', document: b.document || '',
      fields: (b.fields && typeof b.fields === 'object') ? b.fields : {},
      frecventa: ['lunar', 'trimestrial', 'anual'].includes(b.frecventa) ? b.frecventa : 'lunar',
      ziua: Math.min(28, Math.max(1, Number(b.ziua) || 1)),
      startDate: /^\d{4}-\d{2}$/.test(b.startDate || '') ? b.startDate : new Date().toISOString().slice(0, 7),
      activ: b.activ != null ? !!b.activ : true,
    });
    if (!t) d.recurringInvoices.push(rec);
    logAudit('recurring.save', rec.tip + ' (' + rec.frecventa + ')', { req });
    db.save();
    res.json({ ok: true, template: rec });
  });
  app.delete('/api/recurring/:id', (req, res) => {
    const d = db.get(); const fid = activeId(req);
    d.recurringInvoices = (d.recurringInvoices || []).filter((t) => !(t.id === req.params.id && t.firmaId === fid));
    logAudit('recurring.delete', req.params.id, { req });
    db.save();
    res.json({ ok: true });
  });
  app.get('/api/recurring/due', (req, res) => {
    const fid = activeId(req);
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    res.json({ period, due: recurring.dueForPeriod((db.get().recurringInvoices || []).filter((t) => t.firmaId === fid), period) });
  });
  app.post('/api/recurring/generate', (req, res) => {
    const d = db.get(); const fid = activeId(req);
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    const due = recurring.dueForPeriod((d.recurringInvoices || []).filter((t) => t.firmaId === fid), period);
    const created = []; const errors = [];
    for (const t of due) {
      const fields = Object.assign({}, t.fields, {
        data: period + '-' + String(t.ziua || 1).padStart(2, '0'),
        partener: t.partener, cuiPartener: t.cuiPartener, document: t.document,
      });
      try {
        const entry = buildEntry(t.tip, fields, null, fid);
        entry.recurringId = t.id;
        d.entries.push(entry);
        upsertPartner(fid, entry);
        t.lastGenerated = period;
        created.push({ id: entry.id, tip: entry.tipNume, partener: t.partener });
      } catch (e) { errors.push((t.partener || t.tip) + ': ' + e.message); }
    }
    if (created.length) logAudit('recurring.generate', period + ': ' + created.length + ' generate', { req });
    db.save();
    res.json({ ok: true, period, created: created.length, errors, items: created });
  });

  app.delete('/api/entries/:id', (req, res) => {
    const d = db.get();
    const e = d.entries.find((x) => x.id === req.params.id);
    // izolare multi-firma: nu stergi inregistrari ale firmelor la care nu ai acces
    if (e && !canAccess(req, e.firmaId == null ? d.firmaActiva : e.firmaId)) return res.status(404).json({ error: 'Inregistrare inexistenta.' });
    if (e) {
      const firma = db.getFirma(e.firmaId == null ? activeId(req) : e.firmaId);
      const per = e.period || periodOf(e.data);
      if (firma && firma.lockedUntil && per <= firma.lockedUntil) {
        return res.status(400).json({ error: 'Inregistrarea e in perioada inchisa ' + per + ' (blocata pana la ' + firma.lockedUntil + '). Deblocheaza perioada (admin) inainte de stergere.' });
      }
    }
    const n = d.entries.length;
    d.entries = d.entries.filter((x) => x.id !== req.params.id);
    if (e) logAudit('entry.delete', e.tipNume + ' ' + (e.document || ''), { req, firmaId: e.firmaId });
    db.save();
    res.json({ ok: true, removed: n - d.entries.length });
  });

  // Blocare/deblocare perioada (admin): seteaza luna pana la care e read-only (sau goleste pentru deblocare).
  app.post('/api/period-lock', requireAdmin, (req, res) => {
    const firma = db.getFirma(activeId(req));
    if (!firma) return res.status(404).json({ error: 'Firma inexistenta.' });
    const v = (req.body || {}).lockedUntil;
    if (v == null || v === '') firma.lockedUntil = null;
    else if (/^\d{4}-\d{2}$/.test(v) && Number(v.slice(5)) >= 1 && Number(v.slice(5)) <= 12) firma.lockedUntil = v;
    else return res.status(400).json({ error: 'Format invalid. Foloseste YYYY-MM (ex. 2026-05) sau gol pentru deblocare.' });
    logAudit('perioada.lock', firma.lockedUntil ? 'blocat pana la ' + firma.lockedUntil : 'deblocat complet', { req });
    db.save();
    res.json({ ok: true, lockedUntil: firma.lockedUntil });
  });

  // TVA la incasare: din suma bruta incasata/platita, calculeaza TVA exigibila si posteaza nota
  app.post('/api/tva-incasare/exigibilitate', (req, res) => {
    const b = req.body || {};
    const brut = round2(Number(b.brut) || 0);
    const cota = Number(b.cota) || 0;
    if (brut <= 0 || cota <= 0) return res.status(400).json({ error: 'Completeaza suma bruta si cota TVA.' });
    const tva = round2((brut * cota) / (100 + cota));
    const tip = b.tip === 'deductibila' ? 'exigibilitate_tva_deductibila' : 'exigibilitate_tva_colectata';
    const data = b.data && String(b.data).length === 10 ? b.data : new Date().toISOString().slice(0, 10);
    const entry = buildEntry(tip, { data, partener: b.partener || '', document: b.document || '', tva }, null, activeId(req));
    entry.system = true;
    // baza aferenta TVA-ului devenit exigibil (pentru D300 in perioada exigibilitatii — TVA la incasare)
    entry.tvaExig = { baza: round2(brut - tva), cota, side: b.tip === 'deductibila' ? 'deductibila' : 'colectata' };
    const d = db.get();
    d.entries.push(entry);
    logAudit('tva.exigibilitate', tip + ' ' + tva, { req });
    db.save();
    res.json({ ok: true, tva, brut, cota, entry });
  });
};
