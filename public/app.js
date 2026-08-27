'use strict';
import { $, $$, H, fmt, toast, api, META, USER, setMeta, setUser, setOnReconnect, escMsg, escAttr, isDemo, applyFiscalDefaults, fiscalText, setCsrf, umpleTemeiuri, legaCompletareCui, confirmAction, promptAction, alertAction } from './core.js';
import { loadMessages, startMsgPolling, setMsgBadge, setLastUnread } from './messages.js';
import { setBankRefresh } from './bank.js';
import { render2FA, renderBackup, renderProfile, renderSessions, renderSmtp, renderFiscal, renderPachetWin, renderVideo, setSettingsDeps } from './settings.js';
import { renderFirme, renderUsers, renderColaboratori, renderAudit, renderAccess, renderCereriAcces, setAdminDeps } from './admin.js';
import { loadDashboard, setDashboardDeps } from './dashboard.js';
import { initUiMode } from './simplemode.js';
import { initGhid } from './ghid.js';
import { loadPartners } from './partners.js';
import './viewer.js'; // vizualizatorul de documente (PDF/CSV/XML/e-Factura) — se activeaza prin efect secundar
import './etransport.js'; // formularul ghidat e-Transport (cod UIT) — se activeaza prin efect secundar
import { setWorkMonth, applyWorkMonth, fillPeriods, setPeriodsDeps } from './periods.js';
import { loadJournal, loadLedger, loadCashbook, loadBalance, loadVat, loadClosings, loadStatements, loadStorno, loadSaft, loadBuget, loadRegFiscal } from './rapoarte.js';
import { loadLivrabile, loadPortfolio, loadNotifications, loadReconcile, loadAnalytic, refreshNotifBadge, setLivrabileDeps } from './livrabile.js';
import { setPaletaDeps, deschide as deschidePaleta } from './paleta.js';
import { loadAssets, loadLeasingContracts } from './mijloace.js';
import { loadMonthlyClose, setInchidereDeps } from './inchidere.js';
import { loadSalarizare, setSalarizareDeps } from './salarizare.js';
import { loadStocks } from './stocuri.js';
import { renderPlan, renderOpening } from './plan.js';
import { setAuthuiDeps, bootAuth, showLogin, hideLogin, showForcePw, handleRegisterLink, openRegisterPanel } from './authui.js';
import { setDocflowDeps, fillTipSelect, renderRecurring } from './docflow.js';
import { setEntriesDeps, loadEntries, renderEntryLists, loadMissingDocs, loadArhiva, loadCalitate } from './entries.js';
import { registerFormFlow, formFlowLoaded, formFlowSaved, flushAllFormFlows, setFormFlowCompany, setFormFlowUser } from './formflow.js';
setAuthuiDeps({ init, goTab, promptFirmaSubscribe });
setDocflowDeps({ goTab, refreshCashbook: loadCashbook }); // salvarea din tabul Bani reîmprospătează registrul
setEntriesDeps({ goTab });
setSalarizareDeps({ goTab }); // „editează" din statul de plată duce in pagina „Angajați"

setPeriodsDeps({ renderEntryLists, onTab }); // functiile sunt declarate mai jos (hoisting)

registerFormFlow({
  form: '#companyForm',
  title: 'Configurarea firmei',
  firstStepTitle: 'Configurare de bază — 3 pași simpli',
  entityKey: () => 'firma:' + (META.firmaActiva || 'curenta'),
  progressFields: (form) => ['nume', 'cui', 'tipEntitate', 'adresa', 'oras', 'judet', 'caen',
    ...(form.tvaPlatitor && form.tvaPlatitor.value === 'true' ? ['perioadaTva'] : []),
    ...(form.tipEntitate && form.tipEntitate.value !== 'pfa' ? ['regimImpozit'] : [])]
    .map((name) => form.elements[name]).filter(Boolean),
  onDiscard: () => fillCompanyForm(),
});


// CURRENT + fluxul documentelor -> public/docflow.js

// EFACT/SENDABLE + listele -> public/entries.js
// autentificarea UI -> public/authui.js
let firmaSubPromptOpen = false;
async function promptFirmaSubscribe(firmaId, firmaNume) {
  if (firmaSubPromptOpen || !firmaId) return;
  firmaSubPromptOpen = true;
  const contabil = USER && USER.tip === 'contabil';
  const planNume = contabil ? 'Pro' : 'Start';
  // Cat timp incasarea e oprita (vezi PLATI_SUSPENDATE din src/plans.js), NU se promite o plata
  // care ar fi refuzata cu 503 dupa apasare. Steagul vine din META, nu din raspunsul rutei: aici
  // textul se scrie INAINTE de orice cerere, deci o verificare de dupa ar veni prea tarziu.
  if (META && META.platiSuspendate) {
    firmaSubPromptOpen = false;
    await alertAction('Firma „' + (firmaNume || '') + '" are nevoie de un abonament, dar acesta nu poate fi '
      + 'activat deocamdată.\n\n' + (META.motivPlatiSuspendate || '')
      + '\n\nScrie-ne și îți prelungim accesul până când abonamentele redevin disponibile.', { title: 'Abonamente indisponibile temporar' });
    return;
  }
  const da = await confirmAction('Firma „' + (firmaNume || '') + '" va folosi planul ' + planNume + '. '
    + 'Prețul este 99 lei/lună/firmă (' + planNume + ' pentru ' + (contabil ? 'contabili' : 'necontabili') + '). '
    + 'Se deschide plata online, iar datele firmei rămân intacte.', { title: 'Activezi abonamentul?', confirmLabel: 'Continuă la plată' });
  firmaSubPromptOpen = false;
  if (!da) return;
  try {
    const r = await api('/api/firme/' + firmaId + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    if (r.url) { window.location.href = r.url; return; } // plata Stripe
    await init(); onTab('setari');
    toast('Firma „' + (firmaNume || '') + '" e abonată pe luna curentă — poți continua.');
  } catch (e) { /* eroarea a fost deja aratata */ }
}

// ───────────────────────── AUTENTIFICARE ─────────────────────────
// ── Inscriere firma (pagina publica de pe login) ──


// ───────────────────────── MENIU LATERAL (acordeoane) ────────────────────────
// Clic pe grup deschide submeniul și le închide pe celelalte: un singur acordeon deschis.
function closeMenus(except) {
  $$('#tabs .navgroup.open').forEach((g) => { if (g === except) return; g.classList.remove('open'); const l = g.querySelector('.navlabel'); if (l) l.setAttribute('aria-expanded', 'false'); });
}
function openGroup(g) {
  if (!g) return;
  closeMenus(g);
  g.classList.add('open');
  const l = g.querySelector('.navlabel'); if (l) l.setAttribute('aria-expanded', 'true');
  // Atât bara laterală desktop, cât și sertarul mobil își derulează conținutul. După extindere,
  // aducem capătul submeniului în cadru dacă a coborât sub marginea navigatorului.
  const meniu = g.querySelector('.navmenu');
  if (!meniu) return;
  requestAnimationFrame(() => {
    const bara = g.closest('#tabs'); if (!bara) return;
    if (meniu.getBoundingClientRect().bottom > bara.getBoundingClientRect().bottom) {
      g.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}
$$('#tabs .navgroup').forEach((g) => {
  const label = g.querySelector('.navlabel');
  if (!label) return;
  label.setAttribute('aria-expanded', g.classList.contains('open') ? 'true' : 'false');
  g.querySelector('.navmenu') && g.querySelector('.navmenu').setAttribute('role', 'group');
  label.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (g.classList.contains('open')) { g.classList.remove('open'); label.setAttribute('aria-expanded', 'false'); }
    else openGroup(g);
  });
});
// Navigatorul nu pornește cu un acordeon deschis inutil.
closeMenus();
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#tabs .navgroup')) closeMenus();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const deschis = $('#tabs .navgroup.open');
  if (!deschis) return;
  const label = deschis.querySelector('.navlabel');
  closeMenus();
  if (label) label.focus();
});

// Toate destinațiile, inclusiv Ghid și Mesaje, sunt în același navigator #tabs.
const NAV_TAB_SELECTOR = '#tabs button[data-tab]';
function navTabButtons() { return $$(NAV_TAB_SELECTOR); }
function navTabButton(name) { return navTabButtons().find((b) => b.dataset.tab === name) || null; }
function activeNavTabButton() { return navTabButtons().find((b) => b.classList.contains('active')) || null; }
function selectNavTabButton(b) {
  navTabButtons().forEach((x) => x.classList.toggle('active', x === b));
  $$('#tabs .navlabel').forEach((l) => l.classList.remove('active'));
  const grp = b.closest('.navgroup');
  closeMenus();
  if (grp) grp.querySelector('.navlabel').classList.add('active');
}
function navigateFromTabButton(b) {
  if (!b || !b.dataset.tab) return;
  selectNavTabButton(b);
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
  if (document.activeElement) document.activeElement.blur();
  onTab(b.dataset.tab);
  // optional: deruleaza la o sectiune anume din tab (ex. „Ieșiri” -> banda IEȘIRE)
  if (b.dataset.scroll) {
    const el = document.getElementById(b.dataset.scroll);
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  } else {
    window.scrollTo({ top: 0 });
  }
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !b.dataset.tab) return; // ignora etichetele de grup
  navigateFromTabButton(b);
});
// Portofoliu nu ocupă un loc în navigator; rămâne disponibil acolo unde se gestionează
// mai multe firme: Setări -> Cine are acces -> Firmele mele.
$('#portofoliuGo') && $('#portofoliuGo').addEventListener('click', () => goTab('portofoliu'));
// Utilitarele care nu schimbă pagina (țema, densitatea, căutarea etc.) închid dropdownul
// după alegere; destinațiile data-tab sunt tratate de listenerul unic de pe #tabs.
$('#sideTools').addEventListener('click', (e) => {
  const control = e.target.closest('button, a');
  if (control && !control.dataset.tab) closeMenus();
});
function onTab(t) {
  if (t === 'dashboard') loadDashboard();
  if (t === 'documente' || t === 'intrate' || t === 'iesite') loadEntries();
  if (t === 'emite') renderRecurring();
  if (t === 'intrate') { loadMissingDocs(); loadCalitate(); }
  // Temeiul legal al pasului se umple pe ORICE tab care are un slot — pasii ciclului contabil se
  // executa pe ecrane diferite, iar un apel legat de un singur tab i-ar lasa pe ceilalti muti.
  // Functia isi tine singura evidenta (`data-umplut`), deci apelul repetat nu costa nimic.
  umpleTemeiuri();
  if (t === 'jurnal') loadJournal();
  if (t === 'carte') loadLedger();
  if (t === 'cashbook') loadCashbook();
  if (t === 'balanta') loadBalance();
  if (t === 'storno') loadStorno();
  if (t === 'tva') loadVat();
  // Inchiderile stau in doua pagini (ritm lunar / ritm anual), dar randarea ramane un singur punct:
  // `loadClosings()` umple toate previzualizarile dintr-o data, iar cardurile exista in DOM
  // indiferent de pagina activa. Cockpitul lunar se incarca doar unde se vede.
  if (t === 'inchideri' || t === 'inchidere-an') loadClosings();
  if (t === 'inchideri') loadMonthlyClose();
  // Situatiile si anexele lor (fluxuri, capitaluri, note): acelasi `loadStatements()` umple ambele pagini.
  if (t === 'situatii' || t === 'anexe') loadStatements();
  // Trei panouri au plecat din „Situatii financiare", fiindca nu erau situatii financiare:
  // bugetul e control de gestiune INTERN, registrul fiscal tine de impozitul pe profit, iar
  // SAF-T e o DECLARATIE — pe care meniul o promitea deja la „Declaratii ANAF", fara sa fie acolo.
  if (t === 'buget') loadBuget();
  if (t === 'regfiscal') loadRegFiscal();
  // Declaratiile lunii, SAF-T si SPV au pagini separate: SAF-T are perioada lui, iar panoul SPV
  // nu se randeaza singur (raspunsurile se cer la clic), deci n-are ce incarca la deschidere.
  if (t === 'livrabile') loadLivrabile();
  if (t === 'saft') loadSaft();
  if (t === 'portofoliu') loadPortfolio();
  if (t === 'notificari') loadNotifications();
  if (t === 'reconciliere') loadReconcile();
  if (t === 'analitic') loadAnalytic();
  // Mijloacele fixe si leasingul sunt doua pagini, dar randarea ramane un singur punct: cardurile
  // exista in DOM indiferent de pagina activa, deci fiecare dintre cele doua cheama acelasi lucru
  // — la fel de scump ca azi, si fara o a doua cale de randare care sa driftreze fata de prima.
  if (t === 'mijloace' || t === 'leasing') { loadAssets(); loadLeasingContracts(); }
  // Idem pentru cele trei pagini de salarii: `loadSalarizare()` umple statul, lista si registrul
  // anual dintr-o singura runda (si tot el pune anul implicit in `#rsYear`).
  if (t === 'salarizare' || t === 'angajati' || t === 'regsalarii') loadSalarizare();
  // Stocurile sunt sparte in trei pagini, dar `loadStocks()` ramane UN singur punct de randare:
  // umple toate zonele (gestiuni, produse, stoc, miscari, productie, retete) dintr-o singura runda
  // de patru apeluri. Cardurile exista in DOM indiferent de pagina activa, deci fiecare dintre cele
  // trei cheama acelasi lucru — la fel de scump ca azi, si fara o a doua cale de randare care sa
  // driftreze fata de prima.
  if (t === 'stocuri' || t === 'productie' || t === 'configstoc') loadStocks();
  if (t === 'parteneri') loadPartners();
  // Setarile au fost sparte in cinci pagini tematice. `setari` PASTREAZA reimprospatarea completa,
  // deliberat: vreo zece locuri din aplicatie cheama `onTab('setari')` dupa o operatie (firma
  // activata/stearsa, colaborator acceptat, copie restaurata) ca sa reincarce ce s-a schimbat.
  // Toate cardurile exista in DOM indiferent de pagina activa, deci un refresh complet ramane
  // corect si nu costa mai mult decat costa azi. Paginile noi isi randeaza doar partea lor.
  if (t === 'setari') { renderAnaf(); renderFirme(); renderColaboratori(); renderUsers(); render2FA(); renderSmtp(); renderFiscal(); renderBackup(); renderProfile(); renderSessions(); renderLock(); renderOpening(); }
  if (t === 'cont') { renderProfile(); renderSessions(); render2FA(); }
  if (t === 'acces') { renderFirme(); renderColaboratori(); renderUsers(); renderCereriAcces(); }
  if (t === 'date') { renderBackup(); renderOpening(); }
  if (t === 'conexiuni') { renderAnaf(); renderSmtp(); renderFiscal(); }
  // Pagina pachetului Windows e pentru TOTI utilizatorii — nicio garda pe rol aici.
  if (t === 'pachetwin') renderPachetWin();
  // Videoul de prezentare: fisier static + manifest, ca pachetul Windows (vezi settings.js).
  if (t === 'video') renderVideo();
  if (t === 'audit') renderAudit();
  if (t === 'accesari') renderAccess();
  if (t === 'arhiva') loadArhiva();
  if (t === 'plan') renderPlan();
  if (t === 'galerie') loadGalerie();
  if (t === 'galerie-emise') loadGalerieEmise();
  if (t === 'abonament') loadSubscription();
  if (t === 'ghid') renderGhid();
  if (t === 'mesaje') loadMessages();
}
// ───────────────────────── FIRME (multi-firma) ─────────────────────────
// Eticheta de abonament din selectorul de firme: proba (cu zilele ramase), expirata, fara
// abonament, sau nimic pentru un abonament activ. Scoasa la nivel de modul ca sa fie testabila —
// e primul lucru pe care il vede utilizatorul despre starea platii firmei.
const subTag = (f) => { const s = (f || {})._sub || {}; return s.status === 'trial' ? ' 🎁 probă ' + s.zileRamase + 'z' : s.status === 'expired' ? ' 🎁 expirată' : s.status === 'none' ? ' ⚠ fără abonament' : ''; };
function fillFirmaSelect() {
  const sel = $('#firmaSelect');
  const opts = (META.firme || []).map((f) => {
    const option = document.createElement('option');
    option.value = String(f.id);
    option.selected = String(f.id) === String(META.firmaActiva);
    option.textContent = `${f.nume || ''}${f.cui ? ' (' + f.cui + ')' : ''}${subTag(f)}`;
    // Selectorul vizibil rămâne nativ și unic; metadatele alimentează căutarea integrată
    // fără să extragem fragil numele/CUI-ul din eticheta formatată pentru afișare.
    option.dataset.companyName = f.nume || '';
    option.dataset.companyCui = f.cui || '';
    option.dataset.companyStatus = subTag(f).trim();
    return option;
  });
  // optiune de adaugare direct din selector (discoverability) — duce la Setari -> Firmele mele.
  // Contul demo nu adauga/gestioneaza firme (lucreaza doar pe firma demo, resetata periodic).
  if (!isDemo()) {
    const manage = document.createElement('option');
    manage.value = '__add__';
    manage.textContent = '＋ Adaugă / gestionează firme…';
    opts.push(manage);
  }
  sel.replaceChildren(...opts);
}
// Schimbarea firmei active, ca functie ASTEPTABILA. Handlerul de pe #firmaSelect e async, deci
// cine il declanseaza cu dispatchEvent nu are cum sa astepte sfarsitul lui `init()`. Notificarile
// au nevoie sa astepte: abia dupa ce firma s-a schimbat pot pune luna si deschide ecranul.
async function activateFirma(id) {
  if (String(id) === String(META.firmaActiva)) return false;
  await api('/api/firme/' + id + '/activate', { method: 'POST' });
  await init();
  return true;
}
$('#firmaSelect').addEventListener('change', async (e) => {
  if (e.target.value === '__add__') { // nu e o firma — deschide gestionarea firmelor
    e.target.value = String(META.firmaActiva || '');
    goTab('acces'); // firmele si cererile de acces stau acum in pagina lor, nu in „Firma mea"
    // firmele nu se mai creeaza de aici: o firma noua intra prin inscriere (patronul ei),
    // iar una existenta se adauga cerand acces dupa CUI, cu acordul proprietarului
    setTimeout(() => { const c = $('#cerereAccesForm'); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.cui.focus(); } }, 150);
    return;
  }
  // Include și ultimele taste încă aflate în debounce. Cheia folosește firma veche; după init,
  // formularele vor restaura numai ciornele firmei nou activate.
  flushAllFormFlows();
  await activateFirma(e.target.value);
  const active = activeNavTabButton(); onTab(active ? active.dataset.tab : 'dashboard');
  toast('Firmă activă schimbată');
});
// ───────────────────────── ADMINISTRARE (firme / utilizatori / audit) ─────────────────────────
// Extrase in public/admin.js.
setAdminDeps({ init, onTab, promptFirmaSubscribe, impersonate });

