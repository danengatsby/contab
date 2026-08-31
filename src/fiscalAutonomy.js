'use strict';

// Poarta DISTINCTA pentru autonomie fiscala. Cele 25 de cazuri din fiscalReview sunt o poarta
// de lansare/depunere; acest modul cere un corpus mult mai mare, acoperire structurala pe fiecare
// tratament, executia tuturor cazurilor, doi revizori independenti si zero incertitudini materiale
// deschise pe regula care ar urma sa ruleze fara om.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fiscalReview = require('./fiscalReview');
const treatments = require('./fiscalTreatments');
const coverageRegistry = require('./fiscalAutonomyCoverage');
const { validIsoDate } = require('./util');

const CORPUS_SCHEMA = 2;
const APPROVAL_SCHEMA = 1;
const MINIMUM_CASES = 500;
const MINIMUM_REVIEWERS = 2;
const SIGNATURE_DOMAIN = 'CONTABO-FISCAL-AUTONOMY-V1';
const DEFAULT_CORPUS = path.join(__dirname, 'fiscalAutonomyCorpus.json');
const DEFAULT_APPROVALS = path.join(__dirname, 'fiscalAutonomyApprovals.json');
const KINDS = new Set([
  'branch', 'threshold_boundary', 'temporal_transition', 'exception_combination',
  'rectification', 'incomplete_data', 'contradictory_data', 'mandatory_refusal',
]);
const POSITIONS = Object.freeze({
  threshold_boundary: new Set(['below', 'at', 'above']),
  temporal_transition: new Set(['before', 'at', 'after']),
});
const DECISION_STATUSES = new Set([
  'computed', 'not_applicable', 'review_required', 'undetermined', 'ruleset_unavailable',
]);
const REQUIRED_APPROVAL = [
  'reviewer', 'credential', 'reviewedAt', 'legalBasis', 'evidenceDocumentSha256',
  'keyId', 'corpusHash', 'signature',
];
// Probleme cunoscute care nu pot dispărea prin ștergerea unui rând din JSON. Închiderea lor cere
// `status: resolved` plus dovadă profesională hash-uită; orice lipsă face configurația invalidă.
const REQUIRED_UNCERTAINTIES = new Map([
  ['RO-CF-ART40-2-FORMULA', ['ro.tax.profit']],
  ['RO-CF-ART40-2-BAZA-SI-FX', ['ro.tax.profit']],
  ['RO-CF-ART25-PROTOCOL-BASE', ['ro.tax.profit']],
  ['RO-CF-ART25-SPONSORSHIP-CARRY', ['ro.tax.profit']],
  ['RO-CF-ART25-SOCIAL-PAYROLL-BASE', ['ro.tax.profit']],
]);

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function isoDate(value) {
  const raw = String(value || '');
  if (!validIsoDate(raw)) return false;
  const parsed = new Date(raw + 'T00:00:00.000Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}
function readJson(file, fallback, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return Object.assign({}, fallback, { _error: label + ' nu poate fi citit: ' + error.message }); }
}

function readCorpus(explicit) {
  const file = process.env.CONTAB_FISCAL_AUTONOMY_CORPUS_FILE
    ? path.resolve(process.env.CONTAB_FISCAL_AUTONOMY_CORPUS_FILE) : DEFAULT_CORPUS;
  const parsed = explicit && typeof explicit === 'object' ? explicit
    : readJson(file, { schemaVersion: CORPUS_SCHEMA, cases: [], materialUncertainties: [] }, 'Corpul de autonomie');
  if (!parsed || parsed.schemaVersion !== CORPUS_SCHEMA || !Array.isArray(parsed.cases)
      || !Array.isArray(parsed.materialUncertainties)) {
    return { schemaVersion: CORPUS_SCHEMA, cases: [], materialUncertainties: [],
      _error: 'Corpul de autonomie trebuie să folosească schemaVersion ' + CORPUS_SCHEMA
        + ' și listele cases/materialUncertainties.' };
  }
  return parsed;
}

function readApprovals(explicit) {
  const file = process.env.CONTAB_FISCAL_AUTONOMY_APPROVALS_FILE
    ? path.resolve(process.env.CONTAB_FISCAL_AUTONOMY_APPROVALS_FILE) : DEFAULT_APPROVALS;
  const parsed = explicit && typeof explicit === 'object' ? explicit
    : readJson(file, { schemaVersion: APPROVAL_SCHEMA, approvals: {} }, 'Aprobările corpusului de autonomie');
  if (!parsed || parsed.schemaVersion !== APPROVAL_SCHEMA || !plainObject(parsed.approvals)) {
    return { schemaVersion: APPROVAL_SCHEMA, approvals: {},
      _error: 'Aprobările autonomiei trebuie să folosească schemaVersion ' + APPROVAL_SCHEMA + ' și obiectul approvals.' };
  }
  return parsed;
}

function legalBasisValid(value) {
  return plainObject(value) && String(value.act || '').trim() && String(value.article || '').trim()
    && /^https:\/\//.test(String(value.url || '').trim());
}

function factValid(value, type) {
  if (value == null || value === '') return false;
  if (type === 'money' || type === 'number') return Number.isFinite(Number(value));
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'date') return isoDate(value);
  return typeof value === 'string' && value.trim() !== '';
}

