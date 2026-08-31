'use strict';

// Contractul RUNTIME al celor 25 de cazuri din poarta de lansare. `dependencies` este citit de
// fiscalDependencyGraph: fiecare aprobare este legata numai de codul, parametrii, versiunile de
// RuleSet si tratamentele care pot influenta cazul. Lista nu este doar documentatie; o dependenta
// inexistenta sau un selector necunoscut inchide poarta.

const PAYROLL_RULES = ['ro.payroll.cas', 'ro.payroll.cass', 'ro.payroll.income_tax', 'ro.payroll.cam'];
const PFA_RULES = ['ro.pfa.cas', 'ro.pfa.cass', 'ro.pfa.income_tax'];
const PAYROLL_RATES = ['cas', 'cass', 'impozitVenit', 'cam', 'salariuMinim'];
const PAYROLL_FILES = ['src/fiscal.js', 'src/payroll.js', 'src/beneficii.js'];
const PROFIT_RULE = ['ro.tax.profit'];

function deps(files, components, rateNames, ruleSetIds, ruleIds, configPaths, consumers) {
  return { files, components, rateNames, ruleSetIds, ruleIds, configPaths, consumers };
}

const H1 = ['ro-2026-h1'];
const H2 = ['ro-2026-h2'];
const H1_H2 = ['ro-2026-h1', 'ro-2026-h2'];
const SALARY_CONSUMERS = ['payroll', 'D112'];

