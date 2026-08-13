'use strict';

// D107 — beneficiarii sponsorizărilor/mecenatului, formular anual pentru plătitorii de
// impozit pe profit. Contabilitatea păstrează sumele în 6582; aici le individualizăm pe CUI,
// reconstruim reportul pe vintage-uri și alocăm FIFO creditul fiscal efectiv folosit.

const acc = require('./accounting');
const identitate = require('./identitate');
const fiscal = require('./fiscalConfig');
const { period: periodOf } = require('./util');

const CONT = '6582';
const TIP_DOCUMENT = 'sponsorizare_mecenat_d107';

function lei(v) { return Math.round(Number(v) || 0); }
function cuiKey(v) { return identitate.cuiKey(v); }
function validCod(v) { return identitate.validCUI(v) || identitate.validCNP(v); }

function partner(view, cui) {
  const ps = (view && view.partners) || {};
  if (Array.isArray(ps)) return ps.find((p) => cuiKey(p.cui || p.cnp) === cui) || {};
  return ps[cui] || ps['RO' + cui] || {};
}

/** Sponsorizările pozitive ale unui an, păstrate ca bucket-uri distincte pentru alocarea FIFO. */
function grants(view, year) {
  const out = [];
  for (const e of acc.postedEntries(view || {})) {
    if (e.stornat || !String(e.period || periodOf(e.data)).startsWith(String(year))) continue;
    const suma = lei((e.lines || []).reduce((s, l) => {
      const d = String(l.debit || ''); const c = String(l.credit || '');
      return s + (d.startsWith(CONT) ? Number(l.suma) || 0 : 0)
        - (c.startsWith(CONT) ? Number(l.suma) || 0 : 0);
    }, 0));
    if (suma <= 0) continue;
    const cui = cuiKey(e.partenerCui);
    const p = partner(view, cui);
    out.push({
      an: Number(year), data: String(e.data || year + '-12-31'), cui,
      den: String(e.partener || p.den || '').trim(), adresa: String(p.adresa || '').trim(),
      suma, source: String(e.id || e.document || out.length + 1),
    });
  }
  return out;
}

function sortBuckets(rows) {
  return rows.slice().sort((a, b) => Number(a.an) - Number(b.an)
    || String(a.data || '').localeCompare(String(b.data || ''))
    || String(a.cui || '').localeCompare(String(b.cui || ''))
    || String(a.source || '').localeCompare(String(b.source || '')));
}

/** Consumă o sumă FIFO și întoarce atât resturile, cât și alocarea pe beneficiar. */
function consume(rows, amount) {
  let ramas = Math.max(0, lei(amount));
  const used = new Map();
  const reportNou = [];
  for (const src of sortBuckets(rows)) {
    const b = Object.assign({}, src, { suma: Math.max(0, lei(src.suma)) });
    const ia = Math.min(ramas, b.suma);
    ramas -= ia;
    if (ia) used.set(b.cui, (used.get(b.cui) || 0) + ia);
    b.suma -= ia;
    if (b.suma > 0) reportNou.push(b);
  }
  return { folosit: Math.max(0, lei(amount) - ramas), nealocat: ramas, used, reportNou };
}

function taxUsed(view, year) {
  const e = acc.postedEntries(view || {}).find((x) => !x.stornat && x.tip === 'impozit_profit'
    && String(x.period || '') === String(year) + '-12' && x.rezultatFiscal);
  if (e && e.rezultatFiscal.sponsorizare) return lei(e.rezultatFiscal.sponsorizare.folosit);
  const h = view && view.company && view.company.d107Istoric;
  return lei(h && h[year] && h[year].folosit);
}

/** Reface reportul de la începutul anului din sponsorizări și închiderile anilor anteriori. */
function reconstructOpening(view, year) {
  const maxAni = Number(fiscal.RATES.sponsorizareReportAni || 7);
  let buckets = [];
  for (let y = Math.max(2018, Number(year) - maxAni); y < Number(year); y++) {
    buckets = buckets.filter((b) => y - Number(b.an) < maxAni);
    buckets.push(...grants(view, y));
    buckets = consume(buckets, taxUsed(view, y)).reportNou;
  }
  return buckets.filter((b) => Number(year) - Number(b.an) < maxAni);
}

