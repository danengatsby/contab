'use strict';

// Service layer pentru mesageria de suport: trimitere (cu rezolvarea destinatarului si
// redeschiderea conversatiei arhivate), citirea firelor (cu marcarea ca citit), accesul la
// atasamente, editare/stergere, arhivare si notificarea adminilor pe email. Rutele
// (src/routes/messages.js) raman puncte de intrare subtiri. src/messages.js ramane modulul
// PUR (fara I/O) — aici stau doar operatiile care scriu in baza sau ating discul.
//
// Mesajele nu sunt legate de firma, ci de utilizator; autorizarea nu trece prin reqFirma,
// ci printr-un `actor` { user, isAdmin } construit de ruta (isAdmin = rol admin fara
// impersonare). Regulile de acces (fisier, editare) sunt impuse aici, nu doar in ruta.

const path = require('path');
const fs = require('fs');
const db = require('./db');
const log = require('./log');
const messages = require('./messages');
const presence = require('./presence');
const { capList } = require('./paginate');
const { sendMail } = require('./notify');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

// Servire atasament: doar tipuri sigure inline; restul ca attachment.
const INLINE_OK = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'application/pdf']);

// ── Plafon de RETENTIE pe CONVERSATIE ──────────────────────────────────────────────────────────
// Graful bazei sta in RAM prin design si fiecare db.save() costa O(colectie), deci o colectie care
// creste nemarginit degradeaza intreg procesul, nu doar ruta ei. `audit` avea deja plafon
// (AUDIT_MAX din server.js); `messages` era singura colectie vie ramasa fara niciunul.
//
// De ce PE CONVERSATIE si nu global: un plafon global lasa o conversatie zgomotoasa sa evacueze
// istoricul de suport al tuturor celorlalti. Per conversatie, totalul e marginit natural de
// (utilizatori x plafon) si se pastreaza exact ce foloseste suportul — contextul recent.
//
// Spre deosebire de audit, mesajele NU au proba durabila pe disc, deci taierea chiar pierde date:
// de aceea plafonul e generos (o conversatie de suport de 500 de mesaje e deja patologica), se
// LOGHEAZA, si duce cu ea si atasamentul de pe disc — altfel ar ramane fisiere orfane in uploads.
const THREAD_MAX = Number(process.env.CONTAB_MESSAGES_MAX) || 500;

/** Taie cele mai vechi mesaje din conversatia unui utilizator peste plafon. @returns cate a sters */
function pruneThread(d, userId) {
  const idx = [];
  for (let i = 0; i < d.messages.length; i++) if (d.messages[i].userId === userId) idx.push(i);
  const over = idx.length - THREAD_MAX;
  if (over <= 0) return 0;
  // `d.messages` creste prin push, deci ordinea indicilor E ordinea cronologica: primii ies primii
  const drop = new Set(idx.slice(0, over));
  const removed = d.messages.filter((_, i) => drop.has(i));
  d.messages = d.messages.filter((_, i) => !drop.has(i));
  for (const m of removed) {
    if (m.attachment && m.attachment.storedName) {
      try { fs.unlinkSync(path.join(db.UPLOAD_DIR, path.basename(m.attachment.storedName))); } catch (_) { /* best-effort */ }
    }
  }
  log.warn('conversatie plafonata (retentie mesaje)', log.ctx(null, { userId, sterse: removed.length, cap: THREAD_MAX }));
  return removed.length;
}

/** Inbox-ul actorului: adminul vede sumarul conversatiilor, utilizatorul propriul fir
 *  (deschiderea marcheaza raspunsurile adminului ca citite). */
function inbox(actor) {
  const d = db.get(); d.messages = d.messages || [];
  if (actor.isAdmin) {
    const s = capList(messages.threadsSummary(d.messages, d.users), 0, 'messages.threads');
    return { admin: true, threads: s.items, threadsTotal: s.total, threadsTruncated: s.truncated };
  }
  const changed = messages.markRead(d.messages, actor.user.id, 'user');
  if (changed) db.save();
  // `thread` ramane ARRAY (contractul frontendului: public/messages.js face .map/.length pe el);
  // totalul si semnalul de trunchiere vin alaturi, nu in locul lui.
  const t = capList(messages.thread(d.messages, actor.user.id), THREAD_MAX, 'messages.thread');
  return { admin: false, thread: t.items, threadTotal: t.total, threadTruncated: t.truncated };
}

/** Conversatia unui utilizator, pentru admin (deschiderea marcheaza cererile ca citite). */
function threadForAdmin(userId) {
  const d = db.get(); d.messages = d.messages || [];
  const uid = Number(userId);
  const u = d.users.find((x) => x.id === uid);
  if (!u) fail(404, 'Utilizator inexistent.');
  const changed = messages.markRead(d.messages, uid, 'admin');
  if (changed) db.save();
  const t = capList(messages.thread(d.messages, uid), THREAD_MAX, 'messages.thread');
  return {
    userId: uid, username: u.username, archived: !!u.supportArchived,
    thread: t.items, threadTotal: t.total, threadTruncated: t.truncated,
  };
}

/** Trimite un mesaj: utilizatorul catre admin (redeschide conversatia arhivata), adminul
 *  catre un utilizator ales. `att` e atasamentul deja salvat de multer (sau null). */
