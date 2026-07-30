'use strict';

// Primitive de autentificare si sesiune (partajate de server.js si de rutele de cont):
// identificarea utilizatorului din cookie (cu suport de impersonare), obiectul public al
// utilizatorului, igiena sesiunilor server-side, cookie-urile semnate (sesiune + dispozitiv de
// incredere 2FA) si protectia anti-brute-force per IP. Logica de audit si scoping pe firma
// (logAudit, activeId, withSessionState) ramane in server.js — depinde de firma activa/mesaje.

const crypto = require('crypto');
const db = require('./db');
const authlib = require('./auth');
const plans = require('./plans');

// Cheia de semnare a token-urilor: env-ul (CONTAB_AUTH_SECRET) e AUTORITATEA daca e setat
// (nu sta in baza/backup, nu e scriabil din aplicatie); altfel fallback-ul aleator din baza.
function signingSecret(d) { return process.env.CONTAB_AUTH_SECRET || d.settings.authSecret; }

function currentUser(req) {
  const d = db.get();
  const token = authlib.parseCookies(req.headers.cookie).sid;
  const p = authlib.verify(token, signingSecret(d));
  if (!p) return null;
  const u = d.users.find((x) => x.id === p.uid);
  if (!u) return null;
  // sesiuni server-side OBLIGATORII: orice token de sesiune (sid) e emis cu sessId
  // (setSession); un token FARA sessId e forjat -> respins. Fara aceasta garda, un secret
  // compromis permitea un token {uid} sessionless care sarea peste verificarea de revocare.
  if (!p.sessId) return null;
  const sess = (u.sessions || []).find((x) => x.id === p.sessId);
  if (!sess) return null; // sesiune revocata -> delogat
  req._sessId = p.sessId;
  if (Date.now() - Date.parse(sess.lastSeen || 0) > 5 * 60 * 1000) { sess.lastSeen = new Date().toISOString(); pruneSessions(u); db.save(); }
  req.realUser = u;
  req.impersonating = false;
  // Impersonare: doar un admin, prin marcaj pe propria sesiune, devine efectiv utilizatorul-tinta.
  // Toate rutele opereaza apoi ca acel utilizator; rutele requireAdmin raman blocate (sandbox).
  if (sess && sess.impersonating != null && u.role === 'admin') {
    const target = d.users.find((x) => x.id === sess.impersonating);
    if (target && target.role !== 'admin') { req.impersonating = true; return target; }
    delete sess.impersonating; // tinta a disparut/nevalida -> curata
  }
  return u;
}
function allowedFirme(u) {
  const d = db.get();
  return u.role === 'admin' ? d.firme.map((f) => f.id) : (u.firme || []);
}
function publicUser(u) {
  const p = u.profil || {};
  return {
    id: u.id, username: u.username, role: u.role, tip: plans.userKind(u), firme: allowedFirme(u),
    drepturi: u.drepturi || {},
    mustChange: !!u.mustChange, twofa: !!u.twofa,
    profilComplet: !!(p.numeComplet && p.telefon), // datele personale minime sunt completate?
    subExpirat: plans.expiredLock(u), // proba expirata -> cont read-only (banner in UI)
  };
}

// Igiena sesiunilor: elimina sesiunile vechi (peste TTL) si plafoneaza nr. de dispozitive active.
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 zile (cat traieste cookie-ul/tokenul)
const MAX_SESSIONS = 10;                   // dispozitive active maxime per utilizator
function pruneSessions(u) {
  if (!u || !u.sessions) return false;
  const before = u.sessions.length;
  const now = Date.now();
  u.sessions = u.sessions.filter((s) => now - Date.parse(s.lastSeen || s.createdAt || 0) < SESSION_TTL);
  if (u.sessions.length > MAX_SESSIONS) u.sessions = u.sessions.slice(-MAX_SESSIONS);
  return u.sessions.length !== before;
}
function cookieFlags(req) { return `HttpOnly; Path=/; SameSite=Lax;${req.secure ? ' Secure;' : ''}`; }
function setSession(req, res, uid, sessId) {
  const d = db.get();
  const token = authlib.sign({ uid, sessId, exp: Date.now() + 7 * 24 * 3600 * 1000 }, signingSecret(d));
  res.setHeader('Set-Cookie', `sid=${token}; Max-Age=${7 * 24 * 3600}; ${cookieFlags(req)}`);
}
// creeaza o sesiune noua (inregistrata pe utilizator) si seteaza cookie-ul
function startSession(req, res, u) {
  const sessId = crypto.randomBytes(12).toString('hex');
  u.sessions = u.sessions || [];
  u.sessions.push({
    id: sessId, ua: String(req.headers['user-agent'] || '').slice(0, 200),
    ip: attemptKey(req), createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(),
  });
  pruneSessions(u); // curata sesiunile vechi + plafoneaza la MAX_SESSIONS
  setSession(req, res, u.id, sessId);
}
function setTrustedDevice(req, res, u) {
  const d = db.get();
  const token = authlib.sign({ uid: u.id, ep: u.tfdEpoch || 0, kind: 'tfd', exp: Date.now() + 30 * 24 * 3600 * 1000 }, signingSecret(d));
  res.append('Set-Cookie', `tfd=${token}; Max-Age=${30 * 24 * 3600}; ${cookieFlags(req)}`);
}
function deviceTrusted(req, u) {
  const tok = authlib.parseCookies(req.headers.cookie).tfd;
  const p = authlib.verify(tok, signingSecret(db.get()));
  return !!(p && p.kind === 'tfd' && p.uid === u.id && (p.ep || 0) === (u.tfdEpoch || 0));
}

