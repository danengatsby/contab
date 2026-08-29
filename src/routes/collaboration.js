'use strict';

// Rute subtiri pentru spatiul de colaborare al firmei active.
const svc = require('../collaborationService');
const notify = require('../notify');

module.exports = function register(app, ctx) {
  const { activeId, logAudit } = ctx;
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  app.get('/api/collaboration', (req, res) => run(res, () => svc.inbox(req.user, activeId(req))));
  app.get('/api/collaboration/unread', (req, res) => res.json({ unread: svc.unreadForUser(req.user) }));
  app.get('/api/tasks/mine', (req, res) => run(res, () => svc.myTasks(req.user)));
  app.post('/api/tasks/mine/read', (req, res) => run(res, () => svc.markTasksRead(req.user)));
  app.post('/api/collaboration/messages', (req, res) => run(res, () => {
    const fid = activeId(req); const r = svc.sendMessage(req.user, fid, req.body);
    logAudit('collaboration.message', 'mesaj in spatiul firmei' + (r.message.requestId ? ' · solicitare ' + r.message.requestId : ''), { req, firmaId: fid });
    return { ok: true, message: r.message };
  }));
  app.post('/api/collaboration/requests', (req, res) => run(res, () => {
    const fid = activeId(req); const r = svc.createRequest(req.user, fid, req.body);
    logAudit('collaboration.request.create', r.request.id + ' · ' + r.request.title, { req, firmaId: fid });
    if (r.assignment) notify.sendAssignmentNotification(r.assignment)
      .catch((e) => console.error('notificare alocare solicitare:', e.message));
    return { ok: true, request: r.request };
  }));
  app.patch('/api/collaboration/requests/:id', (req, res) => run(res, () => {
    const fid = activeId(req); const r = svc.updateRequest(req.user, fid, req.params.id, req.body);
    if (!r.idempotent) logAudit('collaboration.request.update', r.request.id + ' -> ' + r.request.status, { req, firmaId: fid });
    if (r.assignment) notify.sendAssignmentNotification(r.assignment)
      .catch((e) => console.error('notificare realocare solicitare:', e.message));
    return { ok: true, request: r.request, idempotent: !!r.idempotent };
  }));
};
