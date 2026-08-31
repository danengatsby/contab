'use strict';

// Politica de autonomie este deliberat separata de reguli. Regula raspunde „care este tratamentul
// fiscal?”, politica firmei raspunde „poate fi executat fara om in acest context exact?”.

const crypto = require('crypto');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function fail(message, code) { const e = new Error(message); e.code = code; e.status = 400; throw e; }
function list(value, label, allowEmpty) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) fail(label + ' trebuie să fie o listă' + (allowEmpty ? '.' : ' nevidă.'), 'AUTONOMY_POLICY_INVALID');
  return [...new Set(value.map((x) => String(x || '').trim()).filter(Boolean))].sort();
}
function instant(value, label) {
  const out = String(value || ''); if (Number.isNaN(Date.parse(out))) fail(label + ' este invalid.', 'AUTONOMY_POLICY_INVALID');
  return new Date(out).toISOString();
}

function normalize(raw, options) {
  const row = raw || {}; const opts = options || {};
  const authorizedBy = row.authorizedBy || {};
  if (authorizedBy.actorId == null && !String(authorizedBy.username || '').trim()) {
    fail('Politica nu are un autorizator identificabil.', 'AUTONOMY_POLICY_AUTHORIZATION_REQUIRED');
  }
  const limits = {};
  for (const [operation, value] of Object.entries(row.valueLimits || {})) {
    const amount = Number(value);
    if (!operation.trim() || !Number.isFinite(amount) || amount < 0) fail('Limita valorică este invalidă.', 'AUTONOMY_POLICY_INVALID');
    limits[operation.trim()] = amount;
  }
  const authorizedAt = instant(row.authorizedAt || opts.now || new Date().toISOString(), 'authorizedAt');
  const expiresAt = instant(row.expiresAt, 'expiresAt');
  if (expiresAt <= authorizedAt) fail('Politica expiră înainte de autorizare.', 'AUTONOMY_POLICY_INVALID');
  const invalidation = row.invalidation || {};
  const body = {
    schemaVersion: 1,
    id: String(row.id || (opts.nextId && opts.nextId('fap')) || '').trim(),
    firmaId: row.firmaId,
    version: Number(row.version) || 1,
    status: String(row.status || 'active'),
    operations: list(row.operations, 'Operațiunile permise'),
    valueLimits: Object.fromEntries(Object.entries(limits).sort(([a], [b]) => a.localeCompare(b))),
    allowedPartners: list(row.allowedPartners, 'Partenerii permiși'),
    allowedDocumentTypes: list(row.allowedDocumentTypes, 'Tipurile de document permise'),
    requiredDocuments: list(row.requiredDocuments, 'Documentele obligatorii', true),
    authorizedBy: { actorId: authorizedBy.actorId == null ? null : authorizedBy.actorId,
      username: String(authorizedBy.username || '').trim().slice(0, 120), role: String(authorizedBy.role || '').trim().slice(0, 80) },
    authorizedAt,
    expiresAt,
    invalidation: {
      fiscalRulesHash: String(invalidation.fiscalRulesHash || ''),
      treatmentRegistryHash: String(invalidation.treatmentRegistryHash || ''),
      fiscalProfileHash: String(invalidation.fiscalProfileHash || ''),
      factRegistryHash: String(invalidation.factRegistryHash || ''),
    },
    supersedes: row.supersedes ? String(row.supersedes) : null,
    note: String(row.note || '').trim().slice(0, 1000),
  };
  if (!body.id || body.firmaId == null) fail('Identitatea politicii sau firma lipsește.', 'AUTONOMY_POLICY_INVALID');
  if (!Number.isInteger(body.version) || body.version < 1 || !['active', 'revoked'].includes(body.status)) {
    fail('Versiunea sau starea politicii este invalidă.', 'AUTONOMY_POLICY_INVALID');
  }
  for (const [key, value] of Object.entries(body.invalidation)) {
    if (value && !/^[0-9a-f]{64}$/.test(value)) fail('Reperul de invalidare ' + key + ' nu este SHA-256.', 'AUTONOMY_POLICY_INVALID');
  }
  return Object.freeze(Object.assign({}, body, { hash: hash(body) }));
}

