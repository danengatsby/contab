'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./fiscalConfig');
const CASES = require('./fiscalReviewCases');
const { validIsoDate } = require('./util');

const ROOT = path.join(__dirname, '..');
const DEFAULT_APPROVALS = path.join(__dirname, 'fiscalReviewApprovals.json');
const DEFAULT_TRUST = path.join(__dirname, 'fiscalReviewTrust.json');
const APPROVAL_SCHEMA = 2;
const TRUST_SCHEMA = 1;
const MINIMUM_CASES = 25;
const SIGNATURE_DOMAIN = 'CONTABO-FISCAL-REVIEW-V2';
const REQUIRED = [
  'reviewer', 'credential', 'reviewedAt', 'legalBasis', 'evidenceDocumentSha256',
  'keyId', 'signature', 'hash',
];
const SOURCE_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.json', '.html', '.css', '.xml', '.xsd', '.sql', '.sh',
]);
const SOURCE_DIRECTORIES = ['src', 'public', 'scripts', 'test'];
const SOURCE_ROOT_FILES = ['server.js', 'package.json', 'package-lock.json'];
const SOURCE_RULE_FILES = ['docs/dosar-revizie-fiscala.md', 'docs/guvernanta-fiscala.md'];
const MANIFEST_EXCLUSIONS = new Set([
  'src/fiscalReviewApprovals.json',
  'src/fiscalReviewTrust.json',
  'src/fiscalAutonomyApprovals.json',
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

function relativePath(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function registryExclusions(root) {
  const excluded = new Set(MANIFEST_EXCLUSIONS);
  const configured = [process.env.CONTAB_FISCAL_REVIEW_FILE, process.env.CONTAB_FISCAL_REVIEW_TRUST_FILE,
    process.env.CONTAB_FISCAL_AUTONOMY_APPROVALS_FILE]
    .filter(Boolean).map((file) => path.resolve(file));
  for (const absolute of configured) {
    const rel = relativePath(root, absolute);
    if (rel && rel !== '..' && !rel.startsWith('../')) excluded.add(rel);
  }
  return excluded;
}

function collectSourceFiles(root) {
  const found = new Set();
  const excluded = registryExclusions(root);
  function walk(absolute) {
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(absolute, name));
      return;
    }
    if (!stat.isFile()) return;
    const rel = relativePath(root, absolute);
    if (!excluded.has(rel) && SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase())) found.add(rel);
  }
  for (const rel of SOURCE_DIRECTORIES) walk(path.join(root, rel));
  for (const rel of [...SOURCE_ROOT_FILES, ...SOURCE_RULE_FILES]) {
    const absolute = path.join(root, rel);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()) found.add(rel);
  }
  return [...found].sort();
}

/**
 * Inventarul automat al codului executabil, regulilor, testelor fiscale și dependențelor.
 * Fișierele cu aprobări și chei sunt excluse ca să nu creeze o amprentă autoreferențială.
 */
function sourceManifest(options) {
  const root = path.resolve((options && options.root) || ROOT);
  const errors = [];
  let files = [];
  try { files = collectSourceFiles(root); }
  catch (e) { errors.push('Inventarul surselor nu poate fi citit: ' + e.message); }
  const entries = files.map((rel) => {
    try {
      const content = fs.readFileSync(path.join(root, rel));
      return { path: rel, bytes: content.length, sha256: sha(content) };
    } catch (e) {
      errors.push(rel + ': ' + e.message);
      return { path: rel, bytes: null, sha256: 'UNREADABLE' };
    }
  });
  return { schemaVersion: 1, rootHash: sha(stableJson(entries)), files: entries.length, errors, entries };
}

/** Configurația efectiv folosită de calcule, inclusiv suprascrierile din Setări. */
function runtimeRulesSnapshot(explicit) {
  const rates = explicit || require('./fiscal').registrySnapshot();
  const values = stableValue(rates);
  return { schemaVersion: 1, hash: sha(stableJson(values)), values };
}

function reviewContext(options) {
  const o = options || {};
  const manifest = o.manifest || sourceManifest(o.manifestOptions);
  const rules = o.runtimeRulesSnapshot || runtimeRulesSnapshot(o.runtimeRules);
  return { manifest, rules };
}

