'use strict';

// Autentificare UI: login/2FA, inscriere + preturi, parola uitata/reset, invitatii, schimbarea fortata a parolei.
// Extras din app.js (faza 2); apelurile inapoi spre app.js vin prin setDeps (fara cicluri).
import { $$, $, H, fmt, toast, api, setOn402 } from './core.js';

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

// Panoul de prezentare al ecranului de intrare (coloana din dreapta) e scris O SINGURA DATA, in
// #loginOverlay, si se cloneaza in ecranul de inscriere. Doua copii in HTML ar fi doua texte
// despre acelasi produs — ar diverge la prima corectura, iar cel nefolosit s-ar strica in tacere.
// Clonarea e sigura: panoul nu contine niciun `id`.
function oglindestePanoulDePrezentare() {
  const sursa = document.querySelector('#loginOverlay .auth-hero');
  const gazda = document.querySelector('#registerOverlay');
  if (!sursa || !gazda || gazda.querySelector('.auth-hero')) return;
  gazda.appendChild(sursa.cloneNode(true));
}
document.addEventListener('DOMContentLoaded', oglindestePanoulDePrezentare);
oglindestePanoulDePrezentare();
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
  $('#registerOverlay').classList.add('hidden'); $('#loginOverlay').classList.remove('hidden');
});
// REGULA DE INSCRIERE: din panoul public se poate alege DOAR proba gratuită. Planurile plătite se
// aleg din aplicație, după probă — momentul în care omul știe deja ce cumpără, nu înainte să fi
// văzut produsul. De aceea nu mai există „alege un plan plătit acum și plătește după înregistrare":
// mecanismul care reținea planul până la crearea contului a fost scos, nu doar ascuns.
/** Ce control primește un plan în panoul public. PUR, ca să poată fi verificat fără DOM. */
export function ctaPlanPublic(plan, canRegister) {
  if (!canRegister) return { fel: 'text', text: 'Autentifică-te pentru a alege planul' };
  if (plan.trial) return { fel: 'buton', text: 'Începe proba gratuită', activ: true };
  return { fel: 'buton', text: 'Disponibil după probă', activ: false,
    titlu: 'Începe cu proba gratuită de 30 de zile. Planul plătit îl alegi din aplicație, când proba se apropie de final.' };
}
// Prețuri publice (pe pagina de autentificare/înscriere)
async function showPricing() {
  const box = $('#pricingPlans'); if (!box) return;
  box.innerHTML = '<p class="muted">Se încarcă…</p>';
  $('#pricingOverlay').classList.remove('hidden');
  let data; try { data = await (await fetch('/api/plans')).json(); } catch (e) { box.innerHTML = '<p class="status err">Nu s-au putut încărca prețurile.</p>'; return; }
  let canRegister = false;
  try { const r = await fetch('/api/register'); if (r.ok) canRegister = !!(await r.json()).enabled; } catch (e) { /* optional */ }
  box.innerHTML = (data.plans || []).map((p) => {
    const d = ctaPlanPublic(p, canRegister);
    const cta = d.fel === 'text'
      ? `<div class="muted" data-u="u17">${H(d.text)}</div>`
      : (d.activ
        ? `<button class="btn primary pricing-start" data-plan="${p.id}">${H(d.text)}</button>`
        : `<button class="btn" disabled title="${H(d.titlu || '')}">${H(d.text)}</button>`);
    return `<div class="plan-card${p.recomandat ? ' recomandat' : ''}">
      ${p.recomandat ? '<div class="plan-badge">Recomandat</div>' : ''}
      <h3>${H(p.nume)}</h3>
      <div class="plan-price">${p.pret === 0 ? 'Gratuit' : '<b>' + fmt(p.pret) + '</b> ' + p.moneda}<span>${p.pret === 0 ? '' : '/ ' + p.perioada}</span></div>
      <p class="plan-desc">${H(p.descriere || '')}</p>
      <ul class="plan-feat">${(p.features || []).map((f) => `<li>${f}</li>`).join('')}</ul>
      <div class="plan-action">${cta}</div>
    </div>`;
  }).join('');
  // Singurul buton activ e proba gratuită, deci inscrierea nu mai poarta niciun plan cu ea.
  $$('#pricingPlans .pricing-start').forEach((b) => b.addEventListener('click', () => openRegisterPanel()));
}
$('#showPricingLogin') && $('#showPricingLogin').addEventListener('click', showPricing);
$('#showPricingReg') && $('#showPricingReg').addEventListener('click', showPricing);
$('#pricingClose') && $('#pricingClose').addEventListener('click', () => $('#pricingOverlay').classList.add('hidden'));
// Întrebări frecvente (public, pe pagina de autentificare) — acordeoane + căutare
$('#showFaqLogin') && $('#showFaqLogin').addEventListener('click', () => $('#faqOverlay').classList.remove('hidden'));
$('#faqClose') && $('#faqClose').addEventListener('click', () => $('#faqOverlay').classList.add('hidden'));
// Adresa administratorului: `mailto:` merge doar daca sistemul are un program de e-mail asociat.
// Cine foloseste Gmail/Outlook intr-un TAB de browser n-are unul, iar click-ul nu face nimic
// vizibil — pagina isi face treaba (preda linkul sistemului), dar utilizatorul vede o adresa moarta.
// Butonul de copiere functioneaza in ambele cazuri, deci adresa e utilizabila oricum.
$('#adminMailCopy') && $('#adminMailCopy').addEventListener('click', async (e) => {
  e.preventDefault();
  const el = $('#adminMail');
  // adresa vine din data-mail, nu din textul afisat: linkul duce acum la Gmail, deci href-ul
  // nu mai e adresa, iar textul e doar eticheta si poate fi schimbat oricand
  const adr = (el && (el.dataset.mail || el.textContent.trim())) || '';
  try {
    await navigator.clipboard.writeText(adr);
    toast('Adresă copiată: ' + adr);
  } catch (_) {
    // clipboard indisponibil (context nesigur, permisiune refuzata): selectam textul, ca
    // utilizatorul sa poata copia cu Ctrl+C — mai bine decat un buton care nu face nimic
    try {
      const r = document.createRange(); r.selectNodeContents($('#adminMail'));
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      toast('Apasă Ctrl+C ca să copiezi adresa selectată.', true);
    } catch (__) { toast('Copiază manual adresa: ' + adr, true); }
  }
});
$('#faqSearch') && $('#faqSearch').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  $$('#faqList .faq-item').forEach((it) => {
    const hit = !q || it.textContent.toLowerCase().includes(q);
    it.classList.toggle('hidden', !hit);
    if (q && hit) it.open = true; else if (!q) it.open = false;
  });
});
// Felul contului decide ce se cere mai jos: patronul isi inscrie firma odata cu contul, contabilul
// nu are ce firma sa inscrie. Campurile firmei nu se ascund doar vizual — se si scot din validarea
// browserului (`required` pe un camp ascuns blocheaza trimiterea, tacut si fara sa se vada unde).
function regTip() {
  const r = $('#registerForm [name="tipCont"]:checked');
  return r ? r.value : 'patron';
}
export function aplicaTipCont() {
  const f = $('#registerForm'); if (!f) return;
  const contabil = regTip() === 'contabil';
  $('#regFirmaFields').classList.toggle('hidden', contabil);
  $('#regContabilLista').classList.toggle('hidden', !contabil);
  $('#regHintPatron').classList.toggle('hidden', contabil);
  $('#regHintContabil').classList.toggle('hidden', !contabil);
  if (f.nume) f.nume.required = !contabil;
  const btn = $('#regSubmit');
  if (btn) btn.textContent = contabil ? 'Creează contul de contabil' : 'Creează firma și contul';
  // Ce fel de cont se face se spune in TITLUL ecranului, nu in sigla: sigla e marca produsului si
  // ramane aceeasi pe ambele ecrane de autentificare, ca omul sa stie unde e.
  const titlu = $('#registerOverlay .auth-title');
  if (titlu) titlu.textContent = contabil ? 'Fă-ți cont de contabil' : 'Fă-ți cont gratuit pe Contabo';
}
$$('#registerForm [name="tipCont"]').forEach((r) => r.addEventListener('change', aplicaTipCont));

