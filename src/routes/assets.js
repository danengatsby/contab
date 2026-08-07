'use strict';

// Rutele mijloacelor fixe: registru, plan de amortizare, inregistrarea amortizarii lunii,
// livrabilele PDF (registrul, fisa mijlocului fix) si scadentarul de leasing (JSON + PDF).
// Modul de rute: register(app, ctx).

const assets = require('../assets');
const catalogDurate = require('../catalogDurate'); // HG 2139/2004 — sugestie in formular, NU calcul
const db = require('../db');
const pdf = require('../pdf');
const coa = require('../chartOfAccounts');
const { leasingSchedule } = require('../leasing');
const { round2 } = require('../util');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit, requireAdmin } = ctx;

  // ── CATALOGUL DURATELOR (HG 2139/2004) ────────────────────────────────────
  // Sta GLOBAL, ca planul de conturi: duratele normale sunt aceleasi pentru toate firmele.
  // Deci importul e `requireAdmin`, din exact acelasi motiv ca la /api/accounts/import —
  // stare globala partajata, iar un cont legat de o singura firma nu are voie s-o rescrie
  // pentru toate celelalte.
  //
  // Cautarea ramane deschisa oricui e autentificat: e un nomenclator public (o hotarare de
  // guvern), nu date de firma, si e inutila daca doar adminul o poate citi.
  app.get('/api/catalog-durate', (req, res) => {
    const d = db.get();
    const lista = d.catalogDurate || [];
    const q = String(req.query.q || '').trim();
    // Fara `q` NU se intoarce catalogul intreg: sunt sute de randuri si nimeni nu le citeste pe
    // toate: se intoarce doar marimea lui, ca interfata sa poata spune „catalog neincarcat".
    if (!q) return res.json({ total: lista.length, rezultate: [] });
    res.json({ total: lista.length, rezultate: catalogDurate.cauta(lista, q, Number(req.query.limit) || 25) });
  });

  app.post('/api/catalog-durate/import', requireAdmin, (req, res) => {
    const { randuri, respinse } = catalogDurate.parse((req.body || {}).csv);
    if (!randuri.length) {
      return res.status(400).json({
        error: 'Niciun rand valid in fisier. Format asteptat: cod;denumire;ani (ex. „2.1.16.1.1;Masini de spalat;8-12").',
        respinse: respinse.slice(0, 20),
      });
    }
    const d = db.get();
    d.catalogDurate = d.catalogDurate || [];
    // Upsert pe cod, ca la planul de conturi: un import repetat corecteaza, nu dubleaza.
    for (const r of randuri) {
      const ex = d.catalogDurate.find((x) => catalogDurate.normalizeazaCod(x.cod) === catalogDurate.normalizeazaCod(r.cod));
      if (ex) Object.assign(ex, r); else d.catalogDurate.push(r);
    }
    db.save();
    logAudit('catalog-durate.import', randuri.length + ' pozitii (HG 2139/2004)', { req });
    // Randurile respinse pleaca inapoi la utilizator, cu numarul liniei: un catalog incarcat pe
    // jumatate fara sa spuna care jumatate l-ar face sa caute degeaba un cod care n-a intrat.
    res.json({ ok: true, importate: randuri.length, total: d.catalogDurate.length, respinse: respinse.slice(0, 50) });
  });

  app.get('/api/assets', (req, res) => {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
    sendList(req, res, assets.register(S(req), asOf), { label: 'assets' });
  });
  app.get('/api/assets/:id/schedule', (req, res) => {
    const a = (S(req).assets || []).find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: 'Mijloc fix inexistent.' });
    res.json({ asset: a, schedule: assets.schedule(a) });
  });
  app.post('/api/assets', (req, res) => {
    const b = req.body || {};
    if (!b.denumire || !b.cont || !b.cost || !b.durataLuni || !b.dataPif) return res.status(400).json({ error: 'Completeaza denumire, cont, cost, durata si data punerii in functiune.' });
    const d = db.get();
    const a = {
      id: db.nextId('mf'), firmaId: activeId(req),
      denumire: String(b.denumire), cont: String(b.cont),
      furnizor: b.furnizor || '', cui: b.cui || '',
      cost: round2(Number(b.cost) || 0), valoareReziduala: round2(Number(b.valoareReziduala) || 0),
      dataAchizitie: b.dataAchizitie || b.dataPif, dataPif: String(b.dataPif),
      durataLuni: Math.max(1, Number(b.durataLuni) || 1),
      metoda: assets.METHODS.includes(b.metoda) ? b.metoda : 'liniara', status: 'activ',
      // Planul FISCAL (art. 28) e optional: absent inseamna „identic cu cel contabil". Se scrie
      // doar cand difera efectiv — un camp egal cu cel contabil ar sugera o alegere care nu s-a
      // facut, si ar ingheta planul fiscal daca metoda contabila se schimba ulterior.
      ...(assets.METHODS.includes(b.metodaFiscala) && b.metodaFiscala !== b.metoda
        ? { metodaFiscala: b.metodaFiscala } : {}),
      ...(Number(b.durataFiscalaLuni) > 0 && Number(b.durataFiscalaLuni) !== Number(b.durataLuni)
        ? { durataFiscalaLuni: Math.max(1, Number(b.durataFiscalaLuni)) } : {}),
      // Art. 28 alin. (12) lit. m): vehicul de persoane cu maxim 9 scaune -> amortizarea FISCALA
      // e plafonata la 1.500 lei/luna. Marcaj EXPLICIT, nu dedus din contul 2133: acolo intra si
      // camioanele, autoutilitarele si utilajele, care nu au plafon. Un marcaj gresit ar schimba
      // impozitul, deci il pune contabilul, nu o euristica.
      ...(b.vehiculM1 ? { vehiculM1: true } : {}),
    };
    d.assets.push(a);
    logAudit('asset.create', a.denumire + ' (' + a.cont + ')', { req });
    db.save();
    res.json({ ok: true, asset: a });
  });
  app.post('/api/assets/:id/scrap', (req, res) => {
    const d = db.get();
    const a = (d.assets || []).find((x) => x.id === req.params.id && x.firmaId === activeId(req));
    if (!a) return res.status(404).json({ error: 'Mijloc fix inexistent.' }); // izolare multi-firma
    a.status = 'casat'; a.dataCasare = (req.body || {}).dataCasare || new Date().toISOString().slice(0, 10);
    logAudit('asset.scrap', a.denumire, { req });
    db.save();
    res.json({ ok: true, asset: a });
  });
  app.delete('/api/assets/:id', (req, res) => {
    const d = db.get();
    const a = (d.assets || []).find((x) => x.id === req.params.id && x.firmaId === activeId(req));
    if (!a) return res.status(404).json({ error: 'Mijloc fix inexistent.' }); // izolare multi-firma
    d.assets = (d.assets || []).filter((x) => x !== a);
    logAudit('asset.delete', a.denumire, { req });
    db.save();
    res.json({ ok: true });
  });
  // Inregistreaza amortizarea lunii (6811 = 281x), o linie pe mijloc fix
  app.post('/api/assets/depreciation', (req, res) => {
    const period = req.query.period;
    if (!period) return res.status(400).json({ error: 'Lipseste perioada (YYYY-MM).' });
    const d = db.get();
    try { db.assertPeriodOpen(activeId(req), period, 'Inregistrarea amortizarii'); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const dep = assets.monthlyDepreciation(S(req).assets, period);
    if (!dep.lines.length) return res.json({ ok: true, message: 'Nicio amortizare de inregistrat pentru ' + period + '.', result: dep });
    const exists = d.entries.find((e) => e.firmaId === activeId(req) && e.tip === 'amortizare_lunara' && e.period === period);
    if (exists) return res.status(400).json({ error: 'Amortizarea pentru ' + period + ' este deja inregistrata.' });
    d.entries.push({
      id: db.nextId('e'), firmaId: activeId(req), data: period + '-28', period, tip: 'amortizare_lunara', tipNume: 'Amortizare mijloace fixe',
      partener: '', document: 'Nota amortizare ' + period, explicatie: 'Amortizarea lunară a imobilizărilor',
      fileId: null, system: true,
      lines: dep.lines.map((l) => ({ debit: '6811', credit: l.contAmortizare, suma: l.suma, explicatie: 'Amortizare ' + l.denumire })),
    });
    logAudit('amortizare.lunara', period + ' (' + dep.lines.length + ' MF)', { req });
    db.save();
    res.json({ ok: true, result: dep });
  });

  // ── Livrabile PDF + leasing ──
  app.get('/pdf/assets', (req, res) => {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
    pdf.assetsRegisterPdf(res, S(req).company, assets.register(S(req), asOf), asOf);
  });
  app.get('/api/leasing-schedule', (req, res) => res.json(leasingSchedule(req.query.principal, req.query.months, req.query.rate, req.query.method)));
  app.get('/pdf/leasing-schedule', (req, res) => pdf.leasingSchedulePdf(res, S(req).company, leasingSchedule(req.query.principal, req.query.months, req.query.rate, req.query.method)));
  app.get('/pdf/asset/:id', (req, res) => {
    const a = (S(req).assets || []).find((x) => x.id === req.params.id);
    if (!a) return res.status(404).send('Mijloc fix inexistent');
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
    const asset = Object.assign({}, a, { contNume: coa.accountName(a.cont) });
    pdf.assetFisaPdf(res, S(req).company, { asset, calc: assets.compute(a, asOf), schedule: assets.schedule(a) });
  });
};
