'use strict';

// Flux legislativ industrializat. AI-ul poate semnala o schimbare; interpretarea, aprobarea si
// publicarea sunt capabilitati umane distincte, iar fiecare pas intra intr-un lant append-only.

const crypto = require('crypto');
const STAGES = Object.freeze(['detected', 'interpreted', 'impact_assessed', 'package_drafted',
  'independently_approved', 'tested', 'shadow', 'published', 'recalculation_planned', 'completed']);
const REQUIREMENTS = Object.freeze({
  detected: ['officialSource', 'sourceHash', 'detectedAt'],
  interpreted: ['interpretation', 'effectiveFrom'],
  impact_assessed: ['affectedRuleIds', 'affectedClientIds'],
  package_drafted: ['rulePackageHash'],
  independently_approved: ['approval'],
  tested: ['testEvidence', 'validatorEvidence'],
  shadow: ['shadowEvidence'],
  published: ['publication'],
  recalculation_planned: ['recalculation'],
  completed: ['completion'],
});
const HASH_RE = /^[0-9a-f]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function fail(message, code) { const e = new Error(message); e.code = code; e.status = 409; throw e; }
function actor(raw) {
  const row = raw || {};
  if (row.actorId == null && !String(row.username || '').trim()) fail('Identitatea actorului lipsește.', 'LEGISLATIVE_ACTOR_REQUIRED');
  return { actorId: row.actorId == null ? null : row.actorId, username: String(row.username || '').trim().slice(0, 120),
    role: String(row.role || '').trim().slice(0, 80), kind: row.kind === 'ai' ? 'ai' : 'human' };
}
function eventHash(event) { const body = Object.assign({}, event); delete body.hash; return hash(body); }
function identity(value) { return String(value && (value.actorId != null ? value.actorId : value.username) || ''); }
function calendarDate(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(raw + 'T00:00:00.000Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}
function eventFor(rec, stage) { return ((rec && rec.events) || []).find((event) => event.stage === stage) || null; }
function evidenceIssues(rec, stage, evidence) {
  const value = evidence || {}; const issues = [];
  for (const field of REQUIREMENTS[stage] || []) {
    const item = value[field];
    if (item == null || item === '' || (Array.isArray(item) && !item.length)) issues.push('lipsește dovada „' + field + '”');
  }
  if (stage === 'detected') {
    if (!/^https:\/\//.test(String(value.officialSource || '')) || !HASH_RE.test(String(value.sourceHash || ''))
        || Number.isNaN(new Date(value.detectedAt || '').getTime())) issues.push('sursa oficială, hash-ul sau momentul detectării sunt invalide');
  } else if (stage === 'interpreted') {
    if (!String(value.interpretation || '').trim() || !calendarDate(value.effectiveFrom)) issues.push('interpretarea sau data efectivă sunt invalide');
  } else if (stage === 'impact_assessed') {
    if (!Array.isArray(value.affectedRuleIds) || !value.affectedRuleIds.length
        || !value.affectedRuleIds.every((id) => String(id || '').trim())) issues.push('regulile afectate nu sunt identificate');
    if (!Array.isArray(value.affectedClientIds) || !value.affectedClientIds.length) issues.push('clienții afectați nu sunt identificați');
  } else if (stage === 'package_drafted') {
    if (!HASH_RE.test(String(value.rulePackageHash || ''))) issues.push('hash-ul pachetului de reguli este invalid');
  } else if (stage === 'independently_approved') {
    const approval = value.approval || {}; const drafted = eventFor(rec, 'package_drafted');
    const packageHash = String(drafted && drafted.evidence && drafted.evidence.rulePackageHash || '');
    if (!HASH_RE.test(String(approval.signatureHash || ''))) issues.push('semnătura aprobatorului este invalidă');
    if (!packageHash || String(approval.rulePackageHash || '') !== packageHash) issues.push('aprobarea nu semnează pachetul redactat');
  } else if (stage === 'tested') {
    const test = value.testEvidence || {}; const validator = value.validatorEvidence || {};
    const cases = Number(test.cases); const passed = Number(test.passed);
    if (!Number.isInteger(cases) || cases <= 0 || passed !== cases || Number(test.failed || 0) !== 0) {
      issues.push('corpusul de teste nu este integral trecut');
    }
    if (!HASH_RE.test(String(validator.proofHash || ''))) issues.push('dovada validatorului oficial este invalidă');
  } else if (stage === 'shadow') {
    const shadow = value.shadowEvidence || {}; const comparisons = Number(shadow.comparisons);
    if (!calendarDate(shadow.from) || !calendarDate(shadow.to) || shadow.to < shadow.from) issues.push('intervalul shadow mode este invalid');
    if (!Number.isInteger(comparisons) || comparisons <= 0) issues.push('shadow mode nu conține comparații');
    if (!Number.isInteger(Number(shadow.differences)) || Number(shadow.differences) < 0
        || Number(shadow.unresolvedDifferences) !== 0) issues.push('shadow mode păstrează diferențe nerezolvate');
  } else if (stage === 'published') {
    const publication = value.publication || {}; const drafted = eventFor(rec, 'package_drafted');
    const interpreted = eventFor(rec, 'interpreted');
    if (!calendarDate(publication.validFrom) || !String(publication.ruleSetId || '').trim()
        || !HASH_RE.test(String(publication.ruleSetHash || ''))) issues.push('publicarea nu identifică integral RuleSet-ul');
    if (drafted && String(publication.ruleSetHash || '') !== String(drafted.evidence.rulePackageHash || '')) {
      issues.push('RuleSet-ul publicat diferă de pachetul testat și aprobat');
    }
    if (interpreted && String(publication.validFrom || '') !== String(interpreted.evidence.effectiveFrom || '')) {
      issues.push('data publicării diferă de data efectivă interpretată');
    }
  } else if (stage === 'recalculation_planned') {
    const plan = value.recalculation || {}; const impact = eventFor(rec, 'impact_assessed');
    if (!Array.isArray(plan.periods) || !plan.periods.length
        || !plan.periods.every((period) => /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(String(period)))) {
      issues.push('perioadele de recalculat sunt invalide');
    }
    if (!Array.isArray(plan.affectedClients) || !plan.affectedClients.length) issues.push('clienții de recalculat lipsesc');
    const expected = new Set(((impact && impact.evidence.affectedClientIds) || []).map(String));
    const planned = new Set((plan.affectedClients || []).map(String));
    if ([...expected].some((id) => !planned.has(id))) issues.push('planul de recalculare nu acoperă toți clienții afectați');
    if (!Array.isArray(plan.rectificativeProposals)) issues.push('propunerile de rectificative nu sunt inventariate');
  } else if (stage === 'completed') {
    if (!value.completion || value.completion.recalculated !== true) issues.push('recalcularea nu este confirmată ca finalizată');
  }
  return issues;
}

function create(db, raw, options) {
  const d = db || {}; const row = raw || {}; const opts = options || {};
  d.legislativeChanges = Array.isArray(d.legislativeChanges) ? d.legislativeChanges : [];
  const who = actor(row.actor); const sourceHash = String(row.sourceHash || '').toLowerCase();
  if (!/^https:\/\//.test(String(row.officialSource || '')) || !/^[0-9a-f]{64}$/.test(sourceHash)) {
    fail('Detectarea cere sursa oficială HTTPS și hash-ul conținutului.', 'LEGISLATIVE_OFFICIAL_SOURCE_REQUIRED');
  }
  const detectedAt = new Date(row.detectedAt || opts.now || new Date().toISOString()).toISOString();
  const rec = { schemaVersion: 1, id: String(row.id || (opts.nextId && opts.nextId('leg')) || ''),
    title: String(row.title || '').trim().slice(0, 300), stage: 'detected', createdAt: detectedAt,
    events: [] };
  if (!rec.id || !rec.title) fail('Identitatea sau titlul schimbării lipsește.', 'LEGISLATIVE_CHANGE_INVALID');
  if (d.legislativeChanges.some((x) => String(x.id) === rec.id)) fail('Schimbarea există deja.', 'LEGISLATIVE_CHANGE_DUPLICATE');
  appendEvent(rec, 'detected', { officialSource: String(row.officialSource), sourceHash, detectedAt,
    detection: row.detection || null }, who, detectedAt);
  d.legislativeChanges.push(rec); return rec;
}

function appendEvent(rec, stage, evidence, who, at) {
  const previous = rec.events.length ? rec.events[rec.events.length - 1] : null;
  const event = { schemaVersion: 1, seq: rec.events.length + 1, stage,
    at: new Date(at || new Date().toISOString()).toISOString(), actor: who,
    evidence: JSON.parse(JSON.stringify(evidence || {})), previousHash: previous ? previous.hash : null };
  event.hash = eventHash(event); rec.events.push(event); rec.stage = stage; rec.chainHash = event.hash; return event;
}

function advance(rec, nextStage, rawEvidence, rawActor, at) {
  if (!rec || !Array.isArray(rec.events)) fail('Dosarul legislativ lipsește.', 'LEGISLATIVE_CHANGE_REQUIRED');
  const currentIndex = STAGES.indexOf(rec.stage); const nextIndex = STAGES.indexOf(nextStage);
  if (nextIndex !== currentIndex + 1) fail('Etapele legislative nu pot fi sărite sau rescrise.', 'LEGISLATIVE_STAGE_INVALID');
  const who = actor(rawActor); const evidence = rawEvidence || {};
  const evidenceErrors = evidenceIssues(rec, nextStage, evidence);
  if (evidenceErrors.length) fail('Etapa ' + nextStage + ': ' + evidenceErrors.join('; ') + '.', 'LEGISLATIVE_EVIDENCE_INVALID');
  if (nextStage !== 'detected' && who.kind !== 'human') {
    fail('AI-ul poate detecta schimbări, dar nu poate interpreta, aproba sau publica reguli.', 'LEGISLATIVE_HUMAN_REQUIRED');
  }
  const interpreted = eventFor(rec, 'interpreted');
  const drafted = eventFor(rec, 'package_drafted');
  if (nextStage === 'independently_approved') {
    const priorActors = [interpreted, drafted].filter(Boolean).map((event) => identity(event.actor));
    if (priorActors.includes(identity(who))) {
      fail('Aprobatorul trebuie să fie independent de interpret și autorul pachetului.', 'LEGISLATIVE_INDEPENDENCE_REQUIRED');
    }
  }
  const previous = rec.events[rec.events.length - 1];
  if (previous && new Date(at || new Date().toISOString()).getTime() < new Date(previous.at).getTime()) {
    fail('Momentul etapei nu poate fi anterior etapei precedente.', 'LEGISLATIVE_TIME_INVALID');
  }
  return appendEvent(rec, nextStage, evidence, who, at);
}

function verify(rec) {
  const issues = []; let previousHash = null; let stageIndex = -1;
  for (let i = 0; i < ((rec && rec.events) || []).length; i += 1) {
    const event = rec.events[i]; const index = STAGES.indexOf(event.stage);
    if (Number(event.seq) !== i + 1 || index !== stageIndex + 1) issues.push('secvență invalidă la evenimentul #' + (i + 1));
    if ((event.previousHash || null) !== previousHash || event.hash !== eventHash(event)) issues.push('lanț hash invalid la evenimentul #' + (i + 1));
    for (const problem of evidenceIssues(rec, event.stage, event.evidence)) issues.push('dovadă invalidă la evenimentul #' + (i + 1) + ': ' + problem);
    if (event.stage !== 'detected' && (!event.actor || event.actor.kind !== 'human')) issues.push('actor neuman la evenimentul #' + (i + 1));
    if (i && new Date(event.at).getTime() < new Date(rec.events[i - 1].at).getTime()) issues.push('cronologie invalidă la evenimentul #' + (i + 1));
    previousHash = event.hash; stageIndex = index;
  }
  const approval = eventFor(rec, 'independently_approved');
  const interpreted = eventFor(rec, 'interpreted'); const drafted = eventFor(rec, 'package_drafted');
  if (approval && [interpreted, drafted].filter(Boolean).some((event) => identity(event.actor) === identity(approval.actor))) {
    issues.push('aprobatorul nu este independent');
  }
  if (rec && (rec.chainHash !== previousHash || rec.stage !== STAGES[stageIndex])) issues.push('proiecția dosarului nu coincide cu lanțul');
  return { valid: issues.length === 0, issues, stage: rec && rec.stage, chainHash: previousHash || '' };
}

module.exports = { STAGES, REQUIREMENTS, canonical, hash, eventHash, evidenceIssues, create, advance, verify };
