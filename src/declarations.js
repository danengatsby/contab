'use strict';

const crypto = require('crypto');
const { postedEntries } = require('./accounting'); // ciornele nu declanseaza asteptari de declaratii/e-Factura
const { fmtDate } = require('./util'); // termenele se scriu romaneste catre om; ISO ramane in date
const fiscalProfile = require('./fiscalProfile'); // motorul de profil fiscal (sursa unica)
const fiscal = require('./fiscal');
const xml = require('./xml'); // perimetrul e-Factura (`isSendable`), derivat din tipurile de document
const d107 = require('./d107');
const d301 = require('./d301');
const d307 = require('./d307');
const d311 = require('./d311');
const d205 = require('./d205');
const intrastat = require('./intrastat');
const roCalendar = require('./romanianCalendar');
const { statPlataPerioada } = require('./payroll');

// Registrul depunerilor de declaratii + termene fiscale + agregarea pe portofoliu (multi-firma).
//
// Modelul: declaratiile ASTEPTATE pentru o firma/luna sunt derivate din profilul firmei
// (platitor de TVA -> D300/D394/D406, are angajati -> D112, luna de trimestru -> D100);
// STAREA efectiva e tinuta in colectia `declarations` cu cheia (firmaId, tip, period):
//   nedepusa (implicit) -> generata (artefact creat) -> aprobata -> transmisa -> depusa
//   (cu recipisa) / eroare;
//   scutita = firma nu datoreaza declaratia in acea perioada (opreste atentionarile).

const TIPURI = {
  d300: { nume: 'D300 — decont TVA' },
  d301: { nume: 'D301 — decont special TVA' },
  d307: { nume: 'D307 — ajustări/corecții/regularizări TVA' },
  d311: { nume: 'D311 — TVA colectată cu codul anulat' },
  d394: { nume: 'D394 — declarație informativă' },
  d112: { nume: 'D112 — contribuții și impozit salarii' },
  d390: { nume: 'D390 — recapitulativă intracomunitară (VIES)' },
  d100: { nume: 'D100 — impozit micro / avans profit (trimestrial)' },
  d101: { nume: 'D101 — impozit pe profit (anual)' },
  d107: { nume: 'D107 — beneficiarii sponsorizărilor/mecenatului' },
  d205: { nume: 'D205 — impozit reținut la sursă (anual)' },
  saft: { nume: 'D406 — SAF-T' },
  intrastat: { nume: 'Intrastat — declarație statistică (INS)' },
  bilant: { nume: 'Situații financiare anuale (bilanț)' },
};
const STATUSES = ['nedepusa', 'generata', 'aprobata', 'transmisa', 'depusa', 'eroare', 'scutita'];

// ── Dosarul unic de depunere ───────────────────────────────────────────────
//
// `declarations[]` rămâne sursa unică de adevăr. Nu introducem o colecție paralelă care ar putea
// ajunge să spună altceva decât registrul: fiecare rând ESTE dosarul pentru exact o identitate
// (firmă, tip, perioadă). Identitatea este deterministă, deci există și înaintea primei generări,
// iar după materializarea rândului nu poate fi mutată pe altă declarație sau perioadă.
const DOSSIER_SCHEMA_VERSION = 1;
const SUBMISSION_SCHEMA_VERSION = 1;
const RECEIPT_BINDING_SCHEMA_VERSION = 1;
// v2 introduce aprobarea documentului exact. Evenimentele v1 rămân verificabile după matricea
// sub care au fost scrise; evenimentele noi nu mai pot sări generată → aprobată → transmisă.
// v3 leagă transmiterea de rezultatul validatorului oficial rulat pe octeții exacți.
const STATE_LEDGER_SCHEMA_VERSION = 3;
const APPROVAL_STATE_LEDGER_SCHEMA_VERSION = 2;
const LEGACY_STATE_LEDGER_SCHEMA_VERSION = 1;
const ALLOWED_TRANSITIONS = Object.freeze({
  nedepusa: new Set(['generata', 'scutita']),
  generata: new Set(['aprobata', 'eroare', 'scutita']),
  aprobata: new Set(['generata', 'transmisa', 'eroare', 'scutita']),
  transmisa: new Set(['depusa', 'eroare']),
  eroare: new Set(['generata']),
  depusa: new Set(),
  scutita: new Set(),
});
const LEGACY_ALLOWED_TRANSITIONS = Object.freeze({
  nedepusa: new Set(['generata', 'scutita']),
  generata: new Set(['transmisa', 'eroare', 'scutita']),
  transmisa: new Set(['depusa', 'eroare']),
  eroare: new Set(['generata']),
  depusa: new Set(),
  scutita: new Set(),
});

function dossierKey(firmaId, tip, period) {
  return String(firmaId) + '|' + String(tip || '').toLowerCase() + '|' + String(period || '');
}

function dossierIdentity(firmaId, tip, period) {
  const key = dossierKey(firmaId, tip, period);
  return {
    schemaVersion: DOSSIER_SCHEMA_VERSION,
    id: 'dd_' + crypto.createHash('sha256').update('contab:dosar-depunere:v1|' + key).digest('hex'),
    key,
    firmaId,
    tip: String(tip || '').toLowerCase(),
    period: String(period || ''),
  };
}

function dossierError(message, code) {
  const e = new Error(message); e.status = 409; e.code = code; return e;
}

