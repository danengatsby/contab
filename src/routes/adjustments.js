'use strict';

// Evaluari si ajustari de sfarsit de perioada: buget vs realizat, reevaluarea valutara a
// soldurilor in valuta (diferente de curs), ajustarea pentru deprecierea creantelor vechi
// (provizion 6814=491 / reluare 491=7814) si scoaterea din evidenta a creantelor neincasabile
// (654=4111 + reluarea ajustarii). Modul de rute: register(app, ctx).

const db = require('../db');
const coa = require('../chartOfAccounts');
const acc = require('../accounting');
const rep = require('../reporting');
const fxreval = require('../fxreval');
const { aging } = require('../analytic');
const { round2, period: periodOf } = require('../util');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  // ── Buget vs realizat ──
  app.get('/api/budgets', (req, res) => {
    const fid = activeId(req); const year = req.query.year;
    sendList(req, res, (db.get().budgets || []).filter((t) => t.firmaId === fid && (!year || String(t.an) === String(year))), { label: 'budgets' });
  });
  app.post('/api/budgets', (req, res) => {
    const b = req.body || {}; const cont = String(b.cont || '').trim();
    if (!coa.getAccount(cont)) return res.status(400).json({ error: 'Cont inexistent in plan: ' + cont });
    const an = String(b.an || new Date().getFullYear());
    const d = db.get(); const fid = activeId(req);
    const t = (d.budgets || []).find((x) => x.firmaId === fid && String(x.an) === an && x.cont === cont);
    const rec = t || { id: db.nextId('bud'), firmaId: fid, an, cont };
    rec.an = an; rec.cont = cont; rec.suma = round2(Number(b.suma) || 0);
    if (!t) d.budgets.push(rec);
    logAudit('buget.save', an + ' ' + cont + ': ' + rec.suma, { req });
    db.save();
    res.json({ ok: true, budget: rec });
  });
  app.delete('/api/budgets/:id', (req, res) => {
    const d = db.get(); const fid = activeId(req);
    d.budgets = (d.budgets || []).filter((t) => !(t.id === req.params.id && t.firmaId === fid));
    logAudit('buget.delete', req.params.id, { req });
    db.save();
    res.json({ ok: true });
  });
  app.get('/api/budget-report', (req, res) => {
    const fid = activeId(req); const year = req.query.year || String(new Date().getFullYear());
    const budgets = (db.get().budgets || []).filter((t) => t.firmaId === fid && String(t.an) === String(year));
    res.json(rep.budgetReport(S(req), budgets, year));
  });

  // ── Reevaluare valutara la sfarsit de perioada ──
  app.get('/api/fx-reval/candidates', (req, res) => sendList(req, res, fxreval.candidates(S(req), req.query.asOf || null), { label: 'fx-reval/candidates' }));
  app.post('/api/fx-reval/preview', (req, res) => {
    const b = req.body || {};
    res.json(fxreval.buildRevaluation(S(req), b.asOf || null, Array.isArray(b.items) ? b.items : []));
  });
  app.post('/api/fx-reval/post', (req, res) => {
    const b = req.body || {}; const fid = activeId(req); const d = db.get();
    const asOf = b.asOf || new Date().toISOString().slice(0, 10);
    const r = fxreval.buildRevaluation(S(req), asOf, Array.isArray(b.items) ? b.items : []);
    if (!r.lines.length) return res.status(400).json({ error: 'Nicio diferenta de reevaluare de inregistrat.' });
    for (const ln of r.lines) if (!coa.getAccount(ln.debit) || !coa.getAccount(ln.credit)) return res.status(400).json({ error: 'Cont inexistent: ' + ln.debit + '/' + ln.credit });
    const data = String(asOf).length === 7 ? asOf + '-28' : asOf;
    const firma = db.getFirma(fid) || {};
    if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) return res.status(400).json({ error: 'Perioada ' + periodOf(data) + ' este inchisa.' });
    const entry = {
      id: db.nextId('e'), firmaId: fid, data, period: periodOf(data),
      tip: 'reevaluare_valutara', tipNume: 'Reevaluare valutara la sfarsit de perioada',
      partener: '', document: 'Reevaluare ' + periodOf(data), explicatie: 'Diferente de curs din reevaluarea soldurilor in valuta',
      fileId: null, system: false, lines: r.lines,
    };
    d.entries.push(entry);
    logAudit('reevaluare.valutara', periodOf(data) + ': fav ' + r.totalFavorabil + ' / nefav ' + r.totalNefavorabil, { req });
    db.save();
    res.json({ ok: true, entry, totalFavorabil: r.totalFavorabil, totalNefavorabil: r.totalNefavorabil });
  });

  // ── Ajustarea deprecierii creantelor + scoaterea din evidenta ──
  // Provizion (ajustare) pentru deprecierea creantelor vechi (>90 zile), 6814 = 491
  function computeProvizion(v, asOf, pct) {
    const ag = aging(v, asOf);
    const p = pct == null ? 100 : pct;
    const detalii = ag.clienti.filter((c) => c.b90plus > 0).map((c) => ({ partener: c.partener, cui: c.cui, vechi: c.b90plus, provizion: round2((c.b90plus * p) / 100) }));
    const base = round2(detalii.reduce((s, c) => s + c.vechi, 0));
    const necesar = round2((base * p) / 100);
    const m = acc.accumulate(acc.allLines(acc.postedEntries(v)));
    const c491 = m['491'] || { d: 0, c: 0 };
    const existent = round2(c491.c - c491.d);
    return { asOf: ag.asOf, pct: p, base, necesar, existent, deAjustat: round2(necesar - existent), detalii };
  }
  app.get('/api/provizion', (req, res) => res.json(computeProvizion(S(req), req.query.asOf || null, req.query.pct ? Number(req.query.pct) : 100)));
  // Scoaterea din evidenta a unei creante neincasabile: 654 = 4111 (pierdere) + reluare 491 = 7814
  app.post('/api/writeoff', (req, res) => {
    const d = db.get();
    const v = S(req);
    const b = req.body || {};
    const suma = round2(Number(b.suma) || 0);
    if (!b.partener || suma <= 0) return res.status(400).json({ error: 'Completeaza partenerul si suma.' });
    const data = b.data && String(b.data).length === 10 ? b.data : new Date().toISOString().slice(0, 10);
    const period = String(data).slice(0, 7);
    const lines = [{ debit: '654', credit: '4111', suma, explicatie: 'Creanta neincasabila ' + b.partener }];
    const m = acc.accumulate(acc.allLines(acc.postedEntries(v)));
    const c491 = m['491'] || { d: 0, c: 0 };
    const existing491 = round2(c491.c - c491.d);
    const revers = round2(Math.min(suma, existing491));
    if (revers > 0) lines.push({ debit: '491', credit: '7814', suma: revers, explicatie: 'Reluare ajustare ' + b.partener });
    d.entries.push({
      id: db.nextId('e'), firmaId: activeId(req), data, period, tip: 'scoatere_creanta', tipNume: 'Scoatere din evidenta creanta neincasabila',
      partener: b.partener, partenerCui: b.cui || '', document: 'Nota scoatere ' + period, analitic: '', explicatie: 'Creanta neincasabila ' + b.partener, fileId: null, system: true, lines,
    });
    logAudit('writeoff', b.partener + ' ' + suma, { req });
    db.save();
    res.json({ ok: true, suma, reversProvizion: revers });
  });
  app.post('/api/provizion', (req, res) => {
    const d = db.get();
    const b = req.body || {};
    const pct = b.pct != null ? Number(b.pct) : 100;
    const p = computeProvizion(S(req), b.asOf || null, pct);
    if (Math.abs(p.deAjustat) < 0.005) return res.json({ ok: true, message: 'Ajustarea este deja la nivelul necesar (' + p.necesar + ').', result: p });
    const data = b.asOf && String(b.asOf).length === 10 ? b.asOf : (p.asOf || new Date().toISOString().slice(0, 10));
    const period = String(data).slice(0, 7);
    const up = p.deAjustat > 0;
    const line = up
      ? { debit: '6814', credit: '491', suma: p.deAjustat, explicatie: 'Ajustare depreciere creante' }
      : { debit: '491', credit: '7814', suma: -p.deAjustat, explicatie: 'Reluare ajustare creante' };
    d.entries.push({
      id: db.nextId('e'), firmaId: activeId(req), data, period,
      tip: up ? 'provizion_creante' : 'reluare_provizion', tipNume: up ? 'Ajustare depreciere creante (6814=491)' : 'Reluare ajustare creante (491=7814)',
      partener: '', partenerCui: '', document: 'Nota ajustare ' + period, analitic: '', explicatie: line.explicatie, fileId: null, system: true, lines: [line],
    });
    logAudit('provizion', period + ' ' + p.deAjustat, { req });
    db.save();
    res.json({ ok: true, result: p });
  });
};
