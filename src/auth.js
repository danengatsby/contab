'use strict';

const crypto = require('crypto');

// scrypt costa ~30 ms de CPU, deliberat. In forma SINCRONA acele 30 ms sunt buclă de evenimente
// BLOCATA: procesul e unul singur, deci cat dureaza un hash nu se serveste nicio alta cerere,
// oricat de ieftina. Varianta asincrona muta calculul pe threadpool-ul libuv (implicit 4 fire,
// UV_THREADPOOL_SIZE) — bucla ramane libera, iar hash-urile concurente chiar merg in paralel.
//
// Amandoua raman: pe caile de CERERE se foloseste cea asincrona (vezi poarta din test/run.js),
// iar cea sincrona ramane pentru pornire/migrare (db.js), unde nu exista cereri de blocat si
// unde un await ar contamina un `load()` sincron.
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);
const KEYLEN = 64;

/** Comparatia in timp constant — scrisa O SINGURA DATA, ca variantele sa nu poata diverge. */
function sameHash(hexNou, hexStocat) {
  const a = Buffer.from(hexNou); const b = Buffer.from(String(hexStocat));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Hash de parola cu scrypt + salt aleator. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEYLEN).toString('hex');
  return { salt, hash };
}
async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(String(password), salt, KEYLEN)).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  return sameHash(crypto.scryptSync(String(password), salt, KEYLEN).toString('hex'), hash);
}
async function verifyPasswordAsync(password, salt, hash) {
  if (!salt || !hash) return false;
  return sameHash((await scryptAsync(String(password), salt, KEYLEN)).toString('hex'), hash);
}

// Amprenta-MOMEALA: un salt/hash valid peste o parola aleatoare, imposibil de nimerit. Serveste
// exclusiv la a consuma acelasi scrypt cand contul nu exista. Se genereaza la incarcarea
// modulului (o singura data, ~30 ms la pornire) ca sa nu stea o valoare fixa in depozit.
const DECOY = hashPassword(crypto.randomBytes(32).toString('hex'));

/**
 * Verifica parola pentru un utilizator care POATE lipsi — singura forma admisa pe rutele PUBLICE.
 *
 * Forma naiva `!u || !verifyPassword(pw, u.salt, u.hash)` scurtcircuiteaza: pe contul inexistent
 * scrypt nu mai ruleaza deloc, deci raspunsul vine in ~0 ms fata de ~30 ms pentru un cont real.
 * Diferenta e cu doua ordine de marime peste zgomotul retelei, deci raspunsul 401 — identic ca
 * text si status — spune totusi atacatorului daca numele exista. Aici scrypt ruleaza EXACT o data
 * pe ambele ramuri; `user` fals inseamna doar ca rezultatul e aruncat.
 */
function decoyed(user) {
  const usable = !!(user && user.salt && user.hash); // un cont fara credentiale nu se autentifica
  return { usable, salt: usable ? user.salt : DECOY.salt, hash: usable ? user.hash : DECOY.hash };
}
function verifyUserPassword(user, password) {
  const d = decoyed(user);
  const okHash = verifyPassword(password, d.salt, d.hash); // ruleaza INTOTDEAUNA
  return d.usable && okHash;
}
/** Varianta asincrona — cea care trebuie folosita pe caile de cerere (scrypt pe threadpool,
 *  bucla libera). Aceeasi alegere de momeala, deci aceleasi proprietati anti-enumerare. */
async function verifyUserPasswordAsync(user, password) {
  const d = decoyed(user);
  const okHash = await verifyPasswordAsync(password, d.salt, d.hash); // ruleaza INTOTDEAUNA
  return d.usable && okHash;
}

// Politica de parole (centralizata) pentru fluxurile self-service — unde proprietarul contului
// isi alege singur parola: inscriere, resetare, acceptare invitatie, schimbare parola. Intoarce
// un mesaj de eroare (string) sau null daca parola e acceptabila. Fara dependinte: lungime minima
// + o lista mica de parole prea comune (inclusiv parola implicita „admin") + interdictia ca parola
// sa fie identica cu numele de utilizator. Nu se aplica la login (conturile vechi raman valide).
const MIN_PASSWORD = 8;
const WEAK_PASSWORDS = new Set([
  'password', 'passw0rd', 'password1', 'password123', 'parola', 'parola123', 'parolamea',
  '12345678', '123456789', '1234567890', 'qwerty', 'qwertyui', 'qwerty123', 'qwertyuiop',
  'admin', 'admin123', 'administrator', 'contab', 'contabo', 'contabil', 'contabilitate',
  'iloveyou', 'welcome', 'welcome1', 'letmein', 'abc12345', 'abcd1234', '11111111', '00000000',
  'aaaaaaaa', 'baseball', 'football', 'sunshine', 'princess', 'dragon123', 'monkey12',
]);
function validatePassword(password, opts) {
  const p = String(password == null ? '' : password);
  const o = opts || {};
  if (p.length < MIN_PASSWORD) return 'Parola prea scurta (minim ' + MIN_PASSWORD + ' caractere).';
  if (WEAK_PASSWORDS.has(p.toLowerCase())) return 'Parola aleasa este prea comuna — alege una mai greu de ghicit.';
  if (o.username && p.toLowerCase() === String(o.username).toLowerCase()) return 'Parola nu poate fi identica cu numele de utilizator.';
  return null;
}

