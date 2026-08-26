'use strict';

// Utilitar READ-ONLY pentru dosarul extern. Nu scrie aprobări și nu folosește chei private.
// Semnarea se face de revizor, în afara aplicației, peste mesajul canonic emis de --payload.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const rulesAt = args.indexOf('--runtime-rules');
if (rulesAt !== -1) {
  const file = args[rulesAt + 1];
  if (!file) { console.error('Lipsește fișierul după --runtime-rules.'); process.exit(1); }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    require('../src/fiscal').applyConfig(parsed.current || parsed.fiscal || parsed);
  } catch (e) {
    console.error('Configurația fiscală activă nu poate fi citită: ' + e.message);
    process.exit(1);
  }
  args.splice(rulesAt, 2);
}

const review = require('../src/fiscalReview');
const arg = args[0];
const id = args[1];

function approvalFrom(file, caseId) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return (parsed.approvals && parsed.approvals[caseId]) || parsed[caseId] || parsed;
}

if (arg === '--hash' || arg === '--semnatura') {
  const hash = review.currentHash(id);
  if (!hash) { console.error('Caz inexistent: ' + id); process.exit(1); }
  console.log(hash);
} else if (arg === '--template') {
  const out = review.template(id);
  if (!out) { console.error('Caz inexistent: ' + id); process.exit(1); }
  console.log(JSON.stringify({ [id]: out }, null, 2));
} else if (arg === '--payload') {
  const file = args[2];
  if (!review.CASES.some((c) => c.id === id) || !file) {
    console.error('Utilizare: --payload ID aprobare.json'); process.exit(1);
  }
  try { process.stdout.write(review.signatureMessage(id, approvalFrom(file, id))); }
  catch (e) { console.error('Aprobarea nu poate fi citită: ' + e.message); process.exit(1); }
} else if (arg === '--key-id') {
  if (!id) { console.error('Utilizare: --key-id cheie-publica.pem'); process.exit(1); }
  try { console.log(review.publicKeyId(fs.readFileSync(path.resolve(id), 'utf8'))); }
  catch (e) { console.error('Cheia publică nu poate fi citită: ' + e.message); process.exit(1); }
} else if (arg === '--manifest') {
  console.log(JSON.stringify(review.sourceManifest(), null, 2));
} else {
  const s = review.status();
  console.log('Revizie fiscală externă — set ' + s.fiscalYear + ' (' + s.fiscalUpdatedAt + ')');
  console.log(s.approved + '/' + s.total + ' aprobate · ' + s.pending + ' în așteptare · ' + s.invalid + ' invalidate');
  console.log('Manifest surse: ' + s.sourceManifestHash + ' (' + s.sourceFiles + ' fișiere)');
  console.log('Reguli active:  ' + s.runtimeRulesHash);
  console.log('Semnături:      ' + s.signatureScheme);
  if (s.configError) console.log('EROARE CONFIG: ' + s.configError);
  for (const c of s.cases) console.log((c.status === 'approved' ? '✓' : c.status === 'invalid' ? '✗' : '○') + ' ' + c.id + ' — ' + c.status + (c.reason ? ': ' + c.reason : ''));
  console.log('\n' + s.positioning);
  process.exit(s.ready ? 0 : 2);
}
