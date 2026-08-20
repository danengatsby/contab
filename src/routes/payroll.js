'use strict';

// Rutele de salarizare — strat SUBTIRE peste src/payrollService.js pentru scrieri (angajati,
// postarea statului, plata neta); citirile (stat de plata, dosar CM, registru anual) si
// PDF-urile raman aici, pure pe vederea scoped. buildEntry e infrastructura partajata
// (ramane in server.js) si se da serviciului ca dependenta.

const { statPlataPerioada, registruSalarii } = require('../payroll');
const pdf = require('../pdf');
const svc = require('../payrollService');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit, buildEntry } = ctx;
  const deps = { buildEntry };

  // Erorile de business poarta `status` (400/403/404); restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  app.get('/api/angajati', (req, res) => sendList(req, res, S(req).angajati, { label: 'angajati' }));
  app.post('/api/angajati', (req, res) => run(res, () => {
    const r = svc.upsertAngajat(activeId(req), req.body);
    logAudit('angajat.save', r.angajat.nume, { req });
    return { ok: true, angajat: r.angajat };
  }));
  app.delete('/api/angajati/:id', (req, res) => run(res, () => {
    svc.deleteAngajat(activeId(req), req.params.id);
    return { ok: true };
  }));

  app.get('/api/stat-plata', (req, res) => { const v = S(req); res.json(statPlataPerioada(v,
    req.query.period, req.query.live !== '1')); });
  // Dosar de recuperare a concediilor medicale de la FNUASS (o luna): angajatii cu CM + suma de recuperat.
  function dosarCm(v, period) {
    const sp = statPlataPerioada(v, period);
    const rows = sp.rows.flatMap((r) => {
      const certificate = Array.isArray(r.certificateCM) && r.certificateCM.length
        ? r.certificateCM : ((r.indemnizatieCM || 0) > 0 ? [r] : []);
      return certificate.map((c) => ({ nume: r.nume, cnp: r.cnp,
        serieCM: c.serieCM, numarCM: c.numarCM,
        codIndemnizatieCM: c.codIndemnizatieCM,
        zileCM: c.zileCM, zilePlatiteCM: c.zilePlatiteCM, zileNeplatiteCM: c.zileNeplatiteCM,
        zileCMAngajator: c.zileCMAngajator, mediaCM: c.mediaCM,
        mediaZilnicaCM: c.mediaZilnicaCM, cmBazaAproximata: c.cmBazaAproximata,
        cmAngajator: c.cmAngajator, cmFnuass: c.cmFnuass }));
    });
    return { period, rows, totalAngajator: sp.totals.cmAngajator, totalFnuass: sp.totals.cmFnuass };
  }
  app.get('/api/dosar-cm', (req, res) => res.json(dosarCm(S(req), req.query.period)));
  app.get('/pdf/dosar-cm', (req, res) => { const v = S(req); pdf.dosarCmPdf(res, v.company, dosarCm(v, req.query.period)); });
  app.get('/api/registru-salarii', (req, res) => { const v = S(req); res.json(registruSalarii(
    v.payrollHistory, req.query.year || String(new Date().getFullYear()), v.entries)); });
  app.get('/pdf/registru-salarii', (req, res) => { const v = S(req); pdf.registruSalariiPdf(
    res, v.company, registruSalarii(v.payrollHistory,
      req.query.year || String(new Date().getFullYear()), v.entries)); });
  app.get('/pdf/adeverinta/:id', (req, res) => {
    const v = S(req);
    const year = req.query.year || String(new Date().getFullYear());
    const rs = registruSalarii(v.payrollHistory, year, v.entries);
    const e = rs.angajati.find((x) => x.angajatId === req.params.id);
    if (!e) return res.status(404).send('Niciun venit inregistrat pentru acest angajat in anul ' + year);
    const ang = v.angajati.find((a) => a.id === req.params.id);
    pdf.adeverintaPdf(res, v.company, Object.assign({ functie: ang ? ang.functie : '' }, e), year);
  });

  app.post('/api/stat-plata', (req, res) => run(res, () => {
    const r = svc.postStatPlata(activeId(req), req.query.period, deps);
    logAudit('stat.plata', req.query.period + ' (' + r.angajati + ' ang., net ' + r.totals.net + ')', { req });
    return { ok: true, totals: r.totals, entry: r.entry };
  }));
  // Plata efectiva a salariilor: rest de plata -> 421 = 5121/5311
  app.post('/api/stat-plata/pay', (req, res) => run(res, () => {
    const r = svc.paySalaries(activeId(req), req.query.period, req.query.cont, deps);
    logAudit('plata.salarii', req.query.period + ' ' + r.suma + ' din ' + r.cont, { req });
    return { ok: true, suma: r.suma, cont: r.cont, entry: r.entry };
  }));

  app.get('/pdf/stat-plata', (req, res) => { const v = S(req); pdf.statePlataPdf(res, v.company, statPlataPerioada(v, req.query.period), req.query.period || null); });
  app.get('/pdf/fluturas/:id', (req, res) => {
    const v = S(req);
    const row = statPlataPerioada(v, req.query.period).rows
      .find((r) => (r.angajatId || r.id) === req.params.id);
    if (!row) return res.status(404).send('Angajat inexistent in perioada selectata');
    pdf.fluturasPdf(res, v.company, row, req.query.period || new Date().toISOString().slice(0, 7));
  });
};
