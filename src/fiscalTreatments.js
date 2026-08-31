'use strict';

// Registrul tratamentelor fiscale EXECUTABILE. FiscalRuleSet nu mai spune numai „ce cote sunt
// valabile”, ci poarta si regulile care transforma faptele in rezultate. Formulele sunt un AST
// inchis (fara eval / cod arbitrar), iar fiecare verdict retine faptele, regula, temeiul si
// cerintele de revizie care l-au produs.

const crypto = require('crypto');

const CODE_FISCAL_URL = 'https://legislatie.just.ro/Public/DetaliiDocument/184770';
const RISK = new Set(['low', 'medium', 'high', 'critical']);
const TYPES = new Set(['money', 'number', 'boolean', 'string', 'date']);
const OPS = new Set(['fact', 'rate', 'add', 'sub', 'mul', 'div', 'min', 'max', 'round', 'abs',
  'neg', 'clamp', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'not', 'if']);
const ARITY = Object.freeze({ fact: [1, 1], rate: [1, 1], add: [1, Infinity], sub: [1, Infinity],
  mul: [1, Infinity], div: [2, 2], min: [1, Infinity], max: [1, Infinity], round: [1, 2],
  abs: [1, 1], neg: [1, 1], clamp: [3, 3], eq: [2, 2], neq: [2, 2], gt: [2, 2],
  gte: [2, 2], lt: [2, 2], lte: [2, 2], and: [1, Infinity], or: [1, Infinity],
  not: [1, 1], if: [3, 3] });
// Capabilitati private: niciun apelant nu poate transforma aprobari JSON neverificate intr-un
// verdict autonom. Poarta de lansare (25 cazuri) si corpusul de autonomie sunt deliberat distincte.
const VERIFIED_RELEASE_REVIEW = Symbol('verified-release-review');
const VERIFIED_AUTONOMY_CORPUS = Symbol('verified-autonomy-corpus');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value); Object.keys(value).forEach((key) => deepFreeze(value[key])); return value;
}
function fail(message) { throw new Error('Tratament fiscal invalid: ' + message); }
function text(value, label, max) {
  const out = String(value || '').trim();
  if (!out) fail(label + ' lipseste.');
  if (out.length > max) fail(label + ' depaseste ' + max + ' caractere.');
  return out;
}
function date(value, label, nullable) {
  if (nullable && (value == null || value === '')) return null;
  const out = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out)) fail(label + ' trebuie sa fie YYYY-MM-DD.');
  const parsed = new Date(out + 'T00:00:00.000Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== out) fail(label + ' nu este calendaristica.');
  return out;
}

function validateExpression(expr, facts, label) {
  if (!Array.isArray(expr)) {
    if (expr == null || ['number', 'string', 'boolean'].includes(typeof expr)) return;
    fail(label + ' contine o valoare nepermisa.');
  }
  if (!expr.length || !OPS.has(expr[0])) fail(label + ' foloseste operatorul necunoscut „' + String(expr[0]) + '”.');
  const operands = expr.length - 1; const arity = ARITY[expr[0]];
  if (operands < arity[0] || operands > arity[1]) {
    fail(label + ' foloseste un numar invalid de operanzi pentru „' + expr[0] + '”.');
  }
  if (expr[0] === 'fact') {
    if (expr.length !== 2 || !facts.has(String(expr[1]))) fail(label + ' refera faptul nedeclarat „' + String(expr[1]) + '”.');
    return;
  }
  if (expr[0] === 'rate') {
    if (expr.length !== 2 || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(String(expr[1]))) fail(label + ' are o cota invalida.');
    return;
  }
  for (const part of expr.slice(1)) validateExpression(part, facts, label);
}

function normalizeFact(raw) {
  const fact = raw || {}; const name = text(fact.name, 'Numele faptului', 100);
  const type = String(fact.type || '');
  if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) fail('Numele faptului „' + name + '” este invalid.');
  if (!TYPES.has(type)) fail('Tipul faptului „' + name + '” este invalid.');
  return { name, type, description: text(fact.description, 'Descrierea faptului ' + name, 500),
    sourceRequired: fact.sourceRequired !== false };
}