function canonicalJson(value) {
  if (value == null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(String(value));
}

function stateEventHash(event) {
  const body = Object.assign({}, event); delete body.hash;
  return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function documentApprovalHash(approval) {
  const body = Object.assign({}, approval); delete body.approvalHash;
  return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function documentApprovalIssues(approval) {
  const a = approval || {}; const issues = [];
  if (Number(a.schemaVersion) !== 1 || a.decision !== 'approved') issues.push('verdictul aprobării este invalid');
  if (!/^dd_[0-9a-f]{64}$/.test(String(a.dossierId || ''))) issues.push('identitatea dosarului lipsește din aprobare');
  if (!/^[0-9a-f]{64}$/.test(String(a.artifactHash || '')) || Number(a.artifactBytes) < 1) {
    issues.push('hash-ul/dimensiunea documentului aprobat lipsește');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(a.approvedAt || ''))
      || !Number.isFinite(Date.parse(String(a.approvedAt || '')))) issues.push('momentul aprobării este invalid');
  const actor = a.approvedBy || {};
  if (actor.actorId == null && !String(actor.username || '').trim()) issues.push('identitatea aprobatorului lipsește');
  if (!/^[0-9a-f]{64}$/.test(String(a.fiscalReviewHash || ''))) issues.push('revizia fiscală lipsește din aprobare');
  if (!/^[0-9a-f]{64}$/.test(String(a.approvalHash || ''))
      || a.approvalHash !== documentApprovalHash(a)) issues.push('amprenta aprobării este invalidă');
  return issues;
}

function approvalForArtifact(rec, artifactHash) {
  const hash = String(artifactHash || '');
  const candidates = [rec && rec.documentApproval,
    ...(rec && Array.isArray(rec.documentApprovals) ? rec.documentApprovals.slice().reverse() : [])];
  return candidates.find((approval) => approval && approval.artifactHash === hash
    && approval.dossierId === (rec && rec.dossier && rec.dossier.id)
    && approval.dossierKey === (rec && rec.dossier && rec.dossier.key)
    && documentApprovalIssues(approval).length === 0) || null;
}

function currentApprovalMatches(rec, artifactHash) {
  const approval = rec && rec.documentApproval;
  return !!(approval && approval.artifactHash === String(artifactHash || '')
    && approval.dossierId === (rec && rec.dossier && rec.dossier.id)
    && approval.dossierKey === (rec && rec.dossier && rec.dossier.key)
    && documentApprovalIssues(approval).length === 0);
}

/** Hash-ul ales de aprobare, independent de ordinea/ultima versiune din `artifacts[]`. */
function approvedArtifactHashOf(rec) {
  const approval = rec && rec.documentApproval;
  return approval && currentApprovalMatches(rec, approval.artifactHash)
    ? String(approval.artifactHash) : '';
}

/**
 * Artefactul sigilat la tranziția spre `transmisa`. Fallback-ul la `artifactHash` există numai
 * pentru dosarele v1, scrise înainte ca selecția transmisă să aibă un câmp separat.
 */
function transmittedArtifactHashOf(rec) {
  const explicit = String(rec && rec.transmittedArtifactHash || '');
  if (/^[0-9a-f]{64}$/.test(explicit)) return explicit;
  const legacyTransmission = (rec && Array.isArray(rec.stateEvents) ? rec.stateEvents : [])
    .some((event) => Number(event.schemaVersion) === LEGACY_STATE_LEDGER_SCHEMA_VERSION
      && event.to === 'transmisa' && event.from !== event.to);
  return legacyTransmission ? String(rec && rec.artifactHash || '') : '';
}

function submissionIdFor(dossierId, ordinal) {
  return 'ds_' + crypto.createHash('sha256')
    .update('contab:depunere:v1|' + String(dossierId || '') + '|' + String(Number(ordinal) || 0))
    .digest('hex');
}

/** Ancora semantică a unei depuneri: nu depinde de ordinea din arrays și nici de datele curente. */
function submissionEvidence(rec, submission) {
  const dossier = rec && rec.dossier || {}; const dep = submission || {};
  const ordinal = Number(dep.ordinal) || 0;
  const documentApprovalHash = String(dep.documentApprovalHash
    || (dep.documentApproval && dep.documentApproval.approvalHash) || '');
  const approvalReferenceKind = /^[0-9a-f]{64}$/.test(documentApprovalHash)
    ? 'document-approval' : 'legacy-evidence';
  const approvalReferenceHash = approvalReferenceKind === 'document-approval' ? documentApprovalHash
    : crypto.createHash('sha256').update(canonicalJson({
      kind: 'legacy-submission-without-document-approval', dossierId: String(dossier.id || ''),
      ordinal, submittedArtifactHash: String(dep.submittedArtifactHash || dep.artifactHash || ''),
      receiptReference: String(dep.recipisa || '').slice(0, 100),
    })).digest('hex');
  const evidence = {
    schemaVersion: SUBMISSION_SCHEMA_VERSION,
    submissionId: submissionIdFor(dossier.id, ordinal),
    dossierId: String(dossier.id || ''), dossierKey: String(dossier.key || ''),
    firmaId: String(dossier.firmaId == null ? '' : dossier.firmaId),
    declarationType: String(dossier.tip || ''), period: String(dossier.period || ''),
    ordinal, rectificativa: dep.rectificativa === true,
    submittedArtifactHash: String(dep.submittedArtifactHash || dep.artifactHash || ''),
    documentApprovalHash, approvalReferenceKind, approvalReferenceHash,
    receiptReference: String(dep.recipisa || '').slice(0, 100),
  };
  evidence.submissionHash = crypto.createHash('sha256').update(canonicalJson(evidence)).digest('hex');
  return evidence;
}

function filingBindingFor(submissionProof) {
  const proof = submissionProof || {};
  return {
    schemaVersion: RECEIPT_BINDING_SCHEMA_VERSION,
    submissionId: String(proof.submissionId || ''), submissionHash: String(proof.submissionHash || ''),
    dossierId: String(proof.dossierId || ''), dossierKey: String(proof.dossierKey || ''),
    firmaId: String(proof.firmaId == null ? '' : proof.firmaId),
    declarationType: String(proof.declarationType || ''), period: String(proof.period || ''),
    ordinal: Number(proof.ordinal) || 0,
    submittedArtifactHash: String(proof.submittedArtifactHash || ''),
    documentApprovalHash: String(proof.documentApprovalHash || ''),
    approvalReferenceKind: String(proof.approvalReferenceKind || ''),
    approvalReferenceHash: String(proof.approvalReferenceHash || ''),
    reference: String(proof.receiptReference || '').slice(0, 100),
  };
}

function receiptBindingHash(receipt, filingBinding) {
  const r = receipt || {};
  return crypto.createHash('sha256').update(canonicalJson({
    schemaVersion: RECEIPT_BINDING_SCHEMA_VERSION,
    filingBinding,
    receipt: {
      sha256: String(r.sha256 || ''), bytes: Number(r.bytes) || 0,
      filename: String(r.filename || '').slice(0, 180), mime: String(r.mime || '').slice(0, 100),
    },
  })).digest('hex');
}

function bindReceiptToSubmission(rec, submission, receipt) {
  const out = JSON.parse(JSON.stringify(receipt || {}));
  const proof = submissionEvidence(rec, submission);
  out.filingBinding = filingBindingFor(proof);
  out.receiptBindingHash = receiptBindingHash(out, out.filingBinding);
  return out;
}

function sealSubmission(rec, submission) {
  const proof = submissionEvidence(rec, submission);
  submission.schemaVersion = SUBMISSION_SCHEMA_VERSION;
  submission.submissionId = proof.submissionId;
  submission.submissionHash = proof.submissionHash;
  return proof;
}

function submissionEvidenceIssues(proof, dossierId, dossierKey) {
  const p = proof || {}; const issues = [];
  if (Number(p.schemaVersion) !== SUBMISSION_SCHEMA_VERSION) issues.push('schema legăturii depunerii este invalidă');
  if (String(p.dossierId || '') !== String(dossierId || '') || String(p.dossierKey || '') !== String(dossierKey || '')) {
    issues.push('legătura depunerii aparține altui dosar');
  }
  if (!Number.isInteger(Number(p.ordinal)) || Number(p.ordinal) < 1
      || p.submissionId !== submissionIdFor(p.dossierId, p.ordinal)) issues.push('identitatea semantică a depunerii este invalidă');
  if (!/^[0-9a-f]{64}$/.test(String(p.submittedArtifactHash || ''))
      || !/^[0-9a-f]{64}$/.test(String(p.approvalReferenceHash || ''))
      || String(p.receiptReference || '').length < 2) issues.push('ancora semantică a depunerii este incompletă');
  if (!['document-approval', 'legacy-evidence'].includes(String(p.approvalReferenceKind || ''))
      || (p.approvalReferenceKind === 'document-approval'
        && p.documentApprovalHash !== p.approvalReferenceHash)) issues.push('referința aprobării depunerii este invalidă');
  if (p.approvalReferenceKind === 'legacy-evidence') {
    const expectedLegacy = crypto.createHash('sha256').update(canonicalJson({
      kind: 'legacy-submission-without-document-approval', dossierId: String(p.dossierId || ''),
      ordinal: Number(p.ordinal) || 0, submittedArtifactHash: String(p.submittedArtifactHash || ''),
      receiptReference: String(p.receiptReference || '').slice(0, 100),
    })).digest('hex');
    if (p.approvalReferenceHash !== expectedLegacy) issues.push('referința legacy a depunerii este invalidă');
  }
  const body = Object.assign({}, p); delete body.submissionHash;
  const expected = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(String(p.submissionHash || '')) || p.submissionHash !== expected) {
    issues.push('hash-ul semantic al depunerii este invalid');
  }
  return issues;
}

function receiptBindingIssues(receipt, submissionProof) {
  const r = receipt || {}; const issues = [];
  const expectedBinding = filingBindingFor(submissionProof);
  if (canonicalJson(r.filingBinding || null) !== canonicalJson(expectedBinding)) {
    issues.push('recipisa indică altă depunere');
  }
  const expectedHash = receiptBindingHash(r, expectedBinding);
  if (!/^[0-9a-f]{64}$/.test(String(r.receiptBindingHash || '')) || r.receiptBindingHash !== expectedHash) {
    issues.push('legătura criptografică a recipisei este invalidă');
  }
  return issues;
}

function publicAuthorization(auth) {
  const a = auth || {};
  return {
    authorized: a.authorized === true, action: String(a.action || ''), actorId: a.actorId == null ? null : a.actorId,
    username: String(a.username || a.actor || '').slice(0, 80),
    role: String(a.role || '').slice(0, 40), source: String(a.source || 'application').slice(0, 80),
  };
}

function stateEventIssues(event) {
  const issues = []; const type = String(event && event.type || '');
  const from = String(event && event.from || ''); const to = String(event && event.to || '');
  const auth = event && event.authorization || {}; const evidence = event && event.evidence || {};
  const schemaVersion = Number(event && event.schemaVersion);
  const transitions = schemaVersion === LEGACY_STATE_LEDGER_SCHEMA_VERSION
    ? LEGACY_ALLOWED_TRANSITIONS : ALLOWED_TRANSITIONS;
  const system = type === 'dossier.created' || type === 'legacy.snapshot';
  if (from !== to && (!transitions[from] || !transitions[from].has(to))) {
    issues.push('tranziție nepermisă ' + from + ' → ' + to);
  }
  if (system) {
    if (auth.username !== 'system' || !['dossier.create', 'migration'].includes(auth.action)) issues.push('eveniment de sistem fără autorizația sistemului');
    return issues;
  }
  const approvalEvent = type === 'approval.recorded';
  const validationEvent = type === 'official-validation.recorded';
  const prepare = type === 'artifact.generated' || type === 'status.generata'
    || (type === 'status.evidence-updated' && to === 'generata');
  const expectedAction = approvalEvent ? 'declaration.approve'
    : validationEvent ? 'declaration.validate'
      : (prepare ? 'declaration.prepare' : 'declaration.submit');
  if (auth.authorized !== true || auth.action !== expectedAction
      || (auth.actorId == null && !String(auth.username || '').trim())) {
    issues.push('autorizație obligatorie lipsă pentru ' + expectedAction);
  }
  const artifact = evidence.artifact || {};
  if (type === 'artifact.generated' || type === 'status.generata'
      || ((to === 'transmisa' || to === 'depusa') && from !== to)) {
    if (!/^[0-9a-f]{64}$/.test(String(artifact.sha256 || '')) || Number(artifact.bytes) < 1) issues.push('dovada artefactului lipsește');
  }
  if (type === 'artifact.generated' || type === 'status.generata') {
    if (!/^[0-9a-f]{64}$/.test(String(evidence.profileHash || ''))) issues.push('dovada profilului fiscal lipsește');
  }
  if (approvalEvent) {
    const approvalIssues = documentApprovalIssues(evidence.approval);
    if (approvalIssues.length) issues.push(...approvalIssues);
    if (String((evidence.approval || {}).artifactHash || '') !== String((evidence.artifact || {}).sha256 || '')) {
      issues.push('aprobarea nu indică artefactul din eveniment');
    }
    if (String((evidence.approval || {}).dossierId || '') !== String(event.dossierId || '')
        || String((evidence.approval || {}).dossierKey || '') !== String(event.dossierKey || '')) {
      issues.push('aprobarea aparține altui dosar');
    }
  }
  if (validationEvent) {
    const proof = evidence.officialValidation || {};
    const validationIssues = require('./officialArtifactValidation').integrityIssues(proof,
      evidence.artifact || {}, String(evidence.fiscalRulesHash || ''));
    if (validationIssues.length) issues.push(...validationIssues.map((issue) => 'validare oficială: ' + issue));
  }
  if (to === 'transmisa' && from !== to && schemaVersion === LEGACY_STATE_LEDGER_SCHEMA_VERSION) {
    const approval = evidence.approval || {};
    if (approval.ready !== true || !/^[0-9a-f]{64}$/.test(String(approval.hash || ''))) issues.push('dovada aprobării fiscale lipsește');
  }
  if ((to === 'transmisa' || to === 'depusa') && from !== to
      && schemaVersion !== LEGACY_STATE_LEDGER_SCHEMA_VERSION) {
    const approval = evidence.approval || {};
    const approvalIssues = documentApprovalIssues(approval);
    if (approvalIssues.length) issues.push(...approvalIssues);
    if (String(approval.artifactHash || '') !== String((evidence.artifact || {}).sha256 || '')) {
      issues.push('tranziția nu folosește documentul exact aprobat');
    }
    if (String(approval.dossierId || '') !== String(event.dossierId || '')
        || String(approval.dossierKey || '') !== String(event.dossierKey || '')) {
      issues.push('tranziția folosește aprobarea altui dosar');
    }
  }
  if (to === 'transmisa' && from !== to && schemaVersion >= STATE_LEDGER_SCHEMA_VERSION) {
    const validationIssues = require('./officialArtifactValidation').issues(
      evidence.officialValidation || {}, evidence.artifact || {}, String(evidence.fiscalRulesHash || ''));
    if (validationIssues.length) issues.push(...validationIssues.map((issue) => 'validare oficială: ' + issue));
  }
  if (to === 'depusa' && from !== to) {
    const receipt = evidence.receipt || {};
    if (String(receipt.reference || '').length < 2 || !/^[0-9a-f]{64}$/.test(String(receipt.sha256 || ''))
        || Number(receipt.bytes) < 1) issues.push('dovada recipisei lipsește');
    if (evidence.submission) {
      issues.push(...submissionEvidenceIssues(evidence.submission, event.dossierId, event.dossierKey));
      issues.push(...receiptBindingIssues(receipt, evidence.submission));
    }
  }
  if ((to === 'eroare' || to === 'scutita') && from !== to && String(evidence.note || '').trim().length < 3) {
    issues.push('nota explicativă obligatorie lipsește');
  }
  if (type === 'submission.recorded' || type === 'submission.amended') {
    const receipts = Array.isArray(evidence.receipt) ? evidence.receipt : [];
    if (!/^[0-9a-f]{64}$/.test(String(evidence.artifactHash || '')) || !receipts.length
        || receipts.some((r) => String(r.reference || '').length < 2
          || !/^[0-9a-f]{64}$/.test(String(r.sha256 || '')) || Number(r.bytes) < 1)) {
      issues.push('depunerea nu are artefactul și recipisa exactă');
    }
    if (schemaVersion !== LEGACY_STATE_LEDGER_SCHEMA_VERSION) {
      const approvalIssues = documentApprovalIssues(evidence.approval);
      if (approvalIssues.length) issues.push(...approvalIssues);
      if (String((evidence.approval || {}).artifactHash || '') !== String(evidence.artifactHash || '')) {
        issues.push('depunerea nu este legată de aprobarea documentului exact');
      }
      if (String((evidence.approval || {}).dossierId || '') !== String(event.dossierId || '')
          || String((evidence.approval || {}).dossierKey || '') !== String(event.dossierKey || '')) {
        issues.push('depunerea folosește aprobarea altui dosar');
      }
    }
    if (schemaVersion >= STATE_LEDGER_SCHEMA_VERSION) {
      const validationIssues = require('./officialArtifactValidation').issues(
        evidence.officialValidation || {}, evidence.artifact || {}, String(evidence.fiscalRulesHash || ''));
      if (validationIssues.length) issues.push(...validationIssues.map((issue) => 'validare oficială: ' + issue));
    }
    if (evidence.submission) {
      issues.push(...submissionEvidenceIssues(evidence.submission, event.dossierId, event.dossierKey));
      for (const receipt of receipts) issues.push(...receiptBindingIssues(receipt, evidence.submission));
    }
  }
  if (type === 'receipt.attached' && (!/^[0-9a-f]{64}$/.test(String(evidence.sha256 || '')) || Number(evidence.bytes) < 1)) {
    issues.push('atașarea recipisei nu are amprenta exactă');
  }
  if (type === 'receipt.attached' && evidence.submission) {
    issues.push(...submissionEvidenceIssues(evidence.submission, event.dossierId, event.dossierKey));
    issues.push(...receiptBindingIssues(evidence, evidence.submission));
  }
  if (type.startsWith('submitted-artifact.')
      && (!/^[0-9a-f]{64}$/.test(String(evidence.toSha256 || '')) || Number(evidence.bytes) < 1)) {
    issues.push('atașarea artefactului depus nu are amprenta exactă');
  }
  if (type.startsWith('submitted-artifact.') && evidence.submission) {
    issues.push(...submissionEvidenceIssues(evidence.submission, event.dossierId, event.dossierKey));
    if (String(evidence.submission.submittedArtifactHash || '') !== String(evidence.toSha256 || '')) {
      issues.push('resigilarea depunerii nu indică artefactul corectat');
    }
  }
  return issues;
}

function appendStateEvent(rec, firmaId, tip, period, info) {
  if (!rec) throw dossierError('Evenimentul de stare cere un dosar persistent.', 'FILING_DOSSIER_REQUIRED');
  ensureDossier(rec, firmaId, tip, period);
  const before = verifyStateLedger(rec, firmaId, tip, period);
  if (!before.valid) throw dossierError('Lanțul stărilor este invalid: ' + before.issues.join('; '), 'FILING_STATE_CHAIN_INVALID');
  rec.stateEvents = Array.isArray(rec.stateEvents) ? rec.stateEvents : [];
  const last = rec.stateEvents.length ? rec.stateEvents[rec.stateEvents.length - 1] : null;
  const from = String((info && info.from) || (last && last.to) || rec.status || 'nedepusa');
  const to = String((info && info.to) || from);
  const event = {
    schemaVersion: STATE_LEDGER_SCHEMA_VERSION,
    dossierId: rec.dossier.id, dossierKey: rec.dossier.key,
    seq: rec.stateEvents.length + 1,
    type: String((info && info.type) || 'state.changed').slice(0, 80),
    from, to,
    at: String((info && info.at) || new Date().toISOString()),
    authorization: publicAuthorization(info && info.authorization),
    evidence: JSON.parse(JSON.stringify((info && info.evidence) || {})),
    previousHash: last ? last.hash : null,
  };
  const eventIssues = stateEventIssues(event);
  if (eventIssues.length) throw dossierError('Evenimentul de stare nu are autorizarea/dovezile obligatorii: ' + eventIssues.join('; '), 'FILING_STATE_EVIDENCE_INVALID');
  event.hash = stateEventHash(event);
  rec.stateEvents.push(event);
  rec.stateChainHash = event.hash;
  return event;
}

function verifyStateLedger(rec, firmaId, tip, period) {
  const events = rec && Array.isArray(rec.stateEvents) ? rec.stateEvents : [];
  if (!events.length) return { valid: true, legacy: true, issues: [], eventCount: 0, lastHash: '', lastState: rec && rec.status || 'nedepusa' };
  const identity = dossierIdentity(firmaId, tip, period);
  const issues = []; let previousHash = null; let state = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i] || {};
    if (![LEGACY_STATE_LEDGER_SCHEMA_VERSION, APPROVAL_STATE_LEDGER_SCHEMA_VERSION,
      STATE_LEDGER_SCHEMA_VERSION].includes(Number(event.schemaVersion))) {
      issues.push('versiune necunoscută la evenimentul #' + (i + 1));
    }
    if (event.dossierId !== identity.id || event.dossierKey !== identity.key) issues.push('evenimentul #' + (i + 1) + ' aparține altei identități');
    if (Number(event.seq) !== i + 1) issues.push('secvență invalidă la evenimentul #' + (i + 1));
    if ((event.previousHash || null) !== previousHash) issues.push('legătură anterioară invalidă la evenimentul #' + (i + 1));
    if (event.hash !== stateEventHash(event)) issues.push('hash invalid la evenimentul #' + (i + 1));
    if (i > 0 && event.from !== state) issues.push('stare de plecare discontinuă la evenimentul #' + (i + 1));
    issues.push(...stateEventIssues(event).map((x) => x + ' la evenimentul #' + (i + 1)));
    state = event.to; previousHash = event.hash;
  }
  if (state !== String(rec.status || 'nedepusa')) issues.push('proiecția status nu coincide cu ultimul eveniment');
  if (String(rec.stateChainHash || '') !== String(previousHash || '')) issues.push('hash-ul terminal al dosarului nu coincide cu lanțul');
  return { valid: issues.length === 0, legacy: false, issues, eventCount: events.length,
    lastHash: previousHash || '', lastState: state || rec.status || 'nedepusa' };
}

/** Materializarea onestă a bazelor vechi: nu inventează tranziții istorice, ci sigilează starea și
 *  hash-ul istoricului legacy observate la migrare într-un singur eveniment-genesis. */
function ensureStateLedger(rec, firmaId, tip, period, opts) {
  if (Array.isArray(rec.stateEvents) && rec.stateEvents.length) {
    const check = verifyStateLedger(rec, firmaId, tip, period);
    if (!check.valid) throw dossierError('Lanțul stărilor este invalid: ' + check.issues.join('; '), 'FILING_STATE_CHAIN_INVALID');
    return rec.stateEvents;
  }
  rec.stateEvents = []; rec.stateChainHash = '';
  const created = !!(opts && opts.created);
  appendStateEvent(rec, firmaId, tip, period, {
    type: created ? 'dossier.created' : 'legacy.snapshot',
    from: rec.status || 'nedepusa', to: rec.status || 'nedepusa',
    at: created ? (opts.at || new Date().toISOString()) : (earliestDossierTimestamp(rec) || (opts && opts.at) || new Date().toISOString()),
    authorization: { action: created ? 'dossier.create' : 'migration', actorId: null, username: 'system', role: 'system', source: created ? 'application' : 'database-migration' },
    evidence: created ? { initialState: rec.status || 'nedepusa' } : {
      legacy: true,
      statusHistoryHash: crypto.createHash('sha256').update(canonicalJson(rec.statusHistory || [])).digest('hex'),
      artifactCount: Array.isArray(rec.artifacts) ? rec.artifacts.length : 0,
      submissionCount: Array.isArray(rec.depuneri) ? rec.depuneri.length : 0,
    },
  });
  return rec.stateEvents;
}

function earliestDossierTimestamp(rec) {
  const values = [rec && rec.generatedAt, rec && rec.transmittedAt, rec && rec.submittedAt,
    ...(Array.isArray(rec && rec.statusHistory) ? rec.statusHistory : []).map((x) => x && x.at),
    ...(Array.isArray(rec && rec.depuneri) ? rec.depuneri : []).map((x) => x && x.ts)]
    .filter(Boolean).map(String).sort();
  return values[0] || null;
}

