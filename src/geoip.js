'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  LOCALIZAREA APROXIMATIVA A UNEI ADRESE IP (tara / regiune / oras / operator)
//
//  Folosita DOAR in panoul de administrare „Cine acceseaza aplicatia": adminul vede de unde se
//  conecteaza conturile, ca sa poata recunoaste un acces nefiresc. Nu intra in nicio decizie
//  automata — e informatie pentru un om.
//
//  Furnizorul e EXTERN (ipwho.is), deci adresele IP ale utilizatorilor pleaca la un tert. Asta il
//  face SUBIMPUTERNICIT si e declarat ca atare in public/confidentialitate.html si in Anexa 2 din
//  public/dpa.html. Exista o poarta in test/run/porti.js care pica daca modulul e folosit fara sa
//  fie declarat — regula proiectului: furnizorii chiar folositi de cod trebuie sa fie DECLARATI,
//  altfel lista din DPA e o fictiune.
//
//  Trei reguli care tin interogarile la minim (si datele acasa):
//   1. adresele PRIVATE nu pleaca niciodata — nu au ce cauta la un serviciu public si ar scurge
//      topologia retelei interne degeaba;
//   2. cache pe IP, cu TTL lung: localizarea unui IP nu se schimba de la o afisare la alta, iar
//      panoul se poate reincarca de zeci de ori;
//   3. o singura cerere in zbor per IP (single-flight): doua randuri cu acelasi IP in acelasi
//      tabel produceau altfel doua apeluri identice.
//
//  Esecul NU e o eroare: lista trebuie sa se afiseze si cand serviciul e cazut sau plafonat.
//  `lookup` intoarce atunci `null`, iar interfata arata „—". „Nu stiu de unde" e un raspuns
//  acceptabil aici; o pagina de administrare care nu se mai deschide, nu.
// ─────────────────────────────────────────────────────────────────────────────

const log = require('./log');

const URL_BAZA = process.env.CONTAB_GEOIP_URL || 'https://ipwho.is/';
const TIMEOUT_MS = Number(process.env.CONTAB_GEOIP_TIMEOUT_MS) || 4000;
const TTL_MS = 30 * 24 * 3600 * 1000;   // localizarea unui IP e stabila; 30 de zile e generos
const MAX_CACHE = 2000;                  // plafon de memorie (garda OOM, ca la restul colectiilor)
const MAX_PARALEL = 4;                   // cate IP-uri necunoscute se interogheaza simultan

const cache = new Map();      // ip -> { val, exp }
const inZbor = new Map();     // ip -> Promise (single-flight)

/** `::ffff:1.2.3.4` (IPv4 mapat in IPv6) -> `1.2.3.4`; restul se normalizeaza doar ca forma. */
function normalizeIp(ip) {
  const s = String(ip == null ? '' : ip).trim().toLowerCase();
  const m = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return m ? m[1] : s;
}

/**
 * Adresa e din spatiul privat/local, deci NU are voie sa plece la un serviciu extern?
 * Include si CGNAT (100.64/10) si link-local — un IP de acolo nu spune nimic unui serviciu public,
 * dar spune ceva despre reteaua noastra.
 */
function isPrivate(ip) {
  const s = normalizeIp(ip);
  if (!s || s === 'unknown' || s === 'necunoscut') return true;
  if (s === '::1' || s === '::' || s === 'localhost') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;       // fc00::/7 unique-local
  if (/^fe80:/.test(s)) return true;                    // link-local IPv6
  const p = s.split('.');
  if (p.length !== 4) return false;                     // IPv6 public (sau forma necunoscuta)
  const [a, b] = p.map(Number);
  if (![a, b].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return true; // malformat -> nu pleaca
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;              // link-local IPv4
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  return false;
}

/**
 * Raspunsul furnizorului -> forma noastra. PUR, deci verificabil fara retea.
 * Intoarce `null` daca raspunsul nu e utilizabil (serviciul semnaleaza esecul cu `success:false`,
 * nu cu un cod HTTP de eroare — un `res.ok` singur ar fi luat esecul drept reusita).
 */
function parseRaspuns(j) {
  if (!j || typeof j !== 'object' || j.success === false) return null;
  const tara = String(j.country || '').trim();
  const oras = String(j.city || '').trim();
  const regiune = String(j.region || '').trim();
  if (!tara && !oras && !regiune) return null;
  const con = j.connection || {};
  return {
    tara,
    taraCod: String(j.country_code || '').trim().toUpperCase(),
    regiune,
    oras,
    operator: String(con.isp || con.org || '').trim(),
  };
}

/** Eticheta scurta pentru interfata: „Cluj-Napoca, RO". Pura. */
function eticheta(g) {
  if (!g) return '';
  const parti = [g.oras, g.regiune && g.regiune !== g.oras ? g.regiune : '', g.taraCod || g.tara]
    .map((x) => String(x || '').trim()).filter(Boolean);
  return [...new Set(parti)].join(', ');
}

function dinCache(ip) {
  const h = cache.get(ip);
  if (!h) return undefined;
  if (h.exp < Date.now()) { cache.delete(ip); return undefined; }
  return h.val;
}
function inCache(ip, val) {
  // plafon simplu: la depasire se arunca cea mai veche intrare (Map pastreaza ordinea inserarii)
  if (cache.size >= MAX_CACHE) { const prima = cache.keys().next(); if (!prima.done) cache.delete(prima.value); }
  cache.set(ip, { val, exp: Date.now() + TTL_MS });
}

/** Cererea propriu-zisa, cu timeout. Orice esec devine `null` — niciodata o exceptie. */
async function interogheaza(ip) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_BAZA + encodeURIComponent(ip), {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'contab-geoip/1.0' },
    });
    if (!res.ok) return null;
    return parseRaspuns(await res.json());
  } catch (e) {
    log.warn('geoip: interogare esuata', log.ctx(null, { ip, err: String((e && e.message) || e).slice(0, 120) }));
    return null;
  } finally { clearTimeout(t); }
}

/**
 * Localizarea unui IP: din cache daca se poate, altfel o singura cerere externa.
 * @returns {Promise<null | { tara, taraCod, regiune, oras, operator }>} `null` = necunoscut.
 */
async function lookup(ip) {
  const s = normalizeIp(ip);
  if (!s || isPrivate(s)) return null;
  const hit = dinCache(s);
  if (hit !== undefined) return hit;
  if (inZbor.has(s)) return inZbor.get(s);
  const p = interogheaza(s)
    .then((val) => { inCache(s, val); return val; })
    .finally(() => inZbor.delete(s));
  inZbor.set(s, p);
  return p;
}

/**
 * Localizeaza o multime de IP-uri, in valuri de cel mult MAX_PARALEL.
 * Duplicatele se rezolva o singura data (Set + single-flight).
 * @returns {Promise<Map<string, object|null>>} indexat pe IP NORMALIZAT.
 */
async function lookupMany(ips) {
  const unice = [...new Set((ips || []).map(normalizeIp).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < unice.length; i += MAX_PARALEL) {
    const lot = unice.slice(i, i + MAX_PARALEL);
    const rez = await Promise.all(lot.map((ip) => lookup(ip)));
    lot.forEach((ip, k) => out.set(ip, rez[k]));
  }
  return out;
}

/** Doar pentru teste: goleste cache-ul si cererile in zbor. */
function _reset() { cache.clear(); inZbor.clear(); }

module.exports = { lookup, lookupMany, eticheta, normalizeIp, isPrivate, parseRaspuns, _reset, TTL_MS, MAX_CACHE };
