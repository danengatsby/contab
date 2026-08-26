'use strict';
// Nucleu partajat al interfetei: helperi fara stare + starea globala (META/USER).
// Importat de app.js si, pe masura extragerii pe functionalitati, de restul modulelor.
// Live-binding ES: importatorii vad MEREU valoarea curenta a lui META/USER; reasignarea se
// face DOAR prin setMeta/setUser (un import nu poate fi reasignat din alt modul).

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const uiLanguage = () => (typeof window !== 'undefined' && window.contabI18n ? window.contabI18n.language() : 'ro');
export const uiLocale = () => (typeof window !== 'undefined' && window.contabI18n ? window.contabI18n.locale() : 'ro-RO');
export const tr = (s) => (typeof window !== 'undefined' && window.contabI18n ? window.contabI18n.t(s) : String(s == null ? '' : s));
export const fmt = (n) => (Number(n) || 0).toLocaleString(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Rotunjire la 2 zecimale (bani), aceeasi semantica cu src/util.js. Folosita in stocuri
// (total valoare stoc) si la auto-completarea salariilor — lipsea din frontend (ReferenceError).
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Data in conventia romaneasca. Aceeasi semantica cu `fmtDate` din src/util.js (folosit la PDF-uri):
// serverul o avea, frontendul nu — de aceea pe ecran conviețuiau ISO si formatul locale-ului
// browserului. Un `07/10/2026` inseamna 7 octombrie in RO si 10 iulie in US; pentru un termen de
// depunere ambiguitatea nu e cosmetica.
export const dataRo = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (uiLanguage() === 'en' ? `${m[3]}/${m[2]}/${m[1]}` : `${m[3]}.${m[2]}.${m[1]}`) : String(iso || '');
};

// Pluralul romanesc, ca sa nu mai scriem „pas(i)". Regula are DOUA praguri, nu unul: de la 20 in
// sus se intercaleaza „de" (20 de pasi), dar nu si cand ultimele doua cifre cad in 1..19
// (101 pasi, 120 de pasi). Zero ramane fara „de" — „0 de pasi" nu se spune.
export const plural = (n, sg, pl) => {
  const x = Math.abs(Math.trunc(Number(n) || 0));
  if (uiLanguage() === 'en') return n + ' ' + tr(x === 1 ? sg : pl);
  if (x === 1) return n + ' ' + sg;
  const ultimele2 = x % 100;
  const cuDe = x >= 20 && (ultimele2 === 0 || ultimele2 >= 20);
  return n + (cuDe ? ' de ' : ' ') + pl;
};

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
export const fiscalPct = (key, fallback) => {
  const value = String(fiscalRate(key, fallback));
  return (uiLanguage() === 'en' ? value : value.replace('.', ',')) + '%';
};
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

let toastTimer = 0;
export function toast(msg, err) {
  // fara element, un toast nu are voie sa omoare apelantul
  const t = $('#toast'); if (!t) return;
  if (toastTimer) clearTimeout(toastTimer);
  const isError = !!err;
  t.textContent = tr(msg);
  t.className = 'toast show ' + (isError ? 'is-error' : 'is-success');
  // Erorile sunt urgente și trebuie anunțate imediat; confirmările obișnuite nu
  // întrerup cititorul de ecran. Atributele revin la starea neutră după mesaj.
  t.setAttribute('role', isError ? 'alert' : 'status');
  t.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  // La ascundere se goleste si TEXTUL, nu doar clasa: elementul se stinge cu `opacity`, deci
  // ramane in arborele de accesibilitate: un mesaj nesters ar fi ramas de citit la nesfarsit,
  // cu mult dupa ce a disparut de pe ecran.
  toastTimer = setTimeout(() => {
    t.className = 'toast'; t.textContent = '';
    t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite');
    toastTimer = 0;
  }, isError ? 5200 : 3600);
}

