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
const crypto = require('crypto');
const totp = require('./totp');
const authlib = require('./auth');
const plans = require('./plans');
const identitate = require('./identitate');
const { isDemoUser } = require('./session');
const QRCode = require('qrcode-svg');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Conturile demo (demo / demo-contabil) sunt publice si partajate — orice scriere pe cont e refuzata. */
function reqNotDemo(u) {
  if (isDemoUser(u)) fail(403, 'Contul demo este public și partajat — setările contului nu se pot modifica. Înscrie-ți un cont propriu.');
}

// ── 2FA (TOTP) ──

const RECOVERY_COUNT = 8;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // fara 0/O/1/I ambigue

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function recoveryHash(salt, code) {
  return crypto.createHash('sha256').update(String(salt) + ':' + normalizeRecoveryCode(code)).digest('hex');
}

/** Inlocuieste intreg setul. Valorile in clar se intorc o singura data; in baza raman doar hash-uri. */
function replaceRecoveryCodes(u) {
  const salt = crypto.randomBytes(16).toString('hex');
  const codes = [];
  for (let n = 0; n < RECOVERY_COUNT; n += 1) {
    let raw = '';
    const rnd = crypto.randomBytes(12);
    for (const b of rnd) raw += RECOVERY_ALPHABET[b & 31];
    codes.push(raw.match(/.{1,4}/g).join('-'));
  }
  u.twofaRecoverySalt = salt;
  u.twofaRecoveryHashes = codes.map((code) => recoveryHash(salt, code));
  return codes;
}

/** Consuma atomic in RAM un cod one-time. Persistenta este responsabilitatea apelantului. */
function consumeRecoveryCode(u, code) {
  const normalized = normalizeRecoveryCode(code);
  if (!u || !u.twofaRecoverySalt || !Array.isArray(u.twofaRecoveryHashes)
      || normalized.length !== 12 || ![...normalized].every((x) => RECOVERY_ALPHABET.includes(x))) return false;
  const candidate = Buffer.from(recoveryHash(u.twofaRecoverySalt, normalized), 'hex');
  let found = -1;
  for (let i = 0; i < u.twofaRecoveryHashes.length; i += 1) {
    const saved = Buffer.from(String(u.twofaRecoveryHashes[i] || ''), 'hex');
    if (saved.length === candidate.length && crypto.timingSafeEqual(saved, candidate)) found = i;
  }
  if (found < 0) return false;
  u.twofaRecoveryHashes.splice(found, 1);
  return true;
}

function verifySecondFactor(u, code, opts) {
  const value = String(code || '').replace(/\s/g, '');
  if (/^\d{6}$/.test(value) && totp.verify(u && u.totpSecret, value)) return { ok: true, recovery: false };
  if ((!opts || opts.allowRecovery !== false) && consumeRecoveryCode(u, value)) return { ok: true, recovery: true };
  return { ok: false, recovery: false };
}

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
  const recoveryCodes = replaceRecoveryCodes(u);
  u.tfdEpoch = (u.tfdEpoch || 0) + 1; // invalideaza eventualele dispozitive de incredere vechi
  db.save();
  return { recoveryCodes };
}

function disable2fa(u, code) {
  reqNotDemo(u);
  if (!u.twofa) fail(400, '2FA nu este activat.');
  if (!verifySecondFactor(u, code).ok) fail(400, 'Cod TOTP sau cod de rezerva gresit.');
  u.twofa = false; delete u.totpSecret; delete u.pending2fa;
  delete u.twofaRecoverySalt; delete u.twofaRecoveryHashes;
  u.tfdEpoch = (u.tfdEpoch || 0) + 1;
  db.save();
}

