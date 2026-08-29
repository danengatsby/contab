'use strict';

// Colaborarea operationala patron <-> contabil, strict pe firma:
//   - un fir de mesaje comun membrilor firmei;
//   - solicitari cu responsabil, termen, stare si legatura obligatorie la obiectul real.
// Canalul de suport user <-> administrator ramane separat in messagesService.js.

const db = require('./db');
const permissions = require('./permissions');
const monthlyClose = require('./monthlyClose');
const declarations = require('./declarations');
const { capList } = require('./paginate');
const { validIsoDate, naturalCompare } = require('./util');

const MESSAGE_MAX = 4000;
const TITLE_MAX = 160;
const DESCRIPTION_MAX = 2000;
const RESOLUTION_MAX = 1000;
const THREAD_MAX = Number(process.env.CONTAB_COLLAB_MESSAGES_MAX) || 500;
const REQUEST_MAX = Number(process.env.CONTAB_WORK_REQUESTS_MAX) || 500;
const STATUSES = new Set(['deschisa', 'asteapta_patronul', 'asteapta_contabilul', 'in_verificare', 'rezolvata']);
const REQUEST_TYPES = new Set(['document', 'clarificare', 'confirmare', 'aprobare', 'completare', 'semnare', 'alta']);
const ENTITY_TYPES = new Set(['', 'document', 'entry', 'bank_statement', 'declaration', 'closing_step']);
const REQUEST_TYPE_LABELS = {
  document: 'Document solicitat', clarificare: 'Clarificare', confirmare: 'Confirmare',
  aprobare: 'Aprobare', completare: 'Completare', semnare: 'Semnare', alta: 'Altă solicitare',
};
const ENTITY_TYPE_LABELS = {
  document: 'Document', entry: 'Articol contabil', bank_statement: 'Extras bancar',
  declaration: 'Declarație', closing_step: 'Pas din închiderea lunară',
};

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

function declarationIdentity(rec) {
  return (rec.dossier && rec.dossier.id) || declarations.dossierIdentity(rec.firmaId, rec.tip, rec.period).id;
}

function closingStepIdentity(period, key) { return String(period) + '|' + String(key); }

function closingStepParts(rawId) {
  const parts = String(rawId || '').split('|');
  return parts.length === 2 && /^\d{4}-(0[1-9]|1[0-2])$/.test(parts[0])
    && monthlyClose.STEP_KEYS.includes(parts[1]) ? { period: parts[0], key: parts[1] } : null;
}

function entityPermission(type) { return type === 'bank_statement' ? 'treasury.read' : 'read'; }

function canAccessEntity(user, firma, type) {
  return !type || !!firma && permissions.can(user, firma.id, entityPermission(type), firma);
}

function cleanEntity(d, fid, type, rawId, required, actor, firma) {
  const entityType = String(type || '').trim();
  const entityId = String(rawId || '').trim().slice(0, 120);
  if (!ENTITY_TYPES.has(entityType)) fail(400, 'Tip de legatura necunoscut.');
  if (required && !entityType) fail(400, 'Leagă solicitarea de un document, articol, extras, declarație sau pas din închidere.');
  if (!entityType && entityId) fail(400, 'Alege tipul obiectului la care se leaga solicitarea.');
  if (entityType && !entityId) fail(400, 'Alege obiectul real la care se leagă solicitarea.');
  if (entityType && actor && !canAccessEntity(actor, firma, entityType)) {
    fail(403, 'Rolul activ nu permite accesul la acest tip de obiect.');
  }
  if (entityType === 'document' && !(d.documents || []).some((x) => Number(x.firmaId) === fid && String(x.id) === entityId)) {
    fail(404, 'Documentul ales nu exista in firma activa.');
  }
  if (entityType === 'entry' && !(d.entries || []).some((x) => Number(x.firmaId) === fid && String(x.id) === entityId)) {
    fail(404, 'Articolul ales nu exista in firma activa.');
  }
  if (entityType === 'bank_statement' && !(d.bankStatements || []).some((x) => Number(x.firmaId) === fid && String(x.id) === entityId)) {
    fail(404, 'Extrasul bancar ales nu exista in firma activa.');
  }
  if (entityType === 'declaration' && !(d.declarations || []).some((x) => Number(x.firmaId) === fid && declarationIdentity(x) === entityId)) {
    fail(404, 'Declarația aleasă nu există în firma activă.');
  }
  if (entityType === 'closing_step' && !closingStepParts(entityId)) {
    fail(404, 'Pasul de închidere ales nu există.');
  }
  return { entityType, entityId };
}

