'use strict';

// Service layer pentru contul utilizatorului autentificat: 2FA (TOTP), sesiunile active,
// schimbarea parolei si profilul. Rutele (src/routes/account.js) raman puncte de intrare
// subtiri: parseaza cererea, apeleaza serviciul si traduc erorile (`err.status`) in HTTP.
//
// Spre deosebire de serviciile pe firma (reqFirma), aici resursa este chiar utilizatorul
// autentificat, primit ca obiect viu din baza de date. Garda de autorizare este reqNotDemo:
// contul demo e public si partajat, deci scrierile pe cont sunt refuzate si la nivel de
// serviciu — un apelant viitor nu poate ocoli blocajul sarind peste ruta.

const db = require('./db');
const totp = require('./totp');
const authlib = require('./auth');
const plans = require('./plans');
const { isDemoUser } = require('./session');
const QRCode = require('qrcode-svg');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Conturile demo (demo / demo-contabil) sunt publice si partajate — orice scriere pe cont e refuzata. */
function reqNotDemo(u) {
  if (isDemoUser(u)) fail(403, 'Contul demo este public și partajat — setările contului nu se pot modifica. Înscrie-ți un cont propriu.');
}

// ── 2FA (TOTP) ──

function setup2fa(u) {
  reqNotDemo(u);
  if (u.twofa) fail(400, '2FA este deja activat.');
  u.pending2fa = totp.generateSecret();
  db.save();
  const otpauth = totp.otpauthURL(u.username, u.pending2fa, 'Contabo');
  let qrSvg = '';
  try { qrSvg = new QRCode({ content: otpauth, padding: 2, width: 180, height: 180, color: '#1a1f36', background: '#ffffff', ecl: 'M', join: true }).svg(); } catch (e) { /* QR optional */ }
  return { secret: u.pending2fa, otpauth, qrSvg };
}

function enable2fa(u, code) {
  reqNotDemo(u);
  if (!u.pending2fa) fail(400, 'Initiaza intai configurarea 2FA.');
  if (!totp.verify(u.pending2fa, code)) fail(400, 'Cod gresit. Verifica ora dispozitivului.');
  u.totpSecret = u.pending2fa; u.twofa = true; delete u.pending2fa;
  u.tfdEpoch = (u.tfdEpoch || 0) + 1; // invalideaza eventualele dispozitive de incredere vechi
  db.save();
}

function disable2fa(u, code) {
  reqNotDemo(u);
  if (!u.twofa) fail(400, '2FA nu este activat.');
  if (!totp.verify(u.totpSecret, code)) fail(400, 'Cod gresit.');
  u.twofa = false; delete u.totpSecret; delete u.pending2fa;
  u.tfdEpoch = (u.tfdEpoch || 0) + 1;
  db.save();
}

function revokeTrustedDevices(u) {
  reqNotDemo(u);
  u.tfdEpoch = (u.tfdEpoch || 0) + 1; // toate dispozitivele de incredere devin invalide
  db.save();
}

// ── Sesiuni active ──

function listSessions(u, currentSessId) {
  return (u.sessions || []).map((s) => ({
    id: s.id, ua: s.ua, ip: s.ip, createdAt: s.createdAt, lastSeen: s.lastSeen, current: s.id === currentSessId,
  })).reverse();
}

function logoutOtherSessions(u, currentSessId) {
  u.sessions = (u.sessions || []).filter((s) => s.id === currentSessId);
  db.save();
}

function revokeSession(u, sessId) {
  u.sessions = (u.sessions || []).filter((s) => s.id !== sessId);
  db.save();
}

// ── Parola + profil ──

function changePassword(u, oldPassword, newPassword) {
  reqNotDemo(u);
  if (!authlib.verifyPassword(oldPassword, u.salt, u.hash)) fail(400, 'Parola veche gresita.');
  const pwErr = authlib.validatePassword(newPassword, { username: u.username });
  if (pwErr) fail(400, pwErr);
  if (String(newPassword) === String(oldPassword)) fail(400, 'Parola noua trebuie sa fie diferita de cea veche.');
  const h = authlib.hashPassword(newPassword);
  u.salt = h.salt; u.hash = h.hash; u.mustChange = false;
  db.save();
}

/** Ascunde definitiv wizard-ul de prima autentificare pentru acest utilizator (checklist-ul
 *  discret de pe dashboard ramane). Persistat pe cont — supravietuieste schimbarii de browser. */
function dismissWizard(u) {
  reqNotDemo(u);
  u.wizardAscuns = true;
  db.save();
}

function getProfile(u) {
  return {
    username: u.username, email: u.email || '', role: u.role,
    tip: plans.userKind(u), notifyDeadlines: u.notifyDeadlines !== false,
    profil: u.profil || {},
  };
}

function updateProfile(u, b) {
  reqNotDemo(u); b = b || {};
  if (b.email != null) u.email = String(b.email);
  if (b.notifyDeadlines != null) u.notifyDeadlines = !!b.notifyDeadlines;
  // date personale (necontabil / contabil): nume, telefon, adresa + autorizatia contabilului
  if (b.profil && typeof b.profil === 'object') {
    const p = u.profil || {};
    for (const k of ['numeComplet', 'telefon', 'adresa', 'oras', 'judet', 'autorizatie']) {
      if (b.profil[k] != null) p[k] = String(b.profil[k]).slice(0, 120).trim();
    }
    u.profil = p;
  }
  db.save();
  return { email: u.email, notifyDeadlines: u.notifyDeadlines !== false, profil: u.profil || {} };
}

module.exports = {
  reqNotDemo,
  setup2fa, enable2fa, disable2fa, revokeTrustedDevices,
  listSessions, logoutOtherSessions, revokeSession,
  changePassword, getProfile, updateProfile, dismissWizard,
};