/**
 * Amprenta aprobată: definiția cazului + întregul manifest fiscal + regulile active.
 * Orice adăugare, ștergere sau modificare în domeniul sursă invalidează toate aprobările.
 */
function currentHash(meta, explicitContext) {
  const c = typeof meta === 'string' ? CASES.find((x) => x.id === meta) : meta;
  if (!c) return null;
  const context = explicitContext || reviewContext();
  const payload = {
    schemaVersion: APPROVAL_SCHEMA,
    caseId: c.id,
    definitionHash: c.definitionHash,
    fiscalSet: { year: cfg.AN, updatedAt: cfg.DATA_ACTUALIZARE },
    sourceManifestHash: context.manifest.rootHash,
    runtimeRulesHash: context.rules.hash,
  };
  return sha(stableJson(payload));
}

function readJson(file, kind, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return Object.assign({}, fallback, { _error: kind + ' nu poate fi citit: ' + file + ' (' + e.message + ')' });
  }
}

function readBundle(explicit) {
  const file = process.env.CONTAB_FISCAL_REVIEW_FILE
    ? path.resolve(process.env.CONTAB_FISCAL_REVIEW_FILE) : DEFAULT_APPROVALS;
  const parsed = explicit && typeof explicit === 'object'
    ? explicit : readJson(file, 'Fișierul aprobărilor externe', { schemaVersion: APPROVAL_SCHEMA, approvals: {} });
  if (!parsed || parsed.schemaVersion !== APPROVAL_SCHEMA || !parsed.approvals
      || typeof parsed.approvals !== 'object' || Array.isArray(parsed.approvals)) {
    return { schemaVersion: APPROVAL_SCHEMA, approvals: {},
      _error: 'Fișierul aprobărilor externe trebuie să folosească schemaVersion ' + APPROVAL_SCHEMA + ': ' + file };
  }
  return parsed;
}

function readTrust(explicit) {
  const file = process.env.CONTAB_FISCAL_REVIEW_TRUST_FILE
    ? path.resolve(process.env.CONTAB_FISCAL_REVIEW_TRUST_FILE) : DEFAULT_TRUST;
  const parsed = explicit && typeof explicit === 'object'
    ? explicit : readJson(file, 'Registrul cheilor revizorilor', { schemaVersion: TRUST_SCHEMA, reviewers: {} });
  if (!parsed || parsed.schemaVersion !== TRUST_SCHEMA || !parsed.reviewers
      || typeof parsed.reviewers !== 'object' || Array.isArray(parsed.reviewers)) {
    return { schemaVersion: TRUST_SCHEMA, reviewers: {},
      _error: 'Registrul cheilor revizorilor trebuie să folosească schemaVersion ' + TRUST_SCHEMA + ': ' + file };
  }
  return parsed;
}

function publicKeyId(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Cheia trebuie să fie Ed25519.');
  return sha(key.export({ type: 'spki', format: 'der' }));
}

function signedPayload(caseId, approval) {
  return {
    domain: SIGNATURE_DOMAIN,
    schemaVersion: APPROVAL_SCHEMA,
    caseId,
    decision: String(approval.decision || ''),
    fiscalYear: Number(approval.fiscalYear),
    reviewer: String(approval.reviewer || ''),
    credential: String(approval.credential || ''),
    reviewedAt: String(approval.reviewedAt || ''),
    legalBasis: String(approval.legalBasis || ''),
    evidenceDocumentSha256: String(approval.evidenceDocumentSha256 || '').toLowerCase(),
    hash: String(approval.hash || '').toLowerCase(),
    keyId: String(approval.keyId || '').toLowerCase(),
  };
}

function signatureMessage(caseId, approval) {
  return SIGNATURE_DOMAIN + '\n' + stableJson(signedPayload(caseId, approval));
}

function invalid(meta, hash, approval, reason) {
  return { id: meta.id, status: 'invalid', currentHash: hash, approval, reason };
}

