'use strict';

// Service layer pentru articolele contabile: creare (cu descarcare automata de gestiune la CMP
// din liniile de stoc), stergere (cu garda pe perioada inchisa), facturi recurente (sabloane +
// generare pe perioada), blocarea perioadei si TVA la incasare (exigibilitate). Rutele
// (src/routes/entries.js) raman puncte de intrare subtiri.
//
// buildEntry/upsertPartner raman infrastructura partajata in server.js (folosite si de rutele
// de banca/ANAF/salarizare) si vin ca dependente in `deps` — acelasi tipar ca in anafService.
// Autorizarea pe firma e dublata la nivel de serviciu prin reqFirma (refolosit din
// stocksService): firma explicita si existenta, fara fallback pe firmaActiva.

const db = require('./db');
const coa = require('./chartOfAccounts');
const stocks = require('./stocks');
const recurring = require('./recurring');
const { reqFirma } = require('./stocksService');
const { round2, period: periodOf } = require('./util');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Creeaza un articol contabil; liniile de stoc genereaza si descarcarea de gestiune la CMP
 *  (miscarile + liniile COGS intra atomic cu articolul — nicio scriere la eroare). */
function createEntry(fid, b, deps) {
  fid = reqFirma(fid); b = b || {};
  const f = Object.assign({}, b.fields || {});
  const stocLines = Array.isArray(f.stoc) ? f.stoc.filter((s) => s && s.productId && Number(s.cantitate) > 0) : [];
  if (stocLines.length) f.cost = 0; // descarcarea vine din stoc (la CMP), nu din campul manual — evita dubla inregistrare
  let entry;
  try { entry = deps.buildEntry(b.tip, f, b.fileId, fid); }
  catch (e) { fail(400, e.message); }
  if (b.spvMsgId) entry.spvImport = { msgId: b.spvMsgId, at: new Date().toISOString() };
  const d = db.get();
  let stocInfo = null;
  if (stocLines.length) {
    const v = db.scoped(fid);
    let r;
    try { r = stocks.saleCogs(v.products, v.stockMovements, stocLines, { fid, data: entry.data, document: entry.document, entryId: entry.id, nextId: () => db.nextId('sm') }); }
    catch (e) { fail(400, e.message); }
    for (const ln of r.cogsLines) {
      if (!coa.getAccount(ln.debit) || !coa.getAccount(ln.credit)) fail(400, 'Cont de descarcare inexistent in plan: ' + ln.debit + '/' + ln.credit);
    }
    for (const mv of r.newMovements) d.stockMovements.push(mv);
    for (const ln of r.cogsLines) entry.lines.push(ln);
    entry.stocMovementIds = r.newMovements.map((m) => m.id);
    stocInfo = { cogsTotal: r.total, warns: r.warns, movements: r.newMovements.length };
  }
  d.entries.push(entry);
  deps.upsertPartner(fid, entry);
  db.save();
  return { entry, stoc: stocInfo };
}

/** Sterge un articol dupa id. `canFid(firmaId)` decide accesul apelantului la firma articolului
 *  (404 identic pentru inexistent in firma si strain); perioada inchisa blocheaza stergerea.
 *  Un id negasit NU e eroare: intoarce removed=0 (contract istoric al rutei). */
function deleteEntry(id, fallbackFid, canFid) {
  const d = db.get();
  const e = d.entries.find((x) => x.id === id);
  if (e && !canFid(e.firmaId == null ? d.firmaActiva : e.firmaId)) fail(404, 'Inregistrare inexistenta.');
  if (e) {
    const firma = db.getFirma(e.firmaId == null ? fallbackFid : e.firmaId);
    const per = e.period || periodOf(e.data);
    if (firma && firma.lockedUntil && per <= firma.lockedUntil) {
      fail(400, 'Inregistrarea e in perioada inchisa ' + per + ' (blocata pana la ' + firma.lockedUntil + '). Deblocheaza perioada (admin) inainte de stergere.');
    }
  }
  const n = d.entries.length;
  d.entries = d.entries.filter((x) => x.id !== id);
  db.save();
  return { removed: n - d.entries.length, entry: e || null };
}

// ── Facturi recurente (sabloane + generare pe perioada) ──

