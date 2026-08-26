'use strict';

// Transactional outbox pentru mutatiile jurnalului contabil.
// `enqueue` muta acelasi graf pe care db.save() il fotografiaza: pe PostgreSQL, randul outbox si
// articolul/mutatia intra in ACELASI COMMIT. `drain` ruleaza numai dupa flushStore(), replica in
// jurnalul WORM/NDJSON si marcheaza livrarea idempotent.

const crypto = require('crypto');
const auditLog = require('./auditLog');
const chain = require('./globalChain');

const KEEP_DELIVERED = Math.max(100, Number(process.env.CONTAB_AUDIT_OUTBOX_KEEP || 2000));
let inFlight = null;

function actorFields(actor) {
  return {
    userId: actor && actor.id != null ? actor.id : null,
    username: String(actor && actor.username || 'sistem').slice(0, 80),
  };
}

function enqueue(graph, action, entry, actor, detail) {
  graph.auditOutbox = Array.isArray(graph.auditOutbox) ? graph.auditOutbox : [];
  const outboxId = crypto.randomUUID(); const at = new Date().toISOString();
  const snapshot = entry && typeof entry === 'object' ? entry : null;
  const af = actorFields(actor);
  const record = {
    id: 'audit-outbox-' + outboxId,
    outboxId,
    ts: at,
    userId: af.userId,
    username: af.username,
    firmaId: snapshot && snapshot.firmaId != null ? snapshot.firmaId : null,
    action: String(action || 'accounting.mutation'),
    detail: String(detail || ''),
    entityId: snapshot && snapshot.id != null ? String(snapshot.id) : null,
    entitySha256: snapshot ? chain.sha256(Buffer.from(chain.canonicalJson(snapshot), 'utf8')) : null,
  };
  const row = { id: outboxId, firmaId: record.firmaId, createdAt: at, record };
  graph.auditOutbox.push(row);
  return row;
}

function trimDelivered(rows) {
  const pending = rows.filter((r) => !r.deliveredAt);
  const delivered = rows.filter((r) => r.deliveredAt)
    .sort((a, b) => String(b.deliveredAt).localeCompare(String(a.deliveredAt))).slice(0, KEEP_DELIVERED);
  return pending.concat(delivered);
}

async function runDrain() {
  // Cerinta de baza: nu exportam un eveniment care traieste inca numai in RAM.
  const db = require('./db');
  await db.flushStore();
  const d = db.get(); d.auditOutbox = Array.isArray(d.auditOutbox) ? d.auditOutbox : [];
  const pending = d.auditOutbox.filter((row) => row && !row.deliveredAt && row.record)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!pending.length) return { delivered: 0, pending: 0 };
  let delivered = 0;
  for (const row of pending) {
    const rec = row.record;
    if (!auditLog.containsOutboxId(row.id)) auditLog.append(rec);
    d.audit = Array.isArray(d.audit) ? d.audit : [];
    if (!d.audit.some((a) => String(a.id) === String(rec.id))) d.audit.push(rec);
    row.deliveredAt = new Date().toISOString(); row.auditHash = rec.entitySha256 || null;
    delivered += 1;
  }
  const max = Number(process.env.CONTAB_AUDIT_MAX) || 20000;
  if (d.audit.length > max) d.audit = d.audit.slice(-max);
  d.auditOutbox = trimDelivered(d.auditOutbox);
  db.save(['audit', 'auditOutbox']);
  return { delivered, pending: d.auditOutbox.filter((r) => !r.deliveredAt).length };
}

function drain() {
  if (inFlight) return inFlight;
  inFlight = runDrain().finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { KEEP_DELIVERED, enqueue, drain, trimDelivered };
