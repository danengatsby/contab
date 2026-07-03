'use strict';

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Genereaza un secret nou (base32, 20 octeti). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** Cod TOTP pentru un secret la un anumit pas de timp. */
function codeForCounter(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

/** Verifica un cod (cu fereastra +/- window pasi de 30s). */
function verify(secret, token, window) {
  if (!secret || !token) return false;
  const t = String(token).replace(/\s/g, '');
  const w = window == null ? 1 : window;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let i = -w; i <= w; i++) {
    if (codeForCounter(secret, counter + i) === t) return true;
  }
  return false;
}

/** URI otpauth pentru aplicatiile de autentificare (Google Authenticator etc.). */
function otpauthURL(label, secret, issuer) {
  const iss = encodeURIComponent(issuer || 'Contabo');
  return `otpauth://totp/${iss}:${encodeURIComponent(label)}?secret=${secret}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, verify, otpauthURL, codeForCounter };
