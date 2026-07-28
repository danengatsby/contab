'use strict';

// Genereaza fisierele de REFERINTA (din exemplul de seed) pentru toate iesirile fiscale, ca
// sa fie validate cu validatorul oficial ANAF (scripts/valideaza-duk.sh) — manual sau in CI.
// Nu se comit XML-uri: sursa de adevar sunt generatoarele + seed-ul; referinta e „ce produce
// codul curent din exemplu". Foloseste: node scripts/genereaza-referinte.js [dir]

process.env.CONTAB_DB_DRIVER = process.env.CONTAB_DB_DRIVER || 'sqlite';
process.env.CONTAB_DB_FILE = process.env.CONTAB_DB_FILE || require('os').tmpdir() + '/ref-' + process.pid + '.json';

const fs = require('fs');
const path = require('path');
const { scopedSeed } = require('../src/seed');
const acc = require('../src/accounting');
const rep = require('../src/reporting');
const xml = require('../src/xml');
const saft = require('../src/saft');
const etransport = require('../src/etransport');
const { getType } = require('../src/documentTypes');
const { statePlata } = require('../src/payroll');
const bilant = require('../src/bilant');

const dir = process.argv[2] || path.join(require('os').tmpdir(), 'contab-referinte');
fs.mkdirSync(dir, { recursive: true });

const v = scopedSeed();
const who = { nume: 'Popescu', prenume: 'Ion', functie: 'Contabil' };
const w = (tip, xmlStr) => { fs.writeFileSync(path.join(dir, tip + '.xml'), xmlStr); };

// D300 / D394 (TVA lunar din exemplu)
w('D300', xml.d300Xml(v.company, '2026-06', rep.d300(v, '2026-06'), who));
w('D394', xml.d394Xml(v.company, '2026-06', acc.vatJournals(v, '2026-06'), who));
// D390 (VIES) — exemplul n-are operatiuni intracomunitare; adaug una ca sa fie continut
const vIC = { entries: v.entries.concat([{ id: 'ic', data: '2026-06-18', period: '2026-06', tip: 'livrare_intracomunitara', tipNume: 'L', partener: 'GMBH', partenerCui: 'DE811907980', document: 'E1', lines: [{ debit: '4111', credit: '707', suma: 9000 }] }]), openingBalances: v.openingBalances };
w('D390', xml.d390Xml(v.company, '2026-06', rep.d390(vIC, '2026-06'), who));
// D112 (salarii)
w('D112', xml.d112Xml(v.company, '2026-06', statePlata(v.angajati), who));
// D100 (micro trimestrial)
w('D100', xml.d100Xml(v.company, '2026-06', rep.d100micro(v, '2026-06'), who));
// D101 (impozit pe profit, anual) — schema v10; exemplul are profit mic in 2026
w('D101', xml.d101Xml(v.company, rep.d101(v, '2026'), who));
// D205 (retineri la sursa) — an incheiat, cu un beneficiar de dividende
const vDiv = { entries: [{ id: 'd1', data: '2025-08-10', period: '2025-08', tip: 'repartizare_dividende', tipNume: 'Div', partener: 'Ion', partenerCui: '1900101415238', lines: [{ debit: '457', credit: '5121', suma: 9200 }, { debit: '457', credit: '446', suma: 800 }, { debit: '117', credit: '457', suma: 10000 }] }], openingBalances: {} };
w('D205', xml.d205Xml(v.company, '2025', rep.d205(vDiv, '2025'), who));
// Situatii financiare anuale — S1120 (microentitati) si S1121 (entitati mici).
// Antetul cere date pe care exemplul nu le are (administrator, intocmitor, forma de
// proprietate): le completam AICI, pentru referinta, nu cu valori implicite in cod —
// generatorul refuza deliberat sa inventeze identificarea unei firme reale.
const firmaBil = Object.assign({}, v.company, {
  telefon: '0211234567', formaProprietate: '35', administrator: 'Popescu Ion',
  intocmitNume: 'Ionescu Maria', intocmitCalitate: '21', intocmitNr: '12345', auditStatut: '3',
});
for (const [cat, tip] of [['micro', 'S1120'], ['mic', 'S1121'], ['mare', 'S1122']]) {
  const s = bilant.situatii(v, firmaBil, '2026', cat);
  if (s.lipsa.length) throw new Error(tip + ': antet incomplet — ' + s.lipsa.join('; '));
  w(tip, xml.bilantXml(s));
}

// D406 (SAF-T) — cele 4 variante
w('D406', saft.saftXml(v, '2026-06'));                                   // lunar (L)
w('D406-T', saft.saftXml(Object.assign({}, v, { company: Object.assign({}, v.company, { perioadaTva: 'T' }) }), '2026-Q2')); // trimestrial (T)
w('D406-A', saft.saftXml(v, '2026'));                                    // active (A)
w('D406-C', saft.saftXml(v, '2026', 'C'));                               // stocuri (C)

// RO e-Transport (cod UIT) — NU trece prin DUKIntegrator (schema lui e un XSD publicat separat);
// referinta se valideaza cu scripts/valideaza-etransport.sh. Exemplul de seed n-are aviz de
// insotire, deci construim unul minimal-realist: transport intern de marfa, pe rutier.
const avizRef = {
  id: 'et-ref', tip: 'aviz_livrare', tipNume: 'Aviz de insotire a marfii', data: '2026-06-20',
  period: '2026-06', document: 'AVIZ 100', partener: 'CLIENT EXEMPLU SRL', partenerCui: 'RO87654321',
  items: [{ nume: 'Cutii carton', cantitate: 100, um: 'buc', pret: 5, cota: 21 }],
  lines: getType('aviz_livrare').build({ baza: 500, tva: 105 }),
};
w('eTransport', etransport.eTransportXml(v.company, avizRef, {
  codScopOperatiune: '101', nrVehicul: 'B 100 XYZ', codTarifar: '48191000',
  greutateNeta: 120, greutateBruta: 140,
  final: { judet: 'Cluj', localitate: 'Cluj-Napoca', strada: 'Str. Fabricii', numar: '10' },
}));

const generate = fs.readdirSync(dir).filter((n) => n.endsWith('.xml'));
console.log('Referinte generate in ' + dir + ':\n  ' + generate.join('\n  '));
