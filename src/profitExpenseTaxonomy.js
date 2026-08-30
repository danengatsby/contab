'use strict';

// Tratamentul fiscal al conturilor 635, 6581 si 654 nu se poate deduce din numarul contului.
// Acelasi cont poarta operatiuni deductibile, limitat deductibile si nedeductibile. Clasificarea
// sta de aceea pe LINIA articolului contabil si pastreaza natura, temeiul, justificarea si dovezile.

const { round2 } = require('./util');

const ACCOUNTS = Object.freeze(['635', '6581', '654']);

const CATEGORIES = Object.freeze({
  635: Object.freeze({
    business_tax: Object.freeze({ label: 'Impozit/taxa aferenta activitatii economice — deductibila', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (1) Cod fiscal' }),
    vat_business_adjustment: Object.freeze({ label: 'Ajustare TVA aferenta activitatii economice — deductibila', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (1) Cod fiscal' }),
    vehicle_exclusive: Object.freeze({ label: 'Taxa auto/drum — utilizare exclusiv economica', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (1) si alin. (3) lit. l) Cod fiscal' }),
    vehicle_mixed: Object.freeze({ label: 'Taxa auto/drum — utilizare mixta, 50% deductibila', pctNedeductibil: 50, legalBasis: 'Art. 25 alin. (3) lit. l) Cod fiscal' }),
    nondeductible_tax: Object.freeze({ label: 'Impozit/taxa expres nedeductibila', pctNedeductibil: 100, legalBasis: 'Art. 25 alin. (4) lit. a) Cod fiscal' }),
  }),
  6581: Object.freeze({
    public_authority_sanction: Object.freeze({ label: 'Amenda/penalitate legala (necontractuala) datorata unei autoritati — nedeductibila', pctNedeductibil: 100, legalBasis: 'Art. 25 alin. (4) lit. b) Cod fiscal' }),
    contractual_penalty_business: Object.freeze({ label: 'Penalitate contractuala aferenta activitatii (inclusiv contract cu o autoritate) — deductibila', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (1) si alin. (4) lit. b) Cod fiscal' }),
    business_compensation: Object.freeze({ label: 'Despagubire aferenta activitatii economice — deductibila', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (1) Cod fiscal' }),
    non_business_compensation: Object.freeze({ label: 'Despagubire fara scop economic — nedeductibila', pctNedeductibil: 100, legalBasis: 'Art. 25 alin. (1) Cod fiscal' }),
  }),
  654: Object.freeze({
    general_bad_debt: Object.freeze({ label: 'Creanta scoasa din evidenta fara exceptie legala — nedeductibila', pctNedeductibil: 100, legalBasis: 'Art. 25 alin. (4) lit. h) Cod fiscal' }),
    reorganization_plan: Object.freeze({ label: 'Plan de reorganizare confirmat prin hotarare judecatoreasca', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (4) lit. h) Cod fiscal', evidenceRequired: true }),
    bankruptcy_closed: Object.freeze({ label: 'Faliment inchis prin hotarare judecatoreasca', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (4) lit. h) Cod fiscal', evidenceRequired: true }),
    deceased_no_heirs: Object.freeze({ label: 'Debitor decedat, creanta nerecuperabila de la mostenitori', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (4) lit. h) Cod fiscal', evidenceRequired: true }),
    dissolved_without_successor: Object.freeze({ label: 'Debitor dizolvat/lichidat fara succesor', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (4) lit. h) Cod fiscal', evidenceRequired: true }),
    major_financial_difficulty: Object.freeze({ label: 'Dificultati financiare majore care afecteaza intreg patrimoniul', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (4) lit. h) Cod fiscal', evidenceRequired: true }),
    insurance_covered: Object.freeze({ label: 'Creanta acoperita de asigurare', pctNedeductibil: 0, legalBasis: 'Art. 25 alin. (4) lit. h) Cod fiscal', evidenceRequired: true }),
  }),
});

function accountOf(value) {
  const code = String(value || '');
  return ACCOUNTS.find((account) => code.startsWith(account)) || null;
}

function relevantParts(line) {
  const parts = [];
  const debit = accountOf(line && line.debit); const credit = accountOf(line && line.credit);
  const amount = round2(Number(line && line.suma) || 0);
  if (debit) parts.push({ account: debit, amount });
  if (credit) parts.push({ account: credit, amount: round2(-amount) });
  return parts;
}

function categoryFor(account, code) {
  return CATEGORIES[String(account)] && CATEGORIES[String(account)][String(code)] || null;
}

function clientCategories() {
  const out = {};
  for (const account of ACCOUNTS) out[account] = Object.entries(CATEGORIES[account]).map(([code, cfg]) => ({
    code, label: cfg.label, pctNedeductibil: cfg.pctNedeductibil, legalBasis: cfg.legalBasis,
    evidenceRequired: !!cfg.evidenceRequired,
  }));
  return out;
}

function fail(message) {
  const error = new Error(message); error.status = 400; error.code = 'PROFIT_EXPENSE_TAXONOMY_INVALID'; throw error;
}

function normalizeItem(raw, entry) {
  raw = raw || {}; entry = entry || {};
  const lineIndex = Number(raw.lineIndex);
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= (entry.lines || []).length) fail('Linia contabila clasificata nu exista.');
  const parts = relevantParts(entry.lines[lineIndex]);
  const account = String(raw.account || '');
  if (!ACCOUNTS.includes(account) || !parts.some((part) => part.account === account)) {
    fail('Linia ' + lineIndex + ' nu foloseste contul fiscal ' + (account || '(lipsa)') + '.');
  }
  const cfg = categoryFor(account, raw.category);
  if (!cfg) fail('Categoria fiscala „' + String(raw.category || '') + '” nu este admisa pentru contul ' + account + '.');
  const reason = String(raw.reason || '').trim();
  if (reason.length < 5 || reason.length > 500) fail('Justificarea clasificarii trebuie sa aiba 5-500 caractere.');
  const evidenceDocumentIds = [...new Set((Array.isArray(raw.evidenceDocumentIds) ? raw.evidenceDocumentIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 20);
  const evidenceReference = String(raw.evidenceReference || '').trim().slice(0, 500);
  if (cfg.evidenceRequired && !evidenceDocumentIds.length && evidenceReference.length < 3) {
    fail('Categoria „' + cfg.label + '” cere cel putin un document justificativ atasat sau o referinta documentara.');
  }
  return {
    version: 1, lineIndex, account, category: String(raw.category), reason,
    legalBasis: cfg.legalBasis, pctNedeductibil: cfg.pctNedeductibil,
    evidenceDocumentIds, evidenceReference,
  };
}

function classificationItem(entry, lineIndex, account, entriesById) {
  let source = entry;
  if (entry && entry.stornoOf && !(entry.fiscalTaxonomy && entry.fiscalTaxonomy.profitExpense)) {
    source = entriesById.get(String(entry.stornoOf)) || entry;
  }
  const items = source && source.fiscalTaxonomy && source.fiscalTaxonomy.profitExpense
    && source.fiscalTaxonomy.profitExpense.items;
  return (Array.isArray(items) ? items : []).find((item) => Number(item.lineIndex) === lineIndex
    && String(item.account) === account) || null;
}

function analyze(entries, year, panaLa) {
  const limit = panaLa ? String(panaLa).slice(0, 7) : null;
  const list = Array.isArray(entries) ? entries : [];
  const entriesById = new Map(list.map((entry) => [String(entry.id), entry]));
  const groups = new Map(); const unresolvedGroups = new Map();
  for (const entry of list) {
    const period = String(entry.period || entry.data || '').slice(0, 7);
    if (year && !period.startsWith(String(year))) continue;
    if (limit && period > limit) continue;
    for (let lineIndex = 0; lineIndex < (entry.lines || []).length; lineIndex++) {
      const line = entry.lines[lineIndex];
      // Inchiderea conturilor de rezultat nu este o operatiune economica si nu cere clasificare.
      if (String(line.debit) === '121' || String(line.credit) === '121') continue;
      for (const part of relevantParts(line)) {
        if (!part.amount) continue;
        const item = classificationItem(entry, lineIndex, part.account, entriesById);
        const cfg = item && categoryFor(part.account, item.category);
        if (cfg) {
          const key = part.account + ':' + item.category;
          const row = groups.get(key) || { account: part.account, category: item.category, label: cfg.label,
            legalBasis: cfg.legalBasis, pctNedeductibil: cfg.pctNedeductibil, amount: 0, entryIds: [] };
          row.amount = round2(row.amount + part.amount);
          if (!row.entryIds.includes(entry.id)) row.entryIds.push(entry.id);
          groups.set(key, row);
        } else {
          // Original + storno in acelasi exercitiu se neutralizeaza pe aceeasi cheie. Un storno din
          // alt exercitiu ramane de clasificat in anul lui, fiind o reluare fiscala reala.
          const sourceId = String(entry.stornoOf || entry.id);
          const key = sourceId + ':' + lineIndex + ':' + part.account;
          const row = unresolvedGroups.get(key) || { entryId: entry.id, sourceEntryId: sourceId,
            lineIndex, account: part.account, amount: 0, data: entry.data || '', document: entry.document || '',
            partener: entry.partener || '', explicatie: line.explicatie || entry.explicatie || '',
            reason: item ? 'Clasificarea salvata nu mai este valida pentru categoria/contul curent.' : 'Lipseste clasificarea fiscala.' };
          row.amount = round2(row.amount + part.amount);
          unresolvedGroups.set(key, row);
        }
      }
    }
  }
  const classified = [...groups.values()].filter((row) => Math.abs(row.amount) >= 0.005)
    .map((row) => Object.assign(row, { nondeductible: round2(row.amount * row.pctNedeductibil / 100) }));
  const unresolved = [...unresolvedGroups.values()].filter((row) => Math.abs(row.amount) >= 0.005);
  return {
    complete: unresolved.length === 0, classified, unresolved,
    totalClassified: round2(classified.reduce((sum, row) => sum + row.amount, 0)),
    totalNondeductible: round2(classified.reduce((sum, row) => sum + row.nondeductible, 0)),
    categories: clientCategories(),
  };
}

function reviewError(review) {
  const rows = review && review.unresolved || [];
  const error = new Error('Calculul fiscal final este blocat: ' + rows.length
    + ' linie/linii din conturile 635, 6581 sau 654 necesita clasificare fiscala explicita.');
  error.status = 409; error.code = 'FISCAL_TREATMENT_REVIEW_REQUIRED'; error.details = rows; return error;
}

module.exports = { ACCOUNTS, CATEGORIES, accountOf, relevantParts, categoryFor, clientCategories,
  normalizeItem, analyze, reviewError };
