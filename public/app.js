'use strict';
import { $, $$, H, fmt, accName, toast, setLoad, api, META, USER, setMeta, setUser, setOn402, escMsg, escAttr, isDemo, fileToCsv, round2 } from './core.js';
import { loadMessages, startMsgPolling, setMsgBadge, setLastUnread } from './messages.js';
import { setBankRefresh } from './bank.js';
import { render2FA, renderBackup, renderProfile, renderSessions, renderSmtp, renderFiscal, setSettingsDeps } from './settings.js';
import { renderFirme, renderUsers, renderAudit, setAdminDeps } from './admin.js';
import { loadDashboard, renderBudget, setDashboardDeps } from './dashboard.js';
import { initUiMode } from './simplemode.js';
import { loadPartners } from './partners.js';
import './viewer.js'; // vizualizatorul de documente (PDF/CSV/XML/e-Factura) — se activeaza prin efect secundar
import { pget, workMonth, setWorkMonth, lunaLabel, applyWorkMonth, onPeriodChange, fillPeriods, setPeriodsDeps } from './periods.js';
import { loadJournal, loadLedger, loadCashbook, loadBalance, loadVat, loadClosings, loadStatements } from './rapoarte.js';
import { loadLivrabile, loadPortfolio, loadNotifications, loadReconcile, loadAnalytic, refreshNotifBadge } from './livrabile.js';
import { loadAssets } from './mijloace.js';
import { loadSalarizare } from './salarizare.js';
import { loadStocks } from './stocuri.js';
import { renderPlan, renderOpening } from './plan.js';
setPeriodsDeps({ renderEntryLists, onTab }); // functiile sunt declarate mai jos (hoisting)


let CURRENT = null; // { documentId, fields, suggestedType }

const EFACT_TYPES = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare', 'factura_storno_cumparare']);
const SENDABLE_TYPES = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare']);
// $, $$ mutati in core.js (importate mai sus)
// Buton „arată/ascunde" pe fiecare camp de parola (login, inscriere, schimbare parola, admin…)
function enhancePasswordFields() {
  $$('input[type="password"]').forEach((inp) => {
    if (inp.dataset.pwToggle) return;
    inp.dataset.pwToggle = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'pw-toggle'; btn.textContent = 'arată';
    btn.setAttribute('aria-label', 'Arată sau ascunde parola'); btn.tabIndex = -1;
    wrap.appendChild(btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? 'ascunde' : 'arată';
    });
  });
}
document.addEventListener('DOMContentLoaded', enhancePasswordFields);
enhancePasswordFields();
// fmt, accName, H, toast, setLoad, api mutati in core.js (importate mai sus).
// Inregistram hook-ul pentru raspunsul 402 (proba firmei expirata) — promptFirmaSubscribe e
// declaratie de functie (hoisted), deci referirea ei aici, inainte de definitie, e valida.
setOn402((data) => promptFirmaSubscribe(data.firmaId, data.firmaNume));
// Dupa expirarea probei unei firme: avertisment + intrebare de abonare; la „Da" -> plata Stripe
// (Start pentru necontabili / Pro pentru contabili) si deblocarea firmei pe luna curenta.
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
function showLogin() { $('#loginOverlay').classList.remove('hidden'); checkRegisterEnabled(); }
function hideLogin() { $('#loginOverlay').classList.add('hidden'); }
// ── Inscriere firma (pagina publica de pe login) ──
async function checkRegisterEnabled() {
  try { const r = await fetch('/api/register'); if (!r.ok) return; const d = await r.json(); $('#registerBtn') && $('#registerBtn').classList.toggle('hidden', !d.enabled); }
  catch (e) { /* ignora */ }
}
$('#registerBtn') && $('#registerBtn').addEventListener('click', () => {
  pendingPaidPlan = null; // „Testeaza gratuit" = inscriere simpla, fara plan platit in asteptare
  $('#registerErr').textContent = ''; openRegisterPanel();
});
// „Demo": intra in contul demo public (explorare libera, date resetate zilnic)
$('#demoLoginBtn') && $('#demoLoginBtn').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try { await api('/api/demo-login', { method: 'POST' }); $('#loginOverlay').classList.add('hidden'); await init(); toast('Ai intrat în contul demo — explorează liber!'); }
  catch (err) { toast(err.message, true); b.disabled = false; }
});
$('#registerCancel') && $('#registerCancel').addEventListener('click', () => {
  pendingPaidPlan = null;
  $('#registerOverlay').classList.add('hidden'); $('#loginOverlay').classList.remove('hidden');
});
// Planul plătit ales din panoul de prețuri — reținut până la crearea contului, apoi lansează Stripe.
let pendingPaidPlan = null;
// Prețuri publice (pe pagina de autentificare/înscriere)
async function showPricing() {
  const box = $('#pricingPlans'); if (!box) return;
  box.innerHTML = '<p class="muted">Se încarcă…</p>';
  $('#pricingOverlay').classList.remove('hidden');
  let data; try { data = await (await fetch('/api/plans')).json(); } catch (e) { box.innerHTML = '<p class="status err">Nu s-au putut încărca prețurile.</p>'; return; }
  let canRegister = false;
  try { const r = await fetch('/api/register'); if (r.ok) canRegister = !!(await r.json()).enabled; } catch (e) { /* optional */ }
  box.innerHTML = (data.plans || []).map((p) => {
    const cta = canRegister
      ? `<button class="btn primary pricing-start" data-plan="${p.id}" data-trial="${p.trial ? 1 : 0}">${p.trial ? 'Începe proba gratuită' : 'Alege ' + p.nume + ' →'}</button>`
      : '<div class="muted" style="font-size:12px;text-align:center">Autentifică-te pentru a alege planul</div>';
    const demo = p.trial ? '<button class="btn pricing-demo" style="margin-top:6px">🔎 Intră în contul demo</button>' : '';
    return `<div class="plan-card${p.recomandat ? ' recomandat' : ''}">
      ${p.recomandat ? '<div class="plan-badge">Recomandat</div>' : ''}
      <h3>${p.nume}</h3>
      <div class="plan-price">${p.pret === 0 ? 'Gratuit' : '<b>' + fmt(p.pret) + '</b> ' + p.moneda}<span>${p.pret === 0 ? '' : '/ ' + p.perioada}</span></div>
      <p class="plan-desc">${p.descriere || ''}</p>
      <ul class="plan-feat">${(p.features || []).map((f) => `<li>${f}</li>`).join('')}</ul>
      <div class="plan-action">${cta}${demo}</div>
    </div>`;
  }).join('');
  $$('#pricingPlans .pricing-start').forEach((b) => b.addEventListener('click', () => {
    // Intai INSCRIEREA firmei; plata Stripe se lanseaza dupa completarea formularului (vezi registerForm).
    // Proba gratuita nu are plata; planul platit e retinut in pendingPaidPlan.
    pendingPaidPlan = b.dataset.trial === '1' ? null : b.dataset.plan;
    const label = b.textContent.replace(/→/g, '').replace(/^\s*Alege\s+/i, '').trim();
    openRegisterPanel(b.dataset.trial === '1' ? null : label);
  }));
  $$('#pricingPlans .pricing-demo').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api('/api/demo-login', { method: 'POST' });
      $('#pricingOverlay').classList.add('hidden');
      await init();
      toast('Ai intrat în contul demo — explorează liber!');
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}
$('#showPricingLogin') && $('#showPricingLogin').addEventListener('click', showPricing);
$('#showPricingReg') && $('#showPricingReg').addEventListener('click', showPricing);
$('#pricingClose') && $('#pricingClose').addEventListener('click', () => $('#pricingOverlay').classList.add('hidden'));
// Întrebări frecvente (public, pe pagina de autentificare) — acordeoane + căutare
$('#showFaqLogin') && $('#showFaqLogin').addEventListener('click', () => $('#faqOverlay').classList.remove('hidden'));
$('#faqClose') && $('#faqClose').addEventListener('click', () => $('#faqOverlay').classList.add('hidden'));
$('#faqSearch') && $('#faqSearch').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  $$('#faqList .faq-item').forEach((it) => {
    const hit = !q || it.textContent.toLowerCase().includes(q);
    it.classList.toggle('hidden', !hit);
    if (q && hit) it.open = true; else if (!q) it.open = false;
  });
});

