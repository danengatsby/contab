'use strict';
// Nucleu partajat al interfetei: helperi fara stare + starea globala (META/USER).
// Importat de app.js si, pe masura extragerii pe functionalitati, de restul modulelor.
// Live-binding ES: importatorii vad MEREU valoarea curenta a lui META/USER; reasignarea se
// face DOAR prin setMeta/setUser (un import nu poate fi reasignat din alt modul).

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const fmt = (n) => (Number(n) || 0).toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Rotunjire la 2 zecimale (bani), aceeasi semantica cu src/util.js. Folosita in stocuri
// (total valoare stoc) si la auto-completarea salariilor — lipsea din frontend (ReferenceError).
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Escapare HTML pentru datele de provenienta externa (parteneri din e-Factura/SPV, extrase
// bancare, denumiri, explicatii) inainte de interpolarea in innerHTML — al doilea strat de
// aparare dupa CSP. `H` = escapare completa (text + atribute), folosita la randare.
export const H = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Varianta usoara (doar & < >) + varianta pentru atribute (adauga escaparea ghilimelelor).
// Partajate: mesageria le foloseste la randarea firului, iar app.js la galeriile de documente.
export const escMsg = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const escAttr = (s) => escMsg(s).replace(/"/g, '&quot;');

// Codul de cont afisat LANGA o eticheta umana („TVA colectata (4427)"): detaliu tehnic, marcat
// `.adv`, deci ascuns in modul simplu si vizibil in cel expert. Modul simplu era pana acum doar
// un filtru de MENIU — ascundea intrari, dar paginile ramase isi pastrau tot vocabularul contabil.
// Nu se foloseste acolo unde codul ESTE informatia (plan de conturi, balanta, fise de cont):
// acele ecrane sunt oricum `.adv` in intregime.
// `H(cod)` chiar daca azi toate apelurile trec literali: planul de conturi se poate IMPORTA, deci
// un cod poate deveni oricand data externa. Poarta de escapare din test/frontend.mjs cere asta,
// si bine face — regula e „escapeaza dupa SURSA, nu dupa cat de sigur pare apelul de azi".
export const ac = (cod) => ` <span class="adv">(${H(cod)})</span>`;

export let META = { types: [], accounts: [], company: {}, periods: [] };
export let USER = {};
export function setMeta(m) { META = m; }
export function setUser(u) { USER = u; }

// ── Cotele fiscale: de la server, niciodata hardcodate in frontend ──
// Parametrii fiscali stau centralizat in src/fiscalConfig.js si ajung aici prin /api/meta.
// Un procent scris de mana in frontend supravietuieste modificarii de cota si incepe sa minta:
// fie pune o valoare gresita intr-un formular (devine DATA), fie eticheteaza gresit un numar
// corect calculat pe server. `fallback` e doar plasa pentru META neincarcat inca.
export const fiscalRate = (key, fallback) => {
  const v = Number((META.fiscal || {})[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
// Procentul ca text, in scriere romaneasca (virgula zecimala): "25%", "2,25%".
export const fiscalPct = (key, fallback) => String(fiscalRate(key, fallback)).replace('.', ',') + '%';
// Substituie `{cheie|implicit}` cu cota curenta in textele explicative (glosar, panouri).
// Tabelele lor sunt constante evaluate la IMPORT, cand META.fiscal inca nu e incarcat, deci
// substituim la randare, nu la definire.
export const fiscalText = (s) => String(s).replace(/\{(\w+)\|([\d.]+)\}/g, (_, k, fb) => fiscalPct(k, Number(fb)));
// Umple campurile marcate `data-rate="<cheie>"` cu cota curenta. Valoarea din HTML ramane
// plasa (se foloseste daca META inca nu e incarcat). Se apeleaza dupa fiecare setMeta.
export function applyFiscalDefaults(root) {
  $$('[data-rate]', root || document).forEach((el) => { el.value = fiscalRate(el.dataset.rate, el.value); });
}

export const accName = (c) => { const a = META.accounts.find((x) => x.cod === String(c)); return a ? a.nume : ''; };
// Contul demo (public, partajat): unele UI-uri se ascund. Partajat de app.js si admin.js.
export const isDemo = () => !!(USER && (USER.username === 'demo' || USER.username === 'demo-contabil'));

export function toast(msg, err) {
  // fara element, un toast nu are voie sa omoare apelantul
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  // La ascundere se goleste si TEXTUL, nu doar clasa: elementul se stinge cu `opacity`, deci
  // ramane in arborele de accesibilitate: un mesaj nesters ar fi ramas de citit la nesfarsit,
  // cu mult dupa ce a disparut de pe ecran.
  setTimeout(() => { t.className = 'toast'; t.textContent = ''; }, 3200);
}

let pendingReq = 0;
export function setLoad(on) {
  pendingReq = Math.max(0, pendingReq + (on ? 1 : -1));
  const b = document.getElementById('loadbar');
  if (b) b.classList.toggle('on', pendingReq > 0);
}

// Hook optional pentru raspunsul 402 (proba firmei expirata): inregistrat de app.js (setOn402),
// ca sa nu legam nucleul de UI-ul de abonare (promptFirmaSubscribe).
let on402TrialExpired = null;
export function setOn402(fn) { on402TrialExpired = fn; }

// ── Degradare gratioasa la pierderea conexiunii (NU offline-first) ──
// Datele contabile NU se cacheaza si NU se scriu offline: numerotarea documentelor in serie
// continua, blocarea perioadei, stocul la CMP sunt invariante validate DOAR pe server; iar un
// cache client pe un dispozitiv partajat (birou contabil) ar scurge date intre conturi. In schimb,
// cand conexiunea pica: bara de status informeaza clar, cererea esuata pe RETEA arunca un mesaj
// util (nu „Failed to fetch"), iar la revenire se reincarca vederea curenta. Nimic tiparit nu se
// pierde — datele din formular raman in DOM pana la salvare reusita.
function setOffline(on) {
  const b = document.getElementById('offlineBanner');
  if (b) b.classList.toggle('hidden', !on);
  document.body.classList.toggle('is-offline', on);
}
let onReconnect = null;
export function setOnReconnect(fn) { onReconnect = fn; } // app.js: reincarca tab-ul curent la revenire
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => { setOffline(false); if (onReconnect) { try { onReconnect(); } catch (_) { /* */ } } });
  if (!navigator.onLine) setOffline(true);
}

// Token-ul CSRF al sesiunii: vine o data, in /api/me, si se ataseaza la fiecare cerere mutanta.
// Un site strain nu-l poate citi (same-origin policy), deci nu poate compune cererea.
let CSRF = '';
export function setCsrf(t) { CSRF = t || ''; }
export function getCsrf() { return CSRF; }
/** Antetele unei cereri, cu X-CSRF-Token adaugat la metodele mutante. Nu suprascrie unul explicit. */
export function withCsrf(opts) {
  const o = opts || {};
  const m = String(o.method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || !CSRF) return o;
  const h = new Headers(o.headers || {});
  if (!h.has('X-CSRF-Token')) h.set('X-CSRF-Token', CSRF);
  return Object.assign({}, o, { headers: h });
}

export async function api(url, opts) {
  // `quiet`: cereri de fundal (previzualizarea din formular, ceruta la fiecare pauza de tastare)
  // — fara bara de incarcare, care altfel ar clipi continuu. fetch ignora cheile necunoscute.
  const quiet = !!(opts && opts.quiet);
  if (!quiet) setLoad(true);
  try {
    let r;
    try {
      r = await fetch(url, withCsrf(opts));
    } catch (netErr) {
      // Esec de RETEA (offline / server inaccesibil), NU un raspuns HTTP de eroare.
      setOffline(true);
      const err = new Error('Ești offline sau conexiunea e instabilă. Nimic nu s-a pierdut — reîncearcă după ce revii online.');
      err.offline = true; throw err;
    }
    setOffline(false); // un raspuns (chiar si 4xx/5xx) inseamna ca reteaua merge
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      // Firma de proba expirata: propune abonarea in loc de o simpla eroare
      if (r.status === 402 && data && data.firmaTrialExpired && on402TrialExpired) on402TrialExpired(data);
      const err = new Error((data && data.error) || ('Eroare ' + r.status)); err.status = r.status; err.data = data; throw err;
    }
    return data;
  } finally { if (!quiet) setLoad(false); }
}

// Citeste un fisier de import: .xlsx/.xls/.dbf -> convertit la CSV pe server; .csv -> citit direct.
// Partajat de importurile de parteneri, produse, stoc initial si plan de conturi.
export async function fileToCsv(file) {
  if (/\.(xlsx|xls|dbf)$/i.test(file.name)) {
    const fd = new FormData(); fd.append('file', file);
    const r = await api('/api/xlsx-to-csv', { method: 'POST', body: fd });
    return r.csv || '';
  }
  return await file.text();
}

// ── Stiluri dinamice sub CSP fara unsafe-inline ──
// Atributele style= din markup sunt blocate de CSP (style-src 'self'); valorile calculate in
// template-uri se scriu ca data-style="prop:val;..." iar aici se transfera pe el.style.cssText —
// manipulare CSSOM, pe care CSP NU o blocheaza. Observerul acopera orice innerHTML ulterior,
// fara hook per ecran; la incarcare se aplica si celor deja prezente in DOM.
function applyDataStyle(el) { if (el.dataset && el.dataset.style != null) el.style.cssText = el.dataset.style; }
new MutationObserver((muts) => {
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      applyDataStyle(n);
      if (n.querySelectorAll) n.querySelectorAll('[data-style]').forEach(applyDataStyle);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
document.querySelectorAll('[data-style]').forEach(applyDataStyle);

// ── PWA: inregistrarea service worker-ului (instalare pe homescreen + rezilidenta offline) ──
// Doar in context sigur (https sau localhost); pe http simplu register() e refuzat de browser,
// deci il sarim tacut. SW-ul e conservator (public/sw.js): nu cacheaza niciodata date de utilizator.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* instalarea PWA e optionala */ });
  });
}

// ── RAPORTAREA ERORILOR DIN CLIENT ──
// Observabilitatea pe server e buna (reqId, durate, fereastra 5xx). In client era NULA: o exceptie
// netratata lasa utilizatorul cu ecranul blocat, iar noi nu aflam niciodata — el pleaca si atat.
// Aici pleaca semnalul minim catre /api/client-error (ruta publica: o eroare pe ecranul de LOGIN e
// exact cea care nu se afla altfel).
//
// Trei reguli, ca raportorul sa nu devina el problema:
//   1. NU trece prin api(): acela afiseaza toast-uri, trateaza 401/402 si poate fi chiar el rupt.
//      Se foloseste fetch brut, cu keepalive (raportarea supravietuieste navigarii care urmeaza).
//   2. NU raporteaza propriile esecuri — orice eroare din trimitere se inghite. Altfel o retea
//      cazuta ar produce o bucla: eroare -> raportare esuata -> eroare -> ...
//   3. Se opreste dupa un numar mic de raportari pe incarcare de pagina. O bucla de randare poate
//      arunca mii de exceptii pe secunda; fara plafon i-am trimite pe toate.
const ERORI_MAX = 5;              // per incarcare de pagina
let eroriTrimise = 0;
const eroriVazute = new Set();    // aceeasi eroare nu se trimite de doua ori din aceeasi pagina

/** Construieste corpul raportarii. Exportata pentru test/frontend.mjs (logica pura). */
export function pachetEroare(sursaEvent) {
  const e = sursaEvent || {};
  const err = e.error || e.reason;  // 'error' -> .error, 'unhandledrejection' -> .reason
  const mesaj = (err && err.message) || e.message
    || (typeof err === 'string' ? err : '') || 'eroare necunoscuta';
  return {
    msg: String(mesaj).slice(0, 200),
    // fisier:linie:coloana — la respingerile de promisiuni lipseste, si e in regula
    sursa: e.filename ? String(e.filename).split('?')[0] + ':' + (e.lineno || 0) + ':' + (e.colno || 0) : '',
    stack: err && err.stack ? String(err.stack).slice(0, 1000) : '',
    // DOAR pathname: `location.href` ar fi trimis si interogarea, iar pagina de resetare are
    // tokenul acolo (`/?reset=<token>`) — l-am fi scris singuri in metrici.
    cale: (location && location.pathname) || '',
    tip: e.type === 'unhandledrejection' ? 'promisiune' : 'eroare',
  };
}

/** Decide daca raportarea pleaca. Pura, ca sa poata fi verificata fara retea. */
export function trebuieRaportata(pachet, trimise, vazute) {
  if (trimise >= ERORI_MAX) return false;
  const amprenta = pachet.msg + '|' + pachet.sursa;
  return !vazute.has(amprenta);
}

function raporteazaEroare(ev) {
  try {
    const pachet = pachetEroare(ev);
    if (!trebuieRaportata(pachet, eroriTrimise, eroriVazute)) return;
    eroriVazute.add(pachet.msg + '|' + pachet.sursa);
    eroriTrimise += 1;
    fetch('/api/client-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pachet), keepalive: true,
    }).catch(() => { /* regula 2: esecul raportarii nu produce alta raportare */ });
  } catch (_) { /* raportarea nu are voie sa arunce niciodata */ }
}