function normalizeLegalBasis(raw) {
  const row = raw || {}; const url = text(row.url, 'URL-ul temeiului legal', 1000);
  if (!/^https:\/\//.test(url)) fail('URL-ul temeiului legal trebuie sa fie HTTPS.');
  return { act: text(row.act, 'Actul normativ', 300), article: text(row.article, 'Articolul', 200),
    summary: text(row.summary, 'Rezumatul temeiului', 1500), url };
}

function normalize(raw) {
  const row = raw || {};
  const id = text(row.id, 'ID-ul', 120); const domain = text(row.domain, 'Domeniul', 80);
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(id)) fail('ID-ul „' + id + '” este invalid.');
  const validFrom = date(row.validFrom, 'validFrom'); const validTo = date(row.validTo, 'validTo', true);
  if (validTo && validTo < validFrom) fail(id + ': validTo este anterior lui validFrom.');
  const risk = String(row.risk || ''); if (!RISK.has(risk)) fail(id + ': nivel de risc invalid.');
  const requiredFacts = (row.requiredFacts || []).map(normalizeFact);
  const factNames = new Set(requiredFacts.map((fact) => fact.name));
  if (factNames.size !== requiredFacts.length) fail(id + ': fapte obligatorii duplicate.');
  const appliesWhen = row.appliesWhen == null ? true : row.appliesWhen;
  validateExpression(appliesWhen, factNames, id + '.appliesWhen');
  const outputs = row.calculation && row.calculation.outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs) || !Object.keys(outputs).length) {
    fail(id + ': calculul nu are rezultate.');
  }
  const normalizedOutputs = {};
  for (const key of Object.keys(outputs).sort()) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) fail(id + ': cheia rezultatului „' + key + '” este invalida.');
    validateExpression(outputs[key], factNames, id + '.calculation.' + key);
    normalizedOutputs[key] = outputs[key];
  }
  const exceptions = (row.exceptions || []).map((exception, index) => {
    validateExpression(exception.when, factNames, id + '.exceptions[' + index + ']');
    return { when: exception.when, reason: text(exception.reason, 'Motivul exceptiei', 1000) };
  });
  const examples = [...new Set((row.approvedExamples || []).map((x) => text(x, 'Exemplul aprobat', 80)))];
  if (!examples.length) fail(id + ': lipsesc exemplele aprobate.');
  const review = row.review || {};
  const requiredCaseIds = [...new Set((review.requiredCaseIds || examples).map((x) => text(x, 'Cazul de revizie', 80)))];
  if (!requiredCaseIds.length) fail(id + ': lipsesc cazurile de revizie obligatorii.');
  const base = {
    schemaVersion: 1, id, domain, title: text(row.title, 'Titlul', 300), validFrom, validTo,
    appliesWhen, requiredFacts, calculation: { engine: 'safe-ast-v1', outputs: normalizedOutputs },
    result: { description: text(row.result && row.result.description, 'Descrierea rezultatului', 800),
      unit: text(row.result && row.result.unit, 'Unitatea rezultatului', 30) },
    exceptions, legalBasis: (row.legalBasis || []).map(normalizeLegalBasis),
    approvedExamples: examples, risk,
    review: { signatureRequired: true, signatureAlgorithm: 'Ed25519', requiredCaseIds },
    explanation: text(row.explanation, 'Explicatia', 1500),
  };
  if (!base.legalBasis.length) fail(id + ': lipseste temeiul legal.');
  return deepFreeze(Object.assign({}, base, { hash: sha256(base) }));
}

function normalizeSnapshots(rows) {
  if (!Array.isArray(rows) || !rows.length) fail('snapshot-ul nu contine tratamente.');
  const seen = new Set();
  return rows.map((raw) => {
    const rule = normalize(raw);
    if (raw && raw.hash && raw.hash !== rule.hash) fail(rule.id + ': hash-ul snapshot-ului este invalid.');
    if (seen.has(rule.id)) fail('snapshot-ul contine tratamentul duplicat „' + rule.id + '”.');
    seen.add(rule.id); return rule;
  });
}

