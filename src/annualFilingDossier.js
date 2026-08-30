'use strict';

// Dosarul de DEPUNERE al situatiilor financiare este distinct de arhiva contabila generala.
// Aici se pastreaza probele exacte care au intrat in pachetul electronic: fiecare document are
// SHA-256, declaratia semnaturii si o aprobare legata criptografic de acei octeti. Matricea este
// fail-closed: lipsa unei probe sau imposibilitatea stabilirii obligatiei de audit blocheaza
// sigilarea dosarului anual, nu este convertita intr-o bifa implicita.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const balanceCategory = require('./balanceCategory');
const integrity = require('./annualArchiveIntegrity');
const { validIsoDate } = require('./util');

const MAX_SUBMISSION_BYTES = Math.floor(9.5 * 1024 * 1024);
const MAX_ZIP_ENTRIES = 100;
const MAX_ZIP_UNCOMPRESSED = 50 * 1024 * 1024;
const AUDIT_LIMITS = { totalActive: 16000000, cifraAfaceri: 32000000, numarMediuSalariati: 50 };
const SIGNATURE_TYPES = new Set(['handwritten_scan', 'qualified_electronic', 'advanced_electronic']);

const DEFINITIONS = [
  { kind: 'administrators_report', label: 'Raportul administratorilor', requiredInZip: true,
    signatureRequired: true, basis: 'OMF 2.036/2025, anexa nr. 1, pct. 3.5 alin. (1)' },
  { kind: 'art30_declaration', label: 'Declarația scrisă prevăzută de art. 30', requiredInZip: true,
    signatureRequired: true, basis: 'Legea contabilității nr. 82/1991, art. 30; OMF 2.036/2025, anexa nr. 1, pct. 3.5 alin. (3)' },
  { kind: 'result_allocation_proposal', label: 'Propunerea de distribuire a profitului / acoperire a pierderii', requiredInZip: true,
    signatureRequired: true, basis: 'OMF 2.036/2025, anexa nr. 1, pct. 3.5 alin. (3)' },
  { kind: 'aga_resolution', label: 'Hotărârea AGA / decizia asociatului unic de aprobare', requiredInZip: false,
    signatureRequired: true, basis: 'Legea societăților nr. 31/1990, art. 111/194; OMF 2.036/2025, anexa nr. 1, pct. 1.7' },
  { kind: 'audit_report', label: 'Raportul auditorului financiar', requiredInZip: true,
    signatureRequired: true, conditional: 'audit', basis: 'OMFP 1.802/2014, pct. 563; OMF 2.036/2025, anexa nr. 1, pct. 3.5 alin. (1)' },
  { kind: 'censors_report', label: 'Raportul comisiei de cenzori', requiredInZip: true,
    signatureRequired: true, conditional: 'censors', basis: 'OMFP 1.802/2014, pct. 563 alin. (3); OMF 2.036/2025, anexa nr. 1, pct. 3.5 alin. (1)' },
  { kind: 'signed_first_page', label: 'Prima pagină a situațiilor financiare, semnată', requiredInZip: true,
    signatureRequired: true, basis: 'OMF 2.036/2025, anexa nr. 1, pct. 1.8 alin. (1)' },
  { kind: 'submitted_zip', label: 'Fișierul ZIP exact atașat și transmis', requiredInZip: false,
    signatureRequired: false, basis: 'OMF 2.036/2025, anexa nr. 1, pct. 1.8 și pct. 6.1' },
];
const BY_KIND = new Map(DEFINITIONS.map((x) => [x.kind, x]));

const LEGAL_BASIS = [
  { title: 'OMF nr. 2.036/2025', url: 'https://legislatie.just.ro/Public/DetaliiDocument/306521',
    scope: 'întocmirea și depunerea situațiilor financiare aferente exercițiului 2025' },
  { title: 'Instrucțiuni ANAF S1002–S1005 pentru 2025',
    url: 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/situatiifinanciare/2025/1002_5_2025.html',
    scope: 'conținutul ZIP-ului anexat' },
];

function fail(status, message, code) {
  const error = new Error(message); error.status = status; if (code) error.code = code; throw error;
}

function reqYear(value) {
  const year = String(value || '');
  if (!/^[1-9]\d{3}$/.test(year)) fail(400, 'Anul trebuie să aibă forma YYYY.');
  return year;
}

