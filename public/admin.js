'use strict';
// Administrare (tab-urile Setari + Audit, majoritatea admin): gestionarea firmelor (activare,
// creare, stergere, clona de test, import/restaurare ZIP/JSON), utilizatorii (drepturi granulare,
// invitatii, resetare parola, impersonare) si jurnalul de audit (firma / sistem). Extras din
// app.js (Etapa 4). Depinde de nucleu; init/onTab/promptFirmaSubscribe/impersonate sunt INJECTATE
// de app.js prin setAdminDeps (evita dependenta circulara admin <-> app).
import { $, $$, api, toast, USER, H, META, isDemo } from './core.js';

let deps = {};
export function setAdminDeps(d) { deps = d; }

// ── Cereri de acces la o firma existenta ──
// Un contabil care preia o firma nu si-o mai creeaza a doua oara (ar iesi o firma goala, dublura),
// ci cere acces la cea reala. Decide PROPRIETARUL.
export async function renderCereriAcces() {
  const box = $('#cereriPrimite'); if (!box) return;
  let d; try { d = await api('/api/firme/cereri'); } catch (e) { box.innerHTML = ''; return; }
  const c = d.cereri || [];
  box.innerHTML = c.length
    ? `<table><thead><tr><th>Firma</th><th>Cine cere</th><th>Email</th><th>Când</th><th></th></tr></thead><tbody>${
      c.map((r) => `<tr><td>${H(r.firma)}</td><td>${H(r.username)}</td><td class="muted">${H(r.email)}</td>
        <td class="muted">${String(r.ts || '').slice(0, 10)}</td>
        <td><button class="btn small primary cer-ok" data-id="${H(r.id)}">Aprobă</button>
            <button class="btn small cer-nu" data-id="${H(r.id)}">Respinge</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nicio cerere în așteptare.</p>';
  const decide = async (id, aprob) => {
    try {
      const r = await api('/api/firme/cereri/' + encodeURIComponent(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aprob }),
      });
      toast(aprob ? ('Acces acordat pentru „' + r.firma + '".') : 'Cerere respinsă.');
      renderCereriAcces();
    } catch (e) { toast(e.message, true); }
  };
  $$('#cereriPrimite .cer-ok').forEach((b2) => b2.addEventListener('click', () => decide(b2.dataset.id, true)));
  $$('#cereriPrimite .cer-nu').forEach((b2) => b2.addEventListener('click', () => decide(b2.dataset.id, false)));
}
$('#cerereAccesForm') && $('#cerereAccesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('#cerereAccesStatus');
  try {
    const r = await api('/api/firme/cerere-acces', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cui: e.target.cui.value }),
    });
    // mesajul e acelasi fie ca firma exista sau nu — ecranul nu are voie sa devina un mod de a
    // afla ce firme sunt in aplicatie, incercand CUI-uri
    st.className = 'status ok'; st.textContent = r.message;
    e.target.reset();
  } catch (err) { st.className = 'status err'; st.textContent = err.message; }
});