/** Materializează metadatele dosarului pe rândul persistent. Pentru datele istorice, `createdAt`
 *  folosește primul reper deja păstrat; nu inventează retroactiv data generării. */
function ensureDossier(rec, firmaId, tip, period, now) {
  if (!rec) return null;
  const expected = dossierIdentity(firmaId, tip, period);
  const bound = rec.dossier;
  if (bound && (Number(bound.schemaVersion) !== DOSSIER_SCHEMA_VERSION
      || String(bound.id || '') !== expected.id || String(bound.key || '') !== expected.key
      || String(bound.firmaId) !== String(expected.firmaId)
      || String(bound.tip || '').toLowerCase() !== expected.tip || String(bound.period || '') !== expected.period)) {
    throw dossierError('Identitatea dosarului de depunere nu coincide cu firma, declarația și perioada rândului.', 'FILING_DOSSIER_IDENTITY_MISMATCH');
  }
  rec.dossier = Object.assign({}, expected, {
    createdAt: (bound && bound.createdAt) || earliestDossierTimestamp(rec) || now || null,
  });
  return rec.dossier;
}

/** Refuză o bază ambiguă. `find()` nu are voie să aleagă arbitrar primul dintre două dosare care
 *  pretind aceeași declarație/perioadă. */
function assertUniqueDossiers(d) {
  const keys = new Map(); const ids = new Map();
  for (const rec of (d && d.declarations) || []) {
    const identity = dossierIdentity(rec.firmaId, rec.tip, rec.period);
    if (keys.has(identity.key)) {
      throw dossierError('Există două dosare pentru ' + identity.key + ' (' + keys.get(identity.key) + ' și ' + String(rec.id || '?') + ').', 'DUPLICATE_FILING_DOSSIER');
    }
    if (ids.has(identity.id) && ids.get(identity.id) !== identity.key) {
      throw dossierError('Aceeași identitate de dosar este legată de două chei declarative.', 'DUPLICATE_FILING_DOSSIER_ID');
    }
    keys.set(identity.key, String(rec.id || '?')); ids.set(identity.id, identity.key);
  }
  return true;
}

/** De unde se descarca fiecare declaratie, pe perioada ei. Sta LANGA `TIPURI` fiindca e tot
 *  identitatea declaratiei, nu o preferinta de ecran.
 *
 *  De ce exista: registrul depunerilor era singura lista ACTIONABILA din aplicatie (ce ai de
 *  depus, pana cand, in ce stare), dar randul nu purta si fisierul — spunea „D300 — nedepusa,
 *  termen 25.09" si te trimitea sa cauti XML-ul intr-un catalog de 25 de randuri de deasupra.
 *  Fara link, lista de sarcini nu e de sine statatoare.
 *
 *  Caile sunt rute REALE, confruntate cu `app.get`-urile din src/ de o poarta din test/run/porti.js:
 *  un link mort pe ecranul principal de sarcini ar fi mai rau decat lipsa lui. Atentie la parametru
 *  — majoritatea rutelor iau `period`, dar D101 si XML-ul de bilant iau `year`. */
const DESCARCARI = {
  d300: (p) => [{ label: 'Recap PDF', href: '/pdf/d300?period=' + p }, { label: 'XML ANAF', href: '/xml/d300?period=' + p }],
  d301: (p) => [{ label: 'XML ANAF', href: '/xml/d301?period=' + p }],
  d307: (p) => [{ label: 'XML ANAF', href: '/xml/d307?period=' + p }],
  d311: (p) => [{ label: 'XML ANAF', href: '/xml/d311?period=' + p }],
  d394: (p) => [{ label: 'Recap PDF', href: '/pdf/d394?period=' + p }, { label: 'XML ANAF', href: '/xml/d394?period=' + p }],
  d112: (p) => [{ label: 'Recap PDF', href: '/pdf/d112?period=' + p }, { label: 'XML ANAF', href: '/xml/d112?period=' + p }],
  d390: (p) => [{ label: 'XML ANAF', href: '/xml/d390?period=' + p }],
  d100: (p) => [{ label: 'Recap PDF', href: '/pdf/d100?period=' + p }, { label: 'XML ANAF', href: '/xml/d100?period=' + p }],
  d101: (p) => [{ label: 'XML ANAF', href: '/xml/d101?year=' + p.slice(0, 4) }],
  d107: (p) => [{ label: 'XML ANAF', href: '/xml/d107?year=' + p.slice(0, 4) }],
  d205: (p) => [{ label: 'XML ANAF', href: '/xml/d205?year=' + p.slice(0, 4) }],
  saft: (p) => [{ label: 'Recap PDF', href: '/pdf/saft?year=' + String(p).slice(0, 4) }, { label: 'XML ANAF', href: '/xml/saft?period=' + p }],
  intrastat: (p) => [{ label: 'Centralizator XML', href: '/xml/intrastat?period=' + p }],
  bilant: (p) => [{ label: 'PDF', href: '/pdf/bilant?period=' + p }, { label: 'XML ANAF', href: '/xml/bilant?year=' + p.slice(0, 4) }],
};
/** Linkurile de descarcare ale unei declaratii, pe perioada. Tip necunoscut -> lista goala
 *  (randurile manuale din registru pot purta un tip pe care nu-l generam noi). */
function descarcari(tip, period) { return (DESCARCARI[tip] || (() => []))(period); }

/** Fotografia minima a unui D100 exact asa cum a fost depus. D710 nu poate reconstrui valoarea
 *  initiala din contabilitatea de ACUM — corectia a schimbat tocmai acele date — asa ca pastram
 *  suma, creanta si termenul impreuna cu depunerea. Valorile sunt deliberat simple/serializabile. */
function d100Snapshot(r) {
  if (!r || !Number.isFinite(Number(r.impozit))) return null;
  return {
    impozit: Number(r.impozit), codOblig: String(r.codOblig || ''),
    codBugetar: String(r.codBugetar || ''), scadenta: String(r.scadenta || ''),
    cota: Number(r.cota) || 0,
  };
}

/** Linkurile unui rand din registru. D710 apare numai dupa o prima depunere D100: inainte de ea
 *  nu exista valori initiale de rectificat, iar un buton permanent ar duce inevitabil la eroare. */
function descarcariPentru(rec, tip, period) {
  const out = descarcari(tip, period);
  if (tip === 'd100' && lastSubmission(rec)) {
    out.push({ label: 'D710 rectificare', href: '/xml/d710?period=' + period });
  }
  return out;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m = 1-12

/** Termenul de depunere pentru declaratia `tip` aferenta lunii `period` (YYYY-MM).
 *  `profile` (optional) = profilul fiscal al firmei; conteaza pentru un singur caz, dar unul real:
 *  plata anticipata a TRIMESTRULUI IV la sistemul anual de impozit pe profit (art. 41 alin. (8))
 *  se declara si se plateste pana pe 25 DECEMBRIE — in aceeasi luna cu perioada, nu in urmatoarea.
 *  E singurul termen din aplicatie care nu cade in luna de dupa perioada; fara profil, regula
 *  generala l-ar fi impins pe 25 ianuarie, adica o luna DUPA ce firma era deja in intarziere. */
function dueDate(tip, period, profile) {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  if (tip === 'saft') {
    // D406: ultima zi calendaristica a lunii urmatoare perioadei raportate (fara gratie din 2026)
    return roCalendar.adjustFiscalDeadline(ny + '-' + pad2(nm) + '-' + pad2(lastDayOfMonth(ny, nm)));
  }
  // Intrastat: pana pe 15 ale lunii urmatoare (termen INS)
  if (tip === 'intrastat') return roCalendar.adjustFiscalDeadline(ny + '-' + pad2(nm) + '-15');
  // D101: pentru anii acoperiti de produs termenul este 25 iunie al anului urmator.
  // Pastreaza regula istorica de 25 martie numai pentru exercitiile <= 2020.
  if (tip === 'd101') return roCalendar.adjustFiscalDeadline((y + 1) + (y >= 2021 ? '-06-25' : '-03-25'));
  // D107 urmeaza termenul declaratiei anuale de impozit pe profit.
  if (tip === 'd107') return roCalendar.adjustFiscalDeadline((y + 1) + '-06-25');
  // D394: 30 ale lunii urmatoare; pentru ianuarie, ultima zi din februarie.
  if (tip === 'd394') {
    const day = m === 1 ? lastDayOfMonth(ny, nm) : 30;
    return roCalendar.adjustFiscalDeadline(ny + '-' + pad2(nm) + '-' + pad2(day));
  }
  // D205: ultima zi din februarie a anului urmator, ajustata la zi lucratoare.
  if (tip === 'd205') {
    return roCalendar.adjustFiscalDeadline((y + 1) + '-02-' + pad2(lastDayOfMonth(y + 1, 2)));
  }
  // D100 — plata anticipata a trimestrului IV, sistem anual (art. 41 alin. (8)): 25 decembrie,
  // ACELASI an. Nu se aplica ramurii de exceptie a alin. (7), care declara doar trimestrele I-III.
  if (tip === 'd100' && m === 12 && profile && profile.profitAnticipat && !profile.anticipatProfitContabil) {
    return roCalendar.adjustFiscalDeadline(y + '-12-25');
  }
  // Situatiile financiare anuale: 31 MAI anul urmator, pentru societati (art. 36 alin. 1 din
  // Legea contabilitatii 82/1991 — 150 de zile de la incheierea exercitiului financiar).
  if (tip === 'bilant') return roCalendar.adjustFiscalDeadline((y + 1) + '-05-31');
  // restul: 25 ale lunii urmatoare
  return roCalendar.adjustFiscalDeadline(ny + '-' + pad2(nm) + '-25');
}

/**
 * Declaratiile asteptate pentru o firma (vedere scoped) in luna `period`.
 * SAF-T (D406): LUNAR pentru platitorii de TVA (perioada fiscala lunara) si TRIMESTRIAL
 * pentru neplatitori / perioada trimestriala — regimul din 2025 pentru toti contribuabilii.
 * Firmele cu alt regim marcheaza lunile in plus drept „scutite" in registru.
 */
// BUNURILE si SERVICIILE se separa fiindca declanseaza declaratii DIFERITE: amandoua cer D390, dar
// numai bunurile intra in Intrastat — statistica INS e despre marfa care trece fizic frontiera, nu
// despre servicii. Cu o singura multime, o firma care cumpara doar reclama din UE ar fi fost
// anuntata ca datoreaza Intrastat.
const INTRACOM_SERVICII = new Set(['prestare_servicii_intracomunitara', 'achizitie_servicii_intracomunitara']);
/** Articolul e o operatiune intracomunitara cu BUNURI? (D390 + Intrastat). Autofactura (art. 320)
 *  doar cand natura marcata pe ea e chiar achizitia de bunuri — celelalte doua situatii pe care le
 *  acopera dau aceleasi conturi, dar nu aceeasi declaratie. */
function esteIntracomBunuri(e) {
  return !!intrastat.flux(e);
}
/** Articolul e o operatiune intracomunitara cu SERVICII? (doar D390, art. 325). */
function esteIntracomServicii(e) {
  if (e && e.tip === 'autofactura_achizitie') return e.naturaAutofactura === 'servicii';
  if (e && e.tip === d301.TIP_DOCUMENT) return Number(e.d301 && e.d301.tipOperatie) === 5;
  return INTRACOM_SERVICII.has(e && e.tip);
}

function expectedForFirma(v, period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return [];
  // Sursa UNICA: profilul fiscal al firmei deriva lista (nu boolean-uri citite inline aici).
  const profile = fiscalProfile.profileAt(v || {}, period, { angajati: (v || {}).angajati });
  const inLuna = (e, per) => String(e.period || e.data || '').slice(0, 7) === per;
  // D301 produce D390 numai pentru persoana care are cod special art. 317. Sectiunile 2/3/4 pot
  // fi depuse si fara acel cod; a genera automat D390 in acele cazuri ar inventa o obligatie.
  const eligibilD390 = (e) => e.tip !== d301.TIP_DOCUMENT || profile.tvaArt317;
  const hasIntracom = (per) => postedEntries(v).some((e) => eligibilD390(e) && esteIntracomBunuri(e) && inLuna(e, per));
  // Intrastat nu depinde de eligibilitatea D390: o firma poate avea obligatie statistica distincta,
  // iar D301 1-3 tot descrie bunuri care au trecut fizic frontiera.
  const hasIntrastat = (per) => postedEntries(v).some((e) => esteIntracomBunuri(e) && inLuna(e, per));
  const hasIntracomServicii = (per) => postedEntries(v).some((e) => eligibilD390(e) && esteIntracomServicii(e) && inLuna(e, per));
  const hasD301 = (per) => postedEntries(v).some((e) => e.tip === d301.TIP_DOCUMENT && !e.stornat && inLuna(e, per));
  const hasD307 = (per) => postedEntries(v).some((e) => e.tip === d307.TIP_DOCUMENT && !e.stornat && inLuna(e, per));
  const hasD311 = (per) => postedEntries(v).some((e) => e.tip === d311.TIP_DOCUMENT && !e.stornat && inLuna(e, per));
  const hasD107 = (per) => d107.hasOperations(v, String(per).slice(0, 4));
  const hasD205 = (per) => d205.hasOperations(v, String(per).slice(0, 4));
  return fiscalProfile.expected(profile, period, hasIntracom, hasIntracomServicii, hasD301, hasD307, hasD311, hasD107, hasD205, hasIntrastat)
    .map((tip) => ({ tip, nume: (TIPURI[tip] || {}).nume || tip, period, due: dueDate(tip, period, profile) }));
}

// ── e-Factura: facturi emise netrimise in SPV (termen legal: 5 zile LUCRATOARE, OUG 89/2025) ──
//
// DOUA conditii, independente, si se greseau impreuna:
//   1. documentul e o factura pe care o EMITEM  -> `xml.isSendable` (steagul `eFactura` de pe tip);
//   2. beneficiarul e stabilit in ROMANIA       -> `xml.perimetruEFactura` != 'strain'.
// O livrare intracomunitara e o factura emisa perfect valabila, dar beneficiarul e in alt stat
// membru — deci nu are termen de 5 zile si nu e o restanta. Inainte, conditia 1 era o lista de
// cinci id-uri scrisa de mana, iar conditia 2 lipsea cu totul.
//
// B2C intra si el: din 1 ianuarie 2025 se raporteaza si facturile catre persoane fizice, cu acelasi
// termen. Filtrul de dinainte cerea un CUI de partener, deci le tacea pe TOATE — exact facturile
// unde lipsa codului e normala, nu o scapare de completare (persoana fizica nu e obligata sa-si dea
// CNP-ul; codul de 13 zerouri exista tocmai pentru asta). Nu se raporteaza bonurile fiscale, dar
// acelea nici nu sunt facturi si nu trec de conditia 1.

/** Data + n zile lucratoare (sambata/duminica sarite). Pastrat pentru compatibilitate. */
function addBusinessDays(dateStr, n) {
  return roCalendar.addWorkingDays(dateStr, n);
}
/** Data + n zile CALENDARISTICE. */
function addCalendarDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Facturile B2B emise (cu CUI de partener) care NU au fost trimise in SPV, din ultimele
 * `lookbackDays` zile. `due` = data emiterii + 5 zile LUCRATOARE (OUG 89/2025).
 */
function eFacturaNetrimise(v, today, lookbackDays) {
  const t = today || new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(t) - (lookbackDays || 60) * 86400000).toISOString().slice(0, 10);
  const items = [];
  for (const e of postedEntries(v)) {
    if (!xml.isSendable(e)) continue;
    // Beneficiar din alt stat: factura ramane valabila si trimisibila, dar nu are termen legal.
    if (xml.perimetruEFactura(e.partenerCui, (v.partners || {})[String(e.partenerCui || '').replace(/^ro/i, '')]) === 'strain') continue;
    if (e.spv && (e.spv.index || e.spv.stare)) continue; // deja trimisa
    if (!e.data || e.data < from || e.data > t) continue;
    const due = addBusinessDays(e.data, 5);
    items.push({ entryId: e.id, document: e.document || '', partener: e.partener || '', data: e.data, due, overdue: due < t });
  }
  items.sort((a, b) => a.due.localeCompare(b.due));
  return { count: items.length, overdue: items.filter((x) => x.overdue).length, items };
}