function canonicalHash(value) {
  return integrity.sha256(Buffer.from(JSON.stringify(integrity.canonical(value)), 'utf8'));
}

function validFilingBinding(binding) {
  return !!(binding && binding.submissionId
    && /^[0-9a-f]{64}$/i.test(String(binding.submissionHash || ''))
    && /^[0-9a-f]{64}$/i.test(String(binding.submittedArtifactHash || '')));
}

function evidenceIdentity(meta) {
  return {
    schemaVersion: 1,
    year: String(meta.year),
    kind: String(meta.kind),
    documentId: String(meta.documentId),
    revision: Number(meta.revision),
    fileName: String(meta.fileName),
    mime: String(meta.mime || 'application/octet-stream'),
    bytes: Number(meta.bytes),
    fileSha256: String(meta.fileSha256),
    signature: meta.signature || null,
    uploadedAt: String(meta.uploadedAt),
    uploadedBy: meta.uploadedBy == null ? null : Number(meta.uploadedBy),
    uploadedByName: String(meta.uploadedByName || ''),
    filingBinding: meta.filingBinding || null,
  };
}

function approvalIdentity(meta, approval) {
  return {
    evidenceHash: String(meta.evidenceHash),
    approvedAt: String(approval.approvedAt),
    approvedBy: approval.approvedBy == null ? null : Number(approval.approvedBy),
    approvedByName: String(approval.approvedByName || ''),
    approvedRole: String(approval.approvedRole || ''),
    statement: String(approval.statement || ''),
  };
}

function createEvidence(input) {
  const i = input || {}; const year = reqYear(i.year); const kind = String(i.kind || '');
  const definition = BY_KIND.get(kind);
  if (!definition) fail(400, 'Tip de anexă necunoscut.', 'ANNUAL_FILING_KIND_INVALID');
  const bytes = Buffer.isBuffer(i.buffer) ? i.buffer : Buffer.from(i.buffer || '');
  if (!bytes.length) fail(400, 'Fișierul anexei este gol.');
  if (bytes.length > MAX_SUBMISSION_BYTES) {
    fail(400, 'Fișierul depășește limita de 9,5 MB a pachetului electronic.', 'ANNUAL_FILING_FILE_TOO_LARGE');
  }
  const ext = path.extname(String(i.fileName || '')).toLowerCase();
  if (kind === 'submitted_zip') {
    if (ext !== '.zip') fail(400, 'Pachetul transmis trebuie încărcat ca fișier .zip.');
    inspectZip(bytes); // respinge parola, duplicatele, traversarea si arhivele expansioniste
  } else if (ext !== '.pdf') {
    fail(400, 'Anexele dosarului se păstrează în forma PDF scanată/transmisă.');
  }
  let signature = null;
  if (definition.signatureRequired) {
    const signedBy = String(i.signedBy || '').trim();
    const signedAt = String(i.signedAt || '').trim();
    const signatureType = String(i.signatureType || '').trim();
    if (signedBy.length < 3) fail(400, 'Completează persoana/persoanele care au semnat documentul.');
    if (!validIsoDate(signedAt)) {
      fail(400, 'Data semnării trebuie să aibă forma YYYY-MM-DD.');
    }
    if (!SIGNATURE_TYPES.has(signatureType)) fail(400, 'Alege forma semnăturii documentului.');
    signature = { signedBy: signedBy.slice(0, 300), signedAt, type: signatureType,
      verification: 'declarată de operator; validarea criptografică a semnăturii PDF nu este efectuată de aplicație' };
  }
  const meta = {
    schemaVersion: 1, year, kind, documentId: String(i.documentId), revision: Number(i.revision) || 1,
    fileName: path.basename(String(i.fileName || 'document')), mime: String(i.mime || 'application/octet-stream').slice(0, 100),
    bytes: bytes.length, fileSha256: integrity.sha256(bytes), signature,
    uploadedAt: String(i.uploadedAt || new Date().toISOString()),
    uploadedBy: i.uploadedBy == null ? null : Number(i.uploadedBy),
    uploadedByName: String(i.uploadedByName || '').slice(0, 100),
    filingBinding: i.filingBinding || null, approval: null,
  };
  if (kind === 'submitted_zip' && !validFilingBinding(meta.filingBinding)) {
    fail(409, 'ZIP-ul exact trebuie legat de o depunere verificabilă a bilanțului.', 'ANNUAL_FILING_SUBMISSION_BINDING_REQUIRED');
  }
  meta.evidenceHash = canonicalHash(evidenceIdentity(meta));
  return meta;
}

