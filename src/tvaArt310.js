'use strict';

// Cifra de afaceri fiscala pentru regimul special al intreprinderilor mici (art. 310) NU este
// cifra de afaceri contabila si nu poate fi reconstruita doar din conturile 70x. Modulul pastreaza
// natura operatiei pe articol, calculeaza cronologic plafonul si refuza o concluzie atunci cand
// natura fiscala nu este documentata.

const fiscal = require('./fiscal');
const { round2, period: periodOf } = require('./util');

const EFFECTIVE_SAME_DAY = '2025-09-01';

const CATEGORIES = Object.freeze({
  taxable: Object.freeze({ included: true, label: 'Taxabila in Romania / taxabila daca nu s-ar aplica scutirea' }),
  exempt_with_deduction: Object.freeze({ included: true, label: 'Scutita cu drept de deducere' }),
  exempt_without_deduction_main: Object.freeze({ included: true, label: 'Scutita fara drept, art. 292 alin. (2) lit. a), b), e), f), neaccesorie' }),
  exempt_without_deduction_other: Object.freeze({ included: false, label: 'Alta operatiune scutita fara drept de deducere' }),
  outside_romania: Object.freeze({ included: false, label: 'Locul operatiunii este in afara Romaniei' }),
  fixed_asset_transfer: Object.freeze({ included: false, label: 'Livrare de activ fix corporal' }),
  intangible_asset_transfer: Object.freeze({ included: false, label: 'Cesiune/transfer de activ necorporal' }),
  advance: Object.freeze({ included: true, label: 'Avans facturat / exigibilitate intervenita; se regularizeaza la livrare' }),
  duplicate_document: Object.freeze({ included: false, label: 'Document ulterior fara o noua livrare/prestare' }),
  outside_scope: Object.freeze({ included: false, label: 'Operatiune in afara bazei art. 310' }),
});

// Natura vine din TIPUL OPERATIUNII, nu din cont. Doar cele trei tipuri din DYNAMIC_TYPES cer
// alegerea operatorului, fiindca acelasi formular poate corecta/documenta naturi fiscale diferite.
const STATIC_RULES = Object.freeze({
  factura_vanzare_marfuri: { category: 'taxable', field: 'baza' },
  factura_vanzare_produse: { category: 'taxable', field: 'baza' },
  factura_vanzare_servicii: { category: 'taxable', field: 'baza' },
  bon_fiscal_z: { category: 'taxable', field: 'baza' },
  factura_vanzare_incasare: { category: 'taxable', field: 'baza' },
  aviz_livrare: { category: 'taxable', field: 'baza' },
  facturare_aviz: { category: 'duplicate_document', field: 'baza' },
  factura_simplificata: { category: 'taxable', field: 'baza' },
  taxare_inversa_interna_livrare: { category: 'taxable', field: 'baza' },
  livrare_intracomunitara: { category: 'exempt_with_deduction', field: 'baza' },
  export_extracomunitar: { category: 'exempt_with_deduction', field: 'baza' },
  livrare_triunghiulara: { category: 'outside_romania', field: 'baza' },
  prestare_servicii_intracomunitara: { category: 'outside_romania', field: 'baza' },
  vanzare_mijloc_fix: { category: 'fixed_asset_transfer', field: 'pret' },
  factura_avans_client: { category: 'advance', field: 'baza', legacyAccounts: ['419'] },
  regularizare_avans_client: { category: 'advance', field: 'baza', sign: -1, legacyAccounts: ['419'] },
  scont_acordat: { category: 'outside_scope', field: 'suma' },
  imputare_lipsa: { category: 'taxable', field: 'valoareImputata', legacyAccounts: ['7588'] },
  horeca_vanzare: { category: 'taxable', fromLines: true },
  vanzare_regim_marja: { category: 'taxable', fromLines: true },
});

const DYNAMIC_TYPES = new Set([
  'factura_vanzare_valuta',
  'factura_storno_vanzare',
  'reducere_comerciala_acordata',
]);

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? round2(n) : 0;
}

/** Valoarea comerciala neta din liniile 70x, folosita NUMAI ca fallback pentru articole vechi
 *  al caror tip de operatie este cunoscut. Nu clasifica niciodata un articol dupa cont. */
function legacyCommercialAmount(lines, extraAccounts) {
  const extras = new Set(extraAccounts || []);
  let total = 0;
  for (const line of lines || []) {
    const suma = number(line.suma);
    const debit = String(line.debit || ''); const credit = String(line.credit || '');
    if (/^70/.test(credit) || extras.has(credit)) total = round2(total + suma);
    if (/^70/.test(debit) || extras.has(debit)) total = round2(total - suma);
  }
  return total;
}

function normalizeCategory(value) {
  const category = String(value || '');
  return CATEGORIES[category] ? category : null;
}

