'use strict';

// Setari de cont si securitate — strat SUBTIRE peste src/accountService.js: parseaza cererea,
// apeleaza serviciul (care valideaza si scrie, inclusiv garda pe contul demo) si traduce
// erorile lui (`err.status`) in raspunsuri HTTP. Nucleul de securitate (login/register/logout/
// me/impersonare/resetare, cookie-uri, anti-brute-force, crearea sesiunii) sta in src/authRoutes.js.

const svc = require('../accountService');
const authlib = require('../auth');
const db = require('../db');
const { sendList } = require('../paginate');

module.exports = function register(app, ctx) {
  const { logAudit } = ctx;

  // Impersonarea este un sandbox pentru datele de lucru ale utilizatorului, nu delegarea
  // identitatii lui. Fara garda asta, un admin intrat „ca utilizator" putea vedea/revoca
  // sesiunile tintei, modifica profilul ei si chiar configura 2FA cu propriul telefon. Rutele
  // de cont se reiau numai dupa iesirea explicita din impersonare.
  const ownAccount = (req, res, next) => {
    if (req.impersonating) return res.status(403).json({ error: 'Ieși din modul de impersonare pentru a gestiona contul și securitatea lui.' });
    next();
  };

  // Erorile de business poarta `status` (400/403); restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };
  // Varianta asincrona (tiparul `runA` din src/routes/anaf.js): erorile de business isi pastreaza
  // statusul, restul urca la handlerul global. Apelantul TREBUIE sa o astepte.
  const runA = async (res, fn) => {
    try { res.json(await fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  // ───────────────────────────── 2FA (TOTP) ─────────────────────────────
  app.post('/api/2fa/setup', ownAccount, (req, res) => run(res, () => svc.setup2fa(req.user)));
  app.post('/api/2fa/enable', ownAccount, (req, res) => run(res, () => {
    const out = svc.enable2fa(req.user, (req.body || {}).code);
    logAudit('2fa.enable', req.user.username, { req, firmaId: null });
    return { ok: true, recoveryCodes: out.recoveryCodes };
  }));
  app.post('/api/2fa/disable', ownAccount, (req, res) => run(res, () => {
    svc.disable2fa(req.user, (req.body || {}).code);
    logAudit('2fa.disable', req.user.username, { req, firmaId: null });
    return { ok: true };
  }));
  app.post('/api/2fa/revoke-devices', ownAccount, (req, res) => run(res, () => {
    svc.revokeTrustedDevices(req.user);
    logAudit('2fa.revoke_devices', req.user.username, { req, firmaId: null });
    return { ok: true };
  }));
  app.post('/api/2fa/recovery-codes', ownAccount, (req, res) => run(res, () => {
    const out = svc.regenerateRecoveryCodes(req.user, (req.body || {}).code);
    logAudit('2fa.recovery_regenerate', req.user.username, { req, firmaId: null });
    return { ok: true, recoveryCodes: out.recoveryCodes };
  }));

  // ───────────────────────────── SESIUNI ACTIVE ─────────────────────────────
  app.get('/api/sessions', ownAccount, (req, res) => sendList(req, res, svc.listSessions(req.user, req._sessId), { label: 'sessions' }));
  app.post('/api/sessions/logout-others', ownAccount, (req, res) => run(res, () => {
    svc.logoutOtherSessions(req.user, req._sessId);
    logAudit('session.logout_others', req.user.username, { req, firmaId: null });
    return { ok: true };
  }));
  app.delete('/api/sessions/:id', ownAccount, (req, res) => run(res, () => {
    svc.revokeSession(req.user, req.params.id);
    logAudit('session.revoked', req.params.id, { req, firmaId: null });
    return { ok: true };
  }));

  // ───────────────────────────── PAROLA + PROFIL ─────────────────────────────
  app.post('/api/change-password', ownAccount, async (req, res) => {
    const b = req.body || {};
    // validarea sincrona (oldPassword, lungime/blacklist) e in serviciu; verificarea HIBP e async
    const breachErr = b.newPassword ? await authlib.breachCheck(String(b.newPassword)) : null;
    if (breachErr) return res.status(400).json({ error: breachErr });
    // runA, nu run: changePassword e acum asincron (scrypt pe threadpool). Cu `run` sincron,
    // promisiunea ar fi ramas neasteptata — raspuns trimis inainte de scriere si erorile de
    // business (parola veche gresita) ratacite intr-o respingere netratata.
    await runA(res, async () => {
      const result = await svc.changePassword(req.user, b.oldPassword, b.newPassword, req._sessId);
      logAudit('parola.schimbata', req.user.username + '; sesiuni revocate: ' + result.sessionsRevoked,
        { req, firmaId: null });
      return { ok: true, sessionsRevoked: result.sessionsRevoked, trustedDevicesRevoked: result.trustedDevicesRevoked };
    });
  });
  app.get('/api/profile', ownAccount, (req, res) => res.json(svc.getProfile(req.user)));
  // Wizard-ul de prima autentificare: „mai tarziu" il ascunde definitiv pentru utilizator
  app.post('/api/onboarding/dismiss', ownAccount, (req, res) => run(res, () => {
    svc.dismissWizard(req.user);
    return { ok: true };
  }));
  app.post('/api/profile', ownAccount, (req, res) => run(res, () => {
    const r = svc.updateProfile(req.user, req.body);
    return { ok: true, email: r.email, notifyDeadlines: r.notifyDeadlines,
      notifyAssignments: r.notifyAssignments, profil: r.profil };
  }));

  app.delete('/api/account', ownAccount, async (req, res) => {
    const b = req.body || {};
    try {
      const r = await svc.deleteAccount(req.user, b.password, b.confirmUsername);
      logAudit('account.delete', 'stergere self-service cont #' + r.userId, {
        userId: null, username: r.pseudonym, firmaId: null, ip: String(req.ip || ''),
      });
      db.save();
      res.setHeader('Set-Cookie', 'sid=; Max-Age=0; HttpOnly; Path=/; SameSite=Lax;' + (req.secure ? ' Secure;' : ''));
      res.json({ ok: true, deleted: true });
    } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  });
};
