'use strict';

// Setari de cont si securitate (opereaza pe utilizatorul deja autentificat, req.user): 2FA (TOTP)
// setup/enable/disable + revocarea dispozitivelor de incredere, sesiunile active (listare,
// deconectarea celorlalte, revocare individuala), schimbarea parolei si profilul (date personale).
// Modul de rute: register(app, ctx). Nucleul de securitate (login/register/logout/me/impersonare/
// resetare, cookie-uri, anti-brute-force, crearea sesiunii) ramane in server.js.

const db = require('../db');
const totp = require('../totp');
const authlib = require('../auth');
const plans = require('../plans');
const QRCode = require('qrcode-svg');

module.exports = function register(app, ctx) {
  const { demoContLock, logAudit } = ctx;

  // ───────────────────────────── 2FA (TOTP) ─────────────────────────────
  app.post('/api/2fa/setup', (req, res) => {
    if (demoContLock(req, res)) return;
    const u = req.user;
    if (u.twofa) return res.status(400).json({ error: '2FA este deja activat.' });
    u.pending2fa = totp.generateSecret();
    db.save();
    const otpauth = totp.otpauthURL(u.username, u.pending2fa, 'Contabo');
    let qrSvg = '';
    try { qrSvg = new QRCode({ content: otpauth, padding: 2, width: 180, height: 180, color: '#1a1f36', background: '#ffffff', ecl: 'M', join: true }).svg(); } catch (e) { /* QR optional */ }
    res.json({ secret: u.pending2fa, otpauth, qrSvg });
  });
  app.post('/api/2fa/enable', (req, res) => {
    if (demoContLock(req, res)) return;
    const u = req.user;
    if (!u.pending2fa) return res.status(400).json({ error: 'Initiaza intai configurarea 2FA.' });
    if (!totp.verify(u.pending2fa, (req.body || {}).code)) return res.status(400).json({ error: 'Cod gresit. Verifica ora dispozitivului.' });
    u.totpSecret = u.pending2fa; u.twofa = true; delete u.pending2fa;
    u.tfdEpoch = (u.tfdEpoch || 0) + 1; // invalideaza eventualele dispozitive de incredere vechi
    logAudit('2fa.enable', u.username, { req, firmaId: null });
    db.save();
    res.json({ ok: true });
  });
  app.post('/api/2fa/disable', (req, res) => {
    if (demoContLock(req, res)) return;
    const u = req.user;
    if (!u.twofa) return res.status(400).json({ error: '2FA nu este activat.' });
    if (!totp.verify(u.totpSecret, (req.body || {}).code)) return res.status(400).json({ error: 'Cod gresit.' });
    u.twofa = false; delete u.totpSecret; delete u.pending2fa;
    u.tfdEpoch = (u.tfdEpoch || 0) + 1;
    logAudit('2fa.disable', u.username, { req, firmaId: null });
    db.save();
    res.json({ ok: true });
  });
  app.post('/api/2fa/revoke-devices', (req, res) => {
    if (demoContLock(req, res)) return;
    const u = req.user;
    u.tfdEpoch = (u.tfdEpoch || 0) + 1; // toate dispozitivele de incredere devin invalide
    logAudit('2fa.revoke_devices', u.username, { req, firmaId: null });
    db.save();
    res.json({ ok: true });
  });

  // ───────────────────────────── SESIUNI ACTIVE ─────────────────────────────
  app.get('/api/sessions', (req, res) => {
    res.json((req.user.sessions || []).map((s) => ({
      id: s.id, ua: s.ua, ip: s.ip, createdAt: s.createdAt, lastSeen: s.lastSeen, current: s.id === req._sessId,
    })).reverse());
  });
  app.post('/api/sessions/logout-others', (req, res) => {
    req.user.sessions = (req.user.sessions || []).filter((s) => s.id === req._sessId);
    logAudit('session.logout_others', req.user.username, { req, firmaId: null });
    db.save();
    res.json({ ok: true });
  });
  app.delete('/api/sessions/:id', (req, res) => {
    req.user.sessions = (req.user.sessions || []).filter((s) => s.id !== req.params.id);
    db.save();
    res.json({ ok: true });
  });

  // ───────────────────────────── PAROLA + PROFIL ─────────────────────────────
  app.post('/api/change-password', (req, res) => {
    if (demoContLock(req, res)) return;
    const { oldPassword, newPassword } = req.body || {};
    const u = req.user;
    if (!authlib.verifyPassword(oldPassword, u.salt, u.hash)) return res.status(400).json({ error: 'Parola veche gresita.' });
    const pwErr = authlib.validatePassword(newPassword, { username: u.username });
    if (pwErr) return res.status(400).json({ error: pwErr });
    if (String(newPassword) === String(oldPassword)) return res.status(400).json({ error: 'Parola noua trebuie sa fie diferita de cea veche.' });
    const h = authlib.hashPassword(newPassword);
    u.salt = h.salt; u.hash = h.hash; u.mustChange = false;
    logAudit('parola.schimbata', u.username, { req, firmaId: null });
    db.save();
    res.json({ ok: true });
  });
  app.get('/api/profile', (req, res) => res.json({
    username: req.user.username, email: req.user.email || '', role: req.user.role,
    tip: plans.userKind(req.user), notifyDeadlines: req.user.notifyDeadlines !== false,
    profil: req.user.profil || {},
  }));
  app.post('/api/profile', (req, res) => {
    if (demoContLock(req, res)) return;
    const b = req.body || {};
    if (b.email != null) req.user.email = String(b.email);
    if (b.notifyDeadlines != null) req.user.notifyDeadlines = !!b.notifyDeadlines;
    // date personale (necontabil / contabil): nume, telefon, adresa + autorizatia contabilului
    if (b.profil && typeof b.profil === 'object') {
      const p = req.user.profil || {};
      for (const k of ['numeComplet', 'telefon', 'adresa', 'oras', 'judet', 'autorizatie']) {
        if (b.profil[k] != null) p[k] = String(b.profil[k]).slice(0, 120).trim();
      }
      req.user.profil = p;
    }
    db.save();
    res.json({ ok: true, email: req.user.email, notifyDeadlines: req.user.notifyDeadlines !== false, profil: req.user.profil || {} });
  });
};