function approveEvidence(meta, actor, role, at) {
  if (!meta || !meta.evidenceHash) fail(409, 'Proba nu are o identitate verificabilă.');
  const approval = {
    evidenceHash: meta.evidenceHash,
    approvedAt: at || new Date().toISOString(),
    approvedBy: actor && actor.id != null ? Number(actor.id) : null,
    approvedByName: String(actor && actor.username || '').slice(0, 100),
    approvedRole: String(role || '').slice(0, 50),
    statement: 'Am verificat documentul exact identificat prin SHA-256 și îl aprob pentru dosarul situațiilor financiare.',
  };
  approval.approvalHash = canonicalHash(approvalIdentity(meta, approval));
  return approval;
}

function inspectZip(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch (error) {
    fail(400, 'Fișierul ZIP nu poate fi deschis: ' + error.message, 'ANNUAL_FILING_ZIP_INVALID');
  }
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (!entries.length) fail(400, 'Fișierul ZIP transmis este gol.', 'ANNUAL_FILING_ZIP_EMPTY');
  if (entries.length > MAX_ZIP_ENTRIES) fail(400, 'Fișierul ZIP are prea multe intrări.');
  const names = new Set(); let total = 0; const out = [];
  for (const entry of entries) {
    const name = String(entry.entryName || '').replace(/\\/g, '/');
    const normal = path.posix.normalize(name);
    if (!name || name.startsWith('/') || normal === '..' || normal.startsWith('../') || /^[A-Za-z]:/.test(name)) {
      fail(400, 'Cale nesigură în ZIP: ' + name, 'ANNUAL_FILING_ZIP_PATH_INVALID');
    }
    const key = normal.toLowerCase();
    if (names.has(key)) fail(400, 'Nume duplicat în ZIP: ' + normal, 'ANNUAL_FILING_ZIP_DUPLICATE');
    names.add(key);
    if (entry.header && (entry.header.encrypted || (Number(entry.header.flags) & 1))) {
      fail(400, 'Fișierul ZIP transmis nu poate fi protejat cu parolă.', 'ANNUAL_FILING_ZIP_ENCRYPTED');
    }
    const declared = Number(entry.header && entry.header.size) || 0;
    total += declared;
    if (total > MAX_ZIP_UNCOMPRESSED) fail(400, 'Conținutul necomprimat al ZIP-ului depășește limita de siguranță.');
    let bytes;
    try { bytes = entry.getData(); } catch (error) {
      fail(400, 'Intrarea ' + normal + ' nu poate fi citită: ' + error.message, 'ANNUAL_FILING_ZIP_ENTRY_INVALID');
    }
    if (bytes.length !== declared) fail(400, 'Dimensiunea declarată nu coincide pentru ' + normal + '.');
    out.push({ path: normal, bytes: bytes.length, sha256: integrity.sha256(bytes) });
  }
  return { entries: out, bytes: buffer.length, uncompressedBytes: total };
}

function currentEvidenceDocuments(view, year) {
  year = reqYear(year); const byKind = new Map(); const duplicateKinds = [];
  const docs = (view.documents || []).filter((doc) => doc && doc.annualFilingEvidence
    && String(doc.annualFilingEvidence.year) === year && !doc.annualFilingEvidence.supersededBy);
  for (const doc of docs) {
    const kind = String(doc.annualFilingEvidence.kind || '');
    if (!BY_KIND.has(kind)) continue;
    const previous = byKind.get(kind);
    if (previous) {
      duplicateKinds.push(kind);
      const a = Number(previous.annualFilingEvidence.revision) || 0;
      const b = Number(doc.annualFilingEvidence.revision) || 0;
      if (b > a || (b === a && String(doc.id).localeCompare(String(previous.id)) > 0)) byKind.set(kind, doc);
    } else byKind.set(kind, doc);
  }
  return { byKind, duplicateKinds: [...new Set(duplicateKinds)] };
}

function evidenceFile(doc, uploadDir) {
  const stored = path.basename(String(doc && doc.storedName || ''));
  if (!stored || !uploadDir) return { ok: false, reason: 'binarul exact nu are o cale de stocare' };
  const filePath = path.join(uploadDir, stored);
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'binarul exact lipsește din stocare' };
  let buffer;
  try { buffer = fs.readFileSync(filePath); } catch (error) { return { ok: false, reason: 'binarul exact nu poate fi citit' }; }
  return { ok: true, buffer, filePath };
}

