'use strict';

// Tablouri de bord si analize (read-only, cu o exceptie de scriere): rezumatul dashboard
// (cu onboarding „Primii pasi" + alerta e-Factura netrimisa), previziunea de cash-flow,
// documentele lipsa (furnizori recurenti fara document in luna), graficele dashboard,
// balanta analitica, aging-ul (clienti/furnizori) + PDF, reconcilierea si compensarea
// creanta/datorie (singura ruta care scrie: posteaza nota 401=4111). Modul de rute:
// register(app, ctx).

const db = require('../db');
const cache = require('../cache');
const rep = require('../reporting');
const decl = require('../declarations');
const pdf = require('../pdf');
const acc = require('../accounting');
const stocks = require('../stocks');
const { reconcile, compensablePartners } = require('../reconcile');
const { analyticBalance, aging } = require('../analytic');
const { round2, period: periodOf } = require('../util');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  app.get('/api/reconcile', (req, res) => res.json(reconcile(S(req))));

  // ── Punctaj manual: leaga/dezleaga o plata de facturile pe care le stinge (camp `stinge`) ──
  // Adnotare de reconciliere: nu misca sume/linii/perioada, deci permisa si pe articole postate.
  // Trimite intreg setul dorit (idempotent): lista goala = dezlegare completa.
  app.post('/api/reconcile/link', (req, res) => {
    const b = req.body || {}; const fid = activeId(req); const d = db.get();
    const own = (id) => d.entries.find((e) => e.id === String(id) && e.firmaId === fid);
    const pay = own(b.paymentId);
    if (!pay) return res.status(404).json({ error: 'Articolul de decontare nu exista.' });
    const ids = Array.isArray(b.invoiceIds)
      ? [...new Set(b.invoiceIds.map(String))].filter((id) => id !== pay.id && !!own(id))
      : [];
    if (ids.length) pay.stinge = ids; else delete pay.stinge;
    logAudit('reconcile.link', pay.id + ' -> [' + ids.join(', ') + ']', { req, firmaId: fid });
    db.save();
    res.json({ ok: true, paymentId: pay.id, stinge: ids });
  });

  // ── Compensare creante / datorii (partener client + furnizor) ──
  app.get('/api/compensations', (req, res) => sendList(req, res, compensablePartners(S(req)), { label: 'compensations' }));
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
      explicatie: 'Compensare creanță clienți cu datorie furnizori', fileId: null, system: false,
      lines: [{ debit: '401', credit: '4111', suma, explicatie: 'Compensare ' + (cand.den || cand.cui) }],
    };
    d.entries.push(entry);
    logAudit('compensare', (cand.den || cand.cui) + ': ' + suma, { req });
    db.save();
    res.json({ ok: true, entry, compensat: suma });
  });

  // Ruta cea mai scumpa a aplicatiei (trece prin tot graful firmei: reconciliere, jurnale TVA,
  // cont de profit pe doi ani, solduri finale, stocuri). Masurat 611–736 ms la 22.000 de articole,
  // singura peste pragul de 500 ms — de aceea rezultatul PE FIRMA e memoizat (src/cache.js),
  // invalidat de orice scriere prin revizia globala. Antet de diagnostic: X-Dashboard-Cache.
  app.get('/api/dashboard', (req, res) => {
    const fid = activeId(req);
    const { value, hit } = cache.memo('dashboard', fid, () => {
      // db.scoped(fid), NU S(req): valoarea e partajata intre utilizatorii aceleiasi firme, deci
      // calculul nu are voie sa depinda de CINE cere (S injecteaza `_intocmit` din profilul lui).
      const v = db.scoped(fid);
      // Primii pasi (onboarding pentru firme proaspete): starea reala a pasilor de inceput,
      // ca dashboard-ul sa ghideze un tester necontabil in loc sa-i arate doar zerouri.
      // Aici intra DOAR ce deriva din datele firmei; wizardAscuns e per UTILIZATOR, deci se
      // suprapune dupa cache (altfel un utilizator ar mosteni starea wizardului altuia).
      const primiiPasi = {
        firmaCompletata: !!(v.company && v.company.cui),
        arePartener: Object.keys(v.partners || {}).length > 0,
        areProdus: (v.products || []).length > 0,
        documentInregistrat: (v.entries || []).some((e) => !e.system),
        facturaEmisa: (v.entries || []).some((e) => /^factura_vanzare/.test(e.tip || '')),
        nrInregistrari: (v.entries || []).length,
      };
      // Ultimele operatiuni: cele mai recente 5 articole (orice tip), cu totalul liniilor —
      // dashboard-ul raspunde la "ce s-a intamplat ultima data" fara drum prin jurnal.
      const ultimeleOperatiuni = acc.lastEntries(v.entries || [], 5).map((e) => ({
        id: e.id, data: e.data, tipNume: e.tipNume, partener: e.partener || '', document: e.document || '',
        suma: round2((e.lines || []).reduce((s, l) => s + (Number(l.suma) || 0), 0)),
      }));
      // Stocuri valoroase: top 5 produse dupa valoarea la CMP (agregat pe gestiuni);
      // lista goala = firma fara activitate de stocuri, frontend-ul ascunde cardul.
      const byProd = new Map();
      for (const r of stocks.currentStock(v, null, null)) {
        const cur = byProd.get(r.product.id) || { cod: r.product.cod, denumire: r.product.denumire, stocV: 0 };
        cur.stocV = round2(cur.stocV + r.stocV);
        byProd.set(r.product.id, cur);
      }
      const stocuriValoroase = [...byProd.values()].filter((x) => x.stocV > 0).sort((a, b) => b.stocV - a.stocV).slice(0, 5);
      // e-Factura B2B: facturile emise netrimise in SPV (termen legal 5 zile lucratoare) — alerta pe dashboard
      return Object.assign(rep.dashboard(v), { efactura: decl.eFacturaNetrimise(v), primiiPasi, ultimeleOperatiuni, stocuriValoroase });
    });
    res.setHeader('X-Dashboard-Cache', hit ? 'hit' : 'miss');
    // Copie superficiala: valoarea din cache e partajata intre cereri, nu se muteaza niciodata.
    res.json(Object.assign({}, value, {
      primiiPasi: Object.assign({}, value.primiiPasi, { wizardAscuns: !!req.user.wizardAscuns }),
    }));
  });
  app.get('/api/cash-forecast', (req, res) => {
    const fid = activeId(req);
    const templates = (db.get().recurringInvoices || []).filter((t) => t.firmaId === fid && t.activ !== false);
    res.json(rep.cashForecast(S(req), templates, { months: Number(req.query.months) || 6, startPeriod: req.query.start || null }));
  });

  // Documente lipsa: furnizori care apareau lunar dar nu au document in luna selectata.
  // Regula traieste in rep.missingDocs — aceeasi folosita de pasul 1 al inchiderii lunare.
  app.get('/api/missing-docs', (req, res) => res.json(rep.missingDocs(S(req), req.query.period)));
  app.get('/api/dashboard-charts', (req, res) => {
    const v = S(req);
    const year = req.query.year || rep.latestYear(v);
    const ag = aging(v, null);
    res.json({ year, monthly: rep.monthlySeries(v, year), agingClienti: ag.totalClienti, agingFurnizori: ag.totalFurnizori });
  });
  app.get('/api/analytic', (req, res) => sendList(req, res, analyticBalance(S(req)), { label: 'analytic' }));
  app.get('/api/aging', (req, res) => res.json(aging(S(req), req.query.asOf || null)));
  app.get('/pdf/aging', (req, res) => pdf.agingPdf(res, S(req).company, aging(S(req), req.query.asOf || null)));
};
