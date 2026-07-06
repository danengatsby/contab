'use strict';

// Rutele de salarizare: nomenclator angajati, statul de plata (+ postare articol contabil),
// plata neta, registrul anual + PDF-urile (stat de plata, fluturas, registru, adeverinta).
// Modul de rute: register(app, ctx).

const db = require('../db');
const { round2 } = require('../util');
const { statePlata, registruSalarii } = require('../payroll');
const pdf = require('../pdf');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit, buildEntry } = ctx;

  app.get('/api/angajati', (req, res) => res.json(S(req).angajati));
  app.post('/api/angajati', (req, res) => {
    const b = req.body || {};
    if (!b.nume || !b.salariuBrut) return res.status(400).json({ error: 'Completeaza numele si salariul brut.' });
    const d = db.get();
    const a = b.id && (d.angajati || []).find((x) => x.id === b.id && x.firmaId === activeId(req));
    const rec = a || { id: db.nextId('ang'), firmaId: activeId(req) };
    Object.assign(rec, { nume: String(b.nume), cnp: b.cnp || '', functie: b.functie || '', salariuBrut: round2(Number(b.salariuBrut) || 0), neimpozabil: round2(Number(b.neimpozabil) || 0), spor: round2(Number(b.spor) || 0), avans: round2(Number(b.avans) || 0), retineri: round2(Number(b.retineri) || 0), persoane: b.persoane === '' || b.persoane == null ? null : Math.max(0, Math.round(Number(b.persoane) || 0)), sub26: !!b.sub26, copii: Math.max(0, Math.round(Number(b.copii) || 0)), tichete: round2(Number(b.tichete) || 0), avantaje: round2(Number(b.avantaje) || 0), zileCM: Math.max(0, Math.round(Number(b.zileCM) || 0)), procentCM: [75, 85, 100].includes(Number(b.procentCM)) ? Number(b.procentCM) : 75, zileCO: Math.max(0, Math.round(Number(b.zileCO) || 0)), zileLucratoare: Math.max(1, Math.round(Number(b.zileLucratoare) || 21)), normaPartiala: !!b.normaPartiala, scutitNormaPartiala: !!b.scutitNormaPartiala, sector: ['it', 'constructii', 'agro'].includes(b.sector) ? b.sector : 'normal' });
    if (!a) d.angajati.push(rec);
    logAudit('angajat.save', rec.nume, { req });
    db.save();
    res.json({ ok: true, angajat: rec });
  });
  app.delete('/api/angajati/:id', (req, res) => {
    const d = db.get();
    const a = (d.angajati || []).find((x) => x.id === req.params.id && x.firmaId === activeId(req));
    if (!a) return res.status(404).json({ error: 'Angajat inexistent.' }); // izolare multi-firma
    d.angajati = (d.angajati || []).filter((x) => x !== a);
    db.save();
    res.json({ ok: true });
  });
  app.get('/api/stat-plata', (req, res) => { const v = S(req); res.json(statePlata(v.angajati, req.query.period, v.payrollHistory)); });
  // Dosar de recuperare a concediilor medicale de la FNUASS (o luna): angajatii cu CM + suma de recuperat.
  function dosarCm(v, period) {
    const sp = statePlata(v.angajati, period, v.payrollHistory);
    const rows = sp.rows.filter((r) => (r.indemnizatieCM || 0) > 0)
      .map((r) => ({ nume: r.nume, cnp: r.cnp, zileCM: r.zileCM, mediaCM: r.mediaCM, cmAngajator: r.cmAngajator, cmFnuass: r.cmFnuass }));
    return { period, rows, totalAngajator: sp.totals.cmAngajator, totalFnuass: sp.totals.cmFnuass };
  }
  app.get('/api/dosar-cm', (req, res) => res.json(dosarCm(S(req), req.query.period)));
  app.get('/pdf/dosar-cm', (req, res) => { const v = S(req); pdf.dosarCmPdf(res, v.company, dosarCm(v, req.query.period)); });
  app.get('/api/registru-salarii', (req, res) => res.json(registruSalarii(S(req).payrollHistory, req.query.year || String(new Date().getFullYear()))));
  app.get('/pdf/registru-salarii', (req, res) => pdf.registruSalariiPdf(res, S(req).company, registruSalarii(S(req).payrollHistory, req.query.year || String(new Date().getFullYear()))));
  app.get('/pdf/adeverinta/:id', (req, res) => {
    const v = S(req);
    const year = req.query.year || String(new Date().getFullYear());
    const rs = registruSalarii(v.payrollHistory, year);
    const e = rs.angajati.find((x) => x.angajatId === req.params.id);
    if (!e) return res.status(404).send('Niciun venit inregistrat pentru acest angajat in anul ' + year);
    const ang = v.angajati.find((a) => a.id === req.params.id);
    pdf.adeverintaPdf(res, v.company, Object.assign({ functie: ang ? ang.functie : '' }, e), year);
  });
  app.post('/api/stat-plata', (req, res) => {
    const v = S(req);
    if (!v.angajati.length) return res.status(400).json({ error: 'Niciun angajat definit.' });
    const period = req.query.period;
    if (!period) return res.status(400).json({ error: 'Lipseste perioada (YYYY-MM).' });
    const sp = statePlata(v.angajati, period, v.payrollHistory);
    const data = period + '-30';
    // posteaza articolul de salarii cu sumele agregate din statul de plata (potrivite exact)
    const entry = buildEntry('stat_plata', {
      data, brut: sp.totals.brut, neimpozabil: sp.totals.neimpozabil,
      cas: sp.totals.cas, cass: sp.totals.cass, impozit: sp.totals.impozit, cam: sp.totals.cam,
      analitic: sp.rows.length + ' angajati',
    }, null, activeId(req));
    entry.system = true; entry.document = 'Stat plata ' + period;
    if (sp.totals.avans > 0) entry.lines.push({ debit: '421', credit: '425', suma: sp.totals.avans, explicatie: 'Retinere avans acordat' });
    if (sp.totals.retineri > 0) entry.lines.push({ debit: '421', credit: '427', suma: sp.totals.retineri, explicatie: 'Retineri din salarii (terti/popriri)' });
    // Concedii medicale: drepturile trec tot prin 421 (retinerile si plata raman pe un singur cont);
    // partea FNUASS e creanta de recuperat (4373 debit). Alternativa cu 423 exista ca tipuri manuale.
    if (sp.totals.cmAngajator > 0) entry.lines.push({ debit: '6458', credit: '421', suma: sp.totals.cmAngajator, explicatie: 'Indemnizatii CM suportate de angajator (primele 5 zile lucratoare)' });
    if (sp.totals.cmFnuass > 0) entry.lines.push({ debit: '4373', credit: '421', suma: sp.totals.cmFnuass, explicatie: 'Indemnizatii CM suportate de FNUASS (de recuperat)' });
    // Norma partiala sub salariul minim (OUG 16/2022): diferentele de CAS/CASS pana la nivelul
    // salariului minim sunt CHELTUIALA a angajatorului (nu retinere din salariat).
    if (sp.totals.casAngajator > 0) entry.lines.push({ debit: '6458', credit: '4315', suma: sp.totals.casAngajator, explicatie: 'CAS suportat de angajator — norma partiala sub salariul minim' });
    if (sp.totals.cassAngajator > 0) entry.lines.push({ debit: '6458', credit: '4316', suma: sp.totals.cassAngajator, explicatie: 'CASS suportat de angajator — norma partiala sub salariul minim' });
    const d = db.get();
    d.entries.push(entry);
    // instantaneu in istoricul de salarizare (inlocuieste daca luna era deja inregistrata)
    d.payrollHistory = (d.payrollHistory || []).filter((h) => !(h.firmaId === activeId(req) && h.period === period));
    d.payrollHistory.push({
      id: db.nextId('ph'), firmaId: activeId(req), period, ts: new Date().toISOString(),
      rows: sp.rows.map((r) => ({ angajatId: r.id, nume: r.nume, cnp: r.cnp, brut: r.brut, cas: r.cas, cass: r.cass, impozit: r.impozit, cam: r.cam, net: r.net, restPlata: r.restPlata })),
      totals: sp.totals,
    });
    logAudit('stat.plata', period + ' (' + sp.rows.length + ' ang., net ' + sp.totals.net + ')', { req });
    db.save();
    res.json({ ok: true, totals: sp.totals, entry });
  });
  // Plata efectiva a salariilor: rest de plata -> 421 = 5121/5311
  app.post('/api/stat-plata/pay', (req, res) => {
    const v = S(req);
    const period = req.query.period;
    if (!period) return res.status(400).json({ error: 'Lipseste perioada (YYYY-MM).' });
    const sp = statePlata(v.angajati, period, v.payrollHistory);
    if (sp.totals.restPlata <= 0) return res.status(400).json({ error: 'Nimic de platit (rest de plata 0).' });
    const cont = ['5121', '5311'].includes(req.query.cont) ? req.query.cont : '5121';
    const entry = buildEntry('plata_salarii', { data: period + '-30', suma: sp.totals.restPlata, cont }, null, activeId(req));
    entry.system = true; entry.document = 'Plata salarii ' + period;
    const d = db.get();
    d.entries.push(entry);
    logAudit('plata.salarii', period + ' ' + sp.totals.restPlata + ' din ' + cont, { req });
    db.save();
    res.json({ ok: true, suma: sp.totals.restPlata, cont, entry });
  });

  app.get('/pdf/stat-plata', (req, res) => { const v = S(req); pdf.statePlataPdf(res, v.company, statePlata(v.angajati, req.query.period, v.payrollHistory), req.query.period || null); });
  app.get('/pdf/fluturas/:id', (req, res) => {
    const v = S(req);
    const ang = v.angajati.find((a) => a.id === req.params.id);
    if (!ang) return res.status(404).send('Angajat inexistent');
    const row = statePlata([ang], req.query.period, v.payrollHistory).rows[0];
    pdf.fluturasPdf(res, v.company, row, req.query.period || new Date().toISOString().slice(0, 7));
  });
};
