'use strict';

// Sursa unica pentru perimetrul si calculul D205. Calendarul declaratiilor trebuie sa decida
// daca formularul este datorat din EXACT aceleasi randuri pe care generatorul le va pune in XML;
// o lista paralela de tipuri ar deriva inevitabil fata de raport.

const { round2, period: periodOf } = require('./util');
const fiscal = require('./fiscal');
const acc = require('./accounting');

const TIPURI = Object.freeze({
  repartizare_dividende: 'Dividende',
  chirie_pf: 'Chirii',
  premiu_pf: 'Premii',
});
const FEL = Object.freeze({
  repartizare_dividende: 'dividende',
  chirie_pf: 'chirii',
  premiu_pf: 'premii',
});

/** Recap D205 — impozit pe venit retinut la sursa, pe beneficiar. */
function report(db, year) {
  // Felul venitului decide BAZA impozabila, care nu e brutul (art. 84 la chirii, art. 110 alin.
  // (4) la premii). Se calculeaza per ARTICOL: suma neimpozabila de 600 lei se acorda pentru
  // FIECARE premiu, deci scazuta o singura data din cumulat ar declara o baza prea mare.
  const ent = acc.postedEntries(db).filter((e) => TIPURI[e.tip]
    && String(e.period || periodOf(e.data)).startsWith(String(year)));
  const map = new Map();
  for (const e of ent) {
    const tip = TIPURI[e.tip];
    let impozit = 0; let brut = 0;
    for (const l of e.lines) if (String(l.credit) === '446') impozit = round2(impozit + l.suma);
    if (e.tip === 'repartizare_dividende') {
      for (const l of e.lines) if (String(l.credit) === '457') brut = round2(brut + l.suma);
    } else {
      for (const l of e.lines) if (/^6/.test(String(l.debit))) brut = round2(brut + l.suma);
    }
    if (impozit === 0 && brut === 0) continue;
    const baza = fiscal.retinereLaSursa(FEL[e.tip], brut, null, { period: e.data || e.period }).baza;
    const cnp = String(e.partenerCui || '').replace(/\s/g, '').toUpperCase();
    const key = tip + '|' + (cnp || e.partener || '-');
    const r = map.get(key) || { tipVenit: tip, beneficiar: e.partener || '', cnp,
      venitBrut: 0, bazaImpozabila: 0, impozit: 0, nrInreg: 0 };
    r.venitBrut = round2(r.venitBrut + brut);
    r.bazaImpozabila = round2(r.bazaImpozabila + baza);
    r.impozit = round2(r.impozit + impozit);
    r.nrInreg += 1;
    if (!r.beneficiar && e.partener) r.beneficiar = e.partener;
    map.set(key, r);
  }
  const rows = [...map.values()].sort((a, b) => (a.tipVenit + a.beneficiar)
    .localeCompare(b.tipVenit + b.beneficiar));
  return {
    year: String(year), rows,
    totalBrut: round2(rows.reduce((s, r) => s + r.venitBrut, 0)),
    totalBaza: round2(rows.reduce((s, r) => s + r.bazaImpozabila, 0)),
    totalImpozit: round2(rows.reduce((s, r) => s + r.impozit, 0)),
    nr: rows.length,
  };
}

/** Exista cel putin un rand care ar intra efectiv in D205 pentru anul dat? */
function hasOperations(db, year) { return report(db, year).rows.length > 0; }

module.exports = { TIPURI, report, hasOperations };
