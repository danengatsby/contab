'use strict';

// Rutele de mesagerie — strat SUBTIRE peste src/messagesService.js: parseaza cererea,
// construieste actorul { user, isAdmin }, apeleaza serviciul si traduce erorile lui
// (`err.status`) in raspunsuri HTTP. Indicatorul „scrie acum…" si poll-ul raman aici:
// stare efemera in memorie + citiri, fara logica de business. Modul de rute:
// register(app, ctx) — ctx aduce requireAdmin, upload (multer) si logAudit din server.js.

const db = require('../db');
const messages = require('../messages');
const svc = require('../messagesService');
const collaboration = require('../collaborationService');
const { capList } = require('../paginate');

// Indicator „scrie acum…": stare efemera in memorie (nu se persista).
const typingState = new Map(); // userId -> { user: tsExpira, admin: tsExpira }
function setTyping(userId, who) { const s = typingState.get(userId) || { user: 0, admin: 0 }; s[who] = Date.now() + 6000; typingState.set(userId, s); }
function isTyping(userId, who) { const s = typingState.get(userId); return !!(s && s[who] > Date.now()); }

module.exports = function register(app, ctx) {
  const { requireAdmin, upload, logAudit } = ctx;

  // Erorile de business poarta `status` (400/403/404); restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };
  const actor = (req) => ({ user: req.user, isAdmin: req.user.role === 'admin' && !req.impersonating });

  app.get('/api/messages', (req, res) => run(res, () => svc.inbox(actor(req))));
  app.get('/api/messages/thread/:userId', requireAdmin, (req, res) => run(res, () => svc.threadForAdmin(req.params.userId)));

  app.post('/api/messages', upload.single('file'), (req, res) => run(res, () => {
    const att = req.file ? { name: req.file.originalname, storedName: req.file.filename, size: req.file.size, mime: req.file.mimetype } : null;
    const r = svc.sendMessage(actor(req), req.body, att);
    logAudit('message.send', (r.fromAdmin ? 'raspuns catre utilizator #' + r.userId : 'cerere catre administrator') + (att ? ' [fisier atasat]' : ''), { req, firmaId: null });
    if (!r.fromAdmin) { try { svc.notifyAdminsOfNewMessage(req.user, r.message, (req.protocol || 'http') + '://' + req.get('host')); } catch (e) { console.error('notify admin:', e.message); } }
    return { ok: true, message: r.message };
  }));

  app.get('/api/messages/:id/file', (req, res) => {
    let f;
    try { f = svc.attachmentFile(actor(req), req.params.id); } catch (e) {
      if (!e.status) throw e;
      return res.status(e.status).json({ error: e.message });
    }
    res.setHeader('Content-Type', f.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', (f.inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(f.name) + '"');
    res.sendFile(f.path);
  });

  app.delete('/api/messages/:id', requireAdmin, (req, res) => run(res, () => {
    const r = svc.deleteMessage(req.params.id);
    logAudit('message.delete', 'mesaj sters din conversatia utilizatorului #' + r.removed.userId, { req, firmaId: null });
    return { ok: true };
  }));

  app.patch('/api/messages/:id', (req, res) => run(res, () => {
    const r = svc.editMessage(actor(req), req.params.id, (req.body || {}).text);
    logAudit('message.edit', 'mesaj editat in conversatia utilizatorului #' + r.message.userId, { req, firmaId: null });
    return { ok: true, message: r.message };
  }));

  app.post('/api/messages/archive', requireAdmin, (req, res) => run(res, () => {
    const b = req.body || {};
    const r = svc.archiveThread(b.userId, b.archived);
    logAudit('message.archive', (r.archived ? 'arhivat' : 'redeschis') + ' conversatia utilizatorului ' + r.username, { req, firmaId: null });
    return { ok: true, archived: r.archived };
  }));

  // ── citiri + stare efemera (fara logica de business) ──
  app.get('/api/messages/unread', (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    const n = actor(req).isAdmin ? messages.unreadForAdmin(d.messages)
      : messages.unreadForUser(d.messages, req.user.id) + collaboration.unreadForUser(req.user);
    res.json({ unread: n });
  });
  app.get('/api/messages/search', requireAdmin, (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    const s = capList(messages.searchThreads(d.messages, d.users, req.query.q || ''), 0, 'messages.search');
    res.json({ admin: true, threads: s.items, threadsTotal: s.total, threadsTruncated: s.truncated });
  });
  app.post('/api/messages/typing', (req, res) => {
    if (actor(req).isAdmin) { const uid = Number((req.body || {}).userId); if (uid) setTyping(uid, 'admin'); }
    else setTyping(req.user.id, 'user');
    res.json({ ok: true });
  });
  app.get('/api/messages/poll', (req, res) => {
    const d = db.get(); d.messages = d.messages || [];
    const isAdmin = actor(req).isAdmin;
    const unread = isAdmin ? messages.unreadForAdmin(d.messages)
      : messages.unreadForUser(d.messages, req.user.id) + collaboration.unreadForUser(req.user);
    let typing = false;
    if (isAdmin) { const uid = Number(req.query.userId); if (uid) typing = isTyping(uid, 'user'); }
    else typing = isTyping(req.user.id, 'admin');
    res.json({ unread, typing });
  });
};