function saveRecurring(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.tip) fail(400, 'Alege tipul de document.');
  const d = db.get();
  const t = b.id && (d.recurringInvoices || []).find((x) => x.id === b.id && x.firmaId === fid);
  const rec = t || { id: db.nextId('rec'), firmaId: fid, createdAt: new Date().toISOString() };
  Object.assign(rec, {
    tip: String(b.tip), partener: b.partener || '', cuiPartener: b.cuiPartener || '', document: b.document || '',
    fields: (b.fields && typeof b.fields === 'object') ? b.fields : {},
    frecventa: ['lunar', 'trimestrial', 'anual'].includes(b.frecventa) ? b.frecventa : 'lunar',
    ziua: Math.min(28, Math.max(1, Number(b.ziua) || 1)),
    startDate: /^\d{4}-\d{2}$/.test(b.startDate || '') ? b.startDate : new Date().toISOString().slice(0, 7),
    activ: b.activ != null ? !!b.activ : true,
  });
  if (!t) d.recurringInvoices.push(rec);
  db.save();
  return { template: rec };
}

function deleteRecurring(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  d.recurringInvoices = (d.recurringInvoices || []).filter((t) => !(t.id === id && t.firmaId === fid));
  db.save();
}

/** Genereaza articolele scadente in perioada din sabloanele active; erorile per sablon se
 *  aduna in `errors` fara sa opreasca restul (contract istoric al rutei). */
function generateRecurring(fid, period, deps) {
  fid = reqFirma(fid);
  const d = db.get();
  period = period || new Date().toISOString().slice(0, 7);
  const due = recurring.dueForPeriod((d.recurringInvoices || []).filter((t) => t.firmaId === fid), period);
  const created = []; const errors = [];
  for (const t of due) {
    const fields = Object.assign({}, t.fields, {
      data: period + '-' + String(t.ziua || 1).padStart(2, '0'),
      partener: t.partener, cuiPartener: t.cuiPartener, document: t.document,
    });
    try {
      const entry = deps.buildEntry(t.tip, fields, null, fid);
      entry.recurringId = t.id;
      d.entries.push(entry);
      deps.upsertPartner(fid, entry);
      t.lastGenerated = period;
      created.push({ id: entry.id, tip: entry.tipNume, partener: t.partener });
    } catch (e) { errors.push((t.partener || t.tip) + ': ' + e.message); }
  }
  db.save();
  return { period, created, errors };
}

// ── Blocarea perioadei + TVA la incasare ──

/** Seteaza luna pana la care firma e read-only (null/gol = deblocare completa).
 *  404 (nu 403) pentru firma inexistenta — contractul istoric al rutei de admin. */
function setPeriodLock(fid, lockedUntil) {
  const firma = db.getFirma(fid);
  if (!firma) fail(404, 'Firma inexistenta.');
  if (lockedUntil == null || lockedUntil === '') firma.lockedUntil = null;
  else if (/^\d{4}-\d{2}$/.test(lockedUntil) && Number(lockedUntil.slice(5)) >= 1 && Number(lockedUntil.slice(5)) <= 12) firma.lockedUntil = lockedUntil;
  else fail(400, 'Format invalid. Foloseste YYYY-MM (ex. 2026-05) sau gol pentru deblocare.');
  db.save();
  return { lockedUntil: firma.lockedUntil };
}

/** TVA la incasare: din suma bruta incasata/platita, calculeaza TVA exigibila si posteaza nota.
 *  buildEntry e apelat intentionat fara catch (ca in ruta istorica): o eroare de acolo urca
 *  la handlerul global, nu devine 400. */
function tvaExigibilitate(fid, b, deps) {
  fid = reqFirma(fid); b = b || {};
  const brut = round2(Number(b.brut) || 0);
  const cota = Number(b.cota) || 0;
  if (brut <= 0 || cota <= 0) fail(400, 'Completeaza suma bruta si cota TVA.');
  const tva = round2((brut * cota) / (100 + cota));
  const tip = b.tip === 'deductibila' ? 'exigibilitate_tva_deductibila' : 'exigibilitate_tva_colectata';
  const data = b.data && String(b.data).length === 10 ? b.data : new Date().toISOString().slice(0, 10);
  const entry = deps.buildEntry(tip, { data, partener: b.partener || '', document: b.document || '', tva }, null, fid);
  entry.system = true;
  // baza aferenta TVA-ului devenit exigibil (pentru D300 in perioada exigibilitatii — TVA la incasare)
  entry.tvaExig = { baza: round2(brut - tva), cota, side: b.tip === 'deductibila' ? 'deductibila' : 'colectata' };
  db.get().entries.push(entry);
  db.save();
  return { tva, brut, cota, entry };
}

module.exports = {
  createEntry, deleteEntry,
  saveRecurring, deleteRecurring, generateRecurring,
  setPeriodLock, tvaExigibilitate,
};
