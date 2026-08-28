'use strict';

// Poarta unica pentru trecerea de la date fictive la date reale.
//
// Identitatea furnizorului si existenta unor proceduri GDPR nu sunt simple texte de marketing:
// ele decid daca aplicatia poate accepta o relatie operator–persoana imputernicita. Implicit,
// poarta este INCHISA. Se deschide numai daca toate dovezile de mai jos sunt configurate, versiunile
// publicate coincid cu cele din cod, iar identitatea configurata apare efectiv in Termeni si DPA.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSIONS = Object.freeze({
  terms: '2026-08-26.1',
  privacy: '2026-08-28.1',
  dpa: '2026-08-26.1',
});

const DOCUMENTS = Object.freeze({
  terms: { file: 'termeni.html', url: '/termeni.html' },
  privacy: { file: 'confidentialitate.html', url: '/confidentialitate.html' },
  dpa: { file: 'dpa.html', url: '/dpa.html' },
});

const PROVIDER_FIELDS = Object.freeze({
  name: 'CONTAB_LEGAL_PROVIDER_NAME',
  registrationNumber: 'CONTAB_LEGAL_PROVIDER_REGISTRATION',
  taxId: 'CONTAB_LEGAL_PROVIDER_TAX_ID',
  address: 'CONTAB_LEGAL_PROVIDER_ADDRESS',
  privacyEmail: 'CONTAB_LEGAL_PRIVACY_EMAIL',
});

const GOVERNANCE_EVIDENCE = Object.freeze({
  ropaVersion: 'CONTAB_GDPR_ROPA_VERSION',
  incidentProcedureVersion: 'CONTAB_GDPR_INCIDENT_PROCEDURE_VERSION',
  rightsProcedureVersion: 'CONTAB_GDPR_RIGHTS_PROCEDURE_VERSION',
  dpiaVersion: 'CONTAB_GDPR_DPIA_VERSION',
  subprocessorsReviewedAt: 'CONTAB_GDPR_SUBPROCESSORS_REVIEWED_AT',
  transferAssessmentVersion: 'CONTAB_GDPR_TRANSFER_ASSESSMENT_VERSION',
});

function clean(value) { return String(value == null ? '' : value).trim(); }
function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }

function readDocuments(rootDir) {
  const root = rootDir || path.join(__dirname, '..', 'public');
  const out = {};
  for (const [key, doc] of Object.entries(DOCUMENTS)) {
    try { out[key] = fs.readFileSync(path.join(root, doc.file), 'utf8'); }
    catch (_) { out[key] = ''; }
  }
  return out;
}

