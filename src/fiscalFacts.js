'use strict';

// Registru temporal, append-only, pentru faptele consumate de motorul fiscal. Un fapt nu este
// doar o valoare: identitatea subiectului, tipul, sursa, intervalul si nivelul de confirmare fac
// parte din dovada care ajunge in decizie.

const crypto = require('crypto');

const TYPES = new Set(['money', 'number', 'boolean', 'string', 'date']);
const CONFIDENCE = new Set(['confirmed', 'declared', 'derived', 'disputed']);

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function error(message, code) { const e = new Error(message); e.code = code; e.status = 400; throw e; }
function required(value, label, max) {
  const out = String(value == null ? '' : value).trim();
  if (!out) error(label + ' lipsește.', 'FISCAL_FACT_INVALID');
  if (out.length > max) error(label + ' depășește ' + max + ' caractere.', 'FISCAL_FACT_INVALID');
  return out;
}
function isoDate(value, label, nullable) {
  if (nullable && (value == null || value === '')) return null;
  const out = String(value || '');
  const parsed = new Date(out + 'T00:00:00.000Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out) || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== out) error(label + ' trebuie să fie o dată calendaristică YYYY-MM-DD.', 'FISCAL_FACT_INVALID');
  return out;
}
function isoInstant(value, label) {
  const out = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(out) || Number.isNaN(Date.parse(out))) {
    error(label + ' trebuie să fie un moment ISO valid.', 'FISCAL_FACT_INVALID');
  }
  return new Date(out).toISOString();
}
function typedValue(value, type) {
  if (value == null || value === '') error('Valoarea faptului lipsește.', 'FISCAL_FACT_VALUE_INVALID');
  if (type === 'money' || type === 'number') {
    const out = Number(value);
    if (!Number.isFinite(out)) error('Valoarea faptului nu este numerică.', 'FISCAL_FACT_VALUE_INVALID');
    return out;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') error('Valoarea faptului nu este booleană.', 'FISCAL_FACT_VALUE_INVALID');
    return value;
  }
  if (type === 'date') return isoDate(value, 'Valoarea faptului');
  return required(value, 'Valoarea faptului', 4000);
}

function normalize(raw, options) {
  const row = raw || {}; const opts = options || {};
  const type = String(row.type || '');
  if (!TYPES.has(type)) error('Tipul faptului fiscal este invalid.', 'FISCAL_FACT_TYPE_INVALID');
  const validFrom = isoDate(row.validFrom || row.validAt, 'validFrom');
  const validTo = isoDate(row.validTo, 'validTo', true);
  if (validTo && validTo < validFrom) error('validTo este anterior lui validFrom.', 'FISCAL_FACT_INTERVAL_INVALID');
  const confidence = String(row.confidence || '');
  if (!CONFIDENCE.has(confidence)) error('Nivelul de încredere al faptului este invalid.', 'FISCAL_FACT_CONFIDENCE_INVALID');
  const sourceHash = String(row.sourceHash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sourceHash)) error('Hash-ul SHA-256 al sursei lipsește.', 'FISCAL_FACT_SOURCE_HASH_REQUIRED');
  const source = row.source || {};
  const recordedAt = isoInstant(row.recordedAt || opts.now || new Date().toISOString(), 'recordedAt');
  const actor = row.recordedBy || {};
  if (actor.actorId == null && !String(actor.username || '').trim()) {
    error('Identitatea persoanei sau sistemului care a consemnat faptul lipsește.', 'FISCAL_FACT_ACTOR_REQUIRED');
  }
  const body = {
    schemaVersion: 1,
    id: required(row.id || (opts.nextId && opts.nextId('ff')), 'ID-ul faptului', 160),
    firmaId: row.firmaId,
    subject: required(row.subject || 'company', 'Subiectul faptului', 300),
    key: required(row.key || row.name, 'Cheia faptului', 120),
    type,
    value: typedValue(row.value, type),
    source: {
      kind: required(source.kind, 'Tipul sursei', 120),
      id: required(source.id, 'Identitatea sursei', 500),
      authority: source.authority ? String(source.authority).trim().slice(0, 300) : '',
    },
    sourceHash,
    validFrom,
    validTo,
    confidence,
    recordedAt,
    recordedBy: {
      actorId: actor.actorId == null ? null : actor.actorId,
      username: String(actor.username || '').trim().slice(0, 120),
      role: String(actor.role || '').trim().slice(0, 80),
    },
    supersedes: row.supersedes ? String(row.supersedes) : null,
    note: String(row.note || '').trim().slice(0, 1000),
  };
  if (body.firmaId == null || body.firmaId === '') error('Firma faptului fiscal lipsește.', 'FISCAL_FACT_FIRMA_REQUIRED');
  if (!/^[a-z][a-zA-Z0-9._-]*$/.test(body.key)) error('Cheia faptului fiscal este invalidă.', 'FISCAL_FACT_KEY_INVALID');
  return Object.freeze(Object.assign({}, body, { hash: hash(body) }));
}