$('#registerForm') && $('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; $('#registerErr').textContent = '';
  const body = { nume: f.nume.value, cui: f.cui.value, regCom: f.regCom.value, adresa: f.adresa.value, oras: f.oras.value, judet: f.judet.value, tvaPlatitor: f.tvaPlatitor.checked, tipEntitate: f.tipEntitate.value, username: f.username.value, password: f.password.value, email: f.email.value };
  try {
    await api('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    f.password.value = '';
    // Plan platit ales din preturi -> dupa crearea contului, lanseaza plata Stripe
    if (pendingPaidPlan) {
      const plan = pendingPaidPlan; pendingPaidPlan = null;
      try {
        const r = await api('/api/subscription/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
        if (r.url) { window.location.href = r.url; return; } // redirect catre Stripe Checkout
      } catch (e) {
        toast('Firma a fost creată. Plata online nu e disponibilă acum — te ajutăm să activezi abonamentul din Abonament.', true);
      }
    }
    $('#registerOverlay').classList.add('hidden'); $('#loginOverlay').classList.add('hidden');
    await init();
    toast('Bine ai venit! Firma „' + body.nume + '" a fost creată.');
  } catch (err) { $('#registerErr').textContent = err.message; }
});
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; $('#loginErr').textContent = '';
  const body = { username: f.username.value, password: f.password.value };
  if (f.code) body.code = f.code.value;
  if (f.remember) body.remember = f.remember.checked;
  try {
    const r = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.twofa && !r.user) { // parola corectă, cere codul 2FA
      $('#codeRow').classList.remove('hidden'); $('#rememberRow').classList.remove('hidden'); if (f.code) f.code.focus();
      $('#loginErr').textContent = 'Introdu codul din aplicația de autentificare.'; return;
    }
    f.password.value = ''; hideLogin(); await init();
  } catch (err) {
    if (/2FA/i.test(err.message)) $('#codeRow').classList.remove('hidden');
    $('#loginErr').textContent = err.message;
  }
});
$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});
// Schimbare de parola fortata (cont cu parola implicita): overlay care blocheaza aplicatia.
function showForcePw() {
  hideLogin();
  const ov = $('#forcePwOverlay'); if (!ov) return;
  ov.classList.remove('hidden');
  const inp = $('#forcePwForm') && $('#forcePwForm').oldPassword; if (inp) inp.focus();
}
$('#forcePwForm') && $('#forcePwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; const err = $('#forcePwErr'); err.textContent = '';
  if (f.newPassword.value !== f.newPassword2.value) { err.textContent = 'Cele două parole noi nu coincid.'; return; }
  try {
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: f.oldPassword.value, newPassword: f.newPassword.value }) });
    $('#forcePwOverlay').classList.add('hidden');
    toast('Parolă schimbată. Îți recomandăm să activezi și 2FA din Setări.');
    await init();
    goTab('setari');
    setTimeout(() => { const t = $('#twofaStart'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 250);
  } catch (ex) { err.textContent = ex.message; }
});
$('#forgotLink').addEventListener('click', () => {
  const box = $('#loginForm');
  box.innerHTML = `<div class="login-logo">▦ Contabo</div>
    <p class="muted">Recuperare parolă — introdu utilizatorul sau emailul.</p>
    <label>Utilizator / email <input name="login" required /></label>
    <div id="loginErr" class="status"></div>
    <button class="btn primary" style="width:100%">Trimite link de resetare</button>
    <p style="margin-top:10px;text-align:center"><a id="forgotBack" class="link">← Înapoi la autentificare</a></p>`;
  $('#forgotBack').addEventListener('click', () => location.reload());
  box.onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api('/api/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: box.login.value }) }); $('#loginErr').className = 'status ok'; $('#loginErr').textContent = r.message; }
    catch (err) { $('#loginErr').textContent = err.message; }
  };
});

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
  if (t === 'tva') loadVat();
  if (t === 'inchideri') loadClosings();
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
  if (t === 'setari') { renderAnaf(); renderFirme(); renderUsers(); render2FA(); renderSmtp(); renderFiscal(); renderBackup(); renderProfile(); renderSessions(); renderLock(); renderOpening(); }
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
$$('#moreSheet button[data-go]').forEach((b) => b.addEventListener('click', () => { goTab(b.dataset.go); closeMore(); }));
// ───────────────────────── FIRME (multi-firma) ─────────────────────────
function fillFirmaSelect() {
  const sel = $('#firmaSelect');
  const subTag = (f) => { const s = f._sub || {}; return s.status === 'trial' ? ' 🎁 probă ' + s.zileRamase + 'z' : s.status === 'expired' ? ' 🎁 expirată' : s.status === 'none' ? ' ⚠ fără abonament' : ''; };
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
  const dict = PANEL_INFO.map(([t, info]) => [norm(t), info]).sort((a, b) => b[0].length - a[0].length);
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
  setUser(META.user || {});
  // Plasa de siguranta (daca meta ar fi permisa candva): acelasi ecran de schimbare fortata.
  if (USER.mustChange) { showForcePw(); return; }
  $('#userBadge').textContent = USER.username ? (USER.username + (USER.tip ? ' · ' + USER.tip : '')) : '';
  $('#usersCard').style.display = USER.role === 'admin' ? '' : 'none';
  $('#exportAllBtn') && ($('#exportAllBtn').style.display = USER.role === 'admin' ? '' : 'none');
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
function handleRegisterLink() {
  if (!/[?&]register=1/.test(location.search)) return;
  history.replaceState(null, '', location.pathname);
  openRegisterPanel();
}
function openRegisterPanel(planLabel) {
  $('#pricingOverlay') && $('#pricingOverlay').classList.add('hidden');
  $('#loginOverlay') && $('#loginOverlay').classList.add('hidden');
  if ($('#registerErr')) $('#registerErr').textContent = '';
  // indiciu: dupa crearea contului urmeaza plata planului ales
  const hint = $('#regPlanHint');
  if (hint) {
    if (pendingPaidPlan && planLabel) { hint.textContent = '💳 Plan ales: ' + planLabel + '. După crearea contului treci la plată.'; hint.classList.remove('hidden'); }
    else hint.classList.add('hidden');
  }
  const submitBtn = $('#registerForm') && $('#registerForm').querySelector('button.primary');
  if (submitBtn) submitBtn.textContent = pendingPaidPlan ? 'Creează firma și continuă la plată →' : 'Creează firma și contul';
  $('#registerOverlay') && $('#registerOverlay').classList.remove('hidden');
}
// ───────────────────────── DASHBOARD ─────────────────────────
// KPI-uri, rezumat, buget, forecast, an-la-an si grafice traiesc in public/dashboard.js.
setDashboardDeps({ goTab });

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
  toggle.disabled = !ai.available;
}
$('#aiToggle').addEventListener('change', async (e) => {
  await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ useAI: e.target.checked }) });
  META.ai.enabled = e.target.checked;
  toast('Setare salvată');
});
function fillCompanyForm() {
  const f = $('#companyForm');
  ['nume', 'cui', 'regCom', 'adresa', 'oras', 'judet', 'iban', 'banca', 'telefon', 'email', 'capitalSocial', 'pdfFooter', 'asociatiText', 'proRataTva'].forEach((k) => { if (f[k]) f[k].value = META.company[k] || ''; });
  if (f.tipEntitate) f.tipEntitate.value = META.company.tipEntitate === 'pfa' ? 'pfa' : 'srl';
  if (f.tvaLaIncasare) f.tvaLaIncasare.checked = !!META.company.tvaLaIncasare;
  if (f.accentColor) f.accentColor.value = /^#[0-9a-fA-F]{6}$/.test(META.company.accentColor || '') ? META.company.accentColor : '#0b6e4f';
  if (f.pdfLayout) f.pdfLayout.value = ['clasic', 'compact', 'detaliat'].includes(META.company.pdfLayout) ? META.company.pdfLayout : 'clasic';
  refreshLogo();
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
function fillTipSelect() {
  const sel = $('#tipSelect');
  const groups = {};
  META.types.forEach((t) => { (groups[t.grup] = groups[t.grup] || []).push(t); });
  sel.innerHTML = Object.keys(groups).map((g) =>
    `<optgroup label="${g}">${groups[g].map((t) => `<option value="${t.id}">${t.nume}</option>`).join('')}</optgroup>`
  ).join('');
}
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
const drop = $('#drop'), fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });

