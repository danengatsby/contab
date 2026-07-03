'use strict';

// Mesagerie de suport user <-> admin. Model simplu: un singur "thread" per utilizator non-admin,
// in care utilizatorul si administratorul schimba mesaje. Functii pure (fara I/O) — usor de testat.
// Un mesaj: { id, userId, fromAdmin, text, author, createdAt, readByUser, readByAdmin }
//   userId    = utilizatorul (non-admin) caruia ii apartine conversatia
//   fromAdmin = true daca l-a scris administratorul (raspuns), false daca l-a scris utilizatorul

const MAX_LEN = 4000;

/** Construieste un mesaj nou (cu starea de citire potrivita expeditorului). */
function newMessage(id, userId, fromAdmin, text, author, attachment) {
  const t = String(text == null ? '' : text).trim().slice(0, MAX_LEN);
  const m = {
    id,
    userId,
    fromAdmin: !!fromAdmin,
    text: t,
    author: author || '',
    createdAt: new Date().toISOString(),
    // expeditorul si-a "citit" propriul mesaj; destinatarul nu inca
    readByUser: !fromAdmin,
    readByAdmin: !!fromAdmin,
  };
  if (attachment && attachment.storedName) {
    m.attachment = {
      name: String(attachment.name || 'fisier'),
      storedName: String(attachment.storedName),
      size: Number(attachment.size) || 0,
      mime: String(attachment.mime || ''),
    };
  }
  return m;
}

const byTime = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

/** Conversatia unui utilizator, cronologic. */
function thread(list, userId) {
  return (list || []).filter((m) => m.userId === userId).slice().sort(byTime);
}

/** Cate mesaje necitite are utilizatorul (raspunsuri de la admin). */
function unreadForUser(list, userId) {
  return (list || []).filter((m) => m.userId === userId && m.fromAdmin && !m.readByUser).length;
}

/** Cate mesaje necitite are administratorul (cereri de la utilizatori), in toate conversatiile. */
function unreadForAdmin(list) {
  return (list || []).filter((m) => !m.fromAdmin && !m.readByAdmin).length;
}

/** Sumar pe conversatii pentru inbox-ul adminului: ultimul mesaj + nr. necitite, cele mai recente sus. */
function threadsSummary(list, users) {
  const byUser = new Map();
  for (const m of (list || [])) {
    if (!byUser.has(m.userId)) byUser.set(m.userId, []);
    byUser.get(m.userId).push(m);
  }
  const out = [];
  for (const [uid, msgs] of byUser) {
    const sorted = msgs.slice().sort(byTime);
    const last = sorted[sorted.length - 1];
    const u = (users || []).find((x) => x.id === uid);
    out.push({
      userId: uid,
      username: u ? u.username : ('#' + uid),
      lastText: last.text,
      lastFromAdmin: last.fromAdmin,
      lastAt: last.createdAt,
      unread: sorted.filter((m) => !m.fromAdmin && !m.readByAdmin).length,
      total: sorted.length,
      archived: !!(u && u.supportArchived),
    });
  }
  return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/** Cautare in conversatii (admin): dupa nume de utilizator sau text de mesaj. */
function searchThreads(list, users, q) {
  const needle = String(q == null ? '' : q).trim().toLowerCase();
  if (!needle) return threadsSummary(list, users);
  const byUser = new Map();
  for (const m of (list || [])) { if (!byUser.has(m.userId)) byUser.set(m.userId, []); byUser.get(m.userId).push(m); }
  const out = [];
  for (const t of threadsSummary(list, users)) {
    const nameHit = t.username.toLowerCase().includes(needle);
    const hit = (byUser.get(t.userId) || []).find((m) => (m.text || '').toLowerCase().includes(needle));
    if (nameHit || hit) out.push(hit ? Object.assign({}, t, { match: hit.text }) : t);
  }
  return out;
}

/**
 * Marcheaza ca citite mesajele dintr-o conversatie pentru o parte.
 * who='user'  -> raspunsurile adminului devin citite (utilizatorul deschide conversatia)
 * who='admin' -> cererile utilizatorului devin citite (adminul deschide conversatia)
 * @returns numarul de mesaje marcate
 */
function markRead(list, userId, who) {
  let n = 0;
  for (const m of (list || [])) {
    if (m.userId !== userId) continue;
    if (who === 'user' && m.fromAdmin && !m.readByUser) { m.readByUser = true; n++; }
    if (who === 'admin' && !m.fromAdmin && !m.readByAdmin) { m.readByAdmin = true; n++; }
  }
  return n;
}

module.exports = { newMessage, thread, unreadForUser, unreadForAdmin, threadsSummary, searchThreads, markRead, MAX_LEN };