function snapshot(category, amount, source, extra) {
  category = normalizeCategory(category);
  if (!category) return Object.assign({ version: 1, category: 'review_required', included: null,
    amount: number(amount), source: source || 'unknown' }, extra || {});
  return Object.assign({ version: 1, category, included: CATEGORIES[category].included,
    amount: number(amount), source: source || 'document-form' }, extra || {});
}

function amountFromDocument(rule, fields, lines) {
  if (rule.fromLines) return legacyCommercialAmount(lines, rule.legacyAccounts);
  return round2(number(fields && fields[rule.field]) * (rule.sign || 1));
}

/** Fotografia legata de un document nou. Pentru tipurile ambigue, campul naturaTvaArt310 este
 *  obligatoriu semantic; lipsa lui ramane vizibila ca review_required si va bloca postarea. */
function fromDocument(tip, fields, lines) {
  const rule = STATIC_RULES[tip];
  if (rule) return snapshot(rule.category, amountFromDocument(rule, fields || {}, lines || []), 'document-form');
  if (!DYNAMIC_TYPES.has(tip)) return null;
  let amount = 0;
  if (tip === 'factura_vanzare_valuta') amount = round2(number(fields && fields.valuta) * number(fields && fields.curs));
  else amount = round2(number(fields && fields.baza) * (tip === 'factura_storno_vanzare' || tip === 'reducere_comerciala_acordata' ? -1 : 1));
  return snapshot(fields && fields.naturaTvaArt310, amount, 'document-form',
    normalizeCategory(fields && fields.naturaTvaArt310) ? null : { reason: 'Natura fiscala art. 310 nu a fost aleasa.' });
}

function relevantByLines(entry) {
  return (entry.lines || []).some((line) => /^70/.test(String(line.debit || ''))
    || /^70/.test(String(line.credit || '')) || String(line.credit || '') === '7588');
}

function normalizedStored(entry) {
  const stored = entry && entry.fiscalTaxonomy && entry.fiscalTaxonomy.tvaArt310;
  if (!stored || Number(stored.version) !== 1) return null;
  if (stored.category === 'review_required') return snapshot(null, stored.amount, stored.source || 'stored',
    { reason: stored.reason || 'Natura fiscala art. 310 necesita revizuire.' });
  const category = normalizeCategory(stored.category);
  if (!category) return snapshot(null, stored.amount, 'stored', { reason: 'Categorie art. 310 necunoscuta.' });
  return snapshot(category, stored.amount, stored.source || 'stored');
}

/** Clasifica un articol existent. Articolele istorice primesc fallback NUMAI dupa tipul de
 *  document. O nota libera pe 70x ramane neclasificata, chiar daca soldul pare un venit. */
function classifyEntry(entry, byId) {
  const stored = normalizedStored(entry);
  if (stored) return stored;

  if (entry && entry.tip === 'storno') {
    const original = byId && byId.get(String(entry.stornoOf));
    if (!original) return snapshot(null, legacyCommercialAmount(entry.lines), 'legacy-storno',
      { reason: 'Nota storno nu are articolul original disponibil pentru mostenirea naturii art. 310.' });
    const base = classifyEntry(original, byId);
    if (!base) return null; // stornul unei operatiuni fara legatura cu art. 310 ramane in afara bazei
    if (base.category === 'review_required') return snapshot(null, -number(base.amount), 'legacy-storno',
      { reason: 'Articolul original al stornului nu are natura art. 310 clasificata.' });
    return snapshot(base.category, -number(base.amount), 'storno-inherited');
  }

  const rule = STATIC_RULES[entry && entry.tip];
  if (rule) {
    const amount = legacyCommercialAmount(entry.lines, rule.legacyAccounts);
    // Pentru o operatie inclusa, lipsa valorii din liniile istorice inseamna ca nu putem pretinde
    // un calcul exact (de exemplu un cont de venit personalizat, altul decat 70x).
    if (CATEGORIES[rule.category].included && amount === 0 && (entry.lines || []).length) {
      return snapshot(null, 0, 'legacy-document-type',
        { reason: 'Valoarea fiscala a articolului istoric nu poate fi reconstruita exact.' });
    }
    return snapshot(rule.category, amount, 'legacy-document-type');
  }
  if (DYNAMIC_TYPES.has(entry && entry.tip)) return snapshot(null, legacyCommercialAmount(entry.lines), 'legacy-document-type',
    { reason: 'Tipul istoric poate avea mai multe tratamente art. 310; este necesara clasificarea.' });
  if (relevantByLines(entry)) return snapshot(null, legacyCommercialAmount(entry.lines), 'unclassified-operation',
    { reason: 'Exista rulaj comercial, dar natura operatiei art. 310 nu este documentata.' });
  return null;
}