function verifyDocument(doc, uploadDir, opts) {
  opts = opts || {};
  const meta = doc && doc.annualFilingEvidence;
  if (!meta || Number(meta.schemaVersion) !== 1 || !BY_KIND.has(String(meta.kind || ''))) {
    return { ok: false, reason: 'metadatele probei sunt invalide' };
  }
  if (String(meta.documentId) !== String(doc.id) || String(meta.fileName) !== String(doc.fileName)
    || String(meta.uploadedAt) !== String(doc.uploadedAt)) {
    return { ok: false, reason: 'identitatea probei nu coincide cu documentul din registru' };
  }
  const source = evidenceFile(doc, uploadDir);
  if (!source.ok) return source;
  const actualHash = integrity.sha256(source.buffer);
  if (actualHash !== String(meta.fileSha256 || '') || actualHash !== String(doc.sha256 || '')
    || source.buffer.length !== Number(meta.bytes) || source.buffer.length !== Number(doc.bytes)) {
    return { ok: false, reason: 'SHA-256 sau dimensiunea nu coincide cu binarul păstrat' };
  }
  if (canonicalHash(evidenceIdentity(meta)) !== String(meta.evidenceHash || '')) {
    return { ok: false, reason: 'identitatea metadatelor nu coincide cu evidenceHash' };
  }
  if (meta.kind === 'submitted_zip' && !validFilingBinding(meta.filingBinding)) {
    return { ok: false, reason: 'legătura ZIP-ului cu depunerea bilanțului este invalidă' };
  }
  if (meta.kind === 'submitted_zip' && opts.filingBinding
    && canonicalHash(meta.filingBinding) !== canonicalHash(opts.filingBinding)) {
    return { ok: false, reason: 'ZIP-ul este legat de altă depunere decât ultima depunere a bilanțului' };
  }
  const definition = BY_KIND.get(meta.kind);
  if (definition.signatureRequired && (!meta.signature || !meta.signature.signedBy
    || !meta.signature.signedAt || !SIGNATURE_TYPES.has(String(meta.signature.type)))) {
    return { ok: false, reason: 'declarația semnăturii este incompletă' };
  }
  const approval = meta.approval;
  if (opts.requireApproval !== false && (!approval || approval.evidenceHash !== meta.evidenceHash
    || canonicalHash(approvalIdentity(meta, approval)) !== String(approval.approvalHash || ''))) {
    return { ok: false, reason: 'aprobarea lipsește sau nu este legată de hash-ul probei' };
  }
  let zip = null;
  if (meta.kind === 'submitted_zip') {
    try { zip = inspectZip(source.buffer); } catch (error) { return { ok: false, reason: error.message }; }
  }
  return { ok: true, buffer: source.buffer, sha256: actualHash, zip };
}

function filingBindingFor(globalDb, firmaId, year) {
  year = reqYear(year);
  const dossier = ((globalDb && globalDb.declarations) || []).find((record) => Number(record.firmaId) === Number(firmaId)
    && record.tip === 'bilant' && String(record.period) === year + '-12');
  if (!dossier || dossier.status !== 'depusa') return null;
  const submissions = Array.isArray(dossier.depuneri) ? dossier.depuneri.slice() : [];
  const submission = submissions.sort((a, b) => Number(a.ordinal || 0) - Number(b.ordinal || 0)).pop();
  if (!submission) return null;
  const binding = {
    dossierId: dossier.dossier && dossier.dossier.id || dossier.id || null,
    submissionId: String(submission.submissionId), submissionHash: String(submission.submissionHash),
    submittedArtifactHash: String(submission.submittedArtifactHash || submission.artifactHash),
    ordinal: Number(submission.ordinal) || submissions.length,
    receiptReference: String(submission.recipisa || ''),
    boundAt: String(submission.depusaLa || submission.submittedAt || ''),
  };
  return validFilingBinding(binding) ? binding : null;
}

function knownIndicators(indicators) {
  return indicators && ['totalActive', 'cifraAfaceri', 'numarMediuSalariati']
    .every((key) => Number.isFinite(Number(indicators[key])));
}