const CASES = [
  { id: 'COT-01', definitionHash: '0d4a241c91e9e430', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.registry'], ['cas', 'cass', 'impozitVenit', 'cam'], H2,
    [...PAYROLL_RULES, ...PFA_RULES], [], ['payroll', 'PFA', 'D112']) },
  { id: 'COT-02', definitionHash: '693bd1f56b90e4b8', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.minimum_wage'],
    ['salariuMinim', 'neimpozabilMinim'], H1_H2, [], [], SALARY_CONSUMERS) },
  { id: 'COT-03', definitionHash: '68635746aaefb497', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.registry'],
    ['tvaStandard', 'tvaRedus', 'plafonScutireTvaLei', 'deductibilitateTvaAutoLimitat'], H2,
    ['ro.vat.standard', 'ro.vat.reduced', 'ro.vat.vehicle_limited_deduction'], [], ['TVA', 'D300', 'D394']) },
  { id: 'COT-04', definitionHash: '41889b8f2f7cc0f6', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.registry'],
    ['impozitProfit', 'impozitMicro', 'impozitDividende', 'plafonMicroEur'], H2,
    ['ro.tax.micro', 'ro.tax.profit', 'ro.withholding.dividends'], [], ['D100', 'D101', 'dividends']) },

  { id: 'SAL-01', definitionHash: '8501524eb1e6abf4', dependencies: deps(
    PAYROLL_FILES, ['fiscal.payroll'], PAYROLL_RATES, H2, PAYROLL_RULES, [], SALARY_CONSUMERS) },
  { id: 'SAL-06', definitionHash: '92c6d3c7657da6b4', dependencies: deps(
    PAYROLL_FILES, ['fiscal.payroll', 'fiscal.minimum_wage'],
    [...PAYROLL_RATES, 'neimpozabilMinim', 'neimpozabilPlafonBrut'], H1_H2, PAYROLL_RULES, [], SALARY_CONSUMERS) },
  { id: 'SAL-02', definitionHash: 'e39dcb485f606fcf', dependencies: deps(
    PAYROLL_FILES, ['fiscal.payroll'], PAYROLL_RATES, H2, PAYROLL_RULES, [], SALARY_CONSUMERS) },
  { id: 'SAL-03', definitionHash: 'bc298b13c4bb630c', dependencies: deps(
    PAYROLL_FILES, ['fiscal.payroll'], PAYROLL_RATES, H2, PAYROLL_RULES, [], SALARY_CONSUMERS) },
  { id: 'SAL-03b', definitionHash: '762ec7260982090e', dependencies: deps(
    PAYROLL_FILES, ['fiscal.payroll', 'fiscal.benefits'],
    [...PAYROLL_RATES, 'plafonBeneficiiPct', 'tichetMasaMaxLei', 'castigSalarialMediuBrut',
      'diurnaInternaLegala', 'cursEurBeneficii'], H1, PAYROLL_RULES, ['BENEFICII'], SALARY_CONSUMERS) },
  { id: 'SAL-04', definitionHash: 'd2a0aa5f55dfc387', dependencies: deps(
    PAYROLL_FILES, ['fiscal.payroll'], PAYROLL_RATES, H1, PAYROLL_RULES, ['DEDUCERE'], SALARY_CONSUMERS) },

  { id: 'DED-01', definitionHash: '919e0a63ffd69987', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.deduction'], ['salariuMinim'], H1,
    ['ro.payroll.income_tax'], ['DEDUCERE'], SALARY_CONSUMERS) },
  { id: 'DED-02', definitionHash: '1537c265b8c5dfae', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.deduction'], ['salariuMinim'], H1,
    ['ro.payroll.income_tax'], ['DEDUCERE'], SALARY_CONSUMERS) },
  { id: 'DED-03', definitionHash: 'cf5dcdcd9c1a34dc', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.deduction'], ['salariuMinim'], H1,
    ['ro.payroll.income_tax'], ['DEDUCERE'], SALARY_CONSUMERS) },

  { id: 'CM-01', definitionHash: '30627d7aedf34eba', dependencies: deps(
    PAYROLL_FILES, ['fiscal.payroll', 'fiscal.minimum_wage'], PAYROLL_RATES, H1,
    PAYROLL_RULES, ['DEDUCERE'], SALARY_CONSUMERS) },
  { id: 'CM-02', definitionHash: '78f0304ab8af54b4', dependencies: deps(
    PAYROLL_FILES, ['fiscal.payroll', 'fiscal.minimum_wage'], PAYROLL_RATES, H1,
    PAYROLL_RULES, ['DEDUCERE'], SALARY_CONSUMERS) },
  { id: 'CO-01', definitionHash: '6555d4f35bfba5a2', dependencies: deps(
    PAYROLL_FILES, ['fiscal.payroll'], PAYROLL_RATES, H1, PAYROLL_RULES, ['DEDUCERE'], SALARY_CONSUMERS) },

  { id: 'PFA-01', definitionHash: '09ca65bf82488c3d', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.pfa'], ['cas', 'cass', 'impozitVenit', 'salariuMinim'],
    H2, PFA_RULES, ['PFA'], ['PFA', 'Declaratia unica']) },
  { id: 'PFA-02', definitionHash: 'f71801ab2ec8d8c4', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.pfa'], ['cas', 'cass', 'impozitVenit', 'salariuMinim'],
    H2, PFA_RULES, ['PFA'], ['PFA', 'Declaratia unica']) },
  { id: 'PFA-03', definitionHash: '381369f9ec896399', dependencies: deps(
    ['src/fiscalConfig.js', 'src/fiscal.js'], ['fiscal.pfa'], ['cas', 'cass', 'impozitVenit', 'salariuMinim'],
    H2, PFA_RULES, ['PFA'], ['PFA', 'Declaratia unica']) },

  { id: 'PLF-01', definitionHash: '017b1dc09d2b9b4d', dependencies: deps(
    ['src/deductibilitate.js'], [], ['protocolPct', 'impozitProfit'], H2, PROFIT_RULE, [], ['D101']) },
  { id: 'PLF-02', definitionHash: '587682f5e0ae7537', dependencies: deps(
    ['src/deductibilitate.js'], [], ['socialPct', 'impozitProfit'], H2, PROFIT_RULE, [], ['D101']) },
  { id: 'PLF-03', definitionHash: '8ea96aa4d7eca684', dependencies: deps(
    ['src/deductibilitate.js'], [], ['sponsorizareCaPct', 'sponsorizareImpozitPct',
      'sponsorizareReportAni', 'impozitProfit'], H2, PROFIT_RULE, [], ['D101']) },
  { id: 'PLF-04', definitionHash: '62b49ffe27666702', dependencies: deps(
    ['src/deductibilitate.js'], [], ['autoCheltuialaDeductibilPct', 'impozitProfit'], H2,
    [...PROFIT_RULE, 'ro.profit.vehicle_limited_deduction'], [], ['D101']) },
  { id: 'PLF-05', definitionHash: 'e41f8682254a033e', dependencies: deps(
    ['src/deductibilitate.js'], [], ['dobanziPlafonEur', 'dobanziEbitdaPct', 'impozitProfit'], H2,
    PROFIT_RULE, [], ['D101']) },
  { id: 'PLF-06', definitionHash: '2d7d7e6af9e8fe46', dependencies: deps(
    ['src/assets.js'], [], ['plafonAmortizareAutoLunar', 'impozitProfit'], H2, PROFIT_RULE, [], ['D101']) },
];

function freezeDependencies(value) {
  const out = {};
  for (const [key, rows] of Object.entries(value)) out[key] = Object.freeze([...rows]);
  return Object.freeze(out);
}

module.exports = Object.freeze(CASES.map((row) => Object.freeze(Object.assign({}, row, {
  dependencies: freezeDependencies(row.dependencies),
}))));