function pctRule(id, domain, title, rate, article, summary, examples, risk, baseDescription) {
  return {
    id, domain, title, validFrom: '2024-01-01', validTo: null, risk,
    appliesWhen: ['gte', ['fact', 'base'], 0],
    requiredFacts: [{ name: 'base', type: 'money', description: baseDescription, sourceRequired: true }],
    calculation: { outputs: { amount: ['round', ['mul', ['fact', 'base'], ['div', ['rate', rate], 100]], 2] } },
    result: { description: 'Obligatia fiscala calculata prin aplicarea cotei la baza confirmata.', unit: 'RON' },
    exceptions: [{ when: ['lt', ['fact', 'base'], 0], reason: 'Baza negativa cere tratamentul specific de regularizare, nu aplicarea directa a cotei.' }],
    legalBasis: [{ act: 'Legea nr. 227/2015 privind Codul fiscal', article, summary, url: CODE_FISCAL_URL }],
    approvedExamples: examples, review: { requiredCaseIds: examples },
    explanation: 'Se aplica {{rate.' + rate + '}}% la baza confirmata de {{fact.base}} lei; rezultatul este {{result.amount}} lei.',
  };
}

const DEFINITIONS = [
  pctRule('ro.payroll.cas', 'payroll', 'CAS datorata de salariat', 'cas', 'art. 138 si art. 139',
    'CAS se aplica bazei lunare de calcul a contributiei de asigurari sociale.', ['COT-01', 'SAL-01'], 'high', 'Baza CAS a lunii, dupa includeri si excluderi legale.'),
  pctRule('ro.payroll.cass', 'payroll', 'CASS datorata de salariat', 'cass', 'art. 156 si art. 157',
    'CASS se aplica bazei lunare de calcul a contributiei de asigurari sociale de sanatate.', ['COT-01', 'SAL-01'], 'high', 'Baza CASS a lunii, dupa includeri si excluderi legale.'),
  pctRule('ro.payroll.income_tax', 'payroll', 'Impozitul pe venitul salarial', 'impozitVenit', 'art. 78',
    'Impozitul lunar se aplica bazei impozabile dupa contributii si deduceri.', ['COT-01', 'SAL-01', 'DED-01'], 'high', 'Baza impozabila salariala dupa contributii si deduceri.'),
  pctRule('ro.payroll.cam', 'payroll', 'Contributia asiguratorie pentru munca', 'cam', 'art. 220^3 si art. 220^4',
    'CAM se aplica bazei datorate de angajator.', ['COT-01', 'SAL-01'], 'high', 'Baza CAM a angajatorului.'),
  pctRule('ro.withholding.dividends', 'withholding', 'Impozitul retinut la sursa pentru dividende',
    'impozitDividende', 'art. 43 si art. 97', 'Impozitul pe dividende se retine prin aplicarea cotei valabile la dividendul brut.',
    ['COT-04'], 'high', 'Dividendul brut distribuit si impozabil.'),
  pctRule('ro.pfa.cas', 'pfa', 'CAS pentru activitati independente', 'cas', 'art. 148',
    'CAS se aplica bazei anuale stabilite dupa plafoanele activitatilor independente.', ['COT-01', 'PFA-01', 'PFA-02', 'PFA-03'], 'high', 'Baza CAS anuala stabilita dupa plafoane.'),
  pctRule('ro.pfa.cass', 'pfa', 'CASS pentru activitati independente', 'cass', 'art. 170',
    'CASS se aplica bazei anuale stabilite dupa plafonul minim si maxim.', ['COT-01', 'PFA-01', 'PFA-02', 'PFA-03'], 'high', 'Baza CASS anuala stabilita dupa plafoane.'),
  pctRule('ro.pfa.income_tax', 'pfa', 'Impozitul pe venitul net din activitati independente',
    'impozitVenit', 'art. 118', 'Impozitul se aplica venitului net anual impozabil dupa contributiile deductibile.',
    ['COT-01', 'PFA-01', 'PFA-02', 'PFA-03'], 'high', 'Venitul net anual impozabil dupa contributii.'),
  pctRule('ro.tax.micro', 'micro', 'Impozitul pe veniturile microintreprinderii', 'impozitMicro', 'art. 51 si art. 53',
    'Cota micro se aplica bazei fiscale determinate conform art. 53, nu totalului contabil al clasei 7.', ['COT-04'], 'critical', 'Baza fiscala micro dupa scaderi si adaugari.'),
  pctRule('ro.tax.profit', 'profit', 'Impozitul brut pe profit', 'impozitProfit', 'art. 17 si art. 19',
    'Cota de impozit pe profit se aplica profitului impozabil dupa ajustarile fiscale si pierderile utilizabile.', ['COT-04', 'PLF-01', 'PLF-02', 'PLF-03', 'PLF-04', 'PLF-05', 'PLF-06'], 'critical', 'Profitul impozabil dupa ajustarile fiscale.'),
  {
    id: 'ro.profit.vehicle_limited_deduction', domain: 'profit',
    title: 'Deductibilitatea limitata a cheltuielilor auto', validFrom: '2024-01-01', validTo: null,
    risk: 'critical', appliesWhen: ['eq', ['fact', 'exclusiveBusinessUse'], false],
    requiredFacts: [
      { name: 'expense', type: 'money', description: 'Cheltuiala auto aferenta vehiculului.', sourceRequired: true },
      { name: 'exclusiveBusinessUse', type: 'boolean', description: 'Utilizarea exclusiv economica, sustinuta documentar.', sourceRequired: true },
    ],
    calculation: { outputs: {
      deductibleExpense: ['round', ['mul', ['fact', 'expense'], ['div', ['rate', 'autoCheltuialaDeductibilPct'], 100]], 2],
      nondeductibleExpense: ['round', ['sub', ['fact', 'expense'], ['mul', ['fact', 'expense'], ['div', ['rate', 'autoCheltuialaDeductibilPct'], 100]]], 2],
    } },
    result: { description: 'Partea deductibila si partea nedeductibila a cheltuielii auto.', unit: 'RON' },
    exceptions: [{ when: ['lt', ['fact', 'expense'], 0], reason: 'Corectia negativa trebuie legata de tratamentul documentului initial.' }],
    legalBasis: [{ act: 'Legea nr. 227/2015 privind Codul fiscal', article: 'art. 25 alin. (3) lit. l)',
      summary: 'Cheltuielile aferente vehiculelor fara utilizare exclusiv economica au deductibilitate limitata.', url: CODE_FISCAL_URL }],
    approvedExamples: ['PLF-04'], review: { requiredCaseIds: ['PLF-04'] },
    explanation: 'Vehiculul nu are utilizare exclusiv economica; din cheltuiala de {{fact.expense}} lei sunt deductibili {{result.deductibleExpense}} lei.',
  },
  pctRule('ro.vat.standard', 'vat', 'TVA la cota standard', 'tvaStandard', 'art. 291',
    'TVA standard se calculeaza prin aplicarea cotei valabile bazei taxabile.', ['COT-03'], 'high', 'Baza taxabila la cota standard.'),
  pctRule('ro.vat.reduced', 'vat', 'TVA la cota redusa', 'tvaRedus', 'art. 291',
    'TVA redusa se calculeaza numai pentru operatiunile eligibile cotei reduse.', ['COT-03'], 'high', 'Baza confirmata ca eligibila cotei reduse.'),
  {
    id: 'ro.vat.vehicle_limited_deduction', domain: 'vat', title: 'Deducerea limitata a TVA pentru vehicule',
    validFrom: '2024-01-01', validTo: null, risk: 'critical',
    appliesWhen: ['eq', ['fact', 'exclusiveBusinessUse'], false],
    requiredFacts: [
      { name: 'inputVat', type: 'money', description: 'TVA deductibila inaintea limitarii.', sourceRequired: true },
      { name: 'exclusiveBusinessUse', type: 'boolean', description: 'Utilizarea exclusiv economica, sustinuta documentar.', sourceRequired: true },
    ],
    calculation: { outputs: {
      deductibleVat: ['round', ['mul', ['fact', 'inputVat'], ['div', ['rate', 'deductibilitateTvaAutoLimitat'], 100]], 2],
      nondeductibleVat: ['round', ['sub', ['fact', 'inputVat'], ['mul', ['fact', 'inputVat'], ['div', ['rate', 'deductibilitateTvaAutoLimitat'], 100]]], 2],
    } },
    result: { description: 'TVA deductibila si partea nedeductibila pentru vehicul fara utilizare exclusiv economica.', unit: 'RON' },
    exceptions: [{ when: ['lt', ['fact', 'inputVat'], 0], reason: 'O corectie negativa de TVA necesita legarea de operatiunea initiala.' }],
    legalBasis: [{ act: 'Legea nr. 227/2015 privind Codul fiscal', article: 'art. 298',
      summary: 'Dreptul de deducere este limitat pentru vehiculele care nu sunt utilizate exclusiv in scopul activitatii economice.', url: CODE_FISCAL_URL }],
    approvedExamples: ['COT-03'], review: { requiredCaseIds: ['COT-03'] },
    explanation: 'Vehiculul nu are utilizare exclusiv economica; din TVA {{fact.inputVat}} lei se deduc {{result.deductibleVat}} lei.',
  },
].map(normalize);

