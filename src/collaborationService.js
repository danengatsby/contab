'use strict';

// Colaborarea operationala patron <-> contabil, strict pe firma:
//   - un fir de mesaje comun membrilor firmei;
//   - solicitari cu responsabil, termen, stare si legatura optionala la document/articol.
// Canalul de suport user <-> administrator ramane separat in messagesService.js.

const db = require('./db');
const permissions = require('./permissions');
const monthlyClose = require('./monthlyClose');
const { capList } = require('./paginate');
const { validIsoDate, naturalCompare } = require('./util');

const MESSAGE_MAX = 4000;
const TITLE_MAX = 160;
const DESCRIPTION_MAX = 2000;
const RESOLUTION_MAX = 1000;
const THREAD_MAX = Number(process.env.CONTAB_COLLAB_MESSAGES_MAX) || 500;
const REQUEST_MAX = Number(process.env.CONTAB_WORK_REQUESTS_MAX) || 500;
const STATUSES = new Set(['deschisa', 'in_lucru', 'blocata', 'rezolvata']);
const ENTITY_TYPES = new Set(['', 'document', 'entry']);

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Garda de firma este dublata in serviciu; ruta nu este singurul strat de autorizare. */
function reqFirma(user, fid) {
  fid = Number(fid);
  const firma = db.getFirma(fid);
  if (!firma) fail(404, 'Firma nu exista.');
  // Spatiul de colaborare apartine relatiei cu firma, nu unei arii contabile. Un responsabil
  // exclusiv de salarizare sau trezorerie trebuie sa poata primi si comenta sarcini fara a primi
  // implicit dreptul `read` pe contabilitatea generala.
  if (!permissions.roleFor(user, fid, firma)) fail(403, 'Nu ai un rol activ pe aceasta firma.');
  return { fid, firma };
}

function userName(u) { return String(((u && u.profil) || {}).numeComplet || (u && u.username) || '').slice(0, 120); }
function memberKind(u, firma) { return Number(firma.ownerId) === Number(u.id) ? 'patron' : 'contabil'; }

function membersFor(d, firma) {
  const rows = (d.users || [])
    .filter((u) => u.role !== 'admin' && !u.pending && Array.isArray(u.firme) && u.firme.includes(firma.id))
    .map((u) => ({
      id: u.id,
      username: u.username,
      name: userName(u),
      kind: memberKind(u, firma),
      role: permissions.roleFor(u, firma.id, firma),
    }))
    .sort((a, b) => naturalCompare(a.name, b.name));
  return capList(rows, 0, 'collaboration.members').items;
}

function reqMember(d, firma, uid) {
  const id = Number(uid);
  const u = (d.users || []).find((x) => Number(x.id) === id && !x.pending
    && Array.isArray(x.firme) && x.firme.includes(firma.id));
  if (!u) fail(400, 'Responsabilul ales nu are acces activ la aceasta firma.');
  return u;
}

function cleanEntity(d, fid, type, rawId) {
  const entityType = String(type || '').trim();
  const entityId = String(rawId || '').trim().slice(0, 120);
  if (!ENTITY_TYPES.has(entityType)) fail(400, 'Tip de legatura necunoscut.');
  if (!entityType && entityId) fail(400, 'Alege tipul obiectului la care se leaga solicitarea.');
  if (entityType && !entityId) fail(400, 'Completeaza identificatorul documentului sau articolului.');
  if (entityType === 'document' && !(d.documents || []).some((x) => Number(x.firmaId) === fid && String(x.id) === entityId)) {
    fail(404, 'Documentul ales nu exista in firma activa.');
  }
  if (entityType === 'entry' && !(d.entries || []).some((x) => Number(x.firmaId) === fid && String(x.id) === entityId)) {
    fail(404, 'Articolul ales nu exista in firma activa.');
  }
  return { entityType, entityId };
}

function publicRequest(r, d, firma, viewerId) {
  const maker = (d.users || []).find((u) => Number(u.id) === Number(r.createdBy));
  const assignee = (d.users || []).find((u) => Number(u.id) === Number(r.assignedTo));
  const assignedKind = assignee ? memberKind(assignee, firma) : '';
  return Object.assign({}, r, {
    createdByName: r.createdByName || userName(maker) || 'Utilizator',
    assignedName: assignee ? userName(assignee) : '',
    assignedKind,
    bucket: r.status === 'rezolvata' ? 'resolved' : (Number(r.assignedTo) === Number(viewerId) ? 'mine' : 'other'),
  });
}

