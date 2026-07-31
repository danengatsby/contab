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
const { round2 } = require('./util');
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

function normalize(b) {
  const principal = round2(Number(b.principal) || 0);
  const months = Math.floor(Number(b.months) || 0);
  if (!(principal > 0)) fail(400, 'Valoarea finantata trebuie sa fie pozitiva.');
  if (!(months > 0)) fail(400, 'Numarul de rate trebuie sa fie cel putin 1.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.dataPrimeiRate || ''))) fail(400, 'Completeaza data primei rate (AAAA-LL-ZZ).');
  const dob = Number(b.dobandaAnuala) || 0;
  if (dob < 0) fail(400, 'Dobanda anuala nu poate fi negativa.');
  const cota = Number(b.cotaTva);
  return {
    denumire: String(b.denumire || '').trim(),
    partener: String(b.partener || '').trim(),
    cui: String(b.cui || '').trim(),
    document: String(b.document || '').trim(),
    principal, months, dobandaAnuala: dob,
    metoda: METODE.includes(b.metoda) ? b.metoda : 'anuitati',
    dataPrimeiRate: String(b.dataPrimeiRate),
    cotaTva: Number.isFinite(cota) && cota >= 0 ? cota : 0,
  };
}

function upsert(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!String(b.denumire || '').trim()) fail(400, 'Completeaza denumirea contractului.');
  const n = normalize(b);
  const d = db.get();
  if (b.id) { // editare: doar in interiorul firmei
    const c = reqContract(fid, b.id);
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
  d.leasingContracts = (d.leasingContracts || []).filter((x) => x !== c);
  db.save();
  return { ok: true, contract: c };
}

/** Lista contractelor firmei, fiecare cu totalurile graficului (nu si randurile — ar fi mult).
 *  Plafonata (garda OOM), ca orice colectie vie intoarsa dintr-un serviciu. */
function list(fid) {
  fid = reqFirma(fid);
  return capList((db.get().leasingContracts || []).filter((c) => c.firmaId === fid), null, 'leasingContracts').items.map((c) => {
    const s = leasing.contractSchedule(c);
    return Object.assign({}, c, {
      totals: s.totals,
      primaRata: s.rows.length ? s.rows[0].period : null,
      ultimaRata: s.rows.length ? s.rows[s.rows.length - 1].period : null,
    });
  });
}

/** Graficul complet al unui contract. */
function schedule(fid, id) {
  fid = reqFirma(fid);
  const c = reqContract(fid, id);
  return { contract: c, schedule: leasing.contractSchedule(c) };
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

module.exports = { upsert, remove, list, schedule, installment, METODE };