const BY_ID = new Map(DEFINITIONS.map((rule) => [rule.id, rule]));

function activeForInterval(validFrom, validTo) {
  const from = date(validFrom, 'validFrom'); const to = date(validTo, 'validTo', true);
  return DEFINITIONS.filter((rule) => rule.validFrom <= from
    && (to ? (!rule.validTo || rule.validTo >= to) : !rule.validTo));
}

function getFact(facts, name) {
  return Object.prototype.hasOwnProperty.call(facts || {}, name) ? facts[name] : undefined;
}
function validFact(value, type) {
  if (value == null || value === '') return false;
  if (type === 'money' || type === 'number') return Number.isFinite(Number(value));
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
    const parsed = new Date(String(value) + 'T00:00:00.000Z');
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === String(value);
  }
  return typeof value === 'string' && value.trim() !== '';
}
function numeric(value, label) {
  const out = Number(value); if (!Number.isFinite(out)) throw new Error(label + ' nu este numeric.'); return out;
}
function compute(expr, facts, rates) {
  if (!Array.isArray(expr)) return expr;
  const op = expr[0];
  if (op === 'fact') return getFact(facts, String(expr[1]));
  if (op === 'rate') return rates && rates[String(expr[1])];
  // Ramurile conditionale sunt evaluate lenes: o impartire nepermisa din ramura nealeasa nu are
  // voie sa transforme o formula valida intr-un verdict nedeterminabil.
  if (op === 'if') return compute(expr[1], facts, rates)
    ? compute(expr[2], facts, rates) : compute(expr[3], facts, rates);
  if (op === 'and') return expr.slice(1).every((part) => Boolean(compute(part, facts, rates)));
  if (op === 'or') return expr.slice(1).some((part) => Boolean(compute(part, facts, rates)));
  const args = expr.slice(1).map((part) => compute(part, facts, rates));
  if (op === 'add') return args.reduce((sum, value) => sum + numeric(value, 'Operandul add'), 0);
  if (op === 'sub') return args.length === 1 ? -numeric(args[0], 'Operandul sub')
    : args.slice(1).reduce((value, part) => value - numeric(part, 'Operandul sub'), numeric(args[0], 'Operandul sub'));
  if (op === 'mul') return args.reduce((value, part) => value * numeric(part, 'Operandul mul'), 1);
  if (op === 'div') {
    const denominator = numeric(args[1], 'Numitorul'); if (denominator === 0) throw new Error('Impartire la zero.');
    return numeric(args[0], 'Numaratorul') / denominator;
  }
  if (op === 'min') return Math.min(...args.map((x) => numeric(x, 'Operandul min')));
  if (op === 'max') return Math.max(...args.map((x) => numeric(x, 'Operandul max')));
  if (op === 'round') {
    const digits = Math.max(0, Math.min(8, Math.round(numeric(args[1] == null ? 2 : args[1], 'Precizia'))));
    const factor = 10 ** digits; return Math.round((numeric(args[0], 'Valoarea rotunjita') + Number.EPSILON) * factor) / factor;
  }
  if (op === 'abs') return Math.abs(numeric(args[0], 'Operandul abs'));
  if (op === 'neg') return -numeric(args[0], 'Operandul neg');
  if (op === 'clamp') return Math.min(numeric(args[2], 'Maximul clamp'), Math.max(numeric(args[1], 'Minimul clamp'), numeric(args[0], 'Valoarea clamp')));
  if (op === 'eq') return args[0] === args[1];
  if (op === 'neq') return args[0] !== args[1];
  if (op === 'gt') return numeric(args[0], 'Operandul gt') > numeric(args[1], 'Operandul gt');
  if (op === 'gte') return numeric(args[0], 'Operandul gte') >= numeric(args[1], 'Operandul gte');
  if (op === 'lt') return numeric(args[0], 'Operandul lt') < numeric(args[1], 'Operandul lt');
  if (op === 'lte') return numeric(args[0], 'Operandul lte') <= numeric(args[1], 'Operandul lte');
  if (op === 'not') return !args[0];
  throw new Error('Operator neimplementat: ' + op + '.');
}