function aboveAuditLimits(indicators) {
  if (!knownIndicators(indicators)) return null;
  return Object.keys(AUDIT_LIMITS).filter((key) => Number(indicators[key]) > AUDIT_LIMITS[key]).length;
}

function reportingContext(view, year) {
  const company = view.company || {}; const type = company.tipEntitate === 'pfa' ? 'pfa' : 'societate';
  if (type === 'pfa') return { type, category: null, auditRequired: false, censorsRequired: false,
    auditReason: 'PFA nu depune situațiile financiare anuale ale societăților din această matrice.', blockers: [] };
  const history = view.balanceCategoryHistory || view.balance_category_history || [];
  const confirmation = balanceCategory.confirmationFor(history, year);
  const blockers = [];
  if (!confirmation) blockers.push('Categoria contabilă nu este confirmată pentru exercițiul ' + year + '.');
  const category = confirmation && confirmation.category || null;
  const current = confirmation && confirmation.indicators;
  const previous = confirmation && confirmation.previousIndicators;
  const currentAbove = aboveAuditLimits(current); const previousAbove = aboveAuditLimits(previous);
  const thresholdAudit = currentAbove == null || previousAbove == null ? null : currentAbove >= 2 && previousAbove >= 2;
  const mediumLargeAudit = category === 'mare';
  const declaredAudit = String(company.auditStatut || '3');
  const auditRequired = mediumLargeAudit || thresholdAudit === true || declaredAudit === '1';
  const censorsRequired = !auditRequired && declaredAudit === '2';
  let auditReason = declaredAudit === '1' ? 'Situațiile sunt declarate auditate.'
    : mediumLargeAudit ? 'Entitățile mijlocii și mari sunt supuse auditului statutar.'
      : thresholdAudit === true ? 'Cel puțin două praguri de audit sunt depășite în două exerciții consecutive.'
        : thresholdAudit === false ? 'Pragurile de audit nu sunt depășite în două exerciții consecutive.'
          : 'Datele pe două exerciții nu permit stabilirea obligației de audit.';
  if (thresholdAudit == null && !mediumLargeAudit && declaredAudit !== '1') {
    blockers.push('Obligația de audit nu poate fi determinată: lipsesc indicatori compleți pentru două exerciții consecutive.');
  }
  if ((mediumLargeAudit || thresholdAudit === true) && declaredAudit !== '1') {
    blockers.push('Statutul de audit al firmei contrazice categoria/pragurile: configurează „Auditate de auditor financiar”.');
  }
  return {
    type, category, declaredAudit, auditRequired, censorsRequired, auditReason, thresholdAudit,
    auditThresholds: AUDIT_LIMITS, auditIndicators: { current, previous, currentAbove, previousAbove }, blockers,
  };
}

function requiredDefinition(definition, context) {
  if (context.type === 'pfa') return false;
  if (definition.conditional === 'audit') return context.auditRequired;
  if (definition.conditional === 'censors') return context.censorsRequired;
  return true;
}

