'use strict';

// Rutele de mesagerie (suport utilizator <-> administrator): conversatii, atasamente,
// editare/stergere, indicatorul „scrie acum…" si poll-ul consolidat. Modul de rute:
// register(app, ctx) — ctx aduce requireAdmin, upload (multer) si logAudit din server.js.

const path = require('path');
const fs = require('fs');
const db = require('../db');
const messages = require('../messages');
const presence = require('../presence');
const { sendMail } = require('../notify');

// Notificare pe email a administratorilor la un mesaj nou de la utilizator (best-effort):
// doar cand SMTP e configurat, niciun admin nu e online si nu suntem in cooldown.
function notifyAdminsOfNewMessage(fromUser, message, baseUrl) {
  const d = db.get();
  const smtp = d.settings.smtp;
  if (!smtp || !smtp.host || smtp.notifyNewMessage === false) return;
  const now = Date.now();
  const admins = presence.adminsToEmail(d.users, now);
  if (!admins.length) return;
  const snippet = String(message.text || (message.attachment ? '[fisier atasat]' : '')).slice(0, 300);
  const subject = 'Contabo — mesaj nou de la ' + (fromUser.username || 'un utilizator');
  const body = (fromUser.username || 'Un utilizator') + ' ti-a trimis un mesaj in Contabo:\n\n' + snippet
    + '\n\nIntra in aplicatie pentru a raspunde:\n' + (baseUrl || '')
    + '\n\n(Primesti cel mult o notificare la ' + Math.round(presence.SUPPORT_EMAIL_COOLDOWN / 60000)
    + ' min. O poti dezactiva din Setari → SMTP.)';
  for (const a of admins) {
    a.lastSupportEmailAt = now;
    sendMail(smtp, a.email, subject, body).catch((e) => console.error('SMTP mesaj nou:', e.message));
  }
  db.save();
}

// Servire atasament: doar tipuri sigure inline; restul ca attachment.
const INLINE_OK = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'application/pdf']);
// Indicator „scrie acum…": stare efemera in memorie (nu se persista).
const typingState = new Map(); // userId -> { user: tsExpira, admin: tsExpira }
function setTyping(userId, who) { const s = typingState.get(userId) || { user: 0, admin: 0 }; s[who] = Date.now() + 6000; typingState.set(userId, s); }
function isTyping(userId, who) { const s = typingState.get(userId); return !!(s && s[who] > Date.now()); }

