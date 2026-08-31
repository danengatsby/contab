'use strict';

// Tablouri de bord si analize (read-only, cu o exceptie de scriere): rezumatul dashboard
// (cu onboarding „Primii pasi" + alerta e-Factura netrimisa), previziunea de cash-flow,
// documentele lipsa (furnizori recurenti fara document in luna), graficele dashboard,
// balanta analitica, aging-ul (clienti/furnizori) + PDF, reconcilierea si compensarea
// creanta/datorie (singura ruta care scrie: posteaza nota pe conturile reale). Modul de rute:
// register(app, ctx).

const db = require('../db');
const cache = require('../cache');
const rep = require('../reporting');
const decl = require('../declarations');
const pdf = require('../pdf');
const acc = require('../accounting');
const stocks = require('../stocks');
const dateFirma = require('../dateFirma');
const { reconcile, compensablePartners, compensationLines } = require('../reconcile');
const { analyticBalance, aging } = require('../analytic');
const openItems = require('../openItems');
const cash13 = require('../cashForecast13Weeks');
const { round2, period: periodOf, validPeriod } = require('../util');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  app.get('/api/reconcile', (req, res) => res.json(reconcile(S(req))));

  // ── Punctaj manual: leaga/dezleaga o plata de facturile pe care le stinge (camp `stinge`) ──
  // Adnotare de reconciliere: nu misca sume/linii/perioada, deci permisa si pe articole postate.
  // Trimite intreg setul dorit (idempotent): lista goala = dezlegare completa.
  app.post('/api/reconcile/link', (req, res) => {
    const b = req.body || {}; const fid = activeId(req); const d = db.get();
    const ownIds = new Set((d.entries || []).filter((e) => Number(e.firmaId) === Number(fid)).map((e) => String(e.id)));
    const ids = Array.isArray(b.invoiceIds) ? [...new Set(b.invoiceIds.map(String))].filter((id) => ownIds.has(id)) : [];
    try {
      const r = openItems.replaceAllocations(d, fid, String(b.paymentId || ''),
        ids.map((documentId) => ({ documentId, amount: null })), req.user, db.nextId);
      if (!r.idempotent) {
        logAudit('reconcile.link', String(b.paymentId) + ' -> [' + ids.join(', ') + ']', { req, firmaId: fid });
        db.save();
      }
      res.json({ ok: true, idempotent: !!r.idempotent, paymentId: String(b.paymentId || ''), stinge: ids,
        allocations: r.allocations });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  // ── Compensare creante / datorii (partener client + furnizor) ──
  app.get('/api/compensations', (req, res) => sendList(req, res, compensablePartners(S(req)), { label: 'compensations' }));
  app.post('/api/compensations', (req, res) => {
    const b = req.body || {}; const fid = activeId(req);
    const cui = String(b.cui || '').replace(/^ro/i, '').replace(/\s/g, '');
    if (!cui) return res.status(400).json({ error: 'Lipseste CUI-ul partenerului.' });
    const cand = compensablePartners(S(req)).find((p) => String(p.cui).replace(/^ro/i, '').replace(/\s/g, '') === cui);
    if (!cand) return res.status(400).json({ error: 'Partenerul nu are simultan creanta si datorie de compensat.' });
    const lipsa = b.suma == null || String(b.suma).trim() === '';
    const suma = round2(lipsa ? cand.compensabil : Number(b.suma));
    if (!Number.isFinite(suma) || !(suma > 0)) return res.status(400).json({ error: 'Suma de compensat trebuie sa fie un numar finit > 0.' });
    if (suma > cand.compensabil) return res.status(400).json({ error: 'Suma depaseste soldul compensabil de ' + cand.compensabil + ' lei.' });
    const data = b.data || new Date().toISOString().slice(0, 10);
    try { db.assertPeriodOpen(fid, data, 'Compensarea'); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const alocare = compensationLines(cand, suma);
    if (alocare.ramas !== 0 || !alocare.lines.length) return res.status(409).json({ error: 'Soldurile analitice nu mai permit compensarea solicitata. Reincarca lista.' });
    const explicatie = 'Compensare ' + (cand.den || cand.cui);
    const entry = {
      id: db.nextId('e'), firmaId: fid, data, period: periodOf(data),
      tip: 'compensare', tipNume: 'Compensare creanta/datorie',
      partener: cand.den, partenerCui: cand.cui, document: b.document || 'Compensare ' + (cand.den || cand.cui),
      explicatie: 'Compensare creanță clienți cu datorie furnizori', fileId: null, system: false,
      lines: alocare.lines.map((l) => Object.assign({}, l, { explicatie })),
    };
    db.pushEntry(entry, { context: 'compensare' });
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
    const period = req.query.period ? String(req.query.period) : '';
    if (period && !validPeriod(period)) return res.status(400).json({ error: 'Perioada dashboardului trebuie sa fie YYYY-MM.' });
    // Perioada face parte din cheie: profitul lunii si fotografia soldurilor trebuie sa urmeze
    // selectorul global, fara ca un hit pe August sa intoarca valorile din Iulie.
    const { value, hit } = cache.memo('dashboard', period ? fid + ':' + period : fid, () => {
      // db.scoped(fid), NU S(req): valoarea e partajata intre utilizatorii aceleiasi firme, deci
      // calculul nu are voie sa depinda de CINE cere (S injecteaza `_intocmit` din profilul lui).
      const v = db.scoped(fid);
      // Primii pasi (onboarding pentru firme proaspete): starea reala a pasilor de inceput,
      // ca dashboard-ul sa ghideze un tester necontabil in loc sa-i arate doar zerouri.
      // Aici intra DOAR ce deriva din datele firmei; wizardAscuns e per UTILIZATOR, deci se
      // suprapune dupa cache (altfel un utilizator ar mosteni starea wizardului altuia).
      // „Datele firmei sunt completate" se DERIVA din campurile de care depind iesirile fiscale
      // (src/dateFirma.js), nu din prezenta CUI-ului. Varianta veche bifa pasul imediat dupa
      // inscriere — deci checklistul spunea „gata" in timp ce controalele de coerenta cereau, la
      // doua clicuri distanta, codul CAEN. Iar campurile lipsa nu blocheaza nimic: generatoarele
      // pun inlocuitori („0000", „RO-B"), deci iese o declaratie valida si gresita.
      const lipsaFirma = dateFirma.lipsa(v.company);
      const primiiPasi = {
        firmaCompletata: lipsaFirma.length === 0,
        // Ce anume lipseste, ca pasul sa poata SPUNE, nu doar sa ramana nebifat. Fara asta,
        // utilizatorul vede un pas rosu pe un ecran cu ~40 de campuri si nu stie care.
        firmaLipsa: lipsaFirma.map((f) => ({ camp: f.camp, eticheta: f.eticheta, deCe: f.deCe })),
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
      return Object.assign(rep.dashboard(v, period || null), { efactura: decl.eFacturaNetrimise(v), primiiPasi, ultimeleOperatiuni, stocuriValoroase });
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

  function forecastTemplates(fid) {
    return (db.get().recurringInvoices || []).filter((t) => Number(t.firmaId) === Number(fid) && t.activ !== false);
  }
  function snapshotPublic(row, view) {
    return { id: row.id, createdAt: row.createdAt, createdByName: row.createdByName,
      startDate: row.startDate, endDate: row.endDate, scenario: row.scenario,
      basisHash: row.basisHash, forecastHash: row.forecastHash, verified: cash13.verifySnapshot(row),
      backtest: cash13.verifySnapshot(row) ? cash13.backtest(view, row) : null };
  }

  app.get('/api/cash-forecast/13-weeks', (req, res) => {
    try {
      const fid = activeId(req); const view = S(req);
      const value = cash13.forecast(view, forecastTemplates(fid), {
        startDate: req.query.start || null, scenario: req.query.scenario || 'base',
      });
      const allSnapshots = (view.cashForecastSnapshots || []).slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const snapshots = allSnapshots.slice(0, 5).map((row) => snapshotPublic(row, view));
      res.json(Object.assign(value, { snapshotCount: allSnapshots.length, snapshots }));
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  // PDF-ul poate fi o previzualizare live sau o fotografie identificată explicit. Pentru o
  // fotografie nu se recalculează nimic: se verifică hash-ul și se tipărește forecast-ul păstrat.
  app.get('/pdf/cash-forecast-13-weeks', (req, res) => {
    try {
      const fid = activeId(req); const view = S(req); let value; let meta = {};
      if (req.query.snapshot) {
        const row = (view.cashForecastSnapshots || []).find((x) => String(x.id) === String(req.query.snapshot));
        if (!row) return res.status(404).send('Fotografia de cash-flow nu există în firma activă.');
        if (!cash13.verifySnapshot(row)) return res.status(409).send('Fotografia de cash-flow este coruptă sau incompletă.');
        value = row.forecast; meta = { snapshotId: row.id, createdAt: row.createdAt,
          createdByName: row.createdByName, forecastHash: row.forecastHash };
      } else {
        value = cash13.forecast(view, forecastTemplates(fid), {
          startDate: req.query.start || null, scenario: req.query.scenario || 'base',
        });
      }
      return pdf.cashForecast13Pdf(res, view.company, value, meta);
    } catch (e) { return res.status(e.status || 400).send(e.message); }
  });

  // Fotografia este append-only. Aceleași date și aceleași ipoteze întorc aceeași fotografie,
  // ca retry-ul HTTP să nu creeze versiuni false; o schimbare de bază produce un hash nou.
  app.post('/api/cash-forecast/13-weeks/snapshot', (req, res) => {
    try {
      const fid = activeId(req); const view = S(req); const body = req.body || {};
      const value = cash13.forecast(view, forecastTemplates(fid), {
        startDate: body.startDate || null, scenario: body.scenario || 'base',
      });
      const existing = (db.get().cashForecastSnapshots || []).find((x) => Number(x.firmaId) === Number(fid)
        && x.startDate === value.startDate && x.scenario === value.scenario && x.basisHash === value.basisHash
        && cash13.verifySnapshot(x));
      if (existing) return res.json({ ok: true, created: false, snapshot: snapshotPublic(existing, view) });
      const row = cash13.makeSnapshot(value, { id: db.nextId('cfs'), firmaId: fid,
        createdBy: req.user && req.user.id, createdByName: req.user && req.user.username });
      db.get().cashForecastSnapshots = db.get().cashForecastSnapshots || [];
      db.get().cashForecastSnapshots.push(row);
      logAudit('cash-flow.snapshot', row.startDate + ' · ' + row.scenario + ' · ' + row.forecastHash.slice(0, 12), { req, firmaId: fid });
      db.save();
      return res.json({ ok: true, created: true, snapshot: snapshotPublic(row, S(req)) });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  });

  app.get('/api/cash-forecast/13-weeks/backtest', (req, res) => {
    try {
      const row = (S(req).cashForecastSnapshots || []).find((x) => String(x.id) === String(req.query.id || ''));
      if (!row) return res.status(404).json({ error: 'Fotografia de cash-flow nu există în firma activă.' });
      return res.json(cash13.backtest(S(req), row, req.query.asOf || null));
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
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