function render(template, facts, rates, result) {
  return String(template).replace(/\{\{(fact|rate|result)\.([a-zA-Z0-9]+)\}\}/g, (_all, kind, key) => {
    const source = kind === 'fact' ? facts : kind === 'rate' ? rates : result;
    return source && Object.prototype.hasOwnProperty.call(source, key) ? String(source[key]) : '?';
  });
}

function reviewEvidence(rule, cases, cryptographicallyVerified) {
  const approvals = []; const missing = [];
  for (const id of rule.review.requiredCaseIds) {
    const row = cases && cases[id]; const approval = row && row.approval;
    if (!row || row.status !== 'approved' || !approval || !approval.signature || !approval.keyId) {
      missing.push(id); continue;
    }
    approvals.push({ caseId: id, reviewer: approval.reviewer || '', credential: approval.credential || '',
      reviewedAt: approval.reviewedAt || '', keyId: approval.keyId, signature: approval.signature,
      evidenceDocumentSha256: approval.evidenceDocumentSha256 || '' });
  }
  return { status: missing.length ? 'pending' : cryptographicallyVerified ? 'approved' : 'unverified',
    cryptographicallyVerified: cryptographicallyVerified === true,
    signatureRequired: true,
    signatureAlgorithm: rule.review.signatureAlgorithm, requiredCaseIds: rule.review.requiredCaseIds,
    missingCaseIds: missing, approvals };
}

