'use strict';

// Sigilarea este asincronă (PDF-uri + ZIP), deci două cereri pot intra în același an înainte ca
// prima să scrie rândul. Proba folosește un constructor ZIP mic, dar manifestul și semnătura sunt
// reale: verifică atât serializarea, cât și idempotenta artefactului persistent.

const AdmZip = require('adm-zip');
const fs = require('fs');
const os = require('os');
const path = require('path');
const integrity = require('../src/annualArchiveIntegrity');
const dosarAnual = require('../src/dosarAnual');
const annualFiling = require('../src/annualFilingDossier');

let pass = 0; let fail = 0;
function eq(name, got, expected) {
  if (got === expected) pass += 1;
  else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(expected)); }
}
function ok(name, value) { if (value) pass += 1; else { fail += 1; console.error('  ✗ ' + name); } }

async function main() {
  const signingKey = 'cheie-test-dosar-anual-concurent-2026-persistenta';
  const globalDb = { annualArchives: [] }; const view = { firmaId: 17 }; let builds = 0; let ids = 0;
  const buildArchive = async (currentView, year, opts) => {
    builds += 1;
    await new Promise((resolve) => setImmediate(resolve));
    const proof = Buffer.from('conținut versiune ' + opts.version, 'utf8');
    const files = [{ path: 'probe.txt', sha256: integrity.sha256(proof), bytes: proof.length }];
    const manifest = {
      schemaVersion: 2, archiveType: 'contab-annual-accounting-archive', archiveVersion: opts.version,
      year, company: { id: currentView.firmaId }, sealedAt: '2027-05-0' + opts.version + 'T10:00:00.000Z',
      reason: opts.reason || 'Sigilarea inițială a exercițiului finalizat', files,
      contentRootHash: integrity.rootHash(files), signature: null,
    };
    manifest.signature = integrity.signManifest(manifest, { signingKey });
    const zip = new AdmZip(); zip.addFile(files[0].path, proof);
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
    return { name: 'dosar-2026-v' + opts.version + '.zip', buffer: zip.toBuffer(), manifest };
  };
  const opts = { signingKey, buildArchive, nextId: () => 'aar' + (++ids), username: 'test' };

  const first = await Promise.all([
    dosarAnual.seal(globalDb, view, '2026', opts),
    dosarAnual.seal(globalDb, view, '2026', opts),
  ]);
  eq('două sigilări inițiale simultane construiesc un singur ZIP', builds, 1);
  eq('două sigilări inițiale păstrează un singur rând', globalDb.annualArchives.length, 1);
  eq('rezultatele sunt create + idempotent', first.map((x) => x.created).sort().join(','), 'false,true');
  eq('ambele cereri primesc exact aceeași amprentă', first[0].row.zipSha256, first[1].row.zipSha256);
  ok('ZIP-ul păstrat după concurență trece verificarea completă', integrity.verifyStored(globalDb.annualArchives[0], { signingKey }).ok);

  const originalHash = globalDb.annualArchives[0].zipSha256;
  const revisions = await Promise.all([
    dosarAnual.seal(globalDb, view, '2026', Object.assign({}, opts, { newRevision: true, reason: 'Corecție aprobată numărul unu' })),
    dosarAnual.seal(globalDb, view, '2026', Object.assign({}, opts, { newRevision: true, reason: 'Corecție aprobată numărul doi' })),
  ]);
  eq('rectificativele simultane primesc versiuni distincte, în ordine', revisions.map((x) => x.row.version).join(','), '2,3');
  eq('istoricul conține toate versiunile, fără duplicate', globalDb.annualArchives.map((x) => x.version).join(','), '1,2,3');
  eq('prima versiune rămâne imuabilă după rectificative', globalDb.annualArchives[0].zipSha256, originalHash);
  ok('toate versiunile persistente sunt verificabile', globalDb.annualArchives.every((row) => integrity.verifyStored(row, { signingKey }).ok));

  const cash13 = require('../src/cashForecast13Weeks');
  const cashSnapshot = cash13.makeSnapshot({ startDate: '2026-08-24', endDate: '2026-11-22',
    scenario: 'base', basisHash: 'c'.repeat(64), rows: [] }, {
    id: 'cfs-2026', firmaId: 17, createdAt: '2026-08-24T09:00:00.000Z', createdByName: 'test',
  });
  const outside = cash13.makeSnapshot({ startDate: '2025-08-25', endDate: '2025-11-23',
    scenario: 'base', basisHash: 'd'.repeat(64), rows: [] }, {
    id: 'cfs-2025', firmaId: 17, createdAt: '2025-08-25T09:00:00.000Z', createdByName: 'test',
  });
  eq('dosarul anual selectează numai fotografiile cash-flow ale exercițiului',
    dosarAnual.cashSnapshotsForYear({ cashForecastSnapshots: [outside, cashSnapshot] }, '2026').map((x) => x.id).join(','), 'cfs-2026');
  const corruptedCash = JSON.parse(JSON.stringify(cashSnapshot)); corruptedCash.forecast.rows.push({ closing: 1 });
  let corruptError = null;
  try { dosarAnual.cashSnapshotsForYear({ cashForecastSnapshots: [corruptedCash] }, '2026'); } catch (e) { corruptError = e; }
  ok('o fotografie cash-flow alterată blochează sigilarea dosarului anual', corruptError && corruptError.status === 409);

  // Matricea anexelor 2025: fiecare PDF este probă separată, aprobată pe hash, iar ZIP-ul
  // transmis trebuie să conțină exact aceiași octeți (nu doar fișiere cu nume asemănător).
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contab-annual-filing-'));
  try {
    const filingView = {
      firmaId: 17,
      company: { tipEntitate: 'srl', auditStatut: '3' },
      balanceCategoryHistory: [{
        id: 'bch-2025', year: '2025', category: 'micro',
        indicators: { totalActive: 1000000, cifraAfaceri: 2000000, numarMediuSalariati: 4 },
        previousIndicators: { totalActive: 900000, cifraAfaceri: 1800000, numarMediuSalariati: 3 },
      }],
      documents: [],
    };
    const filingDb = { declarations: [{ id: 'bilant-2025', firmaId: 17, tip: 'bilant', period: '2025-12', status: 'depusa',
      dossier: { id: 'dossier-bilant-2025' }, depuneri: [{ ordinal: 1, submissionId: 'submission-bilant-2025',
        submissionHash: 'a'.repeat(64), submittedArtifactHash: 'b'.repeat(64), recipisa: 'R-BILANT-2025',
        depusaLa: '2026-05-20T10:00:00.000Z' }] }] };
    let docSeq = 0;
    const addEvidence = (kind, buffer, approved = true) => {
      const id = 'afd' + (++docSeq); const ext = kind === 'submitted_zip' ? '.zip' : '.pdf';
      const storedName = id + ext; const fileName = kind + ext;
      fs.writeFileSync(path.join(evidenceDir, storedName), buffer);
      const meta = annualFiling.createEvidence({
        year: '2025', kind, documentId: id, revision: 1, fileName, buffer,
        mime: kind === 'submitted_zip' ? 'application/zip' : 'application/pdf',
        signedBy: kind === 'submitted_zip' ? '' : 'Administrator Test',
        signedAt: kind === 'submitted_zip' ? '' : '2026-04-10',
        signatureType: kind === 'submitted_zip' ? '' : 'handwritten_scan',
        uploadedBy: 7, uploadedByName: 'operator-test', uploadedAt: '2026-04-11T10:00:00.000Z',
        filingBinding: kind === 'submitted_zip' ? annualFiling.filingBindingFor(filingDb, 17, '2025') : null,
      });
      if (approved) meta.approval = annualFiling.approveEvidence(meta, { id: 8, username: 'aprobator-test' }, 'aprobator', '2026-04-12T10:00:00.000Z');
      const doc = { id, firmaId: 17, fileName, storedName, uploadedAt: meta.uploadedAt,
        sha256: meta.fileSha256, bytes: meta.bytes, annualFilingEvidence: meta };
      filingView.documents.push(doc); return { doc, buffer };
    };
    const annexes = [
      addEvidence('administrators_report', Buffer.from('%PDF-raport-administratori')),
      addEvidence('art30_declaration', Buffer.from('%PDF-declaratie-art-30')),
      addEvidence('result_allocation_proposal', Buffer.from('%PDF-propunere-rezultat')),
      addEvidence('aga_resolution', Buffer.from('%PDF-hotarare-aga')),
      addEvidence('signed_first_page', Buffer.from('%PDF-prima-pagina-semnata')),
    ];
    const submittedZip = new AdmZip();
    for (const item of annexes.filter((x) => x.doc.annualFilingEvidence.kind !== 'aga_resolution')) {
      submittedZip.addFile('anexe/' + item.doc.fileName, item.buffer);
    }
    addEvidence('submitted_zip', submittedZip.toBuffer());
    const filingReady = annualFiling.status(filingView, '2025', { uploadDir: evidenceDir, globalDb: filingDb });
    ok('matricea 2025 devine completă numai cu probe aprobate și ZIP exact', filingReady.ready
      && filingReady.rows.filter((row) => row.requiredInZip).every((row) => row.inSubmittedZip));
    ok('matricea are hash propriu și păstrează hash-ul ZIP-ului transmis',
      /^[a-f0-9]{64}$/.test(filingReady.matrixHash) && filingReady.package.zipSha256
      === filingView.documents.find((d) => d.annualFilingEvidence.kind === 'submitted_zip').sha256);
    eq('dosarul pregătit expune toate cele șase probe obligatorii pentru microentitate',
      annualFiling.exactEvidenceFiles(filingView, '2025', { uploadDir: evidenceDir, globalDb: filingDb }).files.length, 6);

    filingDb.declarations[0].depuneri.push({ ordinal: 2, submissionId: 'submission-bilant-2025-rectificata',
      submissionHash: 'c'.repeat(64), submittedArtifactHash: 'd'.repeat(64), recipisa: 'R-BILANT-2025-2' });
    const stalePackage = annualFiling.status(filingView, '2025', { uploadDir: evidenceDir, globalDb: filingDb });
    ok('o depunere mai nouă invalidează legătura ZIP-ului vechi cu registrul și recipisa', !stalePackage.ready
      && /altă depunere/.test(stalePackage.rows.find((row) => row.kind === 'submitted_zip').reason));
    filingDb.declarations[0].depuneri.pop();

    const firstPage = filingView.documents.find((d) => d.annualFilingEvidence.kind === 'signed_first_page');
    fs.writeFileSync(path.join(evidenceDir, firstPage.storedName), Buffer.from('%PDF-octeti-schimbati'));
    const changed = annualFiling.status(filingView, '2025', { uploadDir: evidenceDir, globalDb: filingDb });
    ok('modificarea binarului după aprobare invalidează proba și blochează sigilarea', !changed.ready
      && changed.rows.find((row) => row.kind === 'signed_first_page').reason.includes('SHA-256'));
    fs.writeFileSync(path.join(evidenceDir, firstPage.storedName), annexes[4].buffer);

    const largeView = JSON.parse(JSON.stringify(filingView));
    largeView.company.auditStatut = '3'; largeView.balanceCategoryHistory[0].category = 'mare';
    const large = annualFiling.status(largeView, '2025', { uploadDir: evidenceDir, globalDb: filingDb });
    ok('entitatea mijlocie/mare cere raport de audit și refuză statutul neauditat', !large.ready
      && large.rows.find((row) => row.kind === 'audit_report').required
      && large.blockers.some((message) => message.includes('contrazice categoria')));

    const pendingView = JSON.parse(JSON.stringify(filingView));
    pendingView.documents.find((d) => d.annualFilingEvidence.kind === 'aga_resolution').annualFilingEvidence.approval = null;
    const pending = annualFiling.status(pendingView, '2025', { uploadDir: evidenceDir, globalDb: filingDb });
    ok('o anexă încărcată dar neaprobată nu este tratată drept completă', !pending.ready
      && /aprobarea lipsește/.test(pending.rows.find((row) => row.kind === 'aga_resolution').reason));
  } finally { fs.rmSync(evidenceDir, { recursive: true, force: true }); }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari dosar anual trecute, ' + fail + ' esuate.');
  process.exitCode = fail ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