function clientCategories() {
  return Object.entries(CATEGORIES).map(([code, value]) => ({ code, label: value.label,
    included: value.included }));
}

function normalizeManual(value) {
  value = value || {};
  const category = normalizeCategory(value.category);
  if (!category) {
    const error = new Error('Categoria art. 310 nu este valida.'); error.status = 400; throw error;
  }
  const rawAmount = Number(value.amount);
  if (!Number.isFinite(rawAmount)) {
    const error = new Error('Valoarea fiscala art. 310 trebuie sa fie un numar finit.'); error.status = 400; throw error;
  }
  const reason = String(value.reason || '').trim();
  if (reason.length < 5) {
    const error = new Error('Clasificarea art. 310 cere o justificare de minimum 5 caractere.'); error.status = 400; throw error;
  }
  return snapshot(category, rawAmount, 'manual-review', { reason: reason.slice(0, 500) });
}

function thresholdAt(data, fallback) {
  try {
    const value = Number(fiscal.rulesAt(data).rates.plafonScutireTvaLei);
    return value > 0 ? value : number(fallback);
  } catch (_) { return number(fallback); }
}

function crossingPolicy(data) {
  if (data >= EFFECTIVE_SAME_DAY) return {
    regime: 'same_day', registrationDeadline: data, normalRegimeDate: data,
    crossingTransactionTaxable: true,
  };
  if (data >= '2025-08-01' && data <= '2025-08-31') return {
    regime: 'og22_transition_august', registrationDeadline: '2025-09-10', normalRegimeDate: '2025-09-10',
    crossingTransactionTaxable: false,
  };
  return { regime: 'historical_rule', registrationDeadline: null, normalRegimeDate: null,
    crossingTransactionTaxable: false };
}

function operationThreshold(data, fallback) {
  // Art. III OG 22/2025 suspenda efectul depasirii vechiului plafon de 300.000 lei in august;
  // in acea luna se urmareste direct plafonul nou de 395.000 lei.
  if (data >= '2025-08-01' && data <= '2025-08-31') return 395000;
  return thresholdAt(data, fallback);
}

function usesLegacyBasis(data) {
  // Pentru depasirile produse anterior lunii august 2025 se aplica definitia art. 310 de atunci,
  // care includea operatiunile economice cu locul in strainatate daca taxa ar fi fost deductibila
  // in Romania. Tranzitia din august recalculeaza plafonul de 395.000 pe definitia noua.
  return String(data || '') < '2025-08-01';
}

function includedInLegacyBasis(op) {
  if (op.category === 'outside_romania') return true;
  return op.included === true;
}

function compareOperations(a, b) {
  const dateCmp = String(a.entry.data || '').localeCompare(String(b.entry.data || ''));
  if (dateCmp) return dateCmp;
  // Regularizarea avansului este parte din factura finala, nu o livrare ulterioara. Aplicata
  // dupa baza integrala a facturii ar crea o depasire tranzitorie fictiva in aceeasi zi.
  const priority = (row) => row.entry.tip === 'regularizare_avans_client' ? -1 : 0;
  const priorityCmp = priority(a) - priority(b);
  if (priorityCmp) return priorityCmp;
  // `createdAt` lipseste pe articolele istorice. Il folosim numai daca exista pe AMBELE; altfel
  // ordinea append-only din registru este singura dovada disponibila si trebuie pastrata stabil.
  if (a.entry.createdAt && b.entry.createdAt) {
    const createdCmp = String(a.entry.createdAt).localeCompare(String(b.entry.createdAt));
    if (createdCmp) return createdCmp;
  }
  return a.index - b.index;
}

/** Calcul cronologic, operatie cu operatie. Daca exista o operatie neclasificata, `complete=false`
 *  si nu se emite o data de depasire posibil falsa. */
