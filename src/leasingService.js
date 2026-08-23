'use strict';

// Service layer pentru contractele de leasing: nomenclatorul contractelor + graficul de rate
// derivat din ele. Rutele (src/routes/leasing.js) raman puncte de intrare subtiri.
//
// De ce exista colectia: graficul de rate era un CALCULATOR fara stare — parametrii veneau din
// query string, iesea un tabel si un PDF, si nimic nu se pastra. Deci `factura_leasing` n-avea
// ce consulta si cerea principalul si dobanda introduse de mana in fiecare luna, adica exact
// cifrele pe care graficul le stia deja. Contractul persistat e ce leaga cele doua.
//
// Contractul NU e un mijloc fix, desi de obicei vine cu unul: la leasingul OPERATIONAL nu se
// inregistreaza niciun activ, iar la cel financiar activul si contractul au vieti diferite
// (activul se poate casa inainte de ultima rata). De aceea colectie proprie, nu campuri pe `assets`.
//
// Autorizare DUBLATA, ca la celelalte servicii: reqFirma() cere firma explicita si existenta,
// iar cautarea contractului se face DOAR in interiorul ei — un id strain da 404, nu datele altcuiva.

const db = require('./db');
const { validIsoDate, validPeriod } = require('./util');
const leasing = require('./leasing');
const { capList } = require('./paginate');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Garda de autorizare: firma trebuie sa fie explicita si sa existe. Fara ea, db.scoped()
 *  ar cadea pe firmaActiva globala la un fid invalid — adica pe datele altcuiva. */
function reqFirma(fid) {
  const id = Number(fid);
  if (!Number.isInteger(id) || id <= 0 || !db.getFirma(id)) fail(403, 'Firma activa invalida sau inexistenta.');
  return id;
}

/** Contractul cerut, cautat DOAR in firma data. 404 identic pentru inexistent si strain. */
function reqContract(fid, id) {
  const c = (db.get().leasingContracts || []).find((x) => x.id === String(id) && x.firmaId === fid);
  if (!c) fail(404, 'Contract de leasing inexistent.');
  return c;
}

const METODE = ['anuitati', 'rate_egale'];
const CAMPURI_GRAFIC = ['principal', 'months', 'dobandaAnuala', 'metoda', 'dataPrimeiRate', 'cotaTva'];

function normalize(b) {
  const principal = Number(b.principal);
  const months = Number(b.months);
  const dob = b.dobandaAnuala == null || b.dobandaAnuala === '' ? 0 : Number(b.dobandaAnuala);
  // Motorul este limita autoritara (finit, intreg, plafoane); validarea nu se poate ocoli
  // accesand direct calculatorul HTTP in locul nomenclatorului de contracte.
  leasing.leasingSchedule(principal, months, dob, b.metoda);
  if (!validIsoDate(b.dataPrimeiRate)) fail(400, 'Completeaza o data calendaristica reala pentru prima rata (AAAA-LL-ZZ).');
  const cota = b.cotaTva == null || b.cotaTva === '' ? 0 : Number(b.cotaTva);
  if (!Number.isFinite(cota) || cota < 0 || cota > 100) fail(400, 'Cota TVA trebuie sa fie intre 0 si 100%.');
  return {
    denumire: String(b.denumire || '').trim(),
    partener: String(b.partener || '').trim(),
    cui: String(b.cui || '').trim(),
    document: String(b.document || '').trim(),
    principal, months, dobandaAnuala: dob,
    metoda: METODE.includes(b.metoda) ? b.metoda : 'anuitati',
    dataPrimeiRate: String(b.dataPrimeiRate),
    cotaTva: cota,
  };
}