// Dialoguri proprii pentru acțiuni importante. Spre deosebire de alert/confirm/prompt,
// păstrează contextul acțiunii, validează intrarea și folosesc aceleași controale pe toate
// platformele. Conținutul variabil intră exclusiv prin textContent.
function appDialog(kind, message, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'app-dialog' + (o.danger ? ' is-danger' : '');
    dlg.setAttribute('aria-labelledby', 'appDialogTitle');

    const card = document.createElement('div'); card.className = 'app-dialog-card';
    const head = document.createElement('div'); head.className = 'app-dialog-head';
    const mark = document.createElement('span'); mark.className = 'app-dialog-mark'; mark.setAttribute('aria-hidden', 'true');
    mark.textContent = o.danger ? '!' : (kind === 'prompt' ? '…' : '✓');
    const title = document.createElement('h2'); title.id = 'appDialogTitle';
    title.textContent = tr(o.title || (kind === 'alert' ? 'Informație' : kind === 'prompt' ? 'Completează detaliile' : 'Confirmă acțiunea'));
    head.append(mark, title); card.appendChild(head);

    const body = document.createElement('div'); body.className = 'app-dialog-body';
    const text = document.createElement('p'); text.className = 'app-dialog-message'; text.textContent = tr(message || '');
    body.appendChild(text);
    let input = null;
    if (kind === 'prompt') {
      const label = document.createElement('label'); label.className = 'app-dialog-label';
      const labelText = document.createElement('span'); labelText.textContent = tr(o.label || 'Valoare');
      input = document.createElement(o.multiline ? 'textarea' : 'input');
      if (!o.multiline) input.type = o.inputType || 'text';
      input.value = o.value == null ? '' : String(o.value);
      if (o.placeholder) input.placeholder = o.placeholder;
      if (o.minLength) input.minLength = Number(o.minLength);
      if (o.required) input.required = true;
      label.append(labelText, input); body.appendChild(label);
    }
    if (o.detail) {
      const detail = document.createElement('p'); detail.className = 'app-dialog-detail'; detail.textContent = o.detail;
      body.appendChild(detail);
    }
    const error = document.createElement('p'); error.className = 'app-dialog-error hidden'; error.setAttribute('role', 'alert');
    body.appendChild(error); card.appendChild(body);

    const actions = document.createElement('div'); actions.className = 'app-dialog-actions';
    let cancel = null;
    if (kind !== 'alert') {
      cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn ghost';
      cancel.textContent = tr(o.cancelLabel || 'Renunță'); actions.appendChild(cancel);
    }
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn primary' + (o.danger ? ' danger' : '');
    ok.textContent = tr(o.confirmLabel || (kind === 'alert' ? 'Am înțeles' : 'Continuă')); actions.appendChild(ok);
    card.appendChild(actions); dlg.appendChild(card); document.body.appendChild(dlg);

    let inchis = false;
    const termina = (valoare) => {
      if (inchis) return; inchis = true;
      try { if (dlg.open && typeof dlg.close === 'function') dlg.close(); } catch (_) { /* fallback-ul nu are close */ }
      dlg.remove(); resolve(valoare);
    };
    if (cancel) cancel.addEventListener('click', () => termina(kind === 'prompt' ? null : false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); termina(kind === 'prompt' ? null : false); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg && kind !== 'alert') termina(kind === 'prompt' ? null : false); });
    ok.addEventListener('click', () => {
      if (input) {
        const value = input.value.trim();
        if (o.required && !value) { error.textContent = 'Completează câmpul pentru a continua.'; error.classList.remove('hidden'); input.focus(); return; }
        if (o.minLength && value.length < Number(o.minLength)) { error.textContent = 'Scrie cel puțin ' + Number(o.minLength) + ' caractere.'; error.classList.remove('hidden'); input.focus(); return; }
        if (o.pattern && !o.pattern.test(value)) { error.textContent = o.patternMessage || 'Valoarea nu are formatul corect.'; error.classList.remove('hidden'); input.focus(); return; }
        termina(value); return;
      }
      termina(kind === 'alert' ? undefined : true);
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input && !o.multiline) { e.preventDefault(); ok.click(); }
    });
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    setTimeout(() => { (input || (kind === 'alert' ? ok : cancel || ok)).focus(); }, 0);
  });
}

export const alertAction = (message, opts) => appDialog('alert', message, opts);
export const confirmAction = (message, opts) => appDialog('confirm', message, opts);
export const promptAction = (message, opts) => appDialog('prompt', message, opts);

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
// continua, blocarea perioadei, stocul CMP/FIFO sunt invariante validate DOAR pe server; iar un
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