function regenerateRecoveryCodes(u, code) {
  reqNotDemo(u);
  if (!u.twofa) fail(400, '2FA nu este activat.');
  // Regenerarea cere intentionat TOTP, nu un cod de rezerva: un singur cod furat nu poate crea
  // un set nelimitat. Utilizatorul fara dispozitiv poate intra cu rezerva si dezactiva 2FA.
  if (!totp.verify(u.totpSecret, code)) fail(400, 'Cod TOTP gresit.');
  const recoveryCodes = replaceRecoveryCodes(u);
  db.save();
  return { recoveryCodes };
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

// ASINCRON pentru scrypt: doua hash-uri (verificarea celei vechi + calculul celei noi) inseamna
// ~60 ms de bucla blocata daca s-ar face sincron — vezi src/auth.js.
async function changePassword(u, oldPassword, newPassword) {
  reqNotDemo(u);
  if (!await authlib.verifyPasswordAsync(oldPassword, u.salt, u.hash)) fail(400, 'Parola veche gresita.');
  const pwErr = authlib.validatePassword(newPassword, { username: u.username });
  if (pwErr) fail(400, pwErr);
  if (String(newPassword) === String(oldPassword)) fail(400, 'Parola noua trebuie sa fie diferita de cea veche.');
  const h = await authlib.hashPasswordAsync(newPassword);
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
  const p = u.profil || {};
  return {
    username: u.username, email: u.email || '', role: u.role,
    tip: plans.userKind(u), notifyDeadlines: u.notifyDeadlines !== false,
    // CNP-ul nu se intoarce niciodata intreg, nici propriului cont: ecranul serveste la a-l
    // RECUNOASTE, nu la a-l copia, iar o captura de ecran nu are ce sa divulge.
    profil: Object.assign({}, p, { cnp: identitate.maskCNP(p.cnp || ''), cnpSetat: !!p.cnp }),
  };
}

function updateProfile(u, b) {
  reqNotDemo(u); b = b || {};
  if (b.email != null) u.email = String(b.email);
  if (b.notifyDeadlines != null) u.notifyDeadlines = !!b.notifyDeadlines;
  // date personale (necontabil / contabil): nume, telefon, adresa + autorizatia contabilului
  if (b.profil && typeof b.profil === 'object') {
    const p = u.profil || {};
    for (const k of ['numeComplet', 'telefon', 'adresa', 'oras', 'judet', 'autorizatie', 'descriere']) {
      if (b.profil[k] != null) p[k] = String(b.profil[k]).slice(0, 400).trim();
    }
    // CNP: identitatea persoanei care detine firmele. Se valideaza (cifra de control) pentru ca o
    // greseala de tastare aici nu se mai vede niciodata — campul se afiseaza mascat dupa salvare.
    // Sirul mascat trimis inapoi de formular NU rescrie valoarea (ar distruge-o la prima salvare
    // a altui camp): se ignora orice valoare care nu e un CNP intreg.
    if (b.profil.cnp != null) {
      const brut = String(b.profil.cnp).trim();
      if (brut === '') delete p.cnp;
      else if (identitate.cnpKey(brut).length === 13) {
        if (!identitate.validCNP(brut)) fail(400, 'CNP invalid (cifra de control nu se potriveste). Verifică cifrele.');
        p.cnp = identitate.cnpKey(brut);
      }
    }
    // Apar sau nu in lista de contabili pe care o vad patronii. Optiune EXPLICITA: lista de
    // conturi ale aplicatiei nu se publica singura.
    if (b.profil.disponibilContabil != null) p.disponibilContabil = !!b.profil.disponibilContabil;
    u.profil = p;
  }
  db.save();
  return Object.assign({ email: u.email, notifyDeadlines: u.notifyDeadlines !== false }, { profil: getProfile(u).profil });
}

module.exports = {
  reqNotDemo,
  setup2fa, enable2fa, disable2fa, regenerateRecoveryCodes, revokeTrustedDevices,
  verifySecondFactor, consumeRecoveryCode, normalizeRecoveryCode,
  listSessions, logoutOtherSessions, revokeSession,
  changePassword, getProfile, updateProfile, dismissWizard,
};