function status(view, year, opts) {
  year = reqYear(year); opts = opts || {};
  const context = reportingContext(view || {}, year);
  const selected = currentEvidenceDocuments(view || {}, year);
  const filingBinding = filingBindingFor(opts.globalDb, view && view.firmaId, year);
  const blockers = context.blockers.slice();
  if (selected.duplicateKinds.length) blockers.push('Există mai multe probe active pentru: ' + selected.duplicateKinds.join(', ') + '.');
  const verifiedByKind = new Map();
  const rows = DEFINITIONS.map((definition) => {
    const required = requiredDefinition(definition, context); const doc = selected.byKind.get(definition.kind) || null;
    const check = doc ? verifyDocument(doc, opts.uploadDir, {
      filingBinding: definition.kind === 'submitted_zip' ? filingBinding : null,
    }) : null;
    if (check && check.ok) verifiedByKind.set(definition.kind, { doc, check });
    const complete = !required || !!(check && check.ok);
    const meta = doc && doc.annualFilingEvidence;
    return {
      kind: definition.kind, label: definition.label, required, applicable: required || !!doc,
      requiredInZip: required && definition.requiredInZip, signatureRequired: definition.signatureRequired,
      basis: definition.basis, complete, reason: complete ? null : (check ? check.reason : 'documentul exact lipsește'),
      evidence: doc ? {
        schemaVersion: meta.schemaVersion, documentId: doc.id, fileName: doc.fileName, mime: meta.mime,
        bytes: Number(meta.bytes), sha256: meta.fileSha256, evidenceHash: meta.evidenceHash,
        revision: meta.revision, uploadedAt: meta.uploadedAt, uploadedBy: meta.uploadedBy,
        uploadedByName: meta.uploadedByName,
        signature: meta.signature || null, approval: meta.approval ? {
          evidenceHash: meta.approval.evidenceHash, approvedAt: meta.approval.approvedAt,
          approvedBy: meta.approval.approvedBy, approvedByName: meta.approval.approvedByName,
          approvedRole: meta.approval.approvedRole, statement: meta.approval.statement,
          approvalHash: meta.approval.approvalHash,
        } : null, filingBinding: meta.filingBinding || null,
      } : null,
      inSubmittedZip: definition.requiredInZip && required ? false : null,
    };
  });

  const submitted = verifiedByKind.get('submitted_zip'); let packageCheck = null;
  if (context.type !== 'pfa') {
    if (!filingBinding) blockers.push('Nu există o depunere verificabilă a bilanțului de care să fie legat ZIP-ul exact.');
    if (!submitted) packageCheck = { ok: false, reason: 'ZIP-ul exact transmis lipsește sau nu este aprobat.', missing: [] };
    else {
      const hashes = new Set(submitted.check.zip.entries.map((entry) => entry.sha256));
      const missing = [];
      for (const row of rows) {
        if (!row.requiredInZip) continue;
        const found = verifiedByKind.get(row.kind);
        row.inSubmittedZip = !!(found && hashes.has(found.check.sha256));
        if (!row.inSubmittedZip) missing.push({ kind: row.kind, label: row.label,
          sha256: found ? found.check.sha256 : null });
      }
      packageCheck = {
        ok: missing.length === 0, reason: missing.length ? 'ZIP-ul nu conține exact toate anexele obligatorii aprobate.' : null,
        missing, entries: submitted.check.zip.entries, zipSha256: submitted.check.sha256,
        bytes: submitted.check.zip.bytes, uncompressedBytes: submitted.check.zip.uncompressedBytes,
        passwordProtected: false,
      };
    }
    if (!packageCheck.ok) blockers.push(packageCheck.reason);
  }
  for (const row of rows) if (row.required && !row.complete) blockers.push(row.label + ': ' + row.reason + '.');
  const uniqueBlockers = [...new Set(blockers.filter(Boolean))];
  const matrix = {
    schemaVersion: 1, year, exerciseRules: year === '2025' ? 'OMF 2.036/2025' : 'reguli generale; ordinul anual trebuie reverificat',
    electronicOnly: Number(year) >= 2025, context, rows, package: packageCheck,
    ready: uniqueBlockers.length === 0, blockers: uniqueBlockers, legalBasis: LEGAL_BASIS,
  };
  matrix.matrixHash = canonicalHash(matrix);
  return matrix;
}

function assertReady(view, year, opts) {
  const matrix = status(view, year, opts);
  if (!matrix.ready) fail(409, 'Dosarul situațiilor financiare este incomplet: ' + matrix.blockers.join(' '),
    'ANNUAL_FILING_DOSSIER_INCOMPLETE');
  return matrix;
}

function exactEvidenceFiles(view, year, opts) {
  const matrix = assertReady(view, year, opts); const selected = currentEvidenceDocuments(view, year);
  const files = [];
  for (const row of matrix.rows) {
    if (!row.required) continue;
    const doc = selected.byKind.get(row.kind); const check = verifyDocument(doc, opts && opts.uploadDir, {
      filingBinding: row.kind === 'submitted_zip'
        ? filingBindingFor(opts && opts.globalDb, view && view.firmaId, year) : null,
    });
    if (!check.ok) fail(409, row.label + ': ' + check.reason);
    files.push({ kind: row.kind, label: row.label, fileName: path.basename(doc.fileName || row.kind),
      buffer: check.buffer, sha256: check.sha256, documentId: doc.id });
  }
  return { matrix, files };
}

module.exports = {
  DEFINITIONS, LEGAL_BASIS, AUDIT_LIMITS, MAX_SUBMISSION_BYTES, SIGNATURE_TYPES,
  reqYear, canonicalHash, evidenceIdentity, approvalIdentity, createEvidence, approveEvidence,
  inspectZip, currentEvidenceDocuments, verifyDocument, reportingContext, status, assertReady,
  filingBindingFor, exactEvidenceFiles,
};