// ─────────────────────────────────────────────────────────────────────────────
//  COMPLETAREA UNUI FORMULAR DUPA CUI (registrul public ANAF)
//
//  Acelasi CUI se tasta de mana in trei formulare — inscrierea firmei, „Firma mea"
//  si adaugarea unui partener — impreuna cu denumirea, adresa, orasul, judetul,
//  Reg. Com. si CAEN-ul, desi serverul stia deja sa le citeasca din registrul
//  public (src/anafRegistru.js). Le cerea doar pentru VERIFICAREA partenerilor
//  deja salvati, nu si acolo unde omul scrie.
//
//  Regula, si singurul lucru care conteaza cu adevarat aici: completarea NU
//  suprascrie niciodata ce a scris omul. Un formular care iti sterge sub degete
//  ce ai tastat e mai rau decat unul care nu te ajuta deloc — mai ales cand
//  registrul are date vechi (adrese de sediu neactualizate ani la rand) sau cand
//  utilizatorul stie mai bine (denumirea comerciala fata de cea din registru).
//  Deci: se umplu doar campurile GOALE, iar diferentele fata de ce e deja scris
//  se RAPORTEAZA, ca omul sa decida.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ce se completeaza dintr-un raspuns de registru, peste ce e deja in formular.
 * Functie PURA (testata in test/frontend.mjs) — nu atinge pagina.
 *
 * @param {Object} reg   raspunsul rutei /api/registru-anaf
 * @param {Object} harta camp de formular -> cheie din raspuns  ({ nume: 'denumire', … })
 * @param {Object} acum  valorile curente din formular ({ nume: 'ce a tastat omul', … })
 * @returns {{patch: Object, completate: string[], diferite: string[], avertismente: string[]}}
 *   `patch` = doar campurile de scris; `diferite` = campuri deja completate ALTFEL decat in
 *   registru (nu se ating, dar se spun); `avertismente` = stari care schimba o decizie contabila.
 */
export function campuriDeCompletat(reg, harta, acum) {
  const out = { patch: {}, completate: [], diferite: [], avertismente: [] };
  if (!reg || !reg.gasit) return out;
  const gol = (v) => String(v == null ? '' : v).trim() === '';
  const normal = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toUpperCase();
  for (const [camp, cheie] of Object.entries(harta || {})) {
    const val = reg[cheie];
    // `false` e o valoare buna (tvaPlatitor), `''`/null/undefined nu sunt: registrul omite
    // sectiuni intregi pentru unele forme de organizare, iar un camp gol n-are ce completa.
    if (val == null || val === '') continue;
    const curent = (acum || {})[camp];
    if (gol(curent)) { out.patch[camp] = val; out.completate.push(camp); continue; }
    if (typeof val !== 'boolean' && normal(curent) !== normal(val)) out.diferite.push(camp);
  }
  // Semnalele care schimba o decizie contabila, nu doar completeaza un camp. Nu blocheaza nimic:
  // se poate lucra si cu un partener inactiv, doar ca trebuie stiut INAINTE, nu la control.
  if (reg.inactiv) out.avertismente.push('Firma e declarată INACTIVĂ la ANAF: cheltuielile cu ea nu sunt deductibile, iar TVA-ul de pe facturile ei nu se deduce (art. 11 Cod fiscal).');
  if (reg.radiat) out.avertismente.push('Firma e RADIATĂ în registrul ANAF.');
  if (reg.tvaLaIncasare) out.avertismente.push('Firma aplică TVA la încasare: dreptul de deducere se amână până la plata facturii (art. 297 alin. (2)).');
  return out;
}

/**
 * Cauta un CUI in registrul public si intoarce raspunsul, sau `null` daca nu se poate.
 * NU arunca: completarea automata e un ajutor, iar caderea ei n-are voie sa opreasca un
 * formular care merge perfect scris de mana. Motivul ajunge in `null` + un mesaj optional.
 */
export async function cautaCui(cui) {
  try {
    return await api('/api/registru-anaf?cui=' + encodeURIComponent(String(cui || '').trim()));
  } catch (e) {
    return { gasit: false, eroare: e.message };
  }
}

/**
 * Eticheta LIZIBILA a unui camp, din textul `<label>`-ului care il contine. Functie PURA (testata
 * in test/frontend.mjs) peste textul deja extras.
 *
 * De ce exista: mesajul de dupa completare insira campurile atinse, iar prima versiune tiparea
 * NUMELE lor tehnice — „completat din registrul ANAF: den, adresa, oras, judet". `den` nu inseamna
 * nimic pentru cine completeaza formularul; eticheta de deasupra campului spune „Denumire".
 * Eticheta nu se ia dintr-o a treia lista scrisa de mana (ar drifta fata de formular la prima
 * redenumire), ci chiar din `<label>`-ul pe care omul il citeste — deci nu poate sa nu se
 * potriveasca.
 *
 * Se curata ce e ajutor de completare, nu nume: lamuririle din paranteze („Județ (cod, ex: RO-CJ)"
 * -> „Județ") si marcajul de camp obligatoriu.
 */