function append(db, raw, options) {
  const d = db || {}; d.fiscalAutonomyPolicies = Array.isArray(d.fiscalAutonomyPolicies) ? d.fiscalAutonomyPolicies : [];
  const policy = normalize(raw, options);
  if (d.fiscalAutonomyPolicies.some((row) => String(row.id) === policy.id)) fail('ID-ul politicii există deja.', 'AUTONOMY_POLICY_DUPLICATE');
  if (policy.supersedes) {
    const previous = d.fiscalAutonomyPolicies.find((row) => String(row.id) === policy.supersedes);
    if (!previous || String(previous.firmaId) !== String(policy.firmaId) || Number(policy.version) !== Number(previous.version) + 1) {
      fail('Politica înlocuită lipsește sau versiunea nu este consecutivă.', 'AUTONOMY_POLICY_SUPERSEDES_INVALID');
    }
  }
  d.fiscalAutonomyPolicies.push(policy); return policy;
}

function activeFor(db, firmaId, at) {
  const rows = ((db && db.fiscalAutonomyPolicies) || []).filter((row) => String(row.firmaId) === String(firmaId));
  const superseded = new Set(rows.map((row) => String(row.supersedes || '')).filter(Boolean));
  return rows.filter((row) => !superseded.has(String(row.id)) && row.status === 'active'
    && row.authorizedAt <= at && row.expiresAt >= at).sort((a, b) => Number(b.version) - Number(a.version))[0] || null;
}

function decide(policy, context) {
  const p = policy || {}; const ctx = context || {}; const reasons = [];
  const now = instant(ctx.at || new Date().toISOString(), 'Momentul evaluării');
  if (!p.hash || hash(Object.assign({}, p, { hash: undefined })) !== p.hash) reasons.push('POLICY_HASH_INVALID');
  if (String(p.firmaId) !== String(ctx.firmaId)) reasons.push('FIRMA_NOT_AUTHORIZED');
  if (p.status !== 'active') reasons.push('POLICY_INACTIVE');
  if (now < p.authorizedAt || now > p.expiresAt) reasons.push('POLICY_EXPIRED');
  const operation = String(ctx.operation || '');
  if (!(p.operations || []).includes(operation)) reasons.push('OPERATION_NOT_AUTHORIZED');
  const amount = Number(ctx.amount);
  if (!Number.isFinite(amount) || amount < 0) reasons.push('AMOUNT_UNDETERMINED');
  else if (!Object.prototype.hasOwnProperty.call(p.valueLimits || {}, operation)
      || amount > Number(p.valueLimits[operation])) reasons.push('VALUE_LIMIT_EXCEEDED');
  const partner = String(ctx.partnerId || '');
  if (!(p.allowedPartners || []).includes('*') && !(p.allowedPartners || []).includes(partner)) reasons.push('PARTNER_NOT_AUTHORIZED');
  const documentType = String(ctx.documentType || '');
  if (!(p.allowedDocumentTypes || []).includes('*') && !(p.allowedDocumentTypes || []).includes(documentType)) reasons.push('DOCUMENT_TYPE_NOT_AUTHORIZED');
  const documents = Array.isArray(ctx.documents) ? ctx.documents : [];
  for (const kind of p.requiredDocuments || []) {
    if (!documents.some((doc) => doc && doc.kind === kind && /^[0-9a-f]{64}$/.test(String(doc.hash || '')))) {
      reasons.push('REQUIRED_DOCUMENT_MISSING:' + kind);
    }
  }
  for (const [key, expected] of Object.entries(p.invalidation || {})) {
    if (expected && String((ctx.dependencies || {})[key] || '') !== expected) reasons.push('DEPENDENCY_CHANGED:' + key);
  }
  const body = { policyId: String(p.id || ''), policyHash: String(p.hash || ''), firmaId: ctx.firmaId,
    evaluatedAt: now, operation, amount: Number.isFinite(amount) ? amount : null, partnerId: partner,
    documentType, dependencies: ctx.dependencies || {}, reasons };
  return Object.freeze(Object.assign({}, body, { decision: reasons.length ? 'abstain' : 'allow', hash: hash(body) }));
}

module.exports = { canonical, hash, normalize, append, activeFor, decide };