// ───────────────────────── SETARI CONT & SECURITATE ─────────────────────────
// 2FA, backup, profil/sesiuni, SMTP, cote fiscale traiesc in public/settings.js.
setSettingsDeps({ init, onTab });
function renderGhid() {
  const f = META.fiscal; if (!f) return;
  $('#ghidFiscal').innerHTML =
    `<div class="card"><h3>Salarii și contribuții</h3><table>
      <tr><td>CAS (pensii, reținut)</td><td class="num">${f.cas}%</td></tr>
      <tr><td>CASS (sănătate, reținut)</td><td class="num">${f.cass}%</td></tr>
      <tr><td>Impozit pe venit (reținut)</td><td class="num">${f.impozitVenit}%</td></tr>
      <tr><td>CAM (angajator)</td><td class="num">${f.cam}%</td></tr>
      <tr><td>Salariu minim brut (S1 / S2)</td><td class="num">${fmt(f.salariuMinimS1)} / ${fmt(f.salariuMinimS2)}</td></tr>
      <tr><td>Salariu minim construcții</td><td class="num">${fmt(f.salariuMinimConstructii)}</td></tr>
      <tr><td>Sumă neimpozabilă (S1 / S2)</td><td class="num">${fmt(f.neimpozabilS1)} / ${fmt(f.neimpozabilS2)}</td></tr>
     </table></div>
     <div class="card"><h3>TVA și impozite firmă</h3><table>
      <tr><td>TVA cotă standard</td><td class="num">${f.tvaStandard}%</td></tr>
      <tr><td>TVA cotă redusă</td><td class="num">${f.tvaRedus}%</td></tr>
      <tr><td>Impozit microîntreprindere</td><td class="num">${f.impozitMicro}%</td></tr>
      <tr><td>Impozit pe profit</td><td class="num">${f.impozitProfit}%</td></tr>
      <tr><td>Impozit pe dividende</td><td class="num">${f.impozitDividende}%</td></tr>
      <tr><td>Deductibilitate TVA auto limitat</td><td class="num">${f.deductibilitateTvaAutoLimitat}%</td></tr>
     </table></div>`;
}

// ───────────────────────── IMPERSONARE + SESIUNE ─────────────────────────
// Mesageria (chat suport, notificari, polling) traieste in public/messages.js.

// Impersonare: aplica starea (banner + badge) si actiunile de intrare/iesire pe cont
function applySessionState(u) {
  const banner = $('#imperBanner');
  const contNav = $('#tabs button[data-tab="cont"]');
  if (u && u.impersonating) {
    $('#imperName').textContent = u.username;
    const expiry = $('#imperExpiry');
    if (expiry) expiry.textContent = u.impersonating.expiresAt
      ? (' · expiră la ' + String(u.impersonating.expiresAt).slice(11, 16)) : '';
    banner.classList.remove('hidden');
    document.body.classList.add('impersonating');
    if (contNav) contNav.classList.add('hidden');
  } else {
    banner.classList.add('hidden');
    document.body.classList.remove('impersonating');
    if (contNav) contNav.classList.remove('hidden');
  }
  setMsgBadge((u && u.unreadMessages) || 0);
  setLastUnread((u && u.unreadMessages) || 0);
}
async function impersonate(userId) {
  const reason = await promptAction('Accesul este temporar și rămâne în jurnalul de audit.', {
    title: 'Motivul impersonării', label: 'Motiv', multiline: true, required: true, minLength: 10,
    confirmLabel: 'Continuă',
  });
  if (reason == null) return;
  const ticket = await promptAction('Leagă accesul de solicitarea care îl justifică.', {
    title: 'Referință obligatorie', label: 'Tichet / solicitare', required: true, minLength: 3,
    placeholder: 'ex. SUP-1842', confirmLabel: 'Continuă',
  });
  if (ticket == null) return;
  try {
    await api('/api/impersonate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reason, ticket }) });
    await init(); onTab('dashboard'); toast('Ai intrat pe contul utilizatorului');
  } catch (e) { toast(e.message, true); }
}
$('#imperStop').addEventListener('click', async () => {
  try { await api('/api/impersonate/stop', { method: 'POST' }); await init(); onTab('setari'); toast('Ai revenit la contul de admin'); }
  catch (e) { toast(e.message, true); }
});

// ───────────────────────── INIT ─────────────────────────
// ───────────────────────── INIT ─────────────────────────
// Dictionarul de explicatii pe panouri e in public/panel-info.js (incarcat inainte de app.js).
function addPanelInfo() {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ăâîșşțţ]/g, '');
  // fiscalText: cotele din explicatii vin din META.fiscal (tabelul e constanta, evaluata la import)
  const dict = PANEL_INFO.map(([t, info]) => [norm(t), fiscalText(info)]).sort((a, b) => b[0].length - a[0].length);
  $$('.card h2, .card h3, section .toolbar h2, .card > summary').forEach((h) => {
    if (h.querySelector('.cinfo')) return;
    const key = norm(h.textContent);
    const hit = dict.find(([t]) => key.startsWith(t));
    if (!hit) return;
    const i = document.createElement('span');
    i.className = 'cinfo'; i.tabIndex = 0; i.textContent = 'i';
    i.setAttribute('role', 'note'); i.setAttribute('aria-label', hit[1]);
    // Al treilea element al intrarii (optional) e coada TEHNICA a explicatiei — notele contabile
    // („constitui ajustarea 6814 = 491"). Merge intr-un <span class="adv">, deci dispare in modul
    // simplu si ramane pentru expert. Se construieste ca NOD separat, nu prin innerHTML: textul
    // ramane pus cu textContent, deci nu se deschide o cale de injectie in explicatii.
    const pop = document.createElement('span');
    pop.className = 'cpop'; pop.textContent = hit[1];
    if (hit[2]) {
      const teh = document.createElement('span');
      teh.className = 'adv'; teh.textContent = ' ' + hit[2];
      pop.appendChild(teh);
    }
    i.appendChild(pop);
    h.appendChild(i);
  });
}