function entityDetails(d, fid, type, id, viewer, firma) {
  const entityType = String(type || ''); const entityId = String(id || '');
  if (!entityType || !entityId) return null;
  if (viewer && !canAccessEntity(viewer, firma, entityType)) return {
    type: entityType, id: entityId, typeLabel: ENTITY_TYPE_LABELS[entityType] || entityType,
    label: (ENTITY_TYPE_LABELS[entityType] || 'Obiect') + ' · acces restricționat',
    available: false, restricted: true, tab: null, period: null, href: null,
  };
  let row; let label = ENTITY_TYPE_LABELS[entityType] || 'Obiect'; let tab = null; let period = null; let href = null;
  if (entityType === 'document') {
    row = (d.documents || []).find((x) => Number(x.firmaId) === fid && String(x.id) === entityId);
    if (row) { label += ' · ' + (row.originalName || row.fileName || row.name || row.tip || row.id); href = '/api/document/' + encodeURIComponent(row.id) + '/file'; }
  } else if (entityType === 'entry') {
    row = (d.entries || []).find((x) => Number(x.firmaId) === fid && String(x.id) === entityId);
    if (row) { label += ' · ' + [row.document || row.tipNume || row.tip || row.id, row.data, row.partener].filter(Boolean).join(' · '); tab = 'jurnal'; period = String(row.data || '').slice(0, 7) || null; }
  } else if (entityType === 'bank_statement') {
    row = (d.bankStatements || []).find((x) => Number(x.firmaId) === fid && String(x.id) === entityId);
    if (row) { label += ' · ' + [row.fileName || row.id, row.iban, row.periodFrom && row.periodTo ? row.periodFrom + '–' + row.periodTo : ''].filter(Boolean).join(' · '); tab = 'reconciliere'; period = String(row.periodTo || row.periodFrom || '').slice(0, 7) || null; }
  } else if (entityType === 'declaration') {
    row = (d.declarations || []).find((x) => Number(x.firmaId) === fid && declarationIdentity(x) === entityId);
    if (row) { label += ' · ' + String(row.tip || '').toUpperCase() + ' · ' + row.period; tab = 'livrabile'; period = row.period || null; }
  } else if (entityType === 'closing_step') {
    const parts = closingStepParts(entityId); const step = parts && monthlyClose.STEPS.find((x) => x.key === parts.key);
    if (step) { row = step; label += ' · ' + step.nume + ' · ' + parts.period; tab = step.tab || 'inchideri'; period = parts.period; }
  }
  return { type: entityType, id: entityId, typeLabel: ENTITY_TYPE_LABELS[entityType] || entityType,
    label: row ? label : (ENTITY_TYPE_LABELS[entityType] || 'Obiect') + ' indisponibil · ' + entityId,
    available: !!row, tab, period, href };
}

function canEditRequest(user, firma, r) {
  return user.role === 'admin' || Number(firma.ownerId) === Number(user.id)
    || Number(r.createdBy) === Number(user.id) || Number(r.assignedTo) === Number(user.id);
}

