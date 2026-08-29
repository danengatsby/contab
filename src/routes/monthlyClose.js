'use strict';

// Inchiderea lunara (cockpit) — strat SUBTIRE peste src/monthlyCloseService.js: parseaza cererea,
// apeleaza serviciul, scrie auditul si traduce erorile lui (`err.status`) in raspunsuri HTTP.
// Toate regulile (ordinea pasilor, blocajele, cine poate forta) stau in serviciu si in motor.

const svc = require('../monthlyCloseService');
const db = require('../db');
const permissions = require('../permissions');
const notify = require('../notify');

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;

  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json(Object.assign({ error: e.message },
        e.code ? { code: e.code } : {}, e.details || {}));
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
    const firma = db.getFirma(fid);
    return Object.assign(svc.state(fid, period), {
      responsabili: svc.firmUsers(fid),
      validabile: svc.validatableTypes(fid, period),
      permissions: {
        approve: permissions.can(req.user, fid, 'close.approve', firma),
        close: permissions.can(req.user, fid, 'close.manage', firma),
        override: permissions.can(req.user, fid, 'control.override', firma),
      },
    });
  }));

  // Alocarea unui pas: responsabil / termen / nota.
  app.post('/api/monthly-close/step', (req, res) => run(res, () => {
    const b = req.body || {};
    const r = svc.setStepDetailed(activeId(req), b.period, b.step, b, req.user);
    logAudit('inchidere.pas', b.period + ' ' + b.step + ': ' + JSON.stringify({ responsabilId: b.responsabilId, due: b.due,
      nota: Object.prototype.hasOwnProperty.call(b, 'nota') ? 'actualizata' : undefined }), { req });
    if (r.assignment) notify.sendAssignmentNotification(r.assignment)
      .catch((e) => console.error('notificare alocare inchidere:', e.message));
    return r.state;
  }));

  // Validarea unei declaratii, cu pastrarea dovezii (cine, cand, ce verdict).
  app.post('/api/monthly-close/validate', (req, res) => run(res, () => {
    const b = req.body || {};
    const fid = activeId(req); permissions.assert(req.user, fid, 'entry.validate', db.getFirma(fid));
    const r = svc.validateDeclaration(fid, b.period, b.tip, req.user);
    logAudit('inchidere.validare', b.period + ' ' + String(b.tip).toUpperCase() + ': '
      + (r.rezultat.ok ? 'fara erori' : r.rezultat.errors.length + ' eroare/erori'), { req });
    return r;
  }));

  // Aprobarea lunii (asumare explicita) si retragerea ei.
  app.post('/api/monthly-close/approve', (req, res) => run(res, () => {
    const b = req.body || {};
    const fid = activeId(req); permissions.assert(req.user, fid, 'close.approve', db.getFirma(fid));
    const st = svc.approve(fid, b.period, req.user, b);
    const exceptie = st.aprobare && st.aprobare.exceptie;
    logAudit(exceptie ? 'control.override' : 'inchidere.aprobare', b.period + ' aprobata'
      + (exceptie ? ' — exceptie separare atributii: ' + exceptie.motiv : ''), { req });
    return st;
  }));
  app.post('/api/monthly-close/unapprove', (req, res) => run(res, () => {
    const b = req.body || {};
    const fid = activeId(req); permissions.assert(req.user, fid, 'close.approve', db.getFirma(fid));
    const st = svc.unapprove(fid, b.period, req.user);
    logAudit('inchidere.aprobare', b.period + ' aprobare retrasa', { req });
    return st;
  }));

  // Inchiderea propriu-zisa: blocheaza perioada. Peste blocaje deschise cere drept de exceptie
  // (administrator), motiv persistent si eveniment distinct in audit.
  app.post('/api/monthly-close/close', (req, res) => run(res, () => {
    const b = req.body || {};
    const fid = activeId(req); permissions.assert(req.user, fid, 'close.manage', db.getFirma(fid));
    const r = svc.close(fid, b.period, req.user, b);
    if (!r.idempotent) logAudit(r.fortata ? 'inchidere.fortata' : 'inchidere.luna',
      b.period + (r.fortata ? ' FORTATA: ' + String(b.motiv || '').slice(0, 200) : ' inchisa') + ' (blocat pana la ' + r.lockedUntil + ')', { req });
    return r;
  }));
};
