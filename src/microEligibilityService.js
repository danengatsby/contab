'use strict';

// Scrierea registrului de eligibilitate micro este versionata, nu un Object.assign pe firma.
// Fiecare revizie pastreaza fotografia completa, actorul, motivul si SHA-256; corectarea datelor
// nu sterge ce a stat la baza unei generari/decizii anterioare.

const crypto = require('crypto');
const db = require('./db');
const permissions = require('./permissions');
const eligibility = require('./microEligibility');
const { capList } = require('./paginate');
const { reqFirma } = require('./stocksService');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

function history(fid) {
  const rows = (db.get().micro_eligibility_history || []).filter((x) => Number(x.firmaId) === Number(fid))
    .slice().sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || ''))
      || String(b.id || '').localeCompare(String(a.id || '')));
  return capList(rows, 0, 'micro-eligibility-history', { pastreaza: 'cap' }).items;
}

function get(fid, when) {
  fid = reqFirma(fid);
  const rows = history(fid); const registry = rows[0] && rows[0].registry || null;
  const view = Object.assign({}, db.scoped(fid), { microEligibilityRegistry: registry,
    microEligibilityHistory: rows });
  return { registry, assessment: eligibility.analyze(view, when || new Date().toISOString().slice(0, 7)),
    history: rows.map((x) => ({ id: x.id, recordedAt: x.recordedAt, recordedBy: x.recordedBy,
      recordedByName: x.recordedByName, reason: x.reason, hash: x.hash, supersedes: x.supersedes || null })) };
}

function save(fid, body, actor) {
  fid = reqFirma(fid); body = body || {};
  if (actor) permissions.assert(actor, fid, 'fiscal.manage', db.getFirma(fid));
  const reason = String(body.reason || '').trim();
  if (reason.length < 5) fail(400, 'Revizia registrului micro cere un motiv/document de minimum 5 caractere.');
  const registry = eligibility.normalizeRegistry(body.registry);
  const rows = history(fid); const current = rows[0] || null;
  const registryHash = hash(registry);
  if (current && current.hash === registryHash) fail(409, 'Registrul este identic cu revizia curenta; nu se creeaza o copie fara modificari.');
  const recordedAt = new Date().toISOString();
  const revision = {
    id: db.nextId('mer'), firmaId: Number(fid), recordedAt,
    recordedBy: actor && actor.id != null ? actor.id : null,
    recordedByName: String(actor && actor.username || ''), reason: reason.slice(0, 500),
    supersedes: current && current.id || null, registry, hash: registryHash,
  };
  db.get().micro_eligibility_history.push(revision);
  db.save();
  return { revision, registry, assessment: get(fid, body.when).assessment };
}

module.exports = { get, save, history, hash };
