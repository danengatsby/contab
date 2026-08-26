'use strict';

// Dosarul anual este un ARTEFACT SIGILAT, nu o ruta care recalculeaza rapoarte la fiecare
// descarcare. `build` fotografiaza exercitiul inchis o singura data; `seal` pastreaza ZIP-ul
// exact in baza. Descarcarea ulterioara citeste numai acel binar si ii verifica manifestul.

const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const pdf = require('./pdf');
const acc = require('./accounting');
const rep = require('./reporting');
const stmt = require('./statements');
const payroll = require('./payroll');
const payrollHistory = require('./payrollHistory');
const fiscalProfile = require('./fiscalProfile');
const fiscalReview = require('./fiscalReview');
const fiscal = require('./fiscal');
const integrity = require('./annualArchiveIntegrity');
const cash13 = require('./cashForecast13Weeks');
const declarationRegistry = require('./declarations');
const annualInventory = require('./annualInventory');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function reqYear(value) { const y = String(value || ''); if (!/^[1-9]\d{3}$/.test(y)) fail(400, 'Anul trebuie să aibă forma YYYY.'); return y; }

function pdfToBuffer(pdfFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    sink.setHeader = () => {};
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try { pdfFn(sink); } catch (e) { reject(e); }
  });
}

/** Contract pastrat pentru rapoartele istorice si teste. */
function vatPeriods(view, year) {
  if (view && !view.company && (view.perioadaTva === 'L' || view.perioadaTva === 'T')) {
    return view.perioadaTva === 'T' ? ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => year + '-' + q)
      : Array.from({ length: 12 }, (_, i) => year + '-' + String(i + 1).padStart(2, '0'));
  }
  const out = new Set();
  for (let i = 1; i <= 12; i += 1) {
    const month = year + '-' + String(i).padStart(2, '0'); const profile = fiscalProfile.profileAt(view, month);
    if (profile.tvaPlatitor) out.add(profile.perioadaTva === 'T' ? year + '-Q' + Math.ceil(i / 3) : month);
  }
  return [...out];
}

function isYearClosed(view, year) {
  const y = String(year); const company = (view && view.company) || {};
  if (company.annualCloseHistory && company.annualCloseHistory[y]) return true;
  return (view.entries || []).some((e) => !e.stornat && e.tip === 'inchidere_an'
    && String(e.rezultatAn || e.period || e.data || '').slice(0, 4) === y);
}

function safeName(value, fallback) {
  const name = path.basename(String(value || fallback || 'fisier')).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return name.replace(/^-+|-+$/g, '') || String(fallback || 'fisier');
}

function withoutBinary(value) {
  if (Array.isArray(value)) return value.map(withoutBinary);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) if (!['contentBase64', 'zipBase64'].includes(key)) out[key] = withoutBinary(item);
  return out;
}

function exactBytes(blob, label) {
  if (!blob || !blob.contentBase64) fail(409, label + ': binarul exact nu a fost păstrat; regenerarea este interzisă.');
  const bytes = Buffer.from(String(blob.contentBase64), 'base64');
  if (!bytes.length && Number(blob.bytes)) fail(409, label + ': conținut base64 invalid.');
  const hash = integrity.sha256(bytes);
  if (hash !== String(blob.sha256 || '') || bytes.length !== Number(blob.bytes)) fail(409, label + ': amprenta sau dimensiunea nu coincide.');
  return bytes;
}

function selectedDocuments(view, year) {
  const ids = new Set();
  for (const e of (view.entries || [])) if (String(e.data || e.period || '').slice(0, 4) === year && e.fileId) ids.add(String(e.fileId));
  const txYear = new Set((view.bankTransactions || []).filter((t) => String(t.bookingDate || '').slice(0, 4) === year).map((t) => String(t.statementId)));
  for (const s of (view.bankStatements || [])) {
    const inYear = txYear.has(String(s.id)) || [s.periodFrom, s.periodTo].some((d) => String(d || '').slice(0, 4) === year);
    if (inYear && s.documentId) ids.add(String(s.documentId));
  }
  return (view.documents || []).filter((d) => ids.has(String(d.id)) || String(d.uploadedAt || '').slice(0, 4) === year);
}

function archiveRows(globalDb, firmaId, year) {
  return (globalDb.annualArchives || []).filter((x) => Number(x.firmaId) === Number(firmaId) && String(x.year) === String(year))
    .sort((a, b) => Number(a.version) - Number(b.version));
}