function upsert(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!String(b.denumire || '').trim()) fail(400, 'Completeaza denumirea contractului.');
  const n = normalize(b);
  const d = db.get();
  if (b.id) { // editare: doar in interiorul firmei
    const c = reqContract(fid, b.id);
    const folosit = linkedEntries(fid, c.id);
    // Identificarea locatorului poate fi corectata, dar graficul care a alimentat deja o factura
    // ramane imuabil. Altfel aceeasi factura istorica ar indica maine alta rata/principal/TVA.
    if (folosit.length && CAMPURI_GRAFIC.some((k) => String(c[k]) !== String(n[k]))) {
      fail(409, 'Graficul contractului este folosit de ' + folosit.length + ' articol(e) si nu mai poate fi modificat. Pentru conditii noi creeaza un contract nou; denumirea si datele locatorului pot fi corectate aici.');
    }
    Object.assign(c, n);
    db.save();
    return { contract: c, created: false };
  }
  const c = Object.assign({ id: db.nextId('lsg'), firmaId: fid }, n);
  d.leasingContracts.push(c);
  db.save();
  return { contract: c, created: true };
}

function remove(fid, id) {
  fid = reqFirma(fid);
  const c = reqContract(fid, id);
  const d = db.get();
  const folosit = linkedEntries(fid, c.id);
  if (folosit.length) fail(409, 'Contractul este legat de ' + folosit.length + ' articol(e) si nu poate fi sters; istoricul contabil trebuie sa ramana trasabil.');
  d.leasingContracts = (d.leasingContracts || []).filter((x) => x !== c);
  db.save();
  return { ok: true, contract: c };
}

/** Lista contractelor firmei, fiecare cu totalurile graficului (nu si randurile — ar fi mult).
 *  Plafonata (garda OOM), ca orice colectie vie intoarsa dintr-un serviciu. */
function list(fid) {
  fid = reqFirma(fid);
  const contracts = capList((db.get().leasingContracts || []).filter((c) => c.firmaId === fid), null, 'leasingContracts').items;
  const wanted = new Set(contracts.map((c) => String(c.id)));
  const links = new Map();
  // O singura trecere prin jurnal pentru TOATA lista. Un scan per contract ar deveni O(C×E)
  // exact pe firmele cu multe contracte si multe articole.
  for (const e of (db.get().entries || [])) {
    const id = e.firmaId === fid && e.leasingRef ? String(e.leasingRef.contractId) : '';
    if (!wanted.has(id)) continue;
    if (!links.has(id)) links.set(id, []);
    links.get(id).push(e);
  }
  return contracts.map((c) => {
    const s = leasing.contractSchedule(c);
    const usage = usageSummary(fid, c.id, s, links.get(String(c.id)) || []);
    return Object.assign({}, c, {
      totals: s.totals,
      primaRata: s.rows.length ? s.rows[0].period : null,
      ultimaRata: s.rows.length ? s.rows[s.rows.length - 1].period : null,
      usage,
    });
  });
}

/** Graficul complet al unui contract. */
function schedule(fid, id) {
  fid = reqFirma(fid);
  const c = reqContract(fid, id);
  const s = leasing.contractSchedule(c);
  const active = activeLinkedEntries(fid, c.id);
  const byPeriod = new Map();
  // Un articol postat are prioritate fata de o ciorna ramasa accidental pe aceeasi luna.
  for (const e of active.sort((a, b) => (isPosted(a) ? -1 : 1) - (isPosted(b) ? -1 : 1))) {
    if (!byPeriod.has(e.leasingRef.period)) byPeriod.set(e.leasingRef.period, e);
  }
  s.rows = s.rows.map((r) => {
    const e = byPeriod.get(r.period);
    return Object.assign({}, r, e ? { inregistrare: {
      id: e.id, document: e.document || '', data: e.data, status: isPosted(e) ? 'postat' : (e.status || 'ciorna'),
    } } : {});
  });
  return { contract: c, schedule: s, usage: usageSummary(fid, c.id, s) };
}

/**
 * Rata scadenta intr-o luna — exact cifrele pe care le cere `factura_leasing`.
 * O luna in afara contractului e o eroare EXPLICITA, nu o rata goala: o factura completata cu
 * zerouri ar trece nevazuta prin formular si ar posta un articol fara continut.
 */
function installment(fid, id, period) {
  fid = reqFirma(fid);
  const c = reqContract(fid, id);
  const r = leasing.installmentFor(c, period);
  if (!r) fail(404, 'Luna ' + String(period || '') + ' nu are rata in contractul „' + c.denumire + '" (rate: ' + (leasing.contractSchedule(c).rows[0] || {}).period + ' … ' + ((leasing.contractSchedule(c).rows.slice(-1)[0]) || {}).period + ').');
  return { contract: { id: c.id, denumire: c.denumire, partener: c.partener, cui: c.cui, cotaTva: c.cotaTva }, rata: r };
}