async function init() {
  // Poate fi chemat și din alte fluxuri decât selectorul (administrare, impersonare). Finalizează
  // ciornele sub contextul de firmă încă activ înainte de a înlocui META cu răspunsul nou.
  flushAllFormFlows();
  try {
    setMeta(await api('/api/meta'));
  } catch (e) {
    if (e.status === 401) { showLogin(); handleCheckoutReturn(); handleRegisterLink(); return; }
    // Cont cu parola implicita: serverul blocheaza pana la schimbare (inclusiv /api/meta).
    if (e.status === 403 && e.data && e.data.mustChange) {
      // Tokenul CSRF se ia de obicei din /api/meta — dar tocmai meta e blocata aici, iar sesiunea
      // EXISTA, deci garda cere token la orice cerere mutanta. Fara el, ecranul de schimbare
      // fortata nu putea trimite nimic: „Cerere respinsă (token CSRF lipsă sau invalid)", fara
      // iesire — reincarcarea ducea in exact aceeasi stare. /api/me e permisa cat timp mustChange
      // e activ si poarta tokenul, deci de acolo il luam.
      try { const me = await api('/api/me'); setCsrf(me && me.csrf); } catch (_) { /* ecranul se arata oricum */ }
      showForcePw(); return;
    }
    throw e;
  }
  hideLogin();
  applyFiscalDefaults(); // cotele implicite din formulare vin din META.fiscal, nu din HTML
  setUser(META.user || {});
  setCsrf(META.user && META.user.csrf); // token-ul CSRF pentru toate cererile mutante ulterioare
  // Ciornele locale se leaga de contul curent INAINTE ca vreun formular sa fie incarcat.
  setFormFlowUser(META.user && META.user.id);
  // Plasa de siguranta (daca meta ar fi permisa candva): acelasi ecran de schimbare fortata.
  if (USER.mustChange) { showForcePw(); return; }
  $('#userBadge').textContent = USER.username ? (USER.username + (USER.tip ? ' · ' + USER.tip : '')) : '';
  // Administratorul neinrolat poate ajunge numai la pagina in care isi activeaza 2FA. Serverul
  // aplica aceeasi poarta; blocarea navigatiei evita o succesiune de ecrane care raspund 428.
  $$('#tabs button[data-twofa-locked="1"]').forEach((b) => { b.disabled = false; delete b.dataset.twofaLocked; });
  if (USER.twofaRequired) {
    $$('#tabs button[data-tab]').forEach((b) => {
      if (b.dataset.tab !== 'cont') { b.disabled = true; b.dataset.twofaLocked = '1'; }
    });
    applySessionState(USER);
    goTab('cont'); render2FA();
    toast('Activează 2FA pentru a continua ca administrator.', true);
    return;
  }
  // Prin CLASA, nu prin style.display: `= ''` doar sterge stilul inline si lasa regula din
  // foaia de stil sa ascunda mai departe — asa au ramas INVIZIBILE pentru admin cardurile de
  // utilizatori, backup, SMTP si cote fiscale, plus exportul complet si stergerea logoului.
  $('#usersCard').classList.toggle('hidden', USER.role !== 'admin');
  // Intrarea de meniu „Cine accesează aplicația" (submeniul Setări) — doar admin. Serverul refuza
  // oricum /api/access-log cu 403; ascunderea evita o intrare de meniu care nu poate reusi.
  $('#navAccesari') && $('#navAccesari').classList.toggle('hidden', USER.role !== 'admin');
  $('#exportAllBtn') && $('#exportAllBtn').classList.toggle('hidden', USER.role !== 'admin');
  // Planul de conturi e global (partajat de toate firmele), deci importul e rezervat adminului
  // — serverul raspunde 403 oricum; ascunderea evita un buton care nu poate reusi.
  $('#accImportBox') && ($('#accImportBox').style.display = USER.role === 'admin' ? '' : 'none');
  // Catalogul duratelor (HG 2139/2004) e tot stare GLOBALA, ca planul de conturi — deci acelasi
  // tratament: importul il vede doar adminul. Cautarea ramane a tuturor.
  $('#cdImportBox') && ($('#cdImportBox').style.display = USER.role === 'admin' ? '' : 'none');
  applySessionState(USER);
  // drepturi granulare: utilizatorii fara acces la salarizare nu vad intrarea din meniu
  const faraSalarii = !!(USER.drepturi && USER.drepturi.faraSalarii);
  // Prin CLASA, nu prin style inline: regulile de sidebar au `!important`, care bate un
  // un display:none pus inline din JS, care nu e important — deci ascunderea nu se producea deloc.
  // Toate cele trei pagini de salarii, nu doar statul: dreptul e „fara salarii", iar angajatii si
  // registrul anual arata exact aceleasi date.
  $$('button[data-tab="salarizare"], button[data-tab="angajati"], button[data-tab="regsalarii"]')
    .forEach((b) => b.classList.toggle('hidden', faraSalarii));
  const gs = $('#navgrupSalarii'); if (gs) gs.classList.toggle('hidden', faraSalarii); // tot meniul, nu doar intrarea
  initUiMode(); // mod simplu implicit pentru necontabili (ascunde partea tehnica din meniu)
  // Ghidul se construieste DUPA initUiMode: citeste aceleasi grupuri din #tabs, iar modul simplu
  // le ascunde prin CSS, nu le scoate din DOM — deci cuprinsul ramane complet in ambele moduri.
  initGhid();
  // Intoarcere de la Stripe (user logat) dupa abonarea unei firme: confirmare + starea se activeaza la webhook
  const cr = /[?&]checkout=(success|cancel)/.exec(location.search);
  if (cr) {
    history.replaceState(null, '', location.pathname);
    if (cr[1] === 'cancel') toast('Plata a fost anulată — firma rămâne neschimbată.', true);
    else { toast('✓ Plată primită! Abonamentul firmei se activează în câteva momente (după confirmarea Stripe).'); goTab('abonament'); }
  }
  startMsgPolling();
  // Cont fara nicio firma (contabil proaspat inscris): NU e „proba expirata". Pana acum ateriza
  // pe bannerul rosu si pe ecranul de preturi — un mesaj fals, despre un abonament pe care nu-l
  // are si o firma pe care n-o are. Aici i se spune ce are efectiv de facut.
  const ffb = $('#faraFirmaBar');
  if (ffb) {
    ffb.classList.toggle('hidden', !USER.faraFirma);
    // Firma DEMO: un contabil proaspat inscris are contul GOL prin constructie, deci n-are ce
    // evalua. Butonul ii da un dosar complet, cu care se poate juca fara sa strice nimic.
    const fd = $('#faraFirmaDemo');
    if (fd && !fd._wired) {
      fd._wired = true;
      fd.addEventListener('click', async () => {
        fd.disabled = true;
        try {
          const r = await api('/api/firme/demo', { method: 'POST' });
          toast('Firma demo „' + r.nume + '" e gata — poți umbla liniștit prin ea.');
          window.location.reload(); // firma noua devine activa: reincarcam pe datele ei
        } catch (e) { toast(e.message, true); fd.disabled = false; }
      });
    }
    const g = $('#faraFirmaGo');
    if (g && !g._wired) {
      g._wired = true;
      g.addEventListener('click', () => {
        goTab('acces'); // formularul de cerere de acces s-a mutat aici
        setTimeout(() => { const c = $('#cerereAccesForm'); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.cui.focus(); } }, 150);
      });
    }
  }
  // proba expirata: banner persistent + cont read-only (serverul blocheaza scrierile cu 402)
  const seb = $('#subExpiredBar');
  if (seb) {
    seb.classList.toggle('hidden', !USER.subExpirat);
    const go = $('#subExpiredGo');
    if (go && !go._wired) { go._wired = true; go.addEventListener('click', () => goTab('abonament')); }
  }
  // La expirarea probei, ecranul de preturi se deschide SINGUR — o data pe sesiunea de pagina.
  // Contul e read-only pana la o alegere, deci a-l lasa sa rataceasca printr-o aplicatie care
  // refuza orice scriere ar fi doar frustrant. Repetarea la fiecare init() ar fi insa o capcana:
  // orice schimbare de firma sau reincarcare l-ar smulge din ecranul curent.
  if (USER.subExpirat && !window.__pretDeschis) {
    window.__pretDeschis = true;
    goTab('abonament');
    toast('Perioada de probă a expirat. Alege un plan — sau mai încearcă o lună gratuită, dacă nu ai folosit-o încă.', true);
  }
  // abonatii (necontabil/contabil) isi completeaza datele personale in Setari -> Contul meu
  if ((USER.tip === 'necontabil' || USER.tip === 'contabil') && !USER.profilComplet) {
    toast('Completează-ți datele personale (nume, telefon) în Setări → Contul meu.', true);
  }
  maybeWelcome();
  fillFirmaSelect();
  setFormFlowCompany(META.firmaActiva);
  // Curăță valorile firmei precedente și restaurează numai ciorna firmei active.
  window.dispatchEvent(new CustomEvent('contab:company-context', { detail: { firmaId: META.firmaActiva } }));
  fillCompanyForm();
  fillTipSelect();
  fillPeriods();
  renderLegal();
  renderAI();
  refreshNotifBadge();
  addPanelInfo(); // ⓘ cu explicatii pe fiecare panou
  // /?register=1 functioneaza si cu o sesiune activa (ex. demo): deschide inscrierea
  // peste aplicatie — dupa inregistrare, noul cont inlocuieste automat sesiunea curenta.
  handleRegisterLink();
  loadDashboard();
  await loadEntries();
}
// Intoarcerea de la Stripe Checkout (guest): dupa plata -> panoul de inscriere a firmei
function handleCheckoutReturn() {
  const m = /[?&]checkout=(success|cancel)/.exec(location.search);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  if (m[1] === 'cancel') { toast('Plata a fost anulată.', true); return; }
  toast('✓ Plată reușită! Creează-ți contul cu același email folosit la plată.');
  openRegisterPanel();
}
// Link direct la inscrierea firmei (ex. din pagina de prezentare): /?register=1
// ───────────────────────── DASHBOARD ─────────────────────────
// KPI-uri, rezumat, buget, forecast, an-la-an si grafice traiesc in public/dashboard.js.
setDashboardDeps({ goTab });
// Cockpitul de inchidere lunara (public/inchidere.js) navigheaza catre pasul de rezolvat.
setInchidereDeps({ goTab });
// Notificarile duc utilizatorul la ecranul care rezolva restanta — pe FIRMA si pe LUNA ei.
setLivrabileDeps({ goTab, activateFirma, applyWorkMonth, setWorkMonth });
// Cautarea globala (Ctrl+K) navigheaza si ea, si pune luna documentului gasit.
setPaletaDeps({ goTab, applyWorkMonth, setWorkMonth });
$('#paletaBtn') && $('#paletaBtn').addEventListener('click', deschidePaleta);

// ───────────────────────── IMPORT EXTRAS BANCAR ─────────────────────────
// Extras in public/bank.js. Ii injectam reimprospatarea de dupa import (functiile traiesc aici).
setBankRefresh(() => { fillPeriods(); loadEntries(); loadDashboard(); });
function renderLegal() {
  const legal = META.legal || {};
  const firma = legal.firm || { mode: 'unclassified', operational: false };
  const status = $('#legalDataStatus');
  const testBtn = $('#legalTestMode');
  const realBtn = $('#legalRealMode');
  const canManage = !!firma.canManage && !isDemo();
  if (status) {
    if (firma.mode === 'test') {
      status.className = 'status ok';
      status.textContent = '✔ Mod date fictive. Scrierile sunt permise, dar nu introduce informații despre persoane sau firme reale.';
    } else if (firma.mode === 'real' && firma.operational) {
      status.className = 'status ok';
      status.textContent = '✔ Date reale activate prin acceptarea DPA-ului curent' + (firma.acceptedAt ? ' la ' + firma.acceptedAt.slice(0, 10) : '') + '.';
    } else if (firma.mode === 'real') {
      status.className = 'status err';
      status.textContent = 'Datele reale sunt blocate: cadrul juridic sau acceptarea DPA-ului nu mai este curentă.';
    } else {
      status.className = 'status err';
      status.textContent = 'Alege regimul datelor înainte de prima scriere în această firmă.';
    }
    if (!canManage) status.textContent += ' Numai proprietarul firmei poate schimba această alegere.';
  }
  if (testBtn) testBtn.disabled = !canManage;
  if (realBtn) {
    realBtn.disabled = !canManage || !legal.ready;
    realBtn.title = legal.ready ? '' : 'Datele reale rămân blocate până la identificarea furnizorului și validarea dosarului GDPR.';
  }
}

