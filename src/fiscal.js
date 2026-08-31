'use strict';

const { round2 } = require('./util');
const cfg = require('./fiscalConfig');
const ben = require('./beneficii');
const registry = require('./fiscalRules');

const DEFAULTS = Object.freeze(Object.assign({}, cfg.RATES));
// Fotografie numai pentru compatibilitate/UI. Este deliberat inghetata; motoarele folosesc rulesAt.
const FISCAL = Object.freeze(Object.assign({}, registry.all()[registry.all().length - 1].rates));

function rulesAt(value) { return registry.at(value); }
function treatmentAt(value, id) { return registry.treatmentAt(value, id); }
function evaluateTreatment(value, id, facts, options) {
  return registry.evaluateTreatment(value, id, facts, options);
}
function evaluateTreatmentForAutonomy(value, id, facts, options) {
  return registry.evaluateTreatmentForAutonomy(value, id, facts, options);
}
function rateContext(value, explicit) {
  if (explicit && explicit.rates && explicit.id && explicit.hash) return explicit;
  return rulesAt(value);
}
function applyConfig(overrides) {
  if (overrides && Object.keys(overrides).length) {
    const e = new Error('Cotele globale mutabile au fost eliminate. Publica un FiscalRuleSet versionat.');
    e.status = 409; throw e;
  }
  return FISCAL;
}
function configureRuleSets(rows) { return registry.configure(rows); }
function fiscalStaleness(anCurent) {
  const cur = Number(anCurent) || 0;
  const years = registry.all().map((x) => Number(x.validTo && x.validTo.slice(0, 4))).filter(Boolean);
  const coveredUntil = years.length ? Math.max(...years) : 0;
  return { an: coveredUntil, anCurent: cur, stale: !!(cur && coveredUntil && cur > coveredUntil), coveredUntil };
}

const DP_PCT_MAX = cfg.DEDUCERE.pctMax;
const DP_PLAFON_PESTE_MINIM = cfg.DEDUCERE.plafonPesteMinim;

