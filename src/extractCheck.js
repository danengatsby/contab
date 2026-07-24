'use strict';

// Verificare post-extragere: strat de reconciliere aritmetica peste campurile intoarse de
// extractor (AI sau reguli locale), inainte sa ajunga in formular. Extractorul (mai ales AI-ul)
// poate intoarce valori plauzibile dar INCOERENTE (suma != baza + TVA, cota care nu se potriveste
// cu raportul TVA/baza) — care ar produce un articol contabil gresit TACUT. Aici:
//   - completam DOAR golurile derivabile (camp lipsa calculabil din celelalte) — nu suprascriem
//     valori extrase (ar ascunde o eroare de citire);
//   - semnalam incoerentele ca avertismente, ca utilizatorul sa le vada si sa decida;
//   - inferam cota cand lipseste/e invalida din raportul TVA/baza;
//   - marcam extragerile cu incredere scazuta pentru verificare.
// Conservator prin design: golurile se umplu, dar orice CONFLICT intre valori extrase se
// raporteaza, nu se rescrie.

const { round2 } = require('./util');

// Cotele TVA valide (RO, curente + istorice recente): 21/11/9 curente, 19/5 istorice, 0 scutit.
const VALID_COTE = new Set([0, 5, 9, 11, 19, 21]);
const TOL = 0.02; // toleranta de rotunjire (lei)

const num = (x) => (x == null || x === '' ? null : Number(x));
const has = (x) => x != null && x !== '' && Number.isFinite(Number(x));

/**
 * @param {Object} fields - { data, document, partener, baza, tva, cota, suma, brut }
 * @param {Object} [opts] - { incredere, standardCota, minConfidence }
 * @returns { fields, warnings:[], needsReview:boolean }
 */
function reconcile(fields, opts) {
  opts = opts || {};
  const f = Object.assign({}, fields || {});
  const warnings = [];

  let baza = num(f.baza); let tva = num(f.tva); let suma = num(f.suma);
  let cota = has(f.cota) ? Math.round(num(f.cota)) : null;

  // 1) Completeaza GOLURILE derivabile (doar cand lipsesc — nu suprascrie valori extrase).
  if (!has(f.suma) && has(f.baza) && has(f.tva)) { suma = round2(baza + tva); f.suma = suma; }
  if (!has(f.tva) && has(f.baza) && has(f.suma)) { tva = round2(suma - baza); if (tva >= 0) f.tva = tva; else tva = null; }
  if (!has(f.baza) && has(f.suma) && has(f.tva)) { baza = round2(suma - tva); if (baza >= 0) f.baza = baza; else baza = null; }
  if (!has(f.tva) && has(f.baza) && cota > 0 && !has(f.suma)) { tva = round2((baza * cota) / 100); f.tva = tva; }

  // 2) Cota: infereaza din raportul TVA/baza cand lipseste sau e invalida (si exista TVA real).
  const impliedCota = baza > 0 && tva > 0 ? Math.round((tva / baza) * 100) : null;
  if ((cota == null || cota === 0 || !VALID_COTE.has(cota)) && tva > TOL) {
    if (impliedCota != null && VALID_COTE.has(impliedCota) && impliedCota > 0) { f.cota = impliedCota; cota = impliedCota; }
    else if (opts.standardCota) { f.cota = Number(opts.standardCota); cota = Number(opts.standardCota); }
  }

  // 3) Coerenta (NU suprascrie — semnaleaza pentru verificare).
  if (has(f.baza) && has(f.tva) && has(f.suma) && Math.abs(round2(baza + tva) - suma) > TOL) {
    warnings.push('Sumele nu se potrivesc: bază ' + baza.toFixed(2) + ' + TVA ' + tva.toFixed(2)
      + ' = ' + round2(baza + tva).toFixed(2) + ', dar totalul extras e ' + suma.toFixed(2) + '. Verifică valorile.');
  }
  if (cota > 0 && baza > 0 && tva > TOL && impliedCota != null && impliedCota !== cota) {
    warnings.push('Cota extrasă ' + cota + '% nu se potrivește cu raportul TVA/bază (≈' + impliedCota + '%): '
      + tva.toFixed(2) + ' / ' + baza.toFixed(2) + '. Verifică cota sau sumele.');
  }
  if (cota != null && cota !== 0 && !VALID_COTE.has(cota)) {
    warnings.push('Cota ' + cota + '% nu este o cotă TVA validă (21/11/9/5/0). Verifică.');
  }

  // 4) Incredere scazuta -> verificare recomandata.
  const conf = opts.incredere;
  const minConf = opts.minConfidence != null ? opts.minConfidence : 70;
  if (conf != null && Number.isFinite(Number(conf)) && Number(conf) < minConf) {
    warnings.push('Încredere scăzută în extragere (' + Math.round(Number(conf)) + '%) — verifică toate câmpurile înainte de salvare.');
  }

  return { fields: f, warnings, needsReview: warnings.length > 0 };
}

module.exports = { reconcile, VALID_COTE };