export function curataEticheta(text, cadere) {
  const t = String(text == null ? '' : text)
    .replace(/\([^)]*\)/g, ' ')   // „(cod, ex: RO-CJ)", „(stradă)"
    .replace(/[*:]/g, ' ')        // marcajul de obligatoriu si doua puncte
    .replace(/\s+/g, ' ')
    .trim();
  return t || String(cadere == null ? '' : cadere);
}

/**
 * Leaga completarea automata pe campul CUI al unui formular. Partea de DOM a mecanismului de mai
 * sus: decizia CE se completeaza ramane in `campuriDeCompletat` (pura, testata), aici doar se
 * cheama serverul si se scriu rezultatele in pagina.
 *
 * Se declanseaza la IESIREA din camp (`change`), nu la fiecare tasta: un CUI are 8-10 caractere,
 * iar o cautare pe fiecare dintre ele ar insemna 10 cereri catre un serviciu ANAF plafonat la una
 * pe secunda. Aceeasi valoare nu se cauta de doua ori la rand.
 *
 * @param {HTMLFormElement} form
 * @param {Object} harta  camp de formular -> cheie din raspuns
 * @param {Object} [opts] { dupa: fn(reg, rezultat) } — apelat dupa completare
 */
export function legaCompletareCui(form, harta, opts) {
  if (!form || form._cuiLegat) return;
  const camp = form.querySelector('[name="cui"]');
  if (!camp) return;
  form._cuiLegat = true;
  const stare = document.createElement('div');
  stare.className = 'muted cui-stare';
  (camp.closest('label') || camp).insertAdjacentElement('afterend', stare);
  let ultimul = null;
  camp.addEventListener('change', async () => {
    const v = String(camp.value || '').trim();
    if (!v || v === ultimul) return;
    ultimul = v;
    stare.textContent = 'Caut la ANAF…';
    const reg = await cautaCui(v);
    if (!reg || !reg.gasit) {
      // Trei stari DIFERITE, spuse diferit: serviciul n-a raspuns, CUI-ul nu e in registru, sau
      // n-a fost cerut nimic. „Nu s-a gasit" pus peste o eroare de retea ar fi o afirmatie falsa
      // despre firma cuiva — la fel ca „neverificat" raportat drept „e bine" in restul aplicatiei.
      stare.textContent = reg && reg.eroare
        ? reg.eroare
        : 'CUI-ul nu apare în registrul ANAF — completează câmpurile manual.';
      return;
    }
    const acum = {};
    for (const c of Object.keys(harta)) { const el = form.querySelector('[name="' + c + '"]'); if (el) acum[c] = el.value; }
    const r = campuriDeCompletat(reg, harta, acum);
    for (const [c, val] of Object.entries(r.patch)) {
      const el = form.querySelector('[name="' + c + '"]');
      if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    // Numele campurilor devin ETICHETE, citite din `<label>`-ul pe care omul il are in fata:
    // `campuriDeCompletat` lucreaza cu numele lor tehnice (asa se scrie in formular), dar mesajul
    // se citeste, nu se programeaza. Caderea pe nume ramane, pentru un camp fara `<label>`.
    const etich = (c) => {
      const el = form.querySelector('[name="' + c + '"]');
      const lab = el && el.closest && el.closest('label');
      return curataEticheta(lab && lab.textContent, c);
    };
    const listeaza = (campuri) => campuri.map(etich).join(', ');
    const bucati = [];
    if (r.completate.length) bucati.push('<b>' + H(reg.denumire || v) + '</b> — completat din registrul ANAF: ' + H(listeaza(r.completate)) + '.');
    else bucati.push('<b>' + H(reg.denumire || v) + '</b> — găsit la ANAF; câmpurile erau deja completate.');
    // Diferentele nu se corecteaza tacit: se SPUN. Registrul poate avea sediul vechi, iar omul
    // poate sti mai bine — dar trebuie sa afle ca cele doua nu se potrivesc.
    if (r.diferite.length) bucati.push('Diferă față de registru (nu am schimbat): ' + H(listeaza(r.diferite)) + '.');
    if (reg.tvaPlatitor === false) bucati.push('La ANAF <b>nu</b> figurează ca plătitoare de TVA.');
    for (const a of r.avertismente) bucati.push('⚠️ ' + H(a));
    stare.innerHTML = bucati.join(' ');
    if (opts && opts.dupa) opts.dupa(reg, r);
  });
}