/** Gaseste inregistrarea (firmaId, tip, period) in colectia declarations. */
function find(d, firmaId, tip, period) {
  const matches = (d.declarations || []).filter((x) => String(x.firmaId) === String(firmaId)
    && String(x.tip || '').toLowerCase() === String(tip || '').toLowerCase()
    && x.period === period);
  if (matches.length > 1) {
    throw dossierError('Există mai multe dosare pentru aceeași firmă, declarație și perioadă; operațiunea a fost refuzată.', 'DUPLICATE_FILING_DOSSIER');
  }
  return matches[0];
}

function requireTransitionAuthorization(patch, action) {
  const auth = patch && patch.authorization;
  if (!auth || auth.authorized !== true || String(auth.action || '') !== action
      || (!auth.actorId && !String(auth.username || '').trim())) {
    const e = dossierError('Tranziția cere autorizarea explicită „' + action + '” și identitatea actorului.', 'FILING_TRANSITION_UNAUTHORIZED');
    e.status = 403; throw e;
  }
  return auth;
}

function receiptEvidencePublic(receipt, reference) {
  const evidence = {
    reference: String(reference || '').slice(0, 100), sha256: String(receipt && receipt.sha256 || ''),
    bytes: Number(receipt && receipt.bytes) || 0, filename: String(receipt && receipt.filename || '').slice(0, 180),
    mime: String(receipt && receipt.mime || '').slice(0, 100),
  };
  if (receipt && receipt.filingBinding) evidence.filingBinding = JSON.parse(JSON.stringify(receipt.filingBinding));
  if (receipt && receipt.receiptBindingHash) evidence.receiptBindingHash = String(receipt.receiptBindingHash);
  return evidence;
}

/**
 * Consemnează aprobarea umană a octeților exacți. Clientul trebuie să trimită hash-ul pe care
 * l-a afișat aprobatorului; serverul îl confruntă cu binarul păstrat și construiește singur dovada.
 * Retry-ul aceleiași aprobări este idempotent, iar aprobările anterioare nu se șterg niciodată.
 */
function approveDocument(d, firmaId, tip, period, info) {
  const rec = find(d, firmaId, tip, period);
  if (!rec) throw dossierError('Aprobarea cere un dosar și un document generat.', 'FILING_DOSSIER_REQUIRED');
  ensureDossier(rec, firmaId, tip, period); ensureStateLedger(rec, firmaId, tip, period);
  if (!['generata', 'aprobata', 'transmisa', 'depusa'].includes(String(rec.status || ''))) {
    throw dossierError('Documentul poate fi aprobat după generare și, pentru dosarele istorice/rectificative, înainte de confirmarea depunerii.', 'FILING_TRANSITION_NOT_ALLOWED');
  }
  const authorization = requireTransitionAuthorization(info || {}, 'declaration.approve');
  const expectedHash = String(info && info.artifactHash || '');
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || expectedHash !== String(rec.artifactHash || '')) {
    throw dossierError('Documentul afișat aprobatorului nu mai este versiunea curentă. Reîncarcă dosarul înainte de aprobare.', 'FILING_APPROVAL_ARTIFACT_MISMATCH');
  }
  const artifact = exactArtifact(rec, expectedHash);
  if (!artifact) throw dossierError('Aprobarea cere binarul exact al documentului verificat.', 'FILING_EVIDENCE_ARTIFACT_REQUIRED');
  const fiscalReview = info && info.fiscalReviewEvidence || {};
  if (fiscalReview.ready !== true || !/^[0-9a-f]{64}$/.test(String(fiscalReview.hash || ''))) {
    throw dossierError('Aprobarea documentului cere revizia fiscală externă validă.', 'FILING_EVIDENCE_FISCAL_REVIEW_REQUIRED');
  }
  if (currentApprovalMatches(rec, expectedHash)) return { rec, approval: rec.documentApproval, created: false };

  const at = String(info && info.at || new Date().toISOString());
  const previous = Array.isArray(rec.documentApprovals) && rec.documentApprovals.length
    ? rec.documentApprovals[rec.documentApprovals.length - 1] : null;
  const approval = {
    schemaVersion: 1, decision: 'approved', dossierId: rec.dossier.id, dossierKey: rec.dossier.key,
    artifactHash: artifact.sha256, artifactBytes: Number(artifact.bytes),
    filename: String(artifact.filename || '').slice(0, 180), mime: String(artifact.mime || '').slice(0, 100),
    approvedAt: at,
    approvedBy: publicAuthorization(authorization),
    note: String(info && info.note || '').trim().slice(0, 500),
    fiscalReviewHash: String(fiscalReview.hash),
    previousApprovalHash: previous ? String(previous.approvalHash || '') : null,
  };
  approval.approvalHash = documentApprovalHash(approval);
  const approvalIssues = documentApprovalIssues(approval);
  if (approvalIssues.length) throw dossierError('Dovada aprobării este invalidă: ' + approvalIssues.join('; '), 'FILING_EVIDENCE_APPROVAL_INVALID');

  const from = String(rec.status || 'generata'); const to = from === 'generata' ? 'aprobata' : from;
  const event = appendStateEvent(rec, firmaId, tip, period, {
    type: 'approval.recorded', from, to, at, authorization,
    evidence: {
      artifact: { sha256: artifact.sha256, bytes: artifact.bytes, filename: artifact.filename, mime: artifact.mime },
      approval: JSON.parse(JSON.stringify(approval)), fiscalReview: JSON.parse(JSON.stringify(fiscalReview)),
    },
  });
  rec.documentApprovals = Array.isArray(rec.documentApprovals) ? rec.documentApprovals : [];
  rec.documentApprovals.push(approval);
  rec.documentApproval = approval;
  if (from === 'transmisa' && !rec.transmittedArtifactHash) {
    // Compatibilitate onestă pentru o transmisie v1: aprobarea are loc acum, nu este antedatată.
    rec.transmittedArtifactHash = approval.artifactHash;
    rec.transmittedApprovalHash = approval.approvalHash;
    rec.transmittedArtifactHashSource = 'legacy-approved-after-transmission';
  }
  rec.approvedAt = at; rec.approvedBy = String(authorization.username || authorization.actorId || '').slice(0, 80);
  if (to !== from) {
    rec.statusHistory = Array.isArray(rec.statusHistory) ? rec.statusHistory : [];
    rec.statusHistory.push({ from, to, at, by: rec.approvedBy, note: approval.note,
      artifactHash: artifact.sha256, profileHash: String(rec.profileHash || ''), approvalHash: approval.approvalHash,
      eventHash: event.hash });
  }
  rec.status = to; rec.updatedAt = at;
  return { rec, approval, created: true };
}

function validationForArtifact(rec, artifactHash) {
  const artifact = exactArtifact(rec, artifactHash);
  if (!artifact) return null;
  const rulesHash = String(artifact.fiscalRulesHash || rec && rec.fiscalRulesHash || '');
  const rows = rec && Array.isArray(rec.officialValidations) ? rec.officialValidations : [];
  return rows.slice().reverse().find((proof) => require('./officialArtifactValidation')
    .issues(proof, artifact, rulesHash).length === 0) || null;
}

/** Consemnează rezultatul adaptorului DUK/schema pe artefactul exact păstrat în dosar. */
function recordOfficialValidation(d, firmaId, tip, period, info) {
  const rec = find(d, firmaId, tip, period);
  if (!rec) throw dossierError('Validarea cere un dosar și un XML generat.', 'FILING_DOSSIER_REQUIRED');
  ensureDossier(rec, firmaId, tip, period); ensureStateLedger(rec, firmaId, tip, period);
  const authorization = requireTransitionAuthorization(info || {}, 'declaration.validate');
  const artifactHash = String(info && info.artifactHash || '');
  if (artifactHash !== String(rec.artifactHash || '')) {
    throw dossierError('Validarea nu aparține versiunii curente a documentului.', 'OFFICIAL_VALIDATION_ARTIFACT_MISMATCH');
  }
  const artifact = exactArtifact(rec, artifactHash);
  if (!artifact) throw dossierError('Validarea cere octeții exacți ai documentului.', 'FILING_EVIDENCE_ARTIFACT_REQUIRED');
  const proof = require('./officialArtifactValidation').create(artifact, Object.assign({}, info, {
    declarationType: tip, fiscalRulesHash: artifact.fiscalRulesHash || rec.fiscalRulesHash,
    ruleSetId: artifact.ruleSetId || rec.ruleSetId,
  }), authorization);
  rec.officialValidations = Array.isArray(rec.officialValidations) ? rec.officialValidations : [];
  const existing = rec.officialValidations.find((row) => row.proofHash === proof.proofHash);
  if (existing) return { rec, validation: existing, created: false };
  appendStateEvent(rec, firmaId, tip, period, {
    type: 'official-validation.recorded', from: rec.status, to: rec.status,
    at: proof.validatedAt, authorization,
    evidence: {
      artifact: { sha256: artifact.sha256, bytes: artifact.bytes, filename: artifact.filename, mime: artifact.mime },
      fiscalRulesHash: proof.fiscalRulesHash, officialValidation: JSON.parse(JSON.stringify(proof)),
    },
  });
  rec.officialValidations.push(proof); rec.officialValidation = proof;
  rec.updatedAt = proof.validatedAt;
  return { rec, validation: proof, created: true };
}

function assertTransition(rec, from, to, patch, prospectiveArtifact) {
  if (from === to) return null;
  if (from === 'generata' && to === 'transmisa') {
    throw dossierError('Transmiterea este blocată până când un aprobator confirmă SHA-256 al documentului exact.', 'FILING_EVIDENCE_APPROVAL_REQUIRED');
  }
  if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].has(to)) {
    throw dossierError('Tranziția ' + from + ' → ' + to + ' nu este permisă. Istoricul nu poate fi rescris sau sărit.', 'FILING_TRANSITION_NOT_ALLOWED');
  }
  const p = patch || {};
  if (to === 'aprobata') {
    throw dossierError('Starea „aprobată” se creează numai prin aprobarea hash-ului exact al documentului.', 'FILING_EVIDENCE_APPROVAL_REQUIRED');
  }
  if (to === 'generata') {
    requireTransitionAuthorization(p, 'declaration.prepare');
    const artifact = prospectiveArtifact || exactArtifact(rec, rec && rec.artifactHash);
    if (!artifact || !exactContent(artifact)) throw dossierError('Starea „generată” cere binarul exact al documentului.', 'FILING_EVIDENCE_ARTIFACT_REQUIRED');
    const profileHash = String((artifact && artifact.profileHash) || (rec && rec.profileHash) || '');
    if (!/^[0-9a-f]{64}$/.test(profileHash)) throw dossierError('Starea „generată” cere fotografia profilului fiscal și hash-ul ei.', 'FILING_EVIDENCE_PROFILE_REQUIRED');
  }
  if (to === 'transmisa') {
    requireTransitionAuthorization(p, 'declaration.submit');
    const approval = p.documentApproval || (rec && rec.documentApproval) || {};
    const approvedHash = String(approval.artifactHash || '');
    if (!currentApprovalMatches(rec, approvedHash)
        || approval.approvalHash !== (rec.documentApproval && rec.documentApproval.approvalHash)) {
      throw dossierError('Transmiterea cere aprobarea documentului exact selectat, pe același SHA-256.', 'FILING_EVIDENCE_APPROVAL_REQUIRED');
    }
    if (!exactArtifact(rec, approvedHash)) throw dossierError('Transmiterea cere binarul exact al artefactului aprobat.', 'FILING_EVIDENCE_ARTIFACT_REQUIRED');
    if (!validationForArtifact(rec, approvedHash)) {
      throw dossierError('Transmiterea cere rezultatul valid al validatorului oficial pentru XML-ul exact aprobat.', 'OFFICIAL_VALIDATION_REQUIRED');
    }
  }
  if (to === 'depusa') {
    requireTransitionAuthorization(p, 'declaration.submit');
    const transmittedHash = transmittedArtifactHashOf(rec);
    const approval = approvalForArtifact(rec, transmittedHash);
    if (!exactArtifact(rec, transmittedHash)) throw dossierError('Depunerea cere binarul exact sigilat la transmitere.', 'FILING_EVIDENCE_ARTIFACT_REQUIRED');
    if (!approval || (rec.transmittedApprovalHash
      && approval.approvalHash !== rec.transmittedApprovalHash)) {
      throw dossierError('Depunerea cere aceeași versiune de document care a fost aprobată.', 'FILING_APPROVAL_ARTIFACT_MISMATCH');
    }
    if (String(p.recipisa || '').trim().length < 2 || !p.receiptEvidence || !exactContent(p.receiptEvidence)) {
      throw dossierError('Starea „depusă” cere atomic numărul și fișierul exact al recipisei.', 'FILING_EVIDENCE_RECEIPT_REQUIRED');
    }
  }
  if (to === 'eroare' || to === 'scutita') {
    requireTransitionAuthorization(p, 'declaration.submit');
    if (String(p.note || '').trim().length < 3) throw dossierError('Starea „' + to + '” cere o explicație verificabilă.', 'FILING_EVIDENCE_NOTE_REQUIRED');
  }
  return true;
}

/**
 * Upsert pe (firmaId, tip, period). `patch.status='generata'` NU retrogradeaza o depunere
 * deja marcata (depusa/scutita) — descarcarea repetata a XML-ului nu strica registrul.
 */