module.exports = function register(app, ctx) {
  const { requireAdmin, upload, logAudit } = ctx;

  app.get('/api/messages', (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    if (req.user.role === 'admin' && !req.impersonating) {
      return res.json({ admin: true, threads: messages.threadsSummary(d.messages, d.users) });
    }
    const changed = messages.markRead(d.messages, req.user.id, 'user');
    if (changed) db.save();
    res.json({ admin: false, thread: messages.thread(d.messages, req.user.id) });
  });
  app.get('/api/messages/thread/:userId', requireAdmin, (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    const uid = Number(req.params.userId);
    const u = d.users.find((x) => x.id === uid);
    if (!u) return res.status(404).json({ error: 'Utilizator inexistent.' });
    const changed = messages.markRead(d.messages, uid, 'admin');
    if (changed) db.save();
    res.json({ userId: uid, username: u.username, archived: !!u.supportArchived, thread: messages.thread(d.messages, uid) });
  });
  app.post('/api/messages', upload.single('file'), (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    const text = String((req.body || {}).text || '').trim();
    const att = req.file ? { name: req.file.originalname, storedName: req.file.filename, size: req.file.size, mime: req.file.mimetype } : null;
    if (!text && !att) return res.status(400).json({ error: 'Scrie un mesaj sau ataseaza un fisier.' });
    if (text.length > messages.MAX_LEN) return res.status(400).json({ error: 'Mesaj prea lung (max ' + messages.MAX_LEN + ' caractere).' });
    let userId; let fromAdmin;
    if (req.user.role === 'admin' && !req.impersonating) {
      userId = Number((req.body || {}).userId);
      if (!d.users.find((x) => x.id === userId)) return res.status(400).json({ error: 'Alege un utilizator destinatar.' });
      fromAdmin = true;
    } else {
      userId = req.user.id; fromAdmin = false;
    }
    // un mesaj nou de la utilizator redeschide automat conversatia arhivata
    if (!fromAdmin) { const tu = d.users.find((x) => x.id === userId); if (tu && tu.supportArchived) tu.supportArchived = false; }
    const m = messages.newMessage(db.nextId('msg'), userId, fromAdmin, text, req.user.username, att);
    d.messages.push(m);
    logAudit('message.send', (fromAdmin ? 'raspuns catre utilizator #' + userId : 'cerere catre administrator') + (att ? ' [fisier atasat]' : ''), { req, firmaId: null });
    db.save();
    if (!fromAdmin) { try { notifyAdminsOfNewMessage(req.user, m, (req.protocol || 'http') + '://' + req.get('host')); } catch (e) { console.error('notify admin:', e.message); } }
    res.json({ ok: true, message: m });
  });
  app.get('/api/messages/:id/file', (req, res) => {
    const d = db.get();
    const m = (d.messages || []).find((x) => x.id === req.params.id);
    if (!m || !m.attachment) return res.status(404).json({ error: 'Atasament inexistent.' });
    const isAdmin = req.user.role === 'admin' && !req.impersonating;
    if (!isAdmin && m.userId !== req.user.id) return res.status(403).json({ error: 'Nu ai acces la acest fisier.' });
    const p = path.join(db.UPLOAD_DIR, path.basename(m.attachment.storedName));
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Fisier negasit pe server.' });
    const mime = String(m.attachment.mime || '').toLowerCase();
    const inline = INLINE_OK.has(mime);
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(m.attachment.name) + '"');
    res.sendFile(p);
  });
  app.delete('/api/messages/:id', requireAdmin, (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    const idx = d.messages.findIndex((m) => m.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Mesaj inexistent.' });
    const [removed] = d.messages.splice(idx, 1);
    if (removed.attachment && removed.attachment.storedName) {
      try { fs.unlinkSync(path.join(db.UPLOAD_DIR, path.basename(removed.attachment.storedName))); } catch (_) { /* best-effort */ }
    }
    logAudit('message.delete', 'mesaj sters din conversatia utilizatorului #' + removed.userId, { req, firmaId: null });
    db.save();
    res.json({ ok: true });
  });
  app.patch('/api/messages/:id', (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    const m = (d.messages || []).find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'Mesaj inexistent.' });
    const isAdmin = req.user.role === 'admin' && !req.impersonating;
    const canEdit = isAdmin ? m.fromAdmin : (!m.fromAdmin && m.userId === req.user.id);
    if (!canEdit) return res.status(403).json({ error: 'Poti edita doar propriile mesaje.' });
    const text = String((req.body || {}).text || '').trim();
    if (!text && !m.attachment) return res.status(400).json({ error: 'Mesajul nu poate ramane gol.' });
    if (text.length > messages.MAX_LEN) return res.status(400).json({ error: 'Mesaj prea lung (max ' + messages.MAX_LEN + ' caractere).' });
    m.text = text; m.editedAt = new Date().toISOString();
    logAudit('message.edit', 'mesaj editat in conversatia utilizatorului #' + m.userId, { req, firmaId: null });
    db.save();
    res.json({ ok: true, message: m });
  });
  app.get('/api/messages/unread', (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    const n = (req.user.role === 'admin' && !req.impersonating)
      ? messages.unreadForAdmin(d.messages)
      : messages.unreadForUser(d.messages, req.user.id);
    res.json({ unread: n });
  });
  app.get('/api/messages/search', requireAdmin, (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    res.json({ admin: true, threads: messages.searchThreads(d.messages, d.users, req.query.q || '') });
  });
  app.post('/api/messages/archive', requireAdmin, (req, res) => {
    const d = db.get();
    const u = d.users.find((x) => x.id === Number((req.body || {}).userId));
    if (!u) return res.status(404).json({ error: 'Utilizator inexistent.' });
    u.supportArchived = !!(req.body || {}).archived;
    logAudit('message.archive', (u.supportArchived ? 'arhivat' : 'redeschis') + ' conversatia utilizatorului ' + u.username, { req, firmaId: null });
    db.save();
    res.json({ ok: true, archived: u.supportArchived });
  });
  app.post('/api/messages/typing', (req, res) => {
    const isAdmin = req.user.role === 'admin' && !req.impersonating;
    if (isAdmin) { const uid = Number((req.body || {}).userId); if (uid) setTyping(uid, 'admin'); }
    else setTyping(req.user.id, 'user');
    res.json({ ok: true });
  });
  app.get('/api/messages/poll', (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    const isAdmin = req.user.role === 'admin' && !req.impersonating;
    const unread = isAdmin ? messages.unreadForAdmin(d.messages) : messages.unreadForUser(d.messages, req.user.id);
    let typing = false;
    if (isAdmin) { const uid = Number(req.query.userId); if (uid) typing = isTyping(uid, 'user'); }
    else typing = isTyping(req.user.id, 'admin');
    res.json({ unread, typing });
  });
};