function inspectFacts(value, rule, label, errors) {
  if (!plainObject(value)) { errors.push(label + ' trebuie să fie obiect'); return; }
  const known = new Set((rule.requiredFacts || []).map((fact) => fact.name));
  const unknown = Object.keys(value).filter((name) => !known.has(name));
  if (unknown.length) errors.push(label + ' conține fapte necunoscute: ' + unknown.join(', '));
}

function inspectExpected(value, label, errors) {
  if (!plainObject(value) || !DECISION_STATUSES.has(value && value.status)) {
    errors.push(label + '.status invalid'); return;
  }
  if (value.status === 'computed' && !plainObject(value.result)) errors.push(label + ' computed cere result');
  if (value.status !== 'computed' && value.result !== undefined && value.result !== null) {
    errors.push(label + ' de refuz nu poate avea rezultat fiscal');
  }
}

function inspectFactEvidence(value, rule, errors) {
  if (value == null) return;
  if (!plainObject(value)) { errors.push('factEvidence trebuie să fie obiect'); return; }
  const facts = new Map((rule.requiredFacts || []).map((fact) => [fact.name, fact]));
  const unknown = Object.keys(value).filter((name) => !facts.has(name));
  if (unknown.length) errors.push('factEvidence conține fapte necunoscute: ' + unknown.join(', '));
  for (const [name, candidates] of Object.entries(value)) {
    if (!Array.isArray(candidates)) continue; // forma cu o singura sursa ramane compatibila
    for (const candidate of candidates) {
      if (!plainObject(candidate) || !String(candidate.sourceId || '').trim()
          || !/^[0-9a-f]{64}$/i.test(String(candidate.sourceHash || ''))
          || (facts.has(name) && !factValid(candidate.value, facts.get(name).type))) {
        errors.push('factEvidence.' + name + ' conține o sursă invalidă'); break;
      }
    }
  }
}

function inspectDefinition(raw, knownRules) {
  const row = plainObject(raw) ? raw : {};
  const id = String(row.id || '').trim(); const ruleId = String(row.ruleId || '').trim();
  const errors = []; const rule = knownRules.get(ruleId) || null;
  if (!/^[A-Z0-9][A-Z0-9._:-]{2,119}$/i.test(id)) errors.push('id invalid');
  if (!rule) errors.push('tratament necunoscut: ' + (ruleId || '(gol)'));
  if (!KINDS.has(row.kind)) errors.push('tip de acoperire invalid');
  if (!/^[a-z0-9][a-z0-9._:-]{1,119}$/i.test(String(row.coverageId || ''))) errors.push('coverageId invalid');
  if (!isoDate(row.validAt)) errors.push('validAt invalid');
  if (rule) inspectFacts(row.facts, rule, 'facts', errors);
  else if (!plainObject(row.facts)) errors.push('facts trebuie să fie obiect');
  inspectExpected(row.expected, 'expected', errors);
  if (['incomplete_data', 'contradictory_data', 'mandatory_refusal'].includes(row.kind)
      && row.expected && row.expected.status === 'computed') {
    errors.push('datele incomplete/contradictorii și refuzurile obligatorii nu pot aștepta computed');
  }
  const expectedPositions = POSITIONS[row.kind];
  if (expectedPositions && !expectedPositions.has(row.position)) errors.push('poziția de prag/tranziție este invalidă');
  if (!expectedPositions && row.position != null) errors.push('position este permis numai la praguri și tranziții');
  if (!legalBasisValid(row.legalBasis)) errors.push('temeiul legal exact lipsește');
  if (!String(row.title || '').trim()) errors.push('titlul lipsește');
  if (row.kind === 'temporal_transition') {
    if (!isoDate(row.transitionAt)) errors.push('tranziția temporală cere transitionAt');
  } else if (row.transitionAt != null) errors.push('transitionAt este permis numai pentru tranziții temporale');
  if (row.kind === 'rectification') {
    if (!Array.isArray(row.history) || !row.history.length) errors.push('rectificarea cere history cu decizia/deciziile anterioare');
    else if (rule) row.history.forEach((step, index) => {
      if (!plainObject(step) || !isoDate(step.validAt)) errors.push('history[' + index + '].validAt invalid');
      inspectFacts(step && step.facts, rule, 'history[' + index + '].facts', errors);
      inspectExpected(step && step.expected, 'history[' + index + '].expected', errors);
      inspectFactEvidence(step && step.factEvidence, rule, errors);
    });
  } else if (row.history != null) errors.push('history este permis numai pentru rectificări');
  if (rule) {
    inspectFactEvidence(row.factEvidence, rule, errors);
    const claim = coverageKey(row);
    if (!requiredCoverage(rule).includes(claim)) errors.push('dimensiune de acoperire nedeclarată: ' + claim);
  }
  return { id: id || '(fără id)', ruleId, kind: row.kind, coverageId: String(row.coverageId || ''),
    position: row.position || null, validAt: String(row.validAt || ''), raw: row, rule, errors };
}

