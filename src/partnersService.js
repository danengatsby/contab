'use strict';

// Service layer pentru nomenclatoare si solduri initiale: partenerii (upsert + import CSV),
// planul de conturi personalizat (import CSV, global — planul e partajat intre firme),
// conversia XLSX/XLS/DBF -> CSV pentru fluxurile de import, soldurile initiale sintetice
// (cu verificarea echilibrului debit=credit) si analitice (pe partener). Rutele
// (src/routes/partners.js) raman puncte de intrare subtiri.
//
// Autorizarea pe firma e dublata prin reqFirma (refolosit din stocksService). Eroarea de
// dezechilibru la solduri poarta si `extra` (totalDebit/totalCredit/diferenta) — ruta o
// include in corpul raspunsului 400, contractul istoric al endpoint-ului.

const fs = require('fs');
const db = require('./db');
const coa = require('./chartOfAccounts');
const xlsx = require('./xlsx');
const xls = require('./xls');
const dbf = require('./dbf');
const { toCsv, parseCsv, isHeaderRow } = require('./csv');
const { reqFirma } = require('./stocksService');
const { round2 } = require('./util');

function fail(status, message, extra) { const e = new Error(message); e.status = status; if (extra) e.extra = extra; throw e; }

/** Import plan de conturi personalizat din CSV: Cod;Denumire;Clasa;Tip (upsert in
 *  customAccounts). Global, nu per firma: planul de conturi e partajat intre firme. */
function importAccounts(csv) {
  const rows = parseCsv(csv || '');
  if (!rows.length) fail(400, 'CSV gol sau invalid.');
  const start = isHeaderRow(rows[0]) ? 1 : 0; // vezi isHeaderRow: decizia se ia dupa PRIMA celula
  const d = db.get();
  const list = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const cod = String(r[0] || '').trim();
    if (!cod || !r[1]) continue;
    list.push({ cod, nume: r[1], clasa: Number(r[2]) || Number(cod[0]) || 0, tip: (r[3] || 'B').toUpperCase() });
  }
  for (const a of list) {
    const ex = d.customAccounts.find((x) => x.cod === a.cod);
    if (ex) Object.assign(ex, a); else d.customAccounts.push(a);
  }
  coa.addAccounts(list);
  db.save();
  return { importati: list.length, totalConturi: coa.ACCOUNTS.length };
}

// ── Parteneri (nomenclator per firma) ──

function upsertPartner(fid, b) {
  fid = reqFirma(fid); b = b || {};
  const key = String(b.cui || '').replace(/^ro/i, '').replace(/\s/g, '');
  if (!key) fail(400, 'CUI lipsa.');
  const d = db.get();
  d.partners[fid] = d.partners[fid] || {};
  const prev = d.partners[fid][key] || {};
  d.partners[fid][key] = {
    cui: key, den: b.den || '', adresa: b.adresa || '', oras: b.oras || '',
    judet: b.judet || '', tara: b.tara || 'RO', tip: b.tip != null ? b.tip : (prev.tip || ''),
  };
  db.save();
  return { partner: d.partners[fid][key] };
}

/** Import parteneri din CSV: CUI;Denumire;Adresa;Oras;Judet;Tara[;Tip] (header optional). */
function importPartners(fid, csv) {
  fid = reqFirma(fid);
  const rows = parseCsv(csv || '');
  if (!rows.length) fail(400, 'CSV gol sau invalid.');
  const start = isHeaderRow(rows[0]) ? 1 : 0; // vezi isHeaderRow: decizia se ia dupa PRIMA celula
  const d = db.get();
  d.partners[fid] = d.partners[fid] || {};
  let importati = 0; const erori = [];
  // Prima celula trebuie sa ARATE a cod fiscal: cifre, eventual cu prefix de tara (RO12345674,
  // 12345674, DE811907980). Fara verificarea asta, un CSV cu alte coloane se importa TACIT ca
  // parteneri de gunoi — gasit de E2E-ul izolat: „nu,sunt,coloane" crea partenerul cui='nu',
  // den='sunt', iar raspunsul raporta „importati: 2". Un import care reuseste pe date gresite e
  // mai rau decat unul care esueaza: gunoiul ajunge in facturi si in declaratii.
  const CUI_OK = /^[A-Z]{0,3}\d{2,12}$/i;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const key = String(r[0] || '').replace(/^ro/i, '').replace(/\s/g, '');
    if (!key) { erori.push('rand ' + (i + 1) + ': CUI lipsa'); continue; }
    if (!CUI_OK.test(key)) { erori.push('rand ' + (i + 1) + ': „' + String(r[0]).slice(0, 24) + '" nu e un cod fiscal valid'); continue; }
    if (!String(r[1] || '').trim()) { erori.push('rand ' + (i + 1) + ': denumire lipsa pentru ' + key); continue; }
    d.partners[fid][key] = { cui: key, den: r[1] || '', adresa: r[2] || '', oras: r[3] || '', judet: r[4] || '', tara: r[5] || 'RO', tip: (r[6] || '').toLowerCase().trim() };
    importati += 1;
  }
  // Niciun rand valid, dar randuri au existat -> fisierul nu are forma asteptata. Spune-o.
  if (!importati && erori.length) fail(400, 'Niciun rand valid: ' + erori.slice(0, 3).join('; ') + (erori.length > 3 ? ' …' : ''));
  db.save();
  return { importati, erori };
}

