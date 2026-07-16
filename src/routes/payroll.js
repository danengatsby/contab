'use strict';

// Rutele de salarizare — strat SUBTIRE peste src/payrollService.js pentru scrieri (angajati,
// postarea statului, plata neta); citirile (stat de plata, dosar CM, registru anual) si
// PDF-urile raman aici, pure pe vederea scoped. buildEntry e infrastructura partajata
// (ramane in server.js) si se da serviciului ca dependenta.

const { statePlata, registruSalarii } = require('../payroll');
const pdf = require('../pdf');
const svc = require('../payrollService');

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

  app.get('/api/angajati', (req, res) => res.json(S(req).angajati));
  app.post('/api/angajati', (req, res) => run(res, () => {
    const r = svc.upsertAngajat(activeId(req), req.body);
    logAudit('angajat.save', r.angajat.nume, { req });
    return { ok: true, angajat: r.angajat };
  }));
  app.delete('/api/angajati/:id', (req, res) => run(res, () => {
    svc.deleteAngajat(activeId(req), req.params.id);
    return { ok: true };
  }));

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

  app.get('/pdf/stat-plata', (req, res) => { const v = S(req); pdf.statePlataPdf(res, v.company, statePlata(v.angajati, req.query.period, v.payrollHistory), req.query.period || null); });
  app.get('/pdf/fluturas/:id', (req, res) => {
    const v = S(req);
    const ang = v.angajati.find((a) => a.id === req.params.id);
    if (!ang) return res.status(404).send('Angajat inexistent');
    const row = statePlata([ang], req.query.period, v.payrollHistory).rows[0];
    pdf.fluturasPdf(res, v.company, row, req.query.period || new Date().toISOString().slice(0, 7));
  });
};
