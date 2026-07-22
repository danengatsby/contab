'use strict';

// Motor de potrivire pentru reconciliere (fise partener + import extras bancar). Inlocuieste
// potrivirea veche "suma exacta, first-fit" cu potriviri graduale, in ordinea increderii:
//  - LEGATA:   punctaj EXPLICIT — plata poarta `stinge` = id-uri de facturi confirmate de
//              utilizator (ex. la importul extrasului); autoritar, inaintea euristicii;
//  - EXACTA:   o plata stinge o factura deschisa de aceeasi suma (toleranta mica de rotunjire);
//  - AGREGATA: o plata stinge mai multe facturi vechi consecutive (frecvent: platite la gramada);
//  - PARTIALA: plata mai mica decat factura -> stingere partiala (alocare FIFO pe cele mai vechi).
// Ce ramane necuplat: facturi DESCHISE (sold neachitat) si AVANSURI (plati fara factura deschisa).
// Pur: fara acces la db; primeste facturi/plati deja extrase ({ id, doc, data, suma }). Toleranta
// implicita acopera doar rotunjirea — diferentele mari raman "partiala", nu se ascund in "exacta".

const { round2 } = require('./util');

const TOL = 0.05; // lei

function near(a, b, tol) { return Math.abs(round2(a - b)) <= tol; }
function byDate(a, b) { return (a.data < b.data ? -1 : a.data > b.data ? 1 : 0); }
function pub(it) { return { id: it.id, doc: it.doc || '', data: it.data || '', suma: round2(it.suma) }; }

// Cel mai scurt prefix de facturi INCA deschise (cele mai vechi, in ordine) a caror suma ramasa
// = amount +/- tol. Acopera "am platit facturile vechi intr-un singur transfer". null daca nu exista.
// Prefixul e monoton crescator, deci ne oprim cand am depasit.
function prefixOpen(invoices, amount, tol) {
  let s = 0; const idx = [];
  for (let i = 0; i < invoices.length; i++) {
    if (invoices[i].rest <= tol) continue;
    s = round2(s + invoices[i].rest); idx.push(i);
    if (near(s, amount, tol)) return idx.slice();
    if (s > amount + tol) return null;
  }
  return null;
}

/**
 * Reconciliaza istoricul unei fise de partener: leaga platile de facturi in trei treceri
 * (exacta -> agregata -> partiala/FIFO). Nu schimba solduri (doar potrivirea de afisare).
 * @returns {{ perechi, deschise, avansuri }} perechi=[{ tip, plata, facturi:[], suma }],
 *   deschise=facturi cu rest > 0, avansuri=plati cu rest > 0.
 */
function settle(invoicesIn, paymentsIn, opts) {
  const tol = (opts && opts.tol != null) ? opts.tol : TOL;
  const invoices = invoicesIn.map((iv) => ({ ...iv, rest: round2(iv.suma) })).sort(byDate);
  const payments = paymentsIn.map((p) => ({ ...p, rest: round2(p.suma) })).sort(byDate);
  const perechi = [];

  // Pas 0: LEGATURI EXPLICITE (punctaj confirmat de utilizator) — autoritare, inaintea euristicii.
  // O plata poarta `stinge` = id-uri de facturi pe care le inchide; aloca FIFO printre cele legate.
  for (const p of payments) {
    if (p.rest <= tol || !Array.isArray(p.stinge) || !p.stinge.length) continue;
    for (const invId of p.stinge) {
      if (p.rest <= tol) break;
      const iv = invoices.find((x) => x.id === invId && x.rest > tol);
      if (!iv) continue;
      const q = round2(Math.min(p.rest, iv.rest));
      perechi.push({ tip: 'legata', plata: pub(p), facturi: [pub(iv)], suma: q });
      iv.rest = round2(iv.rest - q); p.rest = round2(p.rest - q);
    }
  }

  // Pas 1: potriviri EXACTE (o plata <-> o factura de aceeasi suma) — cea mai mare incredere
  for (const p of payments) {
    if (p.rest <= tol) continue;
    const i = invoices.findIndex((iv) => iv.rest > tol && near(iv.rest, p.rest, tol));
    if (i < 0) continue;
    perechi.push({ tip: 'exacta', plata: pub(p), facturi: [pub(invoices[i])], suma: round2(p.rest) });
    invoices[i].rest = 0; p.rest = 0;
  }

  // Pas 2: AGREGAT — o plata stinge mai multe facturi vechi deschise (prefix pe cele mai vechi)
  for (const p of payments) {
    if (p.rest <= tol) continue;
    const idx = prefixOpen(invoices, p.rest, tol);
    if (!idx || idx.length < 2) continue;
    perechi.push({ tip: 'agregata', plata: pub(p), facturi: idx.map((i) => pub(invoices[i])), suma: round2(p.rest) });
    for (const i of idx) invoices[i].rest = 0;
    p.rest = 0;
  }

  // Pas 3: PARTIAL/FIFO — restul platilor peste cele mai vechi facturi deschise, in ordine
  for (const p of payments) {
    if (p.rest <= tol) continue;
    for (const iv of invoices) {
      if (p.rest <= tol) break;
      if (iv.rest <= tol) continue;
      const q = round2(Math.min(p.rest, iv.rest));
      perechi.push({ tip: 'partiala', plata: pub(p), facturi: [pub(iv)], suma: q });
      iv.rest = round2(iv.rest - q); p.rest = round2(p.rest - q);
    }
  }

  const deschise = invoices.filter((iv) => iv.rest > tol).map((iv) => Object.assign(pub(iv), { rest: round2(iv.rest) }));
  const avansuri = payments.filter((p) => p.rest > tol).map((p) => Object.assign(pub(p), { rest: round2(p.rest) }));
  return { perechi, deschise, avansuri };
}

/**
 * Potriveste o singura decontare (o linie de extras bancar) peste facturile DESCHISE ale unui
 * partener, la momentul importului. Acelasi lant: exacta -> agregata -> partiala -> fara.
 * @returns {{ tip, facturi:[], suma }} tip in exacta|agregata|partiala|fara.
 */
function candidatesFor(invoicesIn, amount, opts) {
  const tol = (opts && opts.tol != null) ? opts.tol : TOL;
  amount = round2(amount);
  const open = invoicesIn.map((iv) => ({ ...iv, rest: round2(iv.suma) })).filter((iv) => iv.rest > tol).sort(byDate);
  if (!open.length || !(amount > 0)) return { tip: 'fara', facturi: [], suma: amount };
  const ei = open.findIndex((iv) => near(iv.rest, amount, tol));
  if (ei >= 0) return { tip: 'exacta', facturi: [pub(open[ei])], suma: amount };
  const idx = prefixOpen(open, amount, tol);
  if (idx && idx.length > 1) return { tip: 'agregata', facturi: idx.map((i) => pub(open[i])), suma: amount };
  if (amount < open[0].rest - tol) return { tip: 'partiala', facturi: [pub(open[0])], suma: amount };
  return { tip: 'fara', facturi: [], suma: amount };
}

module.exports = { settle, candidatesFor, TOL };
