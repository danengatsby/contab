'use strict';

const crypto = require('crypto');

/** Hash de parola cu scrypt + salt aleator. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(h); const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Token semnat (HMAC-SHA256) — stateless, supravietuieste restartului. */
function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + mac;
}
function verify(token, secret) {
  if (!token || String(token).indexOf('.') < 0) return null;
  const [body, mac] = String(token).split('.');
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(mac || ''); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(fromB64url(body).toString('utf8'));
    if (p.exp && p.exp < Date.now()) return null;
    return p;
  } catch (_) { return null; }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

module.exports = { hashPassword, verifyPassword, sign, verify, parseCookies };