function documentVersion(html) {
  return ((String(html).match(/<meta\s+name=["']contabo-legal-version["']\s+content=["']([^"']+)["']/i) || [])[1] || '').trim();
}

function visibleText(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Evaluare pura/injectabila: testele pot proba ambele ramuri fara sa modifice mediul procesului. */
function assess(options) {
  const o = options || {};
  const env = o.env || process.env;
  const documents = o.documents || readDocuments(o.publicDir);
  const missing = [];
  const provider = {};
  const governance = {};

  for (const [field, envName] of Object.entries(PROVIDER_FIELDS)) {
    provider[field] = clean(env[envName]);
    if (!provider[field]) missing.push('provider.' + field);
  }
  for (const [field, envName] of Object.entries(GOVERNANCE_EVIDENCE)) {
    governance[field] = clean(env[envName]);
    if (!governance[field]) missing.push('governance.' + field);
  }
  if (clean(env.CONTAB_REAL_DATA_ENABLED) !== '1') missing.push('realData.enabled');

  const versions = {};
  const hashes = {};
  for (const key of Object.keys(DOCUMENTS)) {
    const html = documents[key] || '';
    versions[key] = documentVersion(html);
    hashes[key] = html ? sha256(html) : '';
    if (!html) missing.push('document.' + key);
    else if (versions[key] !== VERSIONS[key]) missing.push('documentVersion.' + key);
  }

  // Identitatea trebuie sa fie PUBLICATA, nu doar prezenta intr-un .env privat. Toate cele trei
  // documente trebuie sa indice acelasi contact; Termenii si DPA publica intreaga contraparte.
  const termsText = visibleText(documents.terms);
  const dpaText = visibleText(documents.dpa);
  const privacyText = visibleText(documents.privacy);
  for (const field of ['name', 'registrationNumber', 'taxId', 'address']) {
    const value = provider[field];
    if (value && (!termsText.includes(value) || !dpaText.includes(value))) missing.push('publishedIdentity.' + field);
  }
  if (provider.privacyEmail && (!termsText.includes(provider.privacyEmail)
    || !dpaText.includes(provider.privacyEmail) || !privacyText.includes(provider.privacyEmail))) {
    missing.push('publishedIdentity.privacyEmail');
  }

  // Un set de variabile complet nu poate anula tacit chiar textul contractual. In ziua lansarii,
  // operatorul trebuie sa publice documentele finale si sa elimine avertismentele de test; altfel
  // am afisa simultan „date reale permise” in aplicatie si „date reale interzise” in contract.
  const publishedText = [termsText, dpaText, privacyText].join(' ');
  if (/folose(?:ș|s)te\s+doar\s+date\s+fictive/i.test(publishedText)
    || /(?:în|in)\s+curs\s+de\s+(?:în|in)fiin(?:ț|t)are/i.test(publishedText)) {
    missing.push('documentState.testOnly');
  }

  const uniqueMissing = [...new Set(missing)];
  return {
    ready: uniqueMissing.length === 0,
    mode: uniqueMissing.length ? 'test-only' : 'real-data-ready',
    missing: uniqueMissing,
    provider,
    governance,
    versions: Object.assign({}, VERSIONS),
    hashes,
  };
}

function currentSnapshot() {
  const status = assess();
  return { versions: status.versions, hashes: status.hashes };
}

function sameMap(actual, expected) {
  return !!actual && Object.keys(expected).every((key) => clean(actual[key]) === clean(expected[key]));
}

function acceptanceCurrent(record, scope) {
  if (!record || record.scope !== scope) return false;
  const snap = currentSnapshot();
  return sameMap(record.versions, snap.versions) && sameMap(record.hashes, snap.hashes);
}

function acceptanceRecord(scope, actor, extra) {
  const snap = currentSnapshot();
  return Object.assign({
    scope,
    versions: snap.versions,
    hashes: snap.hashes,
    acceptedAt: new Date().toISOString(),
    acceptedBy: actor && actor.id || null,
    acceptedUsername: actor && actor.username || '',
  }, extra || {});
}

function firmState(firma) {
  const mode = firma && ['test', 'real'].includes(firma.dataMode) ? firma.dataMode : 'unclassified';
  if (mode === 'test') return { mode, operational: true, reason: null, acceptanceCurrent: true };
  if (mode === 'real') {
    const launch = assess();
    if (!launch.ready) return { mode, operational: false, reason: 'LEGAL_READINESS_INCOMPLETE', acceptanceCurrent: false };
    const current = acceptanceCurrent(firma.legalAcceptance, 'real-data');
    return { mode, operational: current, reason: current ? null : 'LEGAL_ACCEPTANCE_STALE', acceptanceCurrent: current };
  }
  return { mode, operational: false, reason: 'DATA_MODE_UNCLASSIFIED', acceptanceCurrent: false };
}

function aiAllowed(firma) {
  const state = firmState(firma);
  return !!(state.operational && firma && firma.aiProcessing && firma.aiProcessing.enabled === true
    && acceptanceCurrent(firma.aiProcessing.consent, 'ai-processing'));
}

function publicStatus() {
  const status = assess();
  return {
    ready: status.ready,
    mode: status.mode,
    missing: status.missing,
    versions: status.versions,
    documents: Object.fromEntries(Object.entries(DOCUMENTS).map(([key, doc]) => [key, doc.url])),
    provider: status.ready ? status.provider : null,
  };
}

module.exports = {
  VERSIONS, DOCUMENTS, PROVIDER_FIELDS, GOVERNANCE_EVIDENCE,
  assess, currentSnapshot, acceptanceCurrent, acceptanceRecord, firmState, aiAllowed, publicStatus,
  _documentVersion: documentVersion, _visibleText: visibleText,
};
