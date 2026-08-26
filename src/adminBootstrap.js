'use strict';

// Initializarea primei instalari nu foloseste o parola comuna si nu accepta trafic proxat.
// In baza ramane numai SHA-256(token); valoarea in clar este afisata o singura data in log.

const crypto = require('crypto');

const TTL_MS = 30 * 60 * 1000;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function pendingAdmin(d) {
  return (d && d.users || []).find((u) => u && u.role === 'admin' && u.bootstrapPending === true) || null;
}

function issueIfNeeded(d, now) {
  const admin = pendingAdmin(d);
  if (!admin) return null;
  d.settings = d.settings || {};
  const t = Number(now == null ? Date.now() : now);
  const current = d.settings.adminBootstrap || {};
  if (/^[a-f0-9]{64}$/.test(String(current.tokenHash || ''))
      && Date.parse(current.expiresAt || 0) > t) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  d.settings.adminBootstrap = {
    tokenHash: tokenHash(token),
    createdAt: new Date(t).toISOString(),
    expiresAt: new Date(t + TTL_MS).toISOString(),
  };
  console.log('[contab] INITIALIZARE ADMIN — token unic, valabil 30 minute, numai local: ' + token);
  console.log('[contab] POST direct pe loopback la /api/bootstrap/initialize cu { token, password }; cererile prin proxy sunt refuzate.');
  return token;
}

function matches(d, token, now) {
  const admin = pendingAdmin(d); const rec = d && d.settings && d.settings.adminBootstrap;
  if (!admin || !rec || Date.parse(rec.expiresAt || 0) <= Number(now == null ? Date.now() : now)) return false;
  const expected = Buffer.from(String(rec.tokenHash || ''), 'hex');
  const actual = Buffer.from(tokenHash(token), 'hex');
  return expected.length === actual.length && expected.length === 32 && crypto.timingSafeEqual(expected, actual);
}

function consume(d) {
  if (d && d.settings) delete d.settings.adminBootstrap;
}

function loopbackAddress(value) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(value || '').toLowerCase());
}

function localDirectRequest(req) {
  const headers = req && req.headers || {};
  const rawHost = String(headers.host || '').trim().toLowerCase();
  const host = rawHost.startsWith('[') ? rawHost.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')
    : rawHost.replace(/:\d+$/, '');
  const forwarded = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']
    .some((key) => headers[key] != null && String(headers[key]).trim() !== '');
  return loopbackAddress(req && req.socket && req.socket.remoteAddress)
    && ['localhost', '127.0.0.1', '::1'].includes(host) && !forwarded;
}

module.exports = { TTL_MS, tokenHash, pendingAdmin, issueIfNeeded, matches, consume, localDirectRequest };