function isPosted(e) { return !e.status || e.status === 'postat'; }

function linkedEntries(fid, contractId) {
  // Iteratie interna, nu colectia vie returnata direct: rezultatul este folosit pentru invarianti
  // (unicitate/imuabilitate), deci nu poate fi trunchiat fara sa lase dubluri dupa plafon.
  const out = [];
  for (const e of (db.get().entries || [])) {
    if (e.firmaId === fid && e.leasingRef && String(e.leasingRef.contractId) === String(contractId)) out.push(e);
  }
  return out;
}

function activeLinkedEntries(fid, contractId) {
  return linkedEntries(fid, contractId).filter((e) => !e.stornat && !e.stornoOf);
}

function usageSummary(fid, contractId, scheduleValue, knownLinks) {
  const all = knownLinks || linkedEntries(fid, contractId);
  const active = all.filter((e) => !e.stornat && !e.stornoOf);
  const s = scheduleValue || leasing.contractSchedule(reqContract(fid, contractId));
  const periods = new Set((s.rows || []).map((r) => r.period));
  const postedPeriods = new Set(active.filter((e) => isPosted(e) && periods.has(e.leasingRef.period)).map((e) => e.leasingRef.period));
  const inLucruPeriods = new Set(active.filter((e) => !isPosted(e) && periods.has(e.leasingRef.period)).map((e) => e.leasingRef.period));
  const next = (s.rows || []).find((r) => !postedPeriods.has(r.period));
  return { linked: all.length, posted: postedPeriods.size, inLucru: inLucruPeriods.size,
    nextPeriod: next ? next.period : null, complete: postedPeriods.size >= (s.rows || []).length };
}

/** Valideaza selectia din formular si pastreaza o fotografie a ratei. Cifrele facturii pot fi
 * ajustate de operator; fotografia face diferenta verificabila fara sa rescrie graficul. */
function resolveReference(fid, value) {
  fid = reqFirma(fid);
  if (value == null || value === '') return null; // introducerea manuala ramane compatibila
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Referinta ratei de leasing este invalida. Realege contractul si luna.');
  const contractId = String(value.contractId || '').trim();
  const period = String(value.period || '').trim();
  if (!contractId || !validPeriod(period)) fail(400, 'Referinta ratei trebuie sa contina contractul si luna (YYYY-MM).');
  const c = reqContract(fid, contractId);
  const r = leasing.installmentFor(c, period);
  if (!r) fail(400, 'Luna ' + period + ' nu exista in graficul contractului „' + c.denumire + '”.');
  return {
    contractId: c.id, period,
    contractDenumire: c.denumire, contractDocument: c.document || '',
    rata: { luna: r.luna, principal: r.principal, dobanda: r.dobanda, tva: r.tva,
      total: r.total, sold: r.sold, cotaTva: c.cotaTva },
  };
}

/** La postare, contractul trebuie sa existe inca si aceeasi rata sa nu fie deja activa. */
function assertEntryCanPost(fid, entry) {
  if (!entry || !entry.leasingRef) return;
  fid = reqFirma(fid);
  const ref = entry.leasingRef;
  const c = reqContract(fid, ref.contractId);
  if (!validPeriod(ref.period) || !leasing.installmentFor(c, ref.period)) fail(409, 'Rata legata nu mai exista in graficul contractului.');
  const duplicate = activeLinkedEntries(fid, ref.contractId).find((e) => e.id !== entry.id
    && isPosted(e) && e.leasingRef.period === ref.period);
  if (duplicate) fail(409, 'Rata ' + ref.period + ' a contractului „' + c.denumire + '” este deja postata prin documentul '
    + (duplicate.document || duplicate.id) + '. Storneaza inregistrarea existenta inainte de a posta o corectie.');
}

module.exports = { upsert, remove, list, schedule, installment, resolveReference, assertEntryCanPost,
  usageSummary, METODE };