function executeStep(ruleId, row) {
  try {
    const fiscalRules = require('./fiscalRules');
    const ruleSet = fiscalRules.at(row.validAt);
    const decision = fiscalRules.evaluateTreatment(ruleSet, ruleId, row.facts,
      { factEvidence: row.factEvidence });
    return { actual: { status: decision.status, result: decision.result == null ? null : decision.result }, decision };
  } catch (error) {
    if (error && error.code === 'FISCAL_RULES_NOT_FOUND') {
      return { actual: { status: 'ruleset_unavailable', result: null }, decision: null };
    }
    return { error: 'Execuția a eșuat: ' + error.message };
  }
}

function expectedDecision(row) {
  return { status: row.expected.status, result: row.expected.result == null ? null : row.expected.result };
}

function executeCase(definition) {
  if (definition.errors.length) return Object.assign({}, definition, { status: 'invalid', reason: definition.errors.join('; ') });
  const history = [];
  for (const [index, step] of (definition.raw.history || []).entries()) {
    const executed = executeStep(definition.ruleId, step);
    if (executed.error) return Object.assign({}, definition, { status: 'failed', reason: executed.error });
    const expected = expectedDecision(step);
    if (stableJson(executed.actual) !== stableJson(expected)) {
      return Object.assign({}, definition, { status: 'failed', reason: 'history[' + index + ']: așteptat '
        + stableJson(expected) + ', obținut ' + stableJson(executed.actual) + '.' });
    }
    history.push(executed);
  }
  const executed = executeStep(definition.ruleId, definition.raw);
  if (executed.error) return Object.assign({}, definition, { status: 'failed', reason: executed.error });
  const actual = executed.actual; const expected = expectedDecision(definition.raw);
  const resultMatches = stableJson(actual) === stableJson(expected);
  if (!resultMatches) return Object.assign({}, definition, { status: 'failed',
    reason: 'Așteptat ' + stableJson(expected) + ', obținut ' + stableJson(actual) + '.', actual });
  const witnessError = verifyCoverageWitness(definition, executed, history);
  const passed = !witnessError;
  return Object.assign({}, definition, { status: passed ? 'passed' : 'failed',
    reason: passed ? '' : 'Eticheta de acoperire nu este demonstrată: ' + witnessError, actual });
}