function stored(globalDb, firmaId, year, version) {
  const rows = archiveRows(globalDb, firmaId, year);
  if (!rows.length) return null;
  if (version != null && version !== '') return rows.find((x) => Number(x.version) === Number(version)) || null;
  return rows[rows.length - 1];
}

function cashSnapshotsForYear(view, year) {
  year = reqYear(year);
  const rows = (view.cashForecastSnapshots || [])
    .filter((x) => String(x.startDate || x.createdAt || '').slice(0, 4) === year)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const snapshot of rows) if (!cash13.verifySnapshot(snapshot)) {
    fail(409, 'Fotografia cash-flow ' + String(snapshot.id || '?') + ' este coruptă; dosarul anual nu poate fi sigilat cu o prognoză neverificabilă.');
  }
  return rows;
}

async function build(view, year, opts) {
  opts = opts || {}; year = reqYear(year);
  if (!isYearClosed(view, year)) fail(409, 'Exercițiul ' + year + ' nu este închis. Dosarul anual nu poate fi sigilat din date în lucru.');
  const AdmZip = require('adm-zip'); const zip = new AdmZip();
  const company = view.company || {}; const globalDb = opts.globalDb || {};
  const files = []; const paths = new Set();
  const add = async (filePath, producer, category, retentionYears) => {
    if (paths.has(filePath) || filePath === 'manifest.json') fail(500, 'Cale duplicată în dosar: ' + filePath);
    const value = await Promise.resolve().then(producer);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    zip.addFile(filePath, bytes); paths.add(filePath);
    files.push({ path: filePath, sha256: integrity.sha256(bytes), bytes: bytes.length,
      category: category || 'contabil', retentionYears: Number(retentionYears) || 5 });
  };
  const addJson = (filePath, value, category, retentionYears) => add(filePath,
    () => Buffer.from(JSON.stringify(value, null, 2), 'utf8'), category, retentionYears);
  const dec = year + '-12'; const previous = String(Number(year) - 1) + '-12';

  // Registrele si situatiile sunt fotografii ale datelor inchise. O eroare opreste sigilarea:
  // un manifest care enumera „erori tolerate” nu este un dosar complet.
  await add('registre/registru-jurnal.pdf', () => pdfToBuffer((res) => pdf.journalPdf(res, company, acc.journal(view, year))), 'registru', 5);
  await add('registre/cartea-mare.pdf', () => pdfToBuffer((res) => pdf.ledgerPdf(res, company, acc.ledger(view, year), year)), 'registru', 5);
  await add('registre/balanta-' + dec + '.pdf', () => pdfToBuffer((res) => pdf.trialBalancePdf(res, company, acc.trialBalance(view, dec))), 'registru', 5);
  await add('registre/registru-inventar.pdf', () => pdfToBuffer((res) => pdf.registruInventarPdf(res, company, rep.registruInventar(view, dec, year))), 'registru', 5);
  await add('registre/registru-fiscal.pdf', () => pdfToBuffer((res) => pdf.registruFiscalPdf(res, company, rep.registruFiscal(view, year))), 'registru', 5);
  await add('situatii/bilant.pdf', () => pdfToBuffer((res) => pdf.balanceSheetPdf(res, company,
    stmt.balanceSheetF10(view, dec), stmt.balanceSheetF10(view, previous), stmt.balanceSheet(view, dec))), 'situatie-financiara', 10);
  await add('situatii/cont-profit-pierdere.pdf', () => pdfToBuffer((res) => pdf.plPdf(res, company,
    stmt.profitLossF20(view, year), stmt.profitLossF20(view, Number(year) - 1), stmt.profitLoss(view, year))), 'situatie-financiara', 10);
  await add('situatii/fluxuri-trezorerie.pdf', () => pdfToBuffer((res) => pdf.cashFlowPdf(res, company, stmt.cashFlow(view, year))), 'situatie-financiara', 10);
  await add('situatii/modificari-capitaluri.pdf', () => pdfToBuffer((res) => pdf.equityPdf(res, company, stmt.equityChanges(view, year))), 'situatie-financiara', 10);
  const explanatoryNotes = rep.notes(view, year);
  await add('situatii/note-explicative.pdf', () => pdfToBuffer((res) => pdf.notesPdf(res, company, explanatoryNotes)), 'situatie-financiara', 10);
  await addJson('situatii/note-explicative.json', explanatoryNotes, 'situatie-financiara', 10);

  // Declaratiile sunt luate EXCLUSIV din binarul pastrat la generare si legat de depunere.
  // Nu exista fallback la generator: datele curente pot fi diferite de cele efectiv depuse.
  const declarations = (globalDb.declarations || []).filter((d) => Number(d.firmaId) === Number(view.firmaId)
    && String(d.period || '').slice(0, 4) === year);
  await addJson('declaratii/registru-depuneri.json', declarations.map(withoutBinary), 'declaratie', 5);
  for (const rec of declarations) {
    const dossierIntegrity = declarationRegistry.verifyDossier(rec, rec.firmaId, rec.tip, rec.period);
    if (!dossierIntegrity.valid) fail(409, rec.tip.toUpperCase() + ' ' + rec.period
      + ': dosarul de depunere este invalid: ' + dossierIntegrity.issues.join('; '));
    const submissions = Array.isArray(rec.depuneri) ? rec.depuneri : [];
    if (rec.status === 'depusa' && !submissions.length) fail(409, rec.tip.toUpperCase() + ' ' + rec.period + ': starea depusă nu are istoric de depunere.');
    for (const dep of submissions) {
      const filedHash = dep.submittedArtifactHash || dep.artifactHash;
      const artifact = (rec.artifacts || []).find((a) => a.sha256 === filedHash);
      const prefix = 'declaratii/' + safeName(rec.tip) + '-' + safeName(rec.period) + '/depunere-' + Number(dep.ordinal || 1);
      if (dep.submissionId && dep.submissionHash) {
        await addJson(prefix + '-legatura-recipise.json', {
          schemaVersion: dep.schemaVersion, submissionId: dep.submissionId, submissionHash: dep.submissionHash,
          dossierId: rec.dossier && rec.dossier.id, dossierKey: rec.dossier && rec.dossier.key,
          declarationType: rec.tip, period: rec.period, ordinal: dep.ordinal,
          submittedArtifactHash: filedHash, documentApprovalHash: dep.documentApprovalHash,
          approvalReferenceKind: (dep.receipts && dep.receipts[0] && dep.receipts[0].filingBinding
            && dep.receipts[0].filingBinding.approvalReferenceKind) || '',
          approvalReferenceHash: (dep.receipts && dep.receipts[0] && dep.receipts[0].filingBinding
            && dep.receipts[0].filingBinding.approvalReferenceHash) || '',
          receiptReference: dep.recipisa,
          receipts: (dep.receipts || []).map((receipt) => ({
            sha256: receipt.sha256, bytes: receipt.bytes, filename: receipt.filename, mime: receipt.mime,
            filingBinding: receipt.filingBinding, receiptBindingHash: receipt.receiptBindingHash,
            filingBindingHistory: receipt.filingBindingHistory || [],
          })),
        }, 'dovada-depunere', 10);
      }
      const fileName = safeName(artifact && artifact.filename, rec.tip + '-' + rec.period + '.xml');
      await add(prefix + '-' + fileName, () => exactBytes(artifact,
        rec.tip.toUpperCase() + ' ' + rec.period + ' depunerea ' + dep.ordinal), 'declaratie', 5);
      const receipts = Array.isArray(dep.receipts) ? dep.receipts : [];
      if (dep.recipisa && !receipts.length) fail(409, rec.tip.toUpperCase() + ' ' + rec.period
        + ' depunerea ' + dep.ordinal + ': recipisa ' + dep.recipisa + ' nu are fișierul exact atașat.');
      for (let ri = 0; ri < receipts.length; ri += 1) {
        const receipt = receipts[ri];
        await add(prefix + '-recipisa-' + (ri + 1) + '-' + safeName(receipt.filename, 'recipisa.bin'),
          () => exactBytes(receipt, 'Recipisa ' + rec.tip.toUpperCase() + ' ' + rec.period), 'recipisa', 5);
      }
    }
  }

  // Fiecare extras care a alimentat anul trebuie să aibă documentul bancar original. Snapshotul
  // tranzacțiilor nu poate substitui extrasul emis de bancă.
  const bankTx = (view.bankTransactions || []).filter((x) => String(x.bookingDate || '').slice(0, 4) === year);
  const bankIds = new Set(bankTx.map((x) => String(x.statementId)));
  const bankStatements = (view.bankStatements || []).filter((x) => bankIds.has(String(x.id))
    || [x.periodFrom, x.periodTo].some((d) => String(d || '').slice(0, 4) === year));
  for (const statement of bankStatements) {
    if (!statement.documentId) fail(409, 'Extrasul bancar ' + statement.id + ' nu are fișierul original atașat.');
    if (!(view.documents || []).some((d) => String(d.id) === String(statement.documentId))) {
      fail(409, 'Documentul original al extrasului bancar ' + statement.id + ' lipsește din registrul documentelor.');
    }
  }

  // Documentele justificative originale, nu textul extras din ele.
  const docs = selectedDocuments(view, year); const uploadDir = opts.uploadDir;
  await addJson('documente-justificative/index.json', docs.map(withoutBinary), 'document-justificativ', 5);
  for (const doc of docs) {
    if (!doc.storedName) fail(409, 'Documentul justificativ ' + doc.id + ' (' + (doc.fileName || 'fără nume') + ') nu are binarul original.');
    const source = uploadDir && path.join(uploadDir, path.basename(String(doc.storedName)));
    if (!source || !fs.existsSync(source)) fail(409, 'Binarul documentului justificativ ' + doc.id + ' lipsește din stocare.');
    await add('documente-justificative/' + safeName(doc.id) + '-' + safeName(doc.fileName, doc.storedName),
      () => fs.readFileSync(source), 'document-justificativ', 5);
  }

  const yearEntries = (view.entries || []).filter((e) => String(e.data || e.period || '').slice(0, 4) === year
    || (e.tip === 'repartizare_rezultat' && String(e.rezultatAn || '') === year));
  const payrollRows = (view.payrollHistory || []).filter((x) => String(x.period || '').slice(0, 4) === year);
  const activePayroll = payrollHistory.activeSnapshots(view.payrollHistory || [], view.entries || [])
    .filter((x) => String(x.period || '').slice(0, 4) === year);
  const stockMovements = (view.stockMovements || []).filter((x) => String(x.data || '').slice(0, 4) === year);
  const inventories = (view.inventories || []).filter((x) => String(x.data || '').slice(0, 4) === year);
  const inventoryValues = (view.inventarAnual || []).filter((x) => String(x.an || x.data || '').slice(0, 4) === year);
  await addJson('date/articole-contabile.json', yearEntries, 'registru', 5);
  await addJson('salarii/state-salarii-snapshot.json', payrollRows, 'stat-salarii', 5);
  // Regulile efective intra integral in arhiva. Astfel, ID-ul de pe articol/stat/declaratie poate
  // fi verificat peste ani fara versiunea curenta a aplicatiei.
  const fiscalRuleSets = fiscal.allRuleSets().filter((r) => r.validFrom <= year + '-12-31'
    && (!r.validTo || r.validTo >= year + '-01-01'));
  if (!fiscalRuleSets.length) fail(409, 'Nu exista FiscalRuleSet publicat pentru exercitiul ' + year + '.');
  const provenanceRows = yearEntries.concat(payrollRows, declarations);
  const fiscalRuleSetRefs = [...new Map(provenanceRows.filter((x) => x && x.ruleSetId && x.fiscalRulesHash)
    .map((x) => [String(x.ruleSetId) + ':' + String(x.fiscalRulesHash),
      { ruleSetId: String(x.ruleSetId), fiscalRulesHash: String(x.fiscalRulesHash) }])).values()];
  for (const ref of fiscalRuleSetRefs) {
    if (ref.ruleSetId.startsWith('uncovered:') || !fiscal.verifyRuleReference(ref.ruleSetId, ref.fiscalRulesHash)) {
      fail(409, 'Referinta fiscala neverificabila in exercitiul ' + year + ': ' + ref.ruleSetId + '.');
    }
  }
  await addJson('reguli-fiscale/fiscal-rule-sets.json', {
    schemaVersion: 1, year, registryHash: fiscal.registryHash(), ruleSets: fiscalRuleSets,
    referencesUsed: fiscalRuleSetRefs,
    legacyWithoutReference: provenanceRows.filter((x) => x && (!x.ruleSetId || !x.fiscalRulesHash)).length,
  }, 'aprobare', 10);
  if (activePayroll.length) {
    await add('salarii/registru-salarii-' + year + '.pdf', () => pdfToBuffer((res) => pdf.registruSalariiPdf(
      res, company, payroll.registruSalarii(view.payrollHistory || [], year, view.entries || []))), 'stat-salarii', 5);
    for (const snapshot of activePayroll) {
      await add('salarii/stat-plata-' + safeName(snapshot.period) + '.pdf', () => pdfToBuffer((res) => pdf.statePlataPdf(
        res, company, payroll.statPlataPostata(view, snapshot.period), snapshot.period, { ciorna: false })), 'stat-salarii', 5);
    }
  }
  await addJson('stoc/miscari-stoc.json', stockMovements, 'document-gestiune', 5);
  await addJson('stoc/inventare.json', { inventare: inventories, valori: inventoryValues }, 'document-gestiune', 5);
  for (const inventory of inventories) {
    await add('stoc/proces-verbal-inventar-' + safeName(inventory.id || inventory.data) + '.pdf',
      () => pdfToBuffer((res) => pdf.inventoryPvPdf(res, company, inventory)), 'document-gestiune', 5);
  }
  await addJson('banca/extrase-si-tranzactii.json', { statements: bankStatements, transactions: bankTx }, 'extras-bancar', 5);
  const cashSnapshots = cashSnapshotsForYear(view, year);
  await addJson('management/cash-flow-13-saptamani.json', cashSnapshots, 'management', 5);
  for (let i = 0; i < cashSnapshots.length; i += 1) {
    const snapshot = cashSnapshots[i]; const prefix = 'management/cash-flow-13-saptamani/'
      + String(i + 1).padStart(2, '0') + '-' + safeName(snapshot.id || snapshot.startDate);
    await addJson(prefix + '.json', snapshot, 'management', 5);
    await add(prefix + '.pdf', () => pdfToBuffer((res) => pdf.cashForecast13Pdf(res, company, snapshot.forecast, {
      snapshotId: snapshot.id, createdAt: snapshot.createdAt, createdByName: snapshot.createdByName,
      forecastHash: snapshot.forecastHash,
    })), 'management', 5);
  }
  await addJson('aprobari/inchideri-lunare.json', (globalDb.closings || []).filter((x) => Number(x.firmaId) === Number(view.firmaId)
    && String(x.period || '').slice(0, 4) === year), 'aprobare', 5);
  await addJson('aprobari/inventariere-generala.json', annualInventory.evaluate(view, year), 'aprobare', 10);
  await addJson('aprobari/incadrare-bilant.json', (globalDb.balance_category_history || []).filter((x) => Number(x.firmaId) === Number(view.firmaId)
    && String(x.year || x.an || '').slice(0, 4) === year), 'aprobare', 10);
  await addJson('aprobari/mapari-bilant.json', (globalDb.balance_sheet_mappings || []).filter((x) => Number(x.firmaId) === Number(view.firmaId)
    && [year, String(Number(year) - 1)].includes(String(x.year))), 'aprobare', 10);
  await addJson('aprobari/ajustari-bilant.json', (globalDb.balance_sheet_adjustments || []).filter((x) => Number(x.firmaId) === Number(view.firmaId)
    && [year, String(Number(year) - 1)].includes(String(x.year))), 'aprobare', 10);
  await addJson('aprobari/revizie-fiscala-externa.json', fiscalReview.status(), 'aprobare', 10);
  await addJson('audit/evenimente-an.json', (globalDb.audit || []).filter((x) => Number(x.firmaId) === Number(view.firmaId)
    && String(x.ts || '').slice(0, 4) === year), 'audit', 5);

  await add('README.txt', () => Buffer.from(
    'DOSAR CONTABIL ANUAL SIGILAT — ' + (company.nume || '') + ' — ' + year + '\n\n'
    + 'Acesta este binarul persistent al versiunii ' + Number(opts.version || 1) + ', nu o regenerare la descărcare.\n'
    + 'manifest.json enumeră exact toate fișierele, amprentele SHA-256 și semnătura tehnică HMAC.\n'
    + 'Semnătura HMAC nu este semnătură electronică calificată; ea dovedește integritatea tehnică\n'
    + 'față de cheia instanței. Legea contabilității nr. 82/1991: art. 25 — registrele, documentele\n'
    + 'justificative și statele de salarii, 5 ani calculați de la 1 iulie a anului următor;\n'
    + 'art. 35 alin. (3) — situațiile financiare, 10 ani.\n', 'utf8'), 'metadate', 10);

  files.sort((a, b) => a.path.localeCompare(b.path));
  const sealedAt = opts.sealedAt || new Date().toISOString();
  const manifest = {
    schemaVersion: 2, archiveType: 'contab-annual-accounting-archive', archiveVersion: Number(opts.version || 1),
    year, company: { id: view.firmaId, name: company.nume || '', cui: company.cui || '', regCom: company.regCom || '' },
    sealedAt, sealedBy: opts.username || null, reason: opts.reason || 'Sigilarea inițială a exercițiului finalizat',
    accountingClose: (company.annualCloseHistory && company.annualCloseHistory[year]) || null,
    timestamp: { value: sealedAt, source: 'ceasul UTC al aplicației', qualified: false },
    hashAlgorithm: 'SHA-256', files, contentRootHash: integrity.rootHash(files),
    fiscalRules: { registryHash: fiscal.registryHash(), references: fiscalRuleSetRefs,
      ruleSetHashes: fiscalRuleSets.map((r) => ({ id: r.id, hash: r.hash })) },
    retention: { accountingRecordsAndSupportingDocumentsYears: 5,
      accountingRecordsCalculatedFrom: '1 iulie a anului următor încheierii exercițiului financiar',
      financialStatementsYears: 10,
      legalBasis: ['Legea nr. 82/1991 art. 25', 'Legea nr. 82/1991 art. 35 alin. (3)'],
      policy: 'Pachetul complet se păstrează minimum 10 ani deoarece include situațiile financiare.' },
    signature: null,
  };
  manifest.signature = integrity.signManifest(manifest, opts);
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  const buffer = zip.toBuffer(); const verification = integrity.verifyBuffer(buffer, opts);
  if (!verification.ok) fail(500, 'Dosarul construit nu trece propria verificare: ' + verification.reason);
  const safeCompany = safeName(company.nume || 'firma').toLowerCase();
  return { name: 'dosar-anual-' + safeCompany + '-' + year + '-v' + manifest.archiveVersion + '.zip', buffer, manifest };
}

