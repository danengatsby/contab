'use strict';
// Modul de mesagerie (suport user <-> admin): firul de chat, inbox-ul de admin, cautare,
// arhivare, atasamente, notificari (badge/titlu/sunet), indicator „scrie acum" si polling
// aproape in timp real. Extras din app.js (Etapa 1 a modularizarii). Depinde doar de nucleu.
import { $, $$, api, toast, USER, escMsg, escAttr, withCsrf, confirmAction, uiLocale } from './core.js';

function fmtMsgTime(iso) {
  try { return new Date(iso).toLocaleString(uiLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
}
function fmtSize(b) { b = Number(b) || 0; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
// randeaza atasamentul: imaginile raster inline (thumbnail), restul ca buton de descarcare.
// Numele fisierului vine de la incarcator (req.file.originalname) si NU e sanitizat pe server,
// deci in ATRIBUTE se escapeaza cu escAttr, nu cu escMsg: escMsg nu atinge ghilimelele, iar un
// nume ca `x" onerror="…` ar fi inchis atributul alt si ar fi adaugat altele. CSP (script-src
// 'self', fara unsafe-inline) opreste executia, dar escaparea e stratul care nu trebuie sa cada
// primul — mesajele vin de la utilizatori si sunt citite de administrator.
function attachHtml(m) {
  if (!m.attachment) return '';
  const a = m.attachment; const url = '/api/messages/' + encodeURIComponent(m.id) + '/file';
  const isImg = /^image\/(png|jpe?g|gif|webp)$/i.test(a.mime || '');
  if (isImg) return `<a class="msg-img" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escAttr(a.name)}" loading="lazy"></a>`;
  return `<a class="filechip" href="${url}" target="_blank" rel="noopener">📎 <span class="fn">${escMsg(a.name)}</span> <span class="fsize">${fmtSize(a.size)}</span></a>`;
}
// escMsg / escAttr sunt importate din core.js (partajate cu galeriile din app.js)
// o bula de chat; „mine” (dreapta) = mesajul scris de partea care priveste (admin sau user)
function bubble(m, viewerIsAdmin) {
  const mine = viewerIsAdmin ? m.fromAdmin : !m.fromAdmin;
  const who = m.fromAdmin ? 'Administrator' : (m.author || 'Utilizator');
  const txt = m.text ? escMsg(m.text).replace(/\n/g, '<br>') : '';
  const del = viewerIsAdmin ? `<button type="button" class="msg-del" data-id="${escAttr(m.id)}" title="Șterge mesajul">✕</button>` : '';
  // editarea: doar autorul (mesajul „mine”)
  const edit = mine ? `<button type="button" class="msg-edit" data-id="${escAttr(m.id)}" data-text="${escAttr(m.text || '')}" title="Editează">✎</button>` : '';
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

export async function loadMessages() {
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
  if (!list.length) { box.innerHTML = '<p class="muted">' + (MSG_SEARCH_Q ? 'Niciun rezultat pentru căutare.' : 'Nicio conversație. Utilizatorii îți pot scrie din „Unelte → Mesaje".') + '</p>'; return; }
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
    if (!await confirmAction('Mesajul nu va mai putea fi recuperat.', { title: 'Ștergi mesajul?', confirmLabel: 'Șterge definitiv', danger: true })) return;
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
export function setMsgBadge(n) {
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
// applySessionState (app.js) initializeaza contorul de necitite din starea de sesiune.
export function setLastUnread(n) { lastUnread = n; }
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
export function startMsgPolling() { if (MSG_POLL) clearInterval(MSG_POLL); pollTick = 0; MSG_POLL = setInterval(chatPoll, 3000); }
// trimite „scrie acum…” catre cealalta parte (throttled)
let lastTypingPing = 0;
function pingTyping() {
  if (isAdminView() && !MSG_ADMIN_TARGET) return;
  const now = Date.now(); if (now - lastTypingPing < 2500) return; lastTypingPing = now;
  const body = isAdminView() ? JSON.stringify({ userId: MSG_ADMIN_TARGET }) : '{}';
  // fetch DIRECT (fara api(): e o cerere de fundal care nu trebuie sa aprinda bara de incarcare)
  // — dar tot mutanta, deci trece prin withCsrf ca sa poarte antetul X-CSRF-Token.
  fetch('/api/messages/typing', withCsrf({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).catch(() => {});
}

// Exportate pentru testele unitare de frontend (randarea firului de chat, escapare): test/frontend.mjs
export { bubble, attachHtml, fmtSize };
