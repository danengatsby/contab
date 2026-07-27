'use strict';
import { $, $$, H, fmt, accName, toast, setLoad, api, META, USER, setMeta, setUser, setOn402, setOnReconnect, escMsg, escAttr, isDemo, fileToCsv, round2, applyFiscalDefaults, fiscalText } from './core.js';
import { loadMessages, startMsgPolling, setMsgBadge, setLastUnread } from './messages.js';
import { setBankRefresh } from './bank.js';
import { render2FA, renderBackup, renderProfile, renderSessions, renderSmtp, renderFiscal, setSettingsDeps } from './settings.js';
import { renderFirme, renderUsers, renderColaboratori, renderAudit, setAdminDeps } from './admin.js';
import { loadDashboard, renderBudget, setDashboardDeps } from './dashboard.js';
import { initUiMode } from './simplemode.js';
import { loadPartners } from './partners.js';
import './viewer.js'; // vizualizatorul de documente (PDF/CSV/XML/e-Factura) — se activeaza prin efect secundar
import './etransport.js'; // formularul ghidat e-Transport (cod UIT) — se activeaza prin efect secundar
import { pget, workMonth, setWorkMonth, lunaLabel, applyWorkMonth, onPeriodChange, fillPeriods, setPeriodsDeps } from './periods.js';
import { loadJournal, loadLedger, loadCashbook, loadBalance, loadVat, loadClosings, loadStatements, loadStorno } from './rapoarte.js';
import { loadLivrabile, loadPortfolio, loadNotifications, loadReconcile, loadAnalytic, refreshNotifBadge } from './livrabile.js';
import { loadAssets } from './mijloace.js';
import { loadMonthlyClose, setInchidereDeps } from './inchidere.js';
import { loadSalarizare } from './salarizare.js';
import { loadStocks } from './stocuri.js';
import { renderPlan, renderOpening } from './plan.js';
import { setAuthuiDeps, bootAuth, showLogin, hideLogin, showForcePw, handleRegisterLink, openRegisterPanel } from './authui.js';
import { setDocflowDeps, fillTipSelect, renderRecurring } from './docflow.js';
import { setEntriesDeps, loadEntries, renderEntryLists, loadMissingDocs, loadArhiva } from './entries.js';
setAuthuiDeps({ init, goTab, promptFirmaSubscribe });
setDocflowDeps({ goTab });
setEntriesDeps({ goTab });

setPeriodsDeps({ renderEntryLists, onTab }); // functiile sunt declarate mai jos (hoisting)


// CURRENT + fluxul documentelor -> public/docflow.js

