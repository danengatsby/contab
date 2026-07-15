'use strict';
// Setari de cont & securitate (tab-ul Setari): 2FA (TOTP), backup/restaurare (admin),
// profil + sesiuni active, server SMTP (admin) si cotele fiscale configurabile (admin).
// Extras din app.js (Etapa 3 a modularizarii). Depinde de nucleu; init/onTab (reincarcarea
// sesiunii dupa (dez)activarea 2FA) sunt INJECTATE de app.js prin setSettingsDeps.
import { $, $$, api, toast, USER, setMeta } from './core.js';

let deps = {};
export function setSettingsDeps(d) { deps = d; }

export function render2FA() {
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
  try { await api('/api/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('#twofaCode').value }) }); toast('2FA activat'); await deps.init(); deps.onTab('setari'); }
  catch (e) { toast(e.message, true); }
});
$('#twofaDisable').addEventListener('click', async () => {
  try { await api('/api/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('#twofaDisCode').value }) }); toast('2FA dezactivat'); await deps.init(); deps.onTab('setari'); }
  catch (e) { toast(e.message, true); }
});
$('#twofaRevoke').addEventListener('click', async () => {
  try { await api('/api/2fa/revoke-devices', { method: 'POST' }); toast('Dispozitivele de încredere au fost revocate'); }
  catch (e) { toast(e.message, true); }
});

// ───────────────────────── BACKUP (admin) ─────────────────────────
export async function renderBackup() {
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
export async function renderProfile() {
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
export async function renderSessions() {
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
export async function renderSmtp() {
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
export async function renderFiscal() {
  if (!USER || USER.role !== 'admin') return;
  $('#fiscalCard').style.display = '';
  let c; try { c = await api('/api/fiscal-config'); } catch (e) { return; }
  const f = $('#fiscalForm');
  Object.keys(c.current || {}).forEach((k) => { if (f[k]) f[k].value = c.current[k]; });
  // Semnal de vechime: cotele implicite sunt fixate pentru un an fiscal si trebuie revizuite la lege.
  const vn = $('#fiscalVechime');
  if (vn) {
    const v = c.vechime || {};
    vn.innerHTML = v.stale
      ? `<div class="warnbox"><span class="wi">⚠️</span><div>Cotele sunt configurate pentru anul <b>${v.an}</b>, dar anul curent este <b>${v.anCurent}</b>. Verifică modificările legislative și actualizează cotele afectate — calculele folosesc valorile de mai jos ca atare.</div></div>`
      : (v.an ? `<p class="muted">Cote de referință: anul fiscal <b>${v.an}</b>.</p>` : '');
  }
}
$('#fiscalForm') && $('#fiscalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  [...e.target.elements].forEach((el) => { if (el.name && el.value !== '') body[el.name] = el.value; });
  try { await api('/api/fiscal-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); $('#fiscalStatus').className = 'status ok'; $('#fiscalStatus').textContent = 'Cote salvate — calculele folosesc noile valori.'; setMeta(await api('/api/meta')); toast('Cote fiscale actualizate'); }
  catch (err) { $('#fiscalStatus').className = 'status err'; $('#fiscalStatus').textContent = err.message; }
});
$('#fiscalReset') && $('#fiscalReset').addEventListener('click', async () => {
  if (!confirm('Revii la cotele fiscale standard din aplicație?')) return;
  try { await api('/api/fiscal-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) }); await renderFiscal(); setMeta(await api('/api/meta')); toast('Cote resetate la valori standard'); }
  catch (e) { toast(e.message, true); }
});
