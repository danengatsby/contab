'use strict';
// Administrare (tab-urile Setari + Audit, majoritatea admin): gestionarea firmelor (activare,
// creare, stergere, clona de test, import/restaurare ZIP/JSON), utilizatorii (drepturi granulare,
// invitatii, resetare parola, impersonare) si jurnalul de audit (firma / sistem). Extras din
// app.js (Etapa 4). Depinde de nucleu; init/onTab/promptFirmaSubscribe/impersonate sunt INJECTATE
// de app.js prin setAdminDeps (evita dependenta circulara admin <-> app).
import { $, $$, api, toast, USER, H, META, isDemo } from './core.js';

let deps = {};
export function setAdminDeps(d) { deps = d; }

export async function renderFirme() {
  const data = await api('/api/firme');
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