// ───── Scanare directă cu camera / webcam-ul (getUserMedia) ─────
let scanStream = null;
async function startScanStream(deviceId) {
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  const get = (v) => navigator.mediaDevices.getUserMedia({ audio: false, video: v });
  try {
    // preferă camera din spate (telefon), dar fără a o impune
    scanStream = await get(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } });
  } catch (e) {
    scanStream = await get(true); // fallback: orice cameră disponibilă (ex. webcam PC)
  }
  $('#scanVideo').srcObject = scanStream;
}
async function openScan() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Camera nu e suportată de acest browser.', true);
  try {
    await startScanStream();
    // listă camere (după ce avem permisiune, ca să apară etichetele)
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const sel = $('#scanCam');
      sel.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${d.label || ('Cameră ' + (i + 1))}</option>`).join('');
      sel.style.display = devs.length > 1 ? '' : 'none';
    } catch (e) { /* ignora */ }
    $('#scanModal').classList.remove('hidden');
  } catch (e) {
    toast('Nu pot accesa camera: ' + (e.message || e) + '. Permite accesul la cameră în browser.', true);
  }
}
function closeScan() {
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  const v = $('#scanVideo'); if (v) v.srcObject = null;
  $('#scanModal').classList.add('hidden');
}
// Scanare de la scanerul local (prin puntea Contabo Scanner Bridge de pe PC)
async function scanFromBridge() {
  const st = $('#uploadStatus'); st.className = 'status'; st.textContent = 'Se scanează… urmează fereastra de scanare (Windows / NAPS2). Lasă puntea pornită.';
  let res;
  try {
    res = await fetch('http://127.0.0.1:8765/scan');
  } catch (e) {
    // eroare de rețea = puntea nu rulează / blocată
    st.className = 'status err';
    st.textContent = 'Nu găsesc puntea de scanare locală. Pornește „Start-Contab-Scanner.bat" pe acest PC, apoi reîncearcă.';
    const d = $('#scanSetup'); if (d) d.open = true;
    toast('Puntea de scanare nu rulează — vezi „Configurează scanerul local".', true);
    return;
  }
  if (!res.ok) {
    // puntea răspunde, dar scanarea a eșuat — arătăm mesajul real
    const msg = (await res.text().catch(() => '')) || ('cod ' + res.status);
    console.error('[Contabo] Scanare eșuată (de la punte):', msg);
    st.className = 'status err';
    st.textContent = 'Scanarea a eșuat: ' + msg + '  (vezi și fereastra punții). Sfat: instalează NAPS2 pentru fiabilitate.';
    toast('Scanare eșuată: ' + msg, true);
    return;
  }
  const blob = await res.blob();
  const pdf = blob.type === 'application/pdf';
  const file = new File([blob], 'scan-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + (pdf ? '.pdf' : '.jpg'), { type: blob.type || 'image/jpeg' });
  uploadFile(file);
}
$('#scannerBtn') && $('#scannerBtn').addEventListener('click', scanFromBridge);
if ($('#scanBtn')) {
  $('#scanBtn').addEventListener('click', openScan);
  $('#scanClose').addEventListener('click', closeScan);
  $('#scanModal').addEventListener('click', (e) => { if (e.target.id === 'scanModal') closeScan(); });
  $('#scanCam').addEventListener('change', (e) => startScanStream(e.target.value).catch(() => {}));
  $('#scanShot').addEventListener('click', () => {
    const v = $('#scanVideo');
    if (!v.videoWidth) return toast('Camera încă se inițializează…', true);
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob) return toast('Nu s-a putut captura imaginea.', true);
      const file = new File([blob], 'scan-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.jpg', { type: 'image/jpeg' });
      closeScan();
      uploadFile(file);
    }, 'image/jpeg', 0.92);
  });
}

async function uploadFile(file) {
  const st = $('#uploadStatus'); st.className = 'status'; st.textContent = 'Se citește „' + file.name + '”…';
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await api('/api/upload', { method: 'POST', body: fd });
    st.className = 'status ok';
    const via = res.source === 'ai'
      ? '🤖 AI' + (res.incredere != null ? ' (încredere ' + res.incredere + '%)' : '')
      : '⚙️ reguli locale';
    st.innerHTML = 'Extras din „' + res.fileName + '” prin ' + via + '. CUI: ' + ((res.cuis || []).join(', ') || '—')
      + (res.motiv ? '<br><span class="muted">' + res.motiv + '</span>' : '')
      + (res.warning ? '<br><span style="color:var(--danger)">' + res.warning + '</span>' : '');
    CURRENT = { documentId: res.documentId, fields: res.fields, suggestedType: res.suggestedType };
    openForm(res.suggestedType, res.fields);
  } catch (e) { st.className = 'status err'; st.textContent = e.message; }
}

$('#manualBtn').addEventListener('click', () => { CURRENT = { documentId: null, fields: {}, suggestedType: 'nota_contabila' }; openForm('nota_contabila', { data: new Date().toISOString().slice(0, 10) }); });

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
// Scurtaturi „Ce vrei sa faci?” de pe Dashboard
$$('.qa[data-go]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.go, b.dataset.scroll)));

// ───────────────────────── WIZARD „Ce vrei să înregistrezi?” ─────────────────────────
// Ghidează un ne-contabil prin întrebări simple → alege automat tipul de document potrivit.
const WIZ = [
  { ic: '🛒', label: 'Am cumpărat ceva', desc: 'O factură primită de la furnizor', kids: [
    { ic: '📦', label: 'Marfă (pentru revânzare)', tip: 'factura_cumparare_marfuri' },
    { ic: '🧱', label: 'Materiale / materii prime', tip: 'factura_cumparare_materii' },
    { ic: '🛠️', label: 'Servicii (chirie, telecom, onorarii)', tip: 'factura_servicii_primita' },
    { ic: '💡', label: 'Utilități (curent, apă, gaz)', tip: 'factura_utilitati' },
    { ic: '⛽', label: 'Combustibil', tip: 'factura_combustibil' },
    { ic: '🖥️', label: 'Echipament / mijloc fix', tip: 'factura_imobilizare' },
  ] },
  { ic: '💰', label: 'Am vândut / emit factură', desc: 'Factură către un client', kids: [
    { ic: '📦', label: 'Marfă', tip: 'factura_vanzare_marfuri' },
    { ic: '🏭', label: 'Produse (fabricate de mine)', tip: 'factura_vanzare_produse' },
    { ic: '🛠️', label: 'Servicii', tip: 'factura_vanzare_servicii' },
    { ic: '🧾', label: 'Bon fiscal (numerar, amănunt)', tip: 'bon_fiscal_z' },
  ] },
  { ic: '🏦', label: 'Bani (încasări / plăți)', desc: 'Mișcări prin bancă sau casă', kids: [
    { ic: '⬇️', label: 'Am încasat de la un client', tip: 'incasare_client' },
    { ic: '⬆️', label: 'Am plătit un furnizor', tip: 'plata_furnizor' },
    { ic: '🏧', label: 'Depunere numerar la bancă', tip: 'depunere_numerar' },
    { ic: '💵', label: 'Ridicare numerar din bancă', tip: 'ridicare_numerar' },
    { ic: '🏦', label: 'Comision bancar', tip: 'comision_bancar' },
  ] },
  { ic: '👥', label: 'Salarii', desc: 'Calcul și plata salariilor', kids: [
    { ic: '🧮', label: 'Calcul salarii (stat de plată)', tip: 'stat_plata' },
    { ic: '💸', label: 'Plata salariilor', tip: 'plata_salarii' },
  ] },
  { ic: '⋯', label: 'Altceva', desc: 'Notă liberă sau toate tipurile', kids: [
    { ic: '📋', label: 'Notă contabilă liberă', tip: 'nota_contabila' },
    { ic: '🔎', label: 'Alege din toate tipurile…', tip: '__all__' },
  ] },
];
let opwCat = null;
function renderWizard() {
  const opened = !!opwCat;
  $('#opwBack').classList.toggle('hidden', !opened);
  $('#opwTitle').textContent = opened ? opwCat.label : 'Ce vrei să înregistrezi?';
  $('#opwHint').textContent = opened ? 'Alege mai exact:' : 'Alege în cuvinte simple — aplicația alege singură tipul contabil potrivit.';
  const grid = $('#opwGrid');
  const items = opened ? opwCat.kids : WIZ;
  grid.innerHTML = items.map((x, i) => `<button type="button" class="opw-card" data-i="${i}">
    <span class="opw-ic">${x.ic}</span><span class="opw-t">${x.label}</span>${x.desc ? `<span class="opw-d">${x.desc}</span>` : ''}</button>`).join('');
  $$('#opwGrid .opw-card').forEach((b) => b.addEventListener('click', () => {
    const x = items[+b.dataset.i];
    if (x.kids) { opwCat = x; renderWizard(); } else pickWizardType(x.tip);
  }));
}
function openWizard() { opwCat = null; renderWizard(); $('#opWizard').classList.remove('hidden'); }
function closeWizard() { $('#opWizard').classList.add('hidden'); }
// Tipurile de IESIRE (emise de firma) se deschid in pagina „Emite factura"; restul in „Adauga document primit"
const IESIRE_TIPS = /^(factura_vanzare|factura_storno_vanzare|bon_fiscal_z|factura_simplificata|aviz_livrare|facturare_aviz|livrare_intracomunitara)/;
function pickWizardType(tip) {
  closeWizard();
  const real = tip === '__all__' ? 'nota_contabila' : tip;
  const dest = IESIRE_TIPS.test(real) ? 'emite' : 'documente';
  goTab(dest);
  CURRENT = { documentId: null, fields: {}, suggestedType: real };
  openForm(real, { data: new Date().toISOString().slice(0, 10) }, dest);
  setTimeout(() => { const el = $('#entryForm'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (tip === '__all__') { const t = $('#tipSelect'); if (t) t.focus(); } }, 80);
}
$('#qaWizard') && $('#qaWizard').addEventListener('click', openWizard);
$('#opwBack') && $('#opwBack').addEventListener('click', () => { opwCat = null; renderWizard(); });
$('#opwClose') && $('#opwClose').addEventListener('click', closeWizard);
$('#opWizard') && $('#opWizard').addEventListener('click', (e) => { if (e.target.id === 'opWizard') closeWizard(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#opWizard').classList.contains('hidden')) closeWizard(); });

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
$$('.emit').forEach((btn) => btn.addEventListener('click', () => {
  const tip = btn.dataset.tip;
  CURRENT = { documentId: null, fields: {}, suggestedType: tip };
  openForm(tip, { data: new Date().toISOString().slice(0, 10) }, 'emite');
  setTimeout(() => $('#entryForm').scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
}));
// Linkuri catre registrele/situatiile generate
$$('.linklist a[data-go]').forEach((a) => { a.style.cursor = 'pointer'; a.addEventListener('click', () => goTab(a.dataset.go)); });

// ───────────────────────── FACTURI RECURENTE ─────────────────────────
async function renderRecurring() {
  const sel = $('#recTip');
  if (sel && !sel.options.length) sel.innerHTML = (META.types || []).map((t) => `<option value="${t.id}">${t.nume}</option>`).join('');
  if ($('#recPeriod') && !$('#recPeriod').value) $('#recPeriod').value = workMonth();
  let list;
  try { list = await api('/api/recurring'); } catch (e) { return; }
  const box = $('#recList');
  if (!list.length) { box.innerHTML = '<p class="muted">Niciun șablon recurent definit încă.</p>'; return; }
  const tname = (id) => ((META.types || []).find((t) => t.id === id) || {}).nume || id;
  box.innerHTML = `<table><thead><tr><th>Document</th><th>Partener</th><th class="num">Bază</th><th>Frecvență</th><th>Din</th><th>Ultima</th><th></th></tr></thead><tbody>${
    list.map((t) => `<tr${t.activ ? '' : ' style="opacity:.5"'}><td>${tname(t.tip)}</td><td>${t.partener || '—'}</td>
      <td class="num">${fmt((t.fields || {}).baza || 0)}</td><td>${t.frecventa}</td><td>${t.startDate || ''}</td><td>${t.lastGenerated || '—'}</td>
      <td><button class="linkbtn rectog" data-id="${t.id}" data-activ="${t.activ ? 1 : 0}">${t.activ ? 'dezactivează' : 'activează'}</button> · <button class="del recdel" data-id="${t.id}">✕</button></td></tr>`).join('')}</tbody></table>`;
  $$('#recList .recdel').forEach((b) => b.addEventListener('click', async () => { if (confirm('Ștergi șablonul recurent?')) { await api('/api/recurring/' + b.dataset.id, { method: 'DELETE' }); renderRecurring(); } }));
  $$('#recList .rectog').forEach((b) => b.addEventListener('click', async () => {
    const t = list.find((x) => x.id === b.dataset.id); if (!t) return;
    await api('/api/recurring', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, t, { activ: !t.activ })) });
    renderRecurring();
  }));
}
$('#recForm') && $('#recForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const baza = Number(f.baza.value) || 0; const cota = Number(f.cota.value) || 0;
  const body = {
    tip: f.tip.value, partener: f.partener.value, cuiPartener: f.cuiPartener.value, document: f.document.value,
    fields: { baza, cota, tva: Math.round(baza * cota) / 100 },
    frecventa: f.frecventa.value, ziua: f.ziua.value, startDate: f.startDate.value || workMonth(),
  };
  try { await api('/api/recurring', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); f.reset(); f.cota.value = 21; renderRecurring(); toast('Șablon recurent salvat'); }
  catch (err) { toast(err.message, true); }
});
$('#recGenBtn') && $('#recGenBtn').addEventListener('click', async () => {
  const period = $('#recPeriod').value; if (!period) return toast('Alege luna', true);
  $('#recGenStatus').textContent = 'Se generează…';
  try {
    const r = await api('/api/recurring/generate?period=' + period, { method: 'POST' });
    $('#recGenStatus').textContent = r.created + ' factură(i) generate' + (r.errors.length ? (', ' + r.errors.length + ' erori') : '') + '.';
    if (r.errors.length) toast(r.errors.join(' | '), true);
    else if (r.created) toast(r.created + ' facturi recurente generate pentru ' + period);
    else toast('Nimic de generat pentru ' + period + ' (deja generate sau niciun șablon scadent)');
    renderRecurring(); loadEntries();
  } catch (e) { $('#recGenStatus').textContent = ''; toast(e.message, true); }
});

// ───────────────────────── SPV INBOX ─────────────────────────
$('#inboxRefresh').addEventListener('click', loadInbox);
async function loadInbox() {
  const box = $('#inboxList'); box.innerHTML = '<p class="muted">Se încarcă…</p>';
  try {
    const msgs = await api('/api/anaf/inbox?zile=60');
    if (!msgs.length) { box.innerHTML = '<p class="muted">Nicio factură primită în ultimele 60 de zile.</p>'; return; }
    box.innerHTML = `<table><thead><tr><th>Data</th><th>Emitent (CIF)</th><th>Detalii</th><th></th></tr></thead><tbody>${
      msgs.map((m) => `<tr><td>${m.data || ''}</td><td>${m.cif || ''}</td><td>${(m.detalii || '').slice(0, 60)}</td>
        <td>${m.importat ? '<span class="pill">importată</span>' : `<button class="linkbtn spvimp" data-id="${m.id}">importă</button>`}</td></tr>`).join('')}</tbody></table>`;
    $$('#inboxList .spvimp').forEach((b) => b.addEventListener('click', () => importFromSpv(b.dataset.id)));
  } catch (e) { box.innerHTML = `<p class="status err">${e.message}</p>`; }
}
async function importFromSpv(msgId) {
  const st = $('#uploadStatus'); st.className = 'status'; st.textContent = 'Se importă factura din SPV…';
  try {
    const res = await api('/api/anaf/import/' + msgId, { method: 'POST' });
    st.className = 'status ok'; st.textContent = 'Importat din SPV. Verifică și salvează.';
    CURRENT = { documentId: res.documentId, fields: res.fields, suggestedType: res.suggestedType, spvMsgId: res.msgId };
    openForm(res.suggestedType, res.fields);
  } catch (e) { st.className = 'status err'; st.textContent = e.message; }
}
$('#cancelEntry').addEventListener('click', closeForm);

// ── Import direct e-Factura (XML UBL) ──
$('#efImportFile') && $('#efImportFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { $('#efImportXml').value = await f.text(); $('#efParseBtn').click(); } catch (err) { toast(err.message, true); }
});
$('#efParseBtn') && $('#efParseBtn').addEventListener('click', async () => {
  const xml = $('#efImportXml').value.trim();
  if (!xml) return toast('Încarcă sau lipește un XML de e-Factura', true);
  const box = $('#efPreview'); box.innerHTML = '<p class="muted">Se citește…</p>';
  try {
    const r = await api('/api/efactura/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xml }) });
    const inv = r.invoice;
    const liniiHtml = (inv.linii || []).length
      ? `<table style="margin-top:6px"><thead><tr><th>Denumire</th><th class="num">Cant.</th><th class="num">Preț</th><th class="num">Valoare</th><th class="num">TVA%</th></tr></thead><tbody>${
        inv.linii.map((l) => `<tr><td>${H(l.nume)}</td><td class="num">${fmt(l.cantitate)}</td><td class="num">${fmt(l.pret)}</td><td class="num">${fmt(l.valoare)}</td><td class="num">${l.cota}</td></tr>`).join('')}</tbody></table>`
      : '';
    box.innerHTML = `<div class="card">
      <p style="margin:0 0 6px">${inv.tip === 'creditnote' ? '↩️ <b>Notă de credit (storno)</b>' : '🧾 <b>Factură de cumpărare</b>'} ${inv.moneda !== 'RON' ? '<span class="status err">— monedă ' + inv.moneda + ' (neacceptat automat)</span>' : ''}</p>
      <table>
        <tr><td>Furnizor</td><td><b>${H(inv.furnizor.nume || '—')}</b> ${inv.furnizor.cui ? '(CUI ' + H(inv.furnizor.cui) + ')' : ''}</td></tr>
        <tr><td>Număr / Data</td><td>${inv.numar || '—'} · ${inv.data || '—'}</td></tr>
        <tr><td>Bază impozabilă</td><td class="num">${fmt(inv.baza)}</td></tr>
        <tr><td>TVA (${inv.cota}%)</td><td class="num">${fmt(inv.tva)}</td></tr>
        <tr class="total"><td>Total de plată</td><td class="num">${fmt(inv.total)}</td></tr>
      </table>${liniiHtml}
      <button id="efImportBtn" class="btn primary" style="margin-top:8px" ${inv.moneda !== 'RON' ? 'disabled' : ''}>✓ Importă ca factură de cumpărare</button>
    </div>`;
    const ib = $('#efImportBtn');
    if (ib) ib.addEventListener('click', async () => {
      ib.disabled = true;
      try {
        const res = await api('/api/efactura/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xml, cont: $('#efImportCont').value }) });
        toast('e-Factura importată: ' + (res.entry.document || '') + ' — ' + res.entry.partener);
        $('#efImportXml').value = ''; $('#efPreview').innerHTML = ''; $('#efImportFile').value = '';
        loadEntries();
      } catch (err) { toast(err.message, true); ib.disabled = false; }
    });
  } catch (e) { box.innerHTML = `<p class="status err">${e.message}</p>`; }
});

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
    const pend = s.pending ? ' <span class="pill" style="background:#fff4e0;color:#b26a00" title="Ai inițiat plata — se activează după confirmarea Stripe">⏳ plată în așteptare</span>' : '';
    if (s.status === 'trial') return `<span class="pill" style="background:#eaf4ef;color:#0b6e4f">🎁 probă · ${s.zileRamase} ${s.zileRamase === 1 ? 'zi' : 'zile'}</span>${pend}`;
    if (s.status === 'active') return `<span class="pill" style="background:#eaf4ef;color:#0b6e4f">✓ activ${s.plan && s.plan !== 'grandfathered' ? ' · ' + (s.plan === 'pro' ? 'Pro' : 'Start') : ''}</span>`;
    if (s.status === 'expired') return `<span class="pill warn">probă expirată</span>${pend}`;
    return `<span class="pill warn">fără abonament</span>${pend}`;
  };
  box.innerHTML = `<table><thead><tr><th>Firmă</th><th>Stare abonament</th><th></th></tr></thead><tbody>${
    data.firme.map((f) => { const s = f._sub || {}; const needs = s.status === 'expired' || s.status === 'none';
      return `<tr><td>${H(f.nume)}${f.cui ? ' <span class="muted">(' + H(f.cui) + ')</span>' : ''}</td>
        <td>${stLabel(s)}</td>
        <td>${needs ? `<button class="linkbtn fbsub" data-id="${f.id}" data-nume="${H(f.nume)}" style="color:var(--accent);font-weight:700">abonează-te →</button>` : (s.status === 'trial' ? `<button class="linkbtn fbsub" data-id="${f.id}" data-nume="${H(f.nume)}">abonează firma acum</button>` : '')}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="muted" style="font-size:12px;margin-top:6px">Firma activă acum: <b>${H((data.firme.find((f) => f.id === data.firmaActiva) || {}).nume || '—')}</b>. Abonarea deschide plata (Stripe) pentru planul potrivit tipului tău.</p>`;
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
  if (c.status === 'active' && data.manageable) banner += `<div style="margin-top:8px"><button id="subPortal" class="btn">Gestionează / anulează abonamentul</button></div>`;
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
      <h3>${p.nume}</h3>
      <div class="plan-price">${p.pret === 0 ? 'Gratuit' : '<b>' + fmt(p.pret) + '</b> ' + p.moneda}<span>${p.pret === 0 ? '' : '/ ' + p.perioada}</span></div>
      <p class="plan-desc">${p.descriere || ''}</p>
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
function mountForm(host) {
  const target = $(host === 'emite' ? '#formHostEmite' : '#formHostDoc');
  const f = $('#entryForm');
  if (target && f.parentElement !== target) target.appendChild(f);
}
function openForm(tipId, fields, host) {
  mountForm(host);
  $('#noDoc').classList.add('hidden');
  const ne = $('#noDocEmit'); if (ne) ne.classList.add('hidden');
  $('#entryForm').classList.remove('hidden');
  $('#tipSelect').value = tipId || 'nota_contabila';
  renderFields(fields || {});
}
function closeForm() {
  $('#entryForm').classList.add('hidden');
  $('#noDoc').classList.remove('hidden');
  const ne = $('#noDocEmit'); if (ne) ne.classList.remove('hidden');
  CURRENT = null;
}

$('#tipSelect').addEventListener('change', () => renderFields(collectFields()));

function accountOptions(val) {
  return META.accounts.map((a) => `<option value="${a.cod}" ${a.cod === String(val) ? 'selected' : ''}>${a.cod} — ${a.nume}</option>`).join('');
}
function renderFields(values) {
  const tip = META.types.find((t) => t.id === $('#tipSelect').value);
  const box = $('#dynFields'); box.innerHTML = '';
  tip.fields.forEach((f) => {
    const v = values[f.name] != null ? values[f.name] : (f.default != null ? f.default : '');
    const id = 'fld_' + f.name;
    let input;
    if (f.type === 'select') input = `<select id="${id}">${f.options.map((o) => `<option value="${o.value}" ${o.value === String(v) ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`;
    else if (f.type === 'account') input = `<select id="${id}">${accountOptions(v)}</select>`;
    else if (f.type === 'date') input = `<input id="${id}" type="date" value="${v || ''}" />`;
    else if (f.type === 'number') input = `<input id="${id}" type="number" step="0.01" value="${v === '' ? '' : v}" />`;
    else if (f.type === 'items') input = `<div class="items-editor" id="${id}"><div class="items-rows"></div><button type="button" class="btn ghost small additem">＋ adaugă linie</button></div>`;
    else if (f.type === 'stoc') input = `<div class="stoc-editor" id="${id}"><div class="stoc-rows"></div><button type="button" class="btn ghost small addstoc">＋ produs din stoc</button><div class="muted" style="font-size:11.5px;margin-top:4px">Costul mărfii vândute (607=371) se calculează automat la <b>CMP</b>, la salvare.</div></div>`;
    else if (f.type === 'checkbox') input = `<input id="${id}" type="checkbox" ${v && v !== 'false' ? 'checked' : ''} style="width:auto;margin-left:8px;vertical-align:middle" />`;
    else input = `<input id="${id}" type="text" value="${(v || '').toString().replace(/"/g, '&quot;')}" />`;
    const wide = (f.name === 'explicatie' || f.type === 'account' || f.type === 'select' || f.type === 'items' || f.type === 'stoc' || f.type === 'checkbox') ? ' full' : '';
    box.insertAdjacentHTML('beforeend', `<label class="${wide ? 'full' : ''}">${f.label}${input}</label>`);
  });
  // initializeaza editoarele de linii
  box.querySelectorAll('.items-editor').forEach((ed) => {
    const name = ed.id.replace('fld_', '');
    const init = Array.isArray(values[name]) ? values[name] : [];
    init.forEach((it) => addItemRow(ed, it));
    ed.querySelector('.additem').addEventListener('click', () => { addItemRow(ed, {}); updatePreview(); });
    ed.addEventListener('input', updatePreview);
    ed.addEventListener('click', (e) => { if (e.target.classList.contains('delitem')) { e.target.closest('.item-row').remove(); updatePreview(); } });
  });
  box.querySelectorAll('.stoc-editor').forEach((ed) => {
    const name = ed.id.replace('fld_', '');
    initStocEditor(ed, Array.isArray(values[name]) ? values[name] : []);
  });
  box.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', updatePreview));
  updatePreview();
}
function addItemRow(ed, it) {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `<input class="it-nume" placeholder="Denumire" value="${H(it.nume)}">
    <input class="it-cant" type="number" step="0.001" placeholder="Cant." value="${it.cantitate != null ? it.cantitate : ''}">
    <input class="it-um" placeholder="UM" value="${it.um || 'buc'}">
    <input class="it-pret" type="number" step="0.01" placeholder="Preț" value="${it.pret != null ? it.pret : ''}">
    <input class="it-cota" type="number" placeholder="Cotă%" value="${it.cota != null ? it.cota : 21}">
    <button type="button" class="btn ghost small delitem">✕</button>`;
  ed.querySelector('.items-rows').appendChild(row);
}
function readItems(ed) {
  return [...ed.querySelectorAll('.item-row')].map((r) => ({
    nume: r.querySelector('.it-nume').value,
    cantitate: r.querySelector('.it-cant').value,
    um: r.querySelector('.it-um').value,
    pret: r.querySelector('.it-pret').value,
    cota: r.querySelector('.it-cota').value,
  })).filter((it) => it.nume && parseFloat(it.cantitate) > 0);
}
// ── Editor „descărcare din stoc" (produs + gestiune + cantitate); COGS la CMP, calculat de server ──
let STOCCACHE = null;
async function ensureStocCache() {
  try { STOCCACHE = { products: await api('/api/products'), gestiuni: await api('/api/gestiuni') }; }
  catch (_) { STOCCACHE = STOCCACHE || { products: [], gestiuni: [] }; }
  return STOCCACHE;
}
async function initStocEditor(ed, initLines) {
  await ensureStocCache();
  (initLines || []).forEach((l) => addStocRow(ed, l));
  if (!initLines || !initLines.length) addStocRow(ed, {});
  ed.querySelector('.addstoc').addEventListener('click', () => addStocRow(ed, {}));
  ed.addEventListener('click', (e) => { if (e.target.classList.contains('delstoc')) e.target.closest('.stoc-row').remove(); });
}
function addStocRow(ed, l) {
  const e = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const prods = (STOCCACHE && STOCCACHE.products) || [];
  const gests = (STOCCACHE && STOCCACHE.gestiuni) || [];
  const prodOpts = prods.length
    ? prods.map((p) => `<option value="${e(p.id)}" ${p.id === l.productId ? 'selected' : ''}>${e(p.cod)} — ${e(p.denumire)}</option>`).join('')
    : '<option value="">(niciun produs în nomenclator)</option>';
  const gestOpts = '<option value="">(fără gestiune)</option>' + gests.map((g) => `<option value="${e(g.id)}" ${g.id === l.gestiuneId ? 'selected' : ''}>${e(g.cod)} — ${e(g.denumire)}</option>`).join('');
  const row = document.createElement('div');
  row.className = 'stoc-row';
  row.innerHTML = `<select class="st-prod">${prodOpts}</select>
    <select class="st-gest">${gestOpts}</select>
    <input class="st-cant" type="number" step="0.001" placeholder="Cant." value="${l.cantitate != null ? l.cantitate : ''}">
    <button type="button" class="btn ghost small delstoc">✕</button>`;
  ed.querySelector('.stoc-rows').appendChild(row);
}
function readStoc(ed) {
  return [...ed.querySelectorAll('.stoc-row')].map((r) => ({
    productId: r.querySelector('.st-prod').value,
    gestiuneId: r.querySelector('.st-gest').value || null,
    cantitate: r.querySelector('.st-cant').value,
  })).filter((s) => s.productId && parseFloat(s.cantitate) > 0);
}
function collectFields() {
  const tip = META.types.find((t) => t.id === $('#tipSelect').value);
  const out = {};
  tip.fields.forEach((f) => {
    if (f.type === 'items') { const ed = $('#fld_' + f.name); if (ed) out[f.name] = readItems(ed); return; }
    if (f.type === 'stoc') { const ed = $('#fld_' + f.name); if (ed) out[f.name] = readStoc(ed); return; }
    if (f.type === 'checkbox') { const el = $('#fld_' + f.name); if (el) out[f.name] = el.checked; return; }
    const el = $('#fld_' + f.name); if (el) out[f.name] = el.value;
  });
  return out;
}
function localBuild(tipId, f) {
  // replica simplificata pentru previzualizare (server ramane sursa de adevar)
  const r2 = (x) => Math.round(x * 100) / 100;
  // daca exista linii detaliate, baza si TVA se calculeaza din ele
  if (Array.isArray(f.items) && f.items.length) {
    let b = 0; let t = 0;
    f.items.forEach((it) => { const x = r2((parseFloat(it.cantitate) || 0) * (parseFloat(it.pret) || 0)); b = r2(b + x); t = r2(t + (x * (parseFloat(it.cota) || 0)) / 100); });
    f.baza = b; f.tva = t;
  }
  const n = (x) => parseFloat(f[x]) || 0;
  const L = (d, c, s, e) => ({ debit: d, credit: c, suma: r2(s), explicatie: e });
  const m = {
    factura_vanzare_marfuri: () => [L('4111', '707', n('baza'), 'Venit marfuri'), n('tva') > 0 && L('4111', '4427', n('tva'), 'TVA colectata'), n('cost') > 0 && L('607', '371', n('cost'), 'Cost marfa')],
    factura_vanzare_produse: () => [L('4111', '701', n('baza'), 'Venit produse'), n('tva') > 0 && L('4111', '4427', n('tva'), 'TVA colectata')],
    factura_vanzare_servicii: () => [L('4111', '704', n('baza'), 'Venit servicii'), n('tva') > 0 && L('4111', '4427', n('tva'), 'TVA colectata')],
    bon_fiscal_z: () => [L(f.incasare || '5311', '707', n('baza'), 'Vanzare amanuntul'), n('tva') > 0 && L(f.incasare || '5311', '4427', n('tva'), 'TVA colectata')],
    factura_cumparare_marfuri: () => [L('371', '401', n('baza'), 'Marfuri'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_cumparare_materii: () => [L(f.contStoc || '301', '401', n('baza'), 'Materii'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_utilitati: () => [L('605', '401', n('baza'), 'Energie/apa'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_servicii_primita: () => [L(f.contChelt || '628', '401', n('baza'), 'Servicii'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_combustibil: () => [L('6022', '401', n('baza'), 'Combustibil'), n('tva') > 0 && L('4426', '401', n('tva'), 'TVA deductibila')],
    factura_imobilizare: () => [L(f.contImob || '2131', '404', n('baza'), 'Imobilizare'), n('tva') > 0 && L('4426', '404', n('tva'), 'TVA deductibila')],
    achizitie_intracomunitara: () => { const t = r2(n('baza') * (n('cota') || 19) / 100); return [L(f.contStoc || '371', '401', n('baza'), 'Achizitie IC'), L('4426', '4427', t, 'Taxare inversa')]; },
    livrare_intracomunitara: () => [L('4111', '707', n('baza'), 'Livrare IC')],
    incasare_client: () => [L(f.cont || '5121', '4111', n('suma'), 'Incasare client')],
    plata_furnizor: () => [L(f.contFz || '401', f.cont || '5121', n('suma'), 'Plata furnizor')],
    depunere_numerar: () => [L('581', '5311', n('suma'), 'Ridicare casa'), L('5121', '581', n('suma'), 'Depunere banca')],
    ridicare_numerar: () => [L('581', '5121', n('suma'), 'Ridicare banca'), L('5311', '581', n('suma'), 'Intrare casa')],
    comision_bancar: () => [L('627', '5121', n('suma'), 'Comision bancar')],
    stat_plata: () => {
      let cas = n('cas'); let cass = n('cass'); let imp = n('impozit'); let cam = n('cam');
      const fp = (META.fiscal) || { cas: 25, cass: 10, impozitVenit: 10, cam: 2.25 };
      if (n('brut') > 0 && !cas && !cass && !imp && !cam) {
        cas = r2(n('brut') * fp.cas / 100); cass = r2(n('brut') * fp.cass / 100);
        const baza = Math.max(0, r2(n('brut') - cas - cass - n('neimpozabil')));
        imp = r2(baza * fp.impozitVenit / 100); cam = r2(n('brut') * fp.cam / 100);
      }
      return [L('641', '421', n('brut'), 'Salarii brute'), cas > 0 && L('421', '4315', cas, 'CAS'), cass > 0 && L('421', '4316', cass, 'CASS'), imp > 0 && L('421', '444', imp, 'Impozit'), cam > 0 && L('646', '436', cam, 'CAM')];
    },
    avans_incasat_client: () => [L(f.cont || '5121', '419', n('suma'), 'Avans incasat client')],
    avans_platit_furnizor: () => [L('409', f.cont || '5121', n('suma'), 'Avans platit furnizor')],
    lucrari_in_curs: () => f.sens === 'reluare' ? [L('712', '332', n('suma'), 'Reluare lucrari in curs')] : [L('332', '712', n('suma'), 'Lucrari in curs')],
    garantie_retinuta: () => [L('2678', '4111', n('suma'), 'Garantie retinuta')],
    garantie_restituita: () => [L(f.cont || '5121', '2678', n('suma'), 'Restituire garantie')],
    horeca_intrare: () => { const o = [L('371', '401', n('cost'), 'Marfa la cost')]; if (n('tvaDed') > 0) o.push(L('4426', '401', n('tvaDed'), 'TVA deductibila')); if (n('adaos') > 0) o.push(L('371', '378', n('adaos'), 'Adaos')); const tn = r2((n('cost') + n('adaos')) * (n('cotaVanzare') || 11) / 100); if (tn > 0) o.push(L('371', '4428', tn, 'TVA neexigibila')); return o; },
    horeca_vanzare: () => { const o = []; if (n('numerar') > 0) o.push(L('5311', '707', n('numerar'), 'Numerar')); if (n('card') > 0) o.push(L('5121', '707', n('card'), 'Card')); const tot = r2(n('numerar') + n('card')); const c = n('cota') || 11; const tc = r2(tot * c / (100 + c)); if (tc > 0) o.push(L('4428', '4427', tc, 'TVA colectata')); if (n('cost') > 0) o.push(L('607', '371', n('cost'), 'Cost')); if (n('adaos') > 0) o.push(L('378', '371', n('adaos'), 'Adaos')); return o; },
    diferenta_curs: () => f.sens === 'nefavorabila' ? [L('665', f.contTert || '401', n('suma'), 'Diferenta nefavorabila')] : [L(f.contTert || '5124', '765', n('suma'), 'Diferenta favorabila')],
    combustibil_50: () => { const tt = r2(n('baza') * (n('cota') || 21) / 100); const td = r2(tt * 0.5); const tn = r2(tt - td); const o = [L('6022', '401', n('baza'), 'Combustibil')]; if (td > 0) o.push(L('4426', '401', td, 'TVA ded. 50%')); if (tn > 0) o.push(L('6022', '401', tn, 'TVA nded. 50%')); return o; },
    taxe_drum: () => [L('635', '446', n('suma'), 'Rovinieta/taxe drum')],
    plata_salarii: () => [L('421', f.cont || '5121', n('suma'), 'Plata salarii')],
    amortizare: () => [L('6811', f.contAmort || '281', n('suma'), 'Amortizare')],
    factura_storno_vanzare: () => [L('4111', '707', -n('baza'), 'Storno venit'), n('tva') > 0 && L('4111', '4427', -n('tva'), 'Storno TVA colectata')],
    factura_storno_cumparare: () => [L(f.contStoc || '371', '401', -n('baza'), 'Storno achizitie'), n('tva') > 0 && L('4426', '401', -n('tva'), 'Storno TVA deductibila')],
    bon_consum: () => [L(f.contChelt || '601', f.contStoc || '301', n('suma'), 'Consum din stoc')],
    acordare_avans: () => [L('542', f.cont || '5311', n('suma'), 'Avans de trezorerie acordat')],
    decont_deplasare: () => [L(f.contChelt || '625', f.cont || '542', n('suma'), 'Decont deplasare')],
    dobanda_bancara: () => [L('666', '5121', n('suma'), 'Cheltuieli cu dobanzile')],
    import_vamal: () => { const baza = r2(n('valoareBunuri') + n('taxeVamale')); const tva = r2(baza * (n('cota') || 21) / 100); const o = [L(f.contBun || '371', '401', n('valoareBunuri'), 'Import bunuri')]; if (n('taxeVamale') > 0) o.push(L(f.contBun || '371', '446', n('taxeVamale'), 'Taxe vamale')); o.push(L('4426', '446', tva, 'TVA in vama')); return o; },
    diferente_inventar: () => f.sens === 'plus' ? [L(f.contStoc || '371', f.contChelt || '607', n('suma'), 'Plus la inventar')] : [L(f.contChelt || '607', f.contStoc || '371', n('suma'), 'Minus la inventar')],
    casare_mijloc_fix: () => { const ramas = r2(n('valoare') - n('amortizare')); const o = []; if (n('amortizare') > 0) o.push(L(f.contAmort || '281', f.contImob || '2131', n('amortizare'), 'Scadere amortizare')); if (ramas > 0) o.push(L('6583', f.contImob || '2131', ramas, 'Valoare ramasa')); return o; },
    imputare_lipsa: () => { const tva = r2(n('valoareImputata') * (n('cota') || 21) / 100); const o = [L(f.contCreanta || '4282', '7588', n('valoareImputata'), 'Imputare lipsa - venit')]; if (tva > 0) o.push(L(f.contCreanta || '4282', '4427', tva, 'TVA imputare')); return o; },
    plata_taxe: () => [L(f.contTaxa || '446', f.cont || '5121', n('suma'), 'Plata taxe/impozite')],
    nota_contabila: () => [L(f.debit || '?', f.credit || '?', n('suma'), f.explicatie || 'Nota')],
  };
  return (m[tipId] ? m[tipId]() : []).filter(Boolean);
}
function updatePreview() {
  const tipId = $('#tipSelect').value;
  const f = collectFields();
  const lines = localBuild(tipId, f);
  const total = lines.reduce((s, l) => s + l.suma, 0);
  $('#preview').innerHTML = lines.length
    ? lines.map((l) => `<span class="pd">${l.debit}</span> ${accName(l.debit)} = <span class="pc">${l.credit}</span> ${accName(l.credit)}  →  <b>${fmt(l.suma)}</b> lei`).join('\n')
      + `\n──────────\nTotal articol: <b>${fmt(total)}</b> lei`
    : 'Completează câmpurile pentru a vedea articolul contabil.';
}

$('#entryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('/api/entries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tip: $('#tipSelect').value, fields: collectFields(), fileId: CURRENT && CURRENT.documentId, spvMsgId: CURRENT && CURRENT.spvMsgId }),
    });
    toast('Înregistrare salvată: ' + res.entry.id);
    closeForm();
    setMeta(await api('/api/meta')); fillPeriods();
    await loadEntries();
  } catch (err) { toast(err.message, true); }
});

// ───────────────────────── ENTRIES LIST ─────────────────────────
// Clasifica o inregistrare: intrare (cumparare), iesire (vanzare) sau alta operatiune interna
function entryDir(tip) {
  const t = (META.types || []).find((x) => x.id === tip);
  const grup = t ? t.grup : '';
  if (grup === 'Vanzari' || /vanzare|^livrare_intra|^bon_fiscal/.test(tip)) return 'out';
  if (grup === 'Cumparari' || /cumparare/.test(tip)) return 'in';
  return 'other';
}
function entryRowHtml(e) {
  const formula = e.lines.map((l) => `${l.debit}=${l.credit}`).join(', ');
  const total = e.lines.reduce((s, l) => s + l.suma, 0);
  return `<tr class="${e.system ? 'sys' : ''}">
    <td>${H(e.data)}</td>
    <td>${H(e.tipNume)}${e.system ? ' <span class="pill">auto</span>' : ''}</td>
    <td>${H(e.partener)}</td>
    <td class="acc">${H(formula)}</td>
    <td class="num">${fmt(total)}</td>
    <td><a class="linkbtn" href="/pdf/note/${e.id}" target="_blank">PDF</a>
        ${e.lines.some((l) => /^531/.test(String(l.debit))) ? ` · <a class="linkbtn" href="/pdf/chitanta/${e.id}" target="_blank" title="Chitanta pentru incasarea in numerar (numar din seria CH)">chitanță</a>` : ''}
        ${EFACT_TYPES.has(e.tip) ? ` · <a class="linkbtn" href="/xml/efactura/${e.id}" target="_blank">e-Factura</a>` : ''}
        ${SENDABLE_TYPES.has(e.tip) ? (e.spv
    ? ` · <button class="linkbtn spvstat" data-id="${e.id}">SPV: ${e.spv.stare}${e.spv.acceptat ? ' ✓' : ''}</button>${e.spv.idDescarcare ? ` · <button class="linkbtn spvdl" data-id="${e.id}">recipisă</button>` : ''}`
    : ` · <button class="linkbtn spvsend" data-id="${e.id}">trimite SPV</button>`) : ''}
        ${e.fileId ? ` · <a class="linkbtn" href="/api/document/${e.fileId}/file" target="_blank">doc</a>` : ''}</td>
    <td><button class="del" data-id="${e.id}" title="Șterge">✕</button></td>
  </tr>`;
}
function renderEntryTable(containerId, rowsHtml, emptyMsg) {
  const el = $('#' + containerId); if (!el) return;
  if (!rowsHtml) { el.innerHTML = `<p class="muted">${emptyMsg}</p>`; return; }
  el.innerHTML = `<table><thead><tr>
    <th>Data</th><th>Tip</th><th>Partener</th><th>Formulă</th><th class="num">Sumă</th><th>Fișiere</th><th></th>
    </tr></thead><tbody>${rowsHtml}</tbody></table>`;
  bindEntryActions(el);
}
function bindEntryActions(root) {
  root.querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi această înregistrare?')) return;
    await api('/api/entries/' + b.dataset.id, { method: 'DELETE' });
    toast('Înregistrare ștearsă');
    setMeta(await api('/api/meta')); fillPeriods(); loadEntries();
  }));
  root.querySelectorAll('.spvsend').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'se trimite…';
    try { const r = await api('/api/anaf/send/' + b.dataset.id, { method: 'POST' }); toast('Trimis în SPV (index ' + r.spv.index + ')'); loadEntries(); }
    catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'trimite SPV'; }
  }));
  root.querySelectorAll('.spvstat').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api('/api/anaf/status/' + b.dataset.id, { method: 'POST' }); toast('Stare SPV: ' + r.spv.stare + (r.spv.acceptat ? ' (acceptată)' : '')); loadEntries(); }
    catch (e) { toast(e.message, true); }
  }));
  root.querySelectorAll('.spvdl').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api('/api/anaf/download/' + b.dataset.id, { method: 'POST' }); toast('Recipisă descărcată'); window.open('/api/document/' + r.documentId + '/file', '_blank'); loadEntries(); }
    catch (e) { toast(e.message, true); }
  }));
}
let ENTRIES_CACHE = [];
function inPeriodClient(e, period) {
  if (!period) return true;
  return (e.period || (e.data || '').slice(0, 7)).startsWith(period);
}
async function loadEntries() {
  ENTRIES_CACHE = await api('/api/entries');
  renderEntryLists();
}
function renderEntryLists() {
  const ordered = ENTRIES_CACHE.slice().reverse();
  // 📥 intrate (filtrate pe Lună+An)
  const pi = pget('intrate');
  let intr = ordered.filter((e) => entryDir(e.tip) === 'in');
  if (pi) intr = intr.filter((e) => inPeriodClient(e, pi));
  if ($('#countIntrare')) $('#countIntrare').textContent = intr.length + ' documente';
  renderEntryTable('entriesIntrare', intr.map(entryRowHtml).join(''), 'Niciun document de intrare în perioada aleasă.');
  // 📤 ieșite
  const po = pget('iesite');
  let ies = ordered.filter((e) => entryDir(e.tip) === 'out');
  if (po) ies = ies.filter((e) => inPeriodClient(e, po));
  if ($('#countIesire')) $('#countIesire').textContent = ies.length + ' documente';
  renderEntryTable('entriesIesire', ies.map(entryRowHtml).join(''), 'Niciun document de ieșire în perioada aleasă.');
  // toate
  const pt = pget('toate');
  let toate = ordered;
  if (pt) toate = toate.filter((e) => inPeriodClient(e, pt));
  if ($('#entriesCount')) $('#entriesCount').textContent = toate.length + ' înregistrări';
  renderEntryTable('entriesList', toate.map(entryRowHtml).join(''), 'Nicio înregistrare în perioada aleasă.');
}
onPeriodChange('intrate', renderEntryLists);
onPeriodChange('iesite', renderEntryLists);
onPeriodChange('toate', renderEntryLists);

