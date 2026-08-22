'use strict';

// Fotografiile statelor de plata sunt documente de audit, nu un cache care se suprascrie.
// Un stat corectat produce o fotografie noua; cea veche ramane legata de articolul stornat si
// este exclusa din calcule. Modulul tine aceasta regula intr-un singur loc, ca registrul anual,
// D112, concediile si plafoanele anuale sa nu aleaga fiecare alta versiune a aceleiasi luni.

function fidOf(x) {
  return x && x.firmaId != null ? Number(x.firmaId) : null;
}

function sameFirma(a, b) {
  const fa = fidOf(a); const fb = fidOf(b);
  return fa == null || fb == null ? fa === fb : fa === fb;
}

function entriesForSnapshot(snapshot, entries) {
  return (entries || []).filter((e) => e && e.tip === 'stat_plata'
    && sameFirma(e, snapshot) && String(e.period || '').slice(0, 7) === String(snapshot.period || ''));
}

/**
 * O fotografie este activa daca nu a fost stornata/suprascrisa si articolul legat nu este
 * stornat. Pentru fotografiile istorice fara `entryId`, existenta numai a unor articole stornate
 * in aceeasi luna este suficienta ca sa nu mai prezentam statul vechi drept activ.
 */
function isActive(snapshot, entries) {
  if (!snapshot || snapshot.stornat || snapshot.supersededBy) return false;
  if (!Array.isArray(entries)) return true;
  if (snapshot.entryId) {
    const linked = entries.find((e) => e && e.id === snapshot.entryId);
    // O fotografie v3 fara articolul ei nu mai este dovada unei postari. Cazul apare la un import
    // partial/corupt; tratarea lui ca activ ar permite D112 si fluturasi finali fara nota 641=421.
    return !!linked && linked.tip === 'stat_plata' && !linked.stornat;
  }
  const samePeriod = entriesForSnapshot(snapshot, entries);
  return !samePeriod.length || samePeriod.some((e) => !e.stornat);
}

/** Ultima fotografie activa per firma+luna; dublurile istorice nu dubleaza registrele. */
function activeSnapshots(history, entries) {
  const byPeriod = new Map();
  for (const h of history || []) {
    if (!isActive(h, entries)) continue;
    const key = String(fidOf(h)) + '|' + String(h.period || '');
    byPeriod.set(key, h); // append-only: ultima revizie activa castiga
  }
  return [...byPeriod.values()];
}

function activeSnapshot(history, period, entries) {
  const p = String(period || '');
  let found = null;
  for (const h of activeSnapshots(history, entries)) if (String(h.period || '') === p) found = h;
  return found;
}

/** Marcheaza fotografia corespunzatoare articolului salarial care tocmai a fost stornat. */
function markStornat(history, entry, storno) {
  if (!entry || entry.tip !== 'stat_plata') return null;
  const candidates = (history || []).filter((h) => sameFirma(h, entry)
    && String(h.period || '') === String(entry.period || '') && !h.stornat && !h.supersededBy);
  let h = candidates.find((x) => x.entryId === entry.id) || candidates[candidates.length - 1];
  if (!h) return null;
  if (!h.entryId) h.entryId = entry.id; // legatura pentru fotografiile v2 create inaintea migrarii
  h.stornat = true;
  h.stornoBy = storno && storno.id;
  h.stornoData = storno && storno.data;
  h.stornatAt = new Date().toISOString();
  return h;
}

/**
 * La repostare pastram revizia veche, dar o scoatem explicit din calcule. Acopera si importurile
 * istorice care au fotografie, dar nu au articol contabil legat.
 */
function supersedePeriod(history, firmaId, period, replacementEntry) {
  const fid = Number(firmaId); const p = String(period || '');
  const changed = [];
  for (const h of history || []) {
    if (Number(h.firmaId) !== fid || String(h.period || '') !== p || h.stornat || h.supersededBy) continue;
    if (replacementEntry && h.entryId === replacementEntry.id) continue;
    h.supersededBy = replacementEntry && replacementEntry.id;
    h.supersededAt = new Date().toISOString();
    changed.push(h);
  }
  return changed;
}

module.exports = { activeSnapshots, activeSnapshot, isActive, markStornat, supersedePeriod };