function inspectCase(meta, bundle, trust, today, context) {
  const approval = (bundle.approvals || {})[meta.id] || null;
  const hash = currentHash(meta, context);
  if (!approval) return { id: meta.id, status: 'pending', currentHash: hash, reason: 'Fără aprobare externă.' };
  const missing = REQUIRED.filter((key) => !String(approval[key] || '').trim());
  if (missing.length) return invalid(meta, hash, approval, 'Aprobarea nu conține: ' + missing.join(', ') + '.');
  const nonStrings = REQUIRED.filter((key) => typeof approval[key] !== 'string');
  if (nonStrings.length) return invalid(meta, hash, approval, 'Câmpurile aprobării trebuie să fie text: ' + nonStrings.join(', ') + '.');
  if (approval.reviewer.length > 200 || approval.credential.length > 500 || approval.legalBasis.length > 8000) {
    return invalid(meta, hash, approval, 'Câmpurile de identitate sau temei depășesc limitele registrului.');
  }
  if (approval.decision !== 'approved') return invalid(meta, hash, approval, 'Verdictul extern nu este „approved”.');
  if (!validIsoDate(String(approval.reviewedAt)) || String(approval.reviewedAt) > today) {
    return invalid(meta, hash, approval, 'Data reviziei este invalidă sau în viitor.');
  }
  if (Number(approval.fiscalYear) !== Number(cfg.AN)) {
    return invalid(meta, hash, approval, 'Aprobarea este pentru alt set fiscal decât ' + cfg.AN + '.');
  }
  if (!/^[0-9a-f]{64}$/i.test(String(approval.evidenceDocumentSha256))) {
    return invalid(meta, hash, approval, 'Amprenta SHA-256 a dosarului semnat este invalidă.');
  }
  if (!/^[0-9a-f]{64}$/i.test(String(approval.keyId))) {
    return invalid(meta, hash, approval, 'Identificatorul cheii revizorului este invalid.');
  }
  if (String(approval.hash).toLowerCase() !== hash) {
    return invalid(meta, hash, approval, 'Codul, regula, configurația activă sau cazul s-a schimbat după aprobare.');
  }

  const keyId = String(approval.keyId).toLowerCase();
  const reviewer = (trust.reviewers || {})[keyId];
  if (!reviewer) return invalid(meta, hash, approval, 'Cheia semnatarului nu este autorizată în registrul revizorilor.');
  if (String(reviewer.reviewer || '') !== String(approval.reviewer)
      || String(reviewer.credential || '') !== String(approval.credential)) {
    return invalid(meta, hash, approval, 'Identitatea sau calitatea revizorului nu corespunde cheii autorizate.');
  }
  if (!validIsoDate(String(reviewer.credentialVerifiedAt || ''))
      || String(reviewer.credentialVerifiedAt) > today
      || !String(reviewer.credentialEvidence || '').trim()) {
    return invalid(meta, hash, approval, 'Calitatea profesională nu are o verificare datată și o dovadă în registrul de încredere.');
  }
  if (reviewer.revokedAt) return invalid(meta, hash, approval, 'Cheia revizorului este revocată.');
  if (reviewer.validFrom && (!validIsoDate(String(reviewer.validFrom)) || approval.reviewedAt < reviewer.validFrom)) {
    return invalid(meta, hash, approval, 'Cheia revizorului nu era valabilă la data reviziei.');
  }
  if (reviewer.validUntil && (!validIsoDate(String(reviewer.validUntil)) || approval.reviewedAt > reviewer.validUntil)) {
    return invalid(meta, hash, approval, 'Cheia revizorului era expirată la data reviziei.');
  }
  try {
    if (publicKeyId(reviewer.publicKeyPem) !== keyId) {
      return invalid(meta, hash, approval, 'Cheia publică nu corespunde identificatorului din registru.');
    }
    const signature = String(approval.signature);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)
        || !crypto.verify(null, Buffer.from(signatureMessage(meta.id, approval), 'utf8'),
          crypto.createPublicKey(reviewer.publicKeyPem), Buffer.from(signature, 'base64'))) {
      return invalid(meta, hash, approval, 'Semnătura criptografică a aprobării este invalidă.');
    }
  } catch (e) {
    return invalid(meta, hash, approval, 'Cheia sau semnătura revizorului nu poate fi verificată: ' + e.message);
  }
  return { id: meta.id, status: 'approved', currentHash: hash, approval };
}

