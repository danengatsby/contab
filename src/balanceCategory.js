'use strict';

// Categoria situatiilor financiare este o incadrare CONTABILA, nu fiscala. Modulul nu citeste
// `regimImpozit` si nu importa fiscalProfile: singurele intrari sunt indicatorii de marime,
// istoricul anual al deciziilor si categoria-contabila oglindita pe firma pentru prima incadrare.

const crypto = require('crypto');
const statements = require('./statements');
const payrollHistory = require('./payrollHistory');
const { round2 } = require('./util');

const CATEGORIES = ['micro', 'mic', 'mare'];
const LABELS = {
  micro: 'microentitate',
  mic: 'entitate mica',
  mare: 'entitate mijlocie/mare',
};

// OMF 4164/2024 se aplica incepand cu situatiile financiare anuale aferente exercitiului 2024.
// Pentru exercitiile anterioare pastram pragurile OMFP 1802 valabile pana la acea modificare.
const THRESHOLD_VERSIONS = [
  {
    validFromYear: 2024,
    basis: 'OMF 4164/2024; OMFP 1802/2014 pct. 9 si 12',
    micro: { totalActive: 2250000, cifraAfaceri: 4500000, numarMediuSalariati: 10 },
    small: { totalActive: 25000000, cifraAfaceri: 50000000, numarMediuSalariati: 50 },
  },
  {
    validFromYear: 2015,
    basis: 'OMFP 1802/2014, pragurile aplicabile anterior OMF 4164/2024',
    micro: { totalActive: 1500000, cifraAfaceri: 3000000, numarMediuSalariati: 10 },
    small: { totalActive: 17500000, cifraAfaceri: 35000000, numarMediuSalariati: 50 },
  },
];

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

function yearOf(value) {
  const y = Number(String(value || ''));
  if (!Number.isInteger(y) || y < 2015 || y > 2100) fail(400, 'An invalid pentru categoria de bilant.');
  return y;
}

function reportingYearOf(value) {
  const year = yearOf(value);
  if (year < 2016) fail(400, 'Calculul pe două exerciții este disponibil începând cu anul 2016.');
  return year;
}