function identityErrors(view, rows) {
  const errors = [];
  for (const r of rows) {
    const p = partner(view, r.cui);
    r.den = String(r.den || p.den || '').trim();
    r.adresa = String(p.adresa || r.adresa || '').trim();
    if (!validCod(r.cui)) errors.push((r.den || 'Beneficiar') + ': cod fiscal invalid sau lipsă.');
    if (!r.den) errors.push((r.cui || 'Beneficiar') + ': denumire lipsă.');
    if (!r.adresa) errors.push((r.den || r.cui || 'Beneficiar') + ': adresă lipsă în Parteneri.');
  }
  return errors;
}

function finalize(view, raw) {
  const rows = (raw.rows || []).map((r) => Object.assign({}, r));
  const errors = (raw.financialErrors || []).slice().concat(identityErrors(view, rows));
  return Object.assign({}, raw, { rows, errors });
}

/**
 * Construiește declarația anuală. `pt` este rezultatul fiscal folosit și de D101/închidere;
 * astfel Val3 nu se recalculează cu alte opțiuni decât impozitul efectiv înregistrat.
 */
function report(view, year, pt, opts) {
  opts = opts || {};
  year = String(year);
  const company = (view && view.company) || {};
  const saved = company.d107Istoric && company.d107Istoric[year];
  if (saved && !opts.ignoreHistory) return finalize(view, saved);

  const sponsor = pt && pt.sponsorizare;
  const financialErrors = [];
  if (!sponsor) financialErrors.push('Calculul fiscal al sponsorizării lipsește; finalizează calculul impozitului pe profit.');
  const current = grants(view, year);
  const totalCurent = current.reduce((s, b) => s + b.suma, 0);
  const expectedOpening = Math.max(0, lei((sponsor && sponsor.disponibil) || 0) - totalCurent);
  const detailed = Array.isArray(company.sponsorizareReportDetaliat)
    ? company.sponsorizareReportDetaliat.map((b) => Object.assign({}, b, { suma: lei(b.suma) })) : [];
  const reconstructed = reconstructOpening(view, year);
  const sum = (a) => a.reduce((s, b) => s + lei(b.suma), 0);
  let opening = sum(detailed) === expectedOpening ? detailed : reconstructed;
  if (sum(opening) !== expectedOpening) {
    financialErrors.push('Reportul de sponsorizare individualizat (' + sum(opening)
      + ' lei) nu corespunde reportului fiscal (' + expectedOpening
      + ' lei). Completează istoricul pe beneficiari înainte de D107.');
    opening = detailed.length ? detailed : reconstructed;
  }

  const totalFolosit = lei((sponsor && sponsor.folosit) || 0);
  const consumed = consume(opening.concat(current), totalFolosit);
  if (consumed.nealocat) financialErrors.push('Creditul fiscal folosit depășește sponsorizările individualizate cu ' + consumed.nealocat + ' lei.');

  const by = new Map();
  const add = (b, camp) => {
    const key = b.cui || ('fara-cui:' + b.source);
    const r = by.get(key) || { cui: b.cui, den: b.den, adresa: b.adresa, val1: 0, val2: 0, val3: 0 };
    r[camp] += lei(b.suma);
    if (!r.den && b.den) r.den = b.den;
    if (!r.adresa && b.adresa) r.adresa = b.adresa;
    by.set(key, r);
  };
  opening.forEach((b) => add(b, 'val2'));
  current.forEach((b) => add(b, 'val1'));
  for (const [cui, used] of consumed.used) {
    const r = by.get(cui) || { cui, den: '', adresa: '', val1: 0, val2: 0, val3: 0 };
    r.val3 += used; by.set(cui, r);
  }
  const rows = [...by.values()].filter((r) => r.val1 || r.val2 || r.val3)
    .sort((a, b) => String(a.den || a.cui).localeCompare(String(b.den || b.cui), 'ro'));
  const totals = rows.reduce((t, r) => ({ val1: t.val1 + r.val1, val2: t.val2 + r.val2, val3: t.val3 + r.val3 }), { val1: 0, val2: 0, val3: 0 });
  const raw = {
    year, rows, totals, folosit: totalFolosit, reportNou: consumed.reportNou,
    totalPlata: totals.val1 + totals.val2 + totals.val3,
    nr: rows.length, nrArticole: current.length, financialErrors,
  };
  return finalize(view, raw);
}

function hasOperations(view, year) {
  if (grants(view, year).length) return true;
  return ((view && view.company && view.company.sponsorizareReport) || []).some((r) => lei(r.suma) > 0);
}

module.exports = { CONT, TIP_DOCUMENT, grants, consume, reconstructOpening, report, hasOperations };
