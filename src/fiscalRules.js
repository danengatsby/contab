'use strict';

const crypto = require('crypto');
const cfg = require('./fiscalConfig');
const treatmentRegistry = require('./fiscalTreatments');

function fail(message, status) { const e = new Error(message); e.status = status || 400; throw e; }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value); Object.keys(value).forEach((k) => deepFreeze(value[k])); return value;
}
function dateKey(value, label) {
  const raw = String(value == null || value === '' ? new Date().toISOString().slice(0, 10) : value);
  const s = /^\d{4}$/.test(raw) ? raw + '-01-01' : /^\d{4}-\d{2}$/.test(raw) ? raw + '-01' : raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail((label || 'Data') + ' trebuie sa fie YYYY-MM-DD.');
  const d = new Date(s + 'T00:00:00.000Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail((label || 'Data') + ' nu este calendaristica.');
  return s;
}
function isoInstant(value, label) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) fail((label || 'Momentul publicarii') + ' nu este valid.');
  return d.toISOString();
}
function legalSources(value) {
  if (!Array.isArray(value) || !value.length) fail('FiscalRuleSet necesita cel putin o sursa legala oficiala.');
  return value.map((x) => {
    const title = String((x || {}).title || '').trim(); const url = String((x || {}).url || '').trim();
    if (!title || !/^https:\/\//.test(url)) fail('Fiecare sursa legala necesita titlu si URL HTTPS.');
    return { title, url };
  });
}
function normalizeRates(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {}; const out = {};
  for (const key of Object.keys(cfg.RATES)) {
    if (!Object.prototype.hasOwnProperty.call(src, key) || !Number.isFinite(Number(src[key]))) {
      fail('FiscalRuleSet nu contine parametrul numeric obligatoriu: ' + key + '.');
    }
    out[key] = Number(src[key]);
  }
  const unknown = Object.keys(src).filter((k) => !Object.prototype.hasOwnProperty.call(cfg.RATES, k));
  if (unknown.length) fail('Parametri fiscali necunoscuti: ' + unknown.join(', ') + '.');
  return out;
}
function normalize(row, opts) {
  const o = opts || {}; const validFrom = dateKey(row.validFrom, 'validFrom');
  const validTo = row.validTo == null || row.validTo === '' ? null : dateKey(row.validTo, 'validTo');
  if (validTo && validTo < validFrom) fail('validTo nu poate fi anterior lui validFrom.');
  const approvalId = row.approvalId == null ? null : String(row.approvalId).trim();
  if (!o.builtin && !approvalId) fail('Publicarea necesita approvalId-ul reviziei fiscale.');
  const legacy = { validFrom, validTo, publishedAt: isoInstant(row.publishedAt, 'publishedAt'),
    legalSources: legalSources(row.legalSources), rates: normalizeRates(row.rates), approvalId };
  // Schema 1 sigila numai cotele. Pastram hash-ul ei ca alias verificabil pentru articolele deja
  // postate, dar toate calculele noi primesc schema 2: RuleSet-ul include tratamentele executabile.
  const legacyHash = sha256(legacy);
  const hasTreatmentSnapshot = Object.prototype.hasOwnProperty.call(row, 'treatments');
  const treatments = hasTreatmentSnapshot
    ? treatmentRegistry.normalizeSnapshots(row.treatments)
    : treatmentRegistry.activeForInterval(validFrom, validTo);
  if (!treatments.length) fail('FiscalRuleSet nu are niciun tratament fiscal publicat pentru intervalul cerut.');
  const expectedTreatmentIds = treatmentRegistry.activeForInterval(validFrom, validTo).map((rule) => rule.id);
  const presentTreatmentIds = new Set(treatments.map((rule) => rule.id));
  const missingTreatments = expectedTreatmentIds.filter((id) => !presentTreatmentIds.has(id));
  if (missingTreatments.length) fail('FiscalRuleSet nu contine tratamentele obligatorii: '
    + missingTreatments.join(', ') + '.');
  const uncovered = treatments.filter((rule) => rule.validFrom > validFrom
    || (validTo ? (rule.validTo && rule.validTo < validTo) : !!rule.validTo));
  if (uncovered.length) fail('Tratamentele nu acopera integral intervalul FiscalRuleSet: '
    + uncovered.map((rule) => rule.id).join(', ') + '.');
  const normalized = Object.assign({ schemaVersion: 2 }, legacy, { treatments,
    treatmentsHash: treatmentRegistry.registryHash(treatments) });
  const hash = sha256(normalized);
  // Un hash schema 1 poate fi migrat numai daca randul chiar nu continea tratamente. Altfel un
  // snapshot arbitrar s-ar putea ascunde sub o semnatura veche care acoperea exclusiv cotele.
  if (row.hash && row.hash !== hash && !(row.hash === legacyHash && !hasTreatmentSnapshot)) {
    fail('Hash FiscalRuleSet invalid pentru ' + (row.id || validFrom) + '.');
  }
  const id = String(row.id || ('frs-' + validFrom + '-' + hash.slice(0, 12))).trim();
  if (!/^[a-zA-Z0-9._:-]{3,100}$/.test(id)) fail('Identificator FiscalRuleSet invalid.');
  return deepFreeze(Object.assign({ id }, normalized, { hash, legacyHashes: [legacyHash] }));
}

const builtins = (cfg.RULE_SET_DEFINITIONS || []).map((x) => normalize(x, { builtin: true }));
let published = [];
function all() { return builtins.concat(published).slice().sort((a, b) => a.validFrom.localeCompare(b.validFrom)
  || a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id)); }