function sendMessage(actor, body, att) {
  const d = db.get(); d.messages = d.messages || [];
  const text = String((body || {}).text || '').trim();
  if (!text && !att) fail(400, 'Scrie un mesaj sau ataseaza un fisier.');
  if (text.length > messages.MAX_LEN) fail(400, 'Mesaj prea lung (max ' + messages.MAX_LEN + ' caractere).');
  let userId; let fromAdmin;
  if (actor.isAdmin) {
    userId = Number((body || {}).userId);
    if (!d.users.find((x) => x.id === userId)) fail(400, 'Alege un utilizator destinatar.');
    fromAdmin = true;
  } else {
    userId = actor.user.id; fromAdmin = false;
  }
  // un mesaj nou de la utilizator redeschide automat conversatia arhivata
  if (!fromAdmin) { const tu = d.users.find((x) => x.id === userId); if (tu && tu.supportArchived) tu.supportArchived = false; }
  const m = messages.newMessage(db.nextId('msg'), userId, fromAdmin, text, actor.user.username, att);
  d.messages.push(m);
  pruneThread(d, userId);
  db.save();
  return { message: m, fromAdmin, userId };
}

/** Verifica accesul la atasament si intoarce ce ii trebuie rutei ca sa-l serveasca
 *  (calea pe disc, numele, mime-ul si daca e sigur inline). */
function attachmentFile(actor, id) {
  const d = db.get();
  const m = (d.messages || []).find((x) => x.id === id);
  if (!m || !m.attachment) fail(404, 'Atasament inexistent.');
  if (!actor.isAdmin && m.userId !== actor.user.id) fail(403, 'Nu ai acces la acest fisier.');
  const p = path.join(db.UPLOAD_DIR, path.basename(m.attachment.storedName));
  if (!fs.existsSync(p)) fail(404, 'Fisier negasit pe server.');
  const mime = String(m.attachment.mime || '').toLowerCase();
  return { path: p, name: m.attachment.name, mime, inline: INLINE_OK.has(mime) };
}

/** Sterge un mesaj (admin) si fisierul atasat de pe disc (best-effort). */
function deleteMessage(id) {
  const d = db.get(); d.messages = d.messages || [];
  const idx = d.messages.findIndex((m) => m.id === id);
  if (idx < 0) fail(404, 'Mesaj inexistent.');
  const [removed] = d.messages.splice(idx, 1);
  if (removed.attachment && removed.attachment.storedName) {
    try { fs.unlinkSync(path.join(db.UPLOAD_DIR, path.basename(removed.attachment.storedName))); } catch (_) { /* best-effort */ }
  }
  db.save();
  return { removed };
}

/** Editeaza un mesaj: adminul propriile raspunsuri, utilizatorul propriile cereri. */
function editMessage(actor, id, text) {
  const d = db.get(); d.messages = d.messages || [];
  const m = (d.messages || []).find((x) => x.id === id);
  if (!m) fail(404, 'Mesaj inexistent.');
  const canEdit = actor.isAdmin ? m.fromAdmin : (!m.fromAdmin && m.userId === actor.user.id);
  if (!canEdit) fail(403, 'Poti edita doar propriile mesaje.');
  const t = String(text || '').trim();
  if (!t && !m.attachment) fail(400, 'Mesajul nu poate ramane gol.');
  if (t.length > messages.MAX_LEN) fail(400, 'Mesaj prea lung (max ' + messages.MAX_LEN + ' caractere).');
  m.text = t; m.editedAt = new Date().toISOString();
  db.save();
  return { message: m };
}

/** Arhiveaza / redeschide conversatia unui utilizator (admin). */
function archiveThread(userId, archived) {
  const d = db.get();
  const u = d.users.find((x) => x.id === Number(userId));
  if (!u) fail(404, 'Utilizator inexistent.');
  u.supportArchived = !!archived;
  db.save();
  return { archived: u.supportArchived, username: u.username };
}

/** Notificare pe email a administratorilor la un mesaj nou de la utilizator (best-effort):
 *  doar cand SMTP e configurat, niciun admin nu e online si nu suntem in cooldown. */
function notifyAdminsOfNewMessage(fromUser, message, baseUrl) {
  const d = db.get();
  const smtp = d.settings.smtp;
  if (!smtp || !smtp.host || smtp.notifyNewMessage === false) return;
  const now = Date.now();
  const admins = presence.adminsToEmail(d.users, now);
  if (!admins.length) return;
  const snippet = String(message.text || (message.attachment ? '[fisier atasat]' : '')).slice(0, 300);
  const subject = 'Contabo — mesaj nou de la ' + (fromUser.username || 'un utilizator');
  const body = (fromUser.username || 'Un utilizator') + ' ti-a trimis un mesaj in Contabo:\n\n' + snippet
    + '\n\nIntra in aplicatie pentru a raspunde:\n' + (baseUrl || '')
    + '\n\n(Primesti cel mult o notificare la ' + Math.round(presence.SUPPORT_EMAIL_COOLDOWN / 60000)
    + ' min. O poti dezactiva din Setari → SMTP.)';
  for (const a of admins) {
    a.lastSupportEmailAt = now;
    sendMail(smtp, a.email, subject, body).catch((e) => console.error('SMTP mesaj nou:', e.message));
  }
  db.save();
}

module.exports = {
  inbox, threadForAdmin, sendMessage, attachmentFile,
  deleteMessage, editMessage, archiveThread, notifyAdminsOfNewMessage,
  THREAD_MAX,
};
