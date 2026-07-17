'use strict';

// Rutele de administrare a utilizatorilor + invitatii (link de setare a parolei,
// optional trimis pe email daca SMTP e configurat). Modul de rute: register(app, ctx).

const crypto = require('crypto');
const db = require('../db');
const plans = require('../plans');
const authlib = require('../auth');

module.exports = function register(app, ctx) {
  const { requireAdmin, logAudit, startSession, publicUser } = ctx;

  app.get('/api/users', requireAdmin, (req, res) => {
    const base = (req.protocol || 'http') + '://' + req.get('host');
    res.json(db.get().users.map((u) => ({
      id: u.id, username: u.username, role: u.role, tip: plans.userKind(u), plan: plans.status(u.subscription).plan, firme: u.firme || [],
      drepturi: u.drepturi || {},
      pending: !!u.pending, inviteLink: u.pending && u.inviteToken ? base + '/?invite=' + u.inviteToken : null,
    })));
  });
  app.post('/api/users', requireAdmin, (req, res) => {
    const b = req.body || {};
    if (!b.username || !b.password) return res.status(400).json({ error: 'Utilizator si parola obligatorii.' });
    const d = db.get();
    if (d.users.some((u) => u.username === b.username)) return res.status(400).json({ error: 'Utilizator deja existent.' });
    const { salt, hash } = authlib.hashPassword(b.password);
    const u = { id: db.nextUserId(), username: b.username, email: b.email || '', salt, hash, role: b.role === 'admin' ? 'admin' : 'user', firme: Array.isArray(b.firme) ? b.firme.map(Number) : [], firmaActiva: (b.firme && b.firme[0]) || null };
    d.users.push(u);
    logAudit('user.create', b.username + ' (' + u.role + ')', { req, firmaId: null });
    db.save();
    res.json({ ok: true, user: { id: u.id, username: u.username, role: u.role, firme: u.firme } });
  });
  app.post('/api/users/:id', requireAdmin, (req, res) => {
    const u = db.getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'Utilizator inexistent' });
    const b = req.body || {};
    if (b.role) u.role = b.role === 'admin' ? 'admin' : 'user';
    if (Array.isArray(b.firme)) u.firme = b.firme.map(Number);
    if (b.drepturi && typeof b.drepturi === 'object') u.drepturi = { readonly: !!b.drepturi.readonly, faraSalarii: !!b.drepturi.faraSalarii };
    if (b.password) { const h = authlib.hashPassword(b.password); u.salt = h.salt; u.hash = h.hash; u.mustChange = false; }
    logAudit('user.update', u.username, { req, firmaId: null });
    db.save();
    res.json({ ok: true });
  });
  app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const d = db.get();
    const id = Number(req.params.id);
    if (req.user.id === id) return res.status(400).json({ error: 'Nu te poti sterge pe tine.' });
    if (d.users.filter((u) => u.role === 'admin').length <= 1 && db.getUser(id) && db.getUser(id).role === 'admin') {
      return res.status(400).json({ error: 'Trebuie sa ramana cel putin un administrator.' });
    }
    const target = db.getUser(id);
    d.users = d.users.filter((u) => u.id !== id);
    logAudit('user.delete', target ? target.username : ('id ' + id), { req, firmaId: null });
    db.save();
    res.json({ ok: true });
  });

  // ───────────────────────────── INVITATII ─────────────────────────────
  // Adminul creeaza o invitatie; rezulta un link pe care il poate trimite (manual sau prin email).
  app.post('/api/invites', requireAdmin, async (req, res) => {
    const b = req.body || {};
    if (!b.username) return res.status(400).json({ error: 'Utilizator obligatoriu.' });
    const d = db.get();
    if (d.users.some((u) => u.username === b.username)) return res.status(400).json({ error: 'Utilizator deja existent.' });
    const token = crypto.randomBytes(24).toString('hex');
    const u = {
      id: db.nextUserId(), username: b.username, email: b.email || '', salt: '', hash: '', pending: true, inviteToken: token,
      inviteExp: Date.now() + 7 * 24 * 3600 * 1000, // expira in 7 zile
      role: b.role === 'admin' ? 'admin' : 'user', firme: Array.isArray(b.firme) ? b.firme.map(Number) : [], firmaActiva: (b.firme && b.firme[0]) || null,
    };
    d.users.push(u);
    logAudit('invite.create', b.username, { req, firmaId: null });
    db.save();
    const base = (req.protocol || 'http') + '://' + req.get('host');
    const link = base + '/?invite=' + token;
    // email optional (daca SMTP e configurat) — altfel adminul copiaza linkul
    let emailed = false;
    if (b.email && d.settings.smtp && d.settings.smtp.host) {
      try { await sendInviteEmail(d.settings.smtp, b.email, link); emailed = true; } catch (e) { console.error('SMTP:', e.message); }
    }
    res.json({ ok: true, link, emailed });
  });
  function findInvite(token) {
    const u = db.get().users.find((x) => x.pending && x.inviteToken === token);
    if (!u) return { error: 'Invitatie invalida.' };
    if (u.inviteExp && u.inviteExp < Date.now()) return { error: 'Invitatie expirata. Cere alta administratorului.' };
    return { user: u };
  }
  // Public: detalii invitatie (numele de utilizator) pentru formularul de setare parola
  app.get('/api/invite/:token', (req, res) => {
    const r = findInvite(req.params.token);
    if (r.error) return res.status(404).json({ error: r.error });
    res.json({ username: r.user.username, role: r.user.role });
  });
  // Public: acceptarea invitatiei (setarea parolei) + autentificare
  app.post('/api/invite/accept', async (req, res) => {
    const { token, password } = req.body || {};
    const r = findInvite(token);
    if (r.error) return res.status(404).json({ error: r.error });
    const u = r.user;
    const pwErr = authlib.validatePassword(password, { username: u.username });
    if (pwErr) return res.status(400).json({ error: pwErr });
    const breachErr = await authlib.breachCheck(password);
    if (breachErr) return res.status(400).json({ error: breachErr });
    const h = authlib.hashPassword(password);
    u.salt = h.salt; u.hash = h.hash; u.pending = false; delete u.inviteToken; delete u.inviteExp;
    startSession(req, res, u);
    logAudit('invite.accept', u.username, { userId: u.id, username: u.username, firmaId: null });
    db.save();
    res.json({ ok: true, user: publicUser(u) });
  });

  function sendInviteEmail(smtp, to, link) {
    // hook simplu SMTP prin nodemailer daca e instalat; altfel arunca (adminul foloseste linkul).
    let nodemailer;
    try { nodemailer = require('nodemailer'); } catch (_) { throw new Error('nodemailer neinstalat'); }
    const t = nodemailer.createTransport({ host: smtp.host, port: smtp.port || 587, secure: !!smtp.secure, auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined });
    return t.sendMail({ from: smtp.from || smtp.user, to, subject: 'Invitatie Contabo', text: 'Ai fost invitat in Contabo. Seteaza-ti parola aici:\n' + link });
  }
};
