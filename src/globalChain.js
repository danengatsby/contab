'use strict';

// Verificatorul unic al dovezilor persistente. El nu mută și nu „repară” date: produce același
// verdict și aceeași rădăcină pentru același graf, indiferent de ordinea colecțiilor. Auditul
// durabil este primit ca raport verificat de apelant, ca modulul să poată valida și un db.json
// izolat (restore), fără să citească accidental jurnalul instalației vii.

const crypto = require('crypto');
const declarations = require('./declarations');
const annualIntegrity = require('./annualArchiveIntegrity');
const cash13 = require('./cashForecast13Weeks');
const fiscalProfile = require('./fiscalProfile');
const fiscalFacts = require('./fiscalFacts');
const fiscalAutonomyPolicy = require('./fiscalAutonomyPolicy');
const legislativeWorkflow = require('./legislativeWorkflow');
const { validIsoDate } = require('./util');

const SCHEMA_VERSION = 1;

function canonicalJson(value) {
  if (value == null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(String(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function issue(component, key, code, message) {
  return { component, key: String(key == null ? '' : key), code, message: String(message) };
}

function anchor(type, key, value) {
  return { type, key: String(key), hash: sha256(Buffer.from(canonicalJson(value), 'utf8')) };
}

function fiscalRows(graph, issues, missing) {
  const rows = Array.isArray(graph.fiscal_profile_history) ? graph.fiscal_profile_history
    : (Array.isArray(graph.fiscalProfileHistory) ? graph.fiscalProfileHistory : []);
  const ids = new Set();
  const byFirm = new Map();
  for (const row of rows) {
    const key = row && row.id != null ? row.id : ((row && row.firmaId) + '|' + (row && row.validFrom));
    if (!row || !validIsoDate(String(row.validFrom || '')) || !row.values
        || typeof row.values !== 'object' || Array.isArray(row.values)) {
      issues.push(issue('fiscal-profile', key, 'FISCAL_REVISION_INVALID', 'revizia nu are validFrom și fotografia completă valide'));
      continue;
    }
    if (row.id != null && ids.has(String(row.id))) {
      issues.push(issue('fiscal-profile', key, 'FISCAL_REVISION_DUPLICATE_ID', 'identitatea reviziei fiscale este duplicată'));
    }
    ids.add(String(row.id));
    if (row.recordedAt) {
      if (!fiscalProfile.recordedAtOf(row)) issues.push(issue('fiscal-profile', key,
        'FISCAL_RECORDED_AT_INVALID', 'momentul înregistrării este invalid'));
    } else if (row.createdAt && fiscalProfile.recordedAtOf(row)) {
      missing.push(issue('fiscal-profile', key, 'FISCAL_RECORDED_AT_LEGACY_ALIAS',
        'momentul există numai sub aliasul istoric createdAt, nu în recordedAt'));
    } else if (row.createdAt) {
      issues.push(issue('fiscal-profile', key, 'FISCAL_RECORDED_AT_INVALID', 'momentul înregistrării este invalid'));
    } else {
      missing.push(issue('fiscal-profile', key, 'FISCAL_RECORDED_AT_MISSING', 'momentul înregistrării nu există în datele istorice'));
    }
    if (!Object.prototype.hasOwnProperty.call(row, 'validTo')) {
      missing.push(issue('fiscal-profile', key, 'FISCAL_VALID_TO_MISSING', 'limita validTo nu este materializată în datele istorice'));
    } else if (row.validTo != null && !validIsoDate(String(row.validTo))) {
      issues.push(issue('fiscal-profile', key, 'FISCAL_VALID_TO_INVALID', 'limita validTo nu este o dată validă'));
    }
    const fid = String(row.firmaId == null ? '' : row.firmaId);
    if (!byFirm.has(fid)) byFirm.set(fid, []);
    byFirm.get(fid).push(row);
  }
  for (const [fid, firmRows] of byFirm.entries()) {
    const intervals = fiscalProfile.withIntervals(firmRows);
    const normalized = new Map(intervals.map((row) => [String(row.id), row]));
    for (const row of firmRows) {
      if (!row || row.id == null) continue;
      const expected = normalized.get(String(row.id));
      if (row.validTo != null && expected && String(row.validTo) !== String(expected.validTo)) {
        issues.push(issue('fiscal-profile', row.id, 'FISCAL_VALID_TO_INVALID',
          'validTo nu coincide cu limita exclusivă derivată din următoarea revizie a firmei ' + fid));
      }
    }
  }
  return rows;
}

/**
 * Verifică toate lanțurile istorice dintr-un graf Contab și calculează o rădăcină deterministă.
 * `missing` scade completitudinea, dar nu invalidează date legacy care nu pretind o dovadă.
 */
function verifyGraph(graph, opts) {
  opts = opts || {};
  const issues = []; const missing = []; const anchors = [];
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.firme)) {
    issues.push(issue('graph', 'db.json', 'GRAPH_INVALID', 'lipsește lista de firme'));
  }

  const dossiers = graph && Array.isArray(graph.declarations) ? graph.declarations : [];
  const validDossierRows = dossiers.filter((rec, index) => {
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) return true;
    issues.push(issue('filing-dossier', index, 'FILING_DOSSIER_ROW_INVALID', 'rândul dosarului nu este un obiect'));
    anchors.push(anchor('filing-dossier', index, rec)); return false;
  });
  try { declarations.assertUniqueDossiers({ declarations: validDossierRows }); } catch (e) {
    issues.push(issue('filing-dossier', '*', e.code || 'DUPLICATE_FILING_DOSSIER', e.message));
  }
  for (const rec of validDossierRows) {
    const identity = declarations.dossierIdentity(rec && rec.firmaId, rec && rec.tip, rec && rec.period);
    if (rec && rec.importedSourceFilingEvidence) {
      const source = Object.assign({}, rec.importedSourceFilingEvidence);
      const storedHash = String(source.evidenceHash || ''); delete source.evidenceHash;
      const actualHash = sha256(Buffer.from(canonicalJson(source), 'utf8'));
      if (!/^[0-9a-f]{64}$/.test(storedHash) || storedHash !== actualHash) {
        issues.push(issue('filing-dossier', identity.id, 'IMPORTED_FILING_EVIDENCE_INVALID',
          'dovada dosarului-sursă importat nu mai coincide cu amprenta ei'));
      }
    }
    const check = declarations.verifyDossier(rec, rec && rec.firmaId, rec && rec.tip, rec && rec.period,
      { verifyContent: opts.verifyContent !== false });
    for (const message of check.issues) issues.push(issue('filing-dossier', identity.id, 'FILING_DOSSIER_INVALID', message));
    for (const message of check.missing) missing.push(issue('filing-dossier', identity.id, 'FILING_DOSSIER_INCOMPLETE', message));
    anchors.push(anchor('filing-dossier', identity.id, rec));
  }

  const annualArchives = graph && Array.isArray(graph.annualArchives) ? graph.annualArchives : [];
  for (const row of annualArchives) {
    const key = String(row && row.firmaId) + '|' + String(row && row.year) + '|v' + String(row && row.version);
    const check = annualIntegrity.verifyStored(row, opts.annualArchiveOptions);
    if (!check.ok) issues.push(issue('annual-archive', key, 'ANNUAL_ARCHIVE_INVALID', check.reason));
    anchors.push(anchor('annual-archive', key, row));
  }

  const cashSnapshots = graph && Array.isArray(graph.cashForecastSnapshots) ? graph.cashForecastSnapshots : [];
  for (const row of cashSnapshots) {
    const key = row && row.id != null ? row.id : ((row && row.firmaId) + '|' + (row && row.createdAt));
    if (!cash13.verifySnapshot(row)) {
      issues.push(issue('cash-flow', key, 'CASH_FLOW_SNAPSHOT_INVALID', 'fotografia nu coincide cu amprenta forecastHash'));
    }
    anchors.push(anchor('cash-flow', key, row));
  }

  const fiscalRevisions = fiscalRows(graph || {}, issues, missing);
  for (const row of fiscalRevisions) {
    const key = row && row.id != null ? row.id : ((row && row.firmaId) + '|' + (row && row.validFrom));
    anchors.push(anchor('fiscal-profile', key, row));
  }

  const factRows = graph && Array.isArray(graph.fiscalFacts) ? graph.fiscalFacts : [];
  const factIds = new Set();
  for (const row of factRows) {
    const key = row && row.id != null ? row.id : '?'; const check = fiscalFacts.verify(row);
    if (factIds.has(String(key))) issues.push(issue('fiscal-fact', key, 'FISCAL_FACT_DUPLICATE_ID', 'identitatea faptului este duplicată'));
    factIds.add(String(key));
    if (!check.valid) issues.push(issue('fiscal-fact', key, 'FISCAL_FACT_INVALID', check.issues.join('; ')));
    anchors.push(anchor('fiscal-fact', key, row));
  }

  const policyRows = graph && Array.isArray(graph.fiscalAutonomyPolicies) ? graph.fiscalAutonomyPolicies : [];
  const policyIds = new Set();
  for (const row of policyRows) {
    const key = row && row.id != null ? row.id : '?';
    if (policyIds.has(String(key))) issues.push(issue('autonomy-policy', key, 'AUTONOMY_POLICY_DUPLICATE_ID', 'identitatea politicii este duplicată'));
    policyIds.add(String(key));
    try {
      const rebuilt = fiscalAutonomyPolicy.normalize(row, { now: row && row.authorizedAt });
      if (rebuilt.hash !== row.hash) issues.push(issue('autonomy-policy', key, 'AUTONOMY_POLICY_HASH_INVALID', 'hash-ul politicii nu coincide'));
    } catch (e) { issues.push(issue('autonomy-policy', key, 'AUTONOMY_POLICY_INVALID', e.message)); }
    anchors.push(anchor('autonomy-policy', key, row));
  }

  const legislativeRows = graph && Array.isArray(graph.legislativeChanges) ? graph.legislativeChanges : [];
  const legislativeIds = new Set();
  for (const row of legislativeRows) {
    const key = row && row.id != null ? row.id : '?';
    if (legislativeIds.has(String(key))) issues.push(issue('legislative-change', key, 'LEGISLATIVE_CHANGE_DUPLICATE_ID', 'identitatea dosarului este duplicată'));
    legislativeIds.add(String(key));
    const check = legislativeWorkflow.verify(row);
    if (!check.valid) issues.push(issue('legislative-change', key, 'LEGISLATIVE_CHANGE_INVALID', check.issues.join('; ')));
    anchors.push(anchor('legislative-change', key, row));
  }

  const audit = opts.auditResult || null;
  if (audit) {
    if (!audit.ok) issues.push(issue('audit', 'durable', 'AUDIT_CHAIN_INVALID', audit.motiv || 'lanțul durabil este invalid'));
    if (Number(audit.legacy || 0) > 0) missing.push(issue('audit', 'durable', 'AUDIT_LEGACY_PREFIX',
      String(audit.legacy) + ' evenimente legacy preced începutul lanțului criptografic'));
    anchors.push(anchor('audit', 'durable', {
      head: audit.head || null, chained: Number(audit.chained || 0), legacy: Number(audit.legacy || 0),
      files: Number(audit.files || 0), fileHashes: Array.isArray(audit.fileHashes) ? audit.fileHashes : [],
    }));
  } else if (opts.requireAudit) {
    issues.push(issue('audit', 'durable', 'AUDIT_CHAIN_NOT_CHECKED', 'jurnalul durabil nu a fost furnizat verificatorului'));
  }

  anchors.sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key) || a.hash.localeCompare(b.hash));
  const rootHash = sha256(Buffer.from(anchors.map((row) => row.type + ':' + row.key + ':' + row.hash).join('\n'), 'utf8'));
  return {
    schemaVersion: SCHEMA_VERSION,
    algorithm: 'SHA-256',
    rootHash,
    ok: issues.length === 0,
    complete: issues.length === 0 && missing.length === 0,
    counts: {
      anchors: anchors.length, firms: graph && Array.isArray(graph.firme) ? graph.firme.length : 0,
      filingDossiers: dossiers.length, annualArchives: annualArchives.length,
      cashFlowSnapshots: cashSnapshots.length, fiscalRevisions: fiscalRevisions.length,
      fiscalFacts: factRows.length, autonomyPolicies: policyRows.length,
      legislativeChanges: legislativeRows.length,
      auditEvents: audit ? Number(audit.chained || 0) + Number(audit.legacy || 0) : 0,
    },
    audit: audit ? { checked: true, ok: !!audit.ok, head: audit.head || null,
      files: Number(audit.files || 0), chained: Number(audit.chained || 0), legacy: Number(audit.legacy || 0) }
      : { checked: false },
    issues,
    missing,
    anchors,
  };
}

function assertGraph(graph, opts) {
  const report = verifyGraph(graph, opts);
  if (!report.ok) {
    const first = report.issues[0];
    const context = first ? first.component + ' ' + first.key + ' — ' + first.message : 'integritate invalidă';
    const e = new Error('Verificarea globală a lanțului a eșuat: ' + context + '.');
    e.status = 409; e.code = 'GLOBAL_CHAIN_INVALID'; e.integrity = report; throw e;
  }
  return report;
}

module.exports = { SCHEMA_VERSION, canonicalJson, sha256, verifyGraph, assertGraph };