const MIN_USERNAME = 3;
// Caractere invizibile folosite la mascare: control, zero-width, spatii exotice si marcajele
// bidirectionale (RLO/LRO/PDF…), cu care doua nume pot arata IDENTIC pe ecran fara sa fie egale.
const INVIZIBILE = /[\u0000-\u001F\u007F\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/;

/** Forma canonica a numelui de utilizator: fara spatii la capete si fara siruri de spatii
 *  interioare. Doua nume care difera doar prin spatii devin acelasi nume — altfel „ana" si
 *  „ana  b" arata aproape la fel in liste si in jurnalul de audit. */
function normalizeUsername(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
}
/** Intoarce mesajul de eroare sau null. Se aplica DOAR la creare: numele deja existente raman
 *  valabile (o regula noua nu are voie sa blocheze conturi care functionau). */
function validateUsername(raw) {
  const u = normalizeUsername(raw);
  if (u.length < MIN_USERNAME) return 'Utilizator prea scurt (minim ' + MIN_USERNAME + ' caractere).';
  if (u.length > 60) return 'Utilizator prea lung (maxim 60 de caractere).';
  if (INVIZIBILE.test(u)) return 'Numele de utilizator contine caractere invizibile sau de control.';
  return null;
}
/** Cautare de duplicat INSENSIBILA la litere mari/mici si la spatii — aceeasi regula pe toate
 *  caile de creare (inscriere publica si adaugare din admin), care pana acum difereau. */
function usernameTaken(users, raw) {
  const u = normalizeUsername(raw).toLowerCase();
  return (users || []).some((x) => normalizeUsername(x.username).toLowerCase() === u);
}

// Verifica parola contra bazei HaveIBeenPwned prin k-ANONIMITATE: se trimite DOAR primele 5
// caractere din SHA1 (hex majuscul); serverul intoarce sufixele + nr. aparitii. Parola intreaga
// NU pleaca niciodata (antetul Add-Padding maschează si dimensiunea raspunsului). Suplimenteaza
// validatePassword (sincron: lungime + blacklist) cu o verificare de COMPROMITERE reala.
// FAIL-OPEN: orice eroare (retea/timeout/non-200) -> permite; nu blocam auth pe un serviciu
// extern indisponibil. Dezactivabil: CONTAB_HIBP=0 (ex. instalari izolate, fara internet).
const HIBP_ON = process.env.CONTAB_HIBP !== '0';
// Cat asteptam raspunsul de la Have I Been Pwned inainte sa renuntam. Verificarea e un BONUS de
// securitate, nu o conditie: daca serviciul e lent sau cazut, inregistrarea nu are voie sa stea
// dupa el. CONTAB_HIBP_TIMEOUT_MS ajusteaza pragul; CONTAB_HIBP=0 opreste verificarea de tot.
const HIBP_TIMEOUT_MS = Number(process.env.CONTAB_HIBP_TIMEOUT_MS) || 2500;
async function breachCheck(password) {
  if (!HIBP_ON) return null;
  try {
    const sha1 = crypto.createHash('sha1').update(String(password == null ? '' : password)).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5); const suffix = sha1.slice(5);
    const r = await fetch('https://api.pwnedpasswords.com/range/' + prefix, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'contab-password-check' },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });
    if (!r.ok) return null; // fail-open
    const text = await r.text();
    for (const line of text.split('\n')) {
      const [suf, count] = line.trim().split(':');
      if (suf === suffix && Number(count) > 0) return 'Parola apare in liste publice de parole compromise — alege alta.';
    }
    return null;
  } catch (_) { return null; } // fail-open: HIBP indisponibil nu blocheaza autentificarea
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

module.exports = {
  hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync,
  verifyUserPassword, verifyUserPasswordAsync, validatePassword, breachCheck, sign, verify, parseCookies,
  normalizeUsername, validateUsername, usernameTaken, MIN_PASSWORD, MIN_USERNAME,
};
