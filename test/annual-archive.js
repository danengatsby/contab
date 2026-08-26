'use strict';

// Sigilarea este asincronă (PDF-uri + ZIP), deci două cereri pot intra în același an înainte ca
// prima să scrie rândul. Proba folosește un constructor ZIP mic, dar manifestul și semnătura sunt
// reale: verifică atât serializarea, cât și idempotenta artefactului persistent.

const AdmZip = require('adm-zip');
const integrity = require('../src/annualArchiveIntegrity');
const dosarAnual = require('../src/dosarAnual');

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

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari dosar anual trecute, ' + fail + ' esuate.');
  process.exitCode = fail ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