function autonomyEvidence(rule, gate, cryptographicallyVerified) {
  const row = gate && gate.rule;
  const ready = !!row && row.ready === true && cryptographicallyVerified === true;
  return {
    status: ready ? 'approved' : 'blocked',
    cryptographicallyVerified: cryptographicallyVerified === true,
    gateKind: 'autonomy',
    ruleHash: String(row && row.ruleHash || ''),
    corpusHash: String(gate && gate.corpusHash || ''),
    corpusCases: Number(gate && gate.total || 0),
    minimumCases: Number(gate && gate.minimumCases || 0),
    approvedReviewers: Number(gate && gate.approvedReviewers || 0),
    minimumReviewers: Number(gate && gate.minimumReviewers || 0),
    ruleCoverage: row && row.coverage ? row.coverage : null,
    openUncertainties: row && Array.isArray(row.openUncertainties) ? row.openUncertainties : [],
    blockers: row && Array.isArray(row.blockers) ? row.blockers : ['Corpusul separat de autonomie nu a fost verificat.'],
  };
}

function sourceEvidence(rule, supplied) {
  const accepted = {}; const missing = [];
  for (const fact of rule.requiredFacts) {
    if (!fact.sourceRequired) continue;
    const row = supplied && supplied[fact.name];
    const sourceId = String(row && row.sourceId || '').trim();
    const sourceHash = String(row && row.sourceHash || '').toLowerCase();
    if (!sourceId || !/^[0-9a-f]{64}$/.test(sourceHash)) { missing.push(fact.name); continue; }
    accepted[fact.name] = { sourceId: sourceId.slice(0, 500), sourceHash,
      capturedAt: row.capturedAt ? String(row.capturedAt) : '' };
  }
  return { supplied: accepted, missingFacts: missing };
}