function verify(record) {
  try {
    const rebuilt = normalize(record, { now: record && record.recordedAt });
    return { valid: rebuilt.hash === record.hash, record: rebuilt,
      issues: rebuilt.hash === record.hash ? [] : ['hash-ul înregistrării nu coincide'] };
  } catch (e) { return { valid: false, record: null, issues: [e.message] }; }
}

function append(db, raw, options) {
  const d = db || {}; d.fiscalFacts = Array.isArray(d.fiscalFacts) ? d.fiscalFacts : [];
  const rec = normalize(raw, options);
  if (d.fiscalFacts.some((row) => String(row.id) === rec.id)) error('ID-ul faptului există deja.', 'FISCAL_FACT_DUPLICATE_ID');
  if (rec.supersedes) {
    const previous = d.fiscalFacts.find((row) => String(row.id) === rec.supersedes);
    if (!previous || String(previous.firmaId) !== String(rec.firmaId)
        || previous.subject !== rec.subject || previous.key !== rec.key) {
      error('Înregistrarea înlocuită lipsește sau aparține altui fapt.', 'FISCAL_FACT_SUPERSEDES_INVALID');
    }
    if (d.fiscalFacts.some((row) => String(row.supersedes || '') === rec.supersedes)) {
      error('Înregistrarea a fost deja înlocuită; corecțiile trebuie să formeze un singur lanț.', 'FISCAL_FACT_SUPERSEDES_AMBIGUOUS');
    }
  }
  d.fiscalFacts.push(rec);
  return rec;
}

function activeRecords(records, query) {
  const q = query || {}; const asOf = isoDate(q.asOf, 'asOf');
  const all = (records || []).filter((row) => String(row.firmaId) === String(q.firmaId)
    && String(row.subject) === String(q.subject || 'company') && String(row.key) === String(q.key)
    && row.validFrom <= asOf && (!row.validTo || row.validTo >= asOf));
  const superseded = new Set(all.map((row) => String(row.supersedes || '')).filter(Boolean));
  return all.filter((row) => !superseded.has(String(row.id)));
}

function resolve(records, query) {
  const q = query || {}; const rows = activeRecords(records, q);
  const base = { key: String(q.key || ''), subject: String(q.subject || 'company'), asOf: String(q.asOf || ''),
    records: rows.map((row) => ({ id: row.id, hash: row.hash, type: row.type, value: row.value,
      confidence: row.confidence, validFrom: row.validFrom, validTo: row.validTo,
      source: row.source, sourceHash: row.sourceHash, recordedAt: row.recordedAt })) };
  if (!rows.length) return Object.assign(base, { status: 'missing', value: undefined,
    reason: 'Nu există un fapt valabil la data cerută.' });
  const types = new Set(rows.map((row) => row.type));
  const values = new Set(rows.map((row) => canonical(row.value)));
  if (types.size !== 1 || values.size !== 1 || rows.some((row) => row.confidence === 'disputed')) {
    return Object.assign(base, { status: 'conflict', value: undefined,
      reason: 'Sursele active se contrazic sau faptul este contestat.' });
  }
  const confirmed = rows.every((row) => row.confidence === 'confirmed');
  return Object.assign(base, { status: confirmed ? 'resolved' : 'unconfirmed', value: rows[0].value,
    type: rows[0].type, reason: confirmed ? '' : 'Faptul există, dar nu este confirmat pentru autonomie.',
    evidenceHash: hash(base.records) });
}

function snapshotForRule(records, rule, context) {
  const ctx = context || {}; const facts = {}; const factEvidence = {}; const resolutions = [];
  const missingFacts = []; const conflictingFacts = []; const unconfirmedFacts = [];
  for (const requiredFact of (rule && rule.requiredFacts) || []) {
    const resolution = resolve(records, { firmaId: ctx.firmaId, subject: ctx.subject || 'company',
      key: requiredFact.name, asOf: ctx.asOf });
    resolutions.push(resolution);
    if (resolution.status === 'missing') missingFacts.push(requiredFact.name);
    else if (resolution.status === 'conflict') conflictingFacts.push(requiredFact.name);
    else {
      facts[requiredFact.name] = resolution.value;
      if (resolution.status === 'unconfirmed') unconfirmedFacts.push(requiredFact.name);
      factEvidence[requiredFact.name] = resolution.records.map((row) => ({
        sourceId: row.source.kind + ':' + row.source.id, sourceHash: row.sourceHash,
        capturedAt: row.recordedAt, value: row.value, factRecordId: row.id, factRecordHash: row.hash,
        confidence: row.confidence, validFrom: row.validFrom, validTo: row.validTo,
      }));
    }
  }
  const body = { schemaVersion: 1, firmaId: ctx.firmaId, subject: ctx.subject || 'company',
    asOf: isoDate(ctx.asOf, 'asOf'), ruleId: rule && rule.id, ruleHash: rule && rule.hash,
    facts, factEvidence, resolutions, missingFacts, conflictingFacts, unconfirmedFacts };
  return Object.freeze(Object.assign({}, body, { status: missingFacts.length || conflictingFacts.length
    ? 'NEDETERMINABIL' : 'DETERMINABIL', hash: hash(body) }));
}

module.exports = { TYPES, CONFIDENCE, canonical, hash, normalize, verify, append, activeRecords,
  resolve, snapshotForRule };