export async function renderFirme() {
  const data = await api('/api/firme');
  renderCereriAcces();
  $('#firmaExport').href = '/api/firme/' + data.firmaActiva + '/export-zip';
  // Contul demo (public, partajat) nu gestioneaza firme si nici setarile contului:
  // fara Firmele mele / mediu de test / restaurare, si fara profil / parola / 2FA / conexiune SPV.
  if (isDemo()) {
    ['#firmaNewForm', '#testCloneBtn', '#profileForm', '#pwForm', '#twofaStatus', '#anafForm'].forEach((sel) => {
      const el = $(sel); const card = el && el.closest('.card');
      if (card) card.classList.add('hidden');
    });
    $('#firmaRestoreZone') && $('#firmaRestoreZone').classList.add('hidden');
  }
  // Billing per-firma: fiecare firma are propria stare de abonament (f._sub).
  const subBadge = (f) => {
    const s = f._sub || {};
    if (s.status === 'trial') return ` <span class="pill" data-u="u10" title="Probă gratuită">🎁 probă: ${s.zileRamase} ${s.zileRamase === 1 ? 'zi' : 'zile'}</span>`;
    if (s.status === 'expired') return ' <span class="pill warn" title="Proba a expirat — abonează-te ca să continui">🎁 probă expirată</span>' + (s.pending ? ' <span class="pill" data-u="u11">⏳ plată în așteptare</span>' : '');
    if (s.status === 'none') return ' <span class="pill warn" title="Fără abonament">fără abonament</span>' + (s.pending ? ' <span class="pill" data-u="u11">⏳ plată în așteptare</span>' : '');
    if (s.status === 'active' && s.plan && s.plan !== 'grandfathered') return ` <span class="pill" data-u="u10" title="Abonament activ">✓ ${s.plan === 'pro' ? 'Pro' : s.plan === 'start' ? 'Start' : 'activ'}</span>`;
    return '';
  };
  const needsSub = (f) => f._sub && (f._sub.status === 'expired' || f._sub.status === 'none');
  $('#firmeList').innerHTML = `<table><thead><tr><th>Denumire</th><th>CUI</th><th></th></tr></thead><tbody>${
    data.firme.map((f) => `<tr>
      <td>${f.id === data.firmaActiva ? '<b>● ' + H(f.nume) + '</b>' : H(f.nume)}${subBadge(f)}</td><td>${H(f.cui)}</td>
      <td>${f.id === data.firmaActiva ? '<span class="pill">activă</span>' : `<button class="linkbtn fact" data-id="${f.id}">activează</button>`}
        ${needsSub(f) ? ` · <button class="linkbtn fsub" data-id="${f.id}" data-nume="${H(f.nume)}" data-u="u12">abonează-te →</button>` : ''}
        ${data.firme.length > 1 ? ` · <button class="del fdel" data-id="${f.id}">✕</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  $$('#firmeList .fact').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/firme/' + b.dataset.id + '/activate', { method: 'POST' }); await deps.init(); deps.onTab('setari'); toast('Firmă activată');
  }));
  $$('#firmeList .fsub').forEach((b) => b.addEventListener('click', () => deps.promptFirmaSubscribe(Number(b.dataset.id), b.dataset.nume)));
  $$('#firmeList .fdel').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ștergi această firmă și toate datele ei?')) return;
    try { await api('/api/firme/' + b.dataset.id, { method: 'DELETE' }); await deps.init(); deps.onTab('setari'); toast('Firmă ștearsă'); }
    catch (e) { toast(e.message, true); }
  }));
  const active = data.firme.find((f) => f.id === data.firmaActiva) || {};
  const isTest = /^\[TEST\]/.test(active.nume || '') || active.test;
  const info = $('#testEnvInfo');
  if (info) info.innerHTML = isTest
    ? '🧪 <b data-u="u13">Ești pe o firmă de TEST</b> — modificările de aici NU afectează firma reală.'
    : 'Firma activă acum: <b>' + (active.nume || '—') + '</b> (reală).';
}
$('#testCloneBtn') && $('#testCloneBtn').addEventListener('click', async () => {
  const b = $('#testCloneBtn');
  if (!confirm('Creezi o copie de TEST a firmei curente și vei fi comutat pe ea. Continui?')) return;
  b.disabled = true; b.textContent = 'Se creează copia…';
  try {
    const r = await api('/api/firme/' + META.firmaActiva + '/test-clone', { method: 'POST' });
    await deps.init(); deps.onTab('setari');
    toast('Firmă de test creată: ' + r.nume + ' (acum activă)');
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = '🧪 Creează firmă de test (copie a celei curente)'; }
});
$('#firmaNewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await api('/api/firme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nume: f.nume.value, cui: f.cui.value, regCom: f.regCom.value, oras: f.oras.value, tipEntitate: f.tipEntitate.value, tvaPlatitor: f.tvaPlatitor.checked }) });
  f.reset(); if (f.tvaPlatitor) f.tvaPlatitor.checked = true; await deps.init(); deps.onTab('setari');
  toast('Firmă adăugată cu o lună de probă gratuită (acum activă). Comuți între firme din selectorul de sus.');
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
    await deps.init(); deps.onTab('setari');
  } catch (e) { fail(e.message); }
});

// ───────────────────────── UTILIZATORI (admin) ─────────────────────────
function firmeChecks(selected) {
  const sel = new Set((selected || []).map(Number));
  return (META.firme || []).map((f) => `<label data-u="u14">
    <input type="checkbox" class="ufirma" value="${f.id}" ${sel.has(f.id) ? 'checked' : ''} data-u="u15"> ${H(f.nume)}</label>`).join('');
}
export async function renderUsers() {
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
    return `<span class="pill" data-style="${c}" title="${u.plan ? 'plan: ' + u.plan : 'fără plan (probă)'}">${u.tip || '—'}</span>`;
  };
  const drCheck = (u, key, label, title) => u.role === 'admin' ? '' : `<label data-u="u16" title="${title}">
      <input type="checkbox" class="udrept" data-id="${u.id}" data-drept="${key}" data-u="u15" ${u.drepturi && u.drepturi[key] ? 'checked' : ''} /> ${label}</label>`;
  $('#usersList').innerHTML = `<table><thead><tr><th>Utilizator</th><th>Tip</th><th>Firme</th><th>Drepturi</th><th></th></tr></thead><tbody>${
    users.map((u) => `<tr><td><b>${H(u.username)}</b>${u.pending ? ' <span class="pill warn">invitație</span>' : ''}</td><td>${tipPill(u)}</td>
      <td>${u.role === 'admin' ? '<span class="muted">toate</span>' : u.firme.map((id) => { const f = (META.firme || []).find((x) => x.id === id); return f ? H(f.nume) : id; }).join(', ') || '<span class="muted">—</span>'}</td>
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
    if (confirm('Intri pe contul acestui utilizator? Vei vedea aplicația exact ca el. Toate acțiunile sunt jurnalizate.')) deps.impersonate(Number(b.dataset.id));
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

// Colaboratori pe firma ACTIVA (pentru ORICE utilizator, nu doar admin): contabil <-> necontabil.
const COLAB_PILL = { admin: 'background:#2f2e2a;color:#fff', contabil: 'background:#e2f5e8;color:#0a7d33', necontabil: 'background:#e7eefc;color:#1652d6', tester: 'background:#fff4e0;color:#b26a00' };
export async function renderColaboratori() {
  const box = $('#colaboratoriBox'); if (!box) return;
  box.classList.remove('hidden');
  let data;
  try { data = await api('/api/colaboratori'); } catch (e) { $('#colaboratoriList').innerHTML = `<p class="muted">${H(e.message || 'Indisponibil')}</p>`; return; }
  const cols = data.colaboratori || [];
  const demo = !!data.demo;
  const pill = (c) => `<span class="pill" data-style="${COLAB_PILL[c.tip] || ''}">${c.tip || '—'}</span>`;
  $('#colaboratoriList').innerHTML = `<table><thead><tr><th>Utilizator</th><th>Tip</th><th></th></tr></thead><tbody>${
    cols.map((c) => `<tr><td><b>${H(c.username)}</b>${c.id === data.eu ? ' <span class="muted">(tu)</span>' : ''}${c.pending ? ' <span class="pill warn">invitație</span>' : ''}${c.email ? ` <span class="muted" data-u="u148">${H(c.email)}</span>` : ''}</td><td>${pill(c)}</td>
      <td>${c.id === data.eu ? '' : `<button class="del colremove" data-id="${c.id}" data-nume="${H(c.username)}">✕ scoate</button>`}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">Deocamdată ești singurul cu acces la această firmă.</td></tr>'}</tbody></table>`;
  const form = $('#colaboratorForm');
  if (form) form.querySelectorAll('input,button').forEach((el) => { el.disabled = false; });
  const note = $('#colaboratorInviteResult');
  const invBtn = $('#colaboratorInvite');
  if (demo) {
    // pe demo: colaborarea patron<->contabil se demonstreaza pe perechea demo/demo-contabil;
    // invitatiile de persoane noi sunt dezactivate, iar campul e pre-completat cu contul pereche
    const me = (cols.find((c) => c.id === data.eu) || {}).username || 'demo';
    const pereche = me === 'demo' ? 'demo-contabil' : 'demo';
    if (invBtn) invBtn.style.display = 'none';
    if (note) note.innerHTML = `🎭 Cont demo (<b>${H(me)}</b>): aici vezi colaborarea <b>patron↔contabil</b> pe aceeași firmă. Poți adăuga sau scoate contul pereche <b>${H(pereche)}</b>. Într-un cont propriu adaugi pe oricine (și inviți persoane noi prin link).`;
    if ($('#colaboratorKey') && !cols.some((c) => c.username === pereche)) $('#colaboratorKey').value = pereche;
  } else {
    if (invBtn) invBtn.style.display = '';
    if (note) note.innerHTML = '';
  }
  $$('#colaboratoriList .colremove').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Scoți accesul lui „' + b.dataset.nume + '" la firma activă?')) return;
    try { await api('/api/colaboratori/' + b.dataset.id, { method: 'DELETE' }); renderColaboratori(); toast('Colaborator scos'); }
    catch (e) { toast(e.message, true); }
  }));
}
async function addColaborator(mod) {
  const key = ($('#colaboratorKey').value || '').trim();
  if (!key) { toast('Completează utilizatorul sau emailul.', true); return; }
  const body = mod === 'invite' ? { mod: 'invite', username: key.includes('@') ? '' : key, email: key.includes('@') ? key : '' } : { mod: 'existing', username: key.includes('@') ? '' : key, email: key.includes('@') ? key : '' };
  if (mod === 'invite' && !body.username) { toast('Pentru invitație alege un nume de utilizator (nu email).', true); return; }
  try {
    const r = await api('/api/colaboratori', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.link) {
      $('#colaboratorInviteResult').innerHTML = `Invitație creată${r.emailed ? ' și trimisă pe email' : ''}. Link (trimite-l persoanei): <a href="${r.link}" data-u="u148">${H(r.link)}</a>`;
      toast('Invitație creată');
    } else { $('#colaboratorInviteResult').textContent = ''; toast('Colaborator adăugat'); }
    $('#colaboratorKey').value = '';
    renderColaboratori();
  } catch (e) { toast(e.message, true); }
}
$('#colaboratorAddExisting') && $('#colaboratorAddExisting').addEventListener('click', () => addColaborator('existing'));
$('#colaboratorInvite') && $('#colaboratorInvite').addEventListener('click', () => addColaborator('invite'));
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
export async function renderAudit() {
  const isAdmin = USER && USER.role === 'admin';
  $('#auditScope') && $('#auditScope').classList.toggle('hidden', !isAdmin);
  if (!isAdmin) AUDIT_SCOPE = 'firma';
  $('#auditScopeFirma') && $('#auditScopeFirma').classList.toggle('active', AUDIT_SCOPE === 'firma');
  $('#auditScopeSystem') && $('#auditScopeSystem').classList.toggle('active', AUDIT_SCOPE === 'system');
  // exportul CSV urmeaza scope-ul curent (firma / sistem)
  const exp = $('#auditExport'); if (exp) exp.href = AUDIT_SCOPE === 'system' ? '/csv/audit/system' : '/csv/audit';
  let list;
  try { list = await api(AUDIT_SCOPE === 'system' ? '/api/audit/system' : '/api/audit'); } catch (e) { return; }
  if (!list.length) { $('#auditList').innerHTML = '<p class="muted">Nicio acțiune înregistrată ' + (AUDIT_SCOPE === 'system' ? 'la nivel de sistem.' : 'pentru firma curentă.') + '</p>'; return; }
  $('#auditList').innerHTML = `<table><thead><tr><th>Data</th><th>Utilizator</th><th>Acțiune</th><th>Detaliu</th></tr></thead><tbody>${
    list.map((a) => `<tr><td>${(a.ts || '').replace('T', ' ').slice(0, 16)}</td><td>${H(a.username || '')}${a.viaAdmin ? ' <span class="muted">(via ' + H(a.viaAdmin) + ')</span>' : ''}</td>
      <td class="acc">${a.action}</td><td>${a.detail || ''}</td></tr>`).join('')}</tbody></table>`;
}
$('#auditRefresh').addEventListener('click', renderAudit);
$('#auditScopeFirma') && $('#auditScopeFirma').addEventListener('click', () => { AUDIT_SCOPE = 'firma'; renderAudit(); });
$('#auditScopeSystem') && $('#auditScopeSystem').addEventListener('click', () => { AUDIT_SCOPE = 'system'; renderAudit(); });
