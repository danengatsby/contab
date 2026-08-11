'use strict';

// Inchiderea lunara (cockpit) — strat SUBTIRE peste src/monthlyCloseService.js: parseaza cererea,
// apeleaza serviciul, scrie auditul si traduce erorile lui (`err.status`) in raspunsuri HTTP.
// Toate regulile (ordinea pasilor, blocajele, cine poate forta) stau in serviciu si in motor.

const svc = require('../monthlyCloseService');

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;

  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  // Starea fluxului pentru luna ceruta + lista de responsabili posibili (conturile firmei).
  // Temeiul legal al ciclului contabil, pe faze. Ruta e de CITIRE si nu depinde de firma: legea e
  // aceeasi pentru toti. Interfata o cere o data si o foloseste si la inchiderea lunii, si la cea
  // a anului — de aceea nu e lipita de `/api/monthly-close`, care e legat de o perioada.
  app.get('/api/temei-legal', (req, res) => {
    const faza = String(req.query.faza || '');
    const temeiLegal = require('../temeiLegal');
    res.json({
      acte: temeiLegal.ACTE,
      faze: temeiLegal.FAZE,
      pasi: temeiLegal.ciclu(temeiLegal.FAZE.includes(faza) ? faza : null),
    });
  });
  app.get('/api/monthly-close', (req, res) => run(res, () => {
    const fid = activeId(req);
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    return Object.assign(svc.state(fid, period), {
      responsabili: svc.firmUsers(fid),
      validabile: svc.validatableTypes(fid, period),
    });
  }));

  // Alocarea unui pas: responsabil / termen / nota.
  app.post('/api/monthly-close/step', (req, res) => run(res, () => {
    const b = req.body || {};
    const st = svc.setStep(activeId(req), b.period, b.step, b);
    logAudit('inchidere.pas', b.period + ' ' + b.step + ': ' + JSON.stringify({ responsabilId: b.responsabilId, due: b.due }), { req });
    return st;
  }));

  // Validarea unei declaratii, cu pastrarea dovezii (cine, cand, ce verdict).
  app.post('/api/monthly-close/validate', (req, res) => run(res, () => {
    const b = req.body || {};
    const r = svc.validateDeclaration(activeId(req), b.period, b.tip, req.user);
    logAudit('inchidere.validare', b.period + ' ' + String(b.tip).toUpperCase() + ': '
      + (r.rezultat.ok ? 'fara erori' : r.rezultat.errors.length + ' eroare/erori'), { req });
    return r;
  }));

  // Aprobarea lunii (asumare explicita) si retragerea ei.
  app.post('/api/monthly-close/approve', (req, res) => run(res, () => {
    const b = req.body || {};
    const st = svc.approve(activeId(req), b.period, req.user, b.nota);
    logAudit('inchidere.aprobare', b.period + ' aprobata', { req });
    return st;
  }));
  app.post('/api/monthly-close/unapprove', (req, res) => run(res, () => {
    const b = req.body || {};
    const st = svc.unapprove(activeId(req), b.period);
    logAudit('inchidere.aprobare', b.period + ' aprobare retrasa', { req });
    return st;
  }));

  // Inchiderea propriu-zisa: blocheaza perioada. Peste blocaje deschise cere admin + motiv.
  app.post('/api/monthly-close/close', (req, res) => run(res, () => {
    const b = req.body || {};
    const r = svc.close(activeId(req), b.period, req.user, b);
    logAudit(r.fortata ? 'inchidere.fortata' : 'inchidere.luna',
      b.period + (r.fortata ? ' FORTATA: ' + String(b.motiv || '').slice(0, 200) : ' inchisa') + ' (blocat pana la ' + r.lockedUntil + ')', { req });
    return r;
  }));
};