function appendEvent(d, fid, actor, text, requestId) {
  d.collaborationMessages = d.collaborationMessages || [];
  const m = {
    id: db.nextId('cm'), firmaId: fid, kind: 'system', text: String(text || '').slice(0, MESSAGE_MAX),
    fromUserId: actor.id, author: userName(actor), requestId: requestId || null,
    createdAt: new Date().toISOString(), readBy: [Number(actor.id)],
  };
  d.collaborationMessages.push(m);
  return m;
}

/** Deschide spatiul firmei si marcheaza mesajele ca citite pentru actor. */
function inbox(user, fid) {
  const { fid: id, firma } = reqFirma(user, fid);
  const d = db.get();
  d.collaborationMessages = d.collaborationMessages || [];
  d.workRequests = d.workRequests || [];
  let changed = false;
  const allMessages = d.collaborationMessages.filter((m) => Number(m.firmaId) === id)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const m of allMessages) {
    m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
    if (!m.readBy.some((uid) => Number(uid) === Number(user.id))) { m.readBy.push(Number(user.id)); changed = true; }
  }
  if (changed) db.save();
  const mt = capList(allMessages, THREAD_MAX, 'collaboration.messages');
  const requests = d.workRequests.filter((r) => Number(r.firmaId) === id)
    .map((r) => publicRequest(r, d, firma, user.id))
    .sort((a, b) => {
      if ((a.status === 'rezolvata') !== (b.status === 'rezolvata')) return a.status === 'rezolvata' ? 1 : -1;
      const ad = a.due || '9999-99-99'; const bd = b.due || '9999-99-99';
      return ad === bd ? String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)) : ad.localeCompare(bd);
    });
  const rt = capList(requests, REQUEST_MAX, 'collaboration.requests', { pastreaza: 'cap' });
  const docs = capList((d.documents || []).filter((x) => Number(x.firmaId) === id)
    .sort((a, b) => String(b.createdAt || b.data || '').localeCompare(String(a.createdAt || a.data || '')))
    .map((x) => ({ type: 'document', id: x.id, label: x.originalName || x.name || x.tip || ('Document ' + x.id) })),
  100, 'collaboration.linkable-documents').items;
  const entries = capList((d.entries || []).filter((x) => Number(x.firmaId) === id)
    .sort((a, b) => String(b.data || b.createdAt || '').localeCompare(String(a.data || a.createdAt || '')))
    .map((x) => ({ type: 'entry', id: x.id, label: [x.document || x.tipNume || ('Articol ' + x.id), x.data, x.partener].filter(Boolean).join(' · ') })),
  100, 'collaboration.linkable-entries').items;
  return {
    company: { id, name: firma.nume || ('Firma ' + id) },
    members: membersFor(d, firma),
    messages: mt.items, messagesTotal: mt.total, messagesTruncated: mt.truncated,
    requests: rt.items, requestsTotal: rt.total, requestsTruncated: rt.truncated,
    linkables: docs.concat(entries),
  };
}

function sendMessage(user, fid, body) {
  const { fid: id } = reqFirma(user, fid);
  const d = db.get(); const b = body || {};
  const text = String(b.text || '').trim();
  if (!text) fail(400, 'Scrie un mesaj.');
  if (text.length > MESSAGE_MAX) fail(400, 'Mesaj prea lung (maxim ' + MESSAGE_MAX + ' caractere).');
  let requestId = null;
  if (b.requestId != null && String(b.requestId).trim()) {
    requestId = String(b.requestId);
    if (!(d.workRequests || []).some((r) => Number(r.firmaId) === id && String(r.id) === requestId)) {
      fail(404, 'Solicitarea legata de mesaj nu exista in firma activa.');
    }
  }
  const entity = cleanEntity(d, id, b.entityType, b.entityId);
  const m = {
    id: db.nextId('cm'), firmaId: id, kind: 'message', text,
    fromUserId: user.id, author: userName(user), requestId,
    entityType: entity.entityType, entityId: entity.entityId,
    createdAt: new Date().toISOString(), readBy: [Number(user.id)],
  };
  d.collaborationMessages = d.collaborationMessages || [];
  d.collaborationMessages.push(m); db.save();
  return { message: m };
}