$('#legalTestMode') && $('#legalTestMode').addEventListener('click', async () => {
  const confirm = $('#legalTestConfirm');
  if (!confirm || !confirm.checked) { toast('Confirmă mai întâi că vei folosi exclusiv date fictive.', true); return; }
  try {
    await api('/api/legal/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'test', confirmFictitious: true }) });
    setMeta(await api('/api/meta')); confirm.checked = false; renderLegal(); renderAI();
    toast('Firma este în modul date fictive.');
  } catch (e) { toast(e.message, true); }
});

$('#legalRealMode') && $('#legalRealMode').addEventListener('click', async () => {
  const accept = $('#legalRealAccept');
  if (!accept || !accept.checked) { toast('Acceptă explicit cele trei documente juridice curente.', true); return; }
  try {
    await api('/api/legal/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'real', acceptTerms: true, acceptPrivacy: true, acceptDpa: true }) });
    setMeta(await api('/api/meta')); accept.checked = false; renderLegal(); renderAI();
    toast('Datele reale au fost activate pentru această firmă.');
  } catch (e) { toast(e.message, true); }
});

function renderAI() {
  const ai = META.ai || { available: false, enabled: false };
  const st = $('#aiStatus');
  const help = $('#aiHelp');
  const toggle = $('#aiToggle');
  if (ai.available) {
    st.className = 'status ok';
    st.textContent = 'Furnizor configurat: ' + (ai.provider || '—') + ' · model: ' + (ai.model || '—')
      + (ai.enabled ? ' · opt-in activ pentru firma curentă' : ' · niciun document nu este transmis fără opt-in');
    help.classList.add('hidden');
  } else {
    st.className = 'status';
    st.textContent = 'Nicio cheie API detectată — se folosesc regulile locale.';
    help.classList.remove('hidden');
    help.textContent = 'Pentru a activa extragerea cu AI, pornește serverul cu cheia setată:\n\n  ANTHROPIC_API_KEY=sk-ant-... npm start';
  }
  toggle.checked = !!ai.enabled;
  const documentToggle = $('#documentAiToggle');
  if (documentToggle) {
    documentToggle.checked = !!ai.enabled;
    documentToggle.disabled = !ai.enabled;
    const choice = $('#documentAiChoice');
    if (choice) choice.title = ai.enabled
      ? 'Poți opri AI separat pentru fiecare document.'
      : 'Activează mai întâi opt-in-ul AI al firmei în Setări.';
  }
  const legalFirm = (META.legal && META.legal.firm) || {};
  toggle.disabled = !ai.available || ai.platformEnabled === false || !legalFirm.operational || !legalFirm.canManage || isDemo();
  if (!legalFirm.canManage && ai.available) st.textContent += ' · decizia aparține proprietarului firmei';
}
$('#aiToggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  if (enabled) {
    const accepted = await confirmAction('Documentul complet va fi transmis furnizorului AI afișat, exclusiv pentru extragerea câmpurilor. Activezi pentru firma curentă?', { title: 'Opt-in AI per firmă', confirmLabel: 'Da, activează' });
    if (!accepted) { e.target.checked = false; return; }
  }
  try {
    await api('/api/legal/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, confirmExternalProcessing: enabled }) });
    setMeta(await api('/api/meta')); renderAI();
    toast(enabled ? 'Opt-in AI activat pentru firma curentă.' : 'Transmiterea către AI a fost oprită.');
  } catch (err) { e.target.checked = !enabled; toast(err.message, true); }
});
function fillCompanyForm() {
  const f = $('#companyForm');
  ['nume', 'cui', 'regCom', 'adresa', 'oras', 'judet', 'iban', 'banca', 'telefon', 'email', 'capitalSocial', 'pdfFooter', 'asociatiText', 'proRataTva', 'caen', 'perioadaTva', 'dataAnulareTva', 'dataReinregistrareTva'].forEach((k) => { if (f[k]) f[k].value = META.company[k] || ''; });
  if (f.tipEntitate) f.tipEntitate.value = META.company.tipEntitate === 'pfa' ? 'pfa' : 'srl';
  if (f.tvaPlatitor) f.tvaPlatitor.value = META.company.tvaPlatitor ? 'true' : 'false';
  if (f.tvaLaIncasare) f.tvaLaIncasare.checked = !!META.company.tvaLaIncasare;
  if (f.tvaArt317) f.tvaArt317.checked = !!META.company.tvaArt317;
  if (f.tvaCodAnulat) f.tvaCodAnulat.checked = !!META.company.tvaCodAnulat;
  if (f.motivAnulareTva) f.motivAnulareTva.value = META.company.motivAnulareTva === 'cerere' ? 'cerere' : 'oficiu';
  if (f.accentColor) f.accentColor.value = /^#[0-9a-fA-F]{6}$/.test(META.company.accentColor || '') ? META.company.accentColor : '#0b6e4f';
  if (f.pdfLayout) f.pdfLayout.value = ['clasic', 'compact', 'detaliat'].includes(META.company.pdfLayout) ? META.company.pdfLayout : 'clasic';
  // profil fiscal (motor)
  if (f.regimImpozit) f.regimImpozit.value = ['micro', 'profit'].includes(META.company.regimImpozit) ? META.company.regimImpozit : 'micro';
  if (f.d406Cadenta) f.d406Cadenta.value = ['L', 'T', 'A'].includes(META.company.d406Cadenta) ? META.company.d406Cadenta : '';
  if (f.intrastatObligat) f.intrastatObligat.checked = !!META.company.intrastatObligat;
  if (f.controlDublu) f.controlDublu.checked = !!META.company.controlDublu;
  if (f.metodaEvaluareStoc) f.metodaEvaluareStoc.value = META.company.metodaEvaluareStoc === 'fifo' ? 'fifo' : 'cmp';
  // Sistemul de plata a impozitului pe profit (art. 41) + cele doua INTRARI ale platii anticipate.
  // Anul precedent / anul curent se citesc din hartile pe ani, nu din campuri plate: firma isi
  // pastreaza istoricul, iar indicele se schimba in fiecare an.
  if (f.sistemProfit) f.sistemProfit.value = META.company.sistemProfit === 'anual' ? 'anual' : 'trimestrial';
  if (f.anticipatProfitContabil) f.anticipatProfitContabil.checked = !!META.company.anticipatProfitContabil;
  const anAcum = new Date().getFullYear();
  if (f.impozitProfitAnPrec) f.impozitProfitAnPrec.value = ((META.company.impozitProfitAn || {})[anAcum - 1] != null) ? (META.company.impozitProfitAn || {})[anAcum - 1] : '';
  if (f.ipcAnPrec) f.ipcAnPrec.value = ((META.company.ipcAnticipate || {})[anAcum] != null) ? (META.company.ipcAnticipate || {})[anAcum] : '';
  aplicaSistemProfit();
  aplicaConfigurareFirmaSimpla();
  const scut = (META.company.scutiri && typeof META.company.scutiri === 'object') ? META.company.scutiri : {};
  document.querySelectorAll('#scutiriBox [data-scutire]').forEach((c) => { c.checked = !!scut[c.dataset.scutire]; });
  // antetul situatiilor financiare — se completeaza dupa ce nomenclatoarele sunt in DOM
  fillBilantNomenclatoare().then(() => {
    BILANT_FIELDS.forEach((k) => { if (f[k]) f[k].value = META.company[k] || (k === 'auditStatut' ? '3' : ''); });
    f.dataset.serverFilled = '1';
    formFlowLoaded(f, 'firma:' + (META.firmaActiva || 'curenta'));
    window.dispatchEvent(new CustomEvent('contab:company-filled'));
  });
  refreshLogo();
  refreshFiscalProfile();
  renderFiscalHistory();
  refreshBalanceCategory();
  renderBalanceCategoryHistory();
}

// Categoria contabila + campurile de antet ale situatiilor financiare anuale (S1120/S1121/S1122).
const BILANT_FIELDS = ['categorieRaportare', 'caenE', 'codTeritorial', 'formaProprietate', 'administrator',
  'intocmitNume', 'intocmitCalitate', 'intocmitNr', 'auditStatut', 'auditorNume', 'auditorNr', 'auditorCif'];

const balanceCategoryLabel = (value) => ({
  micro: 'microentitate', mic: 'entitate mică', mare: 'entitate mijlocie/mare',
}[value] || 'neconcludent');

async function refreshBalanceCategory() {
  const box = $('#balanceCategoryStatus'); const yearInput = $('#balanceCategoryYear');
  if (!box || !yearInput) return;
  if (!yearInput.value) yearInput.value = String(new Date().getFullYear() - 1);
  const employees = ($('#balanceCategoryEmployees') || {}).value;
  const q = new URLSearchParams({ year: yearInput.value });
  if (String(employees || '').trim() !== '') q.set('numarMediuSalariati', employees);
  box.innerHTML = '<span class="ei">📐</span><p class="muted">Se calculează încadrarea…</p>';
  try {
    const r = await api('/api/balance-category?' + q.toString());
    const a = r.assessment; const i = a.currentIndicators; const p = a.previousIndicators;
    const current = balanceCategoryLabel(a.currentRawCategory);
    const recommended = balanceCategoryLabel(a.recommendedCategory);
    const emp = i.numarMediuSalariati == null ? 'date incomplete (' + i.payrollMonths + '/12 state)' : fmt(i.numarMediuSalariati);
    const confirmation = r.confirmation;
    let confirmationText = '<span class="status err">Neconfirmată — generarea bilanțului este blocată.</span>';
    if (confirmation && r.confirmedAndCurrent) {
      const savedEmployees = confirmation.indicatorOverrides && confirmation.indicatorOverrides.numarMediuSalariati;
      if ($('#balanceCategoryEmployees') && $('#balanceCategoryEmployees').value === '' && savedEmployees != null) {
        $('#balanceCategoryEmployees').value = savedEmployees;
      }
      confirmationText = '<span class="status ok">Confirmată: ' + H(balanceCategoryLabel(confirmation.category))
        + ' · ' + H(String(confirmation.confirmedAt || '').replace('T', ' ').slice(0, 16))
        + ' · ' + H(confirmation.confirmedByUsername || confirmation.confirmedRole || 'utilizator') + '</span>';
      const categorySelect = document.querySelector('#companyForm [name="categorieRaportare"]');
      if (categorySelect) categorySelect.value = confirmation.category;
    } else if (confirmation) {
      confirmationText = '<span class="status err">Confirmarea existentă nu mai corespunde datelor curente — reconfirmă.</span>';
    }
    const warnings = (a.reasons || []).length
      ? '<ul class="checklist todo">' + a.reasons.map((x) => '<li>⚠️ ' + H(x) + '</li>').join('') + '</ul>' : '';
    box.innerHTML = '<span class="ei">📐</span><div><b>' + H(a.year) + ': recomandare ' + H(recommended) + '</b>'
      + '<p class="muted">Active: ' + H(fmt(i.totalActive)) + ' lei · cifră de afaceri: ' + H(fmt(i.cifraAfaceri))
      + ' lei · nr. mediu salariați: ' + H(emp) + '. Încadrare brută: ' + H(current) + '.<br>'
      + 'Exercițiul anterior: active ' + H(fmt(p.totalActive)) + ' lei · cifră de afaceri ' + H(fmt(p.cifraAfaceri))
      + ' lei · încadrare brută ' + H(balanceCategoryLabel(a.previousRawCategory)) + '.</p>'
      + confirmationText + warnings + '</div>';
  } catch (e) {
    box.innerHTML = '<span class="ei">📐</span><p class="status err">' + H(e.message) + '</p>';
  }
}

async function renderBalanceCategoryHistory() {
  const box = $('#balanceCategoryHistory'); if (!box) return;
  try {
    const r = await api('/api/balance-category/history'); const rows = r.history || [];
    if (!rows.length) { box.innerHTML = '<p class="muted">Nu există încă nicio confirmare anuală.</p>'; return; }
    box.innerHTML = '<table><thead><tr><th>An</th><th>Categorie confirmată</th><th>Calcul</th><th>Indicatori</th><th>Confirmată de</th><th>Justificare</th></tr></thead><tbody>'
      + rows.map((x) => '<tr><td><b>' + H(x.year) + '</b></td><td>' + H(balanceCategoryLabel(x.category))
        + '</td><td>' + H(balanceCategoryLabel(x.calculatedCategory)) + '</td><td>Active ' + H(fmt((x.indicators || {}).totalActive || 0))
        + ' · CA ' + H(fmt((x.indicators || {}).cifraAfaceri || 0)) + ' · sal. '
        + H((x.indicators || {}).numarMediuSalariati == null ? 'incomplet' : fmt(x.indicators.numarMediuSalariati))
        + '</td><td>' + H(x.confirmedByUsername || x.confirmedRole || '') + '<br><span class="muted">'
        + H(String(x.confirmedAt || '').replace('T', ' ').slice(0, 16)) + '</span></td><td>' + H(x.justification || '—') + '</td></tr>').join('')
      + '</tbody></table>';
  } catch (e) { box.innerHTML = '<p class="status err">' + H(e.message) + '</p>'; }
}

$('#balanceCategoryRefresh') && $('#balanceCategoryRefresh').addEventListener('click', refreshBalanceCategory);
$('#balanceCategoryYear') && $('#balanceCategoryYear').addEventListener('change', () => {
  if ($('#balanceCategoryEmployees')) $('#balanceCategoryEmployees').value = '';
  refreshBalanceCategory();
});
$('#balanceCategoryEmployees') && $('#balanceCategoryEmployees').addEventListener('change', refreshBalanceCategory);
$('#balanceCategoryConfirm') && $('#balanceCategoryConfirm').addEventListener('click', async () => {
  const categorySelect = document.querySelector('#companyForm [name="categorieRaportare"]');
  const year = ($('#balanceCategoryYear') || {}).value;
  if (!categorySelect || !categorySelect.value) return toast('Alege categoria contabilă de raportare.', true);
  try {
    await api('/api/balance-category/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      year, category: categorySelect.value,
      numarMediuSalariati: ($('#balanceCategoryEmployees') || {}).value || null,
      justification: ($('#balanceCategoryJustification') || {}).value || '',
    }) });
    if ($('#balanceCategoryJustification')) $('#balanceCategoryJustification').value = '';
    await Promise.all([refreshBalanceCategory(), renderBalanceCategoryHistory()]);
    toast('Categoria bilanțului a fost confirmată pentru ' + year + '.');
  } catch (e) { toast(e.message, true); }
});

// Nomenclatoarele vin de la SERVER, nu sunt scrise in HTML: valorile admise sunt cele extrase din
// validatorul oficial ANAF (src/bilantNomenclator.js). O lista copiata in frontend ar putea drifta
// fata de ce accepta ANAF, iar o valoare in afara listei inseamna declaratie respinsa.
let nomBilantCache = null;
async function fillBilantNomenclatoare() {
  const selects = document.querySelectorAll('#companyForm [data-nom]');
  if (!selects.length) return;
  if (!nomBilantCache) {
    try { nomBilantCache = await api('/api/bilant-nomenclator'); } catch (_) { return; }
  }
  selects.forEach((sel) => {
    if (sel.dataset.populat) return; // o singura data: repopularea ar pierde selectia curenta
    const lista = nomBilantCache[sel.dataset.nom] || [];
    for (const o of lista) {
      const opt = document.createElement('option');
      opt.value = o.cod;
      opt.textContent = o.cod + ' — ' + o.nume;
      sel.appendChild(opt);
    }
    sel.dataset.populat = '1';
  });
}
// Sistemul art. 41 are inteles DOAR in regimul „impozit pe profit": la microintreprindere si la
// PFA, un selector de sistem de plata a impozitului pe profit e o intrebare fara raspuns. Se
// ascunde randul intreg, nu doar optiunile — un camp inaplicabil lasat vizibil e o invitatie la
// bifat gresit. Blocul cu intrarile platii anticipate apare doar cand sistemul ales e cel anual.
function aplicaSistemProfit() {
  const f = $('#companyForm'); if (!f) return;
  const rand = $('#sistProfitRow'); const box = $('#anticipatBox');
  const ePeProfit = f.regimImpozit && f.regimImpozit.value === 'profit'
    && !(f.tipEntitate && f.tipEntitate.value === 'pfa');
  if (rand) rand.classList.toggle('hidden', !ePeProfit);
  if (box) box.classList.toggle('hidden', !(ePeProfit && f.sistemProfit && f.sistemProfit.value === 'anual'));
}
['regimImpozit', 'sistemProfit', 'tipEntitate'].forEach((n) => {
  const el = document.querySelector('#companyForm [name="' + n + '"]');
  if (el) el.addEventListener('change', aplicaSistemProfit);
});

function firmaPlatitoareTva(form) {
  return !!(form && form.tvaPlatitor && String(form.tvaPlatitor.value) === 'true');
}

