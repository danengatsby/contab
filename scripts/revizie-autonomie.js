'use strict';

// Utilitar READ-ONLY pentru corpusul mare de autonomie. Nu scrie aprobări și nu atinge chei
// private; emite numai hash-ul, șablonul și mesajul canonic pe care revizorul îl semnează extern.

const fs = require('fs');
const path = require('path');
const autonomy = require('../src/fiscalAutonomy');
const fiscalReview = require('../src/fiscalReview');

const args = process.argv.slice(2);
const command = args[0];

function approvalFrom(file, keyId) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (parsed.approvals && keyId) return parsed.approvals[keyId];
  return parsed;
}

if (command === '--hash') {
  const corpus = autonomy.readCorpus();
  console.log(autonomy.currentCorpusHash(corpus));
} else if (command === '--template') {
  console.log(JSON.stringify(autonomy.template(), null, 2));
} else if (command === '--payload') {
  const file = args[1]; const keyId = args[2];
  if (!file) { console.error('Utilizare: --payload aprobare.json [keyId]'); process.exit(1); }
  try {
    const approval = approvalFrom(file, keyId);
    if (!approval) throw new Error('aprobarea nu există pentru keyId-ul indicat');
    process.stdout.write(autonomy.signatureMessage(approval));
  } catch (error) { console.error('Aprobarea nu poate fi citită: ' + error.message); process.exit(1); }
} else if (command === '--key-id') {
  const file = args[1];
  if (!file) { console.error('Utilizare: --key-id cheie-publica.pem'); process.exit(1); }
  try { console.log(fiscalReview.publicKeyId(fs.readFileSync(path.resolve(file), 'utf8'))); }
  catch (error) { console.error('Cheia publică nu poate fi citită: ' + error.message); process.exit(1); }
} else {
  const s = autonomy.status();
  console.log('Poarta de autonomie fiscală — distinctă de lansarea 25/25');
  console.log(s.uniqueCases + '/' + s.minimumCases + ' scenarii unice trecute · '
    + s.approvedReviewers + '/' + s.minimumReviewers + ' revizori independenți');
  console.log('Corpus: ' + s.corpusHash);
  if (s.configError) console.log('EROARE CONFIG: ' + s.configError);
  for (const rule of s.rules) {
    console.log((rule.ready ? '✓' : '○') + ' ' + rule.ruleId + ' — '
      + rule.coverage.uniqueCases + '/' + rule.coverage.minimumUniqueCases + ' cazuri unice · '
      + rule.coverage.coveredDimensions + '/' + rule.coverage.requiredDimensions + ' dimensiuni'
      + (rule.blockers.length ? ' · ' + rule.blockers.join(' ') : ''));
  }
  process.exit(s.ready ? 0 : 2);
}
