'use strict';

// Rutele mijloacelor fixe: registru, plan de amortizare, inregistrarea amortizarii lunii,
// livrabilele PDF (registrul, fisa mijlocului fix) si scadentarul de leasing (JSON + PDF).
// Modul de rute: register(app, ctx).

const assets = require('../assets');
const db = require('../db');
const pdf = require('../pdf');
const coa = require('../chartOfAccounts');
const { leasingSchedule } = require('../leasing');
const { round2 } = require('../util');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  app.get('/api/assets', (req, res) => {
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
    res.json(assets.register(S(req), asOf));
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
      partener: '', document: 'Nota amortizare ' + period, explicatie: 'Amortizarea lunara a imobilizarilor',
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