// În pasul simplu se văd numai întrebările aplicabile. Valorile avansate NU sunt șterse când
// secțiunea se ascunde: un contabil poate comuta temporar regimul ca să verifice o variantă, iar
// formularul nu are voie să piardă tacit o configurare fiscală deja salvată.
function aplicaConfigurareFirmaSimpla() {
  const f = $('#companyForm'); if (!f) return;
  const platitoare = firmaPlatitoareTva(f);
  const pfa = !!(f.tipEntitate && f.tipEntitate.value === 'pfa');
  const anulat = !!(f.tvaCodAnulat && f.tvaCodAnulat.checked);
  $('#companyVatPeriodRow')?.classList.toggle('hidden', !platitoare);
  $('#companyTaxRegimeRow')?.classList.toggle('hidden', pfa);
  $('#companyTvaCashRow')?.classList.toggle('hidden', !platitoare);
  $('#companyProRataRow')?.classList.toggle('hidden', !platitoare);
  $('#companyTvaCancelledDetails')?.classList.toggle('hidden', !anulat);
}
['tvaPlatitor', 'tvaCodAnulat', 'tipEntitate'].forEach((n) => {
  const el = document.querySelector('#companyForm [name="' + n + '"]');
  if (el) el.addEventListener('change', aplicaConfigurareFirmaSimpla);
});

// Completarea datelor firmei dupa CUI, din registrul public ANAF. Aici intra si CAEN-ul, care nu
// e cosmetic: fara el, controlul de coerenta al aplicatiei semnaleaza „esti platitor de TVA, dar
// codul CAEN nu e completat — decontul D300 il solicita", iar conditia de activitate pentru
// regimul micro (art. 51) nu poate fi verificata deloc. Un camp completat singur la inscriere
// stinge doua avertismente pe care omul nu stia cum sa le rezolve.
legaCompletareCui($('#companyForm'), {
  nume: 'denumire', regCom: 'nrRegCom', adresa: 'adresa', oras: 'localitate', judet: 'judet', caen: 'caen',
});

// Rezumatul profilului fiscal CALCULAT (motorul) — arata ce declaratii/alerte deriva din setari
async function refreshFiscalProfile() {
  const box = $('#fiscalProfileSummary'); if (!box) return;
  try {
    const p = await api('/api/fiscal-profile');
    const regim = p.pfa ? 'PFA (Declarația Unică)' : (p.profit ? 'impozit pe profit (D101)' : 'micro (D100)');
    const tva = p.tvaCodAnulat ? ('cod normal de TVA anulat — D311' + (p.dataAnulareTva ? ' din ' + H(p.dataAnulareTva) : ''))
      : (p.tvaPlatitor ? ('plătitoare TVA — ' + (p.perioadaTva === 'T' ? 'trimestrial' : 'lunar') + (p.tvaLaIncasare ? ', la încasare' : ''))
        : ('neplătitoare de TVA' + (p.tvaArt317 ? ', cu cod special art. 317 (D301/D390)' : '')));
    const scutiri = Object.keys(p.scutiri || {}).filter((k) => p.scutiri[k]);
    let ctrlHtml = '';
    try {
      const c = await api('/api/fiscal-controls');
      if (c.findings && c.findings.length) {
        const icon = { eroare: '⛔', atentie: '⚠️', info: 'ℹ️' };
        ctrlHtml = '<div data-u="ctrl"><b>Controale de coerență:</b><ul class="checklist todo">'
          + c.findings.map((f) => `<li>${icon[f.nivel] || '•'} ${H(f.mesaj)}</li>`).join('') + '</ul></div>';
      } else {
        ctrlHtml = '<div class="muted">✓ Controale de coerență: nicio problemă pe anul curent.</div>';
      }
    } catch (_) { /* controalele sunt best-effort */ }
    const interval = p.fiscalValidFrom ? ` · valabil ${H(p.fiscalValidFrom)}–${H(p.fiscalValidTo || 'prezent')}` : '';
    const recorded = p.fiscalRecordedAt ? ` · înregistrat ${H(String(p.fiscalRecordedAt).replace('T', ' ').slice(0, 16))} UTC` : '';
    box.innerHTML = `<span class="ei">⚙️</span><p><b>Profil calculat:</b> ${tva} · ${regim} · D406 <b>${{ L: 'lunar', T: 'trimestrial', A: 'anual' }[p.d406] || p.d406}</b> · Intrastat ${p.intrastat ? '<b>da</b>' : 'nu'} · salariați ${p.areAngajati ? 'da' : 'nu'}${scutiri.length ? ' · scutiri: ' + scutiri.join(', ').toUpperCase() : ''}${interval}${recorded}<br><span class="muted">Declarațiile, termenele, alertele și controalele se generează din acest profil.</span></p>${ctrlHtml}`;
  } catch (e) { box.innerHTML = `<span class="ei">⚙️</span><p class="muted">Profilul fiscal se calculează după salvarea firmei.</p>`; }
}

function fiscalChangesFromForm() {
  const f = $('#companyForm'); const scutiri = {};
  document.querySelectorAll('#scutiriBox [data-scutire]').forEach((c) => { if (c.checked) scutiri[c.dataset.scutire] = true; });
  return {
    tipEntitate: f.tipEntitate.value,
    tvaPlatitor: firmaPlatitoareTva(f),
    tvaArt317: !!(f.tvaArt317 && f.tvaArt317.checked),
    tvaLaIncasare: !!(f.tvaLaIncasare && f.tvaLaIncasare.checked),
    tvaCodAnulat: !!(f.tvaCodAnulat && f.tvaCodAnulat.checked),
    dataAnulareTva: f.dataAnulareTva ? f.dataAnulareTva.value : '',
    motivAnulareTva: f.motivAnulareTva ? f.motivAnulareTva.value : 'oficiu',
    dataReinregistrareTva: f.dataReinregistrareTva ? f.dataReinregistrareTva.value : '',
    perioadaTva: f.perioadaTva ? f.perioadaTva.value : 'L',
    regimImpozit: f.regimImpozit ? f.regimImpozit.value : 'micro',
    d406Cadenta: f.d406Cadenta ? f.d406Cadenta.value : '',
    intrastatObligat: !!(f.intrastatObligat && f.intrastatObligat.checked),
    sistemProfit: f.sistemProfit ? f.sistemProfit.value : 'trimestrial',
    anticipatProfitContabil: !!(f.anticipatProfitContabil && f.anticipatProfitContabil.checked),
    scutiri,
  };
}

async function renderFiscalHistory() {
  const box = $('#fiscalHistory'); if (!box) return;
  if ($('#fiscalValidFrom') && !$('#fiscalValidFrom').value) $('#fiscalValidFrom').value = new Date().toISOString().slice(0, 10);
  try {
    const r = await api('/api/fiscal-profile/history'); const rows = r.history || [];
    if (!rows.length) { box.innerHTML = '<p class="muted">Nu există încă revizii. Prima schimbare va crea automat și fotografia inițială.</p>'; return; }
    const tva = (v) => v.tvaCodAnulat ? 'cod anulat' : v.tvaPlatitor ? 'TVA ' + (v.perioadaTva === 'T' ? 'trimestrial' : 'lunar') : v.tvaArt317 ? 'art. 317' : 'neplătitor';
    box.innerHTML = `<table><thead><tr><th>Valabil de la</th><th>Valabil până la</th><th>Regim</th><th>TVA</th><th>D406</th><th>Motiv</th><th>Înregistrată la</th></tr></thead><tbody>${rows.map((x) => {
      const v = x.values || {};
      return `<tr><td><b>${H(x.validFrom)}</b></td><td>${H(x.validTo || 'prezent')}</td><td>${H(v.regimImpozit || (v.tipEntitate === 'pfa' ? 'pfa' : 'micro'))}</td><td>${H(tva(v))}</td><td>${H(v.d406Cadenta || 'automat')}</td><td>${H(x.note || '')}</td><td>${H(String(x.recordedAt || x.createdAt || '').replace('T', ' ').slice(0, 16))} UTC</td></tr>`;
    }).join('')}</tbody></table>`;
  } catch (e) { box.innerHTML = `<p class="status err">${H(e.message)}</p>`; }
}

