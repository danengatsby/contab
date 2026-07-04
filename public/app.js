'use strict';
let META = { types: [], accounts: [], company: {}, periods: [] };
let USER = {};
let CURRENT = null; // { documentId, fields, suggestedType }

const EFACT_TYPES = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare', 'factura_storno_cumparare']);
const SENDABLE_TYPES = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare']);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = (n) => (Number(n) || 0).toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const accName = (c) => { const a = META.accounts.find((x) => x.cod === String(c)); return a ? a.nume : ''; };

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 3200);
}
let pendingReq = 0;
function setLoad(on) {
  pendingReq = Math.max(0, pendingReq + (on ? 1 : -1));
  const b = document.getElementById('loadbar');
  if (b) b.classList.toggle('on', pendingReq > 0);
}
async function api(url, opts) {
  setLoad(true);
  try {
    const r = await fetch(url, opts);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) { const err = new Error((data && data.error) || ('Eroare ' + r.status)); err.status = r.status; throw err; }
    return data;
  } finally { setLoad(false); }
}

// ───────────────────────── AUTENTIFICARE ─────────────────────────
function showLogin() { $('#loginOverlay').classList.remove('hidden'); checkRegisterEnabled(); }
function hideLogin() { $('#loginOverlay').classList.add('hidden'); }
// ── Inscriere firma (pagina publica de pe login) ──
async function checkRegisterEnabled() {
  try { const r = await fetch('/api/register'); if (!r.ok) return; const d = await r.json(); $('#registerCta') && $('#registerCta').classList.toggle('hidden', !d.enabled); }
  catch (e) { /* ignora */ }
}
$('#registerBtn') && $('#registerBtn').addEventListener('click', () => {
  $('#registerErr').textContent = ''; $('#loginOverlay').classList.add('hidden'); $('#registerOverlay').classList.remove('hidden');
});
$('#registerCancel') && $('#registerCancel').addEventListener('click', () => {
  $('#registerOverlay').classList.add('hidden'); $('#loginOverlay').classList.remove('hidden');
});
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
  $$('#pricingPlans .pricing-start').forEach((b) => b.addEventListener('click', async () => {
    // Proba gratuită → direct la înscriere. Plan plătit → lansează plata, apoi la întoarcere se deschide înscrierea.
    if (b.dataset.trial === '1') { openRegisterPanel(); return; }
    b.disabled = true;
    try {
      const r = await api('/api/checkout-guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: b.dataset.plan }) });
      if (r.url) { window.location.href = r.url; return; } // redirect către Stripe Checkout
      if (r.notConfigured) { toast('Plata online nu e activată încă — creezi contul acum, activăm abonamentul ulterior.'); openRegisterPanel(); return; }
      b.disabled = false;
    } catch (e) { toast(e.message, true); b.disabled = false; }
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

$('#registerForm') && $('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; $('#registerErr').textContent = '';
  const body = { nume: f.nume.value, cui: f.cui.value, regCom: f.regCom.value, adresa: f.adresa.value, oras: f.oras.value, judet: f.judet.value, tvaPlatitor: f.tvaPlatitor.checked, username: f.username.value, password: f.password.value, email: f.email.value };
  try {
    await api('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    f.password.value = '';
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
  if (t === 'documente') renderRecurring();
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
  sel.innerHTML = (META.firme || []).map((f) => `<option value="${f.id}" ${f.id === META.firmaActiva ? 'selected' : ''}>${f.nume}${f.cui ? ' (' + f.cui + ')' : ''}</option>`).join('');
  // Portofoliul are sens doar cu mai multe firme in administrare
  const np = $('#navPortofoliu'); if (np) np.classList.toggle('hidden', (META.firme || []).length < 2);
}
$('#firmaSelect').addEventListener('change', async (e) => {
  await api('/api/firme/' + e.target.value + '/activate', { method: 'POST' });
  await init();
  const active = $('#tabs button[data-tab].active'); onTab(active ? active.dataset.tab : 'dashboard');
  toast('Firmă activă schimbată');
});
async function renderFirme() {
  const data = await api('/api/firme');
  $('#firmaExport').href = '/api/firme/' + data.firmaActiva + '/export-zip';
  $('#firmeList').innerHTML = `<table><thead><tr><th>Denumire</th><th>CUI</th><th></th></tr></thead><tbody>${
    data.firme.map((f) => `<tr>
      <td>${f.id === data.firmaActiva ? '<b>● ' + f.nume + '</b>' : f.nume}</td><td>${f.cui || ''}</td>
      <td>${f.id === data.firmaActiva ? '<span class="pill">activă</span>' : `<button class="linkbtn fact" data-id="${f.id}">activează</button>`}
        ${data.firme.length > 1 ? ` · <button class="del fdel" data-id="${f.id}">✕</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  $$('#firmeList .fact').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/firme/' + b.dataset.id + '/activate', { method: 'POST' }); await init(); onTab('setari'); toast('Firmă activată');
  }));
  $$('#firmeList .fdel').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi această firmă și toate datele ei?')) return;
    try { await api('/api/firme/' + b.dataset.id, { method: 'DELETE' }); await init(); onTab('setari'); toast('Firmă ștearsă'); }
    catch (e) { toast(e.message, true); }
  }));
  const active = data.firme.find((f) => f.id === data.firmaActiva) || {};
  const isTest = /^\[TEST\]/.test(active.nume || '') || active.test;
  const info = $('#testEnvInfo');
  if (info) info.innerHTML = isTest
    ? '🧪 <b style="color:var(--danger)">Ești pe o firmă de TEST</b> — modificările de aici NU afectează firma reală.'
    : 'Firma activă acum: <b>' + (active.nume || '—') + '</b> (reală).';
}
$('#testCloneBtn') && $('#testCloneBtn').addEventListener('click', async () => {
  const b = $('#testCloneBtn');
  if (!confirm('Creezi o copie de TEST a firmei curente și vei fi comutat pe ea. Continui?')) return;
  b.disabled = true; b.textContent = 'Se creează copia…';
  try {
    const r = await api('/api/firme/' + META.firmaActiva + '/test-clone', { method: 'POST' });
    await init(); onTab('setari');
    toast('Firmă de test creată: ' + r.nume + ' (acum activă)');
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = '🧪 Creează firmă de test (copie a celei curente)'; }
});
$('#firmaNewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await api('/api/firme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nume: f.nume.value, cui: f.cui.value, regCom: f.regCom.value, oras: f.oras.value }) });
  f.reset(); await init(); onTab('setari'); toast('Firmă adăugată (acum activă)');
});
$('#firmaImportBtn').addEventListener('click', async () => {
  const file = $('#firmaImportFile').files[0];
  const st = $('#firmaRestoreStatus');
  const fail = (msg) => { if (st) { st.className = 'status err'; st.textContent = msg; } else toast(msg, true); };
  if (!file) return toast('Alege întâi fișierul de restaurat (ZIP sau JSON descărcat din aplicație)', true);
  const isZip = /\.zip$/i.test(file.name);
  const firmaNume = (META.firme.find((f) => f.id === META.firmaActiva) || {}).nume || 'firma activă';
  if (!confirm('⚠️ ATENȚIE: restaurarea ÎNLOCUIEȘTE toate datele firmei „' + firmaNume + '" cu cele din copia „' + file.name + '".\n\nDatele actuale ale firmei vor fi suprascrise (o plasă de siguranță se salvează automat pe server).\n\nContinui?')) return;
  if (st) { st.className = 'status'; st.textContent = 'Se restaurează…'; }
  try {
    let r;
    if (isZip) {
      const fd = new FormData(); fd.append('file', file);
      r = await api('/api/firme/import-zip?mode=replace', { method: 'POST', body: fd });
    } else {
      let bundle;
      try { bundle = JSON.parse(await file.text()); } catch (e) { return fail('Fișierul nu este un JSON valid.'); }
      if (!bundle || bundle._format !== 'contab-firma-v1' || !bundle.firma) return fail('Fișierul nu pare o copie de siguranță Contabo (format necunoscut).');
      r = await api('/api/firme/import?mode=replace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle) });
    }
    if (st) { st.className = 'status ok'; st.textContent = '✓ Datele firmei au fost înlocuite cu cele din copie' + (r.files != null ? ' (' + r.files + ' fișiere atașate recuperate)' : '') + '.'; }
    $('#firmaImportFile').value = '';
    toast('Copie restaurată — datele firmei au fost înlocuite');
    await init(); onTab('setari');
  } catch (e) { fail(e.message); }
});

// ───────────────────────── UTILIZATORI (admin) ─────────────────────────
function firmeChecks(selected) {
  const sel = new Set((selected || []).map(Number));
  return (META.firme || []).map((f) => `<label style="display:inline-flex;align-items:center;gap:5px;margin-right:12px;font-weight:500;color:var(--ink)">
    <input type="checkbox" class="ufirma" value="${f.id}" ${sel.has(f.id) ? 'checked' : ''} style="width:auto"> ${f.nume}</label>`).join('');
}
async function renderUsers() {
  if (USER.role !== 'admin') return;
  const srt = $('#selfRegToggle');
  if (srt) {
    srt.checked = META.selfRegister !== false;
    srt.onchange = async () => {
      try { await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selfRegister: srt.checked }) }); META.selfRegister = srt.checked; toast(srt.checked ? 'Înscrierea publică e activată' : 'Înscrierea publică e dezactivată'); }
      catch (e) { toast(e.message, true); srt.checked = !srt.checked; }
    };
  }
  $('#userFirmeChecks').innerHTML = firmeChecks([]);
  const users = await api('/api/users');
  // tipul utilizatorului: admin / tester (proba) / necontabil (Start) / contabil (Pro)
  const tipPill = (u) => {
    const c = { admin: 'background:#2f2e2a;color:#fff', contabil: 'background:#e2f5e8;color:#0a7d33', necontabil: 'background:#e7eefc;color:#1652d6', tester: 'background:#fff4e0;color:#b26a00' }[u.tip] || '';
    return `<span class="pill" style="${c}" title="${u.plan ? 'plan: ' + u.plan : 'fără plan (probă)'}">${u.tip || '—'}</span>`;
  };
  const drCheck = (u, key, label, title) => u.role === 'admin' ? '' : `<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap" title="${title}">
      <input type="checkbox" class="udrept" data-id="${u.id}" data-drept="${key}" style="width:auto" ${u.drepturi && u.drepturi[key] ? 'checked' : ''} /> ${label}</label>`;
  $('#usersList').innerHTML = `<table><thead><tr><th>Utilizator</th><th>Tip</th><th>Firme</th><th>Drepturi</th><th></th></tr></thead><tbody>${
    users.map((u) => `<tr><td><b>${u.username}</b>${u.pending ? ' <span class="pill warn">invitație</span>' : ''}</td><td>${tipPill(u)}</td>
      <td>${u.role === 'admin' ? '<span class="muted">toate</span>' : u.firme.map((id) => { const f = (META.firme || []).find((x) => x.id === id); return f ? f.nume : id; }).join(', ') || '<span class="muted">—</span>'}</td>
      <td>${u.role === 'admin' ? '<span class="muted">complete</span>' : drCheck(u, 'readonly', 'doar citire', 'Vede toate datele, dar nu poate modifica nimic') + '<br>' + drCheck(u, 'faraSalarii', 'fără salarii', 'Fără acces la salarizare (angajați, state de plată, fluturași, D112)')}</td>
      <td>${u.pending ? `<button class="linkbtn ulink" data-link="${u.inviteLink}">copiază link</button>` : `<button class="linkbtn ureset" data-id="${u.id}">resetează parola</button>${u.role !== 'admin' ? ` · <button class="linkbtn uimp" data-id="${u.id}">↪ intră pe cont</button>` : ''}`} · <button class="del udel" data-id="${u.id}">✕</button></td></tr>`).join('')}</tbody></table>`;
  $$('#usersList .udrept').forEach((cb) => cb.addEventListener('change', async () => {
    const row = $$('#usersList .udrept').filter((x) => x.dataset.id === cb.dataset.id);
    const drepturi = {}; row.forEach((x) => { drepturi[x.dataset.drept] = x.checked; });
    try { await api('/api/users/' + cb.dataset.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drepturi }) }); toast('Drepturi salvate'); }
    catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
  }));
  $$('#usersList .ulink').forEach((b) => b.addEventListener('click', () => prompt('Link invitație (trimite-l utilizatorului):', b.dataset.link)));
  $$('#usersList .uimp').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Intri pe contul acestui utilizator? Vei vedea aplicația exact ca el. Toate acțiunile sunt jurnalizate.')) impersonate(Number(b.dataset.id));
  }));
  $$('#usersList .udel').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi utilizatorul?')) return;
    try { await api('/api/users/' + b.dataset.id, { method: 'DELETE' }); renderUsers(); toast('Utilizator șters'); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#usersList .ureset').forEach((b) => b.addEventListener('click', async () => {
    const np = prompt('Parolă nouă pentru utilizator:'); if (!np) return;
    await api('/api/users/' + b.dataset.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: np }) });
    toast('Parolă resetată');
  }));
}
$('#userNewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const firme = $$('#userFirmeChecks .ufirma').filter((c) => c.checked).map((c) => Number(c.value));
  try {
    await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.username.value, password: f.password.value, role: f.role.value, firme }) });
    f.reset(); renderUsers(); toast('Utilizator adăugat');
  } catch (err) { toast(err.message, true); }
});
$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: f.oldPassword.value, newPassword: f.newPassword.value }) });
    f.reset(); toast('Parolă schimbată');
  } catch (err) { toast(err.message, true); }
});
$('#inviteBtn').addEventListener('click', async () => {
  const f = $('#userNewForm');
  if (!f.username.value) return toast('Completează utilizatorul', true);
  const firme = $$('#userFirmeChecks .ufirma').filter((c) => c.checked).map((c) => Number(c.value));
  try {
    const r = await api('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.username.value, role: f.role.value, firme, email: f.email.value }) });
    f.reset(); renderUsers();
    if (r.emailed) toast('Invitație trimisă pe email');
    else { prompt('Trimite acest link utilizatorului (setează parola):', r.link); toast('Invitație creată'); }
  } catch (err) { toast(err.message, true); }
});

// ───────────────────────── AUDIT ─────────────────────────
let AUDIT_SCOPE = 'firma'; // 'firma' (curentă) | 'system' (global, doar admin)
async function renderAudit() {
  const isAdmin = USER && USER.role === 'admin';
  $('#auditScope') && $('#auditScope').classList.toggle('hidden', !isAdmin);
  if (!isAdmin) AUDIT_SCOPE = 'firma';
  $('#auditScopeFirma') && $('#auditScopeFirma').classList.toggle('active', AUDIT_SCOPE === 'firma');
  $('#auditScopeSystem') && $('#auditScopeSystem').classList.toggle('active', AUDIT_SCOPE === 'system');
  let list;
  try { list = await api(AUDIT_SCOPE === 'system' ? '/api/audit/system' : '/api/audit'); } catch (e) { return; }
  if (!list.length) { $('#auditList').innerHTML = '<p class="muted">Nicio acțiune înregistrată ' + (AUDIT_SCOPE === 'system' ? 'la nivel de sistem.' : 'pentru firma curentă.') + '</p>'; return; }
  $('#auditList').innerHTML = `<table><thead><tr><th>Data</th><th>Utilizator</th><th>Acțiune</th><th>Detaliu</th></tr></thead><tbody>${
    list.map((a) => `<tr><td>${(a.ts || '').replace('T', ' ').slice(0, 16)}</td><td>${a.username || ''}${a.viaAdmin ? ' <span class="muted">(via ' + a.viaAdmin + ')</span>' : ''}</td>
      <td class="acc">${a.action}</td><td>${a.detail || ''}</td></tr>`).join('')}</tbody></table>`;
}
$('#auditRefresh').addEventListener('click', renderAudit);
$('#auditScopeFirma') && $('#auditScopeFirma').addEventListener('click', () => { AUDIT_SCOPE = 'firma'; renderAudit(); });
$('#auditScopeSystem') && $('#auditScopeSystem').addEventListener('click', () => { AUDIT_SCOPE = 'system'; renderAudit(); });

// ───────────────────────── 2FA ─────────────────────────
function render2FA() {
  const on = !!(USER && USER.twofa);
  $('#twofaStatus').className = 'status' + (on ? ' ok' : '');
  $('#twofaStatus').textContent = on ? '✔ 2FA este activat pe contul tău.' : '2FA este dezactivat.';
  $('#twofaStart').classList.toggle('hidden', on);
  $('#twofaDisableWrap').classList.toggle('hidden', !on);
  $('#twofaSetup').classList.add('hidden');
}
$('#twofaStart').addEventListener('click', async () => {
  try {
    const r = await api('/api/2fa/setup', { method: 'POST' });
    $('#twofaSecret').textContent = 'Secret: ' + r.secret;
    $('#twofaQr').innerHTML = `${r.qrSvg ? `<div style="display:inline-block;margin-top:6px;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff">${r.qrSvg}</div><br>` : ''}<a href="${r.otpauth}" style="word-break:break-all;font-size:12px">${r.otpauth}</a>`;
    $('#twofaSetup').classList.remove('hidden');
  } catch (e) { toast(e.message, true); }
});
$('#twofaEnable').addEventListener('click', async () => {
  try { await api('/api/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('#twofaCode').value }) }); toast('2FA activat'); await init(); onTab('setari'); }
  catch (e) { toast(e.message, true); }
});
$('#twofaDisable').addEventListener('click', async () => {
  try { await api('/api/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('#twofaDisCode').value }) }); toast('2FA dezactivat'); await init(); onTab('setari'); }
  catch (e) { toast(e.message, true); }
});
$('#twofaRevoke').addEventListener('click', async () => {
  try { await api('/api/2fa/revoke-devices', { method: 'POST' }); toast('Dispozitivele de încredere au fost revocate'); }
  catch (e) { toast(e.message, true); }
});

// ───────────────────────── BACKUP (admin) ─────────────────────────
async function renderBackup() {
  if (!USER || USER.role !== 'admin') return;
  $('#backupCard').style.display = '';
  let b;
  try { b = await api('/api/backups'); } catch (e) { return; }
  $('#backupAuto').checked = b.auto;
  $('#backupStatus').textContent = b.lastAt ? ('Ultimul backup: ' + b.lastAt.replace('T', ' ').slice(0, 16)) : 'Niciun backup încă.';
  $('#backupList').innerHTML = b.list.length
    ? `<table><thead><tr><th>Fișier</th><th class="num">Mărime</th><th></th></tr></thead><tbody>${
      b.list.map((x) => `<tr><td class="acc">${x.name}</td><td class="num">${(x.size / 1024).toFixed(1)} KB</td>
        <td><a class="linkbtn" href="/api/backup/file/${encodeURIComponent(x.name)}" target="_blank">descarcă</a></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio copie salvată.</p>';
}
$('#backupNow').addEventListener('click', async () => {
  try { const r = await api('/api/backup', { method: 'POST' }); toast('Backup creat: ' + r.file); renderBackup(); }
  catch (e) { toast(e.message, true); }
});
$('#backupAuto').addEventListener('change', async (e) => {
  await api('/api/backups/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: e.target.checked }) });
  toast('Setare backup salvată');
});
$('#restoreBtn').addEventListener('click', async () => {
  const file = $('#restoreFile').files[0];
  if (!file) return toast('Alege un fișier db.json', true);
  if (!confirm('Sigur restaurezi? Toate datele curente vor fi înlocuite și vei fi delogat.')) return;
  const fd = new FormData(); fd.append('file', file);
  try { const r = await api('/api/restore', { method: 'POST', body: fd }); toast(r.message); setTimeout(() => location.reload(), 1500); }
  catch (e) { toast(e.message, true); }
});

// ───────────────────────── PROFIL + SESIUNI ─────────────────────────
async function renderProfile() {
  try {
    const p = await api('/api/profile');
    const f = $('#profileForm');
    f.email.value = p.email || '';
    f.notifyDeadlines.checked = p.notifyDeadlines !== false;
    // datele personale: doar pentru abonati (necontabil = Start, contabil = Pro)
    const abonat = p.tip === 'necontabil' || p.tip === 'contabil';
    $('#profilPersonal').classList.toggle('hidden', !abonat);
    $('#autorizatieRow').classList.toggle('hidden', p.tip !== 'contabil');
    const pr = p.profil || {};
    for (const k of ['numeComplet', 'telefon', 'adresa', 'oras', 'judet', 'autorizatie']) { if (f[k]) f[k].value = pr[k] || ''; }
  } catch (e) { /* */ }
}
$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const profil = {};
  for (const k of ['numeComplet', 'telefon', 'adresa', 'oras', 'judet', 'autorizatie']) { if (f[k]) profil[k] = f[k].value; }
  await api('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: f.email.value, notifyDeadlines: f.notifyDeadlines.checked, profil }) });
  toast('Profil salvat');
});
async function renderSessions() {
  let list;
  try { list = await api('/api/sessions'); } catch (e) { return; }
  $('#sessionsList').innerHTML = `<table><thead><tr><th>Dispozitiv</th><th>IP</th><th>Ultima activitate</th><th></th></tr></thead><tbody>${
    list.map((s) => `<tr><td>${(s.ua || '').slice(0, 40) || '—'}${s.current ? ' <span class="pill">acesta</span>' : ''}</td>
      <td>${s.ip || ''}</td><td>${(s.lastSeen || '').replace('T', ' ').slice(0, 16)}</td>
      <td>${s.current ? '' : `<button class="linkbtn sdel" data-id="${s.id}">deconectează</button>`}</td></tr>`).join('')}</tbody></table>`;
  $$('#sessionsList .sdel').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/sessions/' + b.dataset.id, { method: 'DELETE' }); renderSessions(); toast('Sesiune deconectată');
  }));
}
$('#logoutOthers').addEventListener('click', async () => {
  await api('/api/sessions/logout-others', { method: 'POST' }); renderSessions(); toast('Celelalte dispozitive au fost deconectate');
});

// ───────────────────────── SMTP (admin) ─────────────────────────
async function renderSmtp() {
  if (!USER || USER.role !== 'admin') return;
  $('#smtpCard').style.display = '';
  let s;
  try { s = await api('/api/smtp'); } catch (e) { return; }
  const f = $('#smtpForm');
  f.host.value = s.host || ''; f.port.value = s.port || 587; f.secure.checked = !!s.secure; f.user.value = s.user || ''; f.from.value = s.from || '';
  if (f.notifyNewMessage) f.notifyNewMessage.checked = s.notifyNewMessage !== false;
  $('#smtpStatus').className = 'status' + (s.configured ? ' ok' : '');
  $('#smtpStatus').textContent = s.configured ? '✔ SMTP configurat (' + s.host + ')' : 'SMTP necompletat — invitațiile se trimit ca link.';
}
$('#smtpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { host: f.host.value, port: f.port.value, secure: f.secure.checked, user: f.user.value, from: f.from.value, notifyNewMessage: f.notifyNewMessage ? f.notifyNewMessage.checked : true };
  if (f.pass.value) body.pass = f.pass.value;
  await api('/api/smtp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  f.pass.value = ''; renderSmtp(); toast('Setări SMTP salvate');
});
// ── Cote fiscale configurabile (admin) ──
async function renderFiscal() {
  if (!USER || USER.role !== 'admin') return;
  $('#fiscalCard').style.display = '';
  let c; try { c = await api('/api/fiscal-config'); } catch (e) { return; }
  const f = $('#fiscalForm');
  Object.keys(c.current || {}).forEach((k) => { if (f[k]) f[k].value = c.current[k]; });
}
$('#fiscalForm') && $('#fiscalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  [...e.target.elements].forEach((el) => { if (el.name && el.value !== '') body[el.name] = el.value; });
  try { await api('/api/fiscal-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); $('#fiscalStatus').className = 'status ok'; $('#fiscalStatus').textContent = 'Cote salvate — calculele folosesc noile valori.'; META = await api('/api/meta'); toast('Cote fiscale actualizate'); }
  catch (err) { $('#fiscalStatus').className = 'status err'; $('#fiscalStatus').textContent = err.message; }
});
$('#fiscalReset') && $('#fiscalReset').addEventListener('click', async () => {
  if (!confirm('Revii la cotele fiscale standard din aplicație?')) return;
  try { await api('/api/fiscal-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) }); await renderFiscal(); META = await api('/api/meta'); toast('Cote resetate la valori standard'); }
  catch (e) { toast(e.message, true); }
});
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

// ───────────────────────── MESAJE + IMPERSONARE ─────────────────────────
const escMsg = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function fmtMsgTime(iso) {
  try { return new Date(iso).toLocaleString('ro-RO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
}
function fmtSize(b) { b = Number(b) || 0; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
// randeaza atasamentul: imaginile raster inline (thumbnail), restul ca buton de descarcare
function attachHtml(m) {
  if (!m.attachment) return '';
  const a = m.attachment; const url = '/api/messages/' + encodeURIComponent(m.id) + '/file';
  const isImg = /^image\/(png|jpe?g|gif|webp)$/i.test(a.mime || '');
  if (isImg) return `<a class="msg-img" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escMsg(a.name)}" loading="lazy"></a>`;
  return `<a class="filechip" href="${url}" target="_blank" rel="noopener">📎 <span class="fn">${escMsg(a.name)}</span> <span class="fsize">${fmtSize(a.size)}</span></a>`;
}
const escAttr = (s) => escMsg(s).replace(/"/g, '&quot;');
// o bula de chat; „mine” (dreapta) = mesajul scris de partea care priveste (admin sau user)
function bubble(m, viewerIsAdmin) {
  const mine = viewerIsAdmin ? m.fromAdmin : !m.fromAdmin;
  const who = m.fromAdmin ? 'Administrator' : (m.author || 'Utilizator');
  const txt = m.text ? escMsg(m.text).replace(/\n/g, '<br>') : '';
  const del = viewerIsAdmin ? `<button type="button" class="msg-del" data-id="${escMsg(m.id)}" title="Șterge mesajul">✕</button>` : '';
  // editarea: doar autorul (mesajul „mine”)
  const edit = mine ? `<button type="button" class="msg-edit" data-id="${escMsg(m.id)}" data-text="${escAttr(m.text || '')}" title="Editează">✎</button>` : '';
  // confirmare de citire pe mesajele proprii + marcaj „editat”
  let receipt = '';
  if (mine) {
    const read = viewerIsAdmin ? m.readByUser : m.readByAdmin;
    const lbl = read ? ('✓✓ citit' + (viewerIsAdmin ? ' de utilizator' : ' de admin')) : '✓ trimis';
    receipt = `<div class="msg-receipt${read ? ' seen' : ''}">${lbl}${m.editedAt ? ' · editat' : ''}</div>`;
  } else if (m.editedAt) {
    receipt = '<div class="msg-receipt">editat</div>';
  }
  return `<div class="msg ${mine ? 'mine' : 'other'}"><div class="msg-b">${del}${edit}<div class="msg-meta">${escMsg(who)} · ${fmtMsgTime(m.createdAt)}</div>${txt}${attachHtml(m)}${receipt}</div></div>`;
}
// editare inline a unei bule (autorul); `reload` reincarca conversatia dupa salvare/renuntare
function startInlineEdit(btn, reload) {
  const id = btn.dataset.id; const cur = btn.dataset.text || '';
  const bubbleEl = btn.closest('.msg-b');
  if (!bubbleEl || bubbleEl.querySelector('.msg-edit-box')) return;
  const box = document.createElement('div');
  box.className = 'msg-edit-box';
  box.innerHTML = '<textarea class="msg-edit-ta" rows="2"></textarea><div class="msg-edit-acts"><button type="button" class="btn small msg-edit-save">Salvează</button> <button type="button" class="btn small ghost msg-edit-cancel">Renunță</button></div>';
  bubbleEl.appendChild(box);
  const ta = box.querySelector('.msg-edit-ta'); ta.value = cur; ta.focus();
  box.querySelector('.msg-edit-cancel').addEventListener('click', () => reload());
  box.querySelector('.msg-edit-save').addEventListener('click', async () => {
    const text = ta.value.trim();
    try { await api('/api/messages/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); toast('Mesaj editat'); reload(); }
    catch (e) { toast(e.message, true); }
  });
}
function wireMsgEdit(scopeSel, reload) {
  $$(scopeSel + ' .msg-edit').forEach((b) => b.addEventListener('click', () => startInlineEdit(b, reload)));
}

let MSG_ADMIN_TARGET = null; // userId-ul conversatiei deschise in vederea de admin
let MSG_SEARCH_Q = '';       // textul de cautare activ (admin)

async function loadMessages() {
  // admin cu o cautare activa: pastreaza rezultatele filtrate
  if (isAdminView() && MSG_SEARCH_Q) {
    try {
      const r = await api('/api/messages/search?q=' + encodeURIComponent(MSG_SEARCH_Q));
      $('#msgUserView').classList.add('hidden'); $('#msgAdminView').classList.remove('hidden');
      renderAdminInbox(r.threads || []);
    } catch (e) { /* ignora */ }
    refreshMsgBadge(); return;
  }
  let data;
  try { data = await api('/api/messages'); } catch (e) { return; }
  if (data.admin) {
    $('#msgUserView').classList.add('hidden');
    $('#msgAdminView').classList.remove('hidden');
    renderAdminInbox(data.threads || []);
  } else {
    $('#msgAdminView').classList.add('hidden');
    $('#msgUserView').classList.remove('hidden');
    renderUserThread(data.thread || []);
  }
  refreshMsgBadge();
}
function renderUserThread(thread) {
  const box = $('#msgThread');
  box.innerHTML = thread.length ? thread.map((m) => bubble(m, false)).join('')
    : '<p class="muted">Niciun mesaj încă. Scrie-i administratorului mai jos.</p>';
  wireMsgEdit('#msgThread', loadMessages);
  box.scrollTop = box.scrollHeight;
}
function updateFileChip(inputSel, chipSel) {
  const f = $(inputSel).files[0]; const chip = $(chipSel);
  if (f) { chip.textContent = '📎 ' + f.name + ' (' + fmtSize(f.size) + ') — apasă Trimite'; chip.classList.remove('hidden'); }
  else { chip.textContent = ''; chip.classList.add('hidden'); }
}
$('#msgFile').addEventListener('change', () => updateFileChip('#msgFile', '#msgFileName'));
$('#msgAdminFile').addEventListener('change', () => updateFileChip('#msgAdminFile', '#msgAdminFileName'));
$('#msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ta = $('#msgText'); const fi = $('#msgFile');
  const text = ta.value.trim(); const file = fi.files[0];
  if (!text && !file) return;
  const fd = new FormData(); fd.append('text', text); if (file) fd.append('file', file);
  try { await api('/api/messages', { method: 'POST', body: fd }); ta.value = ''; fi.value = ''; updateFileChip('#msgFile', '#msgFileName'); loadMessages(); }
  catch (err) { toast(err.message, true); }
});
function renderAdminInbox(threads) {
  const box = $('#msgThreads');
  const showArch = $('#msgShowArchived') && $('#msgShowArchived').checked;
  const list = (threads || []).filter((t) => showArch || !t.archived);
  if (!list.length) { box.innerHTML = '<p class="muted">' + (MSG_SEARCH_Q ? 'Niciun rezultat pentru căutare.' : 'Nicio conversație. Utilizatorii îți pot scrie din meniul „Mesaje".') + '</p>'; return; }
  box.innerHTML = list.map((t) => {
    const snippet = t.match != null ? t.match : ((t.lastFromAdmin ? 'Tu: ' : '') + (t.lastText || ''));
    return `<button type="button" class="thread-item${t.userId === MSG_ADMIN_TARGET ? ' active' : ''}${t.archived ? ' archived' : ''}" data-uid="${t.userId}">
      <span class="ti-name">${escMsg(t.username)}${t.archived ? ' <span class="ti-tag">arhivat</span>' : ''}${t.unread ? ` <span class="navbadge">${t.unread}</span>` : ''}</span>
      <span class="ti-last">${escMsg(String(snippet).slice(0, 60))}</span></button>`;
  }).join('');
  $$('#msgThreads .thread-item').forEach((b) => b.addEventListener('click', () => openAdminThread(Number(b.dataset.uid))));
  if (MSG_ADMIN_TARGET != null && list.some((t) => t.userId === MSG_ADMIN_TARGET)) openAdminThread(MSG_ADMIN_TARGET, true);
}
async function openAdminThread(uid, keep) {
  MSG_ADMIN_TARGET = uid;
  let data;
  try { data = await api('/api/messages/thread/' + uid); } catch (e) { return; }
  $('#msgAdminTitle').textContent = 'Conversație cu ' + data.username;
  const box = $('#msgAdminThread');
  box.innerHTML = (data.thread || []).length ? data.thread.map((m) => bubble(m, true)).join('') : '<p class="muted">Niciun mesaj.</p>';
  box.scrollTop = box.scrollHeight;
  $$('#msgAdminThread .msg-del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi acest mesaj? Acțiunea este definitivă.')) return;
    try { await api('/api/messages/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' }); await openAdminThread(MSG_ADMIN_TARGET, true); loadMessages(); toast('Mesaj șters'); }
    catch (e) { toast(e.message, true); }
  }));
  wireMsgEdit('#msgAdminThread', () => { openAdminThread(MSG_ADMIN_TARGET, true); loadMessages(); });
  $('#msgAdminForm').classList.remove('hidden');
  const ab = $('#msgArchiveBtn');
  if (ab) { ab.classList.remove('hidden'); ab.textContent = data.archived ? '↩ Redeschide' : '✓ Arhivează'; ab.dataset.uid = String(uid); ab.dataset.archived = data.archived ? '1' : '0'; }
  $$('#msgThreads .thread-item').forEach((b) => b.classList.toggle('active', Number(b.dataset.uid) === uid));
  if (!keep) refreshMsgBadge();
}
$('#msgAdminForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (MSG_ADMIN_TARGET == null) return toast('Selectează o conversație', true);
  const ta = $('#msgAdminText'); const fi = $('#msgAdminFile');
  const text = ta.value.trim(); const file = fi.files[0];
  if (!text && !file) return;
  const fd = new FormData(); fd.append('text', text); fd.append('userId', MSG_ADMIN_TARGET); if (file) fd.append('file', file);
  try { await api('/api/messages', { method: 'POST', body: fd }); ta.value = ''; fi.value = ''; updateFileChip('#msgAdminFile', '#msgAdminFileName'); await openAdminThread(MSG_ADMIN_TARGET, true); loadMessages(); }
  catch (err) { toast(err.message, true); }
});
$('#msgRefresh').addEventListener('click', loadMessages);
(() => {
  const c = $('#msgSound'); if (!c) return;
  c.checked = soundOn();
  c.addEventListener('change', () => { try { localStorage.setItem('contab_msg_sound', c.checked ? '1' : '0'); } catch (e) { /* ignora */ } if (c.checked) beep(); });
})();
// căutare în conversații (admin), cu debounce
let MSG_SEARCH_TIMER = null;
function onMsgSearch() { MSG_SEARCH_Q = (($('#msgSearch') || {}).value || '').trim(); clearTimeout(MSG_SEARCH_TIMER); MSG_SEARCH_TIMER = setTimeout(loadMessages, 250); }
$('#msgSearch') && $('#msgSearch').addEventListener('input', onMsgSearch);
$('#msgShowArchived') && $('#msgShowArchived').addEventListener('change', loadMessages);
// arhivare / redeschidere conversație rezolvată
$('#msgArchiveBtn') && $('#msgArchiveBtn').addEventListener('click', async () => {
  const ab = $('#msgArchiveBtn'); const uid = Number(ab.dataset.uid); const archive = ab.dataset.archived !== '1';
  try {
    await api('/api/messages/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: uid, archived: archive }) });
    toast(archive ? 'Conversație arhivată' : 'Conversație redeschisă');
    await openAdminThread(uid, true); loadMessages();
  } catch (e) { toast(e.message, true); }
});
// „scrie acum…”: anunță cealaltă parte când tastezi
$('#msgText') && $('#msgText').addEventListener('input', pingTyping);
$('#msgAdminText') && $('#msgAdminText').addEventListener('input', pingTyping);

// ── indicatori la mesaj nou: titlu tab, badge pulsant, sunet scurt (WebAudio, fara fisier) ──
const BASE_TITLE = document.title;
function updateTitle(n) { document.title = n > 0 ? '(' + n + ') ' + BASE_TITLE : BASE_TITLE; }
function soundOn() { try { return localStorage.getItem('contab_msg_sound') !== '0'; } catch (e) { return true; } }
let _ac = null;
function beep() {
  if (!soundOn()) return;
  try {
    _ac = _ac || new (window.AudioContext || window.webkitAudioContext)();
    if (_ac.state === 'suspended') _ac.resume();
    const o = _ac.createOscillator(); const g = _ac.createGain();
    o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(_ac.destination);
    const t = _ac.currentTime;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.start(t); o.stop(t + 0.3);
  } catch (e) { /* audio blocat pana la o interactiune -> ignora */ }
}
function pulseBadge() { const b = $('#msgBadge'); if (!b) return; b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); }
function notifyNewMessage() { beep(); pulseBadge(); }
function setMsgBadge(n) {
  const b = $('#msgBadge');
  updateTitle(n);
  if (!b) return;
  if (n > 0) { b.textContent = n; b.classList.remove('hidden'); } else { b.classList.add('hidden'); }
}
async function refreshMsgBadge() {
  try { const r = await api('/api/messages/unread'); setMsgBadge(r.unread || 0); lastUnread = r.unread || 0; } catch (e) { /* ignora */ }
}
// Notificare aproape în timp real + indicator „scrie acum…”. Poll rapid pe tabul Mesaje (3s),
// rar in rest (~15s). Fetch silentios (fara bara de incarcare).
let MSG_POLL = null; let lastUnread = 0; let pollTick = 0; let lastThreadReload = 0;
function isAdminView() { return USER && USER.role === 'admin' && !USER.impersonating; }
function setTypingIndicator(on) {
  const el = isAdminView() ? $('#msgTypingAdmin') : $('#msgTypingUser');
  if (el) el.classList.toggle('hidden', !on);
}
function reloadOpenThread() {
  lastThreadReload = Date.now();
  if (isAdminView() && MSG_SEARCH_Q) { if (MSG_ADMIN_TARGET != null) openAdminThread(MSG_ADMIN_TARGET, true); }
  else loadMessages();
}
async function chatPoll() {
  if (!USER || !USER.username) return;
  pollTick += 1;
  const onTab = $('#tab-mesaje').classList.contains('active');
  if (!onTab && pollTick % 5 !== 0) return; // off-tab: efectiv la ~15s
  try {
    const openUid = (onTab && isAdminView()) ? (MSG_ADMIN_TARGET || '') : '';
    const r = await fetch('/api/messages/poll' + (openUid ? '?userId=' + encodeURIComponent(openUid) : ''));
    if (!r.ok) return;
    const data = await r.json();
    const n = data.unread || 0;
    const grew = n > lastUnread;
    lastUnread = n; setMsgBadge(n);
    if (grew) notifyNewMessage();
    if (grew && !onTab) toast('💬 Ai un mesaj nou');
    if (onTab) {
      setTypingIndicator(!!data.typing);
      const editing = !!document.querySelector('.msg-edit-box');
      if (!editing && (grew || Date.now() - lastThreadReload > 8000)) reloadOpenThread();
    }
  } catch (e) { /* delogat / offline -> ignora */ }
}
function startMsgPolling() { if (MSG_POLL) clearInterval(MSG_POLL); pollTick = 0; MSG_POLL = setInterval(chatPoll, 3000); }
// trimite „scrie acum…” catre cealalta parte (throttled)
let lastTypingPing = 0;
function pingTyping() {
  if (isAdminView() && !MSG_ADMIN_TARGET) return;
  const now = Date.now(); if (now - lastTypingPing < 2500) return; lastTypingPing = now;
  const body = isAdminView() ? JSON.stringify({ userId: MSG_ADMIN_TARGET }) : '{}';
  fetch('/api/messages/typing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
}

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
  lastUnread = (u && u.unreadMessages) || 0;
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
    META = await api('/api/meta');
  } catch (e) {
    if (e.status === 401) { showLogin(); handleCheckoutReturn(); handleRegisterLink(); return; }
    throw e;
  }
  hideLogin();
  USER = META.user || {};
  $('#userBadge').textContent = USER.username ? (USER.username + (USER.tip ? ' · ' + USER.tip : '')) : '';
  $('#usersCard').style.display = USER.role === 'admin' ? '' : 'none';
  $('#exportAllBtn') && ($('#exportAllBtn').style.display = USER.role === 'admin' ? '' : 'none');
  applySessionState(USER);
  // drepturi granulare: utilizatorii fara acces la salarizare nu vad intrarea din meniu
  $$('button[data-tab="salarizare"]').forEach((b) => { b.style.display = (USER.drepturi && USER.drepturi.faraSalarii) ? 'none' : ''; });
  initUiMode(); // mod simplu implicit pentru necontabili (ascunde partea tehnica din meniu)
  startMsgPolling();
  if (USER.mustChange) toast('Schimbă parola implicită (admin/admin) din Setări!', true);
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
function openRegisterPanel() {
  $('#pricingOverlay') && $('#pricingOverlay').classList.add('hidden');
  $('#loginOverlay') && $('#loginOverlay').classList.add('hidden');
  if ($('#registerErr')) $('#registerErr').textContent = '';
  $('#registerOverlay') && $('#registerOverlay').classList.remove('hidden');
}
// ───────────────────────── DASHBOARD ─────────────────────────
// tendinta unei serii lunare (ultima luna cu date vs precedenta), in %
function trendOf(series, key) {
  const d = (series || []).filter((m) => m.venituri || m.cheltuieli)
    .map((m) => (key === 'profit' ? (m.venituri - m.cheltuieli) : (m[key] || 0)));
  if (d.length < 2) return null;
  const cur = d[d.length - 1]; const prev = d[d.length - 2];
  if (!prev) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}
function trendChip(pct, goodWhenUp) {
  if (pct == null || !isFinite(pct)) return '';
  const up = pct >= 0; const good = up === goodWhenUp;
  return `<span class="trend ${good ? 'good' : 'bad'}" title="față de luna precedentă">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%</span>`;
}
async function loadDashboard() {
  let k; try { k = await api('/api/dashboard'); } catch (e) { return; }
  let c = null; try { c = await api('/api/dashboard-charts'); } catch (e) { /* grafice optionale */ }
  $('#dashYear').textContent = 'Exercițiul ' + k.year;
  renderDashAlerts(k);
  const s = (c && c.monthly) || [];
  const cinfo = (info) => info ? `<span class="cinfo" tabindex="0" role="note" aria-label="${info}">i<span class="cpop">${info}</span></span>` : '';
  const card = (ic, lbl, val, sub, cls, trend, info) => `<div class="kpi ${cls || ''}">
    <div class="kpi-top"><span class="kpi-ic">${ic}</span>${trend || ''}</div>
    <div class="lbl">${lbl}${cinfo(info)}</div><div class="val">${fmt(val)}</div><div class="sub">${sub || ''}</div></div>`;
  const tvaP = k.tvaDePlata >= k.tvaDeRecuperat;
  const yo = k.yoY || {};
  const yoySub = (delta) => delta == null ? ('vs ' + (yo.prevYear || '') + ': fără bază') : ('vs ' + yo.prevYear + ': ' + (delta >= 0 ? '▲ +' : '▼ ') + fmt(delta) + '%');
  $('#kpis').innerHTML =
    card('👥', 'Sold clienți (4111)', k.soldClienti, 'de încasat', 'green', '',
      'Cât au de plătit clienții tăi în total — soldul contului 4111 la zi. Detaliul pe fiecare client e în Scadențar.') +
    card('🏭', 'Sold furnizori (401)', k.soldFurnizori, 'de plătit', 'red', '',
      'Cât datorezi furnizorilor în total — soldul contului 401 la zi.') +
    card('🧾', tvaP ? 'TVA de plată' : 'TVA de recuperat', tvaP ? k.tvaDePlata : k.tvaDeRecuperat, 'cumulat', 'blue', '',
      'Soldul de TVA cumulat (4423/4424 după închideri + luna curentă neînchisă). Decontul exact, pe lună, e în tab-ul TVA.') +
    card('🏦', 'Disponibil bancă (5121)', k.banca, 'sold curent', 'blue', '',
      'Banii din contul bancar în lei, după toate încasările și plățile înregistrate.') +
    card('💵', 'Numerar casă (5311)', k.numerar, 'sold curent', 'blue', '',
      'Numerarul din casierie. Nu poate fi negativ — dacă e, lipsește o încasare din evidență.') +
    card('📈', 'Venituri ' + k.year, k.venituri, yoySub(yo.venituriDelta), 'green', trendChip(trendOf(s, 'venituri'), true),
      'Total venituri (clasa 7) pe anul curent, cu comparația față de anul trecut și tendința ultimelor luni.') +
    card('📉', 'Cheltuieli ' + k.year, k.cheltuieli, yoySub(yo.cheltuieliDelta), 'red', trendChip(trendOf(s, 'cheltuieli'), false),
      'Total cheltuieli (clasa 6) pe anul curent, cu comparația față de anul trecut.') +
    card('💰', 'Rezultat ' + k.year, k.profit, yoySub(yo.profitDelta), k.profit >= 0 ? 'green' : 'red', trendChip(trendOf(s, 'profit'), true),
      'Venituri minus cheltuieli pe anul curent — profitul brut contabil, înainte de impozit.');
  renderYoY(yo);
  renderForecast();
  const list = (arr) => arr.length
    ? `<table><tbody>${arr.map((p) => `<tr><td>${p.den}</td><td class="num">${fmt(p.sold)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">—</p>';
  $('#topCreante').innerHTML = list(k.topCreante);
  $('#topDatorii').innerHTML = list(k.topDatorii);
  if (c) renderDashboardCharts(c); else loadDashboardCharts();
}
async function renderBudget(year) {
  const box = $('#budgetView'); if (!box) return;
  let r; try { r = await api('/api/budget-report?year=' + year); } catch (e) { box.innerHTML = ''; return; }
  if (!r.rows.length) { box.innerHTML = '<p class="muted">Niciun cont bugetat pentru ' + year + '. Adaugă mai sus.</p>'; return; }
  const vCell = (row) => {
    // pentru venituri, peste buget = bine; pentru cheltuieli, peste buget = rau
    const good = row.tip === 'venit' ? row.variatie >= 0 : row.variatie <= 0;
    return `<span style="color:${good ? 'var(--accent)' : 'var(--danger)'};font-weight:600">${row.variatie >= 0 ? '+' : ''}${fmt(row.variatie)}</span>`;
  };
  const tipLbl = { venit: 'Venit', cheltuiala: 'Cheltuială', alt: 'Alt' };
  const rows = r.rows.map((row) => `<tr><td class="acc">${row.cont}</td><td>${row.nume}</td><td>${tipLbl[row.tip]}</td>
    <td class="num">${fmt(row.buget)}</td><td class="num">${fmt(row.actual)}</td><td class="num">${vCell(row)}</td>
    <td class="num">${row.realizarePct == null ? '—' : fmt(row.realizarePct) + '%'}</td>
    <td><button class="del budDel" data-id="${row.id}" title="Șterge">✕</button></td></tr>`).join('');
  box.innerHTML = `<table><thead><tr><th>Cont</th><th>Denumire</th><th>Tip</th><th class="num">Buget</th><th class="num">Realizat</th><th class="num">Abatere</th><th class="num">Realizare</th><th></th></tr></thead>
    <tbody>${rows}
    <tr class="total"><td colspan="3">Venituri bugetate / realizate</td><td class="num">${fmt(r.totalBugetVenit)}</td><td class="num">${fmt(r.totalActualVenit)}</td><td colspan="2"></td><td></td></tr>
    <tr class="total"><td colspan="3">Cheltuieli bugetate / realizate</td><td class="num">${fmt(r.totalBugetChelt)}</td><td class="num">${fmt(r.totalActualChelt)}</td><td colspan="2"></td><td></td></tr>
    <tr class="bold"><td colspan="3">Rezultat bugetat / realizat</td><td class="num">${fmt(r.rezultatBugetat)}</td><td class="num">${fmt(r.rezultatActual)}</td><td colspan="2"></td><td></td></tr>
    </tbody></table>`;
  $$('#budgetView .budDel').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/budgets/' + b.dataset.id, { method: 'DELETE' }); renderBudget(year); } catch (e) { toast(e.message, true); }
  }));
}
$('#budgetForm') && $('#budgetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/budgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ an: f.an.value, cont: f.cont.value, suma: f.suma.value }) });
    $('#budgetStatus').className = 'status ok'; $('#budgetStatus').textContent = 'Buget salvat.';
    f.cont.value = ''; f.suma.value = '';
    renderBudget($('#stmtYear') ? $('#stmtYear').value : f.an.value);
  } catch (err) { $('#budgetStatus').className = 'status err'; $('#budgetStatus').textContent = err.message; }
});
async function renderForecast() {
  const box = $('#forecastView'); if (!box) return;
  const months = ($('#fcMonths') && $('#fcMonths').value) || 6;
  let f; try { f = await api('/api/cash-forecast?months=' + months); } catch (e) { box.innerHTML = ''; return; }
  const sign = (v) => (v > 0 ? '+' : '') + fmt(v);
  const rows = f.rows.map((r) => `<tr${r.closing < 0 ? ' style="background:#fdecea;color:#7a1f1f"' : ''}>
    <td>${r.period}</td><td class="num">${fmt(r.opening)}</td>
    <td class="num">${r.incClienti ? '+' + fmt(r.incClienti) : ''}</td>
    <td class="num">${r.recIn ? '+' + fmt(r.recIn) : ''}</td>
    <td class="num">${r.platiFurnizori ? '−' + fmt(r.platiFurnizori) : ''}</td>
    <td class="num">${r.recOut ? '−' + fmt(r.recOut) : ''}</td>
    <td class="num" style="color:${r.net >= 0 ? 'var(--accent)' : 'var(--danger)'}">${sign(r.net)}</td>
    <td class="num" style="font-weight:600;color:${r.closing < 0 ? 'var(--danger)' : 'inherit'}">${fmt(r.closing)}</td></tr>`).join('');
  box.innerHTML = `<p class="muted">Numerar acum: <b>${fmt(f.cashNow)}</b> lei · de încasat: ${fmt(f.openReceivables)} · de plătit: ${fmt(f.openPayables)}</p>
    ${f.riscLichiditate ? `<div class="warnbox"><span class="wi">⚠️</span><div><b>Risc de lichiditate:</b> soldul de numerar proiectat scade până la <b>${fmt(f.minClosing)}</b> lei. Urmărește încasările sau amână plăți.</div></div>` : ''}
    <table><thead><tr><th>Luna</th><th class="num">Sold inițial</th><th class="num">Înc. clienți</th><th class="num">Venit recurent</th><th class="num">Plăți furnizori</th><th class="num">Chelt. recurentă</th><th class="num">Flux net</th><th class="num">Sold final</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted" style="font-size:12px">Model: luna curentă încasează soldurile deschise de clienți și plătește datoriile către furnizori; toate lunile adaugă facturile recurente scadente. Estimare orientativă, nu garanție.</p>`;
}
$('#fcMonths') && $('#fcMonths').addEventListener('change', renderForecast);
function renderYoY(yo) {
  const box = $('#yoyView'); if (!box) return;
  if (!yo || yo.prevYear == null) { box.innerHTML = '<p class="muted">—</p>'; return; }
  const delta = (d, goodUp) => {
    if (d == null) return '<span class="muted">fără bază</span>';
    const good = goodUp ? d >= 0 : d <= 0;
    return `<span style="color:${good ? 'var(--accent)' : 'var(--danger)'};font-weight:600">${d >= 0 ? '▲ +' : '▼ '}${fmt(d)}%</span>`;
  };
  const row = (lbl, cur, prev, d, goodUp) => `<tr><td>${lbl}</td><td class="num">${fmt(prev)}</td><td class="num">${fmt(cur)}</td><td class="num">${delta(d, goodUp)}</td></tr>`;
  box.innerHTML = `<table><thead><tr><th>Indicator</th><th class="num">${yo.prevYear}</th><th class="num">${yo.year}</th><th class="num">Variație</th></tr></thead><tbody>
    ${row('Venituri totale', yo.venituri, yo.venituriPrev, yo.venituriDelta, true)}
    ${row('Cheltuieli totale', yo.cheltuieli, yo.cheltuieliPrev, yo.cheltuieliDelta, false)}
    ${row('Rezultat net', yo.profit, yo.profitPrev, yo.profitDelta, true)}
    <tr><td>Marjă netă (%)</td><td class="num">${yo.marjaPrev == null ? '—' : fmt(yo.marjaPrev) + '%'}</td><td class="num">${yo.marja == null ? '—' : fmt(yo.marja) + '%'}</td><td class="num">${yo.marja != null && yo.marjaPrev != null ? delta(Math.round((yo.marja - yo.marjaPrev) * 100) / 100, true) : '—'}</td></tr>
    </tbody></table>
    <p class="muted" style="font-size:12px">Comparația cumulează tot exercițiul curent față de cel precedent. La marjă, variația e în puncte procentuale.</p>`;
}
// Bandă de alerte acționabile (stil command-center) — calculată din datele deja primite
function renderDashAlerts(k) {
  const box = $('#dashAlerts'); if (!box) return;
  const a = [];
  const ef = k.efactura || {};
  if (ef.count > 0) a.push({ ic: '📤', tone: ef.overdue > 0 ? 'bad' : 'warn',
    txt: '<b>' + ef.count + '</b> facturi emise netrimise în SPV (e-Factura, termen 5 zile lucrătoare)' + (ef.overdue > 0 ? ' — <b>' + ef.overdue + ' cu termen depășit</b>' : ''),
    go: 'iesite', cta: 'Trimite în SPV' });
  if (k.tvaDePlata > k.tvaDeRecuperat && k.tvaDePlata > 0) a.push({ ic: '🧾', tone: 'warn', txt: 'TVA de plată: <b>' + fmt(k.tvaDePlata) + '</b> lei', go: 'tva', cta: 'Decont TVA' });
  if (k.soldFurnizori > 0) a.push({ ic: '🏭', tone: 'warn', txt: '<b>' + fmt(k.soldFurnizori) + '</b> lei de plătit furnizorilor', go: 'cashbook', cta: 'Plăți' });
  if (k.soldClienti > 0) a.push({ ic: '👥', tone: 'info', txt: '<b>' + fmt(k.soldClienti) + '</b> lei de încasat de la clienți', go: 'analitic', cta: 'Scadențar' });
  if (k.profit < 0) a.push({ ic: '⚠️', tone: 'bad', txt: 'Rezultatul anului e <b>pierdere</b> (' + fmt(k.profit) + ' lei)', go: 'situatii', cta: 'Situații' });
  box.innerHTML = a.length
    ? a.map((x) => `<button type="button" class="alert ${x.tone}" data-go="${x.go}"><span class="al-ic">${x.ic}</span><span class="al-tx">${x.txt}</span><span class="al-cta">${x.cta} →</span></button>`).join('')
    : '<div class="alert ok"><span class="al-ic">✅</span><span class="al-tx">Totul pare în regulă — nicio acțiune urgentă pentru moment.</span></div>';
  $$('#dashAlerts .alert[data-go]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.go)));
}
function renderDashboardCharts(c) {
  $('#chartYear').textContent = c.year;
  $('#chartMonthly').innerHTML = svgMonthly(c.monthly);
  $('#chartAging').innerHTML = svgCompare(c.agingClienti.total, c.agingFurnizori.total);
  $('#chartAgingBars').innerHTML = svgAging(c);
}
const MN = ['', 'Ian', 'Feb', 'Mar', 'Apr', 'Mai', 'Iun', 'Iul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function svgMonthly(monthly) {
  const data = monthly.filter((m) => m.venituri || m.cheltuieli);
  if (!data.length) return '<p class="muted">Fără date pentru acest an.</p>';
  const W = 760; const H = 240; const padL = 46; const padR = 12; const padT = 10; const padB = 26;
  const plotW = W - padL - padR; const plotH = H - padT - padB;
  const max = Math.max(1, ...data.map((m) => Math.max(m.venituri, m.cheltuieli)));
  const gW = plotW / data.length; const bw = Math.min(16, gW / 3);
  const x = (i) => padL + i * gW + gW / 2;
  const y = (v) => padT + plotH - (v / max) * plotH;
  let bars = '';
  data.forEach((m, i) => {
    const cx = x(i);
    bars += `<rect rx="2" x="${(cx - bw - 1).toFixed(1)}" y="${y(m.venituri).toFixed(1)}" width="${bw}" height="${(padT + plotH - y(m.venituri)).toFixed(1)}" fill="#1a9c6b"><title>Venituri ${MN[m.luna]}: ${fmt(m.venituri)}</title></rect>`;
    bars += `<rect rx="2" x="${(cx + 1).toFixed(1)}" y="${y(m.cheltuieli).toFixed(1)}" width="${bw}" height="${(padT + plotH - y(m.cheltuieli)).toFixed(1)}" fill="#e0436a"><title>Cheltuieli ${MN[m.luna]}: ${fmt(m.cheltuieli)}</title></rect>`;
    bars += `<text x="${cx.toFixed(1)}" y="${H - 8}" font-size="10" text-anchor="middle" class="ctxt">${MN[m.luna]}</text>`;
  });
  let grid = '';
  for (let g = 0; g <= 2; g++) { const val = (max / 2) * g; const yy = y(val); grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" class="cgrid"/><text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" font-size="9" text-anchor="end" class="ctxt">${fmt(val)}</text>`; }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:260px">${grid}<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="caxis"/>${bars}</svg>
    <div class="muted" style="font-size:12px"><span style="color:#1a9c6b">■</span> Venituri &nbsp; <span style="color:#e0436a">■</span> Cheltuieli</div>`;
}
function svgCompare(creante, datorii) {
  const max = Math.max(1, creante, datorii);
  const bar = (lbl, v, col) => `<div style="margin:10px 0"><div style="display:flex;justify-content:space-between"><span>${lbl}</span><b>${fmt(v)}</b></div><div style="height:20px;background:var(--line);border-radius:6px;overflow:hidden"><div style="width:${(v / max * 100).toFixed(1)}%;height:100%;background:${col}"></div></div></div>`;
  return bar('Creanțe de încasat', creante, '#1a9c6b') + bar('Datorii de plătit', datorii, '#e0436a');
}
function svgAging(c) {
  const seg = [['0-30 zile', '#0b6e4f', 'b0_30'], ['31-60', '#b8860b', 'b31_60'], ['61-90', '#d98300', 'b61_90'], ['>90 zile', '#b00020', 'b90plus']];
  const row = (label, t) => {
    const total = (t && t.total) || 0;
    if (total <= 0) return `<div style="margin:8px 0"><b>${label}</b> <span class="muted">— niciun sold</span></div>`;
    const bar = seg.map((s) => { const w = (t[s[2]] / total) * 100; return w > 0 ? `<div title="${s[0]}: ${fmt(t[s[2]])}" style="width:${w.toFixed(1)}%;background:${s[1]}"></div>` : ''; }).join('');
    return `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between"><b>${label}</b><span>${fmt(total)}</span></div><div style="display:flex;height:18px;border-radius:6px;overflow:hidden;background:var(--line)">${bar}</div></div>`;
  };
  const legend = seg.map((s) => `<span style="color:${s[1]}">■</span> ${s[0]}`).join(' &nbsp; ');
  return row('Creanțe (clienți)', c.agingClienti) + row('Datorii (furnizori)', c.agingFurnizori) + `<div class="muted" style="font-size:12px;margin-top:6px">${legend}</div>`;
}
async function loadDashboardCharts() {
  let c; try { c = await api('/api/dashboard-charts'); } catch (e) { return; }
  renderDashboardCharts(c);
}

// ───────────────────────── IMPORT EXTRAS BANCAR ─────────────────────────
let BANK = { fileId: null, rows: [] };
$('#bankFile').addEventListener('change', async () => {
  const file = $('#bankFile').files[0]; if (!file) return;
  const st = $('#bankStatus'); st.className = 'status'; st.textContent = 'Se citește extrasul…';
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await api('/api/bank/parse', { method: 'POST', body: fd });
    BANK = { fileId: res.documentId, rows: res.transactions };
    st.className = 'status ok'; st.textContent = res.count + ' tranzacții găsite. Verifică și importă.';
    renderBank();
  } catch (e) { st.className = 'status err'; st.textContent = e.message; }
});
function renderBank() {
  if (!BANK.rows.length) { $('#bankResult').innerHTML = '<p class="muted">Nicio tranzacție.</p>'; $('#bankImport').classList.add('hidden'); return; }
  const tipOpts = (sel) => META.types.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${t.nume}</option>`).join('');
  $('#bankResult').innerHTML = `<table><thead><tr><th><input type="checkbox" id="bankAll" checked></th><th>Data</th><th>Descriere</th>
    <th class="num">Sumă</th><th>Sens</th><th>Tip înregistrare</th><th>Partener</th></tr></thead><tbody>${
    BANK.rows.map((r, i) => `<tr>
      <td><input type="checkbox" class="bsel" data-i="${i}" checked></td>
      <td>${r.data}</td><td>${(r.descriere || '').slice(0, 40)}</td>
      <td class="num">${fmt(r.suma)}</td><td>${r.sens === 'in' ? '↓ încasare' : '↑ plată'}</td>
      <td><select class="btip" data-i="${i}">${tipOpts(r.tip)}</select></td>
      <td><input class="bpart" data-i="${i}" value="${(r.fields.partener || '').replace(/"/g, '&quot;')}" />${r.matched ? ' <span class="pill">potrivit</span>' : ''}</td>
    </tr>`).join('')}</tbody></table>`;
  $('#bankImport').classList.remove('hidden');
  $('#bankAll').addEventListener('change', (e) => $$('.bsel').forEach((c) => { c.checked = e.target.checked; }));
  $$('.btip').forEach((s) => s.addEventListener('change', () => { BANK.rows[s.dataset.i].tip = s.value; }));
  $$('.bpart').forEach((inp) => inp.addEventListener('input', () => { BANK.rows[inp.dataset.i].fields.partener = inp.value; }));
}
$('#bankImport').addEventListener('click', async () => {
  const sel = $$('.bsel').filter((c) => c.checked).map((c) => Number(c.dataset.i));
  const transactions = sel.map((i) => ({ tip: BANK.rows[i].tip, fields: BANK.rows[i].fields }));
  if (!transactions.length) return toast('Selectează cel puțin o tranzacție', true);
  try {
    const r = await api('/api/bank/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactions, fileId: BANK.fileId }) });
    toast(r.created + ' înregistrări create' + (r.errors.length ? ', ' + r.errors.length + ' erori' : ''));
    BANK = { fileId: null, rows: [] }; $('#bankResult').innerHTML = ''; $('#bankImport').classList.add('hidden'); $('#bankFile').value = '';
    META = await api('/api/meta'); fillPeriods(); loadEntries(); loadDashboard();
  } catch (e) { toast(e.message, true); }
});
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
  ['nume', 'cui', 'regCom', 'adresa', 'oras', 'judet', 'iban', 'banca', 'telefon', 'email', 'capitalSocial', 'pdfFooter'].forEach((k) => { if (f[k]) f[k].value = META.company[k] || ''; });
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
const LUNI = ['Ianuarie', 'Februarie', 'Martie', 'Aprilie', 'Mai', 'Iunie', 'Iulie', 'August', 'Septembrie', 'Octombrie', 'Noiembrie', 'Decembrie'];
// Compune perioada dintr-o pereche Lună+An: "YYYY-MM" daca e luna, "YYYY" daca e tot anul, "" daca nimic
function pget(prefix) {
  const a = $('#' + prefix + 'An'); const l = $('#' + prefix + 'Luna');
  const y = a ? a.value : ''; const m = l ? l.value : '';
  if (!y) return '';
  return m ? (y + '-' + m) : y;
}
// „Luna de lucru” — pornește de la luna curentă și avansează la închiderea de lună
function workMonth() {
  let m = '';
  try { m = localStorage.getItem('contab_workmonth') || ''; } catch (e) { /* ignora */ }
  if (!/^\d{4}-\d{2}$/.test(m)) m = new Date().toISOString().slice(0, 7);
  return m;
}
function setWorkMonth(m) {
  try { localStorage.setItem('contab_workmonth', m); } catch (e) { /* ignora */ }
  setCurrentPeriod();
}
function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function nextMonth(m) { return shiftMonth(m, 1); }
function prevMonth(m) { return shiftMonth(m, -1); }
function lunaLabel(m) { const [y, mo] = m.split('-').map(Number); return LUNI[mo - 1] + ' ' + y; }
// ───────── Vizualizator PDF/document/e-Factura in aplicatie ─────────
let VIEWER_TEXT = '';
function openViewer(url, title) {
  $('#pdfTitle').textContent = title || 'Document';
  $('#pdfOpen').href = url; $('#pdfDownload').href = url;
  if ($('#pdfCopy')) $('#pdfCopy').classList.add('hidden');
  $('#viewerHtml').classList.add('hidden');
  $('#pdfFrame').classList.remove('hidden');
  $('#pdfFrame').src = url;
  $('#pdfModal').classList.remove('hidden');
}
function openViewerHtml(html, title, url) {
  $('#pdfTitle').textContent = title || 'Document';
  $('#pdfOpen').href = url; $('#pdfDownload').href = url;
  if ($('#pdfCopy')) $('#pdfCopy').classList.add('hidden');
  $('#pdfFrame').classList.add('hidden'); $('#pdfFrame').src = 'about:blank';
  $('#viewerHtml').innerHTML = html; $('#viewerHtml').classList.remove('hidden');
  $('#pdfModal').classList.remove('hidden');
}
// Vedere text simplu (ca în Notepad) — pentru CSV
async function openCsvViewer(url, title) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let text = await res.text();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // scoate BOM la afisare
    VIEWER_TEXT = text;
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    openViewerHtml(`<pre class="txtview">${esc(text)}</pre>`, title || 'Fișier CSV', url);
    if ($('#pdfCopy')) $('#pdfCopy').classList.remove('hidden');
  } catch (e) { window.open(url, '_blank'); }
}
function closeViewer() {
  const m = $('#pdfModal'); if (!m || m.classList.contains('hidden')) return false;
  m.classList.add('hidden'); $('#pdfFrame').src = 'about:blank'; return true;
}
// Parseaza UBL si construieste o factura lizibila (e-Factura)
async function openEfacturaViewer(url, title) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML invalid');
    openViewerHtml(renderEfactura(doc), title || 'e-Factura', url);
  } catch (e) { openViewer(url, title || 'e-Factura'); } // fallback: XML brut in iframe
}
// Vizualizator XML ANAF (D300/D394/D112/SAF-T) — pretty-print + colorare usoara, in aplicatie
function prettyXml(xml) {
  try {
    let out = ''; let pad = 0;
    const s = xml.replace(/>\s+</g, '><').replace(/(>)(<)(\/*)/g, '$1\n$2$3');
    s.split('\n').forEach((ln) => {
      ln = ln.trim(); if (!ln) return;
      if (/^<\/\w/.test(ln)) pad = Math.max(pad - 1, 0);
      out += '  '.repeat(pad) + ln + '\n';
      if (/^<\w[^>]*>$/.test(ln) && !/^<\?/.test(ln) && !/\/>$/.test(ln)) pad += 1;
    });
    return out.trim() || xml;
  } catch (e) { return xml; }
}
function highlightXml(esc) {
  return esc
    .replace(/(&lt;[!?/]?)([\w:.-]+)/g, '$1<span class="xtag">$2</span>')
    .replace(/([\w:.-]+)(=)(&quot;[^&]*?&quot;)/g, '<span class="xattr">$1</span>$2<span class="xval">$3</span>');
}
function xmlTitle(href) {
  const m = (href || '').match(/\/xml\/([a-z0-9]+)/i);
  const map = { d300: 'D300 — Decont TVA (XML ANAF)', d394: 'D394 — Declarație informativă (XML ANAF)', d112: 'D112 — Salarii / contribuții (XML ANAF)', saft: 'SAF-T / D406 (XML ANAF)' };
  return (m && map[(m[1] || '').toLowerCase()]) || 'XML ANAF';
}
async function openXmlViewer(url) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const pretty = prettyXml(await res.text());
    VIEWER_TEXT = pretty;
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    openViewerHtml(`<pre class="txtview xmlview">${highlightXml(esc(pretty))}</pre>`, xmlTitle(url), url);
    if ($('#pdfCopy')) $('#pdfCopy').classList.remove('hidden');
  } catch (e) { window.open(url, '_blank'); }
}
function renderEfactura(doc) {
  const root = doc.documentElement;
  const T = (el, tag) => { const x = el && el.getElementsByTagName(tag)[0]; return x ? x.textContent.trim() : ''; };
  const party = (sel) => doc.getElementsByTagName(sel)[0];
  const sup = party('cac:AccountingSupplierParty'); const cus = party('cac:AccountingCustomerParty');
  const pName = (p) => T(p, 'cbc:RegistrationName') || T(p, 'cbc:Name');
  const cur = T(root, 'cbc:DocumentCurrencyCode') || 'RON';
  const isCN = /CreditNote/.test(root.tagName);
  const lineTags = isCN ? 'cac:CreditNoteLine' : 'cac:InvoiceLine';
  const qtyTag = isCN ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';
  const lines = [...doc.getElementsByTagName(lineTags)].map((ln) => ({
    nume: T(ln, 'cbc:Name'), qty: T(ln, qtyTag), pret: T(ln.getElementsByTagName('cac:Price')[0], 'cbc:PriceAmount'),
    val: T(ln, 'cbc:LineExtensionAmount'), cota: T(ln, 'cbc:Percent'),
  }));
  const tt = party('cac:TaxTotal');
  const baza = T(root, 'cbc:TaxExclusiveAmount'); const tva = T(tt, 'cbc:TaxAmount');
  const total = T(root, 'cbc:PayableAmount') || T(root, 'cbc:TaxInclusiveAmount');
  const esc = (s) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const money = (v) => v ? Number(v).toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + cur : '';
  const idDirect = (() => { for (const c of root.children) if (c.tagName === 'cbc:ID') return c.textContent.trim(); return ''; })();
  return `<div class="efact-doc">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div><h3>${isCN ? 'Factură storno (CreditNote)' : 'Factură (e-Factura)'}</h3>
        <div class="muted">Serie/nr: <b>${esc(idDirect)}</b> · Data: <b>${esc(T(root, 'cbc:IssueDate'))}</b></div></div>
      <div class="pill">UBL · CIUS-RO</div>
    </div>
    <div class="efact-parties">
      <div><div class="lbl">Furnizor</div><b>${esc(pName(sup))}</b><br><span class="muted">CUI: ${esc(T(sup, 'cbc:CompanyID'))}</span></div>
      <div><div class="lbl">Cumpărător</div><b>${esc(pName(cus))}</b><br><span class="muted">CUI: ${esc(T(cus, 'cbc:CompanyID'))}</span></div>
    </div>
    <table><thead><tr><th>Denumire</th><th class="num">Cant.</th><th class="num">Preț</th><th class="num">Cotă</th><th class="num">Valoare</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td>${esc(l.nume)}</td><td class="num">${esc(l.qty)}</td><td class="num">${money(l.pret)}</td><td class="num">${l.cota ? l.cota + '%' : '—'}</td><td class="num">${money(l.val)}</td></tr>`).join('')}</tbody>
    </table>
    <table class="efact-tot"><tbody>
      <tr><td>Bază impozabilă</td><td class="num">${money(baza)}</td></tr>
      <tr><td>TVA</td><td class="num">${money(tva)}</td></tr>
      <tr class="grand"><td>Total de plată</td><td class="num">${money(total)}</td></tr>
    </tbody></table>
  </div>`;
}
if ($('#pdfClose')) {
  $('#pdfClose').addEventListener('click', closeViewer);
  $('#pdfModal').addEventListener('click', (e) => { if (e.target.id === 'pdfModal') closeViewer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });
  if ($('#pdfCopy')) {
    $('#pdfCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(VIEWER_TEXT); toast('Copiat în clipboard'); }
      catch (e) { toast('Nu s-a putut copia', true); }
    });
  }
  // Intercepteaza link-urile -> deschide in aplicatie
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a'); if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/\/xml\/efactura\//.test(href)) { e.preventDefault(); openEfacturaViewer(a.href, 'e-Factura'); return; }
    if (/^\/xml\//.test(href)) { e.preventDefault(); openXmlViewer(a.href); return; }
    if (/^\/csv\//.test(href)) { e.preventDefault(); openCsvViewer(a.href, (a.textContent || '').replace(/[⬇\s]/g, ' ').trim() || 'Fișier CSV'); return; }
    if (/^\/pdf\//.test(href) || /\/api\/document\/[^/]+\/file/.test(href)) {
      e.preventDefault();
      openViewer(a.href, (a.textContent || '').trim() || a.getAttribute('title') || 'Document');
    }
  });
}
// Afiseaza luna de lucru in bara de sus (langa firma)
function setCurrentPeriod() {
  const el = $('#currentPeriod'); if (!el) return;
  el.textContent = lunaLabel(workMonth());
}
// Aplica luna de lucru pe toate filtrele de tabel si reincarca ecranul curent
function applyWorkMonth() {
  const m = workMonth(); const mo = m.slice(5); const yr = m.slice(0, 4);
  $$('select.luna, select.luna-req').forEach((s) => { if ([...s.options].some((o) => o.value === mo)) s.value = mo; });
  $$('select.an').forEach((s) => { if ([...s.options].some((o) => o.value === yr)) s.value = yr; });
  // câmpurile anuale (situații financiare, închidere anuală, registru salarii) urmează anul de lucru
  ['stmtYear', 'yearInput', 'rsYear'].forEach((id) => { const el = $('#' + id); if (el) el.value = yr; });
  // câmpurile native de lună rămase (dacă există) urmează luna de lucru
  $$('input[type="month"].period').forEach((el) => { el.value = m; });
  if (typeof renderEntryLists === 'function') renderEntryLists();
  const active = $('#tabs button[data-tab].active');
  if (active && typeof onTab === 'function') onTab(active.dataset.tab);
}
setCurrentPeriod();
// Navigare luna de lucru din bara de sus
function goWorkMonth(m) { setWorkMonth(m); applyWorkMonth(); }
$('#prevMonth') && $('#prevMonth').addEventListener('click', () => goWorkMonth(prevMonth(workMonth())));
$('#nextMonth') && $('#nextMonth').addEventListener('click', () => goWorkMonth(nextMonth(workMonth())));
$('#currentPeriod') && $('#currentPeriod').addEventListener('click', () => goWorkMonth(new Date().toISOString().slice(0, 7)));
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
// Leaga schimbarea perechii Lună+An de functia de reincarcare a tabelului
function onPeriodChange(prefix, fn) {
  ['Luna', 'An'].forEach((sfx) => {
    const el = $('#' + prefix + sfx);
    if (!el) return;
    el.addEventListener('change', () => {
      const p = pget(prefix);
      // o lună anume devine „luna de lucru” și sincronizează TOATE tabelele (jurnal, intrări, ieșiri…)
      if (/^\d{4}-\d{2}$/.test(p)) { setWorkMonth(p); applyWorkMonth(); }
      else { fn(); } // „Toate lunile” / an întreg: doar tabelul curent
    });
  });
}
function fillPeriods() {
  const now = new Date();
  const curY = String(now.getFullYear());
  const years = new Set((META.periods || []).map((p) => String(p).slice(0, 4)).filter((y) => /^\d{4}$/.test(y)));
  years.add(curY);
  years.add(String(now.getFullYear() + 1)); // anul urmator (pt. trecerea Decembrie -> Ianuarie)
  const wm = workMonth(); const wmM = wm.slice(5); const wmY = wm.slice(0, 4);
  years.add(wmY);
  const yearOpts = [...years].sort().reverse().map((y) => `<option value="${y}">${y}</option>`).join('');
  const monthOpts = LUNI.map((n, i) => `<option value="${String(i + 1).padStart(2, '0')}">${n}</option>`).join('');
  const lunaOpts = '<option value="">Toate lunile</option>' + monthOpts;
  // implicit, toate filtrele pornesc pe LUNA DE LUCRU (poti alege „Toate lunile” oricand)
  $$('select.an').forEach((s) => { const keep = s.value; s.innerHTML = yearOpts; s.value = keep || wmY; });
  $$('select.luna').forEach((s) => { const keep = s.value; s.innerHTML = lunaOpts; s.value = keep || wmM; });
  // luna obligatorie (stocuri, salarizare, mijloace fixe) — fara „Toate”
  $$('select.luna-req').forEach((s) => { const keep = s.value; s.innerHTML = monthOpts; s.value = keep || wmM; });
}

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
function pickWizardType(tip) {
  closeWizard();
  goTab('documente');
  const real = tip === '__all__' ? 'nota_contabila' : tip;
  CURRENT = { documentId: null, fields: {}, suggestedType: real };
  openForm(real, { data: new Date().toISOString().slice(0, 10) });
  setTimeout(() => { const el = $('#entryForm'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (tip === '__all__') { const t = $('#tipSelect'); if (t) t.focus(); } }, 80);
}
$('#qaWizard') && $('#qaWizard').addEventListener('click', openWizard);
$('#opwBack') && $('#opwBack').addEventListener('click', () => { opwCat = null; renderWizard(); });
$('#opwClose') && $('#opwClose').addEventListener('click', closeWizard);
$('#opWizard') && $('#opWizard').addEventListener('click', (e) => { if (e.target.id === 'opWizard') closeWizard(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#opWizard').classList.contains('hidden')) closeWizard(); });

// Harta ciclului contabil — afisata in capul ecranelor din ciclu, cu pasul curent evidentiat
const CYCLE = [
  { go: 'documente', ic: '📥', t: 'Documente' },
  { go: 'jurnal', ic: '📘', t: 'Operațiuni' },
  { go: 'carte', ic: '📗', t: 'Fișe conturi' },
  { go: 'balanta', ic: '⚖️', t: 'Solduri' },
  { go: 'inchideri', ic: '🔒', t: 'Închideri' },
  { go: 'livrabile', ic: '📤', t: 'Declarații' },
];
$$('.cyclemap').forEach((m) => {
  const cur = m.dataset.step;
  m.innerHTML = CYCLE.map((s, i) =>
    `${i ? '<span class="cyclearrow" aria-hidden="true">→</span>' : ''}<button class="cyclestep${s.go === cur ? ' active' : ''}" data-go="${s.go}"${s.go === cur ? ' aria-current="page"' : ''}><span class="ci" aria-hidden="true">${s.ic}</span>${s.t}</button>`
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
  { group: 'Stoc & salarii', ic: '📦', title: 'Stoc & salarii', text: 'Stocuri, salarii și mijloace fixe — dacă firma ta are nevoie de ele.' },
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

// Documente de IESIRE — butoane „emite” deschid formularul cu tipul potrivit
$$('.emit').forEach((btn) => btn.addEventListener('click', () => {
  const tip = btn.dataset.tip;
  CURRENT = { documentId: null, fields: {}, suggestedType: tip };
  openForm(tip, { data: new Date().toISOString().slice(0, 10) });
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
        inv.linii.map((l) => `<tr><td>${l.nume}</td><td class="num">${fmt(l.cantitate)}</td><td class="num">${fmt(l.pret)}</td><td class="num">${fmt(l.valoare)}</td><td class="num">${l.cota}</td></tr>`).join('')}</tbody></table>`
      : '';
    box.innerHTML = `<div class="card">
      <p style="margin:0 0 6px">${inv.tip === 'creditnote' ? '↩️ <b>Notă de credit (storno)</b>' : '🧾 <b>Factură de cumpărare</b>'} ${inv.moneda !== 'RON' ? '<span class="status err">— monedă ' + inv.moneda + ' (neacceptat automat)</span>' : ''}</p>
      <table>
        <tr><td>Furnizor</td><td><b>${inv.furnizor.nume || '—'}</b> ${inv.furnizor.cui ? '(CUI ' + inv.furnizor.cui + ')' : ''}</td></tr>
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
  let data; try { data = await api('/api/subscription'); } catch (e) { statusBox.innerHTML = `<p class="status err">${e.message}</p>`; return; }
  renderSubscription(data);
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

function openForm(tipId, fields) {
  $('#noDoc').classList.add('hidden');
  $('#entryForm').classList.remove('hidden');
  $('#tipSelect').value = tipId || 'nota_contabila';
  renderFields(fields || {});
}
function closeForm() { $('#entryForm').classList.add('hidden'); $('#noDoc').classList.remove('hidden'); CURRENT = null; }

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
  row.innerHTML = `<input class="it-nume" placeholder="Denumire" value="${(it.nume || '').toString().replace(/"/g, '&quot;')}">
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
    META = await api('/api/meta'); fillPeriods();
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
    <td>${e.data}</td>
    <td>${e.tipNume}${e.system ? ' <span class="pill">auto</span>' : ''}</td>
    <td>${e.partener || ''}</td>
    <td class="acc">${formula}</td>
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
    META = await api('/api/meta'); fillPeriods(); loadEntries();
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
  const row = (e, extra) => `<tr><td>${e.data}</td><td>${e.tipNume}</td><td>${e.partener || ''}</td><td class="num">${total(e)}</td>
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

// ───────────────────────── JOURNAL ─────────────────────────
onPeriodChange('jurnal', loadJournal);
async function loadJournal() {
  const p = pget('jurnal');
  $('#jurnalPdf').href = '/pdf/journal' + (p ? '?period=' + p : '');
  $('#jurnalCsv').href = '/csv/journal' + (p ? '?period=' + p : '');
  const j = await api('/api/journal' + (p ? '?period=' + p : ''));
  if (!j.rows.length) { $('#jurnalView').innerHTML = '<p class="muted">Nicio înregistrare în perioada selectată.</p>'; return; }
  const rows = j.rows.map((r) => `<tr${r.nr ? ' style="border-top:2px solid var(--line)"' : ''}>
    <td class="num">${r.nr || ''}</td><td>${r.data}</td><td>${r.document}</td><td>${r.explicatie}</td>
    <td class="acc">${r.debit}</td><td class="acc">${r.credit}</td><td class="num">${fmt(r.suma)}</td></tr>`).join('');
  $('#jurnalView').innerHTML = `<table><thead><tr>
    <th>Nr</th><th>Data</th><th>Document</th><th>Explicație</th><th>Cont D</th><th>Cont C</th><th class="num">Sumă</th>
    </tr></thead><tbody>${rows}
    <tr class="total"><td colspan="6">TOTAL</td><td class="num">${fmt(j.total)}</td></tr></tbody></table>`;
}

// ───────────────────────── LEDGER ─────────────────────────
onPeriodChange('carte', loadLedger);
async function loadLedger() {
  const p = pget('carte');
  $('#cartePdf').href = '/pdf/ledger' + (p ? '?period=' + p : '');
  $('#carteCsv').href = '/csv/ledger' + (p ? '?period=' + p : '');
  const accs = await api('/api/ledger' + (p ? '?period=' + p : ''));
  if (!accs.length) { $('#carteView').innerHTML = '<p class="muted">Nicio mișcare.</p>'; return; }
  $('#carteView').innerHTML = accs.map((a) => {
    const moves = a.moves.map((m) => `<tr><td>${m.data}</td><td>${m.explicatie}</td>
      <td class="num">${m.debit ? fmt(m.debit) : ''}</td><td class="num">${m.credit ? fmt(m.credit) : ''}</td></tr>`).join('');
    return `<div class="ledger-acc">
      <h4><span class="acc">${a.cod}</span> — ${a.nume} <a class="linkbtn" href="/pdf/fisa-cont?cont=${a.cod}${p ? '&period=' + p : ''}" target="_blank" title="Fișa de cont: mișcări cu cont corespondent și sold curent">fișă de cont</a></h4>
      <p class="muted">Sold inițial: D ${fmt(a.siD)} / C ${fmt(a.siC)}</p>
      <div class="tablewrap"><table><thead><tr><th>Data</th><th>Explicație</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
      <tbody>${moves}
      <tr class="total"><td colspan="2">Rulaj perioadă</td><td class="num">${fmt(a.rd)}</td><td class="num">${fmt(a.rc)}</td></tr>
      <tr class="total"><td colspan="2">Sold final</td><td class="num">${fmt(a.sfD)}</td><td class="num">${fmt(a.sfC)}</td></tr>
      </tbody></table></div></div>`;
  }).join('');
}

// ───────────────────────── BANCA / CASA ─────────────────────────
$('#cbCont').addEventListener('change', loadCashbook);
onPeriodChange('cb', loadCashbook);
async function loadCashbook() {
  const cont = $('#cbCont').value; const p = pget('cb');
  const q = '?cont=' + cont + (p ? '&period=' + p : '');
  $('#cbPdf').href = '/pdf/cashbook' + q;
  const cb = await api('/api/cashbook' + q);
  let warnHtml = '';
  if (/^53/.test(cont)) { // control de casa doar pentru numerar
    try {
      const cc = await api('/api/cash-control' + q);
      const items = [];
      cc.negative.forEach((n) => items.push(`<li><b>Sold de casă NEGATIV</b> (${fmt(n.sold)} lei) la ${n.data} — imposibil fizic; verifică ordinea operațiunilor sau o încasare lipsă.</li>`));
      cc.plafon.forEach((w) => items.push(`<li><b>Plafon numerar depășit</b> (Legea 70/2015): ${w.tip === 'plata' ? 'plăți' : 'încasări'} de ${fmt(w.suma)} lei cu „${w.partener}" la ${w.data} — limita ${fmt(w.limita)} lei/zi (${w.juridic ? 'pers. juridică' : 'pers. fizică'}).</li>`));
      if (cc.soldPesteLimita) items.push(`<li>Sold de casierie ${fmt(cc.soldPesteLimita.sold)} lei peste plafonul de ${fmt(cc.soldPesteLimita.limita)} lei — depune excedentul la bancă.</li>`);
      if (items.length) warnHtml = `<div class="warnbox"><span class="wi">⚠️</span><div><b>Control casă:</b><ul style="margin:4px 0 0 16px;padding:0">${items.join('')}</ul></div></div>`;
    } catch (_) { /* control optional */ }
  }
  const rows = cb.rows.map((r) => `<tr><td>${r.data}</td><td>${r.document || ''}</td><td>${(r.partener ? r.partener + ' — ' : '') + r.explicatie}</td>
    <td class="num">${r.incasare ? fmt(r.incasare) : ''}</td><td class="num">${r.plata ? fmt(r.plata) : ''}</td><td class="num">${fmt(r.sold)}</td></tr>`).join('');
  $('#cbView').innerHTML = warnHtml + `<p class="muted">Sold inițial: ${fmt(cb.siInitial)} lei</p>
    <table><thead><tr><th>Data</th><th>Document</th><th>Explicație</th><th class="num">Încasări</th><th class="num">Plăți</th><th class="num">Sold</th></tr></thead>
    <tbody>${rows || ''}<tr class="total"><td colspan="3">Rulaje / Sold final</td><td class="num">${fmt(cb.rd)}</td><td class="num">${fmt(cb.rc)}</td><td class="num">${fmt(cb.sfFinal)}</td></tr></tbody></table>`;
  loadCashValuta();
}
async function loadCashValuta() {
  const box = $('#cvView'); if (!box) return;
  const p = pget('cb'); const moneda = ($('#cvMoneda').value || 'EUR').toUpperCase();
  const q = '?moneda=' + encodeURIComponent(moneda) + (p ? '&period=' + p : '');
  $('#cvPdf').href = '/pdf/cash-valuta' + q;
  let reg; try { reg = await api('/api/cash-valuta' + q); } catch (e) { box.innerHTML = ''; return; }
  const rows = reg.rows.map((r) => `<tr><td>${r.data}</td><td>${r.document || ''}</td><td>${r.explicatie}</td>
    <td>${r.moneda || ''}</td><td class="num">${r.curs ? fmt(r.curs) : ''}</td>
    <td class="num">${r.incasareVal ? fmt(r.incasareVal) : ''}</td><td class="num">${r.plataVal ? fmt(r.plataVal) : ''}</td><td class="num">${fmt(r.soldVal)}</td>
    <td class="num">${r.incasareLei ? fmt(r.incasareLei) : ''}</td><td class="num">${r.plataLei ? fmt(r.plataLei) : ''}</td><td class="num">${fmt(r.soldLei)}</td></tr>`).join('');
  box.innerHTML = reg.rows.length
    ? `<p class="muted">Sold inițial lei: ${fmt(reg.siLei)} · monedă afișată: <b>${reg.moneda}</b></p>
      <table><thead><tr><th>Data</th><th>Doc.</th><th>Explicație</th><th>Mon.</th><th class="num">Curs</th><th class="num">Înc. val.</th><th class="num">Plăți val.</th><th class="num">Sold val.</th><th class="num">Înc. lei</th><th class="num">Plăți lei</th><th class="num">Sold lei</th></tr></thead>
      <tbody>${rows}<tr class="total"><td colspan="5">TOTAL ${reg.moneda} / SOLD FINAL</td><td class="num">${fmt(reg.rdVal)}</td><td class="num">${fmt(reg.rcVal)}</td><td class="num">${fmt(reg.soldFinalVal)}</td><td class="num">${fmt(reg.rdLei)}</td><td class="num">${fmt(reg.rcLei)}</td><td class="num">${fmt(reg.soldFinalLei)}</td></tr></tbody></table>`
    : '<p class="muted">Nicio mișcare prin casa în valută (5314) în perioadă.</p>';
}
$('#cvMoneda') && $('#cvMoneda').addEventListener('change', loadCashValuta);

// ───────────────────────── BALANCE ─────────────────────────
onPeriodChange('balanta', loadBalance);
let BALANCE_TB = null;
async function loadBalance() {
  const p = pget('balanta');
  $('#balantaPdf').href = '/pdf/balance' + (p ? '?period=' + p : '');
  $('#balantaCsv').href = '/csv/balance' + (p ? '?period=' + p : '');
  BALANCE_TB = await api('/api/balance' + (p ? '?period=' + p : ''));
  renderBalance();
}
$('#balOnlyMoves') && $('#balOnlyMoves').addEventListener('change', renderBalance);
function renderBalance() {
  const tb = BALANCE_TB; if (!tb) return;
  if (tb.balanced) {
    $('#balantaStatus').innerHTML = '<p style="color:var(--accent);font-weight:600">✔ Balanța se închide — cele patru egalități sunt respectate.</p>';
  } else {
    // diagnostic: arata care egalitate nu se inchide si cu cat (de regula soldurile initiale)
    const t = tb.tot;
    const eqs = [
      ['Sold inițial', t.siD, t.siC],
      ['Rulaje', t.rd, t.rc],
      ['Total sume', t.tsD, t.tsC],
      ['Sold final', t.sfD, t.sfC],
    ].map(([nume, d, c]) => ({ nume, d, c, dif: Math.round((d - c) * 100) / 100 })).filter((x) => x.dif !== 0);
    const det = eqs.map((x) => `<b>${x.nume}</b>: debit ${fmt(x.d)} vs credit ${fmt(x.c)} — diferență <b>${fmt(x.dif)}</b>`).join('<br>');
    const initDif = eqs.some((x) => x.nume === 'Sold inițial');
    $('#balantaStatus').innerHTML = `<div style="color:var(--danger)"><p style="font-weight:600;margin:0 0 4px">✘ Balanța NU se închide:</p>
      <p style="margin:0;font-size:13px">${det}</p>
      ${initDif ? '<p style="margin:6px 0 0;font-size:13px">Diferența pornește de la <b>soldurile inițiale dezechilibrate</b> (total debit ≠ total credit la deschidere) — verifică-le în Setări / import.</p>' : '<p style="margin:6px 0 0;font-size:13px">Verifică ultimele înregistrări din lună.</p>'}</div>`;
  }
  const onlyMoves = $('#balOnlyMoves') && $('#balOnlyMoves').checked;
  const visible = onlyMoves ? tb.rows.filter((r) => r.rd || r.rc) : tb.rows;
  if (!visible.length) { $('#balantaView').innerHTML = `<p class="muted">${onlyMoves ? 'Niciun cont cu mișcări în luna aleasă.' : 'Niciun cont.'}</p>`; return; }
  const rows = visible.map((r) => `<tr>
    <td class="acc">${r.cod}</td><td>${r.nume}</td>
    <td class="num grpsep">${fmt(r.siD)}</td><td class="num">${fmt(r.siC)}</td>
    <td class="num grpsep">${fmt(r.rd)}</td><td class="num">${fmt(r.rc)}</td>
    <td class="num grpsep">${fmt(r.tsD)}</td><td class="num">${fmt(r.tsC)}</td>
    <td class="num grpsep">${fmt(r.sfD)}</td><td class="num">${fmt(r.sfC)}</td></tr>`).join('');
  // total: cel general, sau recalculat din rândurile vizibile când filtrăm pe „doar mișcări”
  const t = onlyMoves
    ? ['siD', 'siC', 'rd', 'rc', 'tsD', 'tsC', 'sfD', 'sfC'].reduce((o, k) => (o[k] = visible.reduce((s, r) => s + (r[k] || 0), 0), o), {})
    : tb.tot;
  $('#balantaView').innerHTML = `<table><thead>
    <tr>
      <th rowspan="2">Cont</th><th rowspan="2">Denumire</th>
      <th colspan="2" class="bal-grp si">Sold inițial (reportat)</th>
      <th colspan="2" class="bal-grp ru">Rulaj lună</th>
      <th colspan="2" class="bal-grp su">Total sume</th>
      <th colspan="2" class="bal-grp sf">Sold final</th>
    </tr>
    <tr>
      <th class="num grpsep">Debit</th><th class="num">Credit</th>
      <th class="num grpsep">Debit</th><th class="num">Credit</th>
      <th class="num grpsep">Debit</th><th class="num">Credit</th>
      <th class="num grpsep">Debit</th><th class="num">Credit</th>
    </tr></thead>
    <tbody>${rows}<tr class="total"><td colspan="2">TOTAL</td>
    <td class="num grpsep">${fmt(t.siD)}</td><td class="num">${fmt(t.siC)}</td>
    <td class="num grpsep">${fmt(t.rd)}</td><td class="num">${fmt(t.rc)}</td>
    <td class="num grpsep">${fmt(t.tsD)}</td><td class="num">${fmt(t.tsC)}</td>
    <td class="num grpsep">${fmt(t.sfD)}</td><td class="num">${fmt(t.sfC)}</td></tr></tbody></table>`;
}

// ───────────────────────── TVA / D300 ─────────────────────────
onPeriodChange('tva', loadVat);
$('#exigForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { tip: f.tip.value, brut: f.brut.value, cota: f.cota.value, data: f.data.value, partener: f.partener.value, document: f.document.value };
  try {
    const r = await api('/api/tva-incasare/exigibilitate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const l = r.entry.lines[0];
    $('#exigResult').className = 'status ok';
    $('#exigResult').textContent = `TVA exigibilă: ${fmt(r.tva)} lei — notă ${l.debit} = ${l.credit} (${fmt(l.suma)}).`;
    f.brut.value = ''; loadVat(); loadEntries();
  } catch (err) { $('#exigResult').className = 'status err'; $('#exigResult').textContent = err.message; }
});
async function renderNeexigibila() {
  let n; try { n = await api('/api/tva-neexigibila'); } catch (e) { return; }
  if (!n.colectataNeexigibila && !n.deductibilaNeexigibila && !n.facturi.length) { $('#neexigView').innerHTML = ''; return; }
  $('#neexigView').innerHTML = `<table><tbody>
    <tr><td>TVA colectată încă neexigibilă (4428)</td><td class="num">${fmt(n.colectataNeexigibila)}</td></tr>
    <tr><td>TVA deductibilă încă neexigibilă (4428)</td><td class="num">${fmt(n.deductibilaNeexigibila)}</td></tr></tbody></table>
    ${n.facturi.length ? `<div class="tablewrap" style="margin-top:6px"><table><thead><tr><th>Data</th><th>Document</th><th>Partener</th><th>Tip</th><th>Stadiu</th><th class="num">TVA</th></tr></thead><tbody>${
      n.facturi.map((f) => `<tr><td>${f.data}</td><td>${f.document || ''}</td><td>${f.partener || ''}</td><td>${f.tip}</td><td>${f.stadiu === 'neexigibila' ? 'neexigibilă' : 'exigibilă'}</td><td class="num">${fmt(f.suma)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
async function loadVat() {
  const p = pget('tva');
  $('#tvaPdf').href = '/pdf/vat' + (p ? '?period=' + p : '');
  // D300/D394 se generează pe o lună anume; dacă e ales tot anul, dezactivăm link-urile
  const monthly = p && p.length === 7;
  [['#d300Xml', '/xml/d300'], ['#d394Xml', '/xml/d394']].forEach(([id, url]) => {
    const a = $(id); if (!a) return;
    if (monthly) { a.href = url + '?period=' + p; a.style.opacity = ''; a.style.pointerEvents = ''; a.title = ''; }
    else { a.removeAttribute('href'); a.style.opacity = '.45'; a.style.pointerEvents = 'none'; a.title = 'Alege o lună pentru declarația D300/D394'; }
  });
  renderNeexigibila();
  const vj = await api('/api/vat-journals' + (p ? '?period=' + p : ''));
  const t = vj.totals;
  const deLabel = t.deplata > 0 ? 'TVA de plată (4423)' : 'TVA de recuperat (4424)';
  const deVal = t.deplata > 0 ? t.deplata : t.derecuperat;
  $('#tvaSummary').innerHTML =
    `<div class="card"><h3>Sumar decont (D300)</h3><table>
      <tr><td>TVA colectată (4427)</td><td class="num">${fmt(t.colectata)}</td></tr>
      <tr><td>TVA deductibilă (4426)</td><td class="num">${fmt(t.deductibila)}</td></tr>
      <tr class="total"><td>${deLabel}</td><td class="num">${fmt(deVal)}</td></tr>
     </table></div>
     <div class="card"><h3>Defalcare pe cote (D300)</h3><table><thead><tr><th>Cotă</th><th class="num">Bază vânzări</th><th class="num">TVA col.</th><th class="num">Bază cumpărări</th><th class="num">TVA ded.</th></tr></thead><tbody>${
       (() => {
         const cote = [...new Set([...(vj.coteV || []).map((c) => c.cota), ...(vj.coteC || []).map((c) => c.cota)])].sort((a, b) => b - a);
         const cv = Object.fromEntries((vj.coteV || []).map((c) => [c.cota, c]));
         const cc = Object.fromEntries((vj.coteC || []).map((c) => [c.cota, c]));
         return cote.map((k) => `<tr><td>${k ? k + '%' : 'scutit/0%'}</td><td class="num">${cv[k] ? fmt(cv[k].baza) : ''}</td><td class="num">${cv[k] ? fmt(cv[k].tva) : ''}</td><td class="num">${cc[k] ? fmt(cc[k].baza) : ''}</td><td class="num">${cc[k] ? fmt(cc[k].tva) : ''}</td></tr>`).join('')
           + `<tr class="total"><td>TOTAL</td><td class="num">${fmt(t.bazaV)}</td><td class="num">${fmt(t.colectata)}</td><td class="num">${fmt(t.bazaC)}</td><td class="num">${fmt(t.deductibila)}</td></tr>`;
       })()}</tbody></table></div>`;
  const tbl = (rows, totBaza, totTva) => {
    if (!rows.length) return '<p class="muted">Niciun document.</p>';
    const body = rows.map((r) => `<tr><td>${r.data}</td><td>${r.document || ''}</td><td>${r.partener || ''}${r.cui ? ' <span class="muted" style="font-size:11px">' + r.cui + '</span>' : ''}${r.taxareInversa ? ' <span class="muted" style="font-size:11px">↹ taxare inversă</span>' : ''}</td>
      <td class="num">${r.cota ? r.cota + '%' : '—'}</td><td class="num">${fmt(r.baza)}</td><td class="num">${fmt(r.tva)}</td><td class="num">${fmt(r.total)}</td></tr>`).join('');
    return `<table><thead><tr><th>Data</th><th>Document</th><th>Partener</th><th class="num">Cotă</th><th class="num">Bază</th><th class="num">TVA</th><th class="num">Total</th></tr></thead>
      <tbody>${body}<tr class="total"><td colspan="4">TOTAL</td><td class="num">${fmt(totBaza)}</td><td class="num">${fmt(totTva)}</td><td class="num">${fmt(totBaza + totTva)}</td></tr></tbody></table>`;
  };
  $('#tvaVanzari').innerHTML = tbl(vj.vanzari, t.bazaV, t.colectata);
  $('#tvaCumparari').innerHTML = tbl(vj.cumparari, t.bazaC, t.deductibila);
  const cq = p ? '?period=' + p : '';
  $('#tvaVanzariCsv').href = '/csv/vat-sales' + cq;
  $('#tvaCumparariCsv').href = '/csv/vat-purchases' + cq;
}

// ───────────────────────── CLOSINGS ─────────────────────────
onPeriodChange('vc', previewVat);
async function loadClosings() {
  // implicit, luna de inchis = luna de lucru
  const m = workMonth();
  if ($('#vcLuna')) $('#vcLuna').value = m.slice(5);
  if ($('#vcAn') && [...$('#vcAn').options].some((o) => o.value === m.slice(0, 4))) $('#vcAn').value = m.slice(0, 4);
  previewVat(); previewProfitTax(); previewYear(); previewDistribution();
}
async function previewVat() {
  const p = pget('vc'); if (!p) { $('#vatPreview').textContent = 'Alege o perioadă.'; return; }
  const v = await api('/api/vat-preview?period=' + p);
  $('#vatPreview').innerHTML = `Luna: <b>${lunaLabel(p)}</b>\nTVA colectată: <b>${fmt(v.colectata)}</b> lei\nTVA deductibilă: <b>${fmt(v.deductibila)}</b> lei\n──────────\n`
    + (v.lines.length ? v.lines.map((l) => `<span class="pd">${l.debit}</span> = <span class="pc">${l.credit}</span>  ${fmt(l.suma)} lei  (${l.explicatie})`).join('\n')
      : 'Nimic de regularizat.');
}
$('#closeVat').addEventListener('click', async () => {
  const p = pget('vc'); if (!p) return toast('Alege o perioadă', true);
  try {
    await api('/api/close-vat?period=' + p, { method: 'POST' });
    META = await api('/api/meta');
    // avanseaza la luna urmatoare si muta TOATE filtrele (jurnal, balanta etc.) pe noua luna
    const nm = nextMonth(p);
    setWorkMonth(nm);
    applyWorkMonth();
    loadEntries();
    $('#vcLuna').value = nm.slice(5);
    if ([...$('#vcAn').options].some((o) => o.value === nm.slice(0, 4))) $('#vcAn').value = nm.slice(0, 4);
    toast('Luna ' + lunaLabel(p) + ' închisă. Ai trecut la ' + lunaLabel(nm) + '.');
    previewVat();
  } catch (e) { toast(e.message, true); }
});
$('#yearInput').addEventListener('change', previewYear);
async function previewYear() {
  const y = $('#yearInput').value;
  const pl = await api('/api/statements/pl?year=' + y);
  $('#yearPreview').innerHTML = `Venituri totale: <b>${fmt(pl.venitTotal)}</b> lei\nCheltuieli totale: <b>${fmt(pl.cheltTotal)}</b> lei\n──────────\nRezultat brut: <b>${fmt(pl.rezBrut)}</b> lei`;
}
$('#closeYear').addEventListener('click', async () => {
  const y = $('#yearInput').value;
  try { const r = await api('/api/close-year?year=' + y, { method: 'POST' }); toast('Închidere anuală: rezultat ' + fmt(r.result.rezultat) + ' lei'); META = await api('/api/meta'); loadEntries(); }
  catch (e) { toast(e.message, true); }
});
function ptQuery() {
  const y = ($('#ptYear') || {}).value || '';
  let q = 'year=' + y + '&cheltNedeductibile=' + (Number(($('#ptNed') || {}).value) || 0) + '&deduceri=' + (Number(($('#ptDed') || {}).value) || 0);
  const p = ($('#ptPierdere') || {}).value;
  if (p !== '' && p != null) q += '&pierdereReportata=' + (Number(p) || 0);
  return q;
}
async function previewProfitTax() {
  if (!$('#ptYear')) return;
  try {
    const p = await api('/api/profit-tax-preview?' + ptQuery());
    if ($('#ptPierdere') && $('#ptPierdere').value === '') $('#ptPierdere').placeholder = 'auto: ' + fmt(p.pierdereReportata) + ' (din anul precedent)';
    const adj = `Profit contabil (venituri − cheltuieli): <b>${fmt(p.profitContabil)}</b>\n+ Nedeductibile: <b>${fmt(p.cheltNedeductibile)}</b> · − Deduceri: <b>${fmt(p.deduceri)}</b> · − Pierdere reportată folosită: <b>${fmt(p.pierdereFolosita)}</b>\n`;
    $('#ptPreview').innerHTML = adj + `──────────\nProfit impozabil: <b>${fmt(p.profitImpozabil)}</b> × ${p.cota}% = Impozit: <b>${fmt(p.impozit)}</b> lei`
      + (p.impozit > 0 ? ` → <span class="pd">691</span> = <span class="pc">4411</span>` : ' (pierdere/zero — niciun impozit)')
      + (p.pierdereDeReportat > 0 ? `\n⚠ Pierdere fiscală de reportat în anii următori: <b>${fmt(p.pierdereDeReportat)}</b> lei` : '');
  } catch (e) { /* ignora */ }
}
['#ptNed', '#ptDed', '#ptPierdere'].forEach((id) => { const el = $(id); if (el) el.addEventListener('change', previewProfitTax); });
$('#ptYear') && $('#ptYear').addEventListener('change', previewProfitTax);
$('#closeProfitTax') && $('#closeProfitTax').addEventListener('click', async () => {
  const body = { year: $('#ptYear').value, cheltNedeductibile: Number(($('#ptNed') || {}).value) || 0, deduceri: Number(($('#ptDed') || {}).value) || 0 };
  if ($('#ptPierdere') && $('#ptPierdere').value !== '') body.pierdereReportata = Number($('#ptPierdere').value) || 0;
  try { const r = await api('/api/close-profit-tax', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast(r.message || ('Impozit pe profit înregistrat: ' + fmt(r.result.impozit) + ' lei')); META = await api('/api/meta'); loadEntries(); previewProfitTax(); }
  catch (e) { toast(e.message, true); }
});
$('#distYear') && $('#distYear').addEventListener('change', previewDistribution);
async function previewDistribution() {
  const y = $('#distYear').value;
  const r = await api('/api/distribute-preview?year=' + y);
  const txt = r.sold121 === 0 ? 'Soldul contului 121 este 0 — nimic de repartizat.'
    : r.profit ? `Profit în 121: <b>${fmt(r.profit)}</b> lei\n→ se înregistrează: <b>121 = 117</b> ${fmt(r.profit)} lei`
      : `Pierdere în 121: <b>${fmt(r.pierdere)}</b> lei\n→ se înregistrează: <b>117 = 121</b> ${fmt(r.pierdere)} lei`;
  $('#distPreview').innerHTML = txt;
}
$('#distResult') && $('#distResult').addEventListener('click', async () => {
  const y = $('#distYear').value;
  try {
    const r = await api('/api/distribute-result?year=' + y, { method: 'POST' });
    toast(r.message || (r.result.profit ? 'Profit repartizat (121→117): ' + fmt(r.result.profit) + ' lei' : 'Pierdere reportată (117→121): ' + fmt(r.result.pierdere) + ' lei'));
    META = await api('/api/meta'); loadEntries();
  } catch (e) { toast(e.message, true); }
});

// ── Reevaluare valutara ──
$('#fxLoad') && $('#fxLoad').addEventListener('click', async () => {
  const asOf = $('#fxAsOf').value;
  if (!asOf) return toast('Alege data reevaluării', true);
  const area = $('#fxRevalArea'); area.innerHTML = '<p class="muted">Se încarcă…</p>';
  $('#fxRevalPreview').innerHTML = ''; $('#fxRevalPost').classList.add('hidden'); $('#fxRevalStatus').textContent = '';
  let list; try { list = await api('/api/fx-reval/candidates?asOf=' + asOf); } catch (e) { area.innerHTML = `<p class="status err">${e.message}</p>`; return; }
  if (!list.length) { area.innerHTML = '<p class="muted">Niciun cont în valută cu sold la această dată (5124/5314 sau conturi cu mișcări în valută).</p>'; return; }
  area.innerHTML = `<table><thead><tr><th>Cont</th><th>Denumire</th><th>Tip</th><th class="num">Sold contabil (lei)</th><th>Mon.</th><th class="num">Sold în valută</th><th class="num">Curs închidere</th></tr></thead>
    <tbody>${list.map((c) => `<tr data-cont="${c.cont}" data-asset="${c.isAsset ? 1 : 0}">
      <td class="acc">${c.cont}</td><td>${c.nume}</td><td>${c.isAsset ? 'Activ' : 'Datorie'}</td><td class="num">${fmt(c.bookLei)}</td><td>${c.moneda}</td>
      <td class="num"><input class="fx-val" type="number" step="0.01" value="${c.foreignBalance || ''}" style="width:110px;text-align:right"></td>
      <td class="num"><input class="fx-curs" type="number" step="0.0001" placeholder="ex. 4.97" style="width:90px;text-align:right"></td></tr>`).join('')}</tbody></table>
    <button id="fxPreviewBtn" class="btn" style="margin-top:8px">Previzualizează diferențele</button>`;
  $('#fxPreviewBtn').addEventListener('click', fxPreview);
});
function fxItems() {
  return $$('#fxRevalArea tbody tr').map((tr) => ({
    cont: tr.dataset.cont, foreignBalance: Number(tr.querySelector('.fx-val').value) || 0, closingRate: Number(tr.querySelector('.fx-curs').value) || 0,
  })).filter((it) => it.closingRate > 0);
}
async function fxPreview() {
  const asOf = $('#fxAsOf').value; const items = fxItems();
  if (!items.length) return toast('Completează cel puțin un curs de închidere', true);
  let r; try { r = await api('/api/fx-reval/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asOf, items }) }); } catch (e) { return toast(e.message, true); }
  const box = $('#fxRevalPreview');
  if (!r.lines.length) { box.innerHTML = '<p class="muted">Nicio diferență de reevaluare (soldurile coincid cu cursul indicat).</p>'; $('#fxRevalPost').classList.add('hidden'); return; }
  box.innerHTML = `<table><thead><tr><th>Cont</th><th>Sold contabil</th><th>Reevaluat</th><th>Diferență</th><th>Sens</th><th>Notă</th></tr></thead>
    <tbody>${r.results.filter((x) => x.lines.length).map((x) => `<tr><td class="acc">${x.account}</td><td class="num">${fmt(x.book)}</td><td class="num">${fmt(x.revaluedLei)}</td>
      <td class="num" style="color:${x.sens === 'favorabila' ? 'var(--accent)' : 'var(--danger)'}">${x.diff >= 0 ? '+' : ''}${fmt(x.diff)}</td>
      <td>${x.sens}</td><td class="acc">${x.lines[0].debit} = ${x.lines[0].credit}</td></tr>`).join('')}
    <tr class="total"><td colspan="3">Total favorabil (765) / nefavorabil (665)</td><td class="num">+${fmt(r.totalFavorabil)} / −${fmt(r.totalNefavorabil)}</td><td colspan="2"></td></tr></tbody></table>`;
  $('#fxRevalPost').classList.remove('hidden');
}
$('#fxRevalPost') && $('#fxRevalPost').addEventListener('click', async () => {
  const asOf = $('#fxAsOf').value; const items = fxItems();
  try {
    const r = await api('/api/fx-reval/post', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asOf, items }) });
    $('#fxRevalStatus').className = 'status ok';
    $('#fxRevalStatus').textContent = 'Reevaluare înregistrată: favorabil ' + fmt(r.totalFavorabil) + ' lei (765), nefavorabil ' + fmt(r.totalNefavorabil) + ' lei (665).';
    $('#fxRevalArea').innerHTML = ''; $('#fxRevalPreview').innerHTML = ''; $('#fxRevalPost').classList.add('hidden');
    loadEntries();
  } catch (e) { $('#fxRevalStatus').className = 'status err'; $('#fxRevalStatus').textContent = e.message; }
});

// ───────────────────────── STATEMENTS ─────────────────────────
$('#stmtYear').addEventListener('change', loadStatements);
async function loadStatements() {
  // necontabilii isi depun singuri declaratiile, dar bilantul cere semnatura calificata (L82/1991)
  $('#bilantWarn').classList.toggle('hidden', USER.tip !== 'necontabil');
  const y = $('#stmtYear').value;
  $('#plPdf').href = '/pdf/pl?year=' + y;
  $('#bilantPdf').href = '/pdf/bilant?period=' + y + '-12';
  $('#situatiiPdf').href = '/pdf/situatii?year=' + y;
  $('#cashflowPdf').href = '/pdf/cashflow?year=' + y;
  $('#capitalPdf').href = '/pdf/capital?year=' + y;
  $('#fiscalPdf').href = '/pdf/registru-fiscal?year=' + y;
  $('#notesPdf').href = '/pdf/note?year=' + y;
  $('#saftXml').href = '/xml/saft?year=' + y;
  $('#saftXmlLuna') && ($('#saftXmlLuna').href = '/xml/saft?period=' + workMonth());
  api('/api/saft?year=' + y).then((s) => {
    $('#saftView').innerHTML = `<table>
      <tr><td>Articole contabile (tranzacții)</td><td class="num">${s.entries}</td></tr>
      <tr><td>Conturi cu sold/rulaj</td><td class="num">${s.accounts}</td></tr>
      <tr><td>Clienți / Furnizori</td><td class="num">${s.customers} / ${s.suppliers}</td></tr>
      <tr><td>Facturi vânzare / cumpărare (SourceDocuments)</td><td class="num">${s.salesInvoices} / ${s.purchaseInvoices}</td></tr>
      <tr><td>Plăți/încasări (Payments)</td><td class="num">${s.payments}</td></tr>
      <tr><td>Produse / mișcări stoc (Products, MovementOfGoods)</td><td class="num">${s.products} / ${s.stockMovements}</td></tr>
      <tr><td>Total debit = total credit</td><td class="num">${fmt(s.totalDebit)}</td></tr></table>`;
  }).catch(() => { $('#saftView').innerHTML = ''; });
  api('/api/notes?year=' + y).then((n) => {
    const noteSec = (s) => {
      let body;
      if (s.tabel) {
        const head = '<tr>' + s.tabel.cols.map((c) => `<th class="${c.num ? 'num' : ''}" style="text-align:${c.num ? 'right' : 'left'}">${c.label}</th>`).join('') + '</tr>';
        const body2 = s.tabel.rows.map((row) => '<tr' + (row._bold ? ' class="total"' : '') + '>' + s.tabel.cols.map((c) =>
          `<td class="${c.num ? 'num' : ''}">${c.num ? (row[c.k] == null ? '—' : fmt(row[c.k])) : (row[c.k] == null ? '' : row[c.k])}</td>`).join('') + '</tr>').join('');
        body = head + body2;
      } else {
        body = s.linii.map((l) => `<tr${l._bold ? ' class="total"' : ''}><td>${l.k}</td><td class="num">${l.v == null ? '—' : (l.raw ? l.v : fmt(l.v))}</td></tr>`).join('');
      }
      return `<p style="margin:6px 0 2px"><b>${s.titlu}</b></p><table>${body}</table>`;
    };
    $('#notesView').innerHTML = n.sections.map(noteSec).join('')
      + '<p style="margin:8px 0 2px"><b>Nota 7 — Principii și politici contabile</b></p><ul class="muted" style="margin:0;padding-left:18px">'
      + n.principii.map((p) => `<li>${p}</li>`).join('') + '</ul>';
  }).catch(() => {});
  api('/api/statements/cashflow?year=' + y).then((cf) => {
    const cr = (label, val, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="num">${fmt(val)}</td></tr>`;
    const cs = (label, val) => `<tr><td style="padding-left:18px" class="muted">${label}</td><td class="num">${fmt(val)}</td></tr>`;
    $('#cashflowView').innerHTML = `<table>
      ${cr('Activitatea de exploatare', '', 'total')}
      ${cs('Încasări de la clienți', cf.ex_clienti)}${cs('Plăți către furnizori și angajați', cf.ex_furnizoriAngajati)}${cs('Plăți impozite, taxe și TVA', cf.ex_impozite)}${cs('Dobânzi plătite', cf.ex_dobanzi)}${cs('Alte încasări/plăți din exploatare', cf.ex_altele)}
      ${cr('= Numerar net din exploatare', cf.ex_net, 'total')}
      ${cr('Activitatea de investiție', '', 'total')}
      ${cs('Plăți/încasări privind imobilizările', cf.inv_imobilizari)}${cs('Dobânzi și dividende încasate', cf.inv_dobanziDiv)}
      ${cr('= Numerar net din investiție', cf.inv_net, 'total')}
      ${cr('Activitatea de finanțare', '', 'total')}
      ${cs('Credite/împrumuturi (trageri − rambursări)', cf.fin_credite)}${cs('Aporturi de capital', cf.fin_capital)}${cs('Dividende plătite', cf.fin_dividende)}
      ${cr('= Numerar net din finanțare', cf.fin_net, 'total')}
      ${cr('VARIAȚIA NETĂ A NUMERARULUI', cf.variatie, 'bold')}
      ${cs('Numerar la începutul exercițiului', cf.numerarInitial)}${cs('Numerar la sfârșitul exercițiului', cf.numerarFinal)}</table>
      <p class="${cf.echilibrat ? '' : 'status err'}" style="font-size:12px">${cf.echilibrat ? '✔ Control: variația = numerar final − inițial (' + fmt(cf.variatieControl) + ')' : '✘ Variația calculată diferă de variația soldurilor de numerar'}</p>`;
  }).catch(() => { $('#cashflowView').innerHTML = ''; });
  renderBudget(y);
  api('/api/statements/equity?year=' + y).then((eq) => {
    const er = (r, cls) => `<tr class="${cls || ''}"><td>${r.nume}</td><td class="num">${fmt(r.soldI)}</td><td class="num">${fmt(r.cresteri)}</td><td class="num">${fmt(r.reduceri)}</td><td class="num">${fmt(r.soldF)}</td></tr>`;
    $('#capitalView').innerHTML = `<table>
      <tr><th style="text-align:left">Element</th><th class="num">Sold ${Number(y) - 1}-12-31</th><th class="num">Creșteri</th><th class="num">Reduceri</th><th class="num">Sold ${y}-12-31</th></tr>
      ${eq.rows.map((r) => er(r)).join('')}
      ${er(Object.assign({ nume: 'TOTAL CAPITALURI PROPRII' }, eq.total), 'bold')}</table>
      <p class="${eq.echilibrat ? '' : 'status err'}" style="font-size:12px">${eq.echilibrat ? '✔ Control: total = capitalurile proprii din bilanț (F10)' : '✘ Totalul diferă de capitalurile din F10 (' + fmt(eq.capitalPropriiF10) + ')'}</p>`;
  }).catch(() => { $('#capitalView').innerHTML = ''; });
  api('/api/registru-fiscal?year=' + y).then((rf) => {
    const pctTxt = (c) => c.pct < 100 ? ` <span class="muted">(${c.pct}% din ${fmt(c.baza)})</span>` : '';
    $('#fiscalView').innerHTML = `<table>
      <tr><td>Rezultat contabil (brut)</td><td class="num">${fmt(rf.rezultatContabil)}</td></tr>
      ${rf.cheltNeded.map((c) => `<tr><td>+ ${c.cod} ${c.nume}${pctTxt(c)}</td><td class="num">${fmt(c.suma)}</td></tr>`).join('')}
      <tr><td>+ Total cheltuieli nedeductibile</td><td class="num">${fmt(rf.totalNeded)}</td></tr>
      ${(rf.venituriList || []).map((c) => `<tr><td>− ${c.cod} ${c.nume}${pctTxt(c)}</td><td class="num">${fmt(c.suma)}</td></tr>`).join('')}
      <tr><td>− Total venituri neimpozabile</td><td class="num">${fmt(rf.venituriNeimpozabile)}</td></tr>
      <tr class="total"><td>= Rezultat fiscal</td><td class="num">${fmt(rf.rezultatFiscal)}</td></tr>
      <tr class="total"><td>Impozit pe profit ${rf.rateProfit}%</td><td class="num">${fmt(rf.impozitProfit)}</td></tr>
      <tr><td class="muted">(comparativ) Impozit micro 1% din venituri</td><td class="num">${fmt(rf.impozitMicro)}</td></tr>
    </table>${(rf.mentiuni || []).map((m) => `<p class="muted" style="margin:6px 0 0">${m}</p>`).join('')}`;
  }).catch(() => {});
  const Y0 = Number(y) - 1;
  const [pl, pl0] = await Promise.all([
    api('/api/statements/pl-f20?year=' + y),
    api('/api/statements/pl-f20?year=' + Y0).catch(() => null),
  ]);
  const pcell = (o, k) => (o ? fmt(o[k]) : '—');
  const pr = (label, key, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="num">${pcell(pl0, key)}</td><td class="num">${fmt(pl[key])}</td></tr>`;
  $('#plView').innerHTML = `<table>
    <tr><th style="text-align:left"></th><th class="num">Ex. precedent ${Y0}</th><th class="num">Ex. curent ${y}</th></tr>
    ${pr('1. Cifra de afaceri netă', 'cifraAfaceri')}
    ${pr('2. Variația stocurilor / producția imobilizată', 'venitProductie')}
    ${pr('3. Alte venituri din exploatare', 'alteVenitExpl')}
    ${pr('VENITURI DIN EXPLOATARE — TOTAL', 'venitExpl', 'total')}
    ${pr('4. Cheltuieli cu materii prime, mărfuri, utilități', 'cheltMateriale')}
    ${pr('5. Cheltuieli cu personalul', 'cheltPersonal')}
    ${pr('6. Ajustări de valoare (amortizări)', 'amortizare')}
    ${pr('7. Alte cheltuieli de exploatare', 'alteCheltExpl')}
    ${pr('CHELTUIELI DIN EXPLOATARE — TOTAL', 'cheltExpl', 'total')}
    ${pr('REZULTAT DIN EXPLOATARE', 'rezExpl', 'bold')}
    ${pr('8. Venituri financiare', 'venitFin')}
    ${pr('9. Cheltuieli financiare', 'cheltFin')}
    ${pr('REZULTAT FINANCIAR', 'rezFin', 'total')}
    ${pr('VENITURI TOTALE', 'venitTotal')}
    ${pr('CHELTUIELI TOTALE', 'cheltTotal')}
    ${pr('REZULTAT BRUT', 'rezBrut', 'bold')}
    ${pr('10. Impozit pe profit / venit', 'impozit')}
    ${pr('REZULTAT NET AL EXERCIȚIULUI', 'rezNet', 'bold')}</table>
    <p class="muted" style="font-size:11.5px">Structură F20 prescurtat (cont de profit și pierdere, OMFP 1802/2014), cu două coloane: exercițiul precedent și cel curent. Rândurile „Alte..." sunt reziduale, astfel încât totalurile coincid cu rulajul claselor 6 și 7.</p>`;
  const [bs, bs0] = await Promise.all([
    api('/api/statements/bilant-f10?period=' + y + '-12'),
    api('/api/statements/bilant-f10?period=' + Y0 + '-12').catch(() => null),
  ]);
  const r = bs.randuri; const r0 = bs0 ? bs0.randuri : null;
  const row = (label, key, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="num">${pcell(r0, key)}</td><td class="num">${fmt(r[key])}</td></tr>`;
  const sub = (label, key) => `<tr><td style="padding-left:18px" class="muted">${label}</td><td class="num">${pcell(r0, key)}</td><td class="num">${fmt(r[key])}</td></tr>`;
  const rowT = (label, cur, prev, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="num">${prev == null ? '—' : fmt(prev)}</td><td class="num">${fmt(cur)}</td></tr>`;
  $('#bilantView').innerHTML = `<table>
    <tr><th style="text-align:left"></th><th class="num">Început ex. (${Y0})</th><th class="num">Sfârșit ex. (${y})</th></tr>
    ${row('A. Active imobilizate', 'A', 'total')}
    ${sub('Imobilizări necorporale', 'A_necorp')}${sub('Imobilizări corporale', 'A_corp')}${sub('Imobilizări financiare', 'A_financ')}
    ${row('B. Active circulante', 'B', 'total')}
    ${sub('Stocuri', 'B_stocuri')}${sub('Creanțe', 'B_creante')}${sub('Investiții pe termen scurt', 'B_investTS')}${sub('Casa și conturi la bănci', 'B_casa')}
    ${row('C. Cheltuieli în avans', 'C_cheltAvans')}
    ${rowT('TOTAL ACTIV (A+B+C)', bs.totalActiv, bs0 ? bs0.totalActiv : null, 'bold')}
    ${row('D. Datorii ce trebuie plătite într-un an (curente)', 'D_datorii')}
    ${row('E. Active circulante nete', 'E_activeCircNete')}
    ${row('F. Total active minus datorii curente', 'F_totalMinusDat')}
    ${row('G. Datorii ce trebuie plătite peste un an', 'G_datoriiLT')}
    ${row('H. Provizioane', 'H_provizioane')}
    ${row('I. Venituri în avans', 'I_venitAvans')}
    ${row('J. Capital și rezerve (capitaluri proprii)', 'J_capital', 'total')}
    ${sub('din care rezultatul exercițiului', 'rezultatCurent')}
    ${rowT('TOTAL PASIV (J+D+G+H+I)', bs.totalPasiv, bs0 ? bs0.totalPasiv : null, 'bold')}</table>
    <p class="${bs.echilibrat ? '' : 'status err'}">${bs.echilibrat ? '✔ Activ = Pasiv (bilanț echilibrat)' : '✘ Activ ≠ Pasiv'}</p>
    <p class="muted" style="font-size:11.5px">Structură F10 prescurtat (OMFP 1802/2014), cu două coloane: sold la începutul exercițiului (31 dec. ${Y0}) și la sfârșit (31 dec. ${y}). Conturile bifuncționale (clasa 4) se clasifică după sold; datoriile pe termen lung = grupa 16.</p>`;
}

// ───────────────────────── LIVRABILE ─────────────────────────
onPeriodChange('livrabile', loadLivrabile);
const STATUS = {
  ok: { t: 'disponibil', c: 'var(--accent)', bg: '#eef6f2' },
  recap: { t: 'recap (→ ANAF)', c: '#8a6d00', bg: '#fdf6e3' },
  regim: { t: 'după regim', c: '#5a4', bg: '#eef6f2' },
  anaf: { t: 'emis de ANAF', c: '#6b7280', bg: '#eef1f7' },
  manual: { t: 'pregătit de firmă', c: '#6b7280', bg: '#eef1f7' },
};
async function loadLivrabile() {
  const p = pget('livrabile') || new Date().toISOString().slice(0, 7);
  const data = await api('/api/livrabile?period=' + p);
  const s = data.sumar;
  const de = s.d300.deplata > 0 ? ['TVA de plată', s.d300.deplata] : ['TVA de recuperat', s.d300.derecuperat];
  $('#livrabileSumar').innerHTML =
    `<div class="card"><h3>Sumar fiscal — ${p}</h3><table>
      <tr><td>Salarii brute</td><td class="num">${fmt(s.d112.brut)}</td></tr>
      <tr><td>Total de virat (D112)</td><td class="num">${fmt(s.d112.totalBuget)}</td></tr>
      <tr><td>${de[0]} (D300)</td><td class="num">${fmt(de[1])}</td></tr>
      <tr><td>Impozit micro 1% (D100)</td><td class="num">${fmt(s.d100.impozit)}</td></tr>
     </table></div>
     <div class="card"><h3>Total de virat la ANAF (luna ${p})</h3><table>
      ${s.obligatii.items.map((i) => `<tr><td>${i.cont} ${i.nume}</td><td class="num">${fmt(i.suma)}</td></tr>`).join('') || '<tr><td class="muted">Fără obligații în perioadă</td><td></td></tr>'}
      <tr class="total"><td>TOTAL</td><td class="num">${fmt(s.obligatii.total)}</td></tr>
     </table></div>`;
  $('#livrabileLegend').innerHTML = Object.keys(STATUS).map((k) =>
    `<span style="display:inline-block;margin-right:10px"><b style="color:${STATUS[k].c}">●</b> ${STATUS[k].t}</span>`).join('');
  const badge = (st) => { const x = STATUS[st] || STATUS.manual; return `<span style="background:${x.bg};color:${x.c};border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap">${x.t}</span>`; };
  let sec = '';
  const rows = data.list.map((it) => {
    const head = it.sectiune !== sec ? (sec = it.sectiune, `<tr><td colspan="4" style="background:#f2f5fb;font-weight:700;color:#42506f">${it.sectiune}</td></tr>`) : '';
    const links = it.links.map((l) => `<a class="linkbtn" href="${l.href}" target="_blank">${l.label}</a>`).join(' · ') || '<span class="muted">—</span>';
    return head + `<tr><td>${it.nr}</td><td>${it.nume}${it.obs ? `<br><span class="muted" style="font-size:11px">${it.obs}</span>` : ''}</td><td>${badge(it.status)}</td><td>${links}</td></tr>`;
  }).join('');
  $('#livrabileList').innerHTML = `<table><thead><tr><th>#</th><th>Document / declarație</th><th>Statut</th><th>Descărcare</th></tr></thead><tbody>${rows}</tbody></table>`;
  loadDeclRegister(p);
}

// ───────────────────────── REGISTRUL DEPUNERILOR ─────────────────────────
const DECL_ST = {
  nedepusa: { t: 'Nedepusă', c: '#b26a00', bg: '#fff4e0' },
  generata: { t: 'Generată', c: '#1652d6', bg: '#e7eefc' },
  depusa: { t: 'Depusă', c: '#0a7d33', bg: '#e2f5e8' },
  eroare: { t: 'Eroare', c: '#b00020', bg: '#fde7ea' },
  scutita: { t: 'Scutită', c: '#5a6472', bg: '#eceff3' },
  netrimisa: { t: 'Netrimisă în SPV', c: '#b00020', bg: '#fde7ea' },
};
const declBadge = (st, overdue) => {
  const x = DECL_ST[st] || DECL_ST.nedepusa;
  return `<span style="background:${x.bg};color:${x.c};border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap">${x.t}</span>`
    + (overdue ? ' <span style="background:#fde7ea;color:#b00020;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap">⏰ restanță</span>' : '');
};
async function loadDeclRegister(p) {
  const box = $('#declRegister'); if (!box) return;
  const data = await api('/api/declarations?period=' + p);
  if (!data.rows.length) { box.innerHTML = '<p class="muted">Nicio declarație așteptată pe această lună (profil firmă: fără TVA / fără angajați).</p>'; return; }
  const opts = (cur) => Object.keys(DECL_ST).map((k) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${DECL_ST[k].t}</option>`).join('');
  box.innerHTML = `<table><thead><tr><th>Declarație</th><th>Termen</th><th>Stare</th><th>Schimbă starea</th><th>Recipisă / detalii</th></tr></thead><tbody>${
    data.rows.map((r) => `<tr>
      <td>${r.nume}</td>
      <td class="${r.overdue ? '' : 'muted'}" ${r.overdue ? 'style="color:#b00020;font-weight:700"' : ''}>${r.due}</td>
      <td>${declBadge(r.status, r.overdue)}</td>
      <td><select class="decl-set" data-tip="${r.tip}" data-period="${r.period}">${opts(r.status)}</select></td>
      <td class="muted" style="font-size:11px">${r.recipisa ? 'recipisă: ' + r.recipisa + '<br>' : ''}${r.submittedAt ? 'depusă: ' + r.submittedAt.slice(0, 10) : (r.generatedAt ? 'XML generat: ' + r.generatedAt.slice(0, 10) : '')}${r.note ? '<br>' + r.note : ''}</td>
    </tr>`).join('')}</tbody></table>`;
  box.querySelectorAll('.decl-set').forEach((sel) => sel.addEventListener('change', async () => {
    const body = { tip: sel.dataset.tip, period: sel.dataset.period, status: sel.value };
    if (sel.value === 'depusa') body.recipisa = prompt('Număr recipisă / index depunere (opțional):') || '';
    if (sel.value === 'eroare') body.note = prompt('Descrierea erorii (opțional):') || '';
    await api('/api/declarations/set', { method: 'POST', body: JSON.stringify(body) });
    toast('Stare salvată: ' + DECL_ST[sel.value].t);
    loadDeclRegister(sel.dataset.period);
    refreshNotifBadge();
  }));
}

// ───────────────────────── FISA ROL / DOCUMENTE SPV ─────────────────────────
$('#fisaRolBtn') && $('#fisaRolBtn').addEventListener('click', async () => {
  $('#fisaRolStatus').textContent = 'se trimite cererea…';
  try {
    const r = await api('/api/anaf/fisa-rol', { method: 'POST' });
    $('#fisaRolStatus').textContent = r.mesaj || 'Solicitare depusă.';
    toast('Cerere Fișa Rol depusă în SPV');
  } catch (e) { $('#fisaRolStatus').textContent = ''; toast(e.message, true); }
});
$('#spvMesajeBtn') && $('#spvMesajeBtn').addEventListener('click', loadSpvMesaje);
async function loadSpvMesaje() {
  const box = $('#spvMesajeList');
  box.innerHTML = '<p class="muted">se încarcă…</p>';
  let msgs;
  try { msgs = await api('/api/anaf/spv-mesaje?zile=30'); }
  catch (e) { box.innerHTML = ''; toast(e.message, true); return; }
  box.innerHTML = msgs.length
    ? `<table><thead><tr><th>Data</th><th>Tip</th><th>Detalii</th><th></th></tr></thead><tbody>${
      msgs.map((m) => `<tr><td class="muted">${(m.data || '').slice(0, 16)}</td><td>${m.tip || ''}</td><td>${m.detalii || ''}</td>
        <td><button class="linkbtn spv-dl" data-id="${m.id}" data-detalii="${(m.detalii || m.tip || 'Document SPV').replace(/"/g, '')}">descarcă</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun mesaj în SPV pe ultimele 30 de zile.</p>';
  box.querySelectorAll('.spv-dl').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('/api/anaf/spv-descarca/' + b.dataset.id, { method: 'POST', body: JSON.stringify({ detalii: b.dataset.detalii }) });
      toast('Document atașat firmei');
      window.open('/api/document/' + r.documentId + '/file', '_blank');
    } catch (e) { toast(e.message, true); }
  }));
}

// ───────────────────────── PORTOFOLIU (multi-firma) ─────────────────────────
onPeriodChange('portofoliu', loadPortfolio);
async function loadPortfolio() {
  const p = pget('portofoliu') || new Date().toISOString().slice(0, 7);
  const d = await api('/api/portfolio?period=' + p);
  const t = d.tot;
  const pinfo = (info) => `<span class="cinfo" tabindex="0" role="note" aria-label="${info}">i<span class="cpop">${info}</span></span>`;
  const kpi = (ic, lbl, val, sub, cls, info) => `<div class="kpi ${cls || ''}">
    <div class="kpi-top"><span class="kpi-ic">${ic}</span></div>
    <div class="lbl">${lbl}${info ? pinfo(info) : ''}</div><div class="val">${val}</div><div class="sub">${sub || ''}</div></div>`;
  $('#portoKpis').innerHTML =
    kpi('🏢', 'Firme în portofoliu', d.firms.length, 'cu acces', 'blue',
      'Firmele la care ai acces și care intră în agregarea de mai jos.') +
    kpi('📄', 'Declarații așteptate', t.asteptate, 'luna ' + p, 'blue',
      'Câte declarații au de depus firmele tale pe luna selectată, după profilul fiecăreia (TVA, angajați, trimestru).') +
    kpi('✅', 'Depuse', t.depuse, t.generate + ' generate · ' + t.nedepuse + ' nedepuse', 'green',
      'Declarațiile marcate „depuse" în registrul depunerilor. „Generate" = XML descărcat dar încă nedepus.') +
    kpi('🛡️', 'Conformitate', d.conformitate + '%', t.restante + ' restanțe · ' + t.erori + ' erori', t.restante || t.erori ? 'red' : 'green',
      'Depuse împărțit la datorate (fără scutite). Restanțele = termen depășit fără depunere.');
  // bara de status (stacked) + legenda cu numarul pe fiecare stare
  const segs = [['depuse', '#0a7d33'], ['generate', '#1652d6'], ['nedepuse', '#b26a00'], ['erori', '#b00020'], ['scutite', '#8a93a3']];
  const total = Math.max(1, t.asteptate);
  $('#portoStatus').innerHTML =
    `<div style="display:flex;height:26px;border-radius:8px;overflow:hidden;background:#eceff3">${
      segs.map(([k, c]) => t[k] ? `<div style="flex:${t[k]};background:${c}" title="${k}: ${t[k]}"></div>` : '').join('')}</div>
     <table style="margin-top:10px">${segs.map(([k, c]) => `<tr><td><b style="color:${c}">●</b> ${k[0].toUpperCase() + k.slice(1)}</td><td class="num">${t[k]}</td><td class="num muted">${Math.round((t[k] / total) * 100)}%</td></tr>`).join('')}</table>`;
  const warn = d.firms.filter((f) => f.natentionari > 0).slice(0, 5);
  $('#portoTop').innerHTML = warn.length
    ? `<table>${warn.map((f) => `<tr><td>${f.nume}<br><span class="muted" style="font-size:11px">${f.atentionari.slice(0, 3).join(' · ')}</span></td>
        <td class="num"><span style="background:#b00020;color:#fff;border-radius:10px;padding:2px 9px;font-weight:700">${f.natentionari}</span></td></tr>`).join('')}</table>`
    : '<p class="muted">✓ Nicio firmă cu atenționări pe luna selectată.</p>';
  $('#portoFirms').innerHTML = `<table><thead><tr><th>Firma</th><th>CUI</th><th class="num">Așteptate</th><th class="num">Depuse</th><th class="num">Generate</th><th class="num">Nedepuse</th><th class="num">Erori</th><th class="num">Atenționări</th></tr></thead><tbody>${
    d.firms.map((f) => `<tr><td>${f.nume}</td><td class="muted">${f.cui}</td><td class="num">${f.counts.asteptate}</td><td class="num" style="color:#0a7d33">${f.counts.depuse}</td><td class="num">${f.counts.generate}</td><td class="num" ${f.counts.nedepuse ? 'style="color:#b26a00;font-weight:700"' : ''}>${f.counts.nedepuse}</td><td class="num" ${f.counts.erori ? 'style="color:#b00020;font-weight:700"' : ''}>${f.counts.erori}</td><td class="num">${f.natentionari || ''}</td></tr>`).join('')}</tbody></table>`;
  $('#portoRecent').innerHTML = (d.recent || []).length
    ? `<table><thead><tr><th>Când</th><th>Firma</th><th>Cine</th><th>Acțiune</th></tr></thead><tbody>${
      d.recent.map((a) => `<tr><td class="muted">${(a.ts || '').replace('T', ' ').slice(0, 16)}</td><td>${a.firma}</td><td>${a.username}</td><td>${a.action}${a.detail ? ' — <span class="muted">' + a.detail + '</span>' : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio activitate recentă.</p>';
}

// ───────────────────────── NOTIFICARI (termene fiscale) ─────────────────────────
async function refreshNotifBadge() {
  try {
    const n = await api('/api/notifications');
    const b = $('#notifBadge'); if (!b) return;
    b.textContent = n.count;
    b.classList.toggle('hidden', !n.count);
  } catch (e) { /* ignora */ }
}
async function loadNotifications() {
  const n = await api('/api/notifications');
  $('#notifList').innerHTML = n.items.length
    ? `<table><thead><tr><th></th><th>Firma</th><th>Declarația</th><th>Luna</th><th>Termen</th><th>Stare</th></tr></thead><tbody>${
      n.items.map((i) => `<tr>
        <td>${i.kind === 'restanta' ? '<span style="background:#fde7ea;color:#b00020;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700">⏰ RESTANȚĂ</span>' : '<span style="background:#fff4e0;color:#b26a00;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700">📅 termen apropiat</span>'}</td>
        <td>${i.firma}</td><td>${i.nume}</td><td>${i.period}</td>
        <td ${i.kind === 'restanta' ? 'style="color:#b00020;font-weight:700"' : ''}>${i.due}</td>
        <td>${declBadge(i.status)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">✓ Nicio restanță și niciun termen în următoarele 7 zile. Totul e la zi.</p>';
  refreshNotifBadge();
}

// ───────────────────────── RECONCILIERE ─────────────────────────
$('#reconRefresh').addEventListener('click', loadReconcile);
async function loadReconcile() {
  const r = await api('/api/reconcile');
  $('#reconSummary').innerHTML =
    `<div class="card"><h3>Sold clienți (4111)</h3><p style="font-size:22px;font-weight:700;color:var(--accent)">${fmt(r.totalClienti)} lei</p><p class="muted">de încasat (net)</p></div>
     <div class="card"><h3>Sold furnizori (401)</h3><p style="font-size:22px;font-weight:700;color:#b00020">${fmt(r.totalFurnizori)} lei</p><p class="muted">de plătit (net)</p></div>`;
  renderCompensations();
  if (!r.partners.length) { $('#reconList').innerHTML = '<div class="card"><p class="muted">Nicio mișcare pe parteneri.</p></div>'; return; }
  $('#reconList').innerHTML = r.partners.map((p) => {
    const rows = p.items.map((it) => `<tr class="${it.matched ? '' : ''}"><td>${it.data}</td><td>${it.doc}</td><td>${it.tipNume}</td>
      <td class="num">${it.debit ? fmt(it.debit) : ''}</td><td class="num">${it.credit ? fmt(it.credit) : ''}</td>
      <td>${it.matched ? '<span class="pill">✓ potrivit</span>' : '<span class="pill warn">deschis</span>'}</td></tr>`).join('');
    const lbl = p.cont === '4111' ? 'client' : 'furnizor';
    return `<div class="ledger-acc">
      <h4><span class="acc">${p.cont}</span> ${p.den} ${p.cui ? '<span class="muted">(' + p.cui + ')</span>' : ''} <span class="pill">${lbl}</span></h4>
      <p class="muted">Facturat: ${fmt(p.facturat)} · Decontat: ${fmt(p.decontat)} · <b>Sold: ${fmt(p.sold)}</b> · Potriviri: ${p.potriviri} · Deschise: ${p.nepotrivite}</p>
      <div class="tablewrap"><table><thead><tr><th>Data</th><th>Document</th><th>Tip</th><th class="num">Debit</th><th class="num">Credit</th><th>Stare</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  }).join('');
}

async function renderCompensations() {
  const card = $('#compensCard'); if (!card) return;
  let list; try { list = await api('/api/compensations'); } catch (e) { card.classList.add('hidden'); return; }
  if (!list.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('#compensView').innerHTML = `<table><thead><tr><th>Partener</th><th class="num">Creanță (4111)</th><th class="num">Datorie (401)</th><th class="num">Compensabil</th><th></th></tr></thead>
    <tbody>${list.map((c) => `<tr data-cui="${c.cui}"><td>${c.den}${c.cui ? ' <span class="muted">(' + c.cui + ')</span>' : ''}</td>
      <td class="num">${fmt(c.creanta)}</td><td class="num">${fmt(c.datorie)}</td><td class="num"><b>${fmt(c.compensabil)}</b></td>
      <td><button class="btn small primary compBtn" data-cui="${c.cui}" data-max="${c.compensabil}">Compensează</button></td></tr>`).join('')}</tbody></table>`;
  $$('#compensView .compBtn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Compensezi ' + fmt(Number(b.dataset.max)) + ' lei (401 = 4111) pentru acest partener?')) return;
    b.disabled = true;
    try {
      const r = await api('/api/compensations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cui: b.dataset.cui }) });
      toast('Compensat ' + fmt(r.compensat) + ' lei (401 = 4111)');
      loadReconcile(); loadEntries();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}
// ───────────────────────── ANALITIC ─────────────────────────
const ANALYTIC_ACCOUNTS = ['401', '404', '408', '409', '419', '4111', '418', '461', '462', '5121', '5124', '5311', '5314', '542', '421', '425'];
async function renderAging() {
  let a; try { a = await api('/api/aging'); } catch (e) { return; }
  const tbl = (titlu, list, t, lbl, wo) => `<div class="card"><h4>${titlu} <span class="muted" style="font-weight:400">la ${a.asOf}</span></h4>${
    list.length ? `<table><thead><tr><th>Partener</th><th class="num">Total</th><th class="num">0-30</th><th class="num">31-60</th><th class="num">61-90</th><th class="num">&gt;90</th>${wo ? '<th></th>' : ''}</tr></thead><tbody>${
      list.map((x) => `<tr><td>${x.partener}${x.cui ? ' <span class="muted">(' + x.cui + ')</span>' : ''}</td><td class="num">${fmt(x.total)}</td><td class="num">${x.b0_30 ? fmt(x.b0_30) : ''}</td><td class="num">${x.b31_60 ? fmt(x.b31_60) : ''}</td><td class="num">${x.b61_90 ? fmt(x.b61_90) : ''}</td><td class="num">${x.b90plus ? fmt(x.b90plus) : ''}</td>${wo ? `<td><button class="linkbtn woff" data-p="${encodeURIComponent(x.partener)}" data-c="${x.cui || ''}" data-s="${x.total}">scoate</button></td>` : ''}</tr>`).join('')}
      <tr class="bold"><td>TOTAL ${lbl}</td><td class="num">${fmt(t.total)}</td><td class="num">${fmt(t.b0_30)}</td><td class="num">${fmt(t.b31_60)}</td><td class="num">${fmt(t.b61_90)}</td><td class="num">${fmt(t.b90plus)}</td>${wo ? '<td></td>' : ''}</tr></tbody></table>`
      : '<p class="muted">Niciun sold restant.</p>'}</div>`;
  $('#agingView').innerHTML = tbl('De încasat (clienți)', a.clienti, a.totalClienti, 'creanțe', true) + tbl('De plătit (furnizori)', a.furnizori, a.totalFurnizori, 'datorii', false);
  $$('#agingView .woff').forEach((b) => b.addEventListener('click', async () => {
    const partener = decodeURIComponent(b.dataset.p);
    const suma = prompt('Scoatere din evidență (654 = 4111) pentru ' + partener + '. Sumă neîncasabilă:', b.dataset.s);
    if (!suma) return;
    try { const r = await api('/api/writeoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partener, cui: b.dataset.c, suma }) }); toast('Creanță scoasă: ' + fmt(r.suma) + (r.reversProvizion ? ' (+ reluare provizion ' + fmt(r.reversProvizion) + ')' : '')); loadAnalytic(); }
    catch (e) { toast(e.message, true); }
  }));
  renderProvizion();
}
async function renderProvizion() {
  const pct = $('#provPct').value || 100;
  let p; try { p = await api('/api/provizion?pct=' + pct); } catch (e) { return; }
  const det = p.detalii.length
    ? `<table><thead><tr><th>Partener</th><th class="num">Creanțe &gt;90 zile</th><th class="num">Provizion ${p.pct}%</th></tr></thead><tbody>${
      p.detalii.map((c) => `<tr><td>${c.partener}${c.cui ? ' <span class="muted">(' + c.cui + ')</span>' : ''}</td><td class="num">${fmt(c.vechi)}</td><td class="num">${fmt(c.provizion)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio creanță mai veche de 90 de zile.</p>';
  $('#provView').innerHTML = det + `<table style="margin-top:8px"><tbody>
    <tr><td>Provizion necesar (${p.pct}%)</td><td class="num">${fmt(p.necesar)}</td></tr>
    <tr><td>Ajustare existentă (sold 491)</td><td class="num">${fmt(p.existent)}</td></tr>
    <tr class="bold"><td>De înregistrat ${p.deAjustat >= 0 ? '(6814 = 491)' : '(491 = 7814, reluare)'}</td><td class="num">${fmt(Math.abs(p.deAjustat))}</td></tr></tbody></table>`;
}
$('#provPct').addEventListener('input', renderProvizion);
$('#provPost').addEventListener('click', async () => {
  try {
    const r = await api('/api/provizion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct: Number($('#provPct').value || 100) }) });
    toast(r.message || ('Ajustare înregistrată: ' + fmt(Math.abs(r.result.deAjustat))));
    loadAnalytic();
  } catch (e) { toast(e.message, true); }
});
async function loadAnalytic() {
  $('#oaCont').innerHTML = ANALYTIC_ACCOUNTS.map((c) => `<option value="${c}">${c} — ${accName(c)}</option>`).join('');
  await loadOpeningAnalytic();
  renderAging();
  const sections = await api('/api/analytic');
  if (!sections.length) { $('#analyticList').innerHTML = '<div class="card"><p class="muted">Niciun cont de terți cu solduri sau mișcări.</p></div>'; return; }
  $('#analyticList').innerHTML = sections.map((s) => {
    const rows = s.rows.map((r) => `<tr><td class="acc">${r.analitic}</td><td>${r.den}${r.cui ? ' <span class="muted">(' + r.cui + ')</span>' : ''}</td>
      <td class="num">${r.siD ? fmt(r.siD) : ''}</td><td class="num">${r.siC ? fmt(r.siC) : ''}</td>
      <td class="num">${fmt(r.rd)}</td><td class="num">${fmt(r.rc)}</td>
      <td class="num">${r.sfD ? fmt(r.sfD) : ''}</td><td class="num">${r.sfC ? fmt(r.sfC) : ''}</td></tr>`).join('');
    return `<div class="ledger-acc">
      <h4><span class="acc">${s.synth}</span> — ${s.nume} ${s.concorda ? '' : '<span class="pill warn">SI ≠ sintetic</span>'}</h4>
      <div class="tablewrap"><table><thead><tr><th>Analitic</th><th>Partener</th><th class="num">SI D</th><th class="num">SI C</th><th class="num">Rulaj D</th><th class="num">Rulaj C</th><th class="num">SF D</th><th class="num">SF C</th></tr></thead>
      <tbody>${rows}<tr class="total"><td colspan="2">TOTAL ${s.synth}</td><td class="num">${fmt(s.totalSiD)}</td><td class="num">${fmt(s.totalSiC)}</td><td class="num">${fmt(s.totalRd)}</td><td class="num">${fmt(s.totalRc)}</td><td class="num">${fmt(s.totalSfD)}</td><td class="num">${fmt(s.totalSfC)}</td></tr></tbody></table></div>
    </div>`;
  }).join('');
}
async function loadOpeningAnalytic() {
  const arr = await api('/api/opening-analytic');
  $('#oaList').innerHTML = arr.length
    ? `<table><thead><tr><th>Cont</th><th>Partener</th><th>CUI</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead><tbody>${
      arr.map((o, i) => `<tr><td class="acc">${o.cont}</td><td>${o.partener || ''}</td><td>${o.cui || ''}</td>
        <td class="num">${fmt(o.d)}</td><td class="num">${fmt(o.c)}</td><td><button class="del oadel" data-i="${i}">✕</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun sold inițial analitic.</p>';
  $$('#oaList .oadel').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/opening-analytic/' + b.dataset.i, { method: 'DELETE' }); loadAnalytic();
  }));
}
$('#oaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await api('/api/opening-analytic', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cont: f.cont.value, partener: f.partener.value, cui: f.cui.value, d: f.d.value, c: f.c.value }) });
  toast('Sold inițial analitic salvat'); f.partener.value = ''; f.cui.value = ''; f.d.value = '0'; f.c.value = '0';
  loadAnalytic();
});

// ───────────────────────── PARTENERI ─────────────────────────
const TIP_PARTENER = { client: { t: 'Client', c: '#0b6e4f', bg: '#eaf4ef' }, furnizor: { t: 'Furnizor', c: '#b00020', bg: '#fdeef0' }, ambele: { t: 'Ambele', c: '#42506f', bg: '#eef1f7' } };
function tipBadge(tip) { const x = TIP_PARTENER[tip]; return x ? `<span style="background:${x.bg};color:${x.c};border-radius:6px;padding:1px 8px;font-size:11px;font-weight:700">${x.t}</span>` : '<span class="muted">—</span>'; }
let PARTNERS_MAP = {};
async function loadPartners() {
  PARTNERS_MAP = await api('/api/partners');
  renderPartners();
}
function renderPartners() {
  const map = PARTNERS_MAP;
  const ft = ($('#partnerTipFilter') && $('#partnerTipFilter').value) || '';
  let arr = Object.values(map);
  if (ft) arr = arr.filter((p) => p.tip === ft || (ft !== 'ambele' && p.tip === 'ambele'));
  $('#partnersList').innerHTML = arr.length
    ? `<table><thead><tr><th>CUI</th><th>Denumire</th><th>Tip</th><th>Oraș</th><th>Județ</th><th></th></tr></thead><tbody>${
      arr.map((p) => `<tr><td class="acc">${p.cui}</td><td>${p.den || ''}</td><td>${tipBadge(p.tip)}</td><td>${p.oras || ''}</td><td>${p.judet || ''}</td>
        <td><button class="linkbtn pedit" data-cui="${p.cui}">editează</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun partener pentru filtrul ales. Partenerii se adaugă automat când introduci CUI pe o factură.</p>';
  $$('#partnersList .pedit').forEach((b) => b.addEventListener('click', () => {
    const p = map[b.dataset.cui]; const f = $('#partnerForm');
    ['cui', 'den', 'tip', 'adresa', 'oras', 'judet', 'tara'].forEach((k) => { if (f[k]) f[k].value = p[k] || ''; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}
$('#partnerTipFilter') && $('#partnerTipFilter').addEventListener('change', renderPartners);
$('#partnerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { cui: f.cui.value, den: f.den.value, tip: f.tip.value, adresa: f.adresa.value, oras: f.oras.value, judet: f.judet.value, tara: f.tara.value };
  try { await api('/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Partener salvat'); f.reset(); f.tara.value = 'RO'; loadPartners(); }
  catch (err) { toast(err.message, true); }
});
// Citeste un fisier de import: .xlsx -> convertit la CSV pe server; .csv -> citit direct.
async function fileToCsv(file) {
  if (/\.(xlsx|xls|dbf)$/i.test(file.name)) {
    const fd = new FormData(); fd.append('file', file);
    const r = await api('/api/xlsx-to-csv', { method: 'POST', body: fd });
    return r.csv || '';
  }
  return await file.text();
}
$('#partnersCsvFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { try { $('#partnersCsvIn').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } } });
$('#partnersImportBtn').addEventListener('click', async () => {
  const csv = $('#partnersCsvIn').value.trim();
  if (!csv) return toast('Lipiește sau încarcă un CSV', true);
  try {
    const r = await api('/api/partners/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
    toast(r.importati + ' parteneri importați' + (r.erori.length ? ' (' + r.erori.length + ' erori)' : ''));
    $('#partnersCsvIn').value = ''; loadPartners();
  } catch (err) { toast(err.message, true); }
});
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

// ───────────────────────── MIJLOACE FIXE ─────────────────────────
function mfAsOf() { return pget('mf') || new Date().toISOString().slice(0, 7); }
async function loadAssets() {
  const asOf = mfAsOf();
  $('#mfRegPdf').href = '/pdf/assets?asOf=' + asOf;
  const list = await api('/api/assets?asOf=' + asOf);
  $('#assetsList').innerHTML = list.length
    ? `<table><thead><tr><th>Denumire</th><th>Cont</th><th>Metodă</th><th>Data PIF</th><th class="num">Cost</th><th class="num">Amort./lună</th><th class="num">Cumulat</th><th class="num">Rămas</th><th></th></tr></thead><tbody>${
      list.map((a) => `<tr${a.status === 'casat' ? ' class="muted"' : ''}>
        <td>${a.denumire}${a.status === 'casat' ? ' <span class="pill">casat</span>' : ''}</td>
        <td class="acc">${a.cont}/${a.calc.contAmortizare}</td>
        <td>${({ liniara: 'liniară', degresiva: 'degresivă', accelerata: 'accelerată' })[a.metoda] || a.metoda}</td>
        <td>${a.dataPif}</td>
        <td class="num">${fmt(a.cost)}</td>
        <td class="num">${fmt(a.calc.amortizareLunara)}</td>
        <td class="num">${fmt(a.calc.amortizareCumulata)}</td>
        <td class="num">${fmt(a.calc.valoareRamasa)}</td>
        <td><a class="linkbtn" href="/pdf/asset/${a.id}?asOf=${asOf}" target="_blank">fișă</a>
          ${a.status !== 'casat' ? ` · <button class="linkbtn amf-scrap" data-id="${a.id}">casează</button>` : ''}
          · <button class="linkbtn amf-del" data-id="${a.id}">șterge</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun mijloc fix înregistrat.</p>';
  $$('#assetsList .amf-del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi acest mijloc fix?')) return;
    await api('/api/assets/' + b.dataset.id, { method: 'DELETE' }); loadAssets(); toast('Mijloc fix șters');
  }));
  $$('#assetsList .amf-scrap').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/assets/' + b.dataset.id + '/scrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    loadAssets(); toast('Mijloc fix casat');
  }));
}
onPeriodChange('mf', loadAssets);
function lsQuery() { const f = $('#lsForm'); return 'principal=' + f.principal.value + '&months=' + f.months.value + '&rate=' + f.rate.value + '&method=' + f.method.value; }
$('#lsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#lsPdf').href = '/pdf/leasing-schedule?' + lsQuery();
  const s = await api('/api/leasing-schedule?' + lsQuery());
  $('#lsView').innerHTML = `<table><thead><tr><th class="num">Luna</th><th class="num">Rată</th><th class="num">Principal</th><th class="num">Dobândă</th><th class="num">Sold rămas</th></tr></thead><tbody>${
    s.rows.map((r) => `<tr><td class="num">${r.luna}</td><td class="num">${fmt(r.rata)}</td><td class="num">${fmt(r.principal)}</td><td class="num">${fmt(r.dobanda)}</td><td class="num">${fmt(r.sold)}</td></tr>`).join('')}
    <tr class="bold"><td class="num">TOTAL</td><td class="num">${fmt(s.totals.rata)}</td><td class="num">${fmt(s.totals.principal)}</td><td class="num">${fmt(s.totals.dobanda)}</td><td></td></tr></tbody></table>`;
});
$('#assetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { denumire: f.denumire.value, cont: f.cont.value, cost: f.cost.value, durataLuni: f.durataLuni.value, metoda: f.metoda.value, valoareReziduala: f.valoareReziduala.value, dataAchizitie: f.dataAchizitie.value, dataPif: f.dataPif.value, furnizor: f.furnizor.value, cui: f.cui.value };
  try { await api('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Mijloc fix adăugat'); f.reset(); f.valoareReziduala.value = '0'; loadAssets(); }
  catch (err) { toast(err.message, true); }
});
$('#mfDeprec').addEventListener('click', async () => {
  const period = mfAsOf();
  try {
    const r = await api('/api/assets/depreciation?period=' + period, { method: 'POST' });
    toast(r.message || ('Amortizare înregistrată pentru ' + period + ' (' + (r.result.lines || []).length + ' MF)'));
    loadAssets();
  } catch (err) { toast(err.message, true); }
});

// ───────────────────────── SALARIZARE ─────────────────────────
function spPeriod() { return pget('sp') || new Date().toISOString().slice(0, 7); }
async function loadSalarizare() {
  $('#spPdf').href = '/pdf/stat-plata?period=' + spPeriod();
  $('#spD112').href = '/xml/d112?period=' + spPeriod();
  const sp = await api('/api/stat-plata');
  const t = sp.totals;
  $('#angajatiList').innerHTML = sp.rows.length
    ? `<table><thead><tr><th>Nume</th><th>Funcție</th><th class="num">Brut</th><th class="num">CAS</th><th class="num">CASS</th><th class="num">Deducere</th><th class="num">Impozit</th><th class="num">Net</th><th class="num">Avans</th><th class="num">Rețineri</th><th class="num">Rest plată</th><th class="num">CAM</th><th></th></tr></thead><tbody>${
      sp.rows.map((r) => `<tr><td>${r.nume}${r.spor ? ' <span class="muted">+spor ' + fmt(r.spor) + '</span>' : ''}${r.persoane ? ' <span class="muted">' + r.persoane + ' pers.</span>' : ''}${r.tichete ? ' <span class="muted">+tichete ' + fmt(r.tichete) + '</span>' : ''}${r.avantaje ? ' <span class="muted" title="Avantaje în natură impozabile — intră în CAS/CASS/impozit, nu se plătesc în bani">+avantaje ' + fmt(r.avantaje) + '</span>' : ''}${r.scutire ? ' <span class="muted">scutit (' + r.sector + ')</span>' : ''}${r.overPlafon ? ' <span style="color:var(--danger)">⚠ peste plafon scutire</span>' : ''}</td><td>${r.functie || ''}</td>
        <td class="num">${fmt(r.brut)}</td><td class="num">${fmt(r.cas)}</td><td class="num">${fmt(r.cass)}</td><td class="num">${r.deducere ? fmt(r.deducere) : ''}</td><td class="num">${fmt(r.impozit)}</td><td class="num">${fmt(r.net)}</td><td class="num">${r.avans ? fmt(r.avans) : ''}</td><td class="num">${r.retineri ? fmt(r.retineri) : ''}</td><td class="num">${fmt(r.restPlata)}</td><td class="num">${fmt(r.cam)}</td>
        <td><a class="linkbtn" href="/pdf/fluturas/${r.id}?period=${spPeriod()}" target="_blank">fluturaș</a> · <a class="linkbtn" href="/pdf/adeverinta/${r.id}?year=${($('#rsYear').value || new Date().getFullYear())}" target="_blank">adeverință</a> · <button class="linkbtn aedit" data-id="${r.id}">editează</button> · <button class="linkbtn adel" data-id="${r.id}">șterge</button></td></tr>`).join('')}
      <tr class="bold"><td colspan="2">TOTAL (${sp.rows.length} ang.)</td><td class="num">${fmt(t.brut)}</td><td class="num">${fmt(t.cas)}</td><td class="num">${fmt(t.cass)}</td><td class="num">${fmt(t.deducere)}</td><td class="num">${fmt(t.impozit)}</td><td class="num">${fmt(t.net)}</td><td class="num">${fmt(t.avans)}</td><td class="num">${fmt(t.retineri)}</td><td class="num">${fmt(t.restPlata)}</td><td class="num">${fmt(t.cam)}</td><td></td></tr></tbody></table>`
    : '<p class="muted">Niciun angajat. Adaugă unul în formular.</p>';
  $('#spSummary').innerHTML = `<table><tbody>
    <tr><td>Total salarii brute (641)</td><td class="num">${fmt(t.brut)}</td></tr>
    <tr><td>CAS 25% reținut (4315)</td><td class="num">${fmt(t.cas)}</td></tr>
    <tr><td>CASS 10% reținut (4316)</td><td class="num">${fmt(t.cass)}</td></tr>
    <tr><td>Impozit 10% (444)</td><td class="num">${fmt(t.impozit)}</td></tr>
    <tr><td>CAM 2,25% angajator (436)</td><td class="num">${fmt(t.cam)}</td></tr>
    <tr class="bold"><td>Salarii nete de plată (421)</td><td class="num">${fmt(t.net)}</td></tr>
    <tr class="bold"><td>Total de virat la buget</td><td class="num">${fmt(t.totalBuget)}</td></tr>
    <tr><td>Cost total angajator</td><td class="num">${fmt(t.costTotal)}</td></tr></tbody></table>`;
  $$('#angajatiList .adel').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi angajatul?')) return;
    await api('/api/angajati/' + b.dataset.id, { method: 'DELETE' }); loadSalarizare(); toast('Angajat șters');
  }));
  if (!$('#rsYear').value) $('#rsYear').value = (new Date()).getFullYear();
  renderRegistruSalarii();
  $$('#angajatiList .aedit').forEach((b) => b.addEventListener('click', () => {
    const r = sp.rows.find((x) => x.id === b.dataset.id); const f = $('#angajatForm');
    f.id.value = r.id; f.nume.value = r.nume; f.cnp.value = r.cnp; f.functie.value = r.functie;
    f.salariuBrut.value = round2(r.brut - r.spor); f.spor.value = r.spor; f.neimpozabil.value = r.neimpozabil; f.avans.value = r.avans; f.retineri.value = r.retineri;
    f.persoane.value = r.persoane != null ? r.persoane : ''; f.copii.value = r.copii || 0; f.sub26.checked = !!r.sub26;
    f.tichete.value = r.tichete || 0; f.avantaje.value = r.avantaje || 0; f.sector.value = r.sector || 'normal';
  }));
}
onPeriodChange('sp', () => { $('#spPdf').href = '/pdf/stat-plata?period=' + spPeriod(); $('#spD112').href = '/xml/d112?period=' + spPeriod(); loadSalarizare(); });
async function renderRegistruSalarii() {
  const y = $('#rsYear').value || (new Date()).getFullYear();
  $('#rsPdf').href = '/pdf/registru-salarii?year=' + y;
  const rs = await api('/api/registru-salarii?year=' + y);
  $('#rsList').innerHTML = rs.angajati.length
    ? `<table><thead><tr><th>Nume</th><th>CNP</th><th class="num">Luni</th><th class="num">Brut anual</th><th class="num">CAS</th><th class="num">CASS</th><th class="num">Impozit</th><th class="num">Net anual</th></tr></thead><tbody>${
      rs.angajati.map((e) => `<tr><td>${e.nume}</td><td class="acc">${e.cnp || ''}</td><td class="num">${e.luni}</td><td class="num">${fmt(e.brut)}</td><td class="num">${fmt(e.cas)}</td><td class="num">${fmt(e.cass)}</td><td class="num">${fmt(e.impozit)}</td><td class="num">${fmt(e.net)}</td></tr>`).join('')}
      <tr class="bold"><td colspan="3">TOTAL (${rs.nrLuni} luni)</td><td class="num">${fmt(rs.totals.brut)}</td><td class="num">${fmt(rs.totals.cas)}</td><td class="num">${fmt(rs.totals.cass)}</td><td class="num">${fmt(rs.totals.impozit)}</td><td class="num">${fmt(rs.totals.net)}</td></tr></tbody></table>`
    : '<p class="muted">Niciun stat de plată înregistrat pentru anul selectat.</p>';
}
$('#rsYear').addEventListener('change', renderRegistruSalarii);
$('#angajatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { id: f.id.value || undefined, nume: f.nume.value, cnp: f.cnp.value, functie: f.functie.value, salariuBrut: f.salariuBrut.value, spor: f.spor.value, persoane: f.persoane.value, copii: f.copii.value, sub26: f.sub26.checked, neimpozabil: f.neimpozabil.value, tichete: f.tichete.value, avantaje: f.avantaje.value, sector: f.sector.value, avans: f.avans.value, retineri: f.retineri.value };
  try { await api('/api/angajati', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Angajat salvat'); f.reset(); f.id.value = ''; f.spor.value = '0'; f.copii.value = '0'; f.sub26.checked = false; f.neimpozabil.value = '0'; f.avans.value = '0'; f.retineri.value = '0'; f.avantaje.value = '0'; loadSalarizare(); }
  catch (err) { toast(err.message, true); }
});
$('#spPost').addEventListener('click', async () => {
  const period = spPeriod();
  if (!period) return toast('Alege luna', true);
  try { const r = await api('/api/stat-plata?period=' + period, { method: 'POST' }); toast('Salarii înregistrate: net ' + fmt(r.totals.net) + ', de virat ' + fmt(r.totals.totalBuget)); loadEntries(); }
  catch (e) { toast(e.message, true); }
});
$('#spPay').addEventListener('click', async () => {
  const period = spPeriod();
  if (!period) return toast('Alege luna', true);
  try { const r = await api('/api/stat-plata/pay?period=' + period + '&cont=' + $('#spCont').value, { method: 'POST' }); toast('Plătit ' + fmt(r.suma) + ' din contul ' + r.cont + ' (421 = ' + r.cont + ')'); loadEntries(); }
  catch (e) { toast(e.message, true); }
});

// ───────────────────────── STOCURI ─────────────────────────
let STOCK_MOVS = [];
function stocAsOf() { return pget('stoc') || new Date().toISOString().slice(0, 7); }
function renderStockMovements() {
  const ft = $('#mvfTip').value, fg = $('#mvfGest').value, fl = $('#mvfLuna').value;
  const fx = ($('#mvfText').value || '').toLowerCase().trim();
  const movs = STOCK_MOVS.filter((m) => {
    if (ft && m.tip !== ft) return false;
    if (fg && m.gestiuneCod !== fg && m.gestiuneDestCod !== fg) return false;
    if (fl && String(m.data).slice(0, 7) !== fl) return false;
    if (fx && !((m.cod + ' ' + m.denumire + ' ' + (m.document || '') + ' ' + (m.operator || '')).toLowerCase().includes(fx))) return false;
    return true;
  });
  const tipLbl = (m) => m.tip === 'receptie' ? 'recepție' : m.tip === 'transfer' ? `transfer ${m.gestiuneCod}→${m.gestiuneDestCod}` : 'ieșire';
  $('#movementsList').innerHTML = movs.length
    ? `<table><thead><tr><th>Data</th><th>Tip</th><th>Gestiune</th><th>Produs</th><th class="num">Cantitate</th><th class="num">Preț</th><th>Document</th><th>Operator</th><th>Notă contabilă</th><th></th></tr></thead><tbody>${
      movs.map((m) => `<tr><td>${m.data}</td><td>${tipLbl(m)}</td><td>${m.gestiuneCod || ''}</td><td>${m.cod} ${m.denumire}</td>
        <td class="num">${fmt(m.cantitate)} ${m.um}</td><td class="num">${m.pretUnitar ? fmt(m.pretUnitar) : '—'}</td><td>${m.document || ''}</td><td>${m.operator || '—'}</td>
        <td>${m.tip === 'transfer' ? '<span class="muted">intern</span>' : m.initial ? '<span class="pill" title="Stoc preluat la deschidere — valoarea e în soldurile inițiale, nu se contabilizează separat">sold inițial</span>' : m.entryId ? '<span class="pill">✓ contabilizat</span>' : `<button class="linkbtn mpost" data-id="${m.id}">postează nota</button>`}</td>
        <td>${m.tip === 'receptie' ? `<a class="linkbtn" href="/pdf/nir?id=${m.id}" target="_blank">NIR</a> · ` : m.tip === 'iesire' ? `<a class="linkbtn" href="/pdf/bon-consum?id=${m.id}" target="_blank">bon consum</a> · ` : `<a class="linkbtn" href="/pdf/aviz?id=${m.id}" target="_blank">aviz</a> · `}<button class="linkbtn mdel" data-id="${m.id}">șterge</button></td></tr>`).join('')}</tbody></table>
      <p class="muted" style="margin-top:6px">${movs.length} din ${STOCK_MOVS.length} mișcări. „Postează nota”: recepție <b>3xx = 401</b>, ieșire <b>60x = 3xx</b> la CMP. Transferul e mișcare internă.</p>`
    : '<p class="muted">Nicio mișcare (verifică filtrele).</p>';
  $$('#movementsList .mdel').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/stock-movements/' + b.dataset.id, { method: 'DELETE' }); loadStocks(); toast('Mișcare ștearsă');
  }));
  $$('#movementsList .mpost').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api('/api/stock-movements/' + b.dataset.id + '/post', { method: 'POST' }); toast('Notă contabilă generată: ' + r.entry.lines[0].debit + ' = ' + r.entry.lines[0].credit + ' (' + fmt(r.entry.lines[0].suma) + ')'); loadStocks(); }
    catch (err) { toast(err.message, true); }
  }));
}
['#mvfTip', '#mvfGest', '#mvfLuna'].forEach((s) => $(s).addEventListener('change', renderStockMovements));
$('#mvfText').addEventListener('input', renderStockMovements);
$('#mvfReset').addEventListener('click', () => { $('#mvfTip').value = ''; $('#mvfGest').value = ''; $('#mvfText').value = ''; $('#mvfLuna').value = ''; renderStockMovements(); });
async function loadStocks() {
  const asOf = stocAsOf();
  const gf = $('#stocGestFilter').value;
  $('#stocPdf').href = '/pdf/stocks?asOf=' + asOf;
  $('#stocCsv').href = '/csv/stocks?asOf=' + asOf + (gf ? '&gestiune=' + gf : '');
  $('#movCsv').href = '/csv/stock-movements';
  const perioadaStoc = /^\d{4}-\d{2}$/.test(asOf) ? asOf : String(asOf).slice(0, 7);
  $('#aprovPdf') && ($('#aprovPdf').href = '/pdf/aprovizionari?period=' + perioadaStoc);
  $('#consumPdf') && ($('#consumPdf').href = '/pdf/consumuri?period=' + perioadaStoc);
  const [products, gestiuni, stock, movs] = await Promise.all([
    api('/api/products'), api('/api/gestiuni'), api('/api/stocks?asOf=' + asOf + (gf ? '&gestiune=' + gf : '')), api('/api/stock-movements'),
  ]);
  // gestiuni: listă + selecturi
  $('#gestiuniList').innerHTML = gestiuni.length
    ? `<table><thead><tr><th>Cod</th><th>Denumire</th><th>Gestionar</th><th>Cont</th><th></th></tr></thead><tbody>${
      gestiuni.map((g) => `<tr><td class="acc">${g.cod}</td><td>${g.denumire}</td><td>${g.gestionar || ''}</td><td class="acc">${g.cont || '371'}</td>
        <td><button class="linkbtn gdel" data-id="${g.id}">șterge</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio gestiune. Adaugă cel puțin un depozit.</p>';
  $$('#gestiuniList .gdel').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/gestiuni/' + b.dataset.id, { method: 'DELETE' }); loadStocks(); toast('Gestiune ștearsă'); }
    catch (e) { toast(e.message, true); }
  }));
  const gestOpts = gestiuni.map((g) => `<option value="${g.id}">${g.cod} — ${g.denumire}</option>`).join('');
  const mf = $('#movementForm');
  mf.productId.innerHTML = products.map((p) => `<option value="${p.id}">${p.cod} — ${p.denumire}</option>`).join('') || '<option value="">(niciun produs)</option>';
  mf.gestiuneId.innerHTML = gestOpts || '<option value="">(nicio gestiune)</option>';
  mf.gestiuneDestId.innerHTML = gestOpts || '<option value="">(nicio gestiune)</option>';
  $('#stocGestFilter').innerHTML = '<option value="">Toate gestiunile</option>' + gestiuni.map((g) => `<option value="${g.id}"${g.id === gf ? ' selected' : ''}>${g.cod} — ${g.denumire}</option>`).join('');
  fillProduction(products, gestiuni);
  fillRecipes(products, gestiuni);
  const ig = $('#invGest'); const prevIg = ig.value;
  ig.innerHTML = gestiuni.map((g) => `<option value="${g.id}">${g.cod} — ${g.denumire}</option>`).join('') || '<option value="">(nicio gestiune)</option>';
  if (prevIg) ig.value = prevIg;
  $('#invPdf').href = '/pdf/inventory?asOf=' + asOf + '&gestiune=' + (ig.value || '');
  // stoc curent (pe gestiune)
  const totV = stock.reduce((t, s) => t + s.stocV, 0);
  $('#stocksList').innerHTML = stock.length
    ? `<table><thead><tr><th>Gestiune</th><th>Cod</th><th>Denumire</th><th class="num">Cantitate</th><th>UM</th><th class="num">CMP</th><th class="num">Valoare</th><th></th></tr></thead><tbody>${
      stock.map((s) => `<tr><td>${s.gestiune.cod}</td><td class="acc">${s.product.cod}</td><td>${s.product.denumire}</td>
        <td class="num">${fmt(s.stocQ)}</td><td>${s.product.um || 'buc'}</td><td class="num">${fmt(s.cmp)}</td><td class="num">${fmt(s.stocV)}</td>
        <td><a class="linkbtn" href="/pdf/stock-ledger/${s.product.id}?asOf=${asOf}&gestiune=${s.gestiune.id}" target="_blank">fișă</a> · <button class="linkbtn pdel" data-id="${s.product.id}">șterge</button></td></tr>`).join('')}
      <tr class="bold"><td colspan="6">TOTAL VALOARE STOC</td><td class="num">${fmt(round2(totV))}</td><td></td></tr></tbody></table>`
    : '<p class="muted">Niciun stoc. Adaugă produse/gestiuni și înregistrează recepții.</p>';
  $$('#stocksList .pdel').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi produsul și toate mișcările lui?')) return;
    await api('/api/products/' + b.dataset.id, { method: 'DELETE' }); loadStocks(); toast('Produs șters');
  }));
  // mișcări (cu filtre)
  STOCK_MOVS = movs;
  $('#mvfGest').innerHTML = '<option value="">Toate gestiunile</option>' + gestiuni.map((g) => `<option value="${g.cod}">${g.cod} — ${g.denumire}</option>`).join('');
  renderStockMovements();
  // verificarea stocului preluat vs. soldurile inițiale (daca exista o preluare)
  try { renderInitialCheck((await api('/api/stocks/initial-check')).totaluri); } catch (e) { /* ignora */ }
  // procese-verbale de inventariere
  const invs = await api('/api/inventories');
  $('#inventoriesList').innerHTML = invs.length
    ? `<table><thead><tr><th>Data</th><th>Gestiune</th><th>Operator</th><th class="num">Plusuri</th><th class="num">Minusuri</th><th class="num">Imputat</th><th>Stare</th><th></th></tr></thead><tbody>${
      invs.map((iv) => `<tr${iv.status === 'stornat' ? ' class="muted"' : ''}><td>${iv.data}</td><td>${iv.gestiuneCod}</td><td>${iv.operator || '—'}</td>
        <td class="num">${iv.nrPlus} (${fmt(iv.totalPlus)})</td><td class="num">${iv.nrMinus} (${fmt(iv.totalMinus)})</td><td class="num">${fmt(iv.totalImputat)}</td>
        <td>${iv.status === 'stornat' ? '<span class="pill">stornat ' + (iv.stornoData || '') + '</span>' : 'activ'}</td>
        <td><a class="linkbtn" href="/pdf/inventory-pv/${iv.id}" target="_blank">proces-verbal</a>${iv.status === 'stornat' ? '' : ` · <button class="linkbtn ivstorno" data-id="${iv.id}">stornează</button>`}</td></tr>`).join('')}</tbody></table>`
    : '';
  $$('#inventoriesList .ivstorno').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Stornezi acest inventar? Se reversează notele contabile și se șterg mișcările de reglare (stocul revine la starea de dinainte).')) return;
    try { const r = await api('/api/inventories/' + b.dataset.id + '/storno', { method: 'POST' }); toast('Inventar stornat (' + r.stornoEntries + ' note reversate)'); loadStocks(); }
    catch (err) { toast(err.message, true); }
  }));
  loadDocSeries();
  $('#docRegPdf').href = '/pdf/doc-register';
  const reg = await api('/api/doc-register');
  $('#docRegisterList').innerHTML = reg.length
    ? `<table><thead><tr><th>Tip</th><th>Serie/Nr</th><th>Data</th><th>Gestiune</th><th>Referință</th><th class="num">Valoare</th><th>Operator</th></tr></thead><tbody>${
      reg.map((r) => `<tr><td>${r.tip}</td><td class="acc">${r.serieNr}</td><td>${r.data}</td><td>${r.gestiune}</td><td>${r.document || ''}</td><td class="num">${fmt(r.valoare)}</td><td>${r.operator || '—'}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Niciun document emis încă (numerele se atribuie la prima tipărire a unui NIR/bon/aviz).</p>';
}
onPeriodChange('stoc', loadStocks);
$('#stocGestFilter').addEventListener('change', loadStocks);
async function loadDocSeries() {
  let s; try { s = await api('/api/doc-series'); } catch (e) { return; }
  const f = $('#docSeriesForm');
  ['NIR', 'BC', 'AVIZ', 'CH'].forEach((t) => { if (s[t]) { f[t + '_serie'].value = s[t].serie; f[t + '_next'].value = s[t].next; } });
}
$('#docSeriesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { NIR: { serie: f.NIR_serie.value, next: f.NIR_next.value }, BC: { serie: f.BC_serie.value, next: f.BC_next.value }, AVIZ: { serie: f.AVIZ_serie.value, next: f.AVIZ_next.value }, CH: { serie: f.CH_serie.value, next: f.CH_next.value } };
  await api('/api/doc-series', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  toast('Serii salvate'); loadDocSeries();
});
$('#gestiuneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try { await api('/api/gestiuni', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cod: f.cod.value, denumire: f.denumire.value, gestionar: f.gestionar.value, cont: f.cont.value }) }); toast('Gestiune salvată'); f.reset(); f.cont.value = '371'; loadStocks(); }
  catch (err) { toast(err.message, true); }
});
$('#productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { cod: f.cod.value, denumire: f.denumire.value, um: f.um.value, cont: f.cont.value, grupa: f.grupa.value, codNC: f.codNC.value };
  try { await api('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Produs salvat'); f.reset(); f.um.value = 'buc'; f.cont.value = '371'; loadStocks(); }
  catch (err) { toast(err.message, true); }
});
$('#prodCsvFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { try { $('#prodCsvIn').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } } });
$('#prodImportBtn').addEventListener('click', async () => {
  const csv = $('#prodCsvIn').value.trim(); if (!csv) return toast('Lipiește un CSV', true);
  try { const r = await api('/api/products/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) }); toast(r.importati + ' produse importate'); $('#prodCsvIn').value = ''; loadStocks(); }
  catch (err) { toast(err.message, true); }
});
// Preluare stoc inițial (cantitativ-valoric) din CSV/XLS/XLSX/DBF, la data preluării firmei
function renderInitialCheck(tot) {
  const box = $('#initStocCheck'); if (!box) return;
  box.innerHTML = (tot || []).length
    ? `<table><thead><tr><th>Cont stoc</th><th class="num">Stoc inițial preluat</th><th class="num">Sold inițial cont</th><th class="num">Diferență</th></tr></thead><tbody>${
      tot.map((t) => `<tr><td class="acc">${t.cont}</td><td class="num">${fmt(t.stocInitial)}</td><td class="num">${fmt(t.soldInitial)}</td><td class="num"${Math.abs(t.diferenta) >= 0.01 ? ' style="color:#b00020;font-weight:700"' : ''}>${fmt(t.diferenta)}</td></tr>`).join('')}</tbody></table>
      <p class="muted" style="margin-top:6px">Verificare cantitativ-valoric vs. contabilitate: <b>Diferență ≠ 0</b> înseamnă că valoarea stocului preluat nu bate cu soldul inițial sintetic al contului — corectează soldurile inițiale sau cantitățile/valorile preluate.</p>`
    : '';
}
$('#initStocFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { try { $('#initStocCsv').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } } });
$('#initStocBtn').addEventListener('click', async () => {
  const csv = $('#initStocCsv').value.trim(); if (!csv) return toast('Lipiește sau încarcă stocul (CSV/XLS/DBF)', true);
  const data = $('#initStocData').value; if (!data) return toast('Alege data preluării', true);
  try {
    const r = await api('/api/stocks/import-initial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv, data }) });
    const s = $('#initStocStatus'); s.className = 'status ' + (r.erori.length ? 'err' : 'ok');
    s.textContent = r.importate + ' poziții preluate'
      + (r.produseNoi ? ', ' + r.produseNoi + ' produse noi' : '') + (r.gestiuniNoi ? ', ' + r.gestiuniNoi + ' gestiuni noi' : '')
      + (r.erori.length ? ' — ' + r.erori.length + ' rânduri cu probleme: ' + r.erori.slice(0, 3).join('; ') + (r.erori.length > 3 ? '…' : '') : '.');
    renderInitialCheck(r.totaluri);
    $('#initStocCsv').value = '';
    loadStocks();
  } catch (err) { toast(err.message, true); }
});
// transfer => arată gestiunea destinație, ascunde prețul
$('#movementForm').tip.addEventListener('change', (e) => {
  const isTransfer = e.target.value === 'transfer';
  const isReceptie = e.target.value === 'receptie';
  $('#gestDestRow').classList.toggle('hidden', !isTransfer);
  $('#pretRow').classList.toggle('hidden', isTransfer);
  $('#furnizorRow').classList.toggle('hidden', !isReceptie);
  $('#gestSrcRow').firstChild.textContent = isTransfer ? 'Gestiune sursă ' : 'Gestiune ';
});
$('#movementForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { productId: f.productId.value, tip: f.tip.value, gestiuneId: f.gestiuneId.value, gestiuneDestId: f.gestiuneDestId.value, data: f.data.value, cantitate: f.cantitate.value, pretUnitar: f.pretUnitar.value, furnizor: f.furnizor.value, document: f.document.value };
  try { await api('/api/stock-movements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast('Mișcare înregistrată'); f.cantitate.value = ''; f.pretUnitar.value = ''; f.furnizor.value = ''; f.document.value = ''; loadStocks(); }
  catch (err) { toast(err.message, true); }
});
// ── Producție ──
let PROD_OPTS = { products: [], gestiuni: [] };
function prodMatRow() {
  const div = document.createElement('div');
  div.className = 'row'; div.style.cssText = 'gap:6px;margin-top:4px;align-items:center';
  div.innerHTML = `<select class="pm-prod" style="flex:2">${PROD_OPTS.products.map((p) => `<option value="${p.id}">${p.cod} — ${p.denumire}</option>`).join('')}</select>
    <select class="pm-gest" style="flex:1">${PROD_OPTS.gestiuni.map((g) => `<option value="${g.id}">${g.cod}</option>`).join('')}</select>
    <input class="pm-qty" type="number" step="0.001" placeholder="cantitate" style="flex:1">
    <button type="button" class="del pm-del" title="Elimină">✕</button>`;
  div.querySelector('.pm-del').addEventListener('click', () => div.remove());
  return div;
}
function fillProduction(products, gestiuni) {
  PROD_OPTS = { products: products || [], gestiuni: gestiuni || [] };
  const f = $('#prodForm'); if (!f) return;
  f.productId.innerHTML = PROD_OPTS.products.map((p) => `<option value="${p.id}">${p.cod} — ${p.denumire}</option>`).join('') || '<option value="">(niciun produs)</option>';
  f.gestiuneId.innerHTML = PROD_OPTS.gestiuni.map((g) => `<option value="${g.id}">${g.cod} — ${g.denumire}</option>`).join('') || '<option value="">(nicio gestiune)</option>';
  if (!f.data.value) f.data.value = new Date().toISOString().slice(0, 10);
  if (!$('#prodMaterials').children.length) $('#prodMaterials').appendChild(prodMatRow());
  renderProductionReport();
}
async function renderProductionReport() {
  const box = $('#prodReport'); if (!box) return;
  try {
    const r = await api('/api/production-report?period=' + workMonth());
    box.innerHTML = (r.rows || []).length
      ? `<table><thead><tr><th>Data</th><th>Cod</th><th>Produs</th><th class="num">Cant.</th><th class="num">Cost unit.</th><th class="num">Valoare</th></tr></thead><tbody>${
        r.rows.map((x) => `<tr><td>${x.data}</td><td class="acc">${x.cod}</td><td>${x.denumire}</td><td class="num">${fmt(x.cantitate)}</td><td class="num">${fmt(x.cost)}</td><td class="num">${fmt(x.valoare)}</td></tr>`).join('')
      }<tr class="total"><td colspan="3">TOTAL</td><td class="num">${fmt(r.totalCantitate)}</td><td></td><td class="num">${fmt(r.totalValoare)}</td></tr></tbody></table>`
      : '<p class="muted">Nicio producție înregistrată în luna de lucru.</p>';
  } catch (e) { /* ignora */ }
}
$('#prodAddMat') && $('#prodAddMat').addEventListener('click', () => $('#prodMaterials').appendChild(prodMatRow()));
$('#prodForm') && $('#prodForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const materiale = $$('#prodMaterials .row').map((row) => ({
    productId: row.querySelector('.pm-prod').value, gestiuneId: row.querySelector('.pm-gest').value, cantitate: Number(row.querySelector('.pm-qty').value) || 0,
  })).filter((m) => m.productId && m.cantitate > 0);
  const body = { productId: f.productId.value, gestiuneId: f.gestiuneId.value, cantitate: f.cantitate.value, costUnitar: f.costUnitar.value, data: f.data.value, document: f.document.value, materiale };
  try {
    const r = await api('/api/production', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#prodStatus').className = 'status ok';
    $('#prodStatus').textContent = 'Producție înregistrată: cost materiale ' + fmt(r.costMateriale) + ', valoare obținută ' + fmt(r.valoareObtinuta) + ' lei.' + (r.warns.length ? ' ' + r.warns.join(' ') : '');
    f.cantitate.value = ''; f.costUnitar.value = ''; f.document.value = ''; $('#prodMaterials').innerHTML = '';
    loadStocks(); loadEntries();
  } catch (err) { $('#prodStatus').className = 'status err'; $('#prodStatus').textContent = err.message; }
});
// ── Rețete / BOM ──
function recipeMatRow(mat) {
  const div = document.createElement('div');
  div.className = 'row'; div.style.cssText = 'gap:6px;margin-top:4px;align-items:center';
  div.innerHTML = `<select class="rm-prod" style="flex:2">${PROD_OPTS.products.map((p) => `<option value="${p.id}">${p.cod} — ${p.denumire}</option>`).join('')}</select>
    <select class="rm-gest" style="flex:1">${PROD_OPTS.gestiuni.map((g) => `<option value="${g.id}">${g.cod}</option>`).join('')}</select>
    <input class="rm-qty" type="number" step="0.001" placeholder="cantitate" style="flex:1">
    <button type="button" class="del rm-del" title="Elimină">✕</button>`;
  if (mat) {
    div.querySelector('.rm-prod').value = mat.productId;
    if (mat.gestiuneId) div.querySelector('.rm-gest').value = mat.gestiuneId;
    div.querySelector('.rm-qty').value = mat.cantitate;
  }
  div.querySelector('.rm-del').addEventListener('click', () => div.remove());
  return div;
}
function recipeResetForm() {
  const f = $('#recipeForm'); if (!f) return;
  f.reset(); f.id.value = ''; f.cantitateBaza.value = '1';
  $('#recipeMaterials').innerHTML = ''; $('#recipeMaterials').appendChild(recipeMatRow());
  $('#recipeStatus').textContent = '';
}
function fillRecipes(products, gestiuni) {
  const f = $('#recipeForm'); if (!f) return;
  f.productId.innerHTML = (products || []).map((p) => `<option value="${p.id}">${p.cod} — ${p.denumire}</option>`).join('') || '<option value="">(niciun produs)</option>';
  f.gestiuneId.innerHTML = (gestiuni || []).map((g) => `<option value="${g.id}">${g.cod} — ${g.denumire}</option>`).join('') || '<option value="">(nicio gestiune)</option>';
  if (!$('#recipeMaterials').children.length) $('#recipeMaterials').appendChild(recipeMatRow());
  renderRecipes(products);
}
async function renderRecipes(products) {
  const box = $('#recipeList'); if (!box) return;
  const pName = (id) => { const p = (products || PROD_OPTS.products).find((x) => x.id === id); return p ? p.cod + ' — ' + p.denumire : id; };
  let list; try { list = await api('/api/recipes'); } catch (e) { return; }
  if (!list.length) { box.innerHTML = '<p class="muted">Nicio rețetă salvată.</p>'; return; }
  box.innerHTML = `<table><thead><tr><th>Rețetă</th><th>Produs finit</th><th class="num">Cant. bază</th><th class="num">Materiale</th><th>Acțiuni</th></tr></thead><tbody>${
    list.map((r) => `<tr data-id="${r.id}"><td><b>${r.nume}</b></td><td>${pName(r.productId)}</td><td class="num">${fmt(r.cantitateBaza)}</td><td class="num">${(r.materiale || []).length}</td>
      <td class="row" style="gap:4px">
        <input class="rc-qty" type="number" step="0.001" placeholder="cant." style="width:80px" title="Cantitate de produs">
        <button class="btn small primary rc-produce" title="Produce această cantitate">▶ Produce</button>
        <button class="btn small ghost rc-edit">Editează</button>
        <button class="del rc-del" title="Șterge">✕</button>
      </td></tr>`).join('')}</tbody></table>`;
  box._recipes = list;
  $$('#recipeList .rc-produce').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr'); const id = tr.dataset.id; const qty = Number(tr.querySelector('.rc-qty').value) || 0;
    if (!(qty > 0)) return toast('Indică o cantitate', true);
    b.disabled = true;
    try {
      const r = await api('/api/recipes/' + id + '/produce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cantitate: qty, data: $('#prodForm') ? $('#prodForm').data.value : undefined }) });
      $('#recipeStatus').className = 'status ok';
      $('#recipeStatus').textContent = 'Producție din rețetă: cost materiale ' + fmt(r.costMateriale) + ', valoare obținută ' + fmt(r.valoareObtinuta) + ' lei.' + (r.warns.length ? ' ' + r.warns.join(' ') : '');
      loadStocks(); loadEntries();
    } catch (err) { $('#recipeStatus').className = 'status err'; $('#recipeStatus').textContent = err.message; b.disabled = false; }
  }));
  $$('#recipeList .rc-edit').forEach((b) => b.addEventListener('click', () => {
    const r = box._recipes.find((x) => x.id === b.closest('tr').dataset.id); if (!r) return;
    const f = $('#recipeForm');
    f.id.value = r.id; f.nume.value = r.nume; f.productId.value = r.productId; if (r.gestiuneId) f.gestiuneId.value = r.gestiuneId;
    f.cantitateBaza.value = r.cantitateBaza; f.costUnitar.value = r.costUnitar || '';
    $('#recipeMaterials').innerHTML = '';
    (r.materiale || []).forEach((m) => $('#recipeMaterials').appendChild(recipeMatRow(m)));
    if (!(r.materiale || []).length) $('#recipeMaterials').appendChild(recipeMatRow());
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  $$('#recipeList .rc-del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi rețeta?')) return;
    try { await api('/api/recipes/' + b.closest('tr').dataset.id, { method: 'DELETE' }); toast('Rețetă ștearsă'); renderRecipes(products); }
    catch (err) { toast(err.message, true); }
  }));
}
$('#recipeAddMat') && $('#recipeAddMat').addEventListener('click', () => $('#recipeMaterials').appendChild(recipeMatRow()));
$('#recipeReset') && $('#recipeReset').addEventListener('click', recipeResetForm);
$('#recipeForm') && $('#recipeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const materiale = $$('#recipeMaterials .row').map((row) => ({
    productId: row.querySelector('.rm-prod').value, gestiuneId: row.querySelector('.rm-gest').value, cantitate: Number(row.querySelector('.rm-qty').value) || 0,
  })).filter((m) => m.productId && m.cantitate > 0);
  const body = { id: f.id.value || undefined, nume: f.nume.value, productId: f.productId.value, gestiuneId: f.gestiuneId.value, cantitateBaza: f.cantitateBaza.value, costUnitar: f.costUnitar.value, materiale };
  try {
    await api('/api/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#recipeStatus').className = 'status ok'; $('#recipeStatus').textContent = 'Rețetă salvată.';
    recipeResetForm(); renderRecipes();
  } catch (err) { $('#recipeStatus').className = 'status err'; $('#recipeStatus').textContent = err.message; }
});
// ── Inventariere ──
$('#invGest').addEventListener('change', () => { $('#invPdf').href = '/pdf/inventory?asOf=' + stocAsOf() + '&gestiune=' + $('#invGest').value; });
$('#invLoad').addEventListener('click', async () => {
  const gid = $('#invGest').value;
  if (!gid) return toast('Adaugă o gestiune întâi', true);
  const list = await api('/api/inventory?gestiune=' + gid + '&asOf=' + stocAsOf());
  if (!list.length) { $('#inventoryArea').innerHTML = '<p class="muted">Niciun produs în nomenclator.</p>'; return; }
  $('#inventoryArea').innerHTML = `<table><thead><tr><th>Cod</th><th>Denumire</th><th class="num">Scriptic</th><th class="num">CMP</th><th class="num">Faptic</th><th>Imputare</th></tr></thead><tbody>${
    list.map((l) => `<tr data-pid="${l.product.id}"><td class="acc">${l.product.cod}</td><td>${l.product.denumire}</td>
      <td class="num scr">${fmt(l.scripticQty)} ${l.product.um || ''}</td><td class="num">${fmt(l.cmp)}</td>
      <td class="num"><input class="inv-fapt" type="number" step="0.001" value="${l.scripticQty}" style="width:90px;text-align:right"></td>
      <td><input class="inv-imp" type="checkbox" title="Impută lipsa gestionarului"></td></tr>`).join('')}</tbody></table>
    <div class="row" style="margin-top:10px"><input id="invData" type="date" value="${stocAsOf()}-28" style="max-width:160px"> <button id="invPost" class="btn primary">Înregistrează diferențele</button></div>`;
  $('#invPost').addEventListener('click', async () => {
    const lines = $$('#inventoryArea tbody tr').map((tr) => ({ productId: tr.dataset.pid, faptic: tr.querySelector('.inv-fapt').value, imputa: tr.querySelector('.inv-imp').checked }));
    try {
      const r = await api('/api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gestiuneId: gid, data: $('#invData').value, lines }) });
      const res = r.result;
      toast(`Inventar înregistrat: ${res.plusuri.length} plus, ${res.minusuri.length} minus${res.imputari.length ? ', ' + res.imputari.length + ' imputări' : ''}`);
      $('#inventoryArea').innerHTML = ''; loadStocks();
    } catch (err) { toast(err.message, true); }
  });
});

// ───────────────────────── ANAF / SPV ─────────────────────────
async function renderAnaf() {
  let c;
  try { c = await api('/api/anaf/config'); } catch (e) { return; }
  const f = $('#anafForm');
  f.env.value = c.env || 'test'; f.cif.value = c.cif || ''; f.redirectUri.value = c.redirectUri || '';
  f.autoPoll.checked = !!c.autoPoll;
  const st = $('#anafStatus');
  if (c.connected) { st.className = 'status ok'; st.textContent = '✔ Conectat la SPV (' + c.env + ').'; }
  else if (c.configured) { st.className = 'status'; st.textContent = 'Configurat — apasă „Conectează” pentru autorizare.'; }
  else { st.className = 'status'; st.textContent = 'Necompletat — introdu client_id, client_secret și redirect_uri.'; }
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

// ───────────────────────── PLAN ─────────────────────────
$('#planFilter').addEventListener('input', renderPlan);
$('#accCsvFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { try { $('#accCsvIn').value = await fileToCsv(f); } catch (err) { toast(err.message, true); } } });
$('#accImportBtn').addEventListener('click', async () => {
  const csv = $('#accCsvIn').value.trim(); if (!csv) return toast('Lipiește un CSV', true);
  try {
    const r = await api('/api/accounts/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
    toast(r.importati + ' conturi importate (' + r.totalConturi + ' total)');
    $('#accCsvIn').value = ''; META = await api('/api/meta'); renderPlan();
  } catch (err) { toast(err.message, true); }
});
function renderPlan() {
  const q = ($('#planFilter').value || '').toLowerCase();
  const rows = META.accounts.filter((a) => !q || a.cod.includes(q) || a.nume.toLowerCase().includes(q))
    .map((a) => `<tr><td class="acc">${a.cod}</td><td>${a.nume}</td><td>Clasa ${a.clasa}</td><td>${a.tip}</td></tr>`).join('');
  $('#planView').innerHTML = `<table><thead><tr><th>Cont</th><th>Denumire</th><th>Clasa</th><th>Tip</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ── Mod simplu (necontabil) + Dicționar contabil pe înțelesul tuturor ──
const GLOSAR = [
  ['Articol contabil (partidă dublă)', 'Orice operațiune se scrie de două ori: un cont primește (debit), altul dă (credit), cu aceeași sumă. De aceea totalurile trebuie să fie mereu egale — e sistemul de auto-verificare al contabilității.'],
  ['Balanță de verificare', 'Tabelul de control al firmei: soldul fiecărui cont la o dată. Dacă totalul pe Debit = totalul pe Credit, contabilitatea „se închide" — nu s-a pierdut nimic pe drum.'],
  ['Registru-jurnal', 'Lista tuturor operațiunilor firmei, în ordine cronologică, numerotate. E „istoria completă" — documentul legal de bază al contabilității.'],
  ['Cartea mare / Fișă de cont', 'Aceleași operațiuni, dar grupate pe fiecare cont în parte: cât a intrat, cât a ieșit și ce sold a rămas. Fișa de cont e „extrasul de cont" al oricărui cont contabil.'],
  ['Cont contabil / Plan de conturi', 'Un „sertar" cu etichetă numerică în care se adună sume de același fel: 4111 = clienți, 401 = furnizori, 5121 = banca, 371 = mărfuri. Planul de conturi e lista tuturor sertarelor.'],
  ['Debit / Credit', 'Cele două coloane ale oricărui cont. Nu înseamnă „rău/bine" — sunt doar sensurile mișcării: la bani și stocuri debitul crește averea; la datorii creditul o crește.'],
  ['Creanțe', 'Bani pe care ai să-i primești: facturi emise și neîncasate încă de la clienți.'],
  ['Datorii', 'Bani pe care ai să-i dai: facturi primite și neplătite încă, taxe datorate, salarii de plată.'],
  ['Scadențar (aging)', 'Lista „cine îmi datorează / cui datorez", cu vechimea fiecărei sume (0-30, 31-60, 61-90, 90+ zile). Cu cât o creanță e mai veche, cu atât e mai greu de încasat.'],
  ['Sold / Solduri inițiale', 'Soldul = ce rămâne într-un cont după toate plusurile și minusurile. Soldurile inițiale sunt punctul de pornire — situația firmei în ziua în care ai adus-o în aplicație.'],
  ['TVA colectată', 'TVA-ul pe care l-ai adăugat pe facturile TALE către clienți. Nu e banul tău — îl strângi pentru stat.'],
  ['TVA deductibilă', 'TVA-ul plătit de tine pe facturile de la furnizori. Statul ți-l „dă înapoi" scăzându-l din ce ai colectat.'],
  ['Decont de TVA (D300)', 'Socoteala lunară/trimestrială cu statul: TVA colectată minus TVA deductibilă = TVA de plată (sau de recuperat).'],
  ['TVA la încasare', 'Regim special: TVA-ul devine datorat abia când factura e ÎNCASATĂ, nu când e emisă. Bun pentru firme mici cu clienți care plătesc greu.'],
  ['Taxare inversă', 'La anumite achiziții (ex. din UE), nu plătești TVA furnizorului — îl calculezi tu și îl declari simultan la colectat și la deductibil. Efect net zero, dar obligatoriu de raportat.'],
  ['D394 / D390', 'Declarații informative: D394 = cu cine ai făcut afaceri în România (facturi emise/primite); D390 = ce ai vândut/cumpărat din alte țări UE.'],
  ['D112', 'Declarația lunară pentru salarii: cine a lucrat, cât a câștigat și ce contribuții/impozit s-au reținut.'],
  ['D100 / Impozit micro', 'Declarația cu impozitul datorat statului. La microîntreprinderi: un procent mic (1%) din TOATE veniturile trimestrului, indiferent de cheltuieli.'],
  ['SAF-T (D406)', 'Fișierul standard prin care ANAF primește „toată contabilitatea" în format electronic: conturi, facturi, plăți, stocuri. Se depune lunar sau trimestrial, automat din datele existente.'],
  ['e-Factura / SPV', 'Sistemul național de facturi electronice: facturile B2B se trimit obligatoriu în SPV (Spațiul Privat Virtual) ca XML, în cel mult 5 zile lucrătoare.'],
  ['Storno', '„Anulează cu minus": operațiunea greșită nu se șterge (ar dispărea din istorie), ci se scrie încă o dată cu semn invers, ca să se anuleze reciproc.'],
  ['Amortizare / Mijloc fix', 'Un utilaj sau echipament scump (mijloc fix) nu e cheltuială dintr-o dată: costul lui se împarte pe anii de folosință. Bucata lunară se numește amortizare.'],
  ['CMP (cost mediu ponderat)', 'Prețul „mediu" al unui produs din stoc, recalculat la fiecare intrare. Când vinzi sau consumi, ieșirea se evaluează la acest preț mediu.'],
  ['NIR', 'Nota de intrare-recepție: documentul intern care confirmă că marfa de pe factura furnizorului chiar a intrat în depozit, cu cantitățile numărate.'],
  ['Bon de consum', 'Documentul intern cu care scoți materiale din depozit pentru folosință proprie (producție, consum) — nu pentru vânzare.'],
  ['Aviz de însoțire', 'Hârtia care însoțește marfa pe drum când factura nu e gata încă. Factura se emite ulterior, pe baza avizului.'],
  ['Gestiune', 'Un loc de depozitare urmărit separat (depozit, magazin, mașină). Stocul se ține pe fiecare gestiune, cu un gestionar răspunzător.'],
  ['Închidere de lună / de an', 'Ritualul de sfârșit de perioadă: se „strâng" conturile de TVA, veniturile și cheltuielile se mută în rezultat și se calculează impozitul. Aplicația face pașii automat.'],
  ['CAS / CASS / CAM', 'Contribuțiile din salarii: CAS 25% (pensie) și CASS 10% (sănătate) se rețin din salariul angajatului; CAM 2,25% (asigurări de muncă) e plătită de firmă, peste salariu.'],
  ['Avantaje în natură', 'Beneficii date angajatului altfel decât în bani (mașina firmei folosită personal, chirie plătită de firmă). Se impozitează ca salariul, deși nu se plătesc cash.'],
  ['Avans de trezorerie / Decont', 'Bani dați unui angajat „în avans" pentru cheltuieli (deplasare, cumpărături firmă). La întoarcere face decontul: aduce bonurile și restul de bani.'],
  ['Filă carnet comercializare', 'Documentul cu care cumperi legal produse agricole de la producători persoane fizice (Legea 145/2014) — fără TVA și fără factură clasică.'],
  ['Chitanță', 'Dovada scrisă că ai primit bani în numerar. Pentru încasările prin bancă dovada e extrasul, nu chitanța.'],
];
function renderGlossary(q) {
  const box = $('#glossaryList'); if (!box) return;
  const s = (q || '').toLowerCase().trim();
  const items = GLOSAR.filter(([t, e]) => !s || (t + ' ' + e).toLowerCase().includes(s));
  box.innerHTML = items.length
    ? items.map(([t, e]) => `<div class="gloss-item"><b>${t}</b><p>${e}</p></div>`).join('')
    : '<p class="muted" style="padding:10px 6px">Niciun termen găsit — încearcă alt cuvânt.</p>';
}
$('#glossaryBtn') && $('#glossaryBtn').addEventListener('click', () => { renderGlossary(''); $('#glossarySearch').value = ''; $('#glossaryModal').classList.remove('hidden'); $('#glossarySearch').focus(); });
$('#glossaryClose') && $('#glossaryClose').addEventListener('click', () => $('#glossaryModal').classList.add('hidden'));
$('#glossaryModal') && $('#glossaryModal').addEventListener('click', (e) => { if (e.target.id === 'glossaryModal') $('#glossaryModal').classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#glossaryModal')) $('#glossaryModal').classList.add('hidden'); });
$('#glossarySearch') && $('#glossarySearch').addEventListener('input', (e) => renderGlossary(e.target.value));

// Mod simplu: ascunde intrarile tehnic-contabile din meniu (marcate cu .adv). Implicit pentru
// utilizatorii „necontabil"; preferinta se tine per utilizator, in browser.
function uiModeKey() { return 'contabo-uimode-' + ((USER && USER.username) || ''); }
function applyUiMode(mode) {
  document.body.classList.toggle('simple-ui', mode === 'simplu');
  const b = $('#uiModeBtn');
  if (b) b.textContent = mode === 'simplu' ? '🎓 Simplu' : '🛠 Expert';
}
function initUiMode() {
  let saved = null;
  try { saved = localStorage.getItem(uiModeKey()); } catch (e) { /* privat */ }
  applyUiMode(saved || (USER && USER.tip === 'necontabil' ? 'simplu' : 'expert'));
}
$('#uiModeBtn') && $('#uiModeBtn').addEventListener('click', () => {
  const mode = document.body.classList.contains('simple-ui') ? 'expert' : 'simplu';
  try { localStorage.setItem(uiModeKey(), mode); } catch (e) { /* privat */ }
  applyUiMode(mode);
  toast(mode === 'simplu'
    ? 'Mod simplu: partea tehnic-contabilă (balanță, registre, plan de conturi, închideri) e ascunsă din meniu. Contabilitatea rulează neschimbată în fundal — revii oricând cu 🛠.'
    : 'Mod expert: toate meniurile sunt vizibile.');
});

// ── Solduri inițiale (editor, Setări → preluare firmă cu istoric) ──
let OPEN_ROWS = [];
function nrRo(s) {
  s = String(s == null ? '' : s).trim().replace(/\s/g, '').replace(/lei|ron/gi, '');
  if (!s) return 0;
  if (s.includes('.') && s.includes(',')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
async function renderOpening() {
  let map; try { map = await api('/api/opening'); } catch (e) { return; }
  OPEN_ROWS = Object.keys(map).sort().map((cont) => ({ cont, d: Number(map[cont].d) || 0, c: Number(map[cont].c) || 0 }));
  drawOpening();
}
function drawOpening() {
  const rows = OPEN_ROWS.map((r, i) => `<tr>
    <td><input class="op-cont acc" data-i="${i}" value="${r.cont}" placeholder="cont" style="width:90px" /></td>
    <td class="muted op-nume">${accName(r.cont) || ''}</td>
    <td><input class="op-d num" data-i="${i}" type="number" step="0.01" value="${r.d || ''}" placeholder="0" style="width:120px;text-align:right" /></td>
    <td><input class="op-c num" data-i="${i}" type="number" step="0.01" value="${r.c || ''}" placeholder="0" style="width:120px;text-align:right" /></td>
    <td><button class="linkbtn op-del" data-i="${i}">șterge</button></td></tr>`).join('');
  $('#openEditor').innerHTML = OPEN_ROWS.length
    ? `<table><thead><tr><th>Cont</th><th>Denumire</th><th class="num">Sold debit</th><th class="num">Sold credit</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">Niciun sold inițial. Adaugă conturi sau încarcă balanța din fișier.</p>';
  const totD = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.d || 0), 0) * 100) / 100;
  const totC = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.c || 0), 0) * 100) / 100;
  const dif = Math.round((totD - totC) * 100) / 100;
  $('#openTotals').innerHTML = OPEN_ROWS.length
    ? `Total debit: <b>${fmt(totD)}</b> · Total credit: <b>${fmt(totC)}</b> · ${dif === 0 ? '<span style="color:var(--accent);font-weight:700">echilibrat ✓</span>' : `<span style="color:#b00020;font-weight:700">diferență ${fmt(dif)}</span>`}`
    : '';
  $$('#openEditor .op-cont').forEach((inp) => inp.addEventListener('input', (e) => {
    const r = OPEN_ROWS[Number(e.target.dataset.i)]; r.cont = e.target.value.trim();
    e.target.closest('tr').querySelector('.op-nume').textContent = accName(r.cont) || '';
  }));
  $$('#openEditor .op-d').forEach((inp) => inp.addEventListener('input', (e) => { OPEN_ROWS[Number(e.target.dataset.i)].d = Number(e.target.value) || 0; drawOpeningTotals(); }));
  $$('#openEditor .op-c').forEach((inp) => inp.addEventListener('input', (e) => { OPEN_ROWS[Number(e.target.dataset.i)].c = Number(e.target.value) || 0; drawOpeningTotals(); }));
  $$('#openEditor .op-del').forEach((b) => b.addEventListener('click', () => { OPEN_ROWS.splice(Number(b.dataset.i), 1); drawOpening(); }));
}
function drawOpeningTotals() {
  const totD = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.d || 0), 0) * 100) / 100;
  const totC = Math.round(OPEN_ROWS.reduce((s, r) => s + (r.c || 0), 0) * 100) / 100;
  const dif = Math.round((totD - totC) * 100) / 100;
  $('#openTotals').innerHTML = `Total debit: <b>${fmt(totD)}</b> · Total credit: <b>${fmt(totC)}</b> · ${dif === 0 ? '<span style="color:var(--accent);font-weight:700">echilibrat ✓</span>' : `<span style="color:#b00020;font-weight:700">diferență ${fmt(dif)}</span>`}`;
}
$('#openAddRow') && $('#openAddRow').addEventListener('click', () => { OPEN_ROWS.push({ cont: '', d: 0, c: 0 }); drawOpening(); });
$('#openFile') && $('#openFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  let csv; try { csv = await fileToCsv(f); } catch (err) { return toast(err.message, true); }
  const lines = csv.split(/\r?\n/).map((l) => l.replace(/^﻿/, '')).filter((l) => l.trim());
  const rows = [];
  for (const line of lines) {
    const cells = line.split(';');
    const cont = String(cells[0] || '').trim();
    if (!cont || !/^\d/.test(cont)) continue; // sare antetul si randurile fara cont
    const d = nrRo(cells[2]); const c = nrRo(cells[3]);
    if (d === 0 && c === 0) continue;
    rows.push({ cont, d, c });
  }
  if (!rows.length) return toast('Nicio linie cu solduri găsită (aștept coloane Cont;Denumire;SoldDebit;SoldCredit)', true);
  OPEN_ROWS = rows;
  drawOpening();
  toast(rows.length + ' conturi încărcate — verifică echilibrul și salvează');
  e.target.value = '';
});
$('#openSaveBtn') && $('#openSaveBtn').addEventListener('click', async () => {
  const ob = {};
  for (const r of OPEN_ROWS) {
    if (!r.cont) continue;
    const prev = ob[r.cont] || { d: 0, c: 0 };
    ob[r.cont] = { d: Math.round((prev.d + (r.d || 0)) * 100) / 100, c: Math.round((prev.c + (r.c || 0)) * 100) / 100 };
  }
  const s = $('#openStatus');
  try {
    const r = await api('/api/opening', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openingBalances: ob }) });
    s.className = 'status ok';
    s.textContent = 'Solduri inițiale salvate (' + Object.keys(ob).length + ' conturi, debit = credit = ' + fmt(r.totalDebit) + ' lei).';
    toast('Solduri inițiale salvate');
  } catch (err) { s.className = 'status err'; s.textContent = err.message; }
});