function expressionDependencies(rule) {
  const rateNames = new Set();
  function collect(expr) {
    if (!Array.isArray(expr)) return;
    if (expr[0] === 'rate') rateNames.add(String(expr[1]));
    else expr.slice(1).forEach(collect);
  }
  collect(rule.appliesWhen);
  Object.values(rule.calculation.outputs).forEach(collect);
  rule.exceptions.forEach((exception) => collect(exception.when));
  return [...rateNames].sort();
}

function decisionInfluences(rule, ruleSet, facts, factEvidence) {
  const supplied = factEvidence && factEvidence.supplied || {};
  const rules = [{ id: rule.id, hash: rule.hash, validFrom: rule.validFrom, validTo: rule.validTo,
    risk: rule.risk }];
  const ruleSets = [{ id: ruleSet.id, hash: ruleSet.hash, validFrom: ruleSet.validFrom,
    validTo: ruleSet.validTo, publishedAt: ruleSet.publishedAt, approvalId: ruleSet.approvalId || null }];
  const parameters = expressionDependencies(rule).map((name) => ({
    name, value: Object.prototype.hasOwnProperty.call(ruleSet.rates || {}, name) ? ruleSet.rates[name] : null,
    ruleSetId: ruleSet.id,
  }));
  const usedFacts = rule.requiredFacts.map((fact) => ({ name: fact.name, type: fact.type,
    value: getFact(facts, fact.name), sourceRequired: fact.sourceRequired,
    source: supplied[fact.name] || null }));
  const payload = { rules, ruleSets, parameters, facts: usedFacts };
  return Object.assign({ hash: sha256(payload) }, payload);
}

function decision(rule, ruleSet, status, facts, extra) {
  const used = {};
  for (const fact of rule.requiredFacts) used[fact.name] = getFact(facts, fact.name);
  const base = Object.assign({ ruleId: rule.id, ruleHash: rule.hash, ruleSetId: ruleSet.id,
    fiscalRulesHash: ruleSet.hash, status, facts: used, formula: rule.calculation,
    legalBasis: rule.legalBasis, risk: rule.risk, approvedExamples: rule.approvedExamples }, extra || {});
  base.influences = decisionInfluences(rule, ruleSet, facts, base.factEvidence);
  return deepFreeze(Object.assign({ decisionId: sha256({ influences: base.influences.hash,
    status, facts: used, factEvidence: base.factEvidence || null, review: base.review || null,
    autonomy: base.autonomy || null,
    autonomousEligible: base.autonomousEligible === true,
    result: base.result || null, reason: base.reason || null }) }, base));
}