$('#fiscalRevisionSave') && $('#fiscalRevisionSave').addEventListener('click', async () => {
  const validFrom = ($('#fiscalValidFrom') || {}).value;
  if (!validFrom) return toast('Alege data de intrare în vigoare', true);
  try {
    const r = await api('/api/fiscal-profile/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      validFrom, note: ($('#fiscalRevisionNote') || {}).value || '', changes: fiscalChangesFromForm(),
    }) });
    META.company = r.company;
    if ($('#fiscalRevisionNote')) $('#fiscalRevisionNote').value = '';
    await Promise.all([renderFiscalHistory(), refreshFiscalProfile()]);
    toast('Revizie fiscală salvată, valabilă de la ' + validFrom);
  } catch (e) { toast(e.message, true); }
});
// Logo firma (apare in antetul PDF-urilor emise) — incarcare/stergere + previzualizare
async function refreshLogo() {
  const img = $('#logoPreview'); const del = $('#logoDeleteBtn');
  if (!img) return;
  try {
    const r = await fetch('/api/company/logo?ts=' + Date.now());
    // ATENTIE: „firma nu are logo" vine ca 204, iar 204 E un raspuns `ok` (2xx). Un `if (r.ok)`
    // simplu ar fi construit un obiect-imagine dintr-un corp GOL, adica exact pictograma de
    // imagine rupta pe care schimbarea voia s-o evite. Se cere corp, nu doar succes.
    const areLogo = r.ok && r.status !== 204;
    // acelasi motiv ca la cardurile de admin: butonul de stergere e ascuns din foaia de stil,
    // iar `style.display = ''` doar sterge stilul inline, fara sa-l arate
    if (areLogo) { img.src = URL.createObjectURL(await r.blob()); img.style.display = ''; if (del) del.classList.remove('hidden'); }
    else { img.style.display = 'none'; if (del) del.classList.add('hidden'); }
  } catch (e) { /* fara logo */ }
}
$('#logoUploadBtn') && $('#logoUploadBtn').addEventListener('click', async () => {
  const f = $('#logoFile').files[0]; if (!f) return toast('Alege un fișier PNG sau JPEG', true);
  const fd = new FormData(); fd.append('file', f);
  try { await api('/api/company/logo', { method: 'POST', body: fd }); toast('Logo încărcat — apare în antetul tuturor PDF-urilor'); $('#logoFile').value = ''; refreshLogo(); }
  catch (err) { toast(err.message, true); }
});
$('#logoDeleteBtn') && $('#logoDeleteBtn').addEventListener('click', async () => {
  await api('/api/company/logo', { method: 'DELETE' }); toast('Logo șters'); refreshLogo();
});
function renderLock() {
  const lu = META.company && META.company.lockedUntil;
  const st = $('#lockStatus'); const inp = $('#lockUntil');
  if (st) { st.className = 'status' + (lu ? ' ok' : ''); st.textContent = lu ? '🔒 Perioade blocate până la ' + lu + ' inclusiv (read-only).' : 'Nicio perioadă blocată — toate lunile sunt editabile.'; }
  if (inp && lu) inp.value = lu;
}
async function setLock(lockedUntil, motiv) {
  const r = await api('/api/period-lock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lockedUntil, motiv }) });
  if (META.company) META.company.lockedUntil = r.lockedUntil;
  renderLock();
  return r;
}
$('#lockSet') && $('#lockSet').addEventListener('click', async () => {
  const v = $('#lockUntil').value;
  if (!v) return toast('Alege o lună', true);
  let motiv = '';
  const curent = META.company && META.company.lockedUntil;
  if (curent && v < curent) {
    motiv = await promptAction('Reducerea intervalului blocat este un override. Motivul rămâne în jurnalul de audit.', {
      title: 'Reduci blocarea?', label: 'Motivul excepției', multiline: true, required: true, minLength: 10,
      confirmLabel: 'Aplică override-ul', danger: true,
    });
    if (motiv == null) return;
  }
  try { await setLock(v, motiv); toast('Perioade blocate până la ' + v); } catch (e) { toast(e.message, true); }
});
$('#lockClear') && $('#lockClear').addEventListener('click', async () => {
  const motiv = await promptAction('Toate lunile închise vor deveni editabile. Motivul excepției rămâne în jurnalul de audit.', {
    title: 'Deblochezi toate perioadele?', label: 'Motivul excepției', multiline: true, required: true, minLength: 10,
    confirmLabel: 'Deblochează', danger: true,
  });
  if (motiv == null) return;
  try { await setLock(null, motiv); toast('Perioade deblocate'); } catch (e) { toast(e.message, true); }
});
// ── „Luna de lucru" + filtrele de perioada → public/periods.js ──
// Mod compact (densitate) — comutator in bara, retinut in browser
function applyDensity() {
  let c = false; try { c = localStorage.getItem('contab_compact') === '1'; } catch (e) { /* ignora */ }
  document.body.classList.toggle('compact', c);
  const b = $('#densityBtn'); if (b) b.textContent = c ? '⊞ Confortabil' : '⊟ Compact';
}
$('#densityBtn') && $('#densityBtn').addEventListener('click', () => {
  const c = !document.body.classList.contains('compact');
  try { localStorage.setItem('contab_compact', c ? '1' : '0'); } catch (e) { /* ignora */ }
  applyDensity();
});
applyDensity();
// Tema clar / intunecat — comutator in bara, retinut in browser (implicit: preferinta sistemului)
function prefDark() {
  try { const s = localStorage.getItem('contab_dark'); if (s !== null) return s === '1'; } catch (e) { /* ignora */ }
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme() {
  const d = prefDark();
  document.body.classList.toggle('dark', d);
  const b = $('#themeBtn'); if (b) b.textContent = d ? '☀️ Temă' : '🌙 Temă';
}
$('#themeBtn') && $('#themeBtn').addEventListener('click', () => {
  const d = !document.body.classList.contains('dark');
  try { localStorage.setItem('contab_dark', d ? '1' : '0'); } catch (e) { /* ignora */ }
  applyTheme();
});
applyTheme();
// ── Legarea filtrelor Luna/An + popularea perioadelor → public/periods.js ──

// ───────────────────────── UPLOAD ─────────────────────────

// ── Scanare (punte locala) → public/docflow.js; captura cu camera a fost stearsa (cod inaccesibil) ──

// Comutare programatica intre tab-uri (din linkuri/scurtaturi); scrollId optional
function goTab(name, scrollId) {
  const b = navTabButton(name);
  if (b) selectNavTabButton(b);
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  if (document.activeElement) document.activeElement.blur();
  onTab(name);
  if (scrollId) {
    const el = document.getElementById(scrollId);
    if (el) { setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); return; }
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
// Hook public pentru E2E (scripts/e2e.mjs navigheaza prin goTab): modulele ES nu mai expun
// functiile global, deci navigarea programatica are nevoie de acest export explicit pe window.
window.goTab = goTab;
// La revenirea online: reincarca vederea curenta (datele vin doar de la server — nu se cacheaza).
setOnReconnect(() => { const active = activeNavTabButton(); if (active) { toast('Conexiune revenită — reîncarc datele.'); onTab(active.dataset.tab); } });
// Scurtaturi „Ce vrei sa faci?” de pe Dashboard
$$('.qa[data-go]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.go, b.dataset.scroll)));

// ───────────────────────── WIZARD „Ce vrei să înregistrezi?” ─────────────────────────
// Ghidează un ne-contabil prin întrebări simple → alege automat tipul de document potrivit.
// Tipurile de IESIRE (emise de firma) se deschid in pagina „Emite factura"; restul in „Adauga document primit"

// HARTA LUNII — o singură sursă.
//
// Aplicația descria aceeași lună în două feluri care nu se potriveau: banda de sus numea „etape"
// de navigare, iar cockpitul numește controalele efective de închidere. Consecința pentru cine
// ține luna: operațiuni obligatorii precum amortizarea, reevaluarea, TVA-ul și punctajul bancar nu apăreau în
// bandă, în timp ce jurnalul și balanța, care se CONSULTĂ, erau numerotate ca pași de executat.
// Iar „etapa 6/7" deschidea un ecran care începea de la „1/6".
//
// Acum secvența lunii e cea din `src/monthlyClose.js` (STEPS) — aceeași listă care produce
// cockpitul, termenele și temeiul legal. Lista de mai jos o oglindește (cheie + tab, în ordine);
// o poartă din suită le compară ÎN AMBELE SENSURI, ca să nu poată drifta una fără cealaltă.
const PASII_LUNII = [
  { key: 'documente', tab: 'intrate' },
  { key: 'banca', tab: 'reconciliere' },
  { key: 'amortizare_lunara', tab: 'mijloace' },
  { key: 'reevaluare_valutara', tab: 'inchideri' },
  { key: 'ajustari_inventar', tab: 'inchidere-an' },
  { key: 'tva', tab: 'tva' },
  { key: 'declaratii', tab: 'livrabile' },
  { key: 'aprobare', tab: null }, // se rezolvă în cockpit, nu pe ecran propriu
  { key: 'blocare', tab: null },
];
// Ce NU e pas al lunii, dar era numerotat ca atare: introducerea datelor (alimentează pasul 1)
// și registrele care se citesc. Le numim pe nume, în loc să le dăm un număr care minte.
const TABURI_INREGISTRARE = ['documente', 'emite'];
const TABURI_CONSULTARE = ['jurnal', 'carte', 'balanta'];

function marcheazaHartaLunii() {
  const pune = (tab, text) => {
    const b = tab && $(`#tabs button[data-tab="${tab}"]`);
    if (b) b.dataset.kicker = text;
  };
  // „pasul 3 din 6", nu „3/6": cockpitul afișează „1/6 pași" ca PROGRES (câți sunt gata), iar
  // două numere N/6 cu înțelesuri diferite pe ecrane vecine ar fi mutat confuzia, nu ar fi rezolvat-o.
  PASII_LUNII.forEach((p, i) => pune(p.tab, `Închiderea lunii · pasul ${i + 1} din ${PASII_LUNII.length}`));
  pune('inchideri', 'Închiderea lunii · toți pașii');
  TABURI_INREGISTRARE.forEach((t) => pune(t, 'Înregistrare'));
  TABURI_CONSULTARE.forEach((t) => pune(t, 'Consultare'));
}
marcheazaHartaLunii();
if (typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
  document.dispatchEvent(new CustomEvent('contab:cycle-ready'));
}

// Mesaj de bun-venit la prima logare (o data per utilizator, per browser)
function welcomeKey() { return 'contab_welcomed_' + ((USER && USER.username) || '?'); }
function maybeWelcome() {
  try { if (localStorage.getItem(welcomeKey())) return; } catch (e) { return; }
  $('#welcomeOverlay').classList.remove('hidden');
  setTimeout(() => $('#welcomeStart').focus(), 0);
}
function closeWelcome() {
  try { localStorage.setItem(welcomeKey(), '1'); } catch (e) { /* ignora */ }
  $('#welcomeOverlay').classList.add('hidden');
}
$('#welcomeStart').addEventListener('click', () => {
  closeWelcome();
  if (USER && USER.faraFirma) { goTab('acces'); return; }
  goTab('dashboard');
  // Dashboard-ul se încarcă asincron. Primul pas nefinalizat este traseul real al firmei, nu un
  // tur paralel; dacă răspunsul nu a sosit încă, alegerea ghidată rămâne fallback-ul util.
  setTimeout(() => {
    const primul = $('#primiiPasiList .fstep:not(.done)');
    if (primul) primul.click(); else { const q = $('#qaWizard'); if (q) q.click(); }
  }, 350);
});
$('#welcomeGuide').addEventListener('click', () => { closeWelcome(); goTab('ghid'); });
$('#welcomeLater').addEventListener('click', closeWelcome);
// Dialogurile de pornire țin tastatura în interiorul lor. Fără asta, Tab ajungea în meniul și
// formularele ascunse vizual sub overlay, iar utilizatorul nu mai știa unde se află focusul.
document.addEventListener('keydown', (e) => {
  const dialog = ['#welcomeOverlay', '#opWizard'].map((s) => $(s)).find((x) => x && !x.classList.contains('hidden'));
  if (!dialog) return;
  if (e.key === 'Escape' && dialog.id === 'welcomeOverlay') { e.preventDefault(); closeWelcome(); return; }
  if (e.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter((x) => x.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ───────────────────────── TUR GHIDAT (noul meniu) ─────────────────────────
const TOUR = [
  { ic: '👋', title: 'Meniul în 60 de secunde', text: 'Ai nevoie doar de traseul principal: pornești de acasă, adaugi documente, urmărești banii și rezolvi notificările.' },
  { sel: '#tabs [data-tab="dashboard"]', ic: '🏠', title: 'Acasă', text: 'Aici găsești următorul pas concret și situația firmei pe scurt.' },
  { group: 'Documente', ic: '📥', title: 'Documente', text: 'Încarci ce primești și emiți facturile tale. Aplicația construiește evidența din ele.' },
  { group: 'Bani', ic: '🏦', title: 'Bani', text: 'Urmărești încasările, plățile și potrivirea cu extrasul bancar.' },
  { sel: '#tabs [data-tab="notificari"]', ic: '🔔', title: 'Notificări', text: 'Vezi numai ce are termen sau cere atenție și mergi direct la acțiunea care rezolvă.' },
  { ic: '🎉', title: 'Gata', text: 'Restul meniului rămâne disponibil când ai nevoie de el. Poți relua turul din „Unelte”.' },
];
let tourIdx = 0;
function tourKey() { return 'contab_tour_v1_' + ((USER && USER.username) || '?'); }
function tourTargetOf(step) {
  if (step.sel) return $(step.sel);
  if (step.group) return $$('#tabs .navlabel').find((l) => l.textContent.indexOf(step.group) >= 0);
  return null;
}
function clearTourHighlight() { $$('.tour-highlight').forEach((el) => el.classList.remove('tour-highlight')); }
/**
 * Intrarile din submeniul unui grup, CITITE DIN MENIUL REAL, nu dintr-o lista scrisa de mana.
 * O lista fixa ar fi ramas in urma la prima redenumire — si chiar a ramas: turul descria „Stocuri"
 * ca pe un singur ecran mult dupa ce devenise trei, iar „Setari" ca pe unul singur cand avea noua.
 * Asa, turul e corect prin construcție, si ramane corect si la meniurile de maine.
 *
 * Se iau doar intrarile VIZIBILE pentru contul curent: cele ascunse dupa rol („Cine acceseaza
 * aplicatia" e doar pentru admin) sau de modul simplu n-au ce cauta intr-un tur care le promite.
 */
function subintrariVizibile(grupEticheta) {
  const lbl = $$('#tabs .navlabel').find((l) => l.textContent.indexOf(grupEticheta) >= 0);
  const grup = lbl && lbl.closest('.navgroup');
  if (!grup) return [];
  return $$('.navmenu button[data-tab]', grup)
    .filter((b) => !b.classList.contains('hidden') && getComputedStyle(b).display !== 'none')
    .map((b) => b.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
// Pasii CHIAR aplicabili contului curent. Intrarile ascunse dupa rol sau in modul simplu lipsesc
// din tur — un pas care descrie un meniu inexistent e o
// promisiune pe care aplicatia n-o tine, si strica si numaratoarea („pasul 4 din 13", cu pasi
// goi). Se recalculeaza la FIECARE pornire, fiindca modul si drepturile se pot schimba.
let TOUR_PASI = TOUR;
function tourAplicabil(step) {
  if (!step.sel && !step.group) return true; // introducerea si finalul n-au tinta
  const t = tourTargetOf(step);
  return !!(t && t.offsetParent !== null);
}
function showTourStep(i) {
  tourIdx = Math.max(0, Math.min(i, TOUR_PASI.length - 1));
  const step = TOUR_PASI[tourIdx];
  clearTourHighlight();
  $('#tourIc').textContent = step.ic;
  $('#tourTitle').textContent = step.title;
  $('#tourText').textContent = step.text;
  // Sub text, intrarile chiar existente din submeniul grupului. Etichetele vin din DOM-ul nostru,
  // dar trec prin H() la fel ca orice altceva: regula e dupa CONTEXTUL de iesire, nu dupa cat de
  // sigura pare sursa — asa nu trebuie sa reevaluam decizia daca maine meniul devine configurabil.
  const sub = $('#tourSub');
  if (sub) {
    const intrari = step.group ? subintrariVizibile(step.group) : [];
    sub.classList.toggle('hidden', intrari.length === 0);
    sub.innerHTML = intrari.length ? '<b>Cuprinde:</b> ' + intrari.map(H).join(' · ') : '';
  }
  $('#tourProgress').innerHTML = TOUR_PASI.map((_, k) => `<i class="${k === tourIdx ? 'on' : ''}"></i>`).join('');
  $('#tourBack').style.visibility = tourIdx === 0 ? 'hidden' : 'visible';
  $('#tourNext').textContent = tourIdx === TOUR_PASI.length - 1 ? 'Gata ✓' : 'Următorul →';
  const t = tourTargetOf(step);
  if (t) { const g = t.closest && t.closest('.navgroup'); if (g) openGroup(g); t.classList.add('tour-highlight'); try { t.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* ignora */ } }
}
function startTour() { TOUR_PASI = TOUR.filter(tourAplicabil); $('#tourCard').classList.remove('hidden'); showTourStep(0); }
function endTour() { clearTourHighlight(); $('#tourCard').classList.add('hidden'); try { localStorage.setItem(tourKey(), '1'); } catch (e) { /* ignora */ } }
$('#tourNext').addEventListener('click', () => { if (tourIdx >= TOUR_PASI.length - 1) endTour(); else showTourStep(tourIdx + 1); });
$('#tourBack').addEventListener('click', () => showTourStep(tourIdx - 1));
$('#tourSkip').addEventListener('click', endTour);
$('#tourReplay') && $('#tourReplay').addEventListener('click', startTour);
// acelasi tur, pornit si din grupul Unelte (langa comutatorul de densitate): din Ghid se ajunge
// doar daca stii ca exista, iar turul e util tocmai celui care inca NU stie unde e ce.
$('#tourBtn') && $('#tourBtn').addEventListener('click', startTour);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#tourCard').classList.contains('hidden')) endTour(); });

// Documente de IESIRE — butoane „emite” deschid formularul (in pagina Emite factura) cu tipul potrivit

// ───────────────────────── FACTURI RECURENTE ─────────────────────────

// ───────────────────────── SPV INBOX ─────────────────────────

// ── Import direct e-Factura (XML UBL) ──

// ── Galerie documente primite ──
let GALERIE_DOCS = null;
async function loadGalerie() {
  const box = $('#galerieView'); if (!box) return;
  box.innerHTML = '<p class="muted">Se încarcă…</p>';
  try { GALERIE_DOCS = await api('/api/documents/gallery'); } catch (e) { box.innerHTML = `<p class="status err">${e.message}</p>`; return; }
  renderGalerie();
}
function renderGalerie() {
  const box = $('#galerieView'); if (!box) return;
  const q = ($('#galSearch').value || '').trim().toLowerCase();
  const all = GALERIE_DOCS || [];
  const docs = all.filter((d) => !q || (d.fileName + ' ' + (d.entry ? (d.entry.partener + ' ' + d.entry.tipNume + ' ' + d.entry.document) : '')).toLowerCase().includes(q));
  $('#galCount').textContent = docs.length + (docs.length === 1 ? ' document' : ' documente');
  if (!all.length) { box.innerHTML = '<p class="muted">Niciun document încărcat încă. Adaugă unul din <b>„➕ Adaugă document primit"</b>.</p>'; return; }
  if (!docs.length) { box.innerHTML = '<p class="muted">Niciun document nu corespunde căutării.</p>'; return; }
  box.innerHTML = docs.map((d) => {
    const src = '/api/document/' + d.id + '/file';
    const ext = (d.fileName.split('.').pop() || '').toUpperCase();
    const preview = d.type === 'image'
      ? `<img src="${src}" loading="lazy" alt="${escAttr(d.fileName)}">`
      : d.type === 'pdf'
        ? `<embed src="${src}#toolbar=0&navpanes=0&view=FitH" type="application/pdf">`
        : `<div class="doc-noimg">📄<span>${ext || 'FIȘIER'}</span></div>`;
    const sub = d.entry
      ? `${d.entry.data} · ${escMsg(d.entry.partener || d.entry.tipNume || '')}`
      : '<span class="muted">neasociat unui articol</span>';
    return `<a class="doc-card" href="${src}" target="_blank" rel="noopener" title="${escAttr(d.fileName)}">
      <div class="doc-thumb">${preview}<span class="doc-ext">${ext}</span></div>
      <div class="doc-meta"><b>${escMsg(d.fileName)}</b><span>${sub}</span></div>
    </a>`;
  }).join('');
}
$('#galSearch') && $('#galSearch').addEventListener('input', renderGalerie);

// ── Abonament (planuri + trial) ──
$('#subToMsg') && $('#subToMsg').addEventListener('click', () => goTab('mesaje'));
async function loadSubscription() {
  const statusBox = $('#subStatus'); const plansBox = $('#subPlans');
  if (!statusBox || !plansBox) return;
  renderFirmeBilling();
  let data; try { data = await api('/api/subscription'); } catch (e) { statusBox.innerHTML = `<p class="status err">${e.message}</p>`; return; }
  renderSubscription(data);
}
// Billing per-firma: tabelul cu starea abonamentului fiecarei firme + abonare directa.
async function renderFirmeBilling() {
  const box = $('#firmeBilling'); if (!box) return;
  let data; try { data = await api('/api/firme'); } catch (e) { box.innerHTML = ''; return; }
  const stLabel = (s) => {
    const pend = s.pending ? ' <span class="pill" data-u="u11" title="Ai inițiat plata — se activează după confirmarea Stripe">⏳ plată în așteptare</span>' : '';
    if (s.status === 'trial') return `<span class="pill" data-u="u10">🎁 probă · ${s.zileRamase} ${s.zileRamase === 1 ? 'zi' : 'zile'}</span>${pend}`;
    if (s.status === 'active') return `<span class="pill" data-u="u10">✓ activ${s.plan && s.plan !== 'grandfathered' ? ' · ' + (s.plan === 'pro' ? 'Pro' : 'Start') : ''}</span>`;
    if (s.status === 'expired') return `<span class="pill warn">probă expirată${s.trialCount ? ' · ' + s.trialCount + '/' + s.trialMax : ''}</span>${pend}`;
    return `<span class="pill warn">fără abonament</span>${pend}`;
  };
  box.innerHTML = `<table><thead><tr><th>Firmă</th><th>Stare abonament</th><th></th></tr></thead><tbody>${
    data.firme.map((f) => { const s = f._sub || {}; const needs = s.status === 'expired' || s.status === 'none';
      return `<tr><td>${H(f.nume)}${f.cui ? ' <span class="muted">(' + H(f.cui) + ')</span>' : ''}</td>
        <td>${stLabel(s)}</td>
        <td>${needs ? `${s.maiPoateProba ? `<button class="linkbtn fbtrial" data-id="${f.id}" data-nume="${H(f.nume)}">încă o lună de probă</button> · ` : ''}<button class="linkbtn fbsub" data-id="${f.id}" data-nume="${H(f.nume)}" data-u="u12">abonează-te →</button>` : (s.status === 'trial' ? `<button class="linkbtn fbsub" data-id="${f.id}" data-nume="${H(f.nume)}">abonează firma acum</button>` : '')}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="muted" data-u="u24">Firma activă acum: <b>${H((data.firme.find((f) => f.id === data.firmaActiva) || {}).nume || '—')}</b>. Abonarea deschide plata (Stripe) pentru planul potrivit tipului tău.</p>`;
  $$('#firmeBilling .fbsub').forEach((b) => b.addEventListener('click', () => promptFirmaSubscribe(Number(b.dataset.id), b.dataset.nume)));
  // A doua (si ultima) perioada de proba — ceruta explicit, cu mesaj catre utilizator.
  $$('#firmeBilling .fbtrial').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api('/api/firme/' + b.dataset.id + '/trial', { method: 'POST' });
      const ultima = r.trialCount >= (r.sub && r.sub.trialMax);
      toast('Ai încă o lună de probă gratuită pentru ' + r.nume + ' — până pe '
        + String((r.sub || {}).trialEndsAt || '').slice(0, 10)
        + (ultima ? '. Este ultima: după ea alegi un plan ca să continui.' : '.'));
      setMeta(await api('/api/meta'));
      renderFirmeBilling(); loadSubscription();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}
function renderSubscription(data) {
  const c = data.current || {}; const plans = data.plans || [];
  const nameOf = (id) => (plans.find((p) => p.id === id) || {}).nume || id;
  const subscriptionNotice = (tone, icon, content) =>
    `<div class="notice ${tone}"><span class="notice-icon">${icon}</span><div>${content}</div></div>`;
  // banner de stare
  let banner = '';
  if (c.status === 'trial') banner = subscriptionNotice('success', '✓', `<b>Perioadă de probă activă</b> — îți mai rămân <b>${c.zileRamase}</b> ${c.zileRamase === 1 ? 'zi' : 'zile'}. Alege un plan pentru a continua după probă.`);
  else if (c.status === 'active') banner = subscriptionNotice('success', '✓', `<b>Abonament activ: ${nameOf(c.plan)}</b>${c.since ? ' · din ' + c.since.slice(0, 10) : ''}.`);
  else if (c.status === 'expired') banner = subscriptionNotice('warning', '⚠', '<b>Perioada de probă a expirat.</b> Alege un plan pentru a continua.');
  else banner = subscriptionNotice('info', 'ℹ', '<b>Niciun abonament activ.</b> Începe cu proba gratuită de 30 zile.');
  // Accesul il da abonamentul FIRMEI, nu al contului: bannerul trebuie sa spuna ce se intampla cu
  // ea. Altfel invita la „proba gratuită de 30 zile" exact sub cardul care anunta ca sunt consumate.
  const f = data.firma;
  if (f) {
    if (f.status === 'trial') banner = subscriptionNotice('success', '✓', `<b>${H(data.firmaNume || 'Firma activă')}: probă activă</b> — încă <b>${f.zileRamase}</b> ${f.zileRamase === 1 ? 'zi' : 'zile'}${f.trialCount ? ` (proba ${f.trialCount} din ${f.trialMax})` : ''}.`);
    else if (f.status === 'active') banner = subscriptionNotice('success', '✓', `<b>${H(data.firmaNume || 'Firma activă')}: abonament activ</b>${f.plan && f.plan !== 'grandfathered' ? ' · ' + (f.plan === 'pro' ? 'Pro' : 'Start') : ''}.`);
    else if (f.maiPoateProba) banner = subscriptionNotice('warning', '⚠', `<b>${H(data.firmaNume || 'Firma activă')}: perioada de probă a expirat.</b> Alege un plan — sau mai iei o lună gratuită (ultima).`);
    else banner = subscriptionNotice('warning', '⚠', `<b>${H(data.firmaNume || 'Firma activă')}: cele ${f.trialMax} perioade de probă s-au terminat.</b> Alege un plan ca să continui.`);
  }
  if (c.requestedPlan && c.status !== 'active') banner += subscriptionNotice('info', '⏳', `Ai solicitat planul <b>${nameOf(c.requestedPlan)}</b> — în așteptarea activării (după confirmarea plății).`);
  if (c.status === 'active' && data.manageable) banner += `<div data-u="u23"><button id="subPortal" class="btn">Gestionează / anulează abonamentul</button></div>`;
  if (c.status === 'canceled') banner = subscriptionNotice('warning', '⚠', '<b>Abonament anulat.</b> Alege din nou un plan pentru a reactiva.') + banner;
  $('#subStatus').innerHTML = banner;
  const pb = $('#subPortal');
  if (pb) pb.addEventListener('click', async () => {
    pb.disabled = true;
    try { const r = await api('/api/subscription/portal', { method: 'POST' }); window.location.href = r.url; }
    catch (e) { toast(e.message, true); pb.disabled = false; }
  });

  $('#subPlans').innerHTML = plans.map((p) => {
    const isCurrent = (c.status === 'active' && c.plan === p.id) || (p.trial && c.status === 'trial');
    let action;
    if (p.trial) {
      // Cardul de proba urmareste FIRMA activa (ea expira si blocheaza aplicatia), nu contul.
      // Dupa ce firma si-a consumat toate perioadele, cardul RAMANE vizibil dar inactiv, cu
      // numarul folosit: o optiune care dispare fara explicatie pare o functie pierduta.
      const fs2 = data.firma || {};
      if (fs2.status === 'trial') action = `<button class="btn" disabled>Probă în curs · ${fs2.zileRamase} ${fs2.zileRamase === 1 ? 'zi' : 'zile'}</button>`;
      else if (fs2.maiPoateProba) action = `<button class="btn primary firma-trial">Mai vreau o lună de probă</button>`;
      else if (fs2.trialCount) action = `<button class="btn" disabled title="Fiecare firmă are dreptul la ${fs2.trialMax} perioade de probă.">Probă folosită (${fs2.trialCount}/${fs2.trialMax})</button>`;
      else action = c.trialUsed
        ? `<button class="btn" disabled>${c.status === 'trial' ? 'Probă în curs' : 'Probă folosită'}</button>`
        : `<button class="btn primary sub-trial">Începe proba gratuită</button>`;
    } else if (isCurrent) {
      action = `<button class="btn" disabled>Planul tău</button>`;
    } else if (data.platiSuspendate) {
      // Incasarea e oprita pana cand furnizorul isi publica datele de identificare (vezi
      // PLATI_SUSPENDATE din src/plans.js). Cardul RAMANE vizibil, cu motivul la vedere: un plan
      // care dispare fara explicatie pare o functie pierduta, iar serverul oricum ar refuza cu 503.
      action = `<button class="btn" disabled title="${H(data.motivPlatiSuspendate || '')}">Indisponibil momentan</button>`;
    } else if (c.requestedPlan === p.id && !data.stripeEnabled) {
      action = `<button class="btn" disabled>În așteptare activare</button>`;
    } else {
      const label = data.stripeEnabled ? ('Abonează-te') : ('Alege ' + p.nume);
      action = `<button class="btn primary sub-select" data-plan="${p.id}">${label}</button>`;
    }
    return `<div class="plan-card${p.recomandat ? ' recomandat' : ''}${isCurrent ? ' current' : ''}">
      ${p.recomandat ? '<div class="plan-badge">Recomandat</div>' : ''}
      <h3>${H(p.nume)}</h3>
      <div class="plan-price">${p.pret === 0 ? 'Gratuit' : '<b>' + H(p.pret) + '</b> <span>' + H(p.moneda + '/' + p.perioada) + '</span>'}</div>
      <p class="plan-desc">${H(p.descriere || '')}</p>
      <ul class="plan-feat">${(p.features || []).map((f) => `<li>${f}</li>`).join('')}</ul>
      <div class="plan-action">${action}</div>
    </div>`;
  }).join('');

  // „Mai vreau o lună de probă" — pe FIRMA activa
  const ft = $('#subPlans .firma-trial');
  if (ft) ft.addEventListener('click', async () => {
    ft.disabled = true;
    try {
      const r = await api('/api/firme/' + (data.firma && data.firma.firmaId || META.firmaActiva) + '/trial', { method: 'POST' });
      const ultima = r.trialCount >= (r.sub && r.sub.trialMax);
      toast('Ai încă o lună de probă gratuită pentru ' + r.nume + ' — până pe '
        + String((r.sub || {}).trialEndsAt || '').slice(0, 10)
        + (ultima ? '. Este ultima: după ea alegi un plan ca să continui.' : '.'));
      setMeta(await api('/api/meta'));
      loadSubscription();
    } catch (e) { toast(e.message, true); ft.disabled = false; }
  });
  const tb = $('#subPlans .sub-trial');
  if (tb) tb.addEventListener('click', async () => {
    tb.disabled = true;
    try { const r = await api('/api/subscription/trial', { method: 'POST' }); toast('Perioadă de probă activată — 30 zile!'); renderSubscription(Object.assign({}, data, { current: r.current })); }
    catch (e) { toast(e.message, true); tb.disabled = false; }
  });
  $$('#subPlans .sub-select').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (data.stripeEnabled) {
        const r = await api('/api/subscription/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: b.dataset.plan }) });
        window.location.href = r.url; // redirect către Stripe Checkout (pagină securizată de plată)
        return;
      }
      const r = await api('/api/subscription/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: b.dataset.plan }) });
      toast('Plan solicitat — te contactăm pentru activare.'); renderSubscription(Object.assign({}, data, { current: r.current }));
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}

// ── Galerie documente emise (facturi către clienți, ca PDF) ──
let GALERIE_EMISE = null;
async function loadGalerieEmise() {
  const box = $('#galerieEmiseView'); if (!box) return;
  box.innerHTML = '<p class="muted">Se încarcă…</p>';
  try { GALERIE_EMISE = await api('/api/documents/emitted'); } catch (e) { box.innerHTML = `<p class="status err">${e.message}</p>`; return; }
  renderGalerieEmise();
}
function renderGalerieEmise() {
  const box = $('#galerieEmiseView'); if (!box) return;
  const q = ($('#geSearch').value || '').trim().toLowerCase();
  const all = GALERIE_EMISE || [];
  const docs = all.filter((d) => !q || (d.partener + ' ' + d.document + ' ' + d.tipNume).toLowerCase().includes(q));
  $('#geCount').textContent = docs.length + (docs.length === 1 ? ' factură' : ' facturi');
  if (!all.length) { box.innerHTML = '<p class="muted">Nicio factură emisă încă. Emite una din <b>„🧾 Emite factură"</b>.</p>'; return; }
  if (!docs.length) { box.innerHTML = '<p class="muted">Niciun document nu corespunde căutării.</p>'; return; }
  box.innerHTML = docs.map((d) => {
    const src = '/pdf/factura/' + d.id;
    const ef = d.eFactura ? ` · <a href="/xml/efactura/${d.id}" target="_blank" rel="noopener">e-Factura</a>` : '';
    return `<div class="doc-card">
      <a class="doc-thumb-link" href="${src}" target="_blank" rel="noopener" title="Deschide factura ${escAttr(d.document || '')}">
        <div class="doc-thumb"><embed src="${src}#toolbar=0&navpanes=0&view=FitH" type="application/pdf"><span class="doc-ext">PDF</span></div>
      </a>
      <div class="doc-meta"><b>${escMsg(d.document || d.tipNume)}</b><span>${d.data} · ${escMsg(d.partener || '')} · <b>${fmt(d.total)}</b> lei${ef}</span></div>
    </div>`;
  }).join('');
}
$('#geSearch') && $('#geSearch').addEventListener('input', renderGalerieEmise);

// Formularul de inregistrare e UNIC (id-uri unice in pagina), dar e folosit de doua pagini:
// „Adauga document primit" si „Emite factura". Se muta in gazda paginii care il deschide.


// ── Editor „descărcare din stoc"; COGS la metoda firmei, calculat de server ──


// ───────────────────────── ENTRIES LIST ─────────────────────────
// Clasifica o inregistrare: intrare (cumparare), iesire (vanzare) sau alta operatiune interna

// Documente așteptate / lipsă — detectează furnizorii recurenți care lipsesc în luna selectată

// ───────────────────────── ARHIVĂ DOCUMENTE ─────────────────────────

// ── Rapoarte contabile (jurnal, cartea mare, banca/casa, balanta, TVA, inchideri, situatii) → public/rapoarte.js ──
// ── Livrabile, registrul depunerilor, fisa rol, portofoliu, notificari, reconciliere, scadentar → public/livrabile.js ──
// ───────────────────────── PARTENERI ─────────────────────────
// ── Nomenclator parteneri (clienti/furnizori) → public/partners.js ──
// Șabloane email pentru clienți (solicitare lunară / reminder scurt)
const EMAIL_TPL = {
  full: ($('#emailTemplate') && $('#emailTemplate').defaultValue) || '',
  reminder: `Subiect: Reminder — documente contabile (termen: data de 5)

Bună ziua, [Nume client],

Vă reamintim că termenul pentru documentele lunii [luna] este [data de 5].

Vă rugăm să ne trimiteți, dacă nu ați făcut-o deja:
- facturile de cumpărare și vânzare
- extrasele bancare ale lunii
- documentele de casă (chitanțe / bonuri)
- (dacă e cazul) statele de plată

Le puteți trimite scanate sau fotografiate pe [email / aplicație].

Vă mulțumim!
[Nume]`,
};
let emailTpl = 'full';
function setEmailTpl(which) {
  emailTpl = which;
  if ($('#emailTemplate')) $('#emailTemplate').value = EMAIL_TPL[which] || '';
  $$('.emltpl').forEach((b) => b.classList.toggle('active', b.dataset.tpl === which));
}
$$('.emltpl').forEach((b) => b.addEventListener('click', () => setEmailTpl(b.dataset.tpl)));
$('#emailCopyBtn') && $('#emailCopyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#emailTemplate').value); toast('Șablon copiat — lipește-l în email'); }
  catch (e) { toast('Nu s-a putut copia', true); }
});
$('#emailResetBtn') && $('#emailResetBtn').addEventListener('click', () => { setEmailTpl(emailTpl); toast('Șablon resetat'); });

// ── Mijloace fixe → public/mijloace.js ──
// ── Salarizare → public/salarizare.js ──
// ── Stocuri & gestiune → public/stocuri.js ──
// ───────────────────────── ANAF / SPV ─────────────────────────
async function renderAnaf() {
  let c;
  try { c = await api('/api/anaf/config'); } catch (e) { return; }
  const f = $('#anafForm');
  f.env.value = c.env || 'test'; f.cif.value = c.cif || ''; f.redirectUri.value = c.redirectUri || '';
  f.autoPoll.checked = !!c.autoPoll;
  const st = $('#anafStatus');
  const cine = c.firma ? ' — firma ' + c.firma : '';
  if (c.connected) { st.className = 'status ok'; st.textContent = '✔ Conectat la SPV (' + c.env + ')' + cine + '.'; }
  else if (c.configured) { st.className = 'status'; st.textContent = 'Configurat' + cine + ' — apasă „Conectează” pentru autorizare.'; }
  else { st.className = 'status'; st.textContent = 'Necompletat' + cine + ' — introdu client_id, client_secret și redirect_uri.'; }
}
$('#anafForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { env: f.env.value, cif: f.cif.value, redirectUri: f.redirectUri.value, autoPoll: f.autoPoll.checked };
  if (f.clientSecret.value) body.clientSecret = f.clientSecret.value;
  if (f.clientId.value) body.clientId = f.clientId.value;
  await api('/api/anaf/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  toast('Setări SPV salvate'); renderAnaf();
});
$('#anafConnect').addEventListener('click', async () => {
  try { const r = await api('/api/anaf/authorize'); window.open(r.url, '_blank'); toast('Autorizează cu certificatul în fereastra ANAF'); }
  catch (e) { toast(e.message, true); }
});
$('#anafPoll').addEventListener('click', async () => {
  try { const r = await api('/api/anaf/poll', { method: 'POST' }); toast(r.connected ? ('Verificate ' + r.checked + ', acceptate ' + r.accepted + ', recipise ' + r.downloaded) : 'Neconectat la SPV', !r.connected); loadEntries(); }
  catch (e) { toast(e.message, true); }
});

// ── Planul de conturi + solduri initiale (afisare, import CSV) → public/plan.js ──
// ───────────────────────── SETTINGS / SEED ─────────────────────────
function campuriFirmaBazaLipsa(form) {
  const campuri = [
    ['cui', 'CUI-ul'], ['nume', 'denumirea'], ['caen', 'codul CAEN'], ['adresa', 'adresa'],
    ['oras', 'orașul'], ['judet', 'județul'],
  ];
  if (firmaPlatitoareTva(form)) campuri.push(['perioadaTva', 'perioada TVA']);
  return campuri.filter(([name]) => !String((form.elements[name] || {}).value || '').trim());
}

$('#companyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const quick = !!(e.submitter && e.submitter.id === 'companyQuickSave');
  const quickStatus = $('#companyQuickStatus');
  if (quick) {
    const lipsa = campuriFirmaBazaLipsa(f);
    if (lipsa.length) {
      if (quickStatus) {
        quickStatus.className = 'status err';
        quickStatus.textContent = 'Mai completează: ' + lipsa.map((x) => x[1]).join(', ') + '.';
      }
      const primul = f.elements[lipsa[0][0]];
      if (primul) { primul.focus(); primul.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return;
    }
    if (quickStatus) { quickStatus.className = 'muted'; quickStatus.textContent = 'Se salvează…'; }
  }
  const body = { nume: f.nume.value, cui: f.cui.value, regCom: f.regCom.value, adresa: f.adresa.value, oras: f.oras.value, judet: f.judet.value, tvaPlatitor: firmaPlatitoareTva(f), tvaLaIncasare: f.tvaLaIncasare.checked, tvaArt317: f.tvaArt317 ? f.tvaArt317.checked : false,
    tvaCodAnulat: f.tvaCodAnulat ? f.tvaCodAnulat.checked : false,
    dataAnulareTva: f.dataAnulareTva ? f.dataAnulareTva.value : '',
    motivAnulareTva: f.motivAnulareTva ? f.motivAnulareTva.value : 'oficiu',
    dataReinregistrareTva: f.dataReinregistrareTva ? f.dataReinregistrareTva.value : '', tipEntitate: f.tipEntitate.value,
    iban: f.iban.value.trim(), banca: f.banca.value.trim(), telefon: f.telefon.value.trim(), email: f.email.value.trim(), capitalSocial: f.capitalSocial.value.trim(), accentColor: f.accentColor.value, pdfLayout: f.pdfLayout.value, pdfFooter: f.pdfFooter.value.trim(), asociatiText: f.asociatiText.value.trim(), proRataTva: f.proRataTva.value ? Number(f.proRataTva.value) : '', caen: f.caen.value.trim(), perioadaTva: f.perioadaTva.value };
  // profil fiscal (motor): regim, cadenta D406, Intrastat, scutiri
  body.regimImpozit = f.regimImpozit ? f.regimImpozit.value : 'micro';
  body.d406Cadenta = f.d406Cadenta ? f.d406Cadenta.value : '';
  body.intrastatObligat = f.intrastatObligat ? f.intrastatObligat.checked : false;
  body.controlDublu = f.controlDublu ? f.controlDublu.checked : false;
  body.metodaEvaluareStoc = f.metodaEvaluareStoc ? f.metodaEvaluareStoc.value : 'cmp';
  // Sistemul art. 41 + intrarile platii anticipate. Hartile pe ani se COMPLETEAZA, nu se
  // inlocuiesc: un an sters din greseala ar face imposibila recalcularea unei declaratii vechi.
  body.sistemProfit = f.sistemProfit ? f.sistemProfit.value : 'trimestrial';
  body.anticipatProfitContabil = f.anticipatProfitContabil ? f.anticipatProfitContabil.checked : false;
  {
    const an = new Date().getFullYear();
    const imp = Object.assign({}, META.company.impozitProfitAn || {});
    const ipc = Object.assign({}, META.company.ipcAnticipate || {});
    // Camp golit = stergerea valorii pentru anul acela. „Gol" si „0 tastat" nu sunt acelasi lucru:
    // un 0 real inseamna „nu am datorat impozit", iar asta schimba formula (art. 41 alin. 7).
    const vImp = f.impozitProfitAnPrec ? String(f.impozitProfitAnPrec.value).trim() : '';
    const vIpc = f.ipcAnPrec ? String(f.ipcAnPrec.value).trim() : '';
    if (vImp === '') delete imp[an - 1]; else imp[an - 1] = Number(vImp);
    if (vIpc === '') delete ipc[an]; else ipc[an] = Number(vIpc);
    body.impozitProfitAn = imp;
    body.ipcAnticipate = ipc;
  }
  body.scutiri = {};
  document.querySelectorAll('#scutiriBox [data-scutire]').forEach((c) => { if (c.checked) body.scutiri[c.dataset.scutire] = true; });
  // antetul situatiilor financiare anuale (bilant)
  BILANT_FIELDS.forEach((k) => { if (f[k]) body[k] = String(f[k].value || '').trim(); });
  // Formularul nou declara explicit ca aceste valori intra in vigoare AZI. Clientii API vechi,
  // care nu trimit data, pastreaza comportamentul retroactiv pentru compatibilitate.
  body.fiscalValidFrom = new Date().toISOString().slice(0, 10);
  const r = await api('/api/company', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  META.company = r.company || body;
  refreshFiscalProfile(); // recalculeaza rezumatul profilului — inaintea DOM-ului care ar putea arunca
  renderFiscalHistory();
  refreshBalanceCategory();
  renderBalanceCategoryHistory();
  // Numele firmei are o singură reprezentare în shell: selectorul persistent. Actualizează-l
  // imediat după salvare, nu abia la următorul init/reload.
  const firmaDinLista = (META.firme || []).find((firma) => String(firma.id) === String(META.firmaActiva));
  if (firmaDinLista) Object.assign(firmaDinLista, { nume: body.nume, cui: body.cui });
  fillFirmaSelect();
  formFlowSaved(f);
  window.dispatchEvent(new CustomEvent('contab:company-saved'));
  toast('Date firmă salvate' + (body.tvaLaIncasare ? ' · regim TVA la încasare ACTIV' : ''));
  if (quick) {
    if (quickStatus) { quickStatus.className = 'status ok'; quickStatus.textContent = 'Configurarea de bază este salvată.'; }
    goTab('dashboard');
  }
});
$('#seedBtn').addEventListener('click', async () => {
  $('#seedStatus').textContent = 'Se încarcă…';
  try { const r = await api('/api/seed', { method: 'POST' }); $('#seedStatus').textContent = r.message; setMeta(await api('/api/meta')); fillPeriods(); loadEntries(); toast('Exemplu încărcat'); }
  catch (e) { $('#seedStatus').textContent = e.message; }
});

if (/[?&]anaf=ok/.test(location.search)) toast('Conectat la SPV ANAF');
if (/[?&]anaf=error/.test(location.search)) toast('Autorizarea ANAF a eșuat', true);

// Acceptarea unei invitatii: ?invite=TOKEN -> formular de setare parola in overlay

// Pornirea aplicatiei: fluxurile de invitatie/resetare (authui) au prioritate; altfel init().
if (!bootAuth()) init().catch((e) => toast(e.message, true));

// Exportate pentru testele unitare de frontend (eticheta de abonament): test/frontend.mjs
export { subTag };
