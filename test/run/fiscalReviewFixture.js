'use strict';

// Identitate criptografică EFEMERĂ, exclusiv pentru teste. Cheia privată nu este scrisă pe disc,
// iar numele/calitatea indică explicit că nu reprezintă o revizie profesională reală.
const crypto = require('crypto');
const fs = require('fs');
const review = require('../../src/fiscalReview');
const cfg = require('../../src/fiscalConfig');

const REVIEWER = 'Revizor sintetic TEST';
const CREDENTIAL = 'NEVALID — identitate criptografică exclusiv pentru teste automate';
const keys = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const KEY_ID = review.publicKeyId(publicKeyPem);

function trustBundle() {
  return {
    schemaVersion: review.TRUST_SCHEMA,
    description: 'Registru efemer de test; nu autorizează un profesionist real.',
    reviewers: {
      [KEY_ID]: {
        reviewer: REVIEWER,
        credential: CREDENTIAL,
        credentialVerifiedAt: '2026-08-24',
        credentialEvidence: 'TEST-ONLY; nu este o verificare într-un registru profesional.',
        publicKeyPem,
        validFrom: '2026-01-01',
      },
    },
  };
}

function approvedBundle() {
  const approvals = {};
  const context = review.reviewContext();
  for (const c of review.CASES) {
    const approval = {
      decision: 'approved',
      fiscalYear: cfg.AN,
      reviewer: REVIEWER,
      credential: CREDENTIAL,
      reviewedAt: '2026-08-24',
      legalBasis: 'Dosar fiscal sintetic de test; nu reprezintă aprobare profesională reală.',
      evidenceDocumentSha256: crypto.createHash('sha256').update('test-dossier:' + c.id).digest('hex'),
      keyId: KEY_ID,
      hash: review.currentHash(c, context),
    };
    approval.signature = crypto.sign(null, Buffer.from(review.signatureMessage(c.id, approval), 'utf8'), keys.privateKey).toString('base64');
    approvals[c.id] = approval;
  }
  return { schemaVersion: review.APPROVAL_SCHEMA, approvals };
}

function writeApproved(file, trustFile) {
  const bundle = approvedBundle();
  fs.writeFileSync(file, JSON.stringify(bundle));
  if (trustFile) fs.writeFileSync(trustFile, JSON.stringify(trustBundle()));
  return bundle;
}

module.exports = { KEY_ID, trustBundle, approvedBundle, writeApproved };