function publicRequest(r, d, firma, viewer) {
  const maker = (d.users || []).find((u) => Number(u.id) === Number(r.createdBy));
  const assignee = (d.users || []).find((u) => Number(u.id) === Number(r.assignedTo));
  const assignedKind = assignee ? memberKind(assignee, firma) : '';
  const entity = entityDetails(d, firma.id, r.entityType, r.entityId, viewer, firma);
  return Object.assign({}, r, {
    companyName: firma.nume || ('Firma ' + firma.id),
    requestType: REQUEST_TYPES.has(r.requestType) ? r.requestType : 'alta',
    requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || REQUEST_TYPE_LABELS.alta,
    createdByName: r.createdByName || userName(maker) || 'Utilizator',
    assignedName: assignee ? userName(assignee) : '',
    assignedKind,
    entityId: entity && entity.restricted ? '' : r.entityId,
    resolutionEvidence: r.resolutionEvidence && entity && entity.restricted
      ? Object.assign({}, r.resolutionEvidence, { entityId: '' }) : r.resolutionEvidence,
    entity,
    conversationCount: (d.collaborationMessages || []).filter((m) => m.kind === 'message'
      && String(m.requestId || '') === String(r.id)).length,
    canEdit: canEditRequest(viewer, firma, r),
    bucket: r.status === 'rezolvata' ? 'resolved' : (Number(r.assignedTo) === Number(viewer.id) ? 'mine' : 'other'),
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
    .map((r) => publicRequest(r, d, firma, user))
    .sort((a, b) => {
      if ((a.status === 'rezolvata') !== (b.status === 'rezolvata')) return a.status === 'rezolvata' ? 1 : -1;
      const ad = a.due || '9999-99-99'; const bd = b.due || '9999-99-99';
      return ad === bd ? String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)) : ad.localeCompare(bd);
    });
  const rt = capList(requests, REQUEST_MAX, 'collaboration.requests', { pastreaza: 'cap' });
  const generalAccess = permissions.can(user, id, 'read', firma);
  const treasuryAccess = permissions.can(user, id, 'treasury.read', firma);
  const docs = capList((generalAccess ? (d.documents || []) : []).filter((x) => Number(x.firmaId) === id)
    .sort((a, b) => String(b.createdAt || b.data || '').localeCompare(String(a.createdAt || a.data || '')))
    .map((x) => ({ type: 'document', id: x.id, label: x.originalName || x.name || x.tip || ('Document ' + x.id) })),
  100, 'collaboration.linkable-documents').items;
  const entries = capList((generalAccess ? (d.entries || []) : []).filter((x) => Number(x.firmaId) === id)
    .sort((a, b) => String(b.data || b.createdAt || '').localeCompare(String(a.data || a.createdAt || '')))
    .map((x) => ({ type: 'entry', id: x.id, label: [x.document || x.tipNume || ('Articol ' + x.id), x.data, x.partener].filter(Boolean).join(' · ') })),
  100, 'collaboration.linkable-entries').items;
  const statements = capList((treasuryAccess ? (d.bankStatements || []) : []).filter((x) => Number(x.firmaId) === id)
    .sort((a, b) => String(b.importedAt || b.periodTo || '').localeCompare(String(a.importedAt || a.periodTo || '')))
    .map((x) => ({ type: 'bank_statement', id: x.id,
      label: [x.fileName || ('Extras ' + x.id), x.iban, x.periodFrom && x.periodTo ? x.periodFrom + '–' + x.periodTo : ''].filter(Boolean).join(' · ') })),
  100, 'collaboration.linkable-statements').items;
  const declarationRows = capList((generalAccess ? (d.declarations || []) : []).filter((x) => Number(x.firmaId) === id)
    .sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')))
    .map((x) => ({ type: 'declaration', id: declarationIdentity(x),
      label: [String(x.tip || '').toUpperCase(), x.period, x.status].filter(Boolean).join(' · ') })),
  100, 'collaboration.linkable-declarations').items;
  const periods = new Set((d.closings || []).filter((x) => Number(x.firmaId) === id).map((x) => x.period).filter(Boolean));
  const cursor = new Date(); cursor.setUTCDate(1);
  for (let i = 0; i < 12; i += 1) {
    periods.add(cursor.toISOString().slice(0, 7)); cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  const closingSteps = capList((generalAccess ? [...periods] : []).sort().reverse().flatMap((period) => monthlyClose.STEPS.map((step) => ({
    type: 'closing_step', id: closingStepIdentity(period, step.key), label: period + ' · ' + step.nume,
  }))), 120, 'collaboration.linkable-closing-steps').items;
  return {
    company: { id, name: firma.nume || ('Firma ' + id) },
    members: membersFor(d, firma),
    messages: mt.items, messagesTotal: mt.total, messagesTruncated: mt.truncated,
    requests: rt.items, requestsTotal: rt.total, requestsTruncated: rt.truncated,
    requestTypes: Object.entries(REQUEST_TYPE_LABELS).map(([value, label]) => ({ value, label })),
    entityTypes: ENTITY_TYPE_LABELS,
    linkables: docs.concat(entries, statements, declarationRows, closingSteps),
  };
}

function sendMessage(user, fid, body) {
  const { fid: id, firma } = reqFirma(user, fid);
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
  const entity = cleanEntity(d, id, b.entityType, b.entityId, false, user, firma);
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
  const requestType = String(b.requestType || '').trim();
  if (!REQUEST_TYPES.has(requestType)) fail(400, 'Alege tipul solicitării.');
  const assigned = reqMember(d, firma, b.assignedTo);
  const due = String(b.due || '').trim();
  if (due && !validIsoDate(due)) fail(400, 'Termenul trebuie sa fie o data calendaristica reala.');
  const entity = cleanEntity(d, id, b.entityType, b.entityId, true, user, firma);
  if (!canAccessEntity(assigned, firma, entity.entityType)) {
    fail(400, 'Responsabilul ales nu are acces la obiectul asociat.');
  }
  const now = new Date().toISOString();
  const r = {
    id: db.nextId('wrk'), firmaId: id, title, description, requestType,
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
    request: publicRequest(r, d, firma, user),
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
  if (!canEditRequest(user, firma, r)) fail(403, 'Numai solicitantul, responsabilul sau patronul poate actualiza această solicitare.');
  const before = { status: r.status, assignedTo: r.assignedTo, due: r.due || null,
    requestType: r.requestType || 'alta', entityType: r.entityType || '', entityId: r.entityId || '',
    resolution: r.resolution || '' };
  const next = Object.assign({}, r);
  if (Object.prototype.hasOwnProperty.call(b, 'status')) {
    const status = String(b.status || '');
    if (!STATUSES.has(status)) fail(400, 'Stare de solicitare invalida.');
    next.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'assignedTo')) next.assignedTo = reqMember(d, firma, b.assignedTo).id;
  if (Object.prototype.hasOwnProperty.call(b, 'due')) {
    const due = String(b.due || '').trim();
    if (due && !validIsoDate(due)) fail(400, 'Termenul trebuie sa fie o data calendaristica reala.');
    next.due = due || null;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'requestType')) {
    const requestType = String(b.requestType || '').trim();
    if (!REQUEST_TYPES.has(requestType)) fail(400, 'Alege tipul solicitării.');
    next.requestType = requestType;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'entityType') || Object.prototype.hasOwnProperty.call(b, 'entityId')) {
    Object.assign(next, cleanEntity(d, id,
      Object.prototype.hasOwnProperty.call(b, 'entityType') ? b.entityType : next.entityType,
      Object.prototype.hasOwnProperty.call(b, 'entityId') ? b.entityId : next.entityId, true, user, firma));
  }
  Object.assign(next, cleanEntity(d, id, next.entityType, next.entityId, true, user, firma));
  const evidenceSupplied = Object.prototype.hasOwnProperty.call(b, 'resolutionEvidence')
    || Object.prototype.hasOwnProperty.call(b, 'resolution');
  const evidenceNote = String(Object.prototype.hasOwnProperty.call(b, 'resolutionEvidence')
    ? b.resolutionEvidence : (b.resolution || '')).trim();
  if (evidenceNote.length > RESOLUTION_MAX) fail(400, 'Dovada rezolvării este prea lungă.');
  const assignee = reqMember(d, firma, next.assignedTo);
  if (!canAccessEntity(assignee, firma, next.entityType)) fail(400, 'Responsabilul ales nu are acces la obiectul asociat.');
  const kind = memberKind(assignee, firma);
  if (next.status === 'asteapta_patronul' && kind !== 'patron') fail(400, 'Starea „așteaptă patronul” cere ca responsabilul să fie patronul.');
  if (next.status === 'asteapta_contabilul' && kind !== 'contabil') fail(400, 'Starea „așteaptă contabilul” cere ca responsabilul să fie contabilul.');
  if (next.status === 'rezolvata' && ((before.status !== 'rezolvata' && !evidenceSupplied)
      || (evidenceSupplied && evidenceNote.length < 3))) {
    fail(400, 'Pentru „rezolvată”, consemnează dovada rezolvării.');
  }
  const changed = before.status !== next.status || Number(before.assignedTo) !== Number(next.assignedTo)
    || before.due !== (next.due || null) || before.requestType !== (next.requestType || 'alta')
    || before.entityType !== (next.entityType || '') || before.entityId !== (next.entityId || '')
    || (evidenceSupplied && before.resolution !== evidenceNote);
  if (!changed) return { request: publicRequest(r, d, firma, user), idempotent: true };
  const now = new Date().toISOString();
  Object.assign(r, next);
  r.updatedAt = now;
  if (evidenceSupplied) r.resolution = evidenceNote;
  let assignment = null;
  if (Number(before.assignedTo) !== Number(r.assignedTo)) {
    r.assignedAt = now; r.assignedBy = user.id; r.assignedByName = userName(user);
    if (Number(r.assignedTo) !== Number(user.id)) assignment = {
      userId: r.assignedTo, firmaId: id, firma: firma.nume || '', title: r.title, due: r.due || null,
      source: 'request', assignedBy: userName(user),
    };
  }
  if (r.status === 'rezolvata') {
    if (before.status !== 'rezolvata') { r.resolvedAt = now; r.resolvedBy = user.id; }
    if (evidenceSupplied) r.resolutionEvidence = { note: evidenceNote, entityType: r.entityType, entityId: r.entityId,
      recordedBy: user.id, recordedByName: userName(user), recordedAt: now };
  } else { delete r.resolvedAt; delete r.resolvedBy; }
  r.history = Array.isArray(r.history) ? r.history : [];
  r.history.push({ status: r.status, assignedTo: r.assignedTo, due: r.due || null, by: user.id, at: now });
  const label = r.status === 'rezolvata' ? 'a rezolvat' : r.status === 'in_verificare' ? 'a trimis la verificare'
    : r.status === 'asteapta_patronul' ? 'a trimis către patron'
      : r.status === 'asteapta_contabilul' ? 'a trimis către contabil' : 'a redeschis';
  appendEvent(d, id, user, userName(user) + ' ' + label + ' solicitarea „' + r.title + '”' + (assignee ? ' · responsabil: ' + userName(assignee) : '') + '.', r.id);
  db.save();
  return { request: publicRequest(r, d, firma, user), idempotent: false, assignment };
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
      description: r.description || '', requestType: REQUEST_TYPES.has(r.requestType) ? r.requestType : 'alta',
      requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || REQUEST_TYPE_LABELS.alta,
      entity: entityDetails(d, Number(r.firmaId), r.entityType, r.entityId, user,
        (d.firme || []).find((f) => Number(f.id) === Number(r.firmaId))),
      due: r.due || null, status: r.status, assignedAt,
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
  STATUSES, REQUEST_TYPES, REQUEST_TYPE_LABELS, ENTITY_TYPES, ENTITY_TYPE_LABELS,
  MESSAGE_MAX, THREAD_MAX, REQUEST_MAX,
};