function status(explicitBundle, options) {
  const o = options || {};
  const bundle = readBundle(explicitBundle);
  const trust = readTrust(o.trustBundle);
  const context = o.context || reviewContext(o);
  const today = o.today || new Date().toISOString().slice(0, 10);
  const cases = CASES.map((c) => inspectCase(c, bundle, trust, today, context));
  const approved = cases.filter((c) => c.status === 'approved').length;
  const invalidCount = cases.filter((c) => c.status === 'invalid').length;
  const pending = cases.filter((c) => c.status === 'pending').length;
  const known = new Set(CASES.map((c) => c.id));
  const unexpectedApprovals = Object.keys(bundle.approvals || {}).filter((id) => !known.has(id)).sort();
  const completeReleaseSet = cases.length >= MINIMUM_CASES;
  const configErrors = [bundle._error, trust._error].filter(Boolean);
  if ((context.manifest.errors || []).length) configErrors.push('Manifestul surselor are erori: ' + context.manifest.errors.join(' | '));
  if (!completeReleaseSet) configErrors.push('Setul de lansare are numai ' + cases.length + ' cazuri; minimul este ' + MINIMUM_CASES + '.');
  if (unexpectedApprovals.length) configErrors.push('Registrul conține cazuri necunoscute: ' + unexpectedApprovals.join(', ') + '.');
  return {
    // Compatibilitate: `ready` continua sa pazeasca depunerea si inchiderea anuala. Nu este si nu
    // trebuie reutilizat drept verdict de autonomie; aceea este o poarta separata.
    ready: completeReleaseSet && approved === cases.length && !configErrors.length,
    releaseReady: completeReleaseSet && approved === cases.length && !configErrors.length,
    gateKind: 'release',
    autonomyEvidence: false,
    fiscalYear: cfg.AN,
    fiscalUpdatedAt: cfg.DATA_ACTUALIZARE,
    approved,
    pending,
    invalid: invalidCount,
    total: cases.length,
    minimumCases: MINIMUM_CASES,
    configError: configErrors.join(' ') || null,
    unexpectedApprovals,
    sourceManifestHash: context.manifest.rootHash,
    sourceFiles: context.manifest.files,
    runtimeRulesHash: context.rules.hash,
    signatureScheme: 'Ed25519, cheie publică autorizată separat',
    cases,
    positioning: 'Poartă de lansare/depunere cu validare umană. Cele 25 de cazuri nu reprezintă corpus de autonomie.',
  };
}

function assertReady(operation) {
  const s = status();
  if (s.ready) return s;
  const e = new Error('Revizia fiscală externă nu este completă pentru setul ' + s.fiscalYear + ': '
    + s.approved + '/' + s.total + ' cazuri aprobate'
    + (s.invalid ? ', ' + s.invalid + ' aprobări invalidate' : '') + '. '
    + 'Operațiunea „' + (operation || 'depunere fiscală') + '” rămâne blocată. '
    + 'Aplicația poate fi folosită ca asistent contabil, cu validare umană, dar nu ca garanție fiscală.');
  e.status = 409;
  e.code = 'FISCAL_REVIEW_REQUIRED';
  e.review = s;
  throw e;
}

function template(id) {
  const meta = CASES.find((c) => c.id === id);
  if (!meta) return null;
  return {
    decision: 'approved',
    fiscalYear: cfg.AN,
    reviewer: '',
    credential: '',
    reviewedAt: '',
    legalBasis: '',
    evidenceDocumentSha256: '',
    keyId: '',
    signature: '',
    hash: currentHash(meta),
  };
}

module.exports = {
  APPROVAL_SCHEMA, TRUST_SCHEMA, MINIMUM_CASES, SIGNATURE_DOMAIN,
  CASES, DEFAULT_APPROVALS, DEFAULT_TRUST, REQUIRED,
  stableJson, sourceManifest, runtimeRulesSnapshot, reviewContext, currentHash,
  readBundle, readTrust, publicKeyId, signedPayload, signatureMessage,
  status, assertReady, template,
};