function record(d, firmaId, tip, period, patch, nextIdFn) {
  if (!TIPURI[tip] || !/^\d{4}-\d{2}$/.test(String(period || ''))) return null;
  d.declarations = d.declarations || [];
  let rec = find(d, firmaId, tip, period);
  const now = new Date().toISOString();
  let created = false;
  if (!rec) {
    rec = { id: nextIdFn('dcl'), firmaId, tip, period, status: 'nedepusa', generatedAt: null, transmittedAt: null, submittedAt: null, recipisa: '', note: '', artifacts: [], statusHistory: [] };
    ensureDossier(rec, firmaId, tip, period, now);
    ensureStateLedger(rec, firmaId, tip, period, { created: true, at: now });
    created = true;
  } else {
    ensureDossier(rec, firmaId, tip, period);
    ensureStateLedger(rec, firmaId, tip, period);
  }
  const p = patch || {};
  const temporalRef = (p.ruleSetId && p.fiscalRulesHash)
    ? { ruleSetId: String(p.ruleSetId), fiscalRulesHash: String(p.fiscalRulesHash) }
    : fiscal.ruleReferenceAt(period, { allowUncovered: true });
  if (!rec.ruleSetId) rec.ruleSetId = temporalRef.ruleSetId;
  if (!rec.fiscalRulesHash) rec.fiscalRulesHash = temporalRef.fiscalRulesHash;
  const oldStatus = rec.status || 'nedepusa';
  const oldNote = String(rec.note || ''); const oldRecipisa = String(rec.recipisa || '');
  const sameApprovedArtifact = oldStatus === 'aprobata' && p.artifact && p.artifact.sha256
    && String(p.artifact.sha256) === String(rec.artifactHash || '');
  const keep = p.status === 'generata' && (sameApprovedArtifact
    || oldStatus === 'transmisa' || oldStatus === 'depusa' || oldStatus === 'scutita');
  const targetStatus = p.status && STATUSES.includes(p.status) && !keep ? p.status : oldStatus;
  let preparedArtifact = null;
  if (p.artifact && p.artifact.sha256) {
    preparedArtifact = {
      sha256: String(p.artifact.sha256), bytes: Number(p.artifact.bytes) || 0,
      filename: String(p.artifact.filename || '').slice(0, 160),
      mime: String(p.artifact.mime || 'application/xml').slice(0, 80),
      kind: String(p.artifact.kind || 'generated').slice(0, 40),
      source: String(p.artifact.source || 'generator-aplicatie').slice(0, 80),
      generatedAt: p.artifact.generatedAt || p.generatedAt || new Date().toISOString(),
      by: String(p.artifact.by || p.updatedBy || '').slice(0, 80),
      profileSnapshot: p.artifact.profileSnapshot && p.artifact.profileSnapshot.hash
        ? JSON.parse(JSON.stringify(p.artifact.profileSnapshot)) : (p.profileSnapshot || rec.profileSnapshot || null),
      profileHash: String((p.artifact.profileSnapshot && p.artifact.profileSnapshot.hash)
        || (p.profileSnapshot && p.profileSnapshot.hash) || rec.profileHash || ''),
      profileProvenanceHash: String((p.artifact.profileSnapshot && p.artifact.profileSnapshot.provenanceHash)
        || (p.profileSnapshot && p.profileSnapshot.provenanceHash) || rec.profileProvenanceHash || ''),
      balanceCategorySnapshot: p.artifact.balanceCategorySnapshot
        ? JSON.parse(JSON.stringify(p.artifact.balanceCategorySnapshot)) : null,
      balanceControlSnapshot: p.artifact.balanceControlSnapshot
        ? JSON.parse(JSON.stringify(p.artifact.balanceControlSnapshot)) : null,
      ruleSetId: String(p.artifact.ruleSetId || p.ruleSetId || rec.ruleSetId || ''),
      fiscalRulesHash: String(p.artifact.fiscalRulesHash || p.fiscalRulesHash || rec.fiscalRulesHash || ''),
    };
    if (p.artifact.contentBase64) {
      const bytes = Buffer.from(String(p.artifact.contentBase64), 'base64');
      const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== preparedArtifact.sha256 || bytes.length !== preparedArtifact.bytes) {
        const e = new Error('Binarul declarației nu coincide cu SHA-256/dimensiunea declarată.'); e.status = 400; throw e;
      }
      preparedArtifact.contentBase64 = bytes.toString('base64');
    }
  }
  if (preparedArtifact && !exactContent(preparedArtifact)) throw dossierError('Generarea cere conținutul binar exact, nu numai metadate.', 'FILING_EVIDENCE_ARTIFACT_REQUIRED');
  assertTransition(rec, oldStatus, targetStatus, p, preparedArtifact);
  if (preparedArtifact && targetStatus === oldStatus) requireTransitionAuthorization(p, 'declaration.prepare');
  if (targetStatus === oldStatus && (p.note != null || p.recipisa != null)) {
    requireTransitionAuthorization(p, targetStatus === 'generata' ? 'declaration.prepare' : 'declaration.submit');
  }

  if (p.generatedAt) rec.generatedAt = p.generatedAt;
  if (targetStatus === 'transmisa' && targetStatus !== oldStatus) {
    const approval = p.documentApproval || rec.documentApproval;
    rec.transmittedArtifactHash = String(approval && approval.artifactHash || '');
    rec.transmittedApprovalHash = String(approval && approval.approvalHash || '');
    rec.transmittedArtifactHashSource = 'document-approval';
    rec.transmittedValidationHash = String((validationForArtifact(rec, rec.transmittedArtifactHash) || {}).proofHash || '');
    rec.transmittedAt = p.transmittedAt || now;
  }
  if (targetStatus === 'depusa' && targetStatus !== oldStatus) rec.submittedAt = p.submittedAt || now;
  if (p.recipisa != null) rec.recipisa = String(p.recipisa).slice(0, 100);
  if (p.note != null) rec.note = String(p.note).slice(0, 300);
  if (p.updatedBy) rec.updatedBy = p.updatedBy;
  if (p.profileSnapshot && p.profileSnapshot.hash) {
    rec.profileSnapshot = JSON.parse(JSON.stringify(p.profileSnapshot));
    rec.profileHash = String(p.profileSnapshot.hash);
    rec.profileProvenanceHash = String(p.profileSnapshot.provenanceHash || '');
  }
  if (p.ruleSetId && p.fiscalRulesHash) {
    rec.ruleSetId = String(p.ruleSetId); rec.fiscalRulesHash = String(p.fiscalRulesHash);
  }
  if (p.balanceControlSnapshot) {
    rec.balanceControlSnapshot = JSON.parse(JSON.stringify(p.balanceControlSnapshot));
  }
  let artifactChanged = false;
  if (preparedArtifact) {
    rec.artifacts = Array.isArray(rec.artifacts) ? rec.artifacts : [];
    // Redescarcarea aceluiasi continut nu dubleaza istoricul. Instalarile vechi pastrau numai
    // hash-ul: aceeasi descarcare poate completa binarul lipsa, fara sa schimbe identitatea.
    const existing = rec.artifacts.find((x) => x.sha256 === preparedArtifact.sha256
      && String(x.profileHash || '') === preparedArtifact.profileHash);
    artifactChanged = !existing || (!existing.contentBase64 && !!preparedArtifact.contentBase64);
    if (!existing) rec.artifacts.push(preparedArtifact); else Object.assign(existing, preparedArtifact);
    // După transmitere, selecția transmisă rămâne fixă până la recipisă. O regenerare poate fi
    // arhivată, dar nu are voie să mute proiecția pe alți octeți și să rupă legătura cu aprobarea.
    if (!(oldStatus === 'transmisa' && targetStatus === oldStatus)) {
      rec.artifactHash = preparedArtifact.sha256; rec.artifactBytes = preparedArtifact.bytes;
      rec.artifactFilename = preparedArtifact.filename;
      rec.officialValidation = validationForArtifact(rec, preparedArtifact.sha256);
    }
  }
  rec.statusHistory = Array.isArray(rec.statusHistory) ? rec.statusHistory : [];
  let stateEvent = null;
  const evidenceChanged = (p.note != null && String(p.note).slice(0, 300) !== oldNote)
    || (p.recipisa != null && String(p.recipisa).slice(0, 100) !== oldRecipisa);
  if (targetStatus !== oldStatus || artifactChanged || evidenceChanged) {
    const stateChangedToFiling = targetStatus !== oldStatus
      && (targetStatus === 'transmisa' || targetStatus === 'depusa');
    const filingHash = targetStatus === 'transmisa'
      ? String(rec.transmittedArtifactHash || '') : transmittedArtifactHashOf(rec);
    const artifact = stateChangedToFiling
      ? exactArtifact(rec, filingHash) : (preparedArtifact || exactArtifact(rec, rec.artifactHash));
    let filingSubmission = null; let filingReceipt = p.receiptEvidence || null;
    if (stateChangedToFiling && targetStatus === 'depusa' && filingReceipt) {
      const approval = approvalForArtifact(rec, filingHash) || p.documentApproval || rec.documentApproval || {};
      const preview = {
        ordinal: (Array.isArray(rec.depuneri) ? rec.depuneri.length : 0) + 1,
        rectificativa: (Array.isArray(rec.depuneri) ? rec.depuneri.length : 0) > 0,
        artifactHash: filingHash, submittedArtifactHash: filingHash,
        documentApprovalHash: String(approval.approvalHash || ''), recipisa: String(p.recipisa || ''),
      };
      filingSubmission = submissionEvidence(rec, preview);
      filingReceipt = bindReceiptToSubmission(rec, preview, filingReceipt);
    }
    const eventEvidence = {
      artifact: artifact ? { sha256: artifact.sha256, bytes: artifact.bytes, filename: artifact.filename, mime: artifact.mime } : null,
      profileHash: String(rec.profileHash || ''), note: String(p.note || '').slice(0, 300),
      profileProvenanceHash: String(rec.profileProvenanceHash || ''),
      balanceControlHash: p.balanceControlSnapshot
        ? crypto.createHash('sha256').update(JSON.stringify(p.balanceControlSnapshot)).digest('hex') : '',
      ruleSetId: String(rec.ruleSetId || ''), fiscalRulesHash: String(rec.fiscalRulesHash || ''),
      previousNoteHash: oldNote ? crypto.createHash('sha256').update(oldNote).digest('hex') : '',
      previousReceiptHash: oldRecipisa ? crypto.createHash('sha256').update(oldRecipisa).digest('hex') : '',
      approval: (p.documentApproval || ((targetStatus === 'transmisa' || targetStatus === 'depusa')
        ? rec.documentApproval : null))
        ? JSON.parse(JSON.stringify(p.documentApproval || rec.documentApproval)) : null,
      fiscalReview: p.fiscalReviewEvidence ? JSON.parse(JSON.stringify(p.fiscalReviewEvidence)) : null,
      officialValidation: stateChangedToFiling
        ? JSON.parse(JSON.stringify(validationForArtifact(rec, filingHash) || null)) : null,
      submission: filingSubmission,
      receipt: filingReceipt ? receiptEvidencePublic(filingReceipt, p.recipisa) : null,
    };
    stateEvent = appendStateEvent(rec, firmaId, tip, period, {
      type: artifactChanged ? 'artifact.generated' : (targetStatus !== oldStatus ? ('status.' + targetStatus) : 'status.evidence-updated'),
      from: oldStatus, to: targetStatus, at: now, authorization: p.authorization, evidence: eventEvidence,
    });
  }
  if (oldStatus === 'aprobata' && targetStatus === 'generata') {
    // Proiecția aprobării curente se invalidează, dar documentApprovals[] și evenimentul aprobat
    // rămân intacte: se poate demonstra exact ce versiune fusese aprobată înainte de regenerare.
    rec.documentApproval = null; rec.approvedAt = null; rec.approvedBy = '';
  }
  rec.status = targetStatus;
  if (rec.status !== oldStatus) rec.statusHistory.push({
    from: oldStatus, to: rec.status, at: now, by: String(p.updatedBy || '').slice(0, 80),
    note: String(p.note || '').slice(0, 300), recipisa: String(p.recipisa || '').slice(0, 100),
    artifactHash: String((rec.status === 'transmisa' || rec.status === 'depusa')
      ? transmittedArtifactHashOf(rec) : ((p.artifact && p.artifact.sha256) || rec.artifactHash || '')),
    profileHash: String((p.profileSnapshot && p.profileSnapshot.hash) || rec.profileHash || ''),
    approvalHash: String((rec.documentApproval && rec.documentApproval.approvalHash) || ''),
    eventHash: stateEvent && stateEvent.hash || '',
  });
  if (created) d.declarations.push(rec);
  rec.updatedAt = now;
  return rec;
}

function publicArtifacts(list) {
  return (list || []).map((artifact) => {
    const out = Object.assign({}, artifact, { contentStored: !!artifact.contentBase64 });
    delete out.contentBase64; return out;
  });
}

function publicSubmissions(list) {
  return (list || []).map((submission) => {
    const out = Object.assign({}, submission);
    out.receipts = (submission.receipts || []).map((receipt) => {
      const r = Object.assign({}, receipt, { contentStored: !!receipt.contentBase64 });
      delete r.contentBase64; return r;
    });
    return out;
  });
}

/** Verifică și întoarce octeții unui blob arhivat (artefact sau recipisă). */
function exactContent(blob) {
  if (!blob || !blob.contentBase64) return null;
  try {
    const bytes = Buffer.from(String(blob.contentBase64), 'base64');
    if (bytes.length !== Number(blob.bytes)) return null;
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== String(blob.sha256 || '')) return null;
    return bytes;
  } catch (_) { return null; }
}

/** Artefactul există cu octeții exacți, iar SHA-256 și dimensiunea se recalculează corect. */
function exactArtifact(rec, hash) {
  const artifact = (rec && Array.isArray(rec.artifacts) ? rec.artifacts : [])
    .find((x) => String(x.sha256 || '') === String(hash || ''));
  return exactContent(artifact) ? artifact : null;
}

/** Verificarea structurală a unui dosar. `valid=false` înseamnă contradicție/corupție; lipsa unui
 *  binar istoric este raportată separat prin `complete=false`, fără a pretinde că dovada există. */