// Documente așteptate / lipsă — detectează furnizorii recurenți care lipsesc în luna selectată
async function loadMissingDocs() {
  const el = $('#missingDocs'); if (!el) return;
  let p = pget('intrate');
  if (!/^\d{4}-\d{2}$/.test(p)) p = workMonth(); // analiza e lunară
  let d; try { d = await api('/api/missing-docs?period=' + p); } catch (e) { el.innerHTML = ''; return; }
  const lbl = lunaLabel(d.period);
  const alert = d.missing.length || d.countThis < d.avgPrev;
  el.innerHTML = `<div class="missingbox${alert ? '' : ' ok'}">
    <span class="wi">${alert ? '⚠️' : '✅'}</span>
    <div><b>${lbl}:</b> ${d.countThis} documente intrate · media ultimelor 3 luni: <b>${d.avgPrev}</b>${d.countThis < d.avgPrev ? ' <span class="muted">(sub medie — verifică ce lipsește)</span>' : ''}
      ${d.missing.length
    ? `<div style="margin-top:8px"><b>Posibil lipsă</b> — furnizori care apăreau lunar, dar fără document în ${lbl}:</div>
           <ul class="checklist todo" style="margin-top:4px">${d.missing.map((m) => `<li>${m.partener} <span class="muted">— ultima oară: ${lunaLabel(m.ultimaLuna)} · ${m.luniPrezent}/3 luni anterioare</span></li>`).join('')}</ul>`
    : '<div style="margin-top:6px">✓ Nu pare să lipsească niciun document recurent.</div>'}
    </div></div>`;
}