function createRequest(user, fid, body) {
  const { fid: id, firma } = reqFirma(user, fid);
  const d = db.get(); const b = body || {};
  const title = String(b.title || '').trim();
  if (!title) fail(400, 'Completeaza ce trebuie facut.');
  if (title.length > TITLE_MAX) fail(400, 'Titlu prea lung (maxim ' + TITLE_MAX + ' caractere).');
  const description = String(b.description || '').trim();
  if (description.length > DESCRIPTION_MAX) fail(400, 'Descriere prea lunga (maxim ' + DESCRIPTION_MAX + ' caractere).');
  const assigned = reqMember(d, firma, b.assignedTo);
  const due = String(b.due || '').trim();
  if (due && !validIsoDate(due)) fail(400, 'Termenul trebuie sa fie o data calendaristica reala.');
  const entity = cleanEntity(d, id, b.entityType, b.entityId);
  const now = new Date().toISOString();
  const r = {
    id: db.nextId('wrk'), firmaId: id, title, description,
    assignedTo: assigned.id, status: 'deschisa', due: due || null,
    assignedAt: now, assignedBy: user.id, assignedByName: userName(user),
    entityType: entity.entityType, entityId: entity.entityId,
    createdBy: user.id, createdByName: userName(user), createdAt: now, updatedAt: now,
    history: [{ status: 'deschisa', assignedTo: assigned.id, by: user.id, at: now }],
  };
  d.workRequests = d.workRequests || []; d.workRequests.push(r);
  appendEvent(d, id, user, userName(user) + ' a creat solicitarea „' + title + '” pentru ' + userName(assigned) + '.', r.id);
  db.save();
  return {
    request: publicRequest(r, d, firma, user.id),
    assignment: Number(assigned.id) === Number(user.id) ? null : {
      userId: assigned.id, firmaId: id, firma: firma.nume || '', title, due: due || null,
      source: 'request', assignedBy: userName(user),
    },
  };
}

function updateRequest(user, fid, requestId, patch) {
  const { fid: id, firma } = reqFirma(user, fid);
  const d = db.get(); const b = patch || {};
  const r = (d.workRequests || []).find((x) => Number(x.firmaId) === id && String(x.id) === String(requestId));
  if (!r) fail(404, 'Solicitarea nu exista in firma activa.');
  const before = { status: r.status, assignedTo: r.assignedTo, due: r.due || null };
  if (Object.prototype.hasOwnProperty.call(b, 'status')) {
    const status = String(b.status || '');
    if (!STATUSES.has(status)) fail(400, 'Stare de solicitare invalida.');
    r.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'assignedTo')) r.assignedTo = reqMember(d, firma, b.assignedTo).id;
  if (Object.prototype.hasOwnProperty.call(b, 'due')) {
    const due = String(b.due || '').trim();
    if (due && !validIsoDate(due)) fail(400, 'Termenul trebuie sa fie o data calendaristica reala.');
    r.due = due || null;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'resolution')) {
    const resolution = String(b.resolution || '').trim();
    if (resolution.length > RESOLUTION_MAX) fail(400, 'Rezolutia este prea lunga.');
    r.resolution = resolution;
  }
  const changed = before.status !== r.status || Number(before.assignedTo) !== Number(r.assignedTo) || before.due !== (r.due || null)
    || Object.prototype.hasOwnProperty.call(b, 'resolution');
  if (!changed) return { request: publicRequest(r, d, firma, user.id), idempotent: true };
  const now = new Date().toISOString(); r.updatedAt = now;
  let assignment = null;
  if (Number(before.assignedTo) !== Number(r.assignedTo)) {
    r.assignedAt = now; r.assignedBy = user.id; r.assignedByName = userName(user);
    if (Number(r.assignedTo) !== Number(user.id)) assignment = {
      userId: r.assignedTo, firmaId: id, firma: firma.nume || '', title: r.title, due: r.due || null,
      source: 'request', assignedBy: userName(user),
    };
  }
  if (r.status === 'rezolvata') { r.resolvedAt = now; r.resolvedBy = user.id; }
  else { delete r.resolvedAt; delete r.resolvedBy; }
  r.history = Array.isArray(r.history) ? r.history : [];
  r.history.push({ status: r.status, assignedTo: r.assignedTo, due: r.due || null, by: user.id, at: now });
  const assigned = (d.users || []).find((u) => Number(u.id) === Number(r.assignedTo));
  const label = r.status === 'rezolvata' ? 'a rezolvat' : r.status === 'in_lucru' ? 'a preluat' : r.status === 'blocata' ? 'a blocat' : 'a redeschis';
  appendEvent(d, id, user, userName(user) + ' ' + label + ' solicitarea „' + r.title + '”' + (assigned ? ' · responsabil: ' + userName(assigned) : '') + '.', r.id);
  db.save();
  return { request: publicRequest(r, d, firma, user.id), idempotent: false, assignment };
}

