'use strict';

// Tablouri de bord si analize (read-only, cu o exceptie de scriere): rezumatul dashboard
// (cu onboarding „Primii pasi" + alerta e-Factura netrimisa), previziunea de cash-flow,
// documentele lipsa (furnizori recurenti fara document in luna), graficele dashboard,
// balanta analitica, aging-ul (clienti/furnizori) + PDF, reconcilierea si compensarea
// creanta/datorie (singura ruta care scrie: posteaza nota 401=4111). Modul de rute:
// register(app, ctx).

const db = require('../db');
const rep = require('../reporting');
const decl = require('../declarations');
const pdf = require('../pdf');
const { reconcile, compensablePartners } = require('../reconcile');
const { analyticBalance, aging } = require('../analytic');
const { round2, period: periodOf } = require('../util');

function shiftYM(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  app.get('/api/reconcile', (req, res) => res.json(reconcile(S(req))));

  // ── Compensare creante / datorii (partener client + furnizor) ──
  app.get('/api/compensations', (req, res) => res.json(compensablePartners(S(req))));
  app.post('/api/compensations', (req, res) => {
    const b = req.body || {}; const fid = activeId(req); const d = db.get();
    const cui = String(b.cui || '').replace(/^ro/i, '').replace(/\s/g, '');
    if (!cui) return res.status(400).json({ error: 'Lipseste CUI-ul partenerului.' });
    const cand = compensablePartners(S(req)).find((p) => String(p.cui).replace(/^ro/i, '') === cui);
    if (!cand) return res.status(400).json({ error: 'Partenerul nu are simultan creanta si datorie de compensat.' });
    const suma = round2(Math.min(Number(b.suma) > 0 ? Number(b.suma) : cand.compensabil, cand.compensabil));
    if (!(suma > 0)) return res.status(400).json({ error: 'Suma de compensat trebuie sa fie > 0.' });
    const data = b.data || new Date().toISOString().slice(0, 10);
    const firma = db.getFirma(fid) || {};
    if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) return res.status(400).json({ error: 'Perioada ' + periodOf(data) + ' este inchisa.' });
    const entry = {
      id: db.nextId('e'), firmaId: fid, data, period: periodOf(data),
      tip: 'compensare', tipNume: 'Compensare creanta/datorie (401 = 4111)',
      partener: cand.den, partenerCui: cand.cui, document: b.document || 'Compensare ' + (cand.den || cand.cui),
      explicatie: 'Compensare creanta clienti cu datorie furnizori', fileId: null, system: false,
      lines: [{ debit: '401', credit: '4111', suma, explicatie: 'Compensare ' + (cand.den || cand.cui) }],
    };
    d.entries.push(entry);
    logAudit('compensare', (cand.den || cand.cui) + ': ' + suma, { req });
    db.save();
    res.json({ ok: true, entry, compensat: suma });
  });

  app.get('/api/dashboard', (req, res) => {
    const v = S(req);
    // Primii pasi (onboarding pentru firme proaspete): starea reala a pasilor de inceput,
    // ca dashboard-ul sa ghideze un tester necontabil in loc sa-i arate doar zerouri.
    // wizardAscuns e per UTILIZATOR (persistat pe cont, nu in localStorage — supravietuieste
    // schimbarii de browser); conditiile de afisare deriva insa din datele reale ale firmei.
    const primiiPasi = {
      firmaCompletata: !!(v.company && v.company.cui),
      arePartener: Object.keys(v.partners || {}).length > 0,
      areProdus: (v.products || []).length > 0,
      documentInregistrat: (v.entries || []).some((e) => !e.system),
      facturaEmisa: (v.entries || []).some((e) => /^factura_vanzare/.test(e.tip || '')),
      nrInregistrari: (v.entries || []).length,
      wizardAscuns: !!req.user.wizardAscuns,
    };
    // e-Factura B2B: facturile emise netrimise in SPV (termen legal 5 zile lucratoare) — alerta pe dashboard
    res.json(Object.assign(rep.dashboard(v), { efactura: decl.eFacturaNetrimise(v), primiiPasi }));
  });
  app.get('/api/cash-forecast', (req, res) => {
    const fid = activeId(req);
    const templates = (db.get().recurringInvoices || []).filter((t) => t.firmaId === fid && t.activ !== false);
    res.json(rep.cashForecast(S(req), templates, { months: Number(req.query.months) || 6, startPeriod: req.query.start || null }));
  });

  // Documente lipsa: furnizori care apareau lunar dar nu au document in luna selectata
  app.get('/api/missing-docs', (req, res) => {
    const s = S(req);
    const ym = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
    const per = (e) => e.period || periodOf(e.data);
    const purchases = (s.entries || []).filter((e) => /cumparare/.test(e.tip) && e.partener);
    const prev = [1, 2, 3].map((k) => shiftYM(ym, -k));
    const seen = {}; const lastSeen = {};
    purchases.forEach((e) => {
      const m = per(e);
      if (!lastSeen[e.partener] || m > lastSeen[e.partener]) lastSeen[e.partener] = m;
      if (prev.includes(m)) { (seen[e.partener] = seen[e.partener] || new Set()).add(m); }
    });
    const thisSet = new Set(purchases.filter((e) => per(e) === ym).map((e) => e.partener));
    const missing = Object.keys(seen).filter((p) => seen[p].size >= 2 && !thisSet.has(p))
      .map((p) => ({ partener: p, luniPrezent: seen[p].size, ultimaLuna: lastSeen[p] }))
      .sort((a, b) => b.luniPrezent - a.luniPrezent);
    const countThis = thisSet.size ? purchases.filter((e) => per(e) === ym).length : 0;
    const avgPrev = Math.round((prev.reduce((acc, m) => acc + purchases.filter((e) => per(e) === m).length, 0) / 3) * 10) / 10;
    res.json({ period: ym, countThis, avgPrev, missing });
  });
  app.get('/api/dashboard-charts', (req, res) => {
    const v = S(req);
    const year = req.query.year || rep.latestYear(v);
    const ag = aging(v, null);
    res.json({ year, monthly: rep.monthlySeries(v, year), agingClienti: ag.totalClienti, agingFurnizori: ag.totalFurnizori });
  });
  app.get('/api/analytic', (req, res) => res.json(analyticBalance(S(req))));
  app.get('/api/aging', (req, res) => res.json(aging(S(req), req.query.asOf || null)));
  app.get('/pdf/aging', (req, res) => pdf.agingPdf(res, S(req).company, aging(S(req), req.query.asOf || null)));
};