// anti-brute-force: blocheaza dupa prea multe esecuri (per IP), pe o fereastra de timp
const loginAttempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;
function attemptKey(req) { return String(req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown'); }
function isLocked(req) {
  const r = loginAttempts.get(attemptKey(req));
  return r && r.count >= MAX_ATTEMPTS && r.until > Date.now() ? Math.ceil((r.until - Date.now()) / 60000) : 0;
}
function bumpFail(req) {
  const k = attemptKey(req);
  const r = loginAttempts.get(k) || { count: 0, until: 0 };
  r.count += 1; r.until = Date.now() + LOCK_MS;
  loginAttempts.set(k, r);
}
function clearFails(req) { loginAttempts.delete(attemptKey(req)); }
// Igiena rate-limit: fara curatare, map-ul ar creste nelimitat (cate o intrare per IP esuat).
function pruneLoginAttempts(now = Date.now()) {
  for (const [k, r] of loginAttempts) { if (r.until < now) loginAttempts.delete(k); }
}

// Conturile demonstrative publice (partajate, resetate zilnic): patronul (`demo`) si contabilul
// (`demo-contabil`). Ambele sunt „demo" — blocate de la gestionarea contului/firmelor; folosite
// pentru a demonstra colaborarea patron<->contabil pe firma demo.
const DEMO_USERS = ['demo', 'demo-contabil'];
function isDemoUser(user) { return !!(user && DEMO_USERS.includes(user.username)); }

/** Id-ul sesiunii din cookie-ul semnat, FARA a atinge utilizatorul (garda CSRF ruleaza inaintea
 *  middleware-ului de autentificare, deci nu se poate baza pe `req.user`). Null daca lipseste ori
 *  cookie-ul nu verifica — un token forjat nu trebuie sa dea un sessId pe care sa se derive CSRF. */
function sessionIdOf(req) {
  try {
    const d = db.get();
    const p = authlib.verify(authlib.parseCookies((req || {}).headers ? req.headers.cookie : '').sid, signingSecret(d));
    if (!p || !p.sessId) return null;
    // Sesiunea trebuie sa fie si VIE, nu doar semnata corect — aceeasi conditie pe care o pune
    // currentUser (utilizator existent + sesiune nerevocata).
    //
    // Cat timp aici era de ajuns semnatura, un cookie ramas de la o sesiune REVOCATA sau expirata
    // facea token-ul CSRF obligatoriu pe pagina de LOGIN, unde el nu poate fi obtinut: /api/meta
    // raspunde 401, deci clientul n-are de unde lua `user.csrf`. Efectul: utilizatorul nu se mai
    // putea autentifica DELOC — nici demo, nici cu parola, nici inscriere — iar mesajul „Reincarca
    // pagina" nu ajuta, fiindca dupa reincarcare situatia e identica. Singura iesire era stergerea
    // manuala a cookie-urilor.
    //
    // Pentru CSRF, un cookie mort e echivalent cu lipsa sesiunii: nu ofera credentiale ambientale
    // de calarit. Pentru sesiunile VII nimic nu se schimba — token-ul ramane obligatoriu.
    const u = (d.users || []).find((x) => x.id === p.uid);
    if (!u || !(u.sessions || []).some((s) => s.id === p.sessId)) return null;
    return p.sessId;
  } catch (_) { return null; }
}
/** Secretul din care se deriva token-ul CSRF (acelasi cu cel de semnare a sesiunii). */
function csrfSecret() { try { return signingSecret(db.get()); } catch (_) { return null; } }

module.exports = {
  currentUser, allowedFirme, publicUser, sessionIdOf, csrfSecret,
  startSession, setTrustedDevice, deviceTrusted,
  isLocked, bumpFail, clearFails, attemptKey, pruneLoginAttempts,
  DEMO_USERS, isDemoUser,
};