function byId(id) { return all().find((x) => x.id === id) || null; }
function at(value) {
  const date = dateKey(value, 'Data operatiunii');
  const candidates = all().filter((x) => x.validFrom <= date && (!x.validTo || x.validTo >= date));
  candidates.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.validFrom.localeCompare(a.validFrom));
  if (!candidates.length) {
    const e = new Error('Nu exista FiscalRuleSet publicat pentru data ' + date
      + '. Calculul fiscal a fost oprit pentru a nu aplica o fotografie din alt an.');
    e.code = 'FISCAL_RULES_NOT_FOUND'; e.status = 422; throw e;
  }
  return candidates[0];
}
function ref(value, opts) {
  try { const r = at(value); return { ruleSetId: r.id, fiscalRulesHash: r.hash,
    fiscalTreatmentsHash: r.treatmentsHash }; }
  catch (e) {
    if (!(opts || {}).allowUncovered || e.code !== 'FISCAL_RULES_NOT_FOUND') throw e;
    const date = dateKey(value); return { ruleSetId: 'uncovered:' + date.slice(0, 4),
      fiscalRulesHash: sha256({ uncovered: date.slice(0, 4) }), fiscalRulesCovered: false };
  }
}
function configure(rows) {
  const seen = new Set(builtins.map((x) => x.id));
  published = (Array.isArray(rows) ? rows : []).map((x) => normalize(x)).map((x) => {
    if (seen.has(x.id)) fail('FiscalRuleSet duplicat: ' + x.id + '.'); seen.add(x.id); return x;
  });
  return all();
}
function create(input, meta) {
  const src = input && typeof input === 'object' ? input : {};
  const base = src.baseRuleSetId ? byId(String(src.baseRuleSetId)) : null;
  if (src.baseRuleSetId && !base) fail('FiscalRuleSet de baza inexistent: ' + src.baseRuleSetId + '.', 404);
  const partial = src.rates && typeof src.rates === 'object' && !Array.isArray(src.rates) ? src.rates : {};
  const unknown = Object.keys(partial).filter((k) => !Object.prototype.hasOwnProperty.call(cfg.RATES, k));
  if (unknown.length) fail('Parametri fiscali necunoscuti: ' + unknown.join(', ') + '.');
  const merged = Object.assign({}, base ? base.rates : {}, partial);
  const inheritedTreatments = Object.prototype.hasOwnProperty.call(src, 'treatments')
    ? src.treatments : base ? base.treatments : undefined;
  const row = normalize({ validFrom: src.validFrom, validTo: src.validTo,
    publishedAt: (meta && meta.publishedAt) || new Date().toISOString(),
    legalSources: src.legalSources, approvalId: src.approvalId, rates: merged,
    ...(inheritedTreatments ? { treatments: inheritedTreatments } : {}) });
  if (byId(row.id)) fail('FiscalRuleSet deja publicat: ' + row.id + '.', 409);
  return row;
}
function append(row) {
  const normalized = normalize(row);
  if (byId(normalized.id)) fail('FiscalRuleSet deja publicat: ' + normalized.id + '.', 409);
  published = published.concat(normalized); return normalized;
}
function snapshot() { return all().map((r) => ({ id: r.id, validFrom: r.validFrom, validTo: r.validTo,
  publishedAt: r.publishedAt, hash: r.hash, approvalId: r.approvalId,
  treatmentsHash: r.treatmentsHash, treatments: r.treatments.length })); }
