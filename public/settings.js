'use strict';
// Setari de cont & securitate (tab-ul Setari): 2FA (TOTP), backup/restaurare (admin),
// profil + sesiuni active, server SMTP (admin) si cotele fiscale configurabile (admin).
// Extras din app.js (Etapa 3 a modularizarii). Depinde de nucleu; init/onTab (reincarcarea
// sesiunii dupa (dez)activarea 2FA) sunt INJECTATE de app.js prin setSettingsDeps.
import { $, $$, api, toast, USER, setMeta, H, confirmAction, alertAction } from './core.js';
import { registerFormFlow, formFlowFlush, formFlowLoaded, formFlowSaved } from './formflow.js';

let deps = {};
export function setSettingsDeps(d) { deps = d; }

// Cele doua jumatati (configurarea si campul TOTP din login) sunt tinute impreuna de poarta din
// test/run/porti.js. QR-ul venit de la server NU intra prin innerHTML: este pus intr-un <img> ca
// data-URI, context inert chiar daca generatorul SVG s-ar schimba.
export function render2FA() {
  const on = !!(USER && USER.twofa);
  const status = $('#twofaStatus');
  if (!status) return;
  status.className = 'status' + (on ? ' ok' : '');
  const recoveryCount = Number(USER && USER.twofaRecoveryCount) || 0;
  status.textContent = on ? ('✔ 2FA este activat pe contul tău. Coduri de rezervă disponibile: ' + recoveryCount + '.')
    : (USER && USER.twofaRequired
      ? '2FA este obligatorie pentru acest cont privilegiat. Restul aplicației rămâne blocat până la activare.'
      : '2FA este dezactivat.');
  const start = $('#twofaStart'); const setup = $('#twofaSetup'); const disable = $('#twofaDisableWrap'); const recoveryManage = $('#twofaRecoveryManage');
  if (start) start.classList.toggle('hidden', on);
  if (on && setup) setup.classList.add('hidden');
  if (disable) disable.classList.toggle('hidden', !on || (USER && USER.twofaMandatory));
  if (recoveryManage) recoveryManage.classList.toggle('hidden', !on);
}