function canonicalFacts(rule, facts) {
  const out = {};
  for (const fact of rule.requiredFacts || []) {
    if (!Object.prototype.hasOwnProperty.call(facts || {}, fact.name)) continue;
    const value = facts[fact.name];
    out[fact.name] = ['money', 'number'].includes(fact.type) && factValid(value, fact.type)
      ? Number(value) : fact.type === 'string' && typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

function canonicalEvidence(rule, evidence) {
  const out = {};
  for (const fact of rule.requiredFacts || []) {
    const candidates = evidence && evidence[fact.name];
    if (!Array.isArray(candidates)) continue;
    const values = candidates.filter((candidate) => factValid(candidate && candidate.value, fact.type))
      .map((candidate) => canonicalFacts({ requiredFacts: [fact] }, { [fact.name]: candidate.value })[fact.name]);
    out[fact.name] = [...new Map(values.map((value) => [stableJson(value), value])).values()]
      .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }
  return out;
}

function ruleSetPoint(validAt, temporal) {
  if (temporal) return { validAt };
  try {
    const ruleSet = require('./fiscalRules').at(validAt);
    return { ruleSetId: ruleSet.id, ruleSetHash: ruleSet.hash };
  } catch (error) {
    return { uncovered: String(validAt).slice(0, 4) };
  }
}

function scenarioHash(definition) {
  const row = definition.raw; const temporal = row.kind === 'temporal_transition';
  const history = (row.history || []).map((step) => ({ point: ruleSetPoint(step.validAt, false),
    facts: canonicalFacts(definition.rule, step.facts),
    factEvidence: canonicalEvidence(definition.rule, step.factEvidence) }));
  return sha(stableJson({ ruleId: definition.ruleId, point: ruleSetPoint(definition.validAt, temporal),
    facts: canonicalFacts(definition.rule, row.facts),
    factEvidence: canonicalEvidence(definition.rule, row.factEvidence), history }));
}

function requiredCoverage(rule) {
  const c = coverageRegistry.forRule(rule);
  if (!c) throw new Error('Tratamentul nu are contract de acoperire autonomă: ' + String(rule && rule.id || '') + '.');
  const out = [];
  for (const id of c.branches) out.push('branch:' + id);
  for (const id of c.thresholds) for (const position of POSITIONS.threshold_boundary) {
    out.push('threshold_boundary:' + id + ':' + position);
  }
  for (const id of c.temporalTransitions) for (const position of POSITIONS.temporal_transition) {
    out.push('temporal_transition:' + id + ':' + position);
  }
  const fields = [
    ['exception_combination', 'exceptionCombinations'], ['rectification', 'rectifications'],
    ['incomplete_data', 'incompleteData'], ['contradictory_data', 'contradictoryData'],
    ['mandatory_refusal', 'mandatoryRefusals'],
  ];
  for (const [kind, field] of fields) for (const id of c[field]) out.push(kind + ':' + id);
  return out;
}

function coverageKey(row) {
  return row.kind + ':' + row.coverageId + (row.position ? ':' + row.position : '');
}

function addDays(value, amount) {
  const date = new Date(String(value) + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function moneyFact(rule) {
  if ((rule.requiredFacts || []).some((fact) => fact.name === 'base')) return 'base';
  if ((rule.requiredFacts || []).some((fact) => fact.name === 'expense')) return 'expense';
  if ((rule.requiredFacts || []).some((fact) => fact.name === 'inputVat')) return 'inputVat';
  return null;
}

function evidenceConflict(executed, name) {
  return !!(executed.decision && executed.decision.factEvidence
    && executed.decision.factEvidence.conflictingFacts.includes(name));
}

function verifyTemporalWitness(definition) {
  const row = definition.raw; const transition = row.transitionAt;
  const offset = row.position === 'before' ? -1 : row.position === 'after' ? 1 : 0;
  if (row.validAt !== addDays(transition, offset)) return 'validAt trebuie să fie exact cu o zi înainte/la/o zi după transitionAt';
  if (row.coverageId === 'rule-validity-start' && transition !== definition.rule.validFrom) {
    return 'transitionAt nu este începutul valabilității regulii';
  }
  if (row.coverageId === 'fiscal-year-boundary' && !/^\d{4}-01-01$/.test(transition)) {
    return 'transitionAt nu este prima zi a unui an fiscal';
  }
  if (row.coverageId === 'legal-regime-transition') {
    const fiscalRules = require('./fiscalRules');
    const starts = fiscalRules.all().filter((ruleSet) => ruleSet.validFrom === transition);
    if (!starts.length) return 'transitionAt nu coincide cu intrarea în vigoare a unui FiscalRuleSet';
    try {
      const before = fiscalRules.at(addDays(transition, -1)); const after = fiscalRules.at(transition);
      if (before.hash === after.hash) return 'tranziția nu schimbă versiunea FiscalRuleSet';
    } catch (error) {
      if (!error || error.code !== 'FISCAL_RULES_NOT_FOUND') return 'tranziția de regim nu poate fi verificată';
    }
  }
  return '';
}

function verifyCoverageWitness(definition, executed, history) {
  const row = definition.raw; const rule = definition.rule; const actual = executed.actual;
  const amountName = moneyFact(rule); const amount = Number(row.facts && row.facts[amountName]);
  const vehicle = amountName !== 'base'; const exclusive = row.facts && row.facts.exclusiveBusinessUse;
  if (row.kind === 'branch') {
    if (row.coverageId === 'computed-nonnegative-base'
        && !(actual.status === 'computed' && Number.isFinite(amount) && amount >= 0)) return 'ramura calculată cere bază nenegativă și verdict computed';
    if (row.coverageId === 'negative-base-review'
        && !(actual.status === 'review_required' && Number.isFinite(amount) && amount < 0)) return 'ramura negativă cere bază negativă și review_required';
    if (row.coverageId === 'limited-use'
        && !(actual.status === 'computed' && amount >= 0 && exclusive === false)) return 'limitarea cere sumă nenegativă și utilizare neexclusivă';
    if (row.coverageId === 'exclusive-business-use'
        && !(actual.status === 'not_applicable' && amount >= 0 && exclusive === true)) return 'uzul exclusiv trebuie să producă not_applicable';
    if (/^negative-(?:expense|vat)-review$/.test(row.coverageId)
        && !(actual.status === 'review_required' && amount < 0)) return 'ramura negativă trebuie să producă review_required';
  }
  if (row.kind === 'threshold_boundary') {
    const expected = row.position === 'below' ? -0.01 : row.position === 'above' ? 0.01 : 0;
    if (!Number.isFinite(amount) || amount !== expected) return 'pragul zero cere exact -0,01 / 0 / +0,01';
  }
  if (row.kind === 'temporal_transition') return verifyTemporalWitness(definition);
  if (row.kind === 'exception_combination') {
    if (actual.status !== 'review_required' || !(amount < 0)) return 'excepția trebuie observată ca review_required pe sumă negativă';
    if (vehicle && row.coverageId === 'negative-nonexclusive' && exclusive !== false) return 'combinația cere utilizare neexclusivă';
    if (vehicle && row.coverageId === 'negative-exclusive' && exclusive !== true) return 'combinația cere utilizare exclusivă';
  }
  if (row.kind === 'rectification') {
    const minimum = row.coverageId === 'correction-of-correction' ? 2 : 1;
    if (history.length < minimum) return 'rectificarea nu are suficiente decizii anterioare executate';
    const snapshots = (row.history || []).map((step) => stableJson(canonicalFacts(rule, step.facts)))
      .concat(stableJson(canonicalFacts(rule, row.facts)));
    if (new Set(snapshots).size !== snapshots.length) return 'rectificarea repetă aceeași fotografie de fapte';
    const dates = (row.history || []).map((step) => step.validAt).concat(row.validAt);
    if (dates.some((date, index) => index && date < dates[index - 1])) return 'istoricul rectificării nu este cronologic';
  }
  if (row.kind === 'incomplete_data') {
    const fact = row.coverageId === 'missing-use-classification' ? 'exclusiveBusinessUse' : amountName;
    const present = Object.prototype.hasOwnProperty.call(row.facts, fact);
    const factSpec = (rule.requiredFacts || []).find((item) => item.name === fact);
    if (row.coverageId.startsWith('missing-') && present) return 'faptul declarat lipsă este prezent';
    if (row.coverageId.startsWith('invalid-') && (!present || factValid(row.facts[fact], factSpec.type))) {
      return 'faptul declarat invalid lipsește sau este valid';
    }
    if (actual.status !== 'undetermined') return 'datele incomplete/invalide trebuie refuzate cu undetermined';
  }
  if (row.kind === 'contradictory_data') {
    const fact = row.coverageId === 'use-evidence-conflict' ? 'exclusiveBusinessUse' : amountName;
    if (!evidenceConflict(executed, fact) || actual.status !== 'undetermined') {
      return 'sursele contradictorii trebuie detectate de motor și refuzate cu undetermined';
    }
  }
  if (row.kind === 'mandatory_refusal') {
    const missing = row.coverageId.startsWith('missing-');
    if (missing) {
      const fact = row.coverageId === 'missing-use-evidence' ? 'exclusiveBusinessUse' : amountName;
      if (Object.prototype.hasOwnProperty.call(row.facts, fact) || actual.status !== 'undetermined') {
        return 'refuzul pentru fapt lipsă cere absența faptului și verdict undetermined';
      }
    } else if (!(amount < 0) || actual.status !== 'review_required' || row.history) {
      return 'corecția negativă nelegată cere sumă negativă, fără istoric, și review_required';
    }
  }
  return '';
}

function assessCoverage(rule, caseResults) {
  const contract = coverageRegistry.forRule(rule);
  if (!contract) throw new Error('Tratamentul nu are contract de acoperire autonomă: ' + String(rule && rule.id || '') + '.');
  const passed = caseResults.filter((row) => row.ruleId === rule.id && row.status === 'passed');
  const uniqueScenarios = new Set(passed.map(scenarioHash));
  const covered = new Set(passed.map(coverageKey));
  const required = requiredCoverage(rule);
  const missing = required.filter((key) => !covered.has(key));
  return {
    complete: !missing.length && uniqueScenarios.size >= contract.minimumUniqueCases,
    passedCases: passed.length,
    uniqueCases: uniqueScenarios.size,
    minimumUniqueCases: contract.minimumUniqueCases,
    requiredDimensions: required.length,
    coveredDimensions: required.length - missing.length,
    missing,
  };
}

function inspectUncertainty(raw, knownRules) {
  const row = plainObject(raw) ? raw : {}; const errors = [];
  const id = String(row.id || '').trim(); const status = String(row.status || '');
  const ruleIds = Array.isArray(row.ruleIds) ? [...new Set(row.ruleIds.map(String))] : [];
  if (!/^[A-Z0-9][A-Z0-9._:-]{2,119}$/i.test(id)) errors.push('id invalid');
  if (!['open', 'resolved'].includes(status)) errors.push('status invalid');
  if (!ruleIds.length || ruleIds.some((ruleId) => !knownRules.has(ruleId))) errors.push('ruleIds lipsă sau necunoscute');
  if (!String(row.question || '').trim() || !String(row.impact || '').trim() || !legalBasisValid(row.legalBasis)) {
    errors.push('întrebarea, impactul și temeiul legal sunt obligatorii');
  }
  if (status === 'resolved' && (!/^[0-9a-f]{64}$/.test(String(row.resolutionEvidenceSha256 || ''))
      || !String(row.resolvedBy || '').trim() || !isoDate(row.resolvedAt))) {
    errors.push('închiderea cere dovadă SHA-256, profesionist și dată');
  }
  return { id: id || '(fără id)', status, ruleIds, question: String(row.question || ''),
    impact: String(row.impact || ''), errors };
}

function currentCorpusHash(corpus, context) {
  const c = context || fiscalReview.reviewContext();
  return sha(stableJson({ schemaVersion: CORPUS_SCHEMA, cases: corpus.cases,
    materialUncertainties: corpus.materialUncertainties,
    sourceManifestHash: c.manifest.rootHash, runtimeRulesHash: c.rules.hash,
    treatmentsHash: treatments.registryHash(),
    coverageHash: coverageRegistry.registryHash(treatments.all()) }));
}

function signedPayload(approval) {
  return {
    domain: SIGNATURE_DOMAIN, schemaVersion: APPROVAL_SCHEMA,
    reviewer: String(approval.reviewer || ''), credential: String(approval.credential || ''),
    reviewedAt: String(approval.reviewedAt || ''), legalBasis: String(approval.legalBasis || ''),
    evidenceDocumentSha256: String(approval.evidenceDocumentSha256 || '').toLowerCase(),
    keyId: String(approval.keyId || '').toLowerCase(), corpusHash: String(approval.corpusHash || '').toLowerCase(),
  };
}
function signatureMessage(approval) { return SIGNATURE_DOMAIN + '\n' + stableJson(signedPayload(approval)); }

function inspectApproval(approval, key, trust, hash, today) {
  const row = plainObject(approval) ? approval : {}; const missing = REQUIRED_APPROVAL.filter((field) => !String(row[field] || '').trim());
  if (missing.length) return { status: 'invalid', reason: 'Lipsesc: ' + missing.join(', ') + '.' };
  if (String(row.keyId).toLowerCase() !== String(key).toLowerCase()) return { status: 'invalid', reason: 'Cheia indexului nu corespunde keyId.' };
  if (!isoDate(row.reviewedAt) || row.reviewedAt > today) return { status: 'invalid', reason: 'Data reviziei este invalidă sau în viitor.' };
  if (!/^[0-9a-f]{64}$/i.test(row.evidenceDocumentSha256)) return { status: 'invalid', reason: 'SHA-256 al dosarului este invalid.' };
  if (String(row.corpusHash).toLowerCase() !== hash) return { status: 'invalid', reason: 'Corpul, codul sau regulile s-au schimbat după semnare.' };
  const keyId = String(row.keyId).toLowerCase(); const reviewer = (trust.reviewers || {})[keyId];
  if (!reviewer) return { status: 'invalid', reason: 'Cheia nu este autorizată.' };
  if (reviewer.reviewer !== row.reviewer || reviewer.credential !== row.credential) return { status: 'invalid', reason: 'Identitatea nu corespunde cheii.' };
  if (!validIsoDate(String(reviewer.credentialVerifiedAt || '')) || !String(reviewer.credentialEvidence || '').trim()
      || reviewer.revokedAt || (reviewer.validFrom && row.reviewedAt < reviewer.validFrom)
      || (reviewer.validUntil && row.reviewedAt > reviewer.validUntil)) {
    return { status: 'invalid', reason: 'Calitatea sau valabilitatea revizorului nu este verificabilă.' };
  }
  try {
    if (fiscalReview.publicKeyId(reviewer.publicKeyPem) !== keyId) return { status: 'invalid', reason: 'Cheia publică nu corespunde keyId.' };
    const valid = crypto.verify(null, Buffer.from(signatureMessage(row), 'utf8'),
      crypto.createPublicKey(reviewer.publicKeyPem), Buffer.from(String(row.signature), 'base64'));
    if (!valid) return { status: 'invalid', reason: 'Semnătura Ed25519 este invalidă.' };
  } catch (error) { return { status: 'invalid', reason: 'Semnătura nu poate fi verificată: ' + error.message }; }
  return { status: 'approved', reviewer: row.reviewer, credential: row.credential,
    reviewedAt: row.reviewedAt, keyId, evidenceDocumentSha256: row.evidenceDocumentSha256 };
}

function status(explicitCorpus, options) {
  const o = options || {}; const corpus = readCorpus(explicitCorpus);
  const context = o.context || fiscalReview.reviewContext(o);
  const currentHash = currentCorpusHash(corpus, context);
  const known = new Map(treatments.all().map((rule) => [rule.id, rule]));
  const coverageContracts = coverageRegistry.all([...known.values()]);
  const coverageByRule = new Map(coverageContracts.map((row) => [row.ruleId, row]));
  const definitions = corpus.cases.map((row) => inspectDefinition(row, known));
  const duplicateIds = definitions.map((row) => row.id).filter((id, index, all) => all.indexOf(id) !== index);
  const caseResults = definitions.map(executeCase);
  const uncertainties = corpus.materialUncertainties.map((row) => inspectUncertainty(row, known));
  const approvals = readApprovals(o.approvalsBundle);
  const trust = fiscalReview.readTrust(o.trustBundle);
  const today = o.today || new Date().toISOString().slice(0, 10);
  const approvalResults = Object.entries(approvals.approvals || {}).map(([key, row]) =>
    Object.assign({ keyId: key }, inspectApproval(row, key, trust, currentHash, today)));
  // Două chei ale aceleiași persoane nu reprezintă doi revizori independenți.
  const approvedReviewers = new Set(approvalResults.filter((row) => row.status === 'approved')
    .map((row) => row.reviewer + '\u0000' + row.credential)).size;
  const validPassed = caseResults.filter((row) => row.status === 'passed');
  const uniqueCases = new Set(validPassed.map(scenarioHash)).size;
  const configErrors = [corpus._error, approvals._error, trust._error].filter(Boolean);
  if ((context.manifest.errors || []).length) configErrors.push('Manifestul surselor are erori.');
  if (duplicateIds.length) configErrors.push('ID-uri de caz duplicate: ' + [...new Set(duplicateIds)].join(', ') + '.');
  if (caseResults.some((row) => row.status === 'invalid')) configErrors.push('Corpul conține definiții invalide.');
  if (uncertainties.some((row) => row.errors.length)) configErrors.push('Registrul incertitudinilor este invalid.');
  const uncertaintyIds = new Set(uncertainties.map((row) => row.id));
  const missingKnownUncertainties = [...REQUIRED_UNCERTAINTIES.keys()].filter((id) => !uncertaintyIds.has(id));
  if (missingKnownUncertainties.length) configErrors.push('Incertitudini cunoscute eliminate din registru: '
    + missingKnownUncertainties.join(', ') + '.');
  const incorrectlyScoped = uncertainties.filter((row) => REQUIRED_UNCERTAINTIES.has(row.id)
    && stableJson(row.ruleIds.slice().sort()) !== stableJson(REQUIRED_UNCERTAINTIES.get(row.id).slice().sort()));
  if (incorrectlyScoped.length) configErrors.push('Domeniul incertitudinilor cunoscute a fost schimbat: '
    + incorrectlyScoped.map((row) => row.id).join(', ') + '.');
  const volumeReady = uniqueCases >= MINIMUM_CASES;
  const signaturesReady = approvedReviewers >= MINIMUM_REVIEWERS;
  const rules = [...known.values()].map((rule) => {
    const coverage = assessCoverage(rule, caseResults);
    const failedCases = caseResults.filter((row) => row.ruleId === rule.id && row.status === 'failed').map((row) => row.id);
    const openUncertainties = uncertainties.filter((row) => row.status === 'open' && row.ruleIds.includes(rule.id))
      .map((row) => ({ id: row.id, question: row.question, impact: row.impact }));
    const blockers = [];
    if (configErrors.length) blockers.push('Configurația corpusului de autonomie este invalidă.');
    if (!volumeReady) blockers.push('Corpul are ' + uniqueCases + '/' + MINIMUM_CASES + ' scenarii unice trecute.');
    if (!signaturesReady) blockers.push('Corpul are ' + approvedReviewers + '/' + MINIMUM_REVIEWERS + ' revizori independenți validați.');
    if (!coverage.complete) blockers.push('Acoperirea regulii este incompletă: ' + coverage.coveredDimensions + '/'
      + coverage.requiredDimensions + ' dimensiuni și ' + coverage.uniqueCases + '/' + coverage.minimumUniqueCases + ' cazuri unice.');
    if (failedCases.length) blockers.push('Cazuri executate cu rezultat diferit: ' + failedCases.join(', ') + '.');
    if (openUncertainties.length) blockers.push('Există incertitudini juridice materiale deschise: '
      + openUncertainties.map((row) => row.id).join(', ') + '.');
    if (rule.risk === 'critical') blockers.push('Riscul critic necesită o poartă profesională suplimentară, încă neimplementată.');
    return { ruleId: rule.id, ruleHash: rule.hash, coverageHash: coverageByRule.get(rule.id).hash,
      domain: rule.domain, risk: rule.risk, ready: !blockers.length, coverage,
      failedCases, openUncertainties, blockers };
  });
  return {
    ready: rules.length > 0 && rules.every((row) => row.ready),
    gateKind: 'autonomy', releaseGateIndependent: true,
    corpusHash: currentHash, schemaVersion: CORPUS_SCHEMA,
    total: corpus.cases.length, passed: validPassed.length, uniqueCases,
    invalid: caseResults.filter((row) => row.status === 'invalid').length,
    failed: caseResults.filter((row) => row.status === 'failed').length,
    minimumCases: MINIMUM_CASES, volumeReady,
    approvedReviewers, minimumReviewers: MINIMUM_REVIEWERS, signaturesReady,
    configError: configErrors.join(' ') || null,
    materialUncertainties: uncertainties.map((row) => ({ id: row.id, status: row.status,
      ruleIds: row.ruleIds, question: row.question, impact: row.impact, errors: row.errors })),
    rules,
    cases: caseResults.map((row) => ({ id: row.id, ruleId: row.ruleId, kind: row.kind,
      coverageId: row.coverageId, position: row.position, status: row.status,
      scenarioHash: row.rule && plainObject(row.raw && row.raw.facts) ? scenarioHash(row) : null,
      witnessVerified: row.status === 'passed', reason: row.reason || '' })),
    approvals: approvalResults,
    sourceManifestHash: context.manifest.rootHash, runtimeRulesHash: context.rules.hash,
    treatmentsHash: treatments.registryHash(), coverageHash: coverageRegistry.registryHash([...known.values()]),
    positioning: 'Corpus distinct de poarta 25/25; autonomia rămâne blocată până la volum, acoperire, semnături și clarificarea incertitudinilor.',
  };
}

function template() {
  const corpus = readCorpus(); const hash = currentCorpusHash(corpus);
  return { reviewer: '', credential: '', reviewedAt: '', legalBasis: '',
    evidenceDocumentSha256: '', keyId: '', corpusHash: hash, signature: '' };
}

module.exports = {
  CORPUS_SCHEMA, APPROVAL_SCHEMA, MINIMUM_CASES, MINIMUM_REVIEWERS, SIGNATURE_DOMAIN,
  DEFAULT_CORPUS, DEFAULT_APPROVALS, KINDS, REQUIRED_UNCERTAINTIES,
  readCorpus, readApprovals, currentCorpusHash,
  signedPayload, signatureMessage, inspectDefinition, executeCase, requiredCoverage,
  scenarioHash, assessCoverage, status, template,
};
