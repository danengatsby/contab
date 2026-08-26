'use strict';

const SCOPES = new Set(['restore', 'bulk-export', 'filing', 'impersonation']);
const TTL_MS = Math.max(60 * 1000, Number(process.env.CONTAB_STEP_UP_TTL_MINUTES || 5) * 60 * 1000);

function principal(req) { return req && (req.realUser || req.user); }
function session(req) {
  const u = principal(req);
  return u && (u.sessions || []).find((s) => s.id === req._sessId) || null;
}

function grant(req, scope, now) {
  if (!SCOPES.has(scope)) throw new Error('Scop step-up necunoscut: ' + scope);
  const s = session(req);
  if (!s) return null;
  const t = Number(now == null ? Date.now() : now);
  s.stepUp = s.stepUp && typeof s.stepUp === 'object' ? s.stepUp : {};
  s.stepUp[scope] = { verifiedAt: new Date(t).toISOString(), expiresAt: new Date(t + TTL_MS).toISOString() };
  return s.stepUp[scope];
}

function valid(req, scope, now) {
  const s = session(req); const row = s && s.stepUp && s.stepUp[scope];
  return !!(SCOPES.has(scope) && row && Date.parse(row.expiresAt || 0) > Number(now == null ? Date.now() : now));
}

function requiredResponse(res, scope) {
  return res.status(428).json({
    error: 'Operațiunea cere reconfirmarea recentă a parolei și a codului TOTP.',
    stepUpRequired: true,
    stepUpScope: scope,
  });
}

module.exports = { SCOPES, TTL_MS, principal, session, grant, valid, requiredResponse };