function evaluate(rule, ruleSet, facts, options) {
  const opts = options || {}; const values = facts || {}; const rates = ruleSet.rates || {};
  const missingFacts = rule.requiredFacts.filter((fact) => !validFact(getFact(values, fact.name), fact.type))
    .map((fact) => fact.name);
  const missingRates = expressionDependencies(rule).filter((key) => !Number.isFinite(Number(rates[key])));
  const review = reviewEvidence(rule, opts.reviewCases, opts[VERIFIED_RELEASE_REVIEW] === true);
  const autonomy = autonomyEvidence(rule, opts.autonomyGate, opts[VERIFIED_AUTONOMY_CORPUS] === true);
  const evidence = sourceEvidence(rule, opts.factEvidence);
  if (missingFacts.length || missingRates.length) return decision(rule, ruleSet, 'undetermined', values, {
    missingFacts, missingRates, review, autonomy, factEvidence: evidence, result: null,
    reason: 'Tratamentul nu poate fi calculat fara toate faptele si cotele obligatorii.',
    autonomousEligible: false,
  });
  try {
    const exception = rule.exceptions.find((row) => compute(row.when, values, rates));
    if (exception) return decision(rule, ruleSet, 'review_required', values, {
      missingFacts: [], missingRates: [], review, autonomy, factEvidence: evidence, result: null, reason: exception.reason,
      autonomousEligible: false,
    });
    if (!compute(rule.appliesWhen, values, rates)) return decision(rule, ruleSet, 'not_applicable', values, {
      missingFacts: [], missingRates: [], review, autonomy, factEvidence: evidence, result: null,
      reason: 'Conditiile de aplicare ale tratamentului nu sunt indeplinite.', autonomousEligible: false,
    });
    const result = {};
    for (const [key, expr] of Object.entries(rule.calculation.outputs)) {
      const value = compute(expr, values, rates);
      if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new Error('Rezultatul „' + key + '” nu este finit.');
      }
      result[key] = value;
    }
    const explanation = render(rule.explanation, values, rates, result);
    // Cele 25 de cazuri pot deschide doar poarta de lansare. Capabilitatea autonoma apare separat,
    // numai dupa corpusul mare, acoperirea structurala si incertitudinile verificate de fiscalAutonomy.
    const autonomousEligible = review.status === 'approved' && opts[VERIFIED_RELEASE_REVIEW] === true
      && autonomy.status === 'approved' && opts[VERIFIED_AUTONOMY_CORPUS] === true
      && !evidence.missingFacts.length && opts.autonomyPolicyApproved === true && rule.risk !== 'critical';
    return decision(rule, ruleSet, 'computed', values, { missingFacts: [], missingRates: [],
      result, explanation, review, autonomy, factEvidence: evidence, autonomousEligible,
      autonomyReason: autonomousEligible ? '' : autonomy.status !== 'approved' || opts[VERIFIED_AUTONOMY_CORPUS] !== true
        ? (autonomy.blockers[0] || 'Corpusul separat de autonomie este incomplet sau neverificat.')
        : review.status !== 'approved' || opts[VERIFIED_RELEASE_REVIEW] !== true
          ? 'Poarta de lansare 25/25 nu este aprobata.'
        : evidence.missingFacts.length ? 'Lipseste provenienta verificabila pentru faptele: ' + evidence.missingFacts.join(', ') + '.'
          : opts.autonomyPolicyApproved !== true ? 'Politica de autonomie a firmei nu a autorizat tratamentul.'
          : 'Regulile cu risc critic necesita o poarta suplimentara chiar dupa revizia corpusului.',
    });
  } catch (error) {
    return decision(rule, ruleSet, 'undetermined', values, { missingFacts: [], missingRates, review, autonomy,
      factEvidence: evidence,
      result: null, reason: 'Formula nu poate fi evaluata: ' + error.message, autonomousEligible: false });
  }
}

function evaluateForAutonomy(rule, ruleSet, facts, options) {
  // Require lenes pentru a evita ciclul de initializare: ambele porti semneaza fotografia exacta
  // a codului si regulilor, dar numai fiscalAutonomy poate emite capabilitatea de autonomie.
  const release = require('./fiscalReview').status();
  const releaseCases = Object.fromEntries((release.cases || []).map((row) => [row.id, row]));
  const corpus = require('./fiscalAutonomy').status();
  const ruleAutonomy = (corpus.rules || []).find((row) => row.ruleId === rule.id && row.ruleHash === rule.hash) || null;
  return evaluate(rule, ruleSet, facts, Object.assign({}, options || {}, {
    reviewCases: releaseCases,
    autonomyGate: Object.assign({}, corpus, { rule: ruleAutonomy }),
    [VERIFIED_RELEASE_REVIEW]: release.ready === true,
    [VERIFIED_AUTONOMY_CORPUS]: !!ruleAutonomy && ruleAutonomy.ready === true && ruleAutonomy.ruleHash === rule.hash,
  }));
}

function byId(id) { return BY_ID.get(String(id)) || null; }
function snapshot(rules) { return (rules || DEFINITIONS).map((rule) => ({ id: rule.id, hash: rule.hash,
  validFrom: rule.validFrom, validTo: rule.validTo, risk: rule.risk })); }
function registryHash(rules) { return sha256(snapshot(rules)); }

module.exports = { all: () => DEFINITIONS.slice(), byId, activeForInterval, normalizeSnapshots,
  evaluate, evaluateForAutonomy, snapshot, registryHash, expressionDependencies,
  decisionInfluences, canonical, sha256 };