// EFACT/SENDABLE + listele -> public/entries.js
// autentificarea UI -> public/authui.js
let firmaSubPromptOpen = false;
async function promptFirmaSubscribe(firmaId, firmaNume) {
  if (firmaSubPromptOpen || !firmaId) return;
  firmaSubPromptOpen = true;
  const contabil = USER && USER.tip === 'contabil';
  const planNume = contabil ? 'Pro' : 'Start';
  const da = confirm('Abonezi firma „' + (firmaNume || '') + '"?\n\n'
    + 'Fiecare firmă are propriul abonament (' + planNume + ' pentru ' + (contabil ? 'contabili' : 'necontabili') + '). '
    + 'Se deschide plata online — datele firmei rămân intacte.');
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


// ───────────────────────── TABS (sidebar, acordeon) ─────────────────────────
// Secțiuni colapsabile: clic pe antet deschide secțiunea (și le închide pe celelalte = un singur grup deschis).
function closeMenus(except) {
  $$('#tabs .navgroup.open').forEach((g) => { if (g === except) return; g.classList.remove('open'); const l = g.querySelector('.navlabel'); if (l) l.setAttribute('aria-expanded', 'false'); });
}
function openGroup(g) {
  if (!g) return;
  closeMenus(g);
  g.classList.add('open');
  const l = g.querySelector('.navlabel'); if (l) l.setAttribute('aria-expanded', 'true');
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
openGroup($$('#tabs .navgroup')[0]); // deschide prima secțiune (Documente) la pornire

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !b.dataset.tab) return; // ignora etichetele de grup
  $$('#tabs button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $$('#tabs .navlabel').forEach((l) => l.classList.remove('active'));
  const grp = b.closest('.navgroup');
  if (grp) { openGroup(grp); grp.querySelector('.navlabel').classList.add('active'); }
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
});
function onTab(t) {
  if (t === 'dashboard') loadDashboard();
  if (t === 'documente' || t === 'intrate' || t === 'iesite') loadEntries();
  if (t === 'emite') renderRecurring();
  if (t === 'intrate') loadMissingDocs();
  if (t === 'jurnal') loadJournal();
  if (t === 'carte') loadLedger();
  if (t === 'cashbook') loadCashbook();
  if (t === 'balanta') loadBalance();
  if (t === 'storno') loadStorno();
  if (t === 'tva') loadVat();
  if (t === 'inchideri') { loadClosings(); loadMonthlyClose(); }
  if (t === 'situatii') loadStatements();
  if (t === 'livrabile') loadLivrabile();
  if (t === 'portofoliu') loadPortfolio();
  if (t === 'notificari') loadNotifications();
  if (t === 'reconciliere') loadReconcile();
  if (t === 'analitic') loadAnalytic();
  if (t === 'mijloace') loadAssets();
  if (t === 'salarizare') loadSalarizare();
  if (t === 'stocuri') loadStocks();
  if (t === 'parteneri') loadPartners();
  if (t === 'setari') { renderAnaf(); renderFirme(); renderColaboratori(); renderUsers(); render2FA(); renderSmtp(); renderFiscal(); renderBackup(); renderProfile(); renderSessions(); renderLock(); renderOpening(); }
  if (t === 'audit') renderAudit();
  if (t === 'arhiva') loadArhiva();
  if (t === 'plan') renderPlan();
  if (t === 'galerie') loadGalerie();
  if (t === 'galerie-emise') loadGalerieEmise();
  if (t === 'abonament') loadSubscription();
  if (t === 'ghid') renderGhid();
  if (t === 'mesaje') loadMessages();
  updateBottomNav(t);
}
// Mobil: bara de jos + panou „Mai mult"
function updateBottomNav(t) {
  $$('#bottomnav button[data-tabs]').forEach((b) => b.classList.toggle('active', (b.dataset.tabs || '').split(',').includes(t)));
}
function closeMore() { const s = $('#moreSheet'); if (s) s.classList.add('hidden'); }
$$('#bottomnav button[data-go]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.go)));
$('#moreBtn') && $('#moreBtn').addEventListener('click', () => $('#moreSheet').classList.remove('hidden'));
$('#moreClose') && $('#moreClose').addEventListener('click', closeMore);
$('#moreSheet') && $('#moreSheet').addEventListener('click', (e) => { if (e.target.id === 'moreSheet') closeMore(); });
$('#moreClose') && $('#moreClose').addEventListener('click', closeMore);
$$('#moreSheet button[data-go]').forEach((b) => b.addEventListener('click', () => { goTab(b.dataset.go); closeMore(); }));
// ───────────────────────── FIRME (multi-firma) ─────────────────────────
// Eticheta de abonament din selectorul de firme: proba (cu zilele ramase), expirata, fara
// abonament, sau nimic pentru un abonament activ. Scoasa la nivel de modul ca sa fie testabila —
// e primul lucru pe care il vede utilizatorul despre starea platii firmei.
const subTag = (f) => { const s = (f || {})._sub || {}; return s.status === 'trial' ? ' 🎁 probă ' + s.zileRamase + 'z' : s.status === 'expired' ? ' 🎁 expirată' : s.status === 'none' ? ' ⚠ fără abonament' : ''; };
function fillFirmaSelect() {
  const sel = $('#firmaSelect');
  const opts = (META.firme || []).map((f) => `<option value="${f.id}" ${f.id === META.firmaActiva ? 'selected' : ''}>${H(f.nume)}${f.cui ? ' (' + H(f.cui) + ')' : ''}${subTag(f)}</option>`).join('');
  // optiune de adaugare direct din selector (discoverability) — duce la Setari -> Firmele mele.
  // Contul demo nu adauga/gestioneaza firme (lucreaza doar pe firma demo, resetata periodic).
  sel.innerHTML = opts + (isDemo() ? '' : '<option value="__add__">＋ Adaugă / gestionează firme…</option>');
  // Portofoliul are sens doar cu mai multe firme in administrare
  const np = $('#navPortofoliu'); if (np) np.classList.toggle('hidden', (META.firme || []).length < 2);
}
$('#firmaSelect').addEventListener('change', async (e) => {
  if (e.target.value === '__add__') { // nu e o firma — deschide gestionarea firmelor
    e.target.value = String(META.firmaActiva || '');
    goTab('setari');
    setTimeout(() => { const c = $('#firmaNewForm'); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.nume.focus(); } }, 150);
    return;
  }
  await api('/api/firme/' + e.target.value + '/activate', { method: 'POST' });
  await init();
  const active = $('#tabs button[data-tab].active'); onTab(active ? active.dataset.tab : 'dashboard');
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
  if (u && u.impersonating) {
    $('#imperName').textContent = u.username;
    banner.classList.remove('hidden');
    document.body.classList.add('impersonating');
  } else {
    banner.classList.add('hidden');
    document.body.classList.remove('impersonating');
  }
  setMsgBadge((u && u.unreadMessages) || 0);
  setLastUnread((u && u.unreadMessages) || 0);
}
async function impersonate(userId) {
  try {
    await api('/api/impersonate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
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
  $$('.card h2, .card h3, section .toolbar h2').forEach((h) => {
    if (h.querySelector('.cinfo')) return;
    const key = norm(h.textContent);
    const hit = dict.find(([t]) => key.startsWith(t));
    if (!hit) return;
    const i = document.createElement('span');
    i.className = 'cinfo'; i.tabIndex = 0; i.textContent = 'i';
    i.setAttribute('role', 'note'); i.setAttribute('aria-label', hit[1]);
    const pop = document.createElement('span');
    pop.className = 'cpop'; pop.textContent = hit[1];
    i.appendChild(pop);
    h.appendChild(i);
  });
}

async function init() {
  try {
    setMeta(await api('/api/meta'));
  } catch (e) {
    if (e.status === 401) { showLogin(); handleCheckoutReturn(); handleRegisterLink(); return; }
    // Cont cu parola implicita: serverul blocheaza pana la schimbare (inclusiv /api/meta).
    if (e.status === 403 && e.data && e.data.mustChange) { showForcePw(); return; }
    throw e;
  }
  hideLogin();
  applyFiscalDefaults(); // cotele implicite din formulare vin din META.fiscal, nu din HTML
  setUser(META.user || {});
  // Plasa de siguranta (daca meta ar fi permisa candva): acelasi ecran de schimbare fortata.
  if (USER.mustChange) { showForcePw(); return; }
  $('#userBadge').textContent = USER.username ? (USER.username + (USER.tip ? ' · ' + USER.tip : '')) : '';
  $('#usersCard').style.display = USER.role === 'admin' ? '' : 'none';
  $('#exportAllBtn') && ($('#exportAllBtn').style.display = USER.role === 'admin' ? '' : 'none');
  // Planul de conturi e global (partajat de toate firmele), deci importul e rezervat adminului
  // — serverul raspunde 403 oricum; ascunderea evita un buton care nu poate reusi.
  $('#accImportBox') && ($('#accImportBox').style.display = USER.role === 'admin' ? '' : 'none');
  applySessionState(USER);
  // drepturi granulare: utilizatorii fara acces la salarizare nu vad intrarea din meniu
  const faraSalarii = !!(USER.drepturi && USER.drepturi.faraSalarii);
  $$('button[data-tab="salarizare"]').forEach((b) => { b.style.display = faraSalarii ? 'none' : ''; });
  const gs = $('#navgrupSalarii'); if (gs) gs.style.display = faraSalarii ? 'none' : ''; // tot meniul, nu doar intrarea
  initUiMode(); // mod simplu implicit pentru necontabili (ascunde partea tehnica din meniu)
  // Intoarcere de la Stripe (user logat) dupa abonarea unei firme: confirmare + starea se activeaza la webhook
  const cr = /[?&]checkout=(success|cancel)/.exec(location.search);
  if (cr) {
    history.replaceState(null, '', location.pathname);
    if (cr[1] === 'cancel') toast('Plata a fost anulată — firma rămâne neschimbată.', true);
    else { toast('✓ Plată primită! Abonamentul firmei se activează în câteva momente (după confirmarea Stripe).'); goTab('abonament'); }
  }
  startMsgPolling();
  // proba expirata: banner persistent + cont read-only (serverul blocheaza scrierile cu 402)
  const seb = $('#subExpiredBar');
  if (seb) {
    seb.classList.toggle('hidden', !USER.subExpirat);
    const go = $('#subExpiredGo');
    if (go && !go._wired) { go._wired = true; go.addEventListener('click', () => goTab('abonament')); }
  }
  // abonatii (necontabil/contabil) isi completeaza datele personale in Setari -> Contul meu
  if ((USER.tip === 'necontabil' || USER.tip === 'contabil') && !USER.profilComplet) {
    toast('Completează-ți datele personale (nume, telefon) în Setări → Contul meu.', true);
  }
  maybeWelcome();
  maybeTour();
  $('#companyName').textContent = (META.company && META.company.nume) || '';
  fillFirmaSelect();
  fillCompanyForm();
  fillTipSelect();
  fillPeriods();
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

// ───────────────────────── IMPORT EXTRAS BANCAR ─────────────────────────
// Extras in public/bank.js. Ii injectam reimprospatarea de dupa import (functiile traiesc aici).
setBankRefresh(() => { fillPeriods(); loadEntries(); loadDashboard(); });
function renderAI() {
  const ai = META.ai || { available: false, enabled: false };
  const st = $('#aiStatus');
  const help = $('#aiHelp');
  const toggle = $('#aiToggle');
  if (ai.available) {
    st.className = 'status ok';
    st.textContent = '✔ Cheie API detectată. Model: ' + (ai.model || '—');
    help.classList.add('hidden');
  } else {
    st.className = 'status';
    st.textContent = 'Nicio cheie API detectată — se folosesc regulile locale.';
    help.classList.remove('hidden');
    help.textContent = 'Pentru a activa extragerea cu AI, pornește serverul cu cheia setată:\n\n  ANTHROPIC_API_KEY=sk-ant-... npm start';
  }
  toggle.checked = !!ai.enabled;
  // setare GLOBALA — doar adminul o comuta (ceilalti o vad, dezactivata)
  const adminAI = USER.role === 'admin';
  toggle.disabled = !ai.available || !adminAI;
  if (!adminAI && ai.available) { st.textContent += ' · comutarea o face administratorul'; }
}
$('#aiToggle').addEventListener('change', async (e) => {
  await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ useAI: e.target.checked }) });
  META.ai.enabled = e.target.checked;
  toast('Setare salvată');
});
function fillCompanyForm() {
  const f = $('#companyForm');
  ['nume', 'cui', 'regCom', 'adresa', 'oras', 'judet', 'iban', 'banca', 'telefon', 'email', 'capitalSocial', 'pdfFooter', 'asociatiText', 'proRataTva', 'caen', 'perioadaTva'].forEach((k) => { if (f[k]) f[k].value = META.company[k] || ''; });
  if (f.tipEntitate) f.tipEntitate.value = META.company.tipEntitate === 'pfa' ? 'pfa' : 'srl';
  if (f.tvaLaIncasare) f.tvaLaIncasare.checked = !!META.company.tvaLaIncasare;
  if (f.accentColor) f.accentColor.value = /^#[0-9a-fA-F]{6}$/.test(META.company.accentColor || '') ? META.company.accentColor : '#0b6e4f';
  if (f.pdfLayout) f.pdfLayout.value = ['clasic', 'compact', 'detaliat'].includes(META.company.pdfLayout) ? META.company.pdfLayout : 'clasic';
  // profil fiscal (motor)
  if (f.regimImpozit) f.regimImpozit.value = ['micro', 'profit'].includes(META.company.regimImpozit) ? META.company.regimImpozit : 'micro';
  if (f.d406Cadenta) f.d406Cadenta.value = ['L', 'T', 'A'].includes(META.company.d406Cadenta) ? META.company.d406Cadenta : '';
  if (f.intrastatObligat) f.intrastatObligat.checked = !!META.company.intrastatObligat;
  const scut = (META.company.scutiri && typeof META.company.scutiri === 'object') ? META.company.scutiri : {};
  document.querySelectorAll('#scutiriBox [data-scutire]').forEach((c) => { c.checked = !!scut[c.dataset.scutire]; });
  refreshLogo();
  refreshFiscalProfile();
}
// Rezumatul profilului fiscal CALCULAT (motorul) — arata ce declaratii/alerte deriva din setari
async function refreshFiscalProfile() {
  const box = $('#fiscalProfileSummary'); if (!box) return;
  try {
    const p = await api('/api/fiscal-profile');
    const regim = p.pfa ? 'PFA (Declarația Unică)' : (p.profit ? 'impozit pe profit (D101)' : 'micro (D100)');
    const tva = p.tvaPlatitor ? ('plătitoare TVA — ' + (p.perioadaTva === 'T' ? 'trimestrial' : 'lunar') + (p.tvaLaIncasare ? ', la încasare' : '')) : 'neplătitoare de TVA';
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
    box.innerHTML = `<span class="ei">⚙️</span><p><b>Profil calculat:</b> ${tva} · ${regim} · D406 <b>${{ L: 'lunar', T: 'trimestrial', A: 'anual' }[p.d406] || p.d406}</b> · Intrastat ${p.intrastat ? '<b>da</b>' : 'nu'} · salariați ${p.areAngajati ? 'da' : 'nu'}${scutiri.length ? ' · scutiri: ' + scutiri.join(', ').toUpperCase() : ''}<br><span class="muted">Declarațiile, termenele, alertele și controalele se generează din acest profil.</span></p>${ctrlHtml}`;
  } catch (e) { box.innerHTML = `<span class="ei">⚙️</span><p class="muted">Profilul fiscal se calculează după salvarea firmei.</p>`; }
}
// Logo firma (apare in antetul PDF-urilor emise) — incarcare/stergere + previzualizare
async function refreshLogo() {
  const img = $('#logoPreview'); const del = $('#logoDeleteBtn');
  if (!img) return;
  try {
    const r = await fetch('/api/company/logo?ts=' + Date.now());
    if (r.ok) { img.src = URL.createObjectURL(await r.blob()); img.style.display = ''; if (del) del.style.display = ''; }
    else { img.style.display = 'none'; if (del) del.style.display = 'none'; }
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
async function setLock(lockedUntil) {
  const r = await api('/api/period-lock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lockedUntil }) });
  if (META.company) META.company.lockedUntil = r.lockedUntil;
  renderLock();
  return r;
}
$('#lockSet') && $('#lockSet').addEventListener('click', async () => {
  const v = $('#lockUntil').value;
  if (!v) return toast('Alege o lună', true);
  try { await setLock(v); toast('Perioade blocate până la ' + v); } catch (e) { toast(e.message, true); }
});
$('#lockClear') && $('#lockClear').addEventListener('click', async () => {
  if (!confirm('Deblochezi TOATE perioadele? Vei putea înregistra din nou în lunile închise.')) return;
  try { await setLock(null); toast('Perioade deblocate'); } catch (e) { toast(e.message, true); }
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
  const b = $('#themeBtn'); if (b) b.textContent = d ? '☀️' : '🌙';
}
$('#themeBtn') && $('#themeBtn').addEventListener('click', () => {
  const d = !document.body.classList.contains('dark');
  try { localStorage.setItem('contab_dark', d ? '1' : '0'); } catch (e) { /* ignora */ }
  applyTheme();
});
applyTheme();
// ── Legarea filtrelor Luna/An + popularea perioadelor → public/periods.js ──

// ───────────────────────── UPLOAD ─────────────────────────

// ───── Scanare directă cu camera / webcam-ul (getUserMedia) ─────
// Scanare de la scanerul local (prin puntea Contabo Scanner Bridge de pe PC)



// Comutare programatica intre tab-uri (din linkuri/scurtaturi); scrollId optional
function goTab(name, scrollId) {
  const b = $(`#tabs button[data-tab="${name}"]`);
  $$('#tabs button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $$('#tabs .navlabel').forEach((l) => l.classList.remove('active'));
  const grp = b && b.closest('.navgroup'); if (grp) { openGroup(grp); grp.querySelector('.navlabel').classList.add('active'); }
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
setOnReconnect(() => { const active = $('#tabs button[data-tab].active'); if (active) { toast('Conexiune revenită — reîncarc datele.'); onTab(active.dataset.tab); } });
// Scurtaturi „Ce vrei sa faci?” de pe Dashboard
$$('.qa[data-go]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.go, b.dataset.scroll)));

// ───────────────────────── WIZARD „Ce vrei să înregistrezi?” ─────────────────────────
// Ghidează un ne-contabil prin întrebări simple → alege automat tipul de document potrivit.
// Tipurile de IESIRE (emise de firma) se deschid in pagina „Emite factura"; restul in „Adauga document primit"

// Harta ciclului contabil — afisata in capul ecranelor din ciclu, cu pasul curent evidentiat
// Pasii marcati `adv` sunt tehnic-contabili si duc spre taburi ascunse in modul simplu; ei
// (si sagetile lor) primesc clasa `adv`, deci `.simple-ui .adv` ii ascunde — in modul simplu
// bara ramane „Documente → Declarații", fara jargon.
const CYCLE = [
  { go: 'documente', ic: '📥', t: 'Documente' },
  { go: 'emite', ic: '🧾', t: 'Emite' },
  { go: 'jurnal', ic: '📘', t: 'Operațiuni', adv: true },
  { go: 'carte', ic: '📗', t: 'Fișe conturi', adv: true },
  { go: 'balanta', ic: '⚖️', t: 'Solduri', adv: true },
  { go: 'inchideri', ic: '🔒', t: 'Închideri', adv: true },
  { go: 'livrabile', ic: '📤', t: 'Declarații' },
];
$$('.cyclemap').forEach((m) => {
  const cur = m.dataset.step;
  m.innerHTML = CYCLE.map((s, i) =>
    `${i ? `<span class="cyclearrow${s.adv ? ' adv' : ''}" aria-hidden="true">→</span>` : ''}<button class="cyclestep${s.adv ? ' adv' : ''}${s.go === cur ? ' active' : ''}" data-go="${s.go}"${s.go === cur ? ' aria-current="page"' : ''}><span class="ci" aria-hidden="true">${s.ic}</span>${s.t}</button>`
  ).join('');
  m.querySelectorAll('.cyclestep').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.go)));
});

// Mesaj de bun-venit la prima logare (o data per utilizator, per browser)
function welcomeKey() { return 'contab_welcomed_' + ((USER && USER.username) || '?'); }
function maybeWelcome() {
  try { if (localStorage.getItem(welcomeKey())) return; } catch (e) { return; }
  $('#welcomeOverlay').classList.remove('hidden');
}
function closeWelcome() {
  try { localStorage.setItem(welcomeKey(), '1'); } catch (e) { /* ignora */ }
  $('#welcomeOverlay').classList.add('hidden');
}
$('#welcomeStart').addEventListener('click', () => { closeWelcome(); startTour(); });
$('#welcomeGuide').addEventListener('click', () => { closeWelcome(); goTab('ghid'); });

// ───────────────────────── TUR GHIDAT (noul meniu) ─────────────────────────
const TOUR = [
  { ic: '👋', title: 'Bun venit! Meniul, pe scurt', text: 'L-am organizat pe activități zilnice, în limbaj simplu. Ți-l arăt în câțiva pași — apoi ești gata.' },
  { sel: '#tabs [data-tab="dashboard"]', ic: '🏠', title: 'Acasă', text: 'Punctul de plecare: butoane „Ce vrei să faci?" și o privire de ansamblu asupra firmei.' },
  { group: 'Documente', ic: '📥', title: 'Documente & facturi', text: 'Adaugi documentele primite (le încarci, aplicația le citește) și emiți facturi către clienți.' },
  { group: 'Bani', ic: '🏦', title: 'Bani', text: 'Încasările și plățile prin bancă și casă, plus verificarea extrasului bancar.' },
  { group: 'Taxe', ic: '🧾', title: 'Taxe', text: 'TVA-ul de plată și declarațiile pentru ANAF.' },
  { group: 'Stocuri', ic: '📦', title: 'Stocuri, salarii, mijloace fixe', text: 'Fiecare cu meniul lui — le folosești doar dacă firma ta are nevoie de ele (mijloacele fixe apar în modul expert).' },
  { group: 'Rapoarte', ic: '📊', title: 'Rapoarte', text: 'Toate rapoartele contabile la un loc (situații, solduri, operațiuni). Se fac singure din documentele tale.' },
  { sel: '#tabs [data-tab="mesaje"]', ic: '💬', title: 'Mesaje', text: 'Ai o întrebare? Scrie-i administratorului direct de aici — îți răspunde în aplicație.' },
  { ic: '🎉', title: 'Gata!', text: 'Începe din 🏠 Acasă → „Ce vrei să faci?". Poți relua oricând turul din 📖 Ghid.' },
];
let tourIdx = 0;
function tourKey() { return 'contab_tour_v1_' + ((USER && USER.username) || '?'); }
function tourTargetOf(step) {
  if (step.sel) return $(step.sel);
  if (step.group) return $$('#tabs .navlabel').find((l) => l.textContent.indexOf(step.group) >= 0);
  return null;
}
function clearTourHighlight() { $$('.tour-highlight').forEach((el) => el.classList.remove('tour-highlight')); }
function showTourStep(i) {
  tourIdx = Math.max(0, Math.min(i, TOUR.length - 1));
  const step = TOUR[tourIdx];
  clearTourHighlight();
  $('#tourIc').textContent = step.ic;
  $('#tourTitle').textContent = step.title;
  $('#tourText').textContent = step.text;
  $('#tourProgress').innerHTML = TOUR.map((_, k) => `<i class="${k === tourIdx ? 'on' : ''}"></i>`).join('');
  $('#tourBack').style.visibility = tourIdx === 0 ? 'hidden' : 'visible';
  $('#tourNext').textContent = tourIdx === TOUR.length - 1 ? 'Gata ✓' : 'Următorul →';
  const t = tourTargetOf(step);
  if (t) { const g = t.closest && t.closest('.navgroup'); if (g) openGroup(g); t.classList.add('tour-highlight'); try { t.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* ignora */ } }
}
function startTour() { $('#tourCard').classList.remove('hidden'); showTourStep(0); }
function endTour() { clearTourHighlight(); $('#tourCard').classList.add('hidden'); try { localStorage.setItem(tourKey(), '1'); } catch (e) { /* ignora */ } }
function maybeTour() {
  try { if (localStorage.getItem(tourKey())) return; } catch (e) { return; }
  if (!$('#welcomeOverlay').classList.contains('hidden')) return; // dacă se arată bun-venitul, turul pornește după „Începe turul”
  startTour();
}
$('#tourNext').addEventListener('click', () => { if (tourIdx >= TOUR.length - 1) endTour(); else showTourStep(tourIdx + 1); });
$('#tourBack').addEventListener('click', () => showTourStep(tourIdx - 1));
$('#tourSkip').addEventListener('click', endTour);
$('#tourReplay') && $('#tourReplay').addEventListener('click', startTour);
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
    if (s.status === 'expired') return `<span class="pill warn">probă expirată</span>${pend}`;
    return `<span class="pill warn">fără abonament</span>${pend}`;
  };
  box.innerHTML = `<table><thead><tr><th>Firmă</th><th>Stare abonament</th><th></th></tr></thead><tbody>${
    data.firme.map((f) => { const s = f._sub || {}; const needs = s.status === 'expired' || s.status === 'none';
      return `<tr><td>${H(f.nume)}${f.cui ? ' <span class="muted">(' + H(f.cui) + ')</span>' : ''}</td>
        <td>${stLabel(s)}</td>
        <td>${needs ? `<button class="linkbtn fbsub" data-id="${f.id}" data-nume="${H(f.nume)}" data-u="u12">abonează-te →</button>` : (s.status === 'trial' ? `<button class="linkbtn fbsub" data-id="${f.id}" data-nume="${H(f.nume)}">abonează firma acum</button>` : '')}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="muted" data-u="u24">Firma activă acum: <b>${H((data.firme.find((f) => f.id === data.firmaActiva) || {}).nume || '—')}</b>. Abonarea deschide plata (Stripe) pentru planul potrivit tipului tău.</p>`;
  $$('#firmeBilling .fbsub').forEach((b) => b.addEventListener('click', () => promptFirmaSubscribe(Number(b.dataset.id), b.dataset.nume)));
}
function renderSubscription(data) {
  const c = data.current || {}; const plans = data.plans || [];
  const nameOf = (id) => (plans.find((p) => p.id === id) || {}).nume || id;
  // banner de stare
  let banner = '';
  if (c.status === 'trial') banner = `<div class="sub-banner ok"><b>✓ Perioadă de probă activă</b> — îți mai rămân <b>${c.zileRamase}</b> ${c.zileRamase === 1 ? 'zi' : 'zile'}. Alege un plan pentru a continua după probă.</div>`;
  else if (c.status === 'active') banner = `<div class="sub-banner ok"><b>✓ Abonament activ: ${nameOf(c.plan)}</b>${c.since ? ' · din ' + c.since.slice(0, 10) : ''}.</div>`;
  else if (c.status === 'expired') banner = `<div class="sub-banner warn"><b>⚠ Perioada de probă a expirat.</b> Alege un plan pentru a continua.</div>`;
  else banner = `<div class="sub-banner"><b>Niciun abonament activ.</b> Începe cu proba gratuită de 30 zile.</div>`;
  if (c.requestedPlan && c.status !== 'active') banner += `<div class="sub-banner">⏳ Ai solicitat planul <b>${nameOf(c.requestedPlan)}</b> — în așteptarea activării (după confirmarea plății).</div>`;
  if (c.status === 'active' && data.manageable) banner += `<div data-u="u23"><button id="subPortal" class="btn">Gestionează / anulează abonamentul</button></div>`;
  if (c.status === 'canceled') banner = `<div class="sub-banner warn"><b>Abonament anulat.</b> Alege din nou un plan pentru a reactiva.</div>` + banner;
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
      action = c.trialUsed
        ? `<button class="btn" disabled>${c.status === 'trial' ? 'Probă în curs' : 'Probă folosită'}</button>`
        : `<button class="btn primary sub-trial">Începe proba gratuită</button>`;
    } else if (isCurrent) {
      action = `<button class="btn" disabled>Planul tău</button>`;
    } else if (c.requestedPlan === p.id && !data.stripeEnabled) {
      action = `<button class="btn" disabled>În așteptare activare</button>`;
    } else {
      const label = data.stripeEnabled ? ('Abonează-te') : ('Alege ' + p.nume);
      action = `<button class="btn primary sub-select" data-plan="${p.id}">${label}</button>`;
    }
    return `<div class="plan-card${p.recomandat ? ' recomandat' : ''}${isCurrent ? ' current' : ''}">
      ${p.recomandat ? '<div class="plan-badge">Recomandat</div>' : ''}
      <h3>${H(p.nume)}</h3>
      <div class="plan-price">${p.pret === 0 ? 'Gratuit' : '<b>' + fmt(p.pret) + '</b> ' + p.moneda}<span>${p.pret === 0 ? '' : '/ ' + p.perioada}</span></div>
      <p class="plan-desc">${H(p.descriere || '')}</p>
      <ul class="plan-feat">${(p.features || []).map((f) => `<li>${f}</li>`).join('')}</ul>
      <div class="plan-action">${action}</div>
    </div>`;
  }).join('');

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


// ── Editor „descărcare din stoc" (produs + gestiune + cantitate); COGS la CMP, calculat de server ──


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
$('#companyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { nume: f.nume.value, cui: f.cui.value, regCom: f.regCom.value, adresa: f.adresa.value, oras: f.oras.value, judet: f.judet.value, tvaLaIncasare: f.tvaLaIncasare.checked, tipEntitate: f.tipEntitate.value,
    iban: f.iban.value.trim(), banca: f.banca.value.trim(), telefon: f.telefon.value.trim(), email: f.email.value.trim(), capitalSocial: f.capitalSocial.value.trim(), accentColor: f.accentColor.value, pdfLayout: f.pdfLayout.value, pdfFooter: f.pdfFooter.value.trim(), asociatiText: f.asociatiText.value.trim(), proRataTva: f.proRataTva.value ? Number(f.proRataTva.value) : '', caen: f.caen.value.trim(), perioadaTva: f.perioadaTva.value };
  // profil fiscal (motor): regim, cadenta D406, Intrastat, scutiri
  body.regimImpozit = f.regimImpozit ? f.regimImpozit.value : 'micro';
  body.d406Cadenta = f.d406Cadenta ? f.d406Cadenta.value : '';
  body.intrastatObligat = f.intrastatObligat ? f.intrastatObligat.checked : false;
  body.scutiri = {};
  document.querySelectorAll('#scutiriBox [data-scutire]').forEach((c) => { if (c.checked) body.scutiri[c.dataset.scutire] = true; });
  const r = await api('/api/company', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  META.company = r.company || body;
  refreshFiscalProfile(); // recalculeaza rezumatul profilului — inaintea DOM-ului care ar putea arunca
  const cn = $('#companyName'); if (cn) cn.textContent = body.nume; // absent in modul simplu — nu bloca restul
  toast('Date firmă salvate' + (body.tvaLaIncasare ? ' · regim TVA la încasare ACTIV' : ''));
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
