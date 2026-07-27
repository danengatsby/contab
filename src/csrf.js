'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  CSRF: TOKEN SINCRONIZATOR + ALLOWLIST DE ORIGINE
//
//  Ce era inainte: garda accepta cererea daca `Origin`/`Referer` lipsea, „pentru compatibilitate"
//  (curl, integrari server-to-server). Rationamentul era ca un CSRF cu cookie presupune un browser,
//  iar browserul trimite antetul. E adevarat pentru navigarea obisnuita, dar e o presupunere despre
//  ATACATOR, nu despre protocol: exista contexte in care browserul NU trimite Origin pe o cerere
//  cross-site (unele navigari declansate de formular, politici de referrer restrictive, agenti
//  intermediari care curata antetele). Iar o gaura care se deschide „cand lipseste un antet" e exact
//  genul de conditie pe care un atacator o cauta. Pentru actiuni cu efect financiar, presupunerea
//  nu e acceptabila.
//
//  Ce face acum:
//   1. daca `Origin`/`Referer` EXISTA -> gazda trebuie sa fie in allowlist (propria gazda + cele
//      configurate). Origine straina = respins, indiferent de token.
//   2. daca cererea poarta un cookie de sesiune -> token-ul e OBLIGATORIU, si cand antetul lipseste.
//      Lipsa antetului nu mai e o portita.
//   3. daca NU exista sesiune -> nu e nimic de calarit (CSRF exploateaza credentiale ambientale),
//      deci trece: login, inregistrare, webhook Stripe, plati de vizitator raman functionale.
//
//  Token-ul e DERIVAT, nu stocat: HMAC(secretul de semnare, 'csrf:' + sessId). Consecinte:
//   - legat de sesiune (alta sesiune -> alt token), deci nu poate fi reutilizat intre conturi;
//   - se invalideaza SINGUR la delogare, la revocarea sesiunii si la rotirea secretului;
//   - nu adauga camp in baza, deci nu are probleme de sincronizare sau de curatenie.
//  Nu e secret fata de propriul client (i-l dam prin /api/me) — dar un site strain nu-l poate citi,
//  fiindca nu poate citi raspunsurile noastre (same-origin policy).
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

/** Token-ul CSRF al unei sesiuni. Gol daca lipseste sesiunea sau secretul (nu emitem token slab). */
function tokenFor(sessId, secret) {
  if (!sessId || !secret) return '';
  return crypto.createHmac('sha256', String(secret)).update('csrf:' + String(sessId)).digest('hex').slice(0, 32);
}

/** Comparatie in timp constant (evita distingerea prefixului corect prin masurarea duratei). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

/** Gazdele acceptate: propria gazda + `extra` (CONTAB_CSRF_ORIGINS, separate prin virgula). */
function allowedHosts(reqHost, extra) {
  const out = new Set();
  if (reqHost) out.add(String(reqHost).toLowerCase());
  for (const e of String(extra || '').split(',')) {
    const s = e.trim(); if (!s) continue;
    try { out.add(new URL(s.includes('//') ? s : 'https://' + s).host.toLowerCase()); } catch (_) { out.add(s.toLowerCase()); }
  }
  return out;
}

/** Gazda din Origin/Referer, sau null daca antetul lipseste ori e nevalid. */
function sourceHost(headers) {
  const src = (headers || {}).origin || (headers || {}).referer;
  if (!src) return null;
  try { return new URL(src).host.toLowerCase(); } catch (_) { return null; }
}

/**
 * Verdictul garzii pentru o cerere MUTANTA deja filtrata pe cale (API/livrabile, fara webhook).
 * @param {object} p { headers, sessId, secret, extraOrigins }
 * @returns {{ ok:boolean, reason?:string, motiv?:string }}
 */
function check(p) {
  const headers = p.headers || {};
  const host = sourceHost(headers);
  if (host !== null) {
    // antet PREZENT: gazda trebuie sa fie a noastra. Verificam intai, ca o origine straina sa fie
    // respinsa chiar daca ar fi ghicit un token.
    if (!allowedHosts(headers.host, p.extraOrigins).has(host)) {
      return { ok: false, reason: 'origin', motiv: 'Cerere respinsă (origine străină).' };
    }
  }
  // Fara sesiune nu exista credentiale ambientale de exploatat.
  if (!p.sessId) return { ok: true };
  const asteptat = tokenFor(p.sessId, p.secret);
  if (!asteptat) return { ok: true }; // fara secret nu putem emite token; nu blocam aplicatia
  const primit = headers['x-csrf-token'] || '';
  if (!safeEqual(primit, asteptat)) {
    return { ok: false, reason: 'token', motiv: 'Cerere respinsă (token CSRF lipsă sau invalid). Reîncarcă pagina.' };
  }
  return { ok: true };
}

module.exports = { tokenFor, check, allowedHosts, sourceHost, safeEqual };