function verifyDossier(rec, firmaId, tip, period, opts) {
  const verifyContent = !opts || opts.verifyContent !== false;
  const identity = dossierIdentity(firmaId, tip, period);
  const issues = []; const missing = [];
  if (!rec) return { valid: true, complete: false, contentVerified: verifyContent, state: 'nematerializat', issues, missing: ['dosarul nu are încă evenimente persistente'] };
  if (String(rec.firmaId) !== String(firmaId) || String(rec.tip || '').toLowerCase() !== identity.tip || rec.period !== period) {
    issues.push('rândul persistent are altă identitate declarativă');
  }
  if (rec.dossier && (Number(rec.dossier.schemaVersion) !== DOSSIER_SCHEMA_VERSION
      || String(rec.dossier.id || '') !== identity.id || String(rec.dossier.key || '') !== identity.key
      || String(rec.dossier.firmaId) !== String(identity.firmaId)
      || String(rec.dossier.tip || '').toLowerCase() !== identity.tip
      || String(rec.dossier.period || '') !== identity.period)) {
    issues.push('identitatea sigilată a dosarului nu coincide cu cheia declarativă');
  }
  const ledger = verifyStateLedger(rec, firmaId, tip, period);
  if (!ledger.valid) issues.push(...ledger.issues.map((x) => 'lanț stări: ' + x));
  const artifacts = Array.isArray(rec.artifacts) ? rec.artifacts : [];
  const artifactsByHash = new Map();
  for (const artifact of artifacts) {
    const hash = String(artifact && artifact.sha256 || '');
    artifactsByHash.set(hash, artifact);
    if (verifyContent && artifact && artifact.contentBase64 && !exactContent(artifact)) issues.push('artefact corupt ' + hash);
  }
  for (const proof of (Array.isArray(rec.officialValidations) ? rec.officialValidations : [])) {
    const artifact = artifactsByHash.get(String(proof && proof.artifactHash || ''));
    if (!artifact) {
      missing.push('artefactul validării oficiale ' + String(proof && proof.proofHash || '').slice(0, 12));
      continue;
    }
    const validationIssues = require('./officialArtifactValidation').integrityIssues(proof, artifact,
      String(artifact.fiscalRulesHash || rec.fiscalRulesHash || ''));
    if (validationIssues.length) issues.push(...validationIssues.map((issue) => 'validare oficială: ' + issue));
  }
  let previousApprovalHash = null;
  for (const approval of (Array.isArray(rec.documentApprovals) ? rec.documentApprovals : [])) {
    const approvalIssues = documentApprovalIssues(approval);
    if (approvalIssues.length) issues.push(...approvalIssues.map((x) => 'aprobare document: ' + x));
    if (String(approval.dossierId || '') !== identity.id || String(approval.dossierKey || '') !== identity.key) {
      issues.push('aprobarea documentului aparține altui dosar');
    }
    if ((approval.previousApprovalHash || null) !== previousApprovalHash) issues.push('lanțul aprobărilor documentului este discontinuu');
    const approvedArtifact = artifactsByHash.get(String(approval.artifactHash || ''));
    if (!approvedArtifact || !approvedArtifact.contentBase64
        || Number(approvedArtifact.bytes) !== Number(approval.artifactBytes)) {
      missing.push('documentul exact al aprobării ' + String(approval.approvalHash || '').slice(0, 12));
    } else if (verifyContent && approvedArtifact.contentBase64 && !exactContent(approvedArtifact)) {
      issues.push('documentul unei aprobări este corupt');
    }
    previousApprovalHash = String(approval.approvalHash || '');
  }
  if (rec.documentApproval && documentApprovalIssues(rec.documentApproval).length) {
    issues.push('proiecția aprobării curente este invalidă');
  }
  if (rec.status === 'aprobata' && !approvedArtifactHashOf(rec)) {
    issues.push('starea aprobată nu mai indică o aprobare validă');
  }
  if (rec.transmittedArtifactHash) {
    const transmittedHash = transmittedArtifactHashOf(rec);
    const transmittedApproval = approvalForArtifact(rec, transmittedHash);
    if (!exactArtifact(rec, transmittedHash)) missing.push('binarul exact sigilat la transmitere');
    if (!transmittedApproval || (rec.transmittedApprovalHash
        && transmittedApproval.approvalHash !== rec.transmittedApprovalHash)) {
      issues.push('selecția transmisă nu coincide cu artefactul aprobat');
    }
    const transmittedValidation = validationForArtifact(rec, transmittedHash);
    if (rec.transmittedValidationHash && (!transmittedValidation
        || transmittedValidation.proofHash !== rec.transmittedValidationHash)) {
      issues.push('selecția transmisă nu coincide cu validarea oficială exactă');
    }
  }
  const ordinals = new Set();
  for (const submission of (Array.isArray(rec.depuneri) ? rec.depuneri : [])) {
    const ordinal = Number(submission && submission.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinals.has(ordinal)) issues.push('ordinal de depunere invalid sau duplicat');
    ordinals.add(ordinal);
    const submittedHash = String((submission && (submission.submittedArtifactHash || submission.artifactHash)) || '');
    const submitted = artifactsByHash.get(submittedHash);
    if (!submitted || !submitted.contentBase64 || (verifyContent && !exactContent(submitted))) missing.push('binarul depunerii #' + ordinal);
    if (submission && submission.documentApproval) {
      const approvalIssues = documentApprovalIssues(submission.documentApproval);
      if (approvalIssues.length) issues.push('aprobarea depunerii #' + ordinal + ' este invalidă');
      if (String(submission.approvedArtifactHash || '') !== String(submission.documentApproval.artifactHash || '')
          || String(submission.documentApprovalHash || '') !== String(submission.documentApproval.approvalHash || '')) {
        issues.push('legătura aprobării depunerii #' + ordinal + ' este inconsistentă');
      }
    }
    const hasSubmissionBinding = Number(submission && submission.schemaVersion) === SUBMISSION_SCHEMA_VERSION
      || !!(submission && (submission.submissionId || submission.submissionHash));
    const submissionProof = hasSubmissionBinding ? submissionEvidence(rec, submission) : null;
    if (hasSubmissionBinding) {
      const bindingIssues = submissionEvidenceIssues(submissionProof, identity.id, identity.key);
      if (Number(submission.schemaVersion) !== SUBMISSION_SCHEMA_VERSION) {
        bindingIssues.push('versiunea proiecției depunerii este invalidă');
      }
      if (submission.submissionId !== submissionProof.submissionId
          || submission.submissionHash !== submissionProof.submissionHash) {
        bindingIssues.push('proiecția hash-ului depunerii nu coincide cu conținutul ei');
      }
      for (const historical of (submission.submissionBindingHistory || [])) {
        const historicalProof = historical && historical.submission;
        const historicalIssues = submissionEvidenceIssues(historicalProof, identity.id, identity.key);
        const correctionEvent = (rec.stateEvents || []).find((event) => event.type === 'submitted-artifact.corrected'
          && Number((event.evidence || {}).ordinal) === ordinal
          && String((event.evidence || {}).previousSubmissionHash || '') === String(historicalProof && historicalProof.submissionHash || ''));
        if (!correctionEvent) historicalIssues.push('resigilarea istorică nu are eveniment append-only');
        if (historicalIssues.length) bindingIssues.push(...historicalIssues.map((x) => 'istoric: ' + x));
      }
      if (bindingIssues.length) issues.push(...bindingIssues.map((x) => 'depunerea #' + ordinal + ': ' + x));
    }
    const receipts = Array.isArray(submission && submission.receipts) ? submission.receipts : [];
    if (submission && submission.recipisa && !receipts.length) missing.push('fișierul recipisei pentru depunerea #' + ordinal);
    for (const receipt of receipts) {
      if (verifyContent && receipt && receipt.contentBase64 && !exactContent(receipt)) issues.push('recipisă coruptă la depunerea #' + ordinal);
      else if (!receipt || !receipt.contentBase64) missing.push('binarul unei recipise la depunerea #' + ordinal);
      if (submissionProof) {
        const bindingIssues = receiptBindingIssues(receipt, submissionProof);
        for (const historical of (receipt && receipt.filingBindingHistory || [])) {
          const oldBinding = historical && historical.filingBinding;
          const oldProofRow = (submission.submissionBindingHistory || []).find((row) => row && row.submission
            && row.submission.submissionHash === (oldBinding && oldBinding.submissionHash));
          if (!oldProofRow || canonicalJson(oldBinding) !== canonicalJson(filingBindingFor(oldProofRow.submission))) {
            bindingIssues.push('istoricul recipisei nu indică o versiune istorică a depunerii');
          } else if (historical.receiptBindingHash !== receiptBindingHash(receipt, oldBinding)) {
            bindingIssues.push('hash-ul istoric al legăturii recipisei este invalid');
          }
        }
        if (bindingIssues.length) issues.push(...bindingIssues.map((x) => 'recipisa depunerii #' + ordinal + ': ' + x));
      } else if (receipt && (receipt.filingBinding || receipt.receiptBindingHash)) {
        issues.push('recipisa depunerii #' + ordinal + ' are o legătură fără identitatea depunerii');
      }
    }
  }
  const valid = issues.length === 0;
  const complete = valid && missing.length === 0 && (rec.depuneri || []).length > 0;
  return { valid, complete, contentVerified: verifyContent,
    state: !valid ? 'corupt' : (complete ? (verifyContent ? 'complet' : 'prezent') : 'incomplet'), issues, missing };
}

function dossierSummary(rec, firmaId, tip, period, opts) {
  const identity = dossierIdentity(firmaId, tip, period);
  const integrity = verifyDossier(rec, firmaId, tip, period, opts);
  return Object.assign(identity, {
    persisted: !!rec,
    createdAt: rec && rec.dossier && rec.dossier.createdAt || (rec && earliestDossierTimestamp(rec)) || null,
    integrity,
    artifactCount: rec && Array.isArray(rec.artifacts) ? rec.artifacts.length : 0,
    submissionCount: rec && Array.isArray(rec.depuneri) ? rec.depuneri.length : 0,
    transitionCount: rec && Array.isArray(rec.statusHistory) ? rec.statusHistory.length : 0,
    eventCount: rec && Array.isArray(rec.stateEvents) ? rec.stateEvents.length : 0,
    officialValidationCount: rec && Array.isArray(rec.officialValidations) ? rec.officialValidations.length : 0,
    stateChainHash: rec && rec.stateChainHash || '',
  });
}

