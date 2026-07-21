'use strict';

// Autentificare UI: login/2FA, inscriere + preturi, parola uitata/reset, invitatii, schimbarea fortata a parolei.
// Extras din app.js (faza 2); apelurile inapoi spre app.js vin prin setDeps (fara cicluri).
import { $$, $, H, fmt, accName, toast, setLoad, api, setOn402 } from './core.js';

const D = { init: null, goTab: null, promptFirmaSubscribe: null };
function setAuthuiDeps(d) { Object.assign(D, d); }

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
setOn402((data) => D.promptFirmaSubscribe(data.firmaId, data.firmaNume));
// Dupa expirarea probei unei firme: avertisment + intrebare de abonare; la „Da" -> plata Stripe
// (Start pentru necontabili / Pro pentru contabili) si deblocarea firmei pe luna curenta.
function showLogin() { $('#loginOverlay').classList.remove('hidden'); checkRegisterEnabled(); }
function hideLogin() { $('#loginOverlay').classList.add('hidden'); }
async function checkRegisterEnabled() {
  try { const r = await fetch('/api/register'); if (!r.ok) return; const d = await r.json(); $('#registerBtn') && $('#registerBtn').classList.toggle('hidden', !d.enabled); }
  catch (e) { /* ignora */ }
}
$('#registerBtn') && $('#registerBtn').addEventListener('click', () => {
  pendingPaidPlan = null; // „Testeaza gratuit" = inscriere simpla, fara plan platit in asteptare
  $('#registerErr').textContent = ''; openRegisterPanel();
});
// „Demo": intra in contul demo public (explorare libera, date resetate zilnic). Doua conturi
// partajate care demonstreaza colaborarea pe aceeasi firma: patronul (demo) si contabilul (demo-contabil).
function demoLogin(btn, as) {
  return async () => {
    btn.disabled = true;
    try { await api('/api/demo-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(as ? { as } : {}) }); $('#loginOverlay').classList.add('hidden'); await D.init(); toast('Ai intrat în contul demo ' + (as === 'contabil' ? 'contabil' : 'patron') + ' — explorează liber!'); }
    catch (err) { toast(err.message, true); btn.disabled = false; }
  };
}
$('#demoLoginBtn') && $('#demoLoginBtn').addEventListener('click', (e) => demoLogin(e.currentTarget)());
$('#demoContabilBtn') && $('#demoContabilBtn').addEventListener('click', (e) => demoLogin(e.currentTarget, 'contabil')());
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
      : '<div class="muted" data-u="u17">Autentifică-te pentru a alege planul</div>';
    const demo = p.trial ? '<button class="btn pricing-demo" data-u="u18">🔎 Intră în contul demo</button>' : '';
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
      await D.init();
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
    await D.init();
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
    f.password.value = ''; hideLogin(); await D.init();
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
    await D.init();
    D.goTab('setari');
    setTimeout(() => { const t = $('#twofaStart'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 250);
  } catch (ex) { err.textContent = ex.message; }
});
$('#forgotLink').addEventListener('click', () => {
  const box = $('#loginForm');
  box.innerHTML = `<div class="login-logo">▦ Contabo</div>
    <p class="muted">Recuperare parolă — introdu utilizatorul sau emailul.</p>
    <label>Utilizator / email <input name="login" required /></label>
    <div id="loginErr" class="status"></div>
    <button class="btn primary" data-u="u19">Trimite link de resetare</button>
    <p data-u="u20"><a id="forgotBack" class="link">← Înapoi la autentificare</a></p>`;
  $('#forgotBack').addEventListener('click', () => location.reload());
  box.onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api('/api/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: box.login.value }) }); $('#loginErr').className = 'status ok'; $('#loginErr').textContent = r.message; }
    catch (err) { $('#loginErr').textContent = err.message; }
  };
});
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
    <button class="btn primary" data-u="u19">Activează contul</button>`;
  box.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/invite/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: box.password.value }) });
      history.replaceState({}, '', location.pathname);
      hideLogin(); await D.init(); toast('Cont activat. Bun venit!');
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
    <button class="btn primary" data-u="u19">Salvează parola</button>`;
  box.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/reset/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: box.password.value }) });
      history.replaceState({}, '', location.pathname);
      hideLogin(); await D.init(); toast('Parolă resetată. Bun venit!');
    } catch (err) { $('#loginErr').textContent = err.message; }
  };
}
// Pornirea fluxurilor de invitatie/resetare din URL. Apelata de app.js LA FINAL (dupa
// setAuthuiDeps) — nu la evaluarea modulului, cand D.init inca nu e legat. Intoarce true
// daca a preluat pornirea (app.js nu mai cheama init()).
function bootAuth() {
  if (inviteToken) { startInvite(inviteToken); return true; }
  if (resetToken) { startReset(resetToken); return true; }
  return false;
}

export { bootAuth, handleRegisterLink, hideLogin, openRegisterPanel, setAuthuiDeps, showForcePw, showLogin };