// ───────────────────────── ARHIVĂ DOCUMENTE ─────────────────────────
async function loadArhiva() {
  const p = pget('arhiva') || workMonth();
  const monthly = /^\d{4}-\d{2}$/.test(p);
  const yr = p.slice(0, 4);
  const pq = '?period=' + p; const yq = '?year=' + yr;
  const all = await api('/api/entries');
  const inPer = (e) => (e.period || (e.data || '').slice(0, 7)).startsWith(p);
  const intr = all.filter((e) => entryDir(e.tip) === 'in' && inPer(e));
  const ies = all.filter((e) => entryDir(e.tip) === 'out' && inPer(e));
  const total = (e) => fmt(e.lines.reduce((s, l) => s + l.suma, 0));
  const row = (e, extra) => `<tr><td>${H(e.data)}</td><td>${H(e.tipNume)}</td><td>${H(e.partener)}</td><td class="num">${total(e)}</td>
    <td><a class="linkbtn" href="/pdf/note/${e.id}" target="_blank">PDF</a>${e.fileId ? ` · <a class="linkbtn" href="/api/document/${e.fileId}/file" target="_blank">doc</a>` : ''}${extra ? extra(e) : ''}</td></tr>`;
  const tbl = (arr, extra, empty) => arr.length
    ? `<table><thead><tr><th>Data</th><th>Document</th><th>Partener</th><th class="num">Sumă</th><th>Fișiere</th></tr></thead><tbody>${arr.map((e) => row(e, extra)).join('')}</tbody></table>`
    : `<p class="muted">${empty}</p>`;
  const L = (href, label) => `<a class="btn small arh-link" href="${href}" target="_blank">${label}</a>`;
  const G = (tab, label) => `<button class="btn small arh-link" data-go="${tab}">${label}</button>`;
  const eFact = (e) => (EFACT_TYPES.has(e.tip) ? ` · <a class="linkbtn" href="/xml/efactura/${e.id}" target="_blank">e-Factura</a>` : '');
  const declMonthly = L('/pdf/d300' + pq, '⬇ D300 PDF') + L('/xml/d300' + pq, 'D300 XML') + L('/xml/d394' + pq, 'D394 XML') + L('/xml/d390' + pq, 'D390 XML (VIES)') + L('/xml/d100' + pq, 'D100 XML (trim.)') + L('/csv/intrastat' + pq, 'Intrastat CSV') + L('/xml/intrastat' + pq, 'Intrastat XML') + L('/pdf/d112' + pq, '⬇ D112 PDF') + L('/xml/d112' + pq, 'D112 XML') + L('/xml/d205' + yq, 'D205 XML (an)') + L('/xml/saft' + yq, 'SAF-T XML');
  $('#arhivaView').innerHTML = `
    <div class="card"><h3>📥 01 · Intrări (facturi primite)</h3>
      <p class="muted">Facturi de la furnizori, bonuri, chitanțe — cu fișierul scanat atașat.</p>${tbl(intr, null, 'Niciun document de intrare în perioadă.')}</div>
    <div class="card"><h3>📤 02 · Ieșiri (facturi emise)</h3>
      <p class="muted">Facturi către clienți — cu PDF și e-Factura.</p>${tbl(ies, eFact, 'Niciun document de ieșire în perioadă.')}</div>
    <div class="grid2">
      <div class="card"><h3>🏦 03 · Bancă</h3><p class="muted">Jurnalul de bancă (5121) și extrasele importate.</p>${G('cashbook', 'Deschide Bancă / Casă')}</div>
      <div class="card"><h3>💵 04 · Casă</h3><p class="muted">Registrul de casă (5311) — încasări/plăți în numerar.</p>${G('cashbook', 'Deschide Bancă / Casă')}</div>
    </div>
    <div class="card"><h3>👥 05 · Salarii</h3>
      <p class="muted">State de plată și declarația D112.</p>${monthly ? L('/pdf/stat-plata' + pq, '⬇ Stat de plată PDF') + L('/xml/d112' + pq, 'D112 XML') : '<span class="muted">Alege o lună pentru statul de plată.</span>'}</div>
    <div class="card"><h3>🧾 06 · Declarații ANAF</h3>
      <p class="muted">Declarațiile fiscale ale perioadei.${monthly ? '' : ' <b>Alege o lună</b> pentru declarațiile lunare (D300/D394/D112).'}</p>${monthly ? declMonthly : L('/xml/saft' + yq, 'SAF-T XML (an întreg)')}
      ${monthly ? `<div style="margin-top:8px"><button id="validateDecl" class="btn small" data-p="${p}" data-yr="${yr}">🔍 Verifică declarațiile (pre-depunere)</button><div id="validateResult" style="margin-top:6px"></div></div>` : ''}
      <p class="muted" style="font-size:12px;margin-top:8px">⚠️ Ciorne — verificarea de mai sus prinde erorile frecvente, dar validează final cu <b>DUKIntegrator</b> / XSD ANAF înainte de depunere.</p></div>
    <div class="card"><h3>📚 07 · Registre & Bilanț</h3>
      <p class="muted">Registrele obligatorii și situațiile financiare.</p>
      ${L('/pdf/journal' + pq, '⬇ Registru-jurnal PDF')}${L('/csv/journal' + pq, 'Jurnal CSV')}${L('/pdf/ledger' + pq, '⬇ Cartea mare PDF')}${L('/pdf/balance' + pq, '⬇ Balanță PDF')}${L('/csv/balance' + pq, 'Balanță CSV')}${L('/pdf/pl' + yq, '⬇ Cont P&P PDF')}${L('/pdf/bilant' + pq, '⬇ Bilanț PDF')}</div>`;
  $$('#arhivaView [data-go]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.go)));
  const vb = $('#validateDecl');
  if (vb) vb.addEventListener('click', async () => {
    vb.disabled = true; const out = $('#validateResult'); out.innerHTML = '<span class="muted">Se verifică…</span>';
    const types = [['d300', 'D300'], ['d394', 'D394'], ['d390', 'D390'], ['d112', 'D112']];
    const results = [];
    for (const [t, label] of types) {
      try { const r = await api('/api/validate/' + t + '?period=' + vb.dataset.p + '&year=' + vb.dataset.yr); results.push(Object.assign({ label }, r)); }
      catch (e) { results.push({ label, ok: false, errors: [e.message], warnings: [] }); }
    }
    out.innerHTML = results.map((r) => {
      const icon = r.ok ? (r.warnings.length ? '⚠️' : '✅') : '❌';
      const msgs = [...r.errors.map((m) => `<span style="color:var(--danger)">✗ ${m}</span>`), ...r.warnings.map((m) => `<span class="muted">⚠ ${m}</span>`)];
      return `<div style="margin:3px 0;font-size:13px"><b>${icon} ${r.label}</b>${msgs.length ? ': ' + msgs.join(' · ') : ' — fără probleme'}</div>`;
    }).join('');
    vb.disabled = false;
  });
}
onPeriodChange('arhiva', loadArhiva);

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
    iban: f.iban.value.trim(), banca: f.banca.value.trim(), telefon: f.telefon.value.trim(), email: f.email.value.trim(), capitalSocial: f.capitalSocial.value.trim(), accentColor: f.accentColor.value, pdfLayout: f.pdfLayout.value, pdfFooter: f.pdfFooter.value.trim(), asociatiText: f.asociatiText.value.trim(), proRataTva: f.proRataTva.value ? Number(f.proRataTva.value) : '' };
  const r = await api('/api/company', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  META.company = r.company || body; $('#companyName').textContent = body.nume; toast('Date firmă salvate' + (body.tvaLaIncasare ? ' · regim TVA la încasare ACTIV' : ''));
});
$('#seedBtn').addEventListener('click', async () => {
  $('#seedStatus').textContent = 'Se încarcă…';
  try { const r = await api('/api/seed', { method: 'POST' }); $('#seedStatus').textContent = r.message; setMeta(await api('/api/meta')); fillPeriods(); loadEntries(); toast('Exemplu încărcat'); }
  catch (e) { $('#seedStatus').textContent = e.message; }
});