$('#registerForm') && $('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; $('#registerErr').textContent = '';
  const contabil = regTip() === 'contabil';
  const body = contabil
    ? { tipCont: 'contabil', disponibilContabil: f.disponibilContabil.checked, username: f.username.value, password: f.password.value, email: f.email.value }
    : { nume: f.nume.value, cui: f.cui.value, regCom: f.regCom.value, adresa: f.adresa.value, oras: f.oras.value, judet: f.judet.value, tvaPlatitor: f.tvaPlatitor.checked, tipEntitate: f.tipEntitate.value, username: f.username.value, password: f.password.value, email: f.email.value };
  try {
    await api('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    f.password.value = '';
    // Inscrierea porneste INTOTDEAUNA proba gratuita; nu mai exista plata imediat dupa creare.
    // Planul platit se alege din aplicatie (Abonament), cand proba se apropie de final.
    $('#registerOverlay').classList.add('hidden'); $('#loginOverlay').classList.add('hidden');
    await D.init();
    toast(contabil
      ? 'Bine ai venit! Contul tău de contabil e gata — firmele vin după, cu acordul clienților.'
      : ('Bine ai venit! Firma „' + body.nume + '" a fost creată.'));
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
      $('#codeRow').classList.remove('hidden'); if (f.code) { f.code.required = true; f.code.focus(); }
      $('#loginErr').textContent = 'Introdu codul din aplicația de autentificare sau un cod de rezervă.'; return;
    }
    f.password.value = ''; if (f.code) f.code.value = ''; hideLogin(); await D.init();
  } catch (err) {
    if (/2FA/i.test(err.message)) { $('#codeRow').classList.remove('hidden'); if (f.code) f.code.required = true; }
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
    const r = await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: f.oldPassword.value, newPassword: f.newPassword.value }) });
    $('#forcePwOverlay').classList.add('hidden');
    toast('Parolă schimbată. ' + (Number(r.sessionsRevoked) || 0) + ' sesiuni vechi au fost deconectate; activează 2FA pentru protecție suplimentară.');
    await D.init();
    D.goTab('cont'); // parola si sesiunile stau in „Contul meu"
    setTimeout(() => { const t = $('#sessionsList'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 250);
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
function openRegisterPanel() {
  $('#pricingOverlay') && $('#pricingOverlay').classList.add('hidden');
  $('#loginOverlay') && $('#loginOverlay').classList.add('hidden');
  if ($('#registerErr')) $('#registerErr').textContent = '';
  // Inscrierea e mereu pe proba gratuita, deci nu mai exista „plan ales" de anuntat.
  const hint = $('#regPlanHint');
  if (hint) hint.classList.add('hidden');
  const submitBtn = $('#registerForm') && $('#registerForm').querySelector('button.primary');
  if (submitBtn) submitBtn.textContent = 'Creează firma și contul';
  $('#registerOverlay') && $('#registerOverlay').classList.remove('hidden'); aplicaTipCont(); // normalizeaza starea la fiecare deschidere
}
const inviteToken = new URLSearchParams(location.search).get('invite');
async function startInvite(token) {
  showLogin();
  let info;
  try { info = await api('/api/invite/' + token); }
  catch (e) { $('#loginErr').textContent = 'Invitație invalidă sau expirată.'; return; }
  const box = $('#loginForm');
  box.innerHTML = `<div class="login-logo">▦ Contabo</div>
    <p class="muted">Bun venit, <b>${H(info.username)}</b>. Setează-ți parola.</p>
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
    <p class="muted">Resetare parolă pentru <b>${H(info.username)}</b>.</p>
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