function analyze(entries, year, opts) {
  opts = opts || {};
  year = String(year || new Date().getFullYear());
  const all = Array.isArray(entries) ? entries : [];
  const byId = new Map(all.filter((e) => e && e.id != null).map((e) => [String(e.id), e]));
  const rows = all.map((entry, index) => ({ entry, index }))
    .filter((row) => row.entry && (row.entry.status == null || row.entry.status === 'postat')
      && String(row.entry.period || periodOf(row.entry.data)).startsWith(year))
    .sort(compareOperations);
  const unresolved = []; const operations = [];
  for (const row of rows) {
    const cls = classifyEntry(row.entry, byId);
    if (!cls) continue;
    const op = {
      entryId: row.entry.id == null ? null : row.entry.id,
      data: String(row.entry.data || ''), document: row.entry.document || '', tip: row.entry.tip || '',
      category: cls.category, included: cls.included, amount: number(cls.amount), source: cls.source,
    };
    operations.push(op);
    if (cls.category === 'review_required') unresolved.push(Object.assign({}, op, { reason: cls.reason || 'Clasificare lipsa.' }));
    // In vechea redactare, activele fixe/necorporale erau excluse numai daca erau accesorii
    // activitatii principale. Tipul documentului nu poate dovedi aceasta conditie; se cere o
    // reclasificare manuala ca `taxable` (neaccesorie) sau `outside_scope` (accesorie).
    else if (usesLegacyBasis(op.data)
      && (op.category === 'fixed_asset_transfer' || op.category === 'intangible_asset_transfer')) {
      unresolved.push(Object.assign({}, op, {
        reason: 'Pentru data istorica trebuie stabilit daca cedarea activului era accesorie activitatii principale.',
      }));
    }
  }

  const fallbackThreshold = number(opts.threshold) || thresholdAt(year + '-12-31', 0);
  if (unresolved.length) return { year, threshold: fallbackThreshold, total: null, complete: false,
    crossing: null, unresolved, operations };

  let currentTotal = 0; let legacyTotal = 0; let crossing = null;
  for (const op of operations) {
    const legacyBefore = legacyTotal; const currentBefore = currentTotal;
    if (includedInLegacyBasis(op)) legacyTotal = round2(legacyTotal + op.amount);
    if (op.included) currentTotal = round2(currentTotal + op.amount);
    const legacy = usesLegacyBasis(op.data);
    const before = legacy ? legacyBefore : currentBefore;
    const after = legacy ? legacyTotal : currentTotal;
    const threshold = operationThreshold(op.data, fallbackThreshold);
    if (!crossing && threshold > 0 && before <= threshold && after > threshold) {
      crossing = Object.assign({ entryId: op.entryId, data: op.data, document: op.document, tip: op.tip,
        operationAmount: op.amount, totalBefore: before, totalAfter: after,
        threshold, excess: round2(after - threshold), basisVersion: legacy ? 'legacy' : 'og22-2025' }, crossingPolicy(op.data));
    }
  }
  const total = Number(year) < 2025 ? legacyTotal : currentTotal;
  return { year, threshold: fallbackThreshold, total, complete: true, crossing, unresolved, operations };
}

function postingError(message, code, details) {
  const error = new Error(message); error.status = 409; error.code = code; error.details = details; return error;
}

/** Garda operationala: tranzactia care depaseste plafonul nu poate fi postata sub profil de
 *  neplatitor. Ciorna ramane permisa; dupa revizia profilului TVA se reia postarea cu regimul corect. */
function assertCanPost(view, candidate, profile) {
  // Codul TVA anulat are propriul regim si propria declaratie D311; nu este regimul special de
  // scutire pentru mici intreprinderi, chiar daca `tvaPlatitor` este normalizat la false.
  if (!candidate || (profile && (profile.tvaPlatitor || profile.tvaCodAnulat))) return;
  const cls = classifyEntry(candidate, new Map((view && view.entries || []).filter((e) => e && e.id != null)
    .map((e) => [String(e.id), e])));
  if (!cls || cls.included === false) return;
  if (cls.category === 'review_required') throw postingError(
    'Postarea este blocata: alege natura operatiei pentru cifra de afaceri fiscala art. 310.',
    'TVA_ART310_REVIEW_REQUIRED', { entryId: candidate.id || null });
  if (number(cls.amount) <= 0) return;

  const existing = (view && view.entries || []).filter((e) => String(e.id) !== String(candidate.id));
  const candidatePosted = Object.assign({}, candidate, { status: 'postat' });
  const result = analyze(existing.concat(candidatePosted), String(candidate.data || candidate.period || '').slice(0, 4));
  if (!result.complete) throw postingError(
    'Postarea este blocata: exista operatiuni neclasificate in baza fiscala art. 310; revizuieste-le inainte de o noua livrare.',
    'TVA_ART310_REVIEW_REQUIRED', { unresolved: result.unresolved });
  if (!result.crossing || result.crossing.regime !== 'same_day') return;

  const c = result.crossing;
  throw postingError('Postarea este blocata: plafonul TVA de ' + c.threshold + ' lei este depasit la data de '
    + c.data + ' prin operatiunea ' + (c.document || c.entryId || c.tip) + '. Inregistrarea in scopuri de TVA '
    + 'trebuie solicitata cel tarziu la data depasirii, iar regimul normal se aplica incepand cu aceasta tranzactie. '
    + 'Actualizeaza profilul fiscal cu efect din ' + c.data + ' si reia postarea.',
  'TVA_THRESHOLD_REGISTRATION_REQUIRED', c);
}

module.exports = {
  CATEGORIES, STATIC_RULES, DYNAMIC_TYPES, EFFECTIVE_SAME_DAY,
  fromDocument, classifyEntry, analyze, assertCanPost, snapshot, legacyCommercialAmount,
  clientCategories, normalizeManual,
};