if (/[?&]anaf=ok/.test(location.search)) toast('Conectat la SPV ANAF');
if (/[?&]anaf=error/.test(location.search)) toast('Autorizarea ANAF a eșuat', true);

// Acceptarea unei invitatii: ?invite=TOKEN -> formular de setare parola in overlay
const inviteToken = new URLSearchParams(location.search).get('invite');
async function startInvite(token) {
  showLogin();
  let info;
  try { info = await api('/api/invite/' + token); }
  catch (e) { $('#loginErr').textContent = 'Invitație invalidă sau expirată.'; return; }
  const box = $('#loginForm');
  box.innerHTML = `<div class="login-logo">▦ Contabo</div>
    <p class="muted">Bun venit, <b>${info.username}</b>. Setează-ți parola.</p>
    <label>Parolă nouă <input name="password" type="password" autocomplete="new-password" required minlength="8" /></label>
    <div id="loginErr" class="status err"></div>
    <button class="btn primary" style="width:100%">Activează contul</button>`;
  box.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/invite/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: box.password.value }) });
      history.replaceState({}, '', location.pathname);
      hideLogin(); await init(); toast('Cont activat. Bun venit!');
    } catch (err) { $('#loginErr').textContent = err.message; }
  };
}
const resetToken = new URLSearchParams(location.search).get('reset');
async function startReset(token) {
  showLogin();
  let info;
  try { info = await api('/api/reset/' + token); }
  catch (e) { $('#loginErr').textContent = 'Link de resetare invalid sau expirat.'; return; }
  const box = $('#loginForm');
  box.innerHTML = `<div class="login-logo">▦ Contabo</div>
    <p class="muted">Resetare parolă pentru <b>${info.username}</b>.</p>
    <label>Parolă nouă <input name="password" type="password" autocomplete="new-password" required minlength="8" /></label>
    <div id="loginErr" class="status err"></div>
    <button class="btn primary" style="width:100%">Salvează parola</button>`;
  box.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/reset/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: box.password.value }) });
      history.replaceState({}, '', location.pathname);
      hideLogin(); await init(); toast('Parolă resetată. Bun venit!');
    } catch (err) { $('#loginErr').textContent = err.message; }
  };
}
if (inviteToken) startInvite(inviteToken);
else if (resetToken) startReset(resetToken);
else init().catch((e) => toast(e.message, true));
