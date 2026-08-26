'use strict';

// Taxonomia unica folosita de configurare, motor, API si raport. Cheile sunt chiar randurile
// situatiei de fluxuri; o regula nu poate inventa o categorie pe care PDF-ul nu o afiseaza.
const CATEGORIES = Object.freeze({
  ex_clienti: 'Incasari de la clienti',
  ex_furnizoriAngajati: 'Plati catre furnizori si angajati',
  ex_impozite: 'Plati de impozite, taxe si TVA',
  ex_dobanzi: 'Dobanzi platite',
  ex_altele: 'Alte incasari/plati din exploatare',
  inv_imobilizari: 'Imobilizari',
  inv_dobanziDiv: 'Dobanzi si dividende incasate',
  fin_credite: 'Credite si imprumuturi',
  fin_capital: 'Aporturi de capital',
  fin_dividende: 'Dividende platite',
});

// Ordinea este deliberata. Prefixele mai specifice sunt evaluate primele in aceeasi regula.
const DEFAULT_RULES = Object.freeze([
  { id: 'default-investitii-imobilizari', category: 'inv_imobilizari', prefixes: ['404', '405', '20', '21', '22', '23', '26', '27'] },
  { id: 'default-investitii-randamente', category: 'inv_dobanziDiv', prefixes: ['761', '762', '763', '764', '765'] },
  { id: 'default-finantare-credite', category: 'fin_credite', prefixes: ['159', '519', '455', '509', '16'] },
  { id: 'default-finantare-capital', category: 'fin_capital', prefixes: ['101', '102', '103', '104', '105', '108', '456'] },
  { id: 'default-finantare-dividende', category: 'fin_dividende', prefixes: ['457'] },
  { id: 'default-clienti-avansuri', category: 'ex_clienti', prefixes: ['419'] },
  { id: 'default-furnizori-angajati', category: 'ex_furnizoriAngajati', prefixes: ['40', '42', '43'] },
  { id: 'default-impozite', category: 'ex_impozite', prefixes: ['44'] },
  { id: 'default-dobanzi', category: 'ex_dobanzi', prefixes: ['666', '518'] },
  { id: 'default-clienti', category: 'ex_clienti', prefixes: ['418', '411', '41', '70'] },
]);

function fail(message) { const e = new Error(message); e.status = 400; throw e; }
function cleanPrefix(value) { return String(value == null ? '' : value).trim().replace(/\s+/g, ''); }

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('Regula cash-flow ' + (index + 1) + ' trebuie sa fie obiect.');
  const category = String(rule.category || '');
  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) fail('Categoria cash-flow „' + category + '” nu exista.');
  const prefixes = [...new Set((Array.isArray(rule.prefixes) ? rule.prefixes : []).map(cleanPrefix).filter(Boolean))];
  if (!prefixes.length) fail('Regula cash-flow ' + (index + 1) + ' trebuie sa aiba cel putin un prefix de cont.');
  if (prefixes.some((p) => !/^\d{1,12}(?:\.\d{1,12})?$/.test(p))) fail('Prefixele cash-flow contin numai cifre si, optional, un punct analitic.');
  return {
    id: String(rule.id || ('regula-' + (index + 1))).slice(0, 80),
    label: String(rule.label || CATEGORIES[category]).trim().slice(0, 160),
    category,
    prefixes: prefixes.sort((a, b) => b.length - a.length || a.localeCompare(b)),
  };
}

function normalizeConfig(input) {
  const cfg = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rules = (Array.isArray(cfg.rules) ? cfg.rules : []).map(normalizeRule);
  if (rules.length > 100) fail('Configuratia cash-flow accepta cel mult 100 de reguli.');
  const materialityAmount = Number(cfg.materialityAmount == null ? 1000 : cfg.materialityAmount);
  const materialityPercent = Number(cfg.materialityPercent == null ? 5 : cfg.materialityPercent);
  if (!Number.isFinite(materialityAmount) || materialityAmount < 0 || materialityAmount > 1e12) fail('Pragul valoric cash-flow este invalid.');
  if (!Number.isFinite(materialityPercent) || materialityPercent < 0 || materialityPercent > 100) fail('Pragul procentual cash-flow trebuie sa fie intre 0 si 100.');
  return { version: 1, rules, materialityAmount, materialityPercent };
}

function matchRule(account, rules) {
  const c = String(account || '');
  for (const rule of rules) {
    const prefix = rule.prefixes.find((p) => c.startsWith(p));
    if (prefix) return { category: rule.category, source: 'configured', ruleId: rule.id, prefix };
  }
  return null;
}

function classify(account, entry, line, inputConfig) {
  const explicit = String((line && line.cashFlowCategory) || (entry && entry.cashFlowCategory) || '');
  if (explicit) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, explicit)) fail('Categoria cash-flow explicita „' + explicit + '” nu exista.');
    return { category: explicit, source: 'transaction', ruleId: null, prefix: null };
  }
  const cfg = normalizeConfig(inputConfig);
  const custom = matchRule(account, cfg.rules);
  if (custom) return custom;
  const fallback = matchRule(account, DEFAULT_RULES);
  if (fallback) return Object.assign({}, fallback, { source: 'default' });
  return { category: 'ex_altele', source: 'unmapped', ruleId: null, prefix: null };
}

function materialityThreshold(config, absoluteCashMovement) {
  const cfg = normalizeConfig(config);
  return Math.max(cfg.materialityAmount, (Number(absoluteCashMovement) || 0) * cfg.materialityPercent / 100);
}

module.exports = { CATEGORIES, DEFAULT_RULES, normalizeConfig, classify, materialityThreshold };