/** Toate sarcinile deschise ale utilizatorului, peste firme: solicitari + pasi de inchidere. */
function myTasks(user) {
  if (!user) fail(401, 'Autentificare necesară.');
  const d = db.get(); const uid = Number(user.id);
  const allowed = new Set((user.role === 'admin' ? (d.firme || []).map((f) => f.id) : (user.firme || [])).map(Number));
  const seenAt = String(user.taskInboxSeenAt || ''); const tasks = [];
  const companyName = (fid) => ((d.firme || []).find((f) => Number(f.id) === Number(fid)) || {}).nume || ('Firma ' + fid);
  for (const r of d.workRequests || []) {
    if (!allowed.has(Number(r.firmaId)) || Number(r.assignedTo) !== uid || r.status === 'rezolvata') continue;
    const assignedAt = String(r.assignedAt || r.createdAt || '');
    tasks.push({
      id: r.id, source: 'request', firmaId: r.firmaId, firma: companyName(r.firmaId), title: r.title,
      description: r.description || '', due: r.due || null, status: r.status, assignedAt,
      unread: !!assignedAt && Number(r.assignedBy) !== uid && (!seenAt || assignedAt > seenAt),
    });
  }
  for (const rec of d.closings || []) {
    if (!allowed.has(Number(rec.firmaId)) || !rec.period || !rec.steps) continue;
    const firma = (d.firme || []).find((f) => Number(f.id) === Number(rec.firmaId));
    if (!permissions.can(user, rec.firmaId, 'read', firma)) continue;
    const assignedKeys = Object.keys(rec.steps).filter((key) => Number((rec.steps[key] || {}).responsabilId) === uid);
    if (!assignedKeys.length) continue;
    let state;
    try { state = monthlyClose.status(d, db.scoped(rec.firmaId), rec.period, { users: [] }); } catch (_) { continue; }
    for (const key of assignedKeys) {
      const step = (state.steps || []).find((s) => s.key === key); const cfg = rec.steps[key] || {};
      if (!step || step.stare === 'gata' || step.stare === 'nuseaplica') continue;
      const assignedAt = String(cfg.assignedAt || '');
      tasks.push({
        id: rec.id + ':' + key, source: 'monthly-close', firmaId: rec.firmaId, firma: companyName(rec.firmaId),
        title: step.nume, description: step.descriere || '', period: rec.period, step: key, tab: step.tab || 'inchideri',
        due: step.due || null, status: step.stare, assignedAt,
        unread: !!assignedAt && Number(cfg.assignedBy) !== uid && (!seenAt || assignedAt > seenAt),
      });
    }
  }
  tasks.sort((a, b) => {
    const ad = a.due || '9999-99-99'; const bd = b.due || '9999-99-99';
    return ad === bd ? String(b.assignedAt || '').localeCompare(String(a.assignedAt || '')) : ad.localeCompare(bd);
  });
  const unread = tasks.filter((t) => t.unread).length;
  const capped = capList(tasks, REQUEST_MAX, 'tasks.mine');
  return { items: capped.items, count: capped.total, truncated: capped.truncated,
    unread };
}

function markTasksRead(user) {
  if (!user) fail(401, 'Autentificare necesară.');
  user.taskInboxSeenAt = new Date().toISOString(); db.save();
  return { ok: true, seenAt: user.taskInboxSeenAt };
}

/** Numarul de mesaje necitite din toate firmele utilizatorului; folosit de badge/poll. */
function unreadForUser(user) {
  if (!user || user.role === 'admin') return 0;
  const allowed = new Set((user.firme || []).map(Number));
  return capList(db.get().collaborationMessages || [], Math.max(THREAD_MAX, THREAD_MAX * allowed.size),
    'collaboration.unread').items.filter((m) => allowed.has(Number(m.firmaId))
    && Number(m.fromUserId) !== Number(user.id)
    && !(Array.isArray(m.readBy) && m.readBy.some((uid) => Number(uid) === Number(user.id)))).length;
}

module.exports = {
  inbox, sendMessage, createRequest, updateRequest, unreadForUser, myTasks, markTasksRead,
  STATUSES, ENTITY_TYPES, MESSAGE_MAX, THREAD_MAX, REQUEST_MAX,
};