// ───────────────────────── SETTINGS / SEED ─────────────────────────
$('#companyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { nume: f.nume.value, cui: f.cui.value, regCom: f.regCom.value, adresa: f.adresa.value, oras: f.oras.value, judet: f.judet.value, tvaLaIncasare: f.tvaLaIncasare.checked,
    iban: f.iban.value.trim(), banca: f.banca.value.trim(), telefon: f.telefon.value.trim(), email: f.email.value.trim(), capitalSocial: f.capitalSocial.value.trim(), accentColor: f.accentColor.value, pdfLayout: f.pdfLayout.value, pdfFooter: f.pdfFooter.value.trim() };
  const r = await api('/api/company', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  META.company = r.company || body; $('#companyName').textContent = body.nume; toast('Date firmă salvate' + (body.tvaLaIncasare ? ' · regim TVA la încasare ACTIV' : ''));
});
$('#seedBtn').addEventListener('click', async () => {
  $('#seedStatus').textContent = 'Se încarcă…';
  try { const r = await api('/api/seed', { method: 'POST' }); $('#seedStatus').textContent = r.message; META = await api('/api/meta'); fillPeriods(); loadEntries(); toast('Exemplu încărcat'); }
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
    <label>Parolă nouă <input name="password" type="password" autocomplete="new-password" required minlength="4" /></label>
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
    <label>Parolă nouă <input name="password" type="password" autocomplete="new-password" required minlength="4" /></label>
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
