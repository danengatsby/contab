'use strict';

// Dovada verificării artefactului exact care va fi transmis. Modulul nu pretinde că rulează DUK:
// adaptorul validatorului îl rulează, iar aici rezultatul complet, versiunile și octeții XML sunt
// legați criptografic și apoi verificați din nou la transmitere.

const crypto = require('crypto');
const MAX_FULL_OUTPUT_BYTES = 2 * 1024 * 1024;
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function proofHash(value) { return sha(canonical(value)); }
function fail(message, code) { const e = new Error(message); e.status = 409; e.code = code; throw e; }

function create(artifact, input, authorization) {
  const bytes = artifact && artifact.contentBase64 ? Buffer.from(String(artifact.contentBase64), 'base64') : null;
  if (!bytes || !bytes.length || sha(bytes) !== String(artifact.sha256 || '') || bytes.length !== Number(artifact.bytes)) {
    fail('Validarea cere octeții exacți și integri ai XML-ului.', 'OFFICIAL_VALIDATION_ARTIFACT_REQUIRED');
  }
  const row = input || {}; const validator = row.validator || {}; const schema = row.schema || {};
  const result = row.result || {}; const auth = authorization || {};
  if (!String(validator.name || '').trim() || !String(validator.version || '').trim()
      || !/^[0-9a-f]{64}$/.test(String(validator.distributionHash || ''))) {
    fail('Identitatea, versiunea și hash-ul distribuției validatorului lipsesc.', 'OFFICIAL_VALIDATOR_IDENTITY_REQUIRED');
  }
  if (!String(schema.name || '').trim() || !String(schema.version || '').trim()
      || !/^[0-9a-f]{64}$/.test(String(schema.hash || ''))) {
    fail('Identitatea, versiunea și hash-ul schemei lipsesc.', 'OFFICIAL_SCHEMA_IDENTITY_REQUIRED');
  }
  const fullOutput = String(result.fullOutput == null ? '' : result.fullOutput);
  if (!fullOutput || !['valid', 'invalid'].includes(String(result.status || ''))) {
    fail('Rezultatul complet și verdictul validatorului lipsesc.', 'OFFICIAL_VALIDATION_RESULT_REQUIRED');
  }
  if (Buffer.byteLength(fullOutput, 'utf8') > MAX_FULL_OUTPUT_BYTES) {
    fail('Rezultatul validatorului depășește limita de 2 MiB.', 'OFFICIAL_VALIDATION_RESULT_TOO_LARGE');
  }
  const messages = (value, label) => {
    if (!Array.isArray(value) || value.length > 2000) fail(label + ' validatorului sunt invalide.', 'OFFICIAL_VALIDATION_RESULT_REQUIRED');
    return value.map((item) => String(item).slice(0, 4000));
  };
  if (auth.authorized !== true || (auth.actorId == null && !String(auth.username || '').trim())) {
    fail('Consemnarea validării cere un actor autorizat.', 'OFFICIAL_VALIDATION_AUTHORIZATION_REQUIRED');
  }
  const fiscalRulesHash = String(row.fiscalRulesHash || artifact.fiscalRulesHash || '');
  if (!/^[0-9a-f]{64}$/.test(fiscalRulesHash)) fail('Hash-ul regulilor fiscale lipsește.', 'OFFICIAL_VALIDATION_RULES_REQUIRED');
  const body = {
    schemaVersion: 1, artifactHash: artifact.sha256, artifactBytes: bytes.length,
    declarationType: String(row.declarationType || ''),
    validator: { name: String(validator.name).trim().slice(0, 200), version: String(validator.version).trim().slice(0, 120),
      distributionHash: String(validator.distributionHash) },
    schema: { name: String(schema.name).trim().slice(0, 200), version: String(schema.version).trim().slice(0, 120), hash: String(schema.hash) },
    result: { status: String(result.status), errors: messages(result.errors || [], 'Erorile'),
      warnings: messages(result.warnings || [], 'Avertismentele'), fullOutput, fullOutputHash: sha(fullOutput) },
    validatedAt: new Date(row.validatedAt || new Date().toISOString()).toISOString(),
    fiscalRulesHash,
    ruleSetId: String(row.ruleSetId || artifact.ruleSetId || ''),
    recordedBy: { actorId: auth.actorId == null ? null : auth.actorId,
      username: String(auth.username || '').slice(0, 120), role: String(auth.role || '').slice(0, 80) },
  };
  return Object.freeze(Object.assign({}, body, { proofHash: proofHash(body) }));
}

function integrityIssues(proof, artifact, fiscalRulesHash) {
  const p = proof || {}; const out = [];
  const body = Object.assign({}, p); delete body.proofHash;
  if (Number(p.schemaVersion) !== 1 || p.proofHash !== proofHash(body)) out.push('amprenta dovezii este invalidă');
  if (!artifact || p.artifactHash !== artifact.sha256 || Number(p.artifactBytes) !== Number(artifact.bytes)) out.push('dovada aparține altui artefact');
  if (p.result && p.result.fullOutputHash !== sha(String(p.result.fullOutput || ''))) out.push('rezultatul complet a fost modificat');
  if (String(p.fiscalRulesHash || '') !== String(fiscalRulesHash || '')) out.push('regulile fiscale s-au schimbat după validare');
  if (!p.validator || !p.schema || !/^[0-9a-f]{64}$/.test(String(p.validator.distributionHash || ''))
      || !/^[0-9a-f]{64}$/.test(String(p.schema.hash || ''))) out.push('validatorul sau schema nu sunt identificați complet');
  return out;
}

function issues(proof, artifact, fiscalRulesHash) {
  const out = integrityIssues(proof, artifact, fiscalRulesHash); const p = proof || {};
  if (!p.result || p.result.status !== 'valid' || (p.result.errors || []).length) out.push('validatorul nu a acceptat artefactul');
  return out;
}

module.exports = { MAX_FULL_OUTPUT_BYTES, canonical, sha, proofHash, create, integrityIssues, issues };
