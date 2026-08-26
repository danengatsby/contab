'use strict';

// Contractul RUNTIME al celor 25 de cazuri trimise revizorului extern. `definitionHash` este
// amprenta temei + intrare + rezultat asteptat din test/cazuri-aprobate.js. Testul confrunta
// automat cele doua surse: schimbarea unui caz obliga actualizarea acestei amprente, iar aceasta
// invalideaza aprobarea existenta. `dependencies` documenteaza sursele directe pentru revizor;
// fiscalReview construieste separat un manifest automat al intregului cod si al regulilor, astfel
// incat niciun fisier nou sau omis din aceasta lista sa nu mosteneasca aprobarea codului anterior.

const COMMON_PAYROLL = ['src/fiscalConfig.js', 'src/fiscal.js', 'src/payroll.js', 'src/beneficii.js'];
const COMMON_DEDUCT = ['src/fiscalConfig.js', 'src/deductibilitate.js'];

const CASES = [
  { id: 'COT-01', definitionHash: '0d4a241c91e9e430', dependencies: ['src/fiscalConfig.js'] },
  { id: 'COT-02', definitionHash: '693bd1f56b90e4b8', dependencies: ['src/fiscalConfig.js'] },
  { id: 'COT-03', definitionHash: '68635746aaefb497', dependencies: ['src/fiscalConfig.js'] },
  { id: 'COT-04', definitionHash: '41889b8f2f7cc0f6', dependencies: ['src/fiscalConfig.js'] },
  { id: 'SAL-01', definitionHash: '8501524eb1e6abf4', dependencies: COMMON_PAYROLL },
  { id: 'SAL-06', definitionHash: '92c6d3c7657da6b4', dependencies: COMMON_PAYROLL },
  { id: 'SAL-02', definitionHash: 'e39dcb485f606fcf', dependencies: COMMON_PAYROLL },
  { id: 'SAL-03', definitionHash: 'bc298b13c4bb630c', dependencies: COMMON_PAYROLL },
  { id: 'SAL-03b', definitionHash: '762ec7260982090e', dependencies: COMMON_PAYROLL },
  { id: 'SAL-04', definitionHash: 'd2a0aa5f55dfc387', dependencies: COMMON_PAYROLL },
  { id: 'DED-01', definitionHash: '919e0a63ffd69987', dependencies: ['src/fiscalConfig.js', 'src/fiscal.js'] },
  { id: 'DED-02', definitionHash: '1537c265b8c5dfae', dependencies: ['src/fiscalConfig.js', 'src/fiscal.js'] },
  { id: 'DED-03', definitionHash: 'cf5dcdcd9c1a34dc', dependencies: ['src/fiscalConfig.js', 'src/fiscal.js'] },
  { id: 'CM-01', definitionHash: '30627d7aedf34eba', dependencies: COMMON_PAYROLL },
  { id: 'CM-02', definitionHash: '78f0304ab8af54b4', dependencies: COMMON_PAYROLL },
  { id: 'CO-01', definitionHash: '6555d4f35bfba5a2', dependencies: COMMON_PAYROLL },
  { id: 'PFA-01', definitionHash: '09ca65bf82488c3d', dependencies: ['src/fiscalConfig.js', 'src/fiscal.js'] },
  { id: 'PFA-02', definitionHash: 'f71801ab2ec8d8c4', dependencies: ['src/fiscalConfig.js', 'src/fiscal.js'] },
  { id: 'PFA-03', definitionHash: '381369f9ec896399', dependencies: ['src/fiscalConfig.js', 'src/fiscal.js'] },
  { id: 'PLF-01', definitionHash: '017b1dc09d2b9b4d', dependencies: COMMON_DEDUCT },
  { id: 'PLF-02', definitionHash: '587682f5e0ae7537', dependencies: COMMON_DEDUCT },
  { id: 'PLF-03', definitionHash: '8ea96aa4d7eca684', dependencies: COMMON_DEDUCT },
  { id: 'PLF-04', definitionHash: '62b49ffe27666702', dependencies: COMMON_DEDUCT },
  { id: 'PLF-05', definitionHash: 'e41f8682254a033e', dependencies: COMMON_DEDUCT },
  { id: 'PLF-06', definitionHash: '2d7d7e6af9e8fe46', dependencies: ['src/fiscalConfig.js', 'src/assets.js'] },
].map((c) => Object.freeze(Object.assign({}, c, { dependencies: Object.freeze([...c.dependencies]) })));

module.exports = Object.freeze(CASES);
