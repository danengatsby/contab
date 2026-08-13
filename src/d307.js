'use strict';

// D307 — ajustari/corectii/regularizari TVA pentru transfer de active, leasing si anularea
// codului normal de TVA. Formularul cere un singur rand pentru fiecare combinatie tip + CUI;
// modulul normalizeaza identitatea operatorului si grupeaza articolele inainte de XML, ca doua
// corectii ale aceluiasi partener sa nu fie respinse drept aparitii duplicate.

const acc = require('./accounting');
const identitate = require('./identitate');
const { period: periodOf } = require('./util');

const TIP_DOCUMENT = 'ajustare_regularizare_tva_d307';

const OPERATIUNI = Object.freeze({
  A: { rol: 'cedent', nume: 'Transfer de active — beneficiar succesor al cedentului' },
  L: { rol: 'finanțator', nume: 'Transferul proprietății activului cumpărat prin leasing' },
  C: { rol: 'beneficiar', nume: 'Ajustare/corecție/regularizare după anularea codului TVA' },
});

function fail(message) { throw new Error(message); }

/** Normalizeaza campurile declarative. D307 declara TVA in lei intregi si validatorul oficial
 *  J1.1.0 accepta valori semnate pentru toate cele trei tipuri (inclusiv rectificari negative). */
function dinCampuri(d) {
  d = d || {};
  const tip = String(d.tipOperatieD307 || '').trim().toUpperCase();
  if (!OPERATIUNI[tip]) fail('Alege tipul operațiunii D307: A, L sau C.');
  const denumireOperator = String(d.partener || '').trim();
  if (!denumireOperator) fail('Completează denumirea operatorului D307 (' + OPERATIUNI[tip].rol + ').');
  if (denumireOperator.length > 200) fail('Denumirea operatorului D307 poate avea cel mult 200 de caractere.');
  const codOperator = identitate.cuiKey(d.cuiPartener);
  if (!identitate.validCUI(codOperator)) fail('CUI-ul operatorului D307 este invalid — verifică cifra de control.');
  const tva = Math.round(Number(d.sumaTvaD307));
  if (!Number.isFinite(tva) || tva === 0) fail('Suma TVA D307 trebuie să fie diferită de zero. Folosește minus pentru suma în favoarea firmei.');
  return { tip, rol: OPERATIUNI[tip].rol, codOperator, denumireOperator, tva };
}

/** Raport lunar din articole postate. Agregarea tip+CUI este ceruta de regula oficiala care
 *  respinge aparitiile multiple; pastram si totalul zero, necesar unei rectificari complete. */
function report(view, period) {
  const groups = new Map();
  const errors = [];
  let nrArticole = 0;
  for (const e of acc.postedEntries(view || {})) {
    if (e.tip !== TIP_DOCUMENT || e.stornat) continue;
    const ep = String(e.period || periodOf(e.data));
    if (period && ep !== String(period)) continue;
    const m = e.d307 || {};
    const tip = String(m.tip || '').toUpperCase();
    const codOperator = identitate.cuiKey(m.codOperator);
    if (!OPERATIUNI[tip]) { errors.push('Articolul ' + e.id + ' nu are tip D307 valid.'); continue; }
    if (!identitate.validCUI(codOperator)) { errors.push('Articolul ' + e.id + ' nu are CUI de operator D307 valid.'); continue; }
    if (!String(m.denumireOperator || e.partener || '').trim()) { errors.push('Articolul ' + e.id + ' nu are denumirea operatorului D307.'); continue; }
    const tva = Math.round(Number(m.tva));
    if (!Number.isFinite(tva) || tva === 0) { errors.push('Articolul ' + e.id + ' nu are TVA D307 validă.'); continue; }
    nrArticole += 1;
    const key = tip + ':' + codOperator;
    const row = groups.get(key) || {
      tip, rol: OPERATIUNI[tip].rol, denumire: OPERATIUNI[tip].nume,
      codOperator, denumireOperator: String(m.denumireOperator || e.partener || '').trim(),
      tva: 0, entryIds: [],
    };
    row.tva += tva;
    row.entryIds.push(e.id);
    // Ultima denumire nevida castiga: CUI-ul este identitatea, numele poate fi corectat in timp.
    if (String(m.denumireOperator || e.partener || '').trim()) {
      row.denumireOperator = String(m.denumireOperator || e.partener).trim();
    }
    groups.set(key, row);
  }
  const rows = [...groups.values()]
    .sort((a, b) => a.tip.localeCompare(b.tip) || a.codOperator.localeCompare(b.codOperator));
  const totaluri = { A: 0, L: 0, C: 0 };
  for (const r of rows) totaluri[r.tip] += r.tva;
  return {
    period: period || null,
    rows,
    totaluri,
    totalTva: totaluri.A + totaluri.L + totaluri.C,
    nr: rows.length,
    nrArticole,
    errors,
  };
}

module.exports = { TIP_DOCUMENT, OPERATIUNI, dinCampuri, report };
