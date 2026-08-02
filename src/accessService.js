'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  „CINE ACCESEAZA APLICATIA" — raport de administrare, in trei tabele:
//
//   1. SESIUNI ACTIVE — cine e conectat acum, de pe ce IP si dispozitiv, de cand.
//      Datele exista deja: `startSession` le scrie pe fiecare sesiune (src/session.js).
//      Nu se stocheaza nimic nou pentru tabelul asta.
//
//   2. AUTENTIFICARI — istoricul intrarilor, REUSITE si ESUATE, cu IP si ora.
//      Vine din jurnalul de audit (`login` / `login.failed`). Esecurile sunt semnalul de
//      securitate propriu-zis: o serie de „parola gresita" de pe un IP strain se vede aici
//      inainte sa devina o problema.
//
//   3. VIZITATORI — toate IP-urile care ating site-ul, inclusiv cele care NU se autentifica
//      niciodata (pagina de prezentare, ecranul de login, roboti, scanere). Vin din src/visitors.js,
//      agregate PE IP: un rand per adresa, nu per cerere. Primele doua tabele raspund la „cine a
//      intrat in cont"; asta raspunde la „cine a batut la usa".
//
//  Localizarea IP-ului se adauga DEASUPRA, din src/geoip.js, si e optionala prin constructie:
//  daca serviciul extern tace, randurile se afiseaza fara ea. Un panou de administrare care nu
//  se mai deschide fiindca un tert e cazut ar fi un schimb prost.
//
//  Functiile de asamblare sunt PURE (primesc `users`/`audit`, nu ating baza), ca sa poata fi
//  verificate fara server si fara retea. Doar `raport()` e async, fiindca doar el cere geo.
// ─────────────────────────────────────────────────────────────────────────────

const geoip = require('./geoip');
const visitors = require('./visitors');
const { capList } = require('./paginate');

// Cate randuri se intorc, cel mult. Plafon dublu (aici SI in capList) fiindca lista de audit
// creste pana la CONTAB_AUDIT_MAX (20.000): un panou nu are ce face cu ele si nici browserul.
const MAX_AUTENTIFICARI = Number(process.env.CONTAB_ACCESS_MAX) || 300;
const MAX_SESIUNI = 500;
const MAX_VIZITATORI = 500;   // agregat pe IP, deci 500 de adrese distincte, nu 500 de cereri
// „Activ acum" = aceeasi fereastra ca la prezenta adminilor; lastSeen se improspateaza la ~5 min,
// deci o fereastra mai stramta ar arata oameni activi drept plecati.
const FEREASTRA_ONLINE_MS = 7 * 60 * 1000;

/** Numele scurt al dispozitivului, din User-Agent. Pur, orientativ — nu se ia nicio decizie pe el. */
function dispozitiv(ua) {
  const s = String(ua || '');
  if (!s) return '';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
      : /Chrome\//.test(s) ? 'Chrome'
        : /Firefox\//.test(s) ? 'Firefox'
          : /Safari\//.test(s) ? 'Safari' : '';
  const sistem = /Windows/.test(s) ? 'Windows'
    : /iPhone|iPad|iOS/.test(s) ? 'iOS'
      : /Android/.test(s) ? 'Android'
        : /Mac OS X|Macintosh/.test(s) ? 'macOS'
          : /Linux/.test(s) ? 'Linux' : '';
  return [browser, sistem].filter(Boolean).join(' / ');
}

/**
 * Sesiunile active ale TUTUROR utilizatorilor, cea mai recenta activitate prima.
 * PURA. `now` se da explicit ca testul sa nu depinda de ceasul masinii.
 */
function sesiuniActive(users, now) {
  const t = now || Date.now();
  const out = [];
  for (const u of users || []) {
    for (const s of u.sessions || []) {
      const vazut = Date.parse(s.lastSeen || s.createdAt || 0) || 0;
      out.push({
        userId: u.id,
        username: u.username,
        rol: u.role || 'user',
        ip: geoip.normalizeIp(s.ip),
        dispozitiv: dispozitiv(s.ua),
        creata: s.createdAt || null,
        ultimaActivitate: s.lastSeen || s.createdAt || null,
        online: t - vazut < FEREASTRA_ONLINE_MS,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.ultimaActivitate || 0) - Date.parse(a.ultimaActivitate || 0));
}

/**
 * Autentificarile din jurnalul de audit, cea mai recenta prima.
 * `doarEsuate` filtreaza la incercarile respinse. PURA.
 */
function autentificari(audit, opts) {
  const o = opts || {};
  const vrute = o.doarEsuate ? ['login.failed'] : ['login', 'login.failed'];
  const out = [];
  // De la coada spre cap: jurnalul e cronologic, iar noi vrem ultimele N fara sa parcurgem tot.
  for (let i = (audit || []).length - 1; i >= 0 && out.length < MAX_AUTENTIFICARI; i -= 1) {
    const a = audit[i];
    if (!a || !vrute.includes(a.action)) continue;
    out.push({
      ts: a.ts,
      username: a.username || '',
      userId: a.userId != null ? a.userId : null,
      ip: geoip.normalizeIp(a.ip),
      reusita: a.action === 'login',
      detaliu: a.detail || '',
    });
  }
  return out;
}

/** Toate IP-urile distincte din tabelele date (pentru o singura runda de localizare). */
function ipuriDistincte(...tabele) {
  return [...new Set(tabele.flat().map((x) => x.ip).filter(Boolean))];
}

/**
 * Raportul complet, cu localizare. Singura functie async din modul.
 * `geo` se injecteaza in teste (implicit: modulul real).
 */
async function raport(d, opts) {
  const o = opts || {};
  const g = o.geo || geoip;
  const vis = o.visitors || visitors;
  const sesiuni = sesiuniActive(d.users, o.now);
  const logari = autentificari(d.audit, o);
  // Vizitatorii vin din MEMORIE, nu din `d.visitors`: agregatul viu e mereu mai proaspat decat
  // ultima coborare in baza (jobul ruleaza la un minut). Colectia persistata e doar plasa peste
  // restart, iar `hydrate` a incarcat-o deja in acelasi Map.
  const vizitatori = vis.snapshot();

  let locatii = new Map();
  let geoDisponibil = true;
  try { locatii = await g.lookupMany(ipuriDistincte(sesiuni, logari, vizitatori)); }
  catch (_) { geoDisponibil = false; }   // niciodata fatal: raportul se intoarce fara localizare

  const cuLoc = (r) => Object.assign({}, r, { locatie: g.eticheta(locatii.get(r.ip)) });
  // capList, nu felierea proprie: colectiile vii care ajung intr-un CAMP al raspunsului trebuie
  // plafonate si trunchierea trebuie sa se vada (vezi src/paginate.js si poarta din test/run.js).
  const s = capList(sesiuni.map(cuLoc), MAX_SESIUNI, 'access:sesiuni');
  const l = capList(logari.map(cuLoc), MAX_AUTENTIFICARI, 'access:autentificari');
  const v = capList(vizitatori.map(cuLoc), MAX_VIZITATORI, 'access:vizitatori');
  return {
    sesiuni: s.items,
    sesiuniTotal: s.total,
    autentificari: l.items,
    autentificariTotal: l.total,
    vizitatori: v.items,
    vizitatoriTotal: v.total,
    geoDisponibil,
    maxAutentificari: MAX_AUTENTIFICARI,
  };
}

module.exports = {
  raport, sesiuniActive, autentificari, dispozitiv, ipuriDistincte,
  MAX_AUTENTIFICARI, MAX_VIZITATORI, FEREASTRA_ONLINE_MS,
};