function registryHash() { return sha256(snapshot()); }
function verifyReference(ruleSetId, hash) {
  const r = byId(ruleSetId);
  return !!r && (r.hash === hash || (r.legacyHashes || []).includes(hash));
}
function treatmentAt(value, id) {
  const ruleSet = value && value.rates && value.treatments ? value : at(value);
  return ruleSet.treatments.find((rule) => rule.id === String(id)) || null;
}
function evaluateTreatment(value, id, facts, options) {
  const ruleSet = value && value.rates && value.treatments ? value : at(value);
  const treatment = treatmentAt(ruleSet, id);
  if (!treatment) {
    const e = new Error('Tratamentul fiscal „' + id + '” nu este publicat in FiscalRuleSet ' + ruleSet.id + '.');
    e.code = 'FISCAL_TREATMENT_NOT_FOUND'; e.status = 422; throw e;
  }
  return treatmentRegistry.evaluate(treatment, ruleSet, facts, options);
}
function evaluateTreatmentForAutonomy(value, id, facts, options) {
  const supplied = value && value.rates && value.treatments ? value : null;
  const ruleSet = supplied ? byId(supplied.id) : at(value);
  if (!ruleSet || (supplied && supplied.hash !== ruleSet.hash)) {
    const e = new Error('Autonomia cere un FiscalRuleSet publicat si identic cu fotografia registrului.');
    e.code = 'FISCAL_RULES_UNVERIFIED'; e.status = 409; throw e;
  }
  const treatment = treatmentAt(ruleSet, id);
  if (!treatment) {
    const e = new Error('Tratamentul fiscal „' + id + '” nu este publicat in FiscalRuleSet ' + ruleSet.id + '.');
    e.code = 'FISCAL_TREATMENT_NOT_FOUND'; e.status = 422; throw e;
  }
  return treatmentRegistry.evaluateForAutonomy(treatment, ruleSet, facts, options);
}
function counterfactualTreatment(value, id, facts, change, options) {
  const ruleSet = value && value.rates && value.treatments ? value : at(value);
  const treatment = treatmentAt(ruleSet, id);
  if (!treatment) {
    const e = new Error('Tratamentul fiscal „' + id + '” nu este publicat in FiscalRuleSet ' + ruleSet.id + '.');
    e.code = 'FISCAL_TREATMENT_NOT_FOUND'; e.status = 422; throw e;
  }
  return treatmentRegistry.counterfactual(treatment, ruleSet, facts, change, options);
}

module.exports = { all, at, ref, byId, configure, create, append, snapshot, registryHash,
  verifyReference, treatmentAt, evaluateTreatment, evaluateTreatmentForAutonomy,
  counterfactualTreatment,
  canonical, sha256, dateKey };
