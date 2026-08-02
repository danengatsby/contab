'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  CINE ATINGE SITE-UL — inclusiv vizitatorii NEAUTENTIFICATI
//
//  Panoul de administrare arata pana acum doar sesiuni si autentificari, adica oameni care AU
//  intrat in cont. Aici se acopera restul: pagina de prezentare, ecranul de login, roboti,
//  scanere — tot ce cere ceva de la contabo.space.
//
//  AGREGAT PE IP, nu jurnal de cereri. O singura incarcare a aplicatiei inseamna ~30 de cereri
//  (modulele ES, CSS, icoane), deci un rand pe cerere ar produce mii de linii pe zi de la un
//  singur vizitator: baza creste repede, iar semnalul se pierde in zgomot. Un rand pe IP, cu
//  „prima data / ultima data / cate cereri / cate pagini", raspunde exact la intrebarea pusa
//  („ce IP-uri acceseaza") si costa cu trei ordine de marime mai putin.
//
//  NICIO SCRIERE IN CALEA CERERII. `noteRequest` atinge doar un Map in memorie (O(1)); persistenta
//  se face de un job periodic, si doar daca s-a schimbat ceva. Un `db.save()` per cerere ar fi
//  costat O(colectie) de fiecare data — vezi masuratoarea din docs/scalare-crestere.md.
//
//  Ce NU se numara, deliberat:
//   - bucla locala (127.0.0.1): nginx si sondele interne, nu vizitatori;
//   - `/api/health`: sonda de monitorizare la 5 minute ar fi, altfel, „vizitatorul" numarul unu;
//   - service worker-ul si fisierele de infrastructura (robots.txt, favicon, manifest).
// ─────────────────────────────────────────────────────────────────────────────

const geoip = require('./geoip');

const MAX_IPS = Number(process.env.CONTAB_VISITORS_MAX) || 2000;
const RETENTIE_ZILE = Number(process.env.CONTAB_VISITORS_DAYS) || 30;

// Extensiile servite ca resurse ale paginii. O cerere pentru ele NU e o vizita noua, dar se
// numara la „cereri" — raportul arata ambele, ca sa se vada diferenta dintre un om (cateva
// pagini, zeci de cereri) si un scaner (zeci de cai diferite, nicio pagina).
const RE_RESURSA = /\.(js|mjs|css|png|jpe?g|svg|webp|gif|ico|woff2?|ttf|map|webmanifest|txt|ps1|bat)$/i;
const RE_IGNORAT = /^\/(api\/health|sw\.js|robots\.txt|favicon\.ico|manifest\.webmanifest)$/;
// Roboti si scanere care se DECLARA ca atare. Euristica e orientativa si serveste doar la
// marcarea randului in interfata — nimic nu se filtreaza pe baza ei, ca sa nu ascundem tocmai
// traficul suspect care minte despre cine e.
const RE_BOT = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|curl|wget|python-requests|go-http-client|scrapy|nmap|masscan|zgrab/i;

const vizitatori = new Map();   // ip -> inregistrare
let murdar = false;             // s-a schimbat ceva de la ultima persistare?

/** Cererea se ia in seama? Pura, ca sa poata fi verificata fara server. */
function seNumara(ip, cale) {
  if (!ip || geoip.isPrivate(ip)) return false;   // bucla locala + retele interne
  if (RE_IGNORAT.test(String(cale || ''))) return false;
  return true;
}

/** E o VIZITA de pagina (navigare), nu o resursa a ei? Pura. */
function estePagina(cale, accept, metoda) {
  if (metoda && metoda !== 'GET') return false;
  const c = String(cale || '');
  if (RE_RESURSA.test(c)) return false;
  if (c.startsWith('/api/') || c.startsWith('/pdf/') || c.startsWith('/xml/')
    || c.startsWith('/csv/') || c.startsWith('/efactura')) return false;
  return /text\/html/i.test(String(accept || ''));
}

/** Numele scurt al vizitatorului declarat in User-Agent (doar pentru afisare). Pura. */
function esteBot(ua) { return RE_BOT.test(String(ua || '')); }