async function sealUnlocked(globalDb, view, year, opts) {
  opts = opts || {}; year = reqYear(year); globalDb.annualArchives = globalDb.annualArchives || [];
  const previous = archiveRows(globalDb, view.firmaId, year);
  if (previous.length && !opts.newRevision) {
    const row = previous[previous.length - 1]; const verification = integrity.verifyStored(row, opts);
    if (!verification.ok) fail(409, 'Arhiva persistentă existentă este coruptă: ' + verification.reason);
    return { created: false, row, manifest: verification.manifest, buffer: verification.buffer };
  }
  const reason = String(opts.reason || '').trim();
  if (previous.length && reason.length < 10) fail(400, 'O versiune nouă a dosarului cere un motiv de minimum 10 caractere; versiunea veche rămâne imuabilă.');
  const version = previous.length + 1;
  const builder = typeof opts.buildArchive === 'function' ? opts.buildArchive : build;
  const built = await builder(view, year, Object.assign({}, opts, { globalDb, version, reason: reason || undefined }));
  const row = {
    id: opts.nextId ? opts.nextId('aar') : 'aar-' + view.firmaId + '-' + year + '-' + version,
    firmaId: view.firmaId, year, version, schemaVersion: 2, createdAt: built.manifest.sealedAt,
    createdBy: opts.userId || null, createdByName: opts.username || '', reason: built.manifest.reason,
    fileName: built.name, bytes: built.buffer.length, zipSha256: integrity.sha256(built.buffer),
    contentRootHash: built.manifest.contentRootHash, signature: built.manifest.signature,
    fiscalRuleSetRefs: (built.manifest.fiscalRules && built.manifest.fiscalRules.references) || [],
    fiscalRegistryHash: (built.manifest.fiscalRules && built.manifest.fiscalRules.registryHash) || '',
    manifest: built.manifest, zipBase64: built.buffer.toString('base64'), immutable: true,
  };
  globalDb.annualArchives.push(row);
  return { created: true, row, manifest: built.manifest, buffer: built.buffer };
}

// Construirea PDF-urilor cedează event loop-ul. Două cereri sosite în acel interval ar putea
// calcula aceeași versiune și apoi ar adăuga amândouă v1/v2. Coada este per bază+firmă+an:
// după ce prima termină, a doua recitește istoricul persistent și devine idempotentă (sau v
// următoare, dacă a cerut explicit o rectificativă).
const sealQueues = new WeakMap();
async function seal(globalDb, view, year, opts) {
  year = reqYear(year); const fid = Number(view && view.firmaId); let queues = sealQueues.get(globalDb);
  if (!queues) { queues = new Map(); sealQueues.set(globalDb, queues); }
  const key = fid + ':' + year; const previous = queues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => sealUnlocked(globalDb, view, year, opts));
  queues.set(key, operation);
  try { return await operation; } finally {
    if (queues.get(key) === operation) queues.delete(key);
    if (!queues.size) sealQueues.delete(globalDb);
  }
}

module.exports = { build, seal, stored, archiveRows, isYearClosed, cashSnapshotsForYear,
  pdfToBuffer, vatPeriods, withoutBinary };