function thresholdsFor(value) {
  const year = yearOf(value);
  const found = THRESHOLD_VERSIONS.find((x) => year >= x.validFromYear);
  return Object.assign({ year }, found, {
    micro: Object.assign({}, found.micro), small: Object.assign({}, found.small),
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonical(value[key]);
  return out;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function activeRows(history) {
  return (history || []).filter((x) => x && !x.supersededBy && !x.supersededAt);
}

function confirmationFor(history, value) {
  const year = String(yearOf(value));
  return activeRows(history).filter((x) => String(x.year) === year)
    .sort((a, b) => String(a.confirmedAt || '').localeCompare(String(b.confirmedAt || ''))).slice(-1)[0] || null;
}

function previousConfirmation(history, value) {
  const year = yearOf(value);
  return activeRows(history).filter((x) => Number(x.year) < year)
    .sort((a, b) => Number(b.year) - Number(a.year)
      || String(b.confirmedAt || '').localeCompare(String(a.confirmedAt || '')))[0] || null;
}

function payrollEvidence(view, year) {
  const snaps = payrollHistory.activeSnapshots(view.payrollHistory || [], view.entries || [])
    .filter((x) => String(x.period || '').startsWith(String(year) + '-'))
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));
  return snaps.map((x) => ({
    period: String(x.period),
    snapshotId: x.id || null,
    entryId: x.entryId || null,
    employees: Array.isArray(x.rows) ? x.rows.length : null,
  }));
}

/** Numarul mediu este calculat din fotografiile LUNARE postate. Mai putin de 12 luni inseamna
 *  sursa incompleta, nu zero. Exceptie: firma fara angajati si fara nicio fotografie salariala. */
function averageEmployees(view, value, override) {
  const year = yearOf(value);
  const evidence = payrollEvidence(view, year);
  const numericOverride = override === '' || override == null ? null : Number(override);
  if (numericOverride != null) {
    if (!Number.isFinite(numericOverride) || numericOverride < 0 || numericOverride > 1000000) {
      fail(400, 'Numarul mediu de salariati confirmat trebuie sa fie un numar intre 0 si 1.000.000.');
    }
    return {
      value: round2(numericOverride), complete: true, source: 'confirmat-manual',
      coveredMonths: evidence.length, monthlyEvidence: evidence,
    };
  }
  if (evidence.length === 12 && evidence.every((x) => Number.isFinite(x.employees))) {
    return {
      value: round2(evidence.reduce((s, x) => s + x.employees, 0) / 12),
      complete: true, source: 'state-plata-postate', coveredMonths: 12, monthlyEvidence: evidence,
    };
  }
  if (!evidence.length && !(view.angajati || []).length) {
    return { value: 0, complete: true, source: 'fara-salariati-inregistrati', coveredMonths: 0, monthlyEvidence: [] };
  }
  return { value: null, complete: false, source: 'state-plata-incomplete', coveredMonths: evidence.length, monthlyEvidence: evidence };
}

function indicators(view, value, opts) {
  const year = yearOf(value);
  const o = opts || {};
  const bs = statements.balanceSheetF10(view, String(year) + '-12');
  const pl = statements.profitLossF20(view, String(year));
  const employees = averageEmployees(view, year, o.averageEmployees);
  return {
    year: String(year),
    totalActive: round2(bs.totalActiv),
    cifraAfaceri: round2(pl.cifraAfaceri),
    numarMediuSalariati: employees.value,
    employeesComplete: employees.complete,
    employeesSource: employees.source,
    payrollMonths: employees.coveredMonths,
    payrollEvidence: employees.monthlyEvidence,
  };
}

/** Cel putin doua dintre trei criterii trebuie sa fie sub/egale cu pragul. `null` inseamna ca
 *  indicatorul salarial lipsa poate schimba raspunsul si incadrarea automata nu este completa. */
function withinBoundary(ind, limits) {
  const values = [
    [ind.totalActive, limits.totalActive],
    [ind.cifraAfaceri, limits.cifraAfaceri],
    [ind.numarMediuSalariati, limits.numarMediuSalariati],
  ];
  let within = 0; let above = 0; let unknown = 0;
  for (const [value, limit] of values) {
    if (value == null || !Number.isFinite(Number(value))) unknown += 1;
    else if (Number(value) <= limit) within += 1;
    else above += 1;
  }
  return { result: within >= 2 ? true : above >= 2 ? false : null, within, above, unknown };
}

function rawClassification(ind, thresholds) {
  const micro = withinBoundary(ind, thresholds.micro);
  const small = withinBoundary(ind, thresholds.small);
  let category = null;
  if (micro.result === true) category = 'micro';
  else if (micro.result === false && small.result === true) category = 'mic';
  else if (small.result === false) category = 'mare';
  return { category, micro, small, complete: !!category };
}

function rank(category) { return CATEGORIES.indexOf(category); }

/** Aplica separat fiecare frontiera de marime pe doua exercitii consecutive. De exemplu, o firma
 *  micro cu rezultat brut `mic` apoi `mare` depaseste pragul micro in ambii ani, deci trece cel
 *  putin la `mic`; nu este necesar ca eticheta bruta a celor doi ani sa fie identica. */
function twoYearCategory(baseCategory, previousRaw, currentRaw) {
  const base = rank(baseCategory); const prev = rank(previousRaw); const cur = rank(currentRaw);
  if (base < 0 || prev < 0 || cur < 0) return baseCategory || currentRaw || null;
  if (base === 0) {
    if (prev >= 2 && cur >= 2) return 'mare';
    if (prev >= 1 && cur >= 1) return 'mic';
    return 'micro';
  }
  if (base === 1) {
    if (prev >= 2 && cur >= 2) return 'mare';
    if (prev === 0 && cur === 0) return 'micro';
    return 'mic';
  }
  if (prev === 0 && cur === 0) return 'micro';
  if (prev <= 1 && cur <= 1) return 'mic';
  return 'mare';
}

function assess(view, value, opts) {
  const year = reportingYearOf(value); const o = opts || {};
  const history = view.balanceCategoryHistory || view.balance_category_history || [];
  const currentThresholds = thresholdsFor(year);
  const previousThresholds = thresholdsFor(year - 1);
  const previousRecord = previousConfirmation(history, year);
  const previousYearRecord = confirmationFor(history, year - 1);
  const currentIndicators = indicators(view, year, { averageEmployees: o.averageEmployees });
  const previousIndicators = indicators(view, year - 1, {
    averageEmployees: previousYearRecord && previousYearRecord.indicatorOverrides
      ? previousYearRecord.indicatorOverrides.numarMediuSalariati : null,
  });
  const currentClassification = rawClassification(currentIndicators, currentThresholds);
  const previousClassification = rawClassification(previousIndicators, previousThresholds);
  const mirror = CATEGORIES.includes(String(view.company && view.company.categorieRaportare || ''))
    ? String(view.company.categorieRaportare) : null;
  const baseCategory = previousRecord && CATEGORIES.includes(previousRecord.category)
    ? previousRecord.category : mirror;
  let recommendedCategory = currentClassification.category;
  let recommendationBasis = 'incadrare-initiala';
  if (baseCategory) {
    recommendedCategory = twoYearCategory(baseCategory,
      previousClassification.category, currentClassification.category);
    recommendationBasis = previousRecord ? 'ultima-confirmare-si-doua-exercitii' : 'categorie-oglinda-si-doua-exercitii';
  }
  if (!recommendedCategory && baseCategory) {
    recommendedCategory = baseCategory;
    recommendationBasis = 'date-incomplete-pastreaza-categoria';
  }
  const calculationComplete = !!currentClassification.category && !!previousClassification.category;
  const reasons = [];
  if (!currentIndicators.employeesComplete) reasons.push('Numarul mediu de salariati pentru ' + year + ' nu poate fi calculat din 12 state lunare postate.');
  if (!previousIndicators.employeesComplete) reasons.push('Numarul mediu de salariati pentru ' + (year - 1) + ' nu poate fi calculat din 12 state lunare postate.');
  if (!currentClassification.category) reasons.push('Indicatorii cunoscuti nu sunt suficienti pentru incadrarea automata a anului ' + year + '.');
  if (!previousClassification.category) reasons.push('Indicatorii cunoscuti nu sunt suficienti pentru aplicarea automata a regulii celor doua exercitii.');
  const facts = {
    year: String(year), currentThresholds, previousThresholds,
    currentIndicators, previousIndicators,
    currentRawCategory: currentClassification.category,
    previousRawCategory: previousClassification.category,
    base: previousRecord ? { id: previousRecord.id, year: previousRecord.year, category: previousRecord.category } : { id: null, year: null, category: baseCategory },
    recommendedCategory, recommendationBasis,
    indicatorOverrides: { numarMediuSalariati: o.averageEmployees === '' || o.averageEmployees == null ? null : round2(Number(o.averageEmployees)) },
  };
  return Object.assign({}, facts, {
    currentClassification, previousClassification, calculationComplete, reasons,
    inputHash: hash(facts),
    labels: LABELS,
  });
}

function validateConfirmation(view, value) {
  const year = reportingYearOf(value);
  const history = view.balanceCategoryHistory || view.balance_category_history || [];
  const confirmation = confirmationFor(history, year);
  if (!confirmation) {
    fail(409, 'Bilanțul pentru ' + year + ' este blocat: categoria contabilă nu a fost confirmată pentru acest exercițiu. '
      + 'Verifică indicatorii și confirmă în Setări → Firmă → Situații financiare anuale.');
  }
  const override = confirmation.indicatorOverrides && confirmation.indicatorOverrides.numarMediuSalariati;
  const assessment = assess(view, year, { averageEmployees: override });
  if (confirmation.inputHash !== assessment.inputHash) {
    fail(409, 'Bilanțul pentru ' + year + ' este blocat: activele, cifra de afaceri, statele de plată '
      + 'sau istoricul categoriei s-au schimbat după confirmare. Reconfirmă încadrarea anuală.');
  }
  if (!CATEGORIES.includes(confirmation.category)) fail(409, 'Confirmarea categoriei de bilanț este invalidă. Reconfirmă exercițiul.');
  if (confirmation.category !== assessment.recommendedCategory && String(confirmation.justification || '').trim().length < 10) {
    fail(409, 'Categoria aleasă contrazice încadrarea calculată și nu are o justificare documentată.');
  }
  return { confirmation, assessment, category: confirmation.category };
}

function buildConfirmation(view, body, actor, id, permissionRole) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const year = yearOf(b.year);
  const category = String(b.category || '').trim().toLowerCase();
  if (!CATEGORIES.includes(category)) fail(400, 'Alege categoria: microentitate, entitate mica sau entitate mijlocie/mare.');
  const justification = String(b.justification || '').trim();
  const override = b.numarMediuSalariati === '' || b.numarMediuSalariati == null ? null : b.numarMediuSalariati;
  const assessment = assess(view, year, { averageEmployees: override });
  const deviates = category !== assessment.recommendedCategory;
  if ((deviates || !assessment.calculationComplete) && justification.length < 10) {
    fail(400, deviates
      ? 'Categoria aleasă diferă de încadrarea calculată. Completează o justificare de cel puțin 10 caractere.'
      : 'Calculul automat are date incomplete. Completează o justificare de cel puțin 10 caractere.');
  }
  const confirmedAt = new Date().toISOString();
  return {
    id, firmaId: Number(view.firmaId), year: String(year), category,
    calculatedCategory: assessment.recommendedCategory,
    rawCategory: assessment.currentRawCategory,
    previousRawCategory: assessment.previousRawCategory,
    indicators: assessment.currentIndicators,
    previousIndicators: assessment.previousIndicators,
    thresholds: assessment.currentThresholds,
    inputHash: assessment.inputHash,
    justification,
    indicatorOverrides: assessment.indicatorOverrides,
    confirmedAt,
    confirmedBy: actor && actor.id != null ? actor.id : null,
    confirmedByUsername: actor && actor.username || '',
    confirmedRole: permissionRole || '',
  };
}

module.exports = {
  CATEGORIES, LABELS, THRESHOLD_VERSIONS, thresholdsFor, averageEmployees, indicators,
  withinBoundary, rawClassification, twoYearCategory, assess, activeRows, confirmationFor,
  previousConfirmation, validateConfirmation, buildConfirmation, hash,
};