function timelineDate(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function profileChanges(previous, current) {
  if (!previous) return [];
  const before = previous.values || {}; const after = current.values || {};
  return fiscalProfile.HISTORIC_FIELDS.filter((field) => canonicalJson(before[field]) !== canonicalJson(after[field]))
    .map((field) => ({
      field,
      before: before[field] === undefined ? null : JSON.parse(JSON.stringify(before[field])),
      after: after[field] === undefined ? null : JSON.parse(JSON.stringify(after[field])),
    }));
}

/**
 * Proiecția cronologică a dosarului unește cele două timpuri care nu trebuie confundate:
 * evenimentele de depunere sunt ordonate după momentul consemnării, iar reviziile fiscale arată
 * separat intervalul pentru care produc efecte. Proiecția este construită pe server, din registrele
 * append-only; browserul doar o afișează și nu deduce retrospectiv relații între versiuni.
 */
function dossierTimeline(rec, source, firmaId, tip, period) {
  const items = [];
  const snapshots = [];
  const addSnapshot = (snapshot, use) => {
    if (!snapshot || !snapshot.revisionId) return;
    snapshots.push({ revisionId: String(snapshot.revisionId), use });
  };
  addSnapshot(rec && rec.profileSnapshot, { kind: 'dossier' });
  for (const artifact of (rec && rec.artifacts || [])) {
    addSnapshot(artifact && artifact.profileSnapshot, { kind: 'artifact', artifactHash: String(artifact.sha256 || '') });
  }
  for (const submission of (rec && rec.depuneri || [])) {
    addSnapshot(submission && submission.profileSnapshot, {
      kind: 'submission', ordinal: Number(submission.ordinal) || 0,
      submissionHash: String(submission.submissionHash || ''),
    });
  }

  const asOf = fiscalProfile.asOfDate(period);
  const history = source ? fiscalProfile.historyFor(source, firmaId) : [];
  history.forEach((revision, index) => {
    const uses = snapshots.filter((x) => x.revisionId === String(revision.id || '')).map((x) => x.use);
    const appliesToPeriod = revision.validFrom <= asOf && (!revision.validTo || asOf < revision.validTo);
    const occurredAt = fiscalProfile.recordedAtOf(revision);
    // Un dosar rezervat arată doar profilul care i s-ar aplica. După materializare, întregul
    // registru fiscal rămâne vizibil: inclusiv schimbările anterioare, retroactive sau viitoare.
    if (!rec && !appliesToPeriod && !uses.length) return;
    items.push({
      id: 'profile:' + String(revision.id || (revision.validFrom + ':' + index)),
      kind: 'fiscal-profile', eventType: index === 0 ? 'profile.baseline' : 'profile.changed',
      occurredAt, effectiveAt: revision.validFrom, validTo: revision.validTo || null,
      revisionId: revision.id == null ? null : String(revision.id),
      recordedBy: revision.createdBy == null ? null : revision.createdBy,
      note: String(revision.note || ''), values: JSON.parse(JSON.stringify(revision.values || {})),
      changes: profileChanges(index ? history[index - 1] : null, revision),
      appliesToPeriod, usedByDossier: uses.length > 0, uses,
    });
  });

  for (const rawEvent of (rec && rec.stateEvents || [])) {
    const event = rawEvent || {};
    const evidence = event.evidence || {};
    const submission = evidence.submission || {};
    const receiptEvidence = Array.isArray(evidence.receipt) ? evidence.receipt
      : (evidence.receipt ? [evidence.receipt] : []);
    const approval = evidence.approval || {};
    const artifact = evidence.artifact || {};
    items.push({
      id: 'state:' + String(event.seq || '') + ':' + String(event.hash || ''),
      kind: 'filing', eventType: String(event.type || 'state.changed'),
      occurredAt: timelineDate(event.at), sequence: Number(event.seq) || 0,
      from: String(event.from || ''), to: String(event.to || ''),
      actor: event.authorization ? JSON.parse(JSON.stringify(event.authorization)) : null,
      eventHash: String(event.hash || ''), previousHash: String(event.previousHash || ''),
      artifactHash: String(artifact.sha256 || evidence.artifactHash || submission.submittedArtifactHash || ''),
      approvalHash: String(approval.approvalHash || submission.documentApprovalHash || ''),
      profileHash: String(evidence.profileHash || ''),
      ordinal: Number(evidence.ordinal || submission.ordinal) || null,
      rectificativa: evidence.rectificativa === true || submission.rectificativa === true
        || event.type === 'submission.amended',
      reason: String(evidence.reason || evidence.note || ''),
      submissionId: String(submission.submissionId || ''),
      submissionHash: String(submission.submissionHash || ''),
      receiptReferences: receiptEvidence.map((receipt) => String(receipt.reference || '')).filter(Boolean),
      receiptHashes: receiptEvidence.map((receipt) => String(receipt.receiptBindingHash || receipt.sha256 || '')).filter(Boolean),
    });
  }

  return items.sort((a, b) => {
    const atA = a.occurredAt || ''; const atB = b.occurredAt || '';
    if (atA !== atB) return atA.localeCompare(atB);
    if (a.kind === 'filing' && b.kind === 'filing' && a.sequence !== b.sequence) return a.sequence - b.sequence;
    if (a.kind !== b.kind) return a.kind === 'fiscal-profile' ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Proiecția publică unică: profil, documente, tranziții, depuneri și recipise sub aceeași identitate.
 *  Octeții base64 nu părăsesc API-ul; se recuperează numai prin rutele care reverifică SHA-256. */
function publicDossier(rec, firmaId, tip, period, source) {
  const dossier = dossierSummary(rec, firmaId, tip, period);
  if (!rec) return Object.assign(dossier, {
    status: 'nedepusa', profileSnapshot: null, profileHash: '', profileProvenanceHash: '',
    ruleSetId: '', fiscalRulesHash: '',
    transmittedArtifactHash: '', transmittedApprovalHash: '', transmittedValidationHash: '',
    documentApproval: null, documentApprovals: [], officialValidation: null,
    officialValidations: [], artifacts: [], statusHistory: [], stateEvents: [], submissions: [],
    timeline: dossierTimeline(null, source, firmaId, tip, period),
  });
  return Object.assign(dossier, {
    status: rec.status || 'nedepusa', generatedAt: rec.generatedAt || null,
    transmittedAt: rec.transmittedAt || null, submittedAt: rec.submittedAt || null,
    transmittedArtifactHash: transmittedArtifactHashOf(rec),
    transmittedApprovalHash: rec.transmittedApprovalHash || '',
    transmittedValidationHash: rec.transmittedValidationHash || '',
    recipisa: rec.recipisa || '', note: rec.note || '',
    profileSnapshot: rec.profileSnapshot || null, profileHash: rec.profileHash || '',
    profileProvenanceHash: rec.profileProvenanceHash || '',
    ruleSetId: rec.ruleSetId || '', fiscalRulesHash: rec.fiscalRulesHash || '',
    documentApproval: rec.documentApproval ? JSON.parse(JSON.stringify(rec.documentApproval)) : null,
    documentApprovals: (rec.documentApprovals || []).map((x) => JSON.parse(JSON.stringify(x))),
    officialValidation: rec.officialValidation ? JSON.parse(JSON.stringify(rec.officialValidation)) : null,
    officialValidations: (rec.officialValidations || []).map((x) => JSON.parse(JSON.stringify(x))),
    artifacts: publicArtifacts(rec.artifacts), statusHistory: (rec.statusHistory || []).map((x) => Object.assign({}, x)),
    stateEvents: (rec.stateEvents || []).map((x) => JSON.parse(JSON.stringify(x))),
    submissions: publicSubmissions(rec.depuneri), timeline: dossierTimeline(rec, source, firmaId, tip, period),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  DECLARATII RECTIFICATIVE
//
//  Sondajul pe validatoarele oficiale (metoda „validatorul ca oracol") a aratat ca cele trei
//  declaratii NU se comporta la fel — si ca doua dintre ele nu au niciun steag in XML:
//
//    D112 — SEMNALIZATA in XML: `d_rec="1"` + `tip_rec="N"`. Regula A3b a validatorului:
//           daca d_rec=1, tip_rec nu poate fi 5. Daca d_rec=0, tip_rec nu se completeaza deloc.
//    D300 — FARA steag. Rectificarea e o redepunere a decontului pe aceeasi perioada. Singurul
//           camp inrudit e `temei`, cu lista {0, 2} (1 si 3 respinse la sondaj): temeiul legal
//           cand decontul se depune DUPA anularea rezervei verificarii ulterioare.
//    D394 — FARA steag, zero aparitii ale notiunii in tot validatorul. Rectificarea e o
//           redepunere completa.
//
//  Consecinta de proiectare: „rectificativa" e in primul rand o stare a APLICATIEI (a cata
//  depunere, de ce, ce s-a schimbat), nu un camp XML. De aceea istoricul de mai jos e tinut
//  pentru toate trei, iar XML-ul primeste steag doar unde exista.
// ─────────────────────────────────────────────────────────────────────────────

/** Tipurile care poarta un steag de rectificare in XML (restul se redepun ca atare). */
const RECT_IN_XML = { d107: true, d205: true, d112: true, d301: true, d307: true, d311: true };

/**
 * Inregistreaza o depunere noua peste (firmaId, tip, period). NU suprascrie: adauga in istoric.
 * Prima depunere are ordinal 1 si nu e rectificativa; urmatoarele sunt rectificative.
 * `motiv` e obligatoriu cand perioada e inchisa — vezi garda din serviciu.
 */
function addSubmission(d, firmaId, tip, period, info, _nextIdFn) {
  const rec = find(d, firmaId, tip, period);
  if (!rec) throw dossierError('Depunerea cere un dosar generat și transmis anterior.', 'FILING_DOSSIER_REQUIRED');
  ensureDossier(rec, firmaId, tip, period); ensureStateLedger(rec, firmaId, tip, period);
  if (rec.status !== 'depusa') throw dossierError('Depunerea poate fi adăugată numai după tranziția autorizată la „depusă”.', 'FILING_TRANSITION_REQUIRED');
  requireTransitionAuthorization(info || {}, 'declaration.submit');
  rec.depuneri = Array.isArray(rec.depuneri) ? rec.depuneri : [];
  const ordinal = rec.depuneri.length + 1;
  const receiptInputs = Array.isArray(info && info.receipts) ? info.receipts : [];
  if (String(info && info.recipisa || '').trim().length < 2 || !receiptInputs.length
      || receiptInputs.some((receipt) => !exactContent(receipt))) {
    throw dossierError('Fiecare depunere cere numărul și cel puțin un fișier exact de recipisă.', 'FILING_EVIDENCE_RECEIPT_REQUIRED');
  }
  const documentApproval = (info && info.documentApproval) || rec.documentApproval || null;
  const approvedHash = String(documentApproval && documentApproval.artifactHash || '');
  const submittedHash = String((info && (info.submittedArtifactHash || info.artifactHash))
    || approvedHash || transmittedArtifactHashOf(rec));
  const submittedArtifact = exactArtifact(rec, submittedHash);
  if (!submittedArtifact) throw dossierError('Depunerea cere artefactul transmis, păstrat byte-identic.', 'FILING_EVIDENCE_ARTIFACT_REQUIRED');
  const storedApproval = approvalForArtifact(rec, approvedHash);
  if (!documentApproval || !storedApproval
      || storedApproval.approvalHash !== documentApproval.approvalHash
      || documentApproval.artifactHash !== submittedHash || documentApprovalIssues(documentApproval).length) {
    throw dossierError('Depunerea cere artefactul ales de aprobare, nu ultima versiune disponibilă.', 'FILING_EVIDENCE_APPROVAL_REQUIRED');
  }
  const officialValidation = validationForArtifact(rec, submittedHash);
  if (!officialValidation) {
    throw dossierError('Depunerea sau rectificativa cere validarea oficială a XML-ului exact.', 'OFFICIAL_VALIDATION_REQUIRED');
  }
  const dep = {
    ordinal,
    rectificativa: ordinal > 1,
    ts: (info && info.ts) || new Date().toISOString(),
    motiv: String((info && info.motiv) || '').slice(0, 500),
    de: (info && info.de) || '',
    // Sumele-cheie la momentul depunerii: fara ele nu se poate arata DIFERENTA fata de depunerea
    // anterioara, iar o rectificativa fara diferenta vizibila nu se poate verifica de nimeni.
    sume: (info && info.sume) || null,
    tipRec: (info && info.tipRec != null) ? Number(info.tipRec) : null,
    recipisa: String((info && info.recipisa) || '').slice(0, 100),
    // Ieșirea generatorului și binarul efectiv transmis sunt identități distincte. De regulă
    // coincid; un validator sau o semnare externă poate însă schimba octeții fără să schimbe
    // declarația economică. Aliasul `artifactHash` rămâne pentru bazele istorice.
    artifactHash: submittedHash,
    generatedArtifactHash: String((info && info.generatedArtifactHash) || approvedHash),
    submittedArtifactHash: submittedHash,
    submittedArtifactConfirmedAt: (info && info.submittedArtifactConfirmedAt)
      || ((info && info.ts) || new Date().toISOString()),
    submittedArtifactConfirmedBy: String((info && info.de) || '').slice(0, 80),
    approvedArtifactHash: documentApproval.artifactHash,
    documentApprovalHash: documentApproval.approvalHash,
    documentApproval: JSON.parse(JSON.stringify(documentApproval)),
    officialValidationHash: officialValidation.proofHash,
    profileSnapshot: (info && info.profileSnapshot && info.profileSnapshot.hash)
      ? JSON.parse(JSON.stringify(info.profileSnapshot))
      : (rec.profileSnapshot ? JSON.parse(JSON.stringify(rec.profileSnapshot)) : null),
    profileHash: String((info && info.profileSnapshot && info.profileSnapshot.hash) || rec.profileHash || ''),
    profileProvenanceHash: String((info && info.profileSnapshot && info.profileSnapshot.provenanceHash)
      || rec.profileProvenanceHash || ''),
    receipts: [],
  };
  const submissionProof = sealSubmission(rec, dep);
  dep.receipts = receiptInputs.map((receipt) => bindReceiptToSubmission(rec, dep, receipt));
  appendStateEvent(rec, firmaId, tip, period, {
    type: ordinal > 1 ? 'submission.amended' : 'submission.recorded',
    from: 'depusa', to: 'depusa', at: dep.ts, authorization: info.authorization,
    evidence: {
      ordinal, rectificativa: ordinal > 1, artifactHash: submittedHash,
      artifact: { sha256: submittedArtifact.sha256, bytes: submittedArtifact.bytes,
        filename: submittedArtifact.filename, mime: submittedArtifact.mime },
      fiscalRulesHash: officialValidation.fiscalRulesHash,
      profileHash: dep.profileHash, reason: dep.motiv,
      profileProvenanceHash: dep.profileProvenanceHash,
      submission: submissionProof,
      approval: JSON.parse(JSON.stringify(documentApproval)),
      officialValidation: JSON.parse(JSON.stringify(officialValidation)),
      fiscalReview: info.fiscalReviewEvidence ? JSON.parse(JSON.stringify(info.fiscalReviewEvidence)) : null,
      receipt: dep.receipts.map((receipt) => receiptEvidencePublic(receipt, dep.recipisa)),
    },
  });
  rec.depuneri.push(dep);
  rec.recipisa = dep.recipisa;
  rec.submittedAt = dep.ts;
  rec.updatedAt = dep.ts;
  return { rec, depunere: dep };
}

function attachReceipt(rec, firmaId, tip, period, ordinal, receipt, info) {
  ensureDossier(rec, firmaId, tip, period); ensureStateLedger(rec, firmaId, tip, period);
  requireTransitionAuthorization(info || {}, 'declaration.submit');
  const submission = (rec.depuneri || []).find((x) => Number(x.ordinal) === Number(ordinal));
  if (!submission || !submission.recipisa) {
    throw dossierError('Fișierul trebuie legat de o depunere confirmată cu număr de recipisă.', 'FILING_TRANSITION_REQUIRED');
  }
  if (!exactContent(receipt)) throw dossierError('Recipisa trebuie păstrată byte-identic.', 'FILING_EVIDENCE_RECEIPT_REQUIRED');

  const hadBinding = Number(submission.schemaVersion) === SUBMISSION_SCHEMA_VERSION
    && /^[0-9a-f]{64}$/.test(String(submission.submissionHash || ''));
  if (hadBinding) {
    const currentProof = submissionEvidence(rec, submission);
    if (submission.submissionId !== currentProof.submissionId || submission.submissionHash !== currentProof.submissionHash) {
      throw dossierError('Legătura semantică a depunerii este invalidă; recipisa nu poate fi atașată.', 'FILING_RECEIPT_BINDING_INVALID');
    }
    for (const existing of (submission.receipts || [])) {
      const bindingIssues = receiptBindingIssues(existing, currentProof);
      if (bindingIssues.length) throw dossierError('Legătura unei recipise existente este invalidă: '
        + bindingIssues.join('; '), 'FILING_RECEIPT_BINDING_INVALID');
    }
  } else {
    sealSubmission(rec, submission);
    submission.bindingEstablishedAt = String(info && info.at || new Date().toISOString());
    submission.bindingEstablishedBy = String(info && info.by || '').slice(0, 80);
    submission.receipts = (submission.receipts || []).map((existing) => bindReceiptToSubmission(rec, submission, existing));
  }

  const proof = submissionEvidence(rec, submission);
  const boundReceipt = bindReceiptToSubmission(rec, submission, receipt);
  submission.receipts = Array.isArray(submission.receipts) ? submission.receipts : [];
  const existing = submission.receipts.find((x) => x.sha256 === boundReceipt.sha256);
  if (existing) return { submission, receipt: existing, created: false };

  const evidence = Object.assign(receiptEvidencePublic(boundReceipt, submission.recipisa), {
    ordinal: Number(submission.ordinal), submission: proof,
  });
  appendStateEvent(rec, firmaId, tip, period, {
    type: 'receipt.attached', from: rec.status, to: rec.status,
    at: String(info && info.at || new Date().toISOString()), authorization: info && info.authorization,
    evidence,
  });
  submission.receipts.push(boundReceipt);
  rec.updatedAt = String(info && info.at || new Date().toISOString());
  return { submission, receipt: boundReceipt, created: true };
}

/** Corecțiile motivate păstrează vechea ancoră și resigilează recipisele pe noua realitate. */
function resealSubmission(rec, submission, changes, info) {
  const at = String(info && info.at || new Date().toISOString());
  const by = String(info && info.by || '').slice(0, 80);
  const reason = String(info && info.reason || '').slice(0, 500);
  const hadBinding = Number(submission.schemaVersion) === SUBMISSION_SCHEMA_VERSION
    && /^[0-9a-f]{64}$/.test(String(submission.submissionHash || ''));
  const previousProof = submissionEvidence(rec, submission);
  if (hadBinding && (submission.submissionId !== previousProof.submissionId
      || submission.submissionHash !== previousProof.submissionHash)) {
    throw dossierError('Legătura semantică a depunerii este invalidă și nu poate fi resigilată.', 'FILING_RECEIPT_BINDING_INVALID');
  }
  if (hadBinding) {
    submission.submissionBindingHistory = Array.isArray(submission.submissionBindingHistory)
      ? submission.submissionBindingHistory : [];
    submission.submissionBindingHistory.push({ submission: previousProof, supersededAt: at, supersededBy: by, reason });
  }
  Object.assign(submission, changes || {});
  const proof = sealSubmission(rec, submission);
  submission.receipts = (submission.receipts || []).map((receipt) => {
    const out = JSON.parse(JSON.stringify(receipt));
    if (hadBinding && out.filingBinding) {
      out.filingBindingHistory = Array.isArray(out.filingBindingHistory) ? out.filingBindingHistory : [];
      out.filingBindingHistory.push({ filingBinding: out.filingBinding,
        receiptBindingHash: out.receiptBindingHash || '', supersededAt: at, supersededBy: by, reason });
    }
    const rebound = bindReceiptToSubmission(rec, submission, out);
    if (out.filingBindingHistory) rebound.filingBindingHistory = out.filingBindingHistory;
    return rebound;
  });
  return { previousSubmissionHash: hadBinding ? previousProof.submissionHash : '', submission: proof };
}

/** Ultima depunere (sau null), pentru diferenta la urmatoarea rectificativa. */
function lastSubmission(rec) {
  const list = (rec && Array.isArray(rec.depuneri)) ? rec.depuneri : [];
  return list.length ? list[list.length - 1] : null;
}

/** Diferenta dintre sumele a doua depuneri, pe cheile comune (doar valorile schimbate). */
function submissionDiff(prev, curr) {
  const a = (prev && prev.sume) || {}; const b = (curr && curr.sume) || {};
  const chei = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out = [];
  for (const k of chei) {
    const va = Number(a[k]) || 0; const vb = Number(b[k]) || 0;
    if (va !== vb) out.push({ cheie: k, inainte: va, dupa: vb, delta: Math.round((vb - va) * 100) / 100 });
  }
  return out;
}

// Cat de aproape trebuie sa fie termenul ca declaratia sa treaca din „in pregatire" in „de depus".
// Aceeasi fereastra pe care o foloseste si ecranul de notificari (parametrul `days` din
// `notifications`), scrisa o singura data: doua praguri ar fi insemnat ca acelasi termen e „urgent"
// pe un ecran si linistit pe celalalt.
const ZILE_TERMEN_APROPIAT = 7;

/**
 * Unde se afla o declaratie fata de TERMENUL ei. Functie PURA.
 *
 * Distinctia exista de mult, dar traia doar in `notifications()`: acolo un termen viitor si unul
 * depasit produceau `kind` diferit ('termen' vs 'restanta'), iar dashboard-ul le colora diferit.
 * Registrul de declaratii primea doar `overdue`, deci „termen peste 43 de zile, nicio operatiune
 * in luna" si „termenul a trecut ieri" se afisau IDENTIC — „Nedepusa", pe fond de avertizare.
 * Pentru o firma inscrisa acum un minut, asta citeste ca un repros, nu ca o informatie.
 *
 * Cele trei stari nu sunt cosmetica: sunt trei actiuni diferite ale omului — nimic (inca), pregateste
 * depunerea, respectiv repara o intarziere care poate costa penalitati.
 *
 * @returns {'gata'|'restanta'|'termen'|'in-pregatire'}
 *   `gata` = depusa sau scutita: termenul nu mai spune nimic despre ea.
 */
function urgentaTermen(due, status, today, days) {
  if (status === 'depusa' || status === 'scutita') return 'gata';
  const t = today || new Date().toISOString().slice(0, 10);
  if (!due) return 'in-pregatire';
  if (due < t) return 'restanta';
  const fereastra = Number.isFinite(Number(days)) ? Number(days) : ZILE_TERMEN_APROPIAT;
  const orizont = new Date(Date.parse(t) + fereastra * 86400000).toISOString().slice(0, 10);
  return due <= orizont ? 'termen' : 'in-pregatire';
}

/** Registrul unei firme pe o luna: asteptate ∪ inregistrari, cu termen si restanta. */
function registerForFirma(d, v, period, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  const d112Postat = statPlataPerioada(v, period).postat;
  const rows = expectedForFirma(v, period).map((e) => {
    const stored = find(d, v.firmaId, e.tip, period);
    const rec = stored || {};
    const status = rec.status || 'nedepusa';
    return {
      tip: e.tip, nume: e.nume, period, due: e.due, status,
      // `urgenta` e derivata; `overdue` ramane, dar ca UMBRA a ei — doua reguli paralele pentru
      // aceeasi intrebare ar fi exact defectul reparat aici, cu semnul schimbat.
      urgenta: urgentaTermen(e.due, status, t),
      overdue: urgentaTermen(e.due, status, t) === 'restanta',
      generatedAt: rec.generatedAt || null, transmittedAt: rec.transmittedAt || null, submittedAt: rec.submittedAt || null,
      recipisa: rec.recipisa || '', note: rec.note || '', artifactHash: rec.artifactHash || '',
      transmittedArtifactHash: transmittedArtifactHashOf(rec), transmittedApprovalHash: rec.transmittedApprovalHash || '',
      artifactBytes: rec.artifactBytes || 0, artifacts: publicArtifacts(rec.artifacts), statusHistory: rec.statusHistory || [],
      stateEvents: (rec.stateEvents || []).map((x) => JSON.parse(JSON.stringify(x))),
      profileSnapshot: rec.profileSnapshot || null, profileHash: rec.profileHash || '',
      profileProvenanceHash: rec.profileProvenanceHash || '',
      ruleSetId: rec.ruleSetId || '', fiscalRulesHash: rec.fiscalRulesHash || '',
      documentApproval: rec.documentApproval ? JSON.parse(JSON.stringify(rec.documentApproval)) : null,
      documentApprovals: (rec.documentApprovals || []).map((x) => JSON.parse(JSON.stringify(x))),
      depuneri: publicSubmissions(rec.depuneri),
      timeline: dossierTimeline(stored, v, v.firmaId, e.tip, period),
      dossier: dossierSummary(stored, v.firmaId, e.tip, period, { verifyContent: false }),
      links: e.tip === 'd112' && !d112Postat ? [] : descarcariPentru(rec, e.tip, period),
      blocaj: e.tip === 'd112' && !d112Postat
        ? 'Postează statul de plată înainte de generarea D112.' : '',
    };
  });
  // inregistrari manuale in afara celor asteptate (ex. D100 marcat intr-o luna non-trimestriala)
  for (const rec of (d.declarations || [])) {
    if (rec.firmaId !== v.firmaId || rec.period !== period) continue;
    if (rows.some((r) => r.tip === rec.tip)) continue;
    rows.push({
      tip: rec.tip, nume: (TIPURI[rec.tip] || {}).nume || rec.tip, period, due: dueDate(rec.tip, period),
      // Inregistrare manuala in afara celor asteptate: nu poate fi „restanta" (firma nici n-o
      // datoreaza), dar starea trebuie sa existe ca sa nu fie `undefined` in interfata.
      status: rec.status, urgenta: rec.status === 'depusa' || rec.status === 'scutita' ? 'gata' : 'in-pregatire',
      overdue: false, generatedAt: rec.generatedAt, transmittedAt: rec.transmittedAt || null, submittedAt: rec.submittedAt,
      recipisa: rec.recipisa || '', note: rec.note || '', artifactHash: rec.artifactHash || '',
      transmittedArtifactHash: transmittedArtifactHashOf(rec), transmittedApprovalHash: rec.transmittedApprovalHash || '',
      artifactBytes: rec.artifactBytes || 0, artifacts: publicArtifacts(rec.artifacts), statusHistory: rec.statusHistory || [],
      stateEvents: (rec.stateEvents || []).map((x) => JSON.parse(JSON.stringify(x))),
      profileSnapshot: rec.profileSnapshot || null, profileHash: rec.profileHash || '',
      profileProvenanceHash: rec.profileProvenanceHash || '',
      ruleSetId: rec.ruleSetId || '', fiscalRulesHash: rec.fiscalRulesHash || '',
      documentApproval: rec.documentApproval ? JSON.parse(JSON.stringify(rec.documentApproval)) : null,
      documentApprovals: (rec.documentApprovals || []).map((x) => JSON.parse(JSON.stringify(x))),
      depuneri: publicSubmissions(rec.depuneri),
      timeline: dossierTimeline(rec, v, v.firmaId, rec.tip, period),
      dossier: dossierSummary(rec, v.firmaId, rec.tip, period, { verifyContent: false }),
      links: rec.tip === 'd112' && !d112Postat ? [] : descarcariPentru(rec, rec.tip, period),
      blocaj: rec.tip === 'd112' && !d112Postat
        ? 'Postează statul de plată înainte de generarea D112.' : '',
    });
  }
  return rows;
}

/** Agregarea pe portofoliu: per firma + totaluri + conformitate, pe luna `period`. */
function portfolio(d, scopedList, period, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  const firms = [];
  const tot = { asteptate: 0, depuse: 0, transmise: 0, aprobate: 0, generate: 0, nedepuse: 0, erori: 0, scutite: 0, restante: 0 };
  for (const v of scopedList) {
    // Acelasi reper ca la notificari: pentru o luna dinaintea existentei firmei nu exista obligatii.
    // Firma RAMANE in lista, cu zero — portofoliul e inventarul firmelor administrate, iar una care
    // dispare si reapare dupa luna aleasa ar parea pierduta.
    const dela = primaLunaUrmarita(v);
    const rows = (dela && String(period || '') < dela) ? [] : registerForFirma(d, v, period, t);
    const c = { asteptate: rows.length, depuse: 0, transmise: 0, aprobate: 0, generate: 0, nedepuse: 0, erori: 0, scutite: 0, restante: 0 };
    const atentionari = [];
    for (const r of rows) {
      if (r.status === 'depusa') c.depuse += 1;
      else if (r.status === 'transmisa') c.transmise += 1;
      else if (r.status === 'aprobata') c.aprobate += 1;
      else if (r.status === 'generata') c.generate += 1;
      else if (r.status === 'eroare') { c.erori += 1; atentionari.push(r.nume.split(' — ')[0] + ': eroare' + (r.note ? ' (' + r.note + ')' : '')); }
      else if (r.status === 'scutita') c.scutite += 1;
      else c.nedepuse += 1;
      if (r.overdue) { c.restante += 1; if (r.status !== 'eroare') atentionari.push(r.nume.split(' — ')[0] + ': termen depășit (' + fmtDate(r.due) + ')'); }
    }
    for (const k of Object.keys(tot)) tot[k] += c[k];
    firms.push({
      firmaId: v.firmaId, nume: (v.company || {}).nume || ('Firma ' + v.firmaId), cui: (v.company || {}).cui || '',
      counts: c, atentionari, natentionari: atentionari.length,
    });
  }
  const datorate = tot.asteptate - tot.scutite;
  const conformitate = datorate > 0 ? Math.round((tot.depuse / datorate) * 100) : 100;
  firms.sort((a, b) => b.natentionari - a.natentionari || a.nume.localeCompare(b.nume));
  return { period, firms, tot, conformitate };
}

function addMonths(period, n) {
  let y = Number(period.slice(0, 4)); let m = Number(period.slice(5, 7)) + n;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return y + '-' + pad2(m);
}

/**
 * Notificari de termene pe portofoliu: restante + termene in urmatoarele `days` zile,
 * scanand ultimele `lookback` luni (declaratia lunii M are termen in M+1).
 */
/**
 * Prima luna pentru care aplicatia are dreptul sa ceara declaratii de la o firma.
 *
 * Calendarul fiscal se DERIVA din profilul firmei (platitor de TVA, angajati, regim), nu din date
 * — asa si trebuie, fiindca multe declaratii se depun „pe zero". Dar fara un reper de inceput,
 * o firma creata AZI aparea imediat cu restante pentru lunile dinaintea ei: 9 restante D300/D394/
 * D406 pentru luni in care nu exista. E o acuzatie falsa, si tocmai pe ecranul care ar trebui sa
 * fie lista de lucru a utilizatorului.
 *
 * Reperul e `createdAt`. Daca firma are inregistrari mai VECHI (istoric preluat de la contabilul
 * anterior), acelea coboara reperul: acolo obligatiile sunt reale si trebuie aratate.
 * Firmele fara `createdAt` (cele dinainte de campul asta) intorc '' — comportament neschimbat,
 * ca sa nu ascundem retroactiv restante adevarate.
 */
function primaLunaUrmarita(v) {
  let min = String(((v && v.company) || {}).createdAt || '').slice(0, 7);
  if (!min) return '';
  for (const e of ((v && v.entries) || [])) {
    const p = String(e.period || e.data || '').slice(0, 7);
    if (p && p < min) min = p;
  }
  return min;
}

function notifications(d, scopedList, today, days, lookback) {
  const t = today || new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.parse(t) + (days || 7) * 86400000).toISOString().slice(0, 10);
  const curPeriod = t.slice(0, 7);
  const items = [];
  for (const v of scopedList) {
    const dela = primaLunaUrmarita(v); // '' = firma veche, fara reper -> ca inainte
    for (let i = 1; i <= (lookback || 3); i++) {
      const period = addMonths(curPeriod, -i);
      if (dela && period < dela) continue; // luna dinaintea existentei firmei: n-are obligatii aici
      for (const r of registerForFirma(d, v, period, t)) {
        // ACEEASI derivare ca in registrul de declaratii (`urgentaTermen`), nu o a doua copie a
        // regulii. Fereastra vine din parametrul rutei, deci ecranul de notificari poate cere alt
        // orizont — dar impartirea „restanta / de depus / in pregatire" ramane una singura.
        const u = urgentaTermen(r.due, r.status, t, days || 7);
        if (u === 'gata' || u === 'in-pregatire') continue;
        items.push({ kind: u === 'restanta' ? 'restanta' : 'termen', firmaId: v.firmaId, firma: (v.company || {}).nume || '', tip: r.tip, nume: r.nume, period, due: r.due, status: r.status });
      }
    }
    // e-Factura B2B netrimisa in SPV: restanta cand termenul de 5 zile lucratoare e depasit
    for (const f of eFacturaNetrimise(v, t).items) {
      const nume = 'e-Factura ' + (f.document || f.entryId) + (f.partener ? ' — ' + f.partener : '');
      if (f.overdue) items.push({ kind: 'restanta', firmaId: v.firmaId, firma: (v.company || {}).nume || '', tip: 'efactura', nume, period: f.data.slice(0, 7), due: f.due, status: 'netrimisa' });
      else if (f.due <= horizon) items.push({ kind: 'termen', firmaId: v.firmaId, firma: (v.company || {}).nume || '', tip: 'efactura', nume, period: f.data.slice(0, 7), due: f.due, status: 'netrimisa' });
    }
  }
  items.sort((a, b) => (a.kind === b.kind ? a.due.localeCompare(b.due) : (a.kind === 'restanta' ? -1 : 1)));
  return { count: items.length, items };
}

module.exports = { TIPURI, STATUSES, DESCARCARI, descarcari, dueDate, urgentaTermen, ZILE_TERMEN_APROPIAT, expectedForFirma, record, registerForFirma, portfolio, notifications, primaLunaUrmarita, addMonths, find, eFacturaNetrimise, addBusinessDays, addCalendarDays,
  addSubmission, attachReceipt, resealSubmission, submissionEvidence, bindReceiptToSubmission,
  lastSubmission, submissionDiff, d100Snapshot, RECT_IN_XML, publicArtifacts, publicSubmissions, exactContent, exactArtifact,
  approveDocument, documentApprovalHash, documentApprovalIssues, approvalForArtifact, currentApprovalMatches,
  recordOfficialValidation, validationForArtifact,
  approvedArtifactHashOf, transmittedArtifactHashOf,
  DOSSIER_SCHEMA_VERSION, SUBMISSION_SCHEMA_VERSION, RECEIPT_BINDING_SCHEMA_VERSION,
  dossierKey, dossierIdentity, ensureDossier, assertUniqueDossiers, verifyDossier, dossierSummary, dossierTimeline, publicDossier,
  STATE_LEDGER_SCHEMA_VERSION, APPROVAL_STATE_LEDGER_SCHEMA_VERSION, LEGACY_STATE_LEDGER_SCHEMA_VERSION, ALLOWED_TRANSITIONS,
  stateEventHash, appendStateEvent, verifyStateLedger, ensureStateLedger };