function deducerePersonala(brut, persoane, opts) {
  const o = opts || {}; const rule = rateContext(o.period, o.rules); const r = rule.rates;
  const sm = round2(Number(o.salariuMinim) || r.salariuMinim);
  const b = round2(brut) || 0; let baza = 0; const brutRotunjit = Math.round(b);
  if (sm > 0 && brutRotunjit <= sm + DP_PLAFON_PESTE_MINIM) {
    const p = Math.max(0, Math.min(DP_PCT_MAX.length - 1, Math.round(Number(persoane) || 0)));
    const peste = Math.max(0, brutRotunjit - sm); const transa = peste > 0 ? Math.ceil(peste / 50) : 0;
    baza = round2((sm * Math.max(0, DP_PCT_MAX[p] - transa * 0.5)) / 100);
  }
  let supl = 0;
  if (o.sub26 && b <= sm) supl = round2(supl + (sm * cfg.DEDUCERE.suplTineriPct) / 100);
  if (o.copii) supl = round2(supl + cfg.DEDUCERE.suplCopilLei * (Number(o.copii) || 0));
  const total = baza + supl > 0
    ? Math.ceil(round2(baza + supl) / cfg.DEDUCERE.rotunjireLei) * cfg.DEDUCERE.rotunjireLei : 0;
  return { baza, suplimentara: supl, total, ruleSetId: rule.id, fiscalRulesHash: rule.hash };
}
function salariuMinimLa(period) { return rulesAt(period).rates.salariuMinim; }
function neimpozabilLa(period) { return rulesAt(period).rates.neimpozabilMinim; }
function neimpozabilMinim(brut, salariuBaza, period, explicitRules) {
  const rule = rateContext(period, explicitRules); const r = rule.rates;
  const sm = r.salariuMinim; const suma = r.neimpozabilMinim;
  const b = round2(Number(brut) || 0); const baza = round2(Number(salariuBaza != null ? salariuBaza : brut) || 0);
  const ref = { ruleSetId: rule.id, fiscalRulesHash: rule.hash };
  if (!(sm > 0) || !(suma > 0)) return Object.assign({ suma: 0, eligibil: false,
    motiv: 'Fara salariu minim sau suma neimpozabila publicate.' }, ref);
  if (baza !== sm) return Object.assign({ suma: 0, eligibil: false,
    motiv: 'Salariul de baza (' + baza + ' lei) nu e la nivelul salariului minim (' + sm + ' lei).' }, ref);
  const plafon = round2(r.neimpozabilPlafonBrut);
  if (b > plafon) return Object.assign({ suma: 0, eligibil: false,
    motiv: 'Brutul lunii (' + b + ' lei) depaseste plafonul legal de ' + plafon + ' lei.' }, ref);
  return Object.assign({ suma: Math.min(suma, b), eligibil: true, motiv: '' }, ref);
}
function categoriiBeneficii(period, explicitRules) {
  const r = rateContext(period, explicitRules).rates;
  return cfg.BENEFICII.map((cat) => {
    const key = (cat.limita || {}).sursaRate; const value = Number(r[key]);
    if (!key || !Number.isFinite(value) || value <= 0) return cat;
    return Object.assign({}, cat, { limita: Object.assign({}, cat.limita,
      { lei: round2(value * (Number(cat.limita.multiplu) || 1)) }) });
  });
}
function beneficii(input) {
  const o = input || {}; const rule = rateContext(o.period, o.rules); const r = rule.rates;
  const curs = Number(o.cursEur); const result = ben.calcul(o, {
    categorii: categoriiBeneficii(o.period, rule), pct: r.plafonBeneficiiPct,
    cursEur: Number.isFinite(curs) && curs > 0 ? curs : r.cursEurBeneficii,
  });
  return Object.assign(result, { ruleSetId: rule.id, fiscalRulesHash: rule.hash });
}
function payroll(brut, deducere, opts) {
  const o = opts || {}; const rule = rateContext(o.period, o.rules); const r = rule.rates;
  const b = round2(brut) || 0; const ded = round2(deducere) || 0; const tichete = round2(o.tichete) || 0;
  const avantaje = round2(o.avantaje) || 0; const beneficiiImpozabile = round2(o.beneficiiImpozabile) || 0;
  const cmA = round2(o.cmAngajator) || 0; const cmF = round2(o.cmFnuass) || 0;
  const cmCuCass = Math.max(0, Math.min(round2(o.cmCuCass) || 0, round2(cmA + cmF)));
  const nm = Math.max(0, Math.min(round2(o.neimpozabilMinim) || 0, b));
  const bazaCasReala = round2(b + avantaje + beneficiiImpozabile + cmA + cmF - nm);
  const bazaCassReala = round2(b + tichete + avantaje + beneficiiImpozabile + cmCuCass - nm);
  const casDecision = evaluateTreatment(rule, 'ro.payroll.cas', { base: bazaCasReala }, o.treatmentOptions);
  const cassDecision = evaluateTreatment(rule, 'ro.payroll.cass', { base: bazaCassReala }, o.treatmentOptions);
  const cas = casDecision.result.amount; const cass = cassDecision.result.amount;
  const bmin = round2(o.bazaMinima) || 0;
  const casAngajator = bmin > bazaCasReala ? round2(((bmin - bazaCasReala) * r.cas) / 100) : 0;
  const cassAngajator = bmin > bazaCassReala ? round2(((bmin - bazaCassReala) * r.cass) / 100) : 0;
  const baza = Math.max(0, round2(b + tichete + avantaje + beneficiiImpozabile
    + cmA + cmF - nm - cas - cass - ded));
  const bazaCam = round2(b + avantaje + beneficiiImpozabile + cmA - nm);
  const incomeTaxDecision = evaluateTreatment(rule, 'ro.payroll.income_tax', { base: baza }, o.treatmentOptions);
  const camDecision = evaluateTreatment(rule, 'ro.payroll.cam', { base: bazaCam }, o.treatmentOptions);
  const impozit = incomeTaxDecision.result.amount; const cam = camDecision.result.amount;
  return { brut: b, tichete, avantaje, beneficiiImpozabile, cmAngajator: cmA, cmFnuass: cmF,
    cmCuCass, neimpozabilMinim: nm, bazaCas: bazaCasReala, bazaCass: bazaCassReala,
    cas, cass, casAngajator, cassAngajator, baza, impozit, cam,
    net: round2(b + cmA + cmF - cas - cass - impozit),
    costTotal: round2(b + cmA + cam + tichete + casAngajator + cassAngajator),
    sector: o.sector || 'normal', scutImpozit: false, scutCass: false, overPlafon: false,
    ruleSetId: rule.id, fiscalRulesHash: rule.hash, fiscalTreatmentsHash: rule.treatmentsHash,
    treatmentDecisions: [casDecision, cassDecision, incomeTaxDecision, camDecision] };
}
function retinereLaSursa(fel, brut, cota, opts) {
  const o = opts || {}; const rule = rateContext(o.period, o.rules); const r = rule.rates;
  const b = round2(Number(brut) || 0);
  const defaultRate = fel === 'dividende' ? r.impozitDividende : r.impozitVenit;
  const c = Number.isFinite(Number(cota)) && Number(cota) > 0 ? Number(cota) : defaultRate;
  let baza = b;
  if (fel === 'chirii') baza = round2((b * (100 - Number(r.chiriiForfetarPct || 0))) / 100);
  else if (fel === 'premii') baza = round2(Math.max(0, b - Number(r.premiiNeimpozabil || 0)));
  const treatmentDecision = fel === 'dividende' && !(Number.isFinite(Number(cota)) && Number(cota) > 0)
    ? evaluateTreatment(rule, 'ro.withholding.dividends', { base: baza }, o.treatmentOptions) : null;
  const impozit = treatmentDecision ? treatmentDecision.result.amount : round2((baza * c) / 100);
  return { brut: b, baza, cota: c, impozit, net: round2(b - impozit),
    ruleSetId: rule.id, fiscalRulesHash: rule.hash, fiscalTreatmentsHash: rule.treatmentsHash,
    treatmentDecisions: treatmentDecision ? [treatmentDecision] : [] };
}
function taxePfa(venitNet, opts) {
  const o = opts || {}; const rule = rateContext(o.period, o.rules); const r = rule.rates;
  const sm = round2(Number(o.salariuMinim) || r.salariuMinim); const vn = Math.max(0, round2(venitNet) || 0);
  const p6 = round2(sm * cfg.PFA.plafonCassInf); const p12 = round2(sm * cfg.PFA.cas12);
  const p24 = round2(sm * cfg.PFA.cas24); const p60 = round2(sm * cfg.PFA.plafonCassSup);
  const bazaCas = vn >= p24 ? p24 : vn >= p12 ? p12 : 0;
  let bazaCass = vn > 0 ? (vn < p6 ? (o.areAlteVenituri ? vn : p6) : Math.min(vn, p60)) : 0;
  bazaCass = round2(bazaCass);
  const casDecision = evaluateTreatment(rule, 'ro.pfa.cas', { base: bazaCas }, o.treatmentOptions);
  const cassDecision = evaluateTreatment(rule, 'ro.pfa.cass', { base: bazaCass }, o.treatmentOptions);
  const cas = casDecision.result.amount; const cass = cassDecision.result.amount;
  const bazaImpozit = Math.max(0, round2(vn - cas - cass));
  const incomeTaxDecision = evaluateTreatment(rule, 'ro.pfa.income_tax', { base: bazaImpozit }, o.treatmentOptions);
  const impozit = incomeTaxDecision.result.amount;
  return { venitNet: vn, salariuMinim: sm, plafon6: p6, plafon12: p12, plafon24: p24, plafon60: p60,
    bazaCas, cas, bazaCass, cass, impozit, total: round2(cas + cass + impozit),
    ruleSetId: rule.id, fiscalRulesHash: rule.hash, fiscalTreatmentsHash: rule.treatmentsHash,
    treatmentDecisions: [casDecision, cassDecision, incomeTaxDecision] };
}

module.exports = { FISCAL, DEFAULTS, applyConfig, rulesAt, ruleSetAt: rulesAt,
  ruleReferenceAt: registry.ref, allRuleSets: registry.all, configureRuleSets,
  createRuleSet: registry.create, appendRuleSet: registry.append, ruleSetById: registry.byId,
  registrySnapshot: registry.snapshot, registryHash: registry.registryHash,
  verifyRuleReference: registry.verifyReference, treatmentAt, evaluateTreatment,
  evaluateTreatmentForAutonomy,
  retinereLaSursa, categoriiBeneficii,
  fiscalStaleness, payroll, taxePfa, deducerePersonala, salariuMinimLa, neimpozabilLa,
  neimpozabilMinim, beneficii, CATEGORII_BENEFICII: cfg.BENEFICII };