/** Conversie XLSX (Excel modern) / XLS (vechi) / DBF (dBASE-FoxPro) -> CSV, dupa continut
 *  (magic bytes) cu extensia ca rezerva. Fisierul temporar de upload se sterge intotdeauna. */
function convertUploadToCsv(filePath, originalName) {
  let rows;
  try {
    const data = fs.readFileSync(filePath);
    const name = originalName || '';
    const isXlsx = (data.length > 1 && data[0] === 0x50 && data[1] === 0x4B) || /\.xlsx$/i.test(name); // "PK" -> zip
    const isXls = (data.length > 1 && data[0] === 0xD0 && data[1] === 0xCF) || /\.xls$/i.test(name);   // OLE compound -> Excel vechi
    const isDbf = /\.dbf$/i.test(name) || [0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x83, 0x8b, 0xf5, 0xfb].includes(data[0]);
    rows = isXlsx ? xlsx.parseXlsx(data) : isXls ? xls.parseXls(data) : isDbf ? dbf.parseDbf(data) : xlsx.parseXlsx(data);
  } catch (e) { try { fs.unlinkSync(filePath); } catch (_) { /* */ } fail(400, e.message); }
  try { fs.unlinkSync(filePath); } catch (_) { /* */ }
  if (!rows.length) fail(400, 'Fisierul este gol sau nerecunoscut.');
  return { rows: rows.length, csv: toCsv(rows[0], rows.slice(1)) };
}

// ── Solduri initiale analitice (pe partener) ──

function saveOpeningAnalytic(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.cont) fail(400, 'Lipseste contul.');
  const d = db.get();
  d.openingAnalytic = d.openingAnalytic || [];
  const key = (p) => p.firmaId + '|' + p.cont + '|' + String(p.cui || p.partener || '').toUpperCase().replace(/^RO/i, '').replace(/\s/g, '');
  const rec = { firmaId: fid, cont: String(b.cont), partener: b.partener || '', cui: b.cui || '', d: round2(parseFloat(b.d) || 0), c: round2(parseFloat(b.c) || 0) };
  const i = d.openingAnalytic.findIndex((x) => key(x) === key(rec));
  if (i >= 0) d.openingAnalytic[i] = rec; else d.openingAnalytic.push(rec);
  db.save();
  return { openingAnalytic: d.openingAnalytic.filter((o) => o.firmaId === fid) };
}

/** Sterge dupa indexul din lista filtrata pe firma (contractul UI-ului); un index invalid
 *  NU e eroare (contract istoric al rutei). */
function deleteOpeningAnalytic(fid, idx) {
  fid = reqFirma(fid);
  const d = db.get();
  const list = (d.openingAnalytic || []).filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === fid);
  const rec = list[Number(idx)];
  if (rec) { const gi = d.openingAnalytic.indexOf(rec); if (gi >= 0) d.openingAnalytic.splice(gi, 1); }
  db.save();
}

// ── Solduri initiale sintetice ──

/** Soldurile initiale trebuie sa fie echilibrate (total debit = total credit), altfel balanta
 *  nu se va inchide niciodata. Respinge cu diferenta exacta in `extra` (intra in raspunsul 400). */
function setOpening(fid, ob) {
  fid = reqFirma(fid); ob = ob || {};
  const d = db.get();
  let totD = 0; let totC = 0;
  for (const cod of Object.keys(ob)) { totD = round2(totD + (Number(ob[cod] && ob[cod].d) || 0)); totC = round2(totC + (Number(ob[cod] && ob[cod].c) || 0)); }
  const dif = round2(totD - totC);
  if (Math.abs(dif) >= 0.005) {
    fail(400, 'Soldurile inițiale sunt dezechilibrate: total debit ' + totD + ' ≠ total credit ' + totC + ' (diferență ' + dif + '). Corectează-le înainte de salvare.', { totalDebit: totD, totalCredit: totC, diferenta: dif });
  }
  d.openingBalances[fid] = ob;
  db.save();
  return { totalDebit: totD, totalCredit: totC, conturi: Object.keys(ob).length };
}

module.exports = {
  importAccounts,
  upsertPartner, importPartners, convertUploadToCsv,
  saveOpeningAnalytic, deleteOpeningAnalytic, setOpening,
};
