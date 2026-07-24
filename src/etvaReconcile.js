'use strict';

// Reconciliere RO e-TVA: decontul PRECOMPLETAT de ANAF (notificarea de conformare) <-> D300-ul
// propriu al perioadei. ANAF precompleteaza decontul din sursele pe care le vede (e-Factura,
// e-Transport, SAF-T, case de marcat) si cere justificarea diferentelor pana la un termen; aici
// se importa acel decont si se PUNCTEAZA rand-cu-rand fata de pozitia proprie, evidentiind
// diferentele — simetric cu reconcilierea e-Factura primite <-> jurnal cumparari (einvoiceReconcile).
//
// Decontul precompletat are ACELASI format ca D300-ul generat (declaratie300 cu atribute-randuri
// Rxx_1 = baza, Rxx_2 = TVA, in lei intregi), deci pozitia proprie se ia din aceeasi sursa unica
// (xml.d300Rows) — comparam mere cu mere.

// Randurile relevante de confruntat, cu etichete. Aliniate cu maparea din xml.js
// (D300_RAND_V vanzari, D300_RAND_C cumparari) + totalurile si soldul.
const ROWS = [
  { rand: 'R9', eticheta: 'Livrari taxabile 21%' },
  { rand: 'R10', eticheta: 'Livrari taxabile 11%' },
  { rand: 'R11', eticheta: 'Livrari taxabile 9%' },
  { rand: 'R71', eticheta: 'Livrari taxabile 5%' },
  { rand: 'R69', eticheta: 'Livrari taxabile 19%' },
  { rand: 'R17', eticheta: 'TOTAL taxa colectata', tvaOnly: true },
  { rand: 'R22', eticheta: 'Achizitii taxabile 21%' },
  { rand: 'R23', eticheta: 'Achizitii taxabile 11%' },
  { rand: 'R24', eticheta: 'Achizitii taxabile 5%' },
  { rand: 'R74', eticheta: 'Achizitii taxabile 9%' },
  { rand: 'R75', eticheta: 'Achizitii taxabile 19%' },
  { rand: 'R27', eticheta: 'TOTAL taxa deductibila', tvaOnly: true },
  { rand: 'R41', eticheta: 'TVA de plata', tvaOnly: true },
  { rand: 'R42', eticheta: 'TVA de recuperat', tvaOnly: true },
];

const TOL = 1; // toleranta de rotunjire (D300 e in lei intregi)

/** Parseaza decontul precompletat (XML declaratie300 al ANAF) -> { luna, an, cui, rows }.
 *  `rows` = { Rxx_1: n, Rxx_2: n, ... } (doar randurile prezente). Robust la namespace/ordine. */
function parseD300(xmlStr) {
  const s = String(xmlStr || '');
  if (!/<declaratie300\b/.test(s)) {
    const e = new Error('Nu pare un decont D300 (elementul <declaratie300> lipseste). Incarca XML-ul precompletat descarcat din SPV.');
    e.status = 400; throw e;
  }
  const attr = (n) => { const m = s.match(new RegExp('\\b' + n + '="([^"]*)"')); return m ? m[1] : ''; };
  const rows = {};
  const re = /\b(R\d+_[12])="(-?\d+(?:\.\d+)?)"/g;
  let m;
  while ((m = re.exec(s))) rows[m[1]] = Math.round(Number(m[2]) || 0);
  return {
    luna: attr('luna'), an: attr('an'),
    cui: attr('cui').replace(/^ro/i, '').replace(/\s/g, ''),
    rows,
  };
}

/**
 * Confrunta rand-cu-rand pozitia proprie cu decontul precompletat.
 * @param {Object} own  - randurile proprii (xml.d300Rows), { Rxx_col: n }
 * @param {Object} anaf - randurile din decontul precompletat (parseD300().rows)
 * @param {Object} [meta] - { period, cuiPropriu } pentru context/avertismente
 * @returns { meta, rows, diffCount, ok, findings }
 */
function reconcile(own, anaf, meta) {
  own = own || {}; anaf = anaf || {}; meta = meta || {};
  const cell = (k) => {
    const p = Math.round(own[k] || 0); const a = Math.round(anaf[k] || 0);
    const delta = a - p; // ANAF - propriu (pozitiv = ANAF vede mai mult decat ai declarat tu)
    return { propriu: p, anaf: a, delta, match: Math.abs(delta) <= TOL };
  };
  const rows = ROWS.map((r) => {
    const out = { rand: r.rand, eticheta: r.eticheta, tva: cell(r.rand + '_2') };
    if (!r.tvaOnly) out.baza = cell(r.rand + '_1');
    out.match = out.tva.match && (!out.baza || out.baza.match);
    return out;
  });
  const diffCount = rows.filter((r) => !r.match).length;

  const findings = [];
  const by = (rand) => rows.find((r) => r.rand === rand);
  const flag = (rand, cod, prefix) => {
    const r = by(rand); if (!r || r.tva.match) return;
    const sens = r.tva.delta > 0 ? 'mai mult decat ai declarat' : 'mai putin decat ai declarat';
    findings.push({ nivel: 'atentie', cod, mesaj: prefix + ': ANAF ' + r.tva.anaf + ' lei vs. tu ' + r.tva.propriu + ' lei (diferenta ' + (r.tva.delta > 0 ? '+' : '') + r.tva.delta + ' lei — ANAF vede ' + sens + ').' });
  };
  flag('R17', 'e-tva-colectata-diferita', 'Taxa colectata difera fata de decontul precompletat');
  flag('R27', 'e-tva-deductibila-diferita', 'Taxa deductibila difera fata de decontul precompletat');
  flag('R41', 'e-tva-plata-diferita', 'TVA de plata difera fata de decontul precompletat');
  flag('R42', 'e-tva-recuperat-diferita', 'TVA de recuperat difera fata de decontul precompletat');

  // avertisment de perioada: decontul precompletat e pentru alta luna decat cea comparata
  if (meta.period && /^\d{4}-\d{2}$/.test(meta.period) && meta.anafLuna && meta.anafAn) {
    const anafPer = meta.anafAn + '-' + String(meta.anafLuna).padStart(2, '0');
    if (anafPer !== meta.period) findings.push({ nivel: 'atentie', cod: 'e-tva-perioada',
      mesaj: 'Decontul precompletat e pentru ' + anafPer + ', dar l-ai comparat cu ' + meta.period + '. Verifica perioada.' });
  }
  // avertisment CUI: decontul e al altei firme
  if (meta.cuiPropriu && meta.anafCui && String(meta.cuiPropriu).replace(/^ro/i, '') !== String(meta.anafCui)) {
    findings.push({ nivel: 'eroare', cod: 'e-tva-cui', mesaj: 'CUI-ul din decontul precompletat (' + meta.anafCui + ') difera de firma activa (' + meta.cuiPropriu + ').' });
  }

  return { meta, rows, diffCount, ok: diffCount === 0 && findings.every((f) => f.nivel !== 'eroare'), findings };
}

module.exports = { parseD300, reconcile, ROWS };