/**
 * Inregistreaza o cerere. O(1), fara I/O — se cheama din middleware, pe fiecare cerere.
 * `req` poate fi orice obiect cu { ip, path, method, headers, user } (deci testabil fara server).
 */
function noteRequest(req) {
  const ip = geoip.normalizeIp(req && req.ip);
  const cale = (req && (req.path || req.url)) || '';
  if (!seNumara(ip, cale)) return null;
  const h = (req && req.headers) || {};
  const ua = String(h['user-agent'] || '').slice(0, 200);
  const acum = new Date().toISOString();

  let v = vizitatori.get(ip);
  if (!v) {
    // plafon: la depasire se scoate cel mai VECHI vizitator (dupa ultima activitate)
    if (vizitatori.size >= MAX_IPS) {
      let celMaiVechi = null;
      for (const [k, x] of vizitatori) if (!celMaiVechi || x.ultima < celMaiVechi[1].ultima) celMaiVechi = [k, x];
      if (celMaiVechi) vizitatori.delete(celMaiVechi[0]);
    }
    v = { ip, prima: acum, ultima: acum, cereri: 0, pagini: 0, ultimaCale: '', ua, bot: esteBot(ua), useri: [] };
    vizitatori.set(ip, v);
  }
  v.ultima = acum;
  v.cereri += 1;
  if (ua && ua !== v.ua) { v.ua = ua; v.bot = esteBot(ua); }  // ultimul UA vazut de pe acest IP
  if (estePagina(cale, h.accept, req.method)) { v.pagini += 1; v.ultimaCale = cale; }
  else if (!v.ultimaCale) v.ultimaCale = cale;
  // Legatura IP -> cont, cand exista: raspunde la „IP-ul asta a si intrat in aplicatie, ca cine?"
  const nume = req && req.user && req.user.username;
  if (nume && !v.useri.includes(nume)) { v.useri = [...v.useri, nume].slice(-5); }
  murdar = true;
  return v;
}

/** Sterge inregistrarile mai vechi de `RETENTIE_ZILE`. Intoarce cate au fost scoase. */
function curata(now) {
  const limita = new Date((now || Date.now()) - RETENTIE_ZILE * 86400000).toISOString();
  let n = 0;
  for (const [k, v] of vizitatori) if (v.ultima < limita) { vizitatori.delete(k); n += 1; }
  if (n) murdar = true;
  return n;
}

/** Lista, cea mai recenta activitate prima. Copii, nu referinte: raportul nu muteaza starea. */
function snapshot() {
  return [...vizitatori.values()]
    .map((v) => Object.assign({}, v, { useri: [...v.useri] }))
    .sort((a, b) => (a.ultima < b.ultima ? 1 : a.ultima > b.ultima ? -1 : 0));
}

/** Incarca starea persistata (la pornire). Inregistrarile din memorie au prioritate. */
function hydrate(lista) {
  for (const v of lista || []) {
    if (!v || !v.ip || vizitatori.has(v.ip)) continue;
    vizitatori.set(v.ip, {
      ip: v.ip, prima: v.prima || v.ultima, ultima: v.ultima, cereri: v.cereri || 0,
      pagini: v.pagini || 0, ultimaCale: v.ultimaCale || '', ua: v.ua || '',
      bot: !!v.bot, useri: Array.isArray(v.useri) ? v.useri : [],
    });
  }
}

/** Starea de persistat, cu `id` = IP (colectia are hasId). Null daca nu s-a schimbat nimic. */
function toPersist() {
  if (!murdar) return null;
  murdar = false;
  return snapshot().map((v) => Object.assign({ id: v.ip }, v));
}

/** Doar pentru teste. */
function _reset() { vizitatori.clear(); murdar = false; }

module.exports = {
  noteRequest, snapshot, hydrate, toPersist, curata, _reset,
  seNumara, estePagina, esteBot, MAX_IPS, RETENTIE_ZILE,
};