window.addEventListener('error', raporteazaEroare);
window.addEventListener('unhandledrejection', raporteazaEroare);

// ───────── Temeiul legal al pasilor din ciclul contabil ─────────
// Sta in `core.js` fiindca nu apartine unui singur ecran: sloturile `.temei-slot` sunt raspandite
// pe taburile care EXECUTA pasii (documente, emitere, jurnal, casa, mijloace fixe, balanta,
// situatii, SAF-T, livrabile, arhiva) plus cele doua pagini de inchidere.
//
// Textul vine de la SERVER (`/api/temei-legal`, src/temeiLegal.js) — o copie scrisa in HTML ar
// drifta fata de ghid si de documentatie. Se cere O SINGURA DATA pe sesiune si se tine in memorie:
// legea nu depinde de firma si nu se schimba intre doua taburi.
let TEMEI_CACHE = null;
export async function umpleTemeiuri() {
  const sloturi = document.querySelectorAll('.temei-slot:not([data-umplut])');
  if (!sloturi.length) return;
  if (!TEMEI_CACHE) {
    try { TEMEI_CACHE = await api('/api/temei-legal'); } catch (e) { return; } // fara temei, ecranul merge la fel
  }
  const dupaCheie = new Map((TEMEI_CACHE.pasi || []).map((p) => [p.key, p]));
  for (const el of sloturi) {
    // Un slot poate acoperi MAI MULTI pasi (ex. „situatii,depunere"): acelasi ecran executa doua
    // etape ale ciclului, iar doua blocuri pliate unul sub altul ar fi zgomot.
    const pasi = String(el.dataset.pas || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map((k) => dupaCheie.get(k)).filter((p) => p && p.temei && p.temei.length);
    if (!pasi.length) continue;
    const temei = pasi.flatMap((p) => p.temei);
    el.innerHTML = `<details class="temei"><summary class="muted">Temei legal: ${
      temei.map((x) => H(x.eticheta)).join(' · ')}</summary><ul>${
      pasi.map((p) => `<li><b>${H(p.nume)}</b><ul>${
        p.temei.map((x) => `<li><b>${H(x.actTitlu)}</b>${x.articol && x.articol !== '—' ? ', ' + H(x.articol) : ''} — ${H(x.ce)}</li>`).join('')
      }</ul></li>`).join('')}</ul></details>`;
    el.dataset.umplut = '1';
  }
}