function showRecoveryCodes(codes) {
  const box = $('#twofaRecovery'); const out = $('#twofaRecoveryCodes');
  if (!box || !out || !Array.isArray(codes) || !codes.length) return;
  out.value = codes.join('\n');
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function validSecondFactor(code) {
  const v = String(code || '').trim().toUpperCase();
  return /^\d{6}$/.test(v) || /^[A-Z2-9]{4}-?[A-Z2-9]{4}-?[A-Z2-9]{4}$/.test(v);
}
const twofaStart = $('#twofaStart');
twofaStart && twofaStart.addEventListener('click', async () => {
  try {
    const r = await api('/api/2fa/setup', { method: 'POST' });
    $('#twofaSecret').textContent = r.secret || '';
    $('#twofaQr').src = r.qrSvg ? ('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.qrSvg)) : '';
    $('#twofaQr').classList.toggle('hidden', !r.qrSvg);
    $('#twofaCode').value = '';
    $('#twofaSetup').classList.remove('hidden');
    $('#twofaCode').focus();
  } catch (e) { toast(e.message, true); }
});
const twofaEnable = $('#twofaEnable');
twofaEnable && twofaEnable.addEventListener('click', async () => {
  const code = $('#twofaCode').value.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return toast('Introdu codul de 6 cifre din aplicația de autentificare.', true);
  try {
    const r = await api('/api/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    toast('2FA activat. La următoarea autentificare vei introduce și codul din aplicație.');
    $('#twofaSetup').classList.add('hidden');
    await deps.init(); deps.onTab('cont');
    showRecoveryCodes(r.recoveryCodes);
  } catch (e) { toast(e.message, true); }
});
const twofaCancel = $('#twofaCancel');
twofaCancel && twofaCancel.addEventListener('click', () => {
  $('#twofaSetup').classList.add('hidden');
  $('#twofaCode').value = '';
});
const twofaDisable = $('#twofaDisable');
twofaDisable && twofaDisable.addEventListener('click', async () => {
  const code = $('#twofaDisCode').value.trim();
  if (!validSecondFactor(code)) return toast('Introdu un cod TOTP sau un cod de rezervă valid.', true);
  try { await api('/api/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }); $('#twofaDisCode').value = ''; $('#twofaRecovery')?.classList.add('hidden'); toast('2FA dezactivat'); await deps.init(); deps.onTab('cont'); }
  catch (e) { toast(e.message, true); }
});
const twofaRevoke = $('#twofaRevoke');
twofaRevoke && twofaRevoke.addEventListener('click', async () => {
  try { await api('/api/2fa/revoke-devices', { method: 'POST' }); toast('Dispozitivele de încredere au fost revocate'); }
  catch (e) { toast(e.message, true); }
});
const twofaRegenerate = $('#twofaRegenerate');
twofaRegenerate && twofaRegenerate.addEventListener('click', async () => {
  const code = $('#twofaRegenCode').value.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return toast('Regenerarea cere codul TOTP curent de 6 cifre.', true);
  try {
    const r = await api('/api/2fa/recovery-codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    $('#twofaRegenCode').value = '';
    await deps.init(); deps.onTab('cont'); showRecoveryCodes(r.recoveryCodes);
    toast('Codurile vechi au fost invalidate. Salvează noul set.');
  } catch (e) { toast(e.message, true); }
});
const twofaRecoveryCopy = $('#twofaRecoveryCopy');
twofaRecoveryCopy && twofaRecoveryCopy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#twofaRecoveryCodes').value); toast('Codurile au fost copiate.'); }
  catch (_) { toast('Copierea automată nu este disponibilă. Selectează și copiază manual codurile.', true); }
});
const twofaRecoveryDownload = $('#twofaRecoveryDownload');
twofaRecoveryDownload && twofaRecoveryDownload.addEventListener('click', () => {
  const blob = new Blob(['Coduri de rezervă Contabo 2FA\n\n' + $('#twofaRecoveryCodes').value + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = 'contabo-coduri-rezerva-2fa.txt'; a.click(); URL.revokeObjectURL(url);
});
const twofaRecoveryDone = $('#twofaRecoveryDone');
twofaRecoveryDone && twofaRecoveryDone.addEventListener('click', () => {
  $('#twofaRecovery').classList.add('hidden'); $('#twofaRecoveryCodes').value = '';
});

// ───────────────────────── BACKUP (admin) ─────────────────────────
export function continuityStatusHtml(c) {
  const x = c || {};
  const tests = x.tests || {}; const archive = tests.archive || {}; const pg = tests.nativeDatabase || {};
  const topology = x.topology || {};
  const objectives = x.objectives || {}; const rpo = objectives.rpo || {}; const rto = objectives.rto || {};
  const blockers = (((x.contractualHighAvailability || {}).blockers) || []).map((v) => `<li>${H(v)}</li>`).join('');
  const archiveLabel = archive.ready ? 'OK' : (archive.lastTestAt ? 'expirat/eșuat' : 'fără probă');
  const pgLabel = pg.applicable === false ? 'nu se aplică' : (pg.ready ? 'OK' : (pg.lastTestAt ? 'expirat/eșuat' : 'fără probă'));
  const rpoLabel = Number(rpo.assumedMinutes) === 1440 ? '24 h' : H(rpo.assumedMinutes || 1440) + ' minute';
  const appHa = x.applicationFailoverReady === true;
  const contractual = !!((x.contractualHighAvailability || {}).supported);
  const topologyLabel = appHa
    ? `${H(topology.processes)} instanțe · ${H(topology.hosts)} ${Number(topology.hosts) === 1 ? 'mașină' : 'mașini'} · failover activ–pasiv automat`
    : 'Un singur proces · o singură mașină · fără failover automat';
  return `<div class="notice ${appHa ? 'success' : 'warning'}" role="status"><span class="notice-icon">${appHa ? '✓' : '⚠️'}</span><div>
    <b>${H(x.label || 'Continuitate limitată — pilot și firme mici')}</b>
    <p>${topologyLabel}. <b>${contractual ? 'Cerințele HA contractuale declarate sunt confirmate.' : 'Nu există disponibilitate contractuală ridicată / SLA.'}</b></p>
    <p>Obiective operaționale asumate, necontractuale: <b>RPO ${rpoLabel}</b>
      la pierderea mașinii · <b>RTO ${H(rto.assumedMinutes || 30)} minute</b> end-to-end.</p>
    <p>Probe: restaurare arhivă ${H(archiveLabel)} · restaurare nativă PostgreSQL ${H(pgLabel)} ·
      copie offsite ${x.offsite && x.offsite.ready ? 'OK' : 'neconfirmată'}.</p>
    ${blockers ? `<details><summary>De ce nu este HA contractuală</summary><ul>${blockers}</ul></details>` : ''}
  </div></div>`;
}

export async function renderBackup() {
  if (!USER || USER.role !== 'admin') return;
  $('#backupCard').classList.remove('hidden');
  let b;
  try { b = await api('/api/backups'); } catch (e) { return; }
  $('#backupAuto').checked = b.auto;
  if ($('#continuityStatus')) $('#continuityStatus').innerHTML = continuityStatusHtml(b.continuity);
  const v = b.lastVerified;
  if (v) {
    const off = v.offsite || {};
    const pg = v.pgDrill || {};
    $('#backupStatus').textContent = 'Ultima arhivă completă verificată: ' + String(v.ts || '').replace('T', ' ').slice(0, 16)
      + ' · arhivă ' + (v.ok && v.drill && v.drill.ok ? 'OK' : 'CU EROARE')
      + ' · PG ' + (pg.ok ? 'OK' : (pg.sarit ? 'nu se aplică' : 'neverificat/eșuat'))
      + ' · offsite ' + (off.ok ? (off.encrypted ? 'OK, criptat' : 'OK, necriptat') : 'NECONFIRMAT');
  } else $('#backupStatus').textContent = b.lastAt ? ('Ultima copie DB: ' + b.lastAt.replace('T', ' ').slice(0, 16) + ' · nicio arhivă completă verificată raportată') : 'Niciun backup verificat încă.';
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
  if (!await confirmAction('Fișier: ' + file.name + '\n\nToate datele curente vor fi înlocuite și sesiunea va fi închisă.', {
    title: 'Restaurezi copia de siguranță?', confirmLabel: 'Restaurează și deloghează', danger: true,
  })) return;
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
    if (f.notifyAssignments) f.notifyAssignments.checked = p.notifyAssignments !== false;
    // datele personale: doar pentru abonati (necontabil = Start, contabil = Pro)
    const abonat = p.tip === 'necontabil' || p.tip === 'contabil';
    const pr0 = p.profil || {};
    // ...si pentru cine s-a inscris in LISTA DE CONTABILI: acolo numele, orasul si autorizatia NU
    // sunt date de facturare, ci chiar continutul anuntului. Ascunse dupa abonament, un contabil
    // aflat in proba aparea in lista doar cu numele de utilizator — adica un anunt fara identitate.
    const inLista = !!pr0.disponibilContabil;
    $('#profilPersonal').classList.toggle('hidden', !abonat && !inLista);
    $('#autorizatieRow').classList.toggle('hidden', p.tip !== 'contabil' && !inLista);
    const pr = p.profil || {};
    for (const k of ['numeComplet', 'telefon', 'adresa', 'oras', 'judet', 'autorizatie', 'descriere']) { if (f[k]) f[k].value = pr[k] || ''; }
    // CNP-ul vine MASCAT de la server (1900101******). Se afiseaza asa, ca dovada ca e completat;
    // la salvare, valoarea mascata e ignorata de server, deci re-salvarea altui camp nu il strica.
    if (f.cnp) f.cnp.value = pr.cnp || '';
    if (f.disponibilContabil) f.disponibilContabil.checked = !!pr.disponibilContabil;
    formFlowLoaded(f, 'profil', { restore: false });
  } catch (e) { /* */ }
}
// bifa deschide campurile pe loc: altfel ar trebui sa salvezi o data ca sa poti completa anuntul
$('#profileForm') && $('#profileForm').disponibilContabil && $('#profileForm').disponibilContabil.addEventListener('change', (ev) => {
  if (!ev.target.checked) return;
  $('#profilPersonal').classList.remove('hidden');
  $('#autorizatieRow').classList.remove('hidden');
});
$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const profil = {};
  for (const k of ['numeComplet', 'telefon', 'adresa', 'oras', 'judet', 'autorizatie', 'descriere']) { if (f[k]) profil[k] = f[k].value; }
  if (f.cnp) profil.cnp = f.cnp.value;
  if (f.disponibilContabil) profil.disponibilContabil = f.disponibilContabil.checked;
  try {
    await api('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      email: f.email.value, notifyDeadlines: f.notifyDeadlines.checked,
      notifyAssignments: f.notifyAssignments ? f.notifyAssignments.checked : true, profil,
    }) });
  } catch (err) { return toast(err.message, true); } // CNP invalid: mesajul serverului, nu o eroare tacuta
  formFlowSaved(f);
  toast('Profil salvat');
  renderProfile(); // reafiseaza CNP-ul mascat si reincarca lista de contabili daca s-a schimbat optiunea
  // Reincarcam meta dupa profil pentru ca mastile si indicatorii derivati sa ramana sincronizati.
  if (deps.init) await deps.init();
});
registerFormFlow({
  form: '#profileForm',
  title: 'Datele contului meu',
  firstStepTitle: 'Contact și identificare',
  companyKey: () => 'global',
  entityKey: 'profil',
  autosave: false,
  progressFields: ['email', 'cnp', 'numeComplet', 'telefon'],
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

const deleteAccountBtn = $('#deleteAccountBtn');
deleteAccountBtn && deleteAccountBtn.addEventListener('click', async () => {
  const confirmUsername = String($('#deleteAccountUsername').value || '').trim();
  const password = String($('#deleteAccountPassword').value || '');
  if (!confirmUsername || !password) return toast('Completează utilizatorul și parola curentă.', true);
  if (!await confirmAction('Contul, profilul, sesiunile și mesajele tale vor fi eliminate. Operațiunea nu poate fi anulată.', {
    title: 'Ștergi definitiv contul?', confirmLabel: 'Șterge definitiv', danger: true,
  })) return;
  try {
    await api('/api/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmUsername, password }) });
    location.href = '/';
  } catch (e) { toast(e.message, true); }
});

// ───────────────────────── SMTP (admin) ─────────────────────────
export async function renderSmtp() {
  if (!USER || USER.role !== 'admin') return;
  $('#smtpCard').classList.remove('hidden');
  let s;
  try { s = await api('/api/smtp'); } catch (e) { return; }
  const f = $('#smtpForm');
  f.host.value = s.host || ''; f.port.value = s.port || 587; f.secure.checked = !!s.secure; f.user.value = s.user || ''; f.from.value = s.from || '';
  if (f.notifyNewMessage) f.notifyNewMessage.checked = s.notifyNewMessage !== false;
  $('#smtpStatus').className = 'status' + (s.configured ? ' ok' : ' err');
  $('#smtpStatus').textContent = s.configured
    ? '✔ SMTP configurat (' + s.host + ')'
    : '⚠ SMTP necompletat — aplicația nu trimite emailuri: resetarea parolei NU funcționează, iar invitațiile se dau ca link copiat manual.';
}
// Proba de trimitere: raspunsul serverului poarta eroarea REALA de la serverul de mail
// („autentificare respinsa", „gazda inaccesibila"), fiindca cere remedii diferite. Testul
// foloseste datele SALVATE, deci se apasa dupa „Salvează SMTP" — altfel ar testa altceva
// decat ce va folosi aplicatia.
$('#smtpTest') && $('#smtpTest').addEventListener('click', async () => {
  const b = $('#smtpTest'); const st = $('#smtpStatus');
  b.disabled = true; const textVechi = b.textContent; b.textContent = 'Se trimite…';
  try {
    const r = await api('/api/smtp/test', { method: 'POST' });
    st.className = 'status ok';
    st.textContent = '✔ Email de test trimis către ' + r.to + '. Dacă ajunge, serverul de email e configurat corect.';
    toast('Email de test trimis către ' + r.to);
  } catch (e) {
    st.className = 'status err';
    st.textContent = '⚠ ' + e.message;
    toast(e.message, true);
  } finally { b.disabled = false; b.textContent = textVechi; }
});
$('#smtpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { host: f.host.value, port: f.port.value, secure: f.secure.checked, user: f.user.value, from: f.from.value, notifyNewMessage: f.notifyNewMessage ? f.notifyNewMessage.checked : true };
  if (f.pass.value) body.pass = f.pass.value;
  await api('/api/smtp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  f.pass.value = ''; renderSmtp(); toast('Setări SMTP salvate');
});
// ── FiscalRuleSet-uri append-only (admin) ──
export async function renderFiscal() {
  if (!USER || USER.role !== 'admin') return;
  $('#fiscalCard').classList.remove('hidden');
  const f = $('#fiscalForm');
  // Configurația este globală, dar panoul se poate reranda la navigare. Ultimele taste intrate
  // trebuie fixate în ciornă înainte ca răspunsul serverului să repopuleze controalele.
  formFlowFlush(f);
  let c; try { c = await api('/api/fiscal-config'); } catch (e) { return; }
  const active = c.current || {}; const rates = active.rates || {};
  if (f.baseRuleSetId) {
    f.baseRuleSetId.innerHTML = (c.ruleSets || []).slice().reverse().map((r) =>
      `<option value="${H(r.id)}">${H(r.id)} · ${H(r.validFrom)}…${H(r.validTo || '∞')} · ${H(String(r.hash || '').slice(0, 12))}</option>`).join('');
    if (active.id) f.baseRuleSetId.value = active.id;
  }
  // Valorile de bază se arată ca placeholder, nu ca valori trimise: corpul publicării conține
  // numai diferențele asumate de administrator.
  Object.keys(rates).forEach((k) => { if (f[k]) { f[k].value = ''; f[k].placeholder = String(rates[k]); } });
  formFlowLoaded(f, 'config:fiscal');
  // Semnal de vechime: cotele implicite sunt fixate pentru un an fiscal si trebuie revizuite la lege.
  const vn = $('#fiscalVechime');
  if (vn) {
    const v = c.vechime || {};
    vn.innerHTML = v.stale
      ? `<div class="notice warning"><span class="notice-icon">⚠️</span><div>Registrul acoperă până în <b>${v.coveredUntil || v.an}</b>, iar anul curent este <b>${v.anCurent}</b>. Calculele din afara acoperirii sunt oprite.</div></div>`
      : (v.an ? `<p class="muted">Registru acoperit până în <b>${v.an}</b>. Hash: <code>${H(String(c.registryHash || '').slice(0, 16))}</code>.</p>` : '');
  }
}
$('#fiscalForm') && $('#fiscalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { baseRuleSetId: f.baseRuleSetId.value, validFrom: f.validFrom.value,
    validTo: f.validTo.value || null, approvalId: f.approvalId.value,
    legalSources: [{ title: f.legalSourceTitle.value, url: f.legalSourceUrl.value }], rates: {} };
  [...f.elements].forEach((el) => {
    if (el.name && !(new Set(['baseRuleSetId', 'validFrom', 'validTo', 'approvalId', 'legalSourceTitle', 'legalSourceUrl'])).has(el.name)
        && el.value !== '') body.rates[el.name] = Number(el.value);
  });
  try {
    await api('/api/fiscal-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    formFlowSaved(f);
    $('#fiscalStatus').className = 'status ok'; $('#fiscalStatus').textContent = 'Versiune publicată și sigilată cu hash.';
    f.reset(); await renderFiscal(); setMeta(await api('/api/meta')); toast('Versiune fiscală publicată');
  }
  catch (err) { $('#fiscalStatus').className = 'status err'; $('#fiscalStatus').textContent = err.message; }
});
registerFormFlow({
  form: '#fiscalForm',
  title: 'Publicare versiune fiscală',
  firstStepTitle: 'Contribuții și impozit pe venit',
  companyKey: () => 'global',
  entityKey: 'config:fiscal',
  progressFields: ['cas', 'cass', 'impozitVenit', 'cam', 'tvaStandard', 'tvaRedus', 'impozitProfit',
    'impozitMicro', 'impozitDividende', 'plafonMicroEur', 'cursPlafonMicro', 'salariuMinimS1',
    'salariuMinimS2', 'salariuMinimConstructii', 'plafonScutire', 'deductibilitateTvaAutoLimitat'],
  onDiscard: () => renderFiscal(),
});

// ── Pachetul Windows (Contabo pe calculatorul tau) ───────────────────────────
// Manifestul e un fisier STATIC (public/descarcari/pachet.json), scris de
// scripts/pachet-windows.sh. Fara ruta de API dinadins: nu e nimic de autorizat, iar o instalare
// in care pachetul nu a fost construit trebuie sa ASCUNDA butonul, nu sa ofere un link mort —
// lipsa manifestului e chiar semnalul, si nu cere niciun cod in plus.
// ── Videoul de prezentare ────────────────────────────────────────────────────
// Acelasi tipar ca la pachetul Windows: fisier STATIC + manifest, fara ruta de API. Nu e nimic de
// autorizat (linkul e public prin constructie, ca orice din public/), iar lipsa manifestului e
// chiar semnalul ca filmul nu e publicat pe instalarea asta.
export async function renderVideo() {
  const card = $('#videoCard'); if (!card) return;
  const lipsa = $('#videoLipsa');
  let m;
  try {
    const r = await fetch('/descarcari/video.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('lipsa');
    m = await r.json();
  } catch (e) {
    // Pagina nu ramane goala: un ecran fara nimic pe el se citeste ca „stricat", nu ca „nu se aplica".
    card.classList.add('hidden');
    if (lipsa) lipsa.classList.remove('hidden');
    return;
  }
  card.classList.remove('hidden');
  if (lipsa) lipsa.classList.add('hidden');
  const v = $('#videoPlayer');
  // `src` se pune DIN MANIFEST, nu din HTML: altfel browserul ar cere fisierul (si ar loga un 404)
  // pe fiecare instalare unde filmul nu e publicat.
  if (v && v.getAttribute('src') !== m.fisier) {
    v.setAttribute('src', m.fisier);
    if (m.poster) v.setAttribute('poster', m.poster);
  }
  $('#videoDownload').href = m.fisier;
  const mb = (Number(m.octeti) || 0) / 1048576;
  $('#videoInfo').innerHTML = `Durata <b>${H(m.durata || '—')}</b> · ${H(m.rezolutie || '')} · ${mb.toFixed(0)} MB`
    + (m.data ? ` · înregistrat ${H(m.data)}` : '');
  const link = location.origin + m.fisier;
  $('#videoLink').value = link;
  const buton = $('#videoCopy');
  if (buton && !buton.dataset.legat) {
    buton.dataset.legat = '1';
    buton.addEventListener('click', async () => {
      // clipboard-ul cere context sigur si permisiune; pe esec, selectam textul ca sa poata fi copiat manual
      try { await navigator.clipboard.writeText($('#videoLink').value); toast('Link copiat'); }
      catch (e) { $('#videoLink').select(); toast('Apasă Ctrl+C ca să copiezi linkul', true); }
    });
  }
}

export async function renderPachetWin() {
  const card = $('#pachetWinCard'); if (!card) return;
  let m;
  try {
    const r = await fetch('/descarcari/pachet.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('lipsa');
    m = await r.json();
  } catch (e) {
    // Pachetul nu e construit pe aceasta instalare. Cardul dispare, dar pagina NU ramane goala:
    // un ecran fara nimic pe el se citeste ca „stricat", nu ca „nu se aplica aici".
    card.classList.add('hidden');
    const l = $('#pachetWinLipsa'); if (l) l.classList.remove('hidden');
    return;
  }
  card.classList.remove('hidden');
  const l = $('#pachetWinLipsa'); if (l) l.classList.add('hidden');
  // Descarcarea e oprita cat timp pachetul e in dezvoltare: butonul ramane la vedere (ca sa se stie
  // ca vine), dar spune limpede de ce nu da nimic. Legatura se face o singura data (`legat`),
  // fiindca renderPachetWin ruleaza la fiecare intrare in tab.
  const buton = $('#pachetWinBtn');
  if (buton && !buton.dataset.legat) {
    buton.dataset.legat = '1';
    buton.addEventListener('click', () => { alertAction('Pachetul pentru Windows este încă în dezvoltare.', { title: 'Funcție indisponibilă' }); });
  }
  const mb = (Number(m.octeti) || 0) / 1048576;
  // Amprenta se arata trunchiata, dar INTREAGA in `title`: cine vrea s-o verifice cu
  // `Get-FileHash` o poate copia, fara ca randul sa devina ilizibil pentru restul.
  $('#pachetWinInfo').innerHTML = `Versiunea <b>${H(m.versiune || '—')}</b> · ${mb.toFixed(0)} MB · Node ${H(m.node || '—')}`
    + (m.sha256 ? ` · <span title="SHA-256: ${H(m.sha256)}">amprentă ${H(String(m.sha256).slice(0, 12))}…</span>` : '');
}
