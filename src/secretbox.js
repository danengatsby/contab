'use strict';

// Criptare la nivel de CAMP pentru secretele operationale persistate in baza (parola SMTP,
// credentialele si token-urile SPV per firma). Cheia sta in AFARA bazei si a backupurilor
// (.env: CONTAB_SECRETS_KEY) — compromiterea unui backup nu mai expune credentiale vii.
//
//   seal(text)  -> 'enc:v1:<iv>:<tag>:<ct>' (AES-256-GCM); fara cheie, intoarce textul ca atare
//   open(val)   -> textul in clar; valorile ne-sigilate trec neatinse (compatibilitate);
//                  accepta si cheia VECHE (CONTAB_SECRETS_KEY_OLD) pentru rotatie:
//                  1) pune cheia noua in KEY si pe cea veche in KEY_OLD; 2) restart
//                  (migrarea re-sigileaza cu cheia noua); 3) sterge KEY_OLD.
//
// Cheia: 64 de caractere hex (32 de octeti) — genereaza cu: openssl rand -hex 32

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function keyFrom(envName) {
  const h = process.env[envName] || '';
  if (!/^[0-9a-f]{64}$/i.test(h)) return null;
  return Buffer.from(h, 'hex');
}

function hasKey() { return !!keyFrom('CONTAB_SECRETS_KEY'); }
function isSealed(v) { return typeof v === 'string' && v.startsWith(PREFIX); }

function seal(text) {
  const key = keyFrom('CONTAB_SECRETS_KEY');
  if (!key || text == null || text === '' || isSealed(text)) return text;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return PREFIX + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + ct.toString('base64');
}

function openWith(v, key) {
  const [ivB, tagB, ctB] = v.slice(PREFIX.length).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}

function open(v) {
  if (!isSealed(v)) return v; // compatibilitate: valorile vechi, in clar, trec neatinse
  for (const envName of ['CONTAB_SECRETS_KEY', 'CONTAB_SECRETS_KEY_OLD']) {
    const key = keyFrom(envName);
    if (!key) continue;
    try { return openWith(v, key); } catch (_) { /* incearca urmatoarea cheie */ }
  }
  const e = new Error('Secret criptat, dar CONTAB_SECRETS_KEY lipseste sau nu se potriveste.');
  e.status = 500;
  throw e;
}

module.exports = { seal, open, isSealed, hasKey };
