'use strict';

// Reconciliere e-Factura PRIMITE (inbox SPV) <-> jurnal de cumparari. Inchide simetria fata de
// reconcilierea e-TVA pe VANZARI (reporting.tvaReconciliation): prinde facturile pe care ANAF le
// vede in SPV dar nu sunt inregistrate in contabilitate (TVA deductibila pierduta / jurnal incomplet).
//
// CONSTRANGERE de date: lista de mesaje SPV (listaMesajeFactura) da doar CIF-ul emitentului + data
// + id-ul mesajului — NU numarul/suma facturii (acelea cer descarcarea fiecarui ZIP). Deci potrivirea
// exacta se face pe facturile deja IMPORTATE din SPV (`spvImport.msgId`), iar restul se reconciliaza
// COUNT-BASED per furnizor (cate facturi vede SPV vs cate sunt in jurnal de la acel CIF). E robust si
// exact ce ii trebuie contabilului pentru e-TVA: "ce furnizori au facturi in SPV neinregistrate".

const { round2 } = require('./util');
const acc = require('./accounting');

const nCif = (c) => String(c || '').replace(/^ro/i, '').replace(/\D/g, '');

/** Cumpararile din jurnal: articole postate care cresc datoria pe 401 (net creditor) cu furnizor. */
function journalPurchases(view) {
  const out = [];
  for (const e of acc.postedEntries(view)) {
    if (!e.partenerCui) continue;
    let net = 0;
    for (const l of e.lines) { if (l.credit === '401') net = round2(net + l.suma); if (l.debit === '401') net = round2(net - l.suma); }
    if (net > 0) out.push({ id: e.id, data: e.data, partenerCui: e.partenerCui, document: e.document || '', suma: net, spvImportMsgId: (e.spvImport && e.spvImport.msgId) || null });
  }
  return out;
}

/**
 * Reconciliaza mesajele SPV (facturi primite) cu cumpararile din jurnal.
 * @param {Array} inbox - [{ id, data, cif, importat }] (din anafService.inbox)
 * @param {Array} purchases - [{ id, data, partenerCui, document, suma, spvImportMsgId }]
 * @param {Object} [nameByCif] - harta CIF->denumire pentru afisare
 * @returns rezumat per furnizor + listele de neinregistrate / fara corespondent SPV
 */
function reconcileInbox(inbox, purchases, nameByCif) {
  const name = (cif) => (nameByCif && nameByCif[cif]) || '';
  const byDate = (a, b) => (String(a.data) < String(b.data) ? -1 : String(a.data) > String(b.data) ? 1 : 0);
  const msgs = (inbox || []).map((m) => ({ msgId: m.id, data: m.data || '', cif: nCif(m.cif), importat: !!m.importat }));
  const purch = (purchases || []).map((p) => ({ id: p.id, data: p.data || '', cif: nCif(p.partenerCui), document: p.document || '', suma: p.suma, spvLinked: !!p.spvImportMsgId }));

  const cifs = new Set([...msgs.map((m) => m.cif), ...purch.map((p) => p.cif)].filter(Boolean));
  const furnizori = []; const neinregistrate = []; const faraSpv = [];
  for (const cif of cifs) {
    const cm = msgs.filter((m) => m.cif === cif);
    const cp = purch.filter((p) => p.cif === cif);
    const importate = cm.filter((m) => m.importat).length;               // deja in jurnal (import SPV, potrivire exacta pe msgId)
    const restMsgs = cm.filter((m) => !m.importat).sort(byDate);         // SPV ne-importate (candidate la neinregistrat)
    const restPurch = cp.filter((p) => !p.spvLinked).sort(byDate);       // jurnal ne-legate de SPV
    const paired = Math.min(restMsgs.length, restPurch.length);          // potrivire count-based per furnizor
    for (const m of restMsgs.slice(paired)) neinregistrate.push({ msgId: m.msgId, data: m.data, cif, den: name(cif) });
    for (const p of restPurch.slice(paired)) faraSpv.push({ id: p.id, data: p.data, cif, den: name(cif), document: p.document, suma: p.suma });
    furnizori.push({ cif, den: name(cif), spv: cm.length, jurnal: cp.length, importate, lipsa: restMsgs.length - paired, extra: restPurch.length - paired });
  }
  furnizori.sort((a, b) => b.lipsa - a.lipsa || b.spv - a.spv || String(a.den).localeCompare(String(b.den)));
  return {
    totalSpv: msgs.length, totalJurnal: purch.length,
    lipsaInJurnal: neinregistrate.length, faraSpvCount: faraSpv.length,
    furnizori, neinregistrate, faraSpv,
  };
}

module.exports = { journalPurchases, reconcileInbox };
