'use strict';

// Contractul de acoperire este separat de snapshot-ul executabil al tratamentului. Legarea se face
// prin `ruleHash`, inclus în hash-ul registrului și al corpusului de autonomie. Separarea păstrează
// verificabile hash-urile FiscalRuleSet deja folosite în articole istorice.

const crypto = require('crypto');

const PERCENT_RULE_IDS = [
  'ro.payroll.cas', 'ro.payroll.cass', 'ro.payroll.income_tax', 'ro.payroll.cam',
  'ro.withholding.dividends', 'ro.pfa.cas', 'ro.pfa.cass', 'ro.pfa.income_tax',
  'ro.tax.micro', 'ro.tax.profit', 'ro.vat.standard', 'ro.vat.reduced',
];

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sha(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value); Object.keys(value).forEach((key) => freeze(value[key])); return value;
}
function pct(ruleId) {
  return {
    ruleId,
    branches: ['computed-nonnegative-base', 'negative-base-review'],
    thresholds: ['base-zero'],
    temporalTransitions: ['rule-validity-start', 'fiscal-year-boundary', 'legal-regime-transition'],
    exceptionCombinations: ['negative-base-regularization'],
    rectifications: ['initial-to-correction', 'correction-of-correction'],
    incompleteData: ['missing-base', 'invalid-base'],
    contradictoryData: ['base-source-conflict'],
    mandatoryRefusals: ['missing-base', 'unlinked-negative-correction'],
    minimumUniqueCases: 32,
  };
}

const RAW = PERCENT_RULE_IDS.map(pct).concat([
  {
    ruleId: 'ro.profit.vehicle_limited_deduction',
    branches: ['limited-use', 'exclusive-business-use', 'negative-expense-review'],
    thresholds: ['expense-zero'],
    temporalTransitions: ['rule-validity-start', 'fiscal-year-boundary', 'legal-regime-transition'],
    exceptionCombinations: ['negative-nonexclusive', 'negative-exclusive'],
    rectifications: ['linked-expense-correction', 'correction-of-correction'],
    incompleteData: ['missing-expense', 'missing-use-classification'],
    contradictoryData: ['use-evidence-conflict'],
    mandatoryRefusals: ['unlinked-negative-expense', 'missing-use-evidence'],
    minimumUniqueCases: 36,
  },
  {
    ruleId: 'ro.vat.vehicle_limited_deduction',
    branches: ['limited-use', 'exclusive-business-use', 'negative-vat-review'],
    thresholds: ['input-vat-zero'],
    temporalTransitions: ['rule-validity-start', 'fiscal-year-boundary', 'legal-regime-transition'],
    exceptionCombinations: ['negative-nonexclusive', 'negative-exclusive'],
    rectifications: ['linked-vat-correction', 'correction-of-correction'],
    incompleteData: ['missing-input-vat', 'missing-use-classification'],
    contradictoryData: ['use-evidence-conflict'],
    mandatoryRefusals: ['unlinked-negative-vat', 'missing-use-evidence'],
    minimumUniqueCases: 36,
  },
]);

const REQUIRED_FIELDS = [
  'branches', 'thresholds', 'temporalTransitions', 'exceptionCombinations', 'rectifications',
  'incompleteData', 'contradictoryData', 'mandatoryRefusals',
];
const BY_ID = new Map();
for (const raw of RAW) {
  if (BY_ID.has(raw.ruleId)) throw new Error('Contract de autonomie duplicat: ' + raw.ruleId + '.');
  for (const field of REQUIRED_FIELDS) {
    if (!Array.isArray(raw[field]) || !raw[field].length || new Set(raw[field]).size !== raw[field].length) {
      throw new Error(raw.ruleId + ': acoperirea „' + field + '” lipsește sau conține duplicate.');
    }
  }
  if (!Number.isInteger(raw.minimumUniqueCases) || raw.minimumUniqueCases < 30) {
    throw new Error(raw.ruleId + ': minimumUniqueCases trebuie să fie cel puțin 30.');
  }
  BY_ID.set(raw.ruleId, freeze(Object.assign({}, raw)));
}

function forRule(rule) {
  const base = BY_ID.get(String(rule && rule.id || ''));
  if (!base || !rule || !/^[0-9a-f]{64}$/.test(String(rule.hash || ''))) return null;
  const linked = Object.assign({ schemaVersion: 1, ruleHash: rule.hash }, base);
  return freeze(Object.assign({}, linked, { hash: sha(linked) }));
}

function all(rules) {
  const rows = (rules || []).map(forRule);
  if (rows.some((row) => !row)) {
    const missing = (rules || []).filter((rule) => !BY_ID.has(rule.id)).map((rule) => rule.id);
    throw new Error('Tratamente fără contract de acoperire autonomă: ' + missing.join(', ') + '.');
  }
  const known = new Set((rules || []).map((rule) => rule.id));
  const orphan = [...BY_ID.keys()].filter((id) => !known.has(id));
  if (orphan.length) throw new Error('Contracte de autonomie fără tratament: ' + orphan.join(', ') + '.');
  return rows;
}
function registryHash(rules) { return sha(all(rules).map((row) => ({ ruleId: row.ruleId, ruleHash: row.ruleHash, hash: row.hash }))); }

module.exports = { PERCENT_RULE_IDS, REQUIRED_FIELDS, forRule, all, registryHash };
