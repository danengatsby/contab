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
const ptOpts = require('../src/profitTaxOptions');

const dir = process.argv[2] || path.join(require('os').tmpdir(), 'contab-referinte');
fs.mkdirSync(dir, { recursive: true });

const v = scopedSeed();
const who = { nume: 'Popescu', prenume: 'Ion', functie: 'Contabil' };
const w = (tip, xmlStr) => { fs.writeFileSync(path.join(dir, tip + '.xml'), xmlStr); };

// D300 / D394 (TVA lunar din exemplu)
w('D300', xml.d300Xml(v.company, '2026-06', rep.d300(v, '2026-06'), who));
// D300 varianta cu POZITIE REPORTATA: exemplul de mai sus n-are sold de TVA din perioadele
// anterioare, deci randurile 35 si 38 (si formulele R37/R40 care le folosesc) nu se exercita
// niciodata — poarta ar ramane verde fara sa fi verificat calea noua, exact ca la D101-defalcare.
// Aici ianuarie lasa 4.200 lei de recuperat, februarie datoreaza 8.400, deci rd. 38 = 4.200 si
// rd. 41 = 4.200. Numele „D300-report" duce tot la validatorul D300 (vezi valideaza-referinte.sh).
const vRep = {
  company: v.company, openingBalances: {},
  entries: [
    { id: 'tr1', firmaId: 1, data: '2026-01-10', period: '2026-01', tip: 'diverse', tipNume: 'Achizitie', status: 'postat',
      lines: [{ debit: '371', credit: '401', suma: 20000 }, { debit: '4426', credit: '401', suma: 4200 }] },
    { id: 'tr2', firmaId: 1, data: '2026-01-31', period: '2026-01', tip: 'inchidere_tva', tipNume: 'Inchidere TVA', status: 'postat',
      lines: [{ debit: '4424', credit: '4426', suma: 4200 }] },
    { id: 'tr3', firmaId: 1, data: '2026-02-10', period: '2026-02', tip: 'diverse', tipNume: 'Vanzare', status: 'postat',
      lines: [{ debit: '4111', credit: '707', suma: 40000 }, { debit: '4111', credit: '4427', suma: 8400 }] },
  ],
};
w('D300-report', xml.d300Xml(v.company, '2026-02', rep.d300(vRep, '2026-02'), who));
w('D394', xml.d394Xml(v.company, '2026-06', acc.vatJournals(v, '2026-06'), who));
// D390 (VIES) — exemplul n-are operatiuni intracomunitare; adaug una ca sa fie continut
const vIC = { entries: v.entries.concat([{ id: 'ic', data: '2026-06-18', period: '2026-06', tip: 'livrare_intracomunitara', tipNume: 'L', partener: 'GMBH', partenerCui: 'DE811907980', document: 'E1', lines: [{ debit: '4111', credit: '707', suma: 9000 }] }]), openingBalances: v.openingBalances };
w('D390', xml.d390Xml(v.company, '2026-06', rep.d390(vIC, '2026-06'), who));
// D112 (salarii)
w('D112', xml.d112Xml(v.company, '2026-06', statePlata(v.angajati), who));
// D112 varianta CONCEDIU MEDICAL: angajatul din exemplu nu are niciunul, deci repartizarea
// angajator/FNUASS si indemnizatia din baza CAS n-ar fi exercitate niciodata la validator. Data de
// inceput cade JOI, adica exact cazul in care primele 5 zile CALENDARISTICE contin doar 3 zile
// lucratoare — cifra pe care formula veche o dadea 5.
const angCM = (v.angajati || []).map((a, i) => (i === 0
  ? Object.assign({}, a, { zileCM: 10, procentCM: 75, dataInceputCM: '2026-06-11' })
  : a));
{
  const spCM = statePlata(angCM, '2026-06', v.payrollHistory);
  const r0 = spCM.rows[0];
  if (r0.zileCMAngajator !== 3) {
    throw new Error('D112-cm: angajatorul nu suporta 3 zile (concediu inceput joi) — ' + r0.zileCMAngajator);
  }
  if (!(r0.cmFnuass > 0) || !(r0.cmAngajator > 0)) {
    throw new Error('D112-cm: repartizarea angajator/FNUASS nu e exercitata — ' + JSON.stringify(r0));
  }
  w('D112-cm', xml.d112Xml(v.company, '2026-06', spCM, who));
}

// D112 varianta cu AVANTAJE PESTE PLAFONUL DE 33% (art. 76 alin. (4^1)): angajatul din exemplu
// n-are niciunul, deci partea impozabila ar fi mereu zero si validatorul ar confirma un camp gol —
// aceeasi problema ca la D390 mai sus. La 5.000 lei salariu de baza plafonul e 1.650, iar cazarea
// are si limita ei (20% din salariul minim), deci varianta exercita AMBELE taieri si trimite la
// ANAF baze CAS/CASS/CAM marite fata de brut.
const vBen = { company: v.company, angajati: v.angajati.map((a) => Object.assign({}, a, { beneficii: { cazare: 1000, pensii: 800, sport: 200 } })) };
w('D112-beneficii', xml.d112Xml(vBen.company, '2026-06', statePlata(vBen.angajati), who));
// D100 (micro trimestrial)
w('D100', xml.d100Xml(v.company, '2026-06', rep.d100micro(v, '2026-06'), who));
// D100 varianta IMPOZIT PE PROFIT (art. 41, trimestrele I-III): alt cod de obligatie (103) si alt
// cod bugetar (20470101) decat cel de micro. Exemplul implicit e o firma pe micro, deci calea nu
// s-ar exercita niciodata — ca la D101-defalcare si D300-report.
const vProfit = {
  company: Object.assign({}, v.company, { regimImpozit: 'profit' }), openingBalances: {}, assets: [],
  entries: [{ id: 'pf1', firmaId: 1, data: '2026-02-10', period: '2026-02', tip: 'diverse', tipNume: 'Venit', status: 'postat',
    lines: [{ debit: '4111', credit: '704', suma: 100000 }] }],
};
w('D100-profit', xml.d100Xml(vProfit.company, '2026-03', rep.d100(vProfit, '2026-03'), who));
// D100 varianta PLATI ANTICIPATE (art. 41 alin. (2)): aceeasi obligatie 103, dar ALTA suma — o
// patrime din impozitul anului precedent, actualizat cu indicele preturilor de consum — si un
// trimestru in plus de declarat (T4, cu termen 25 decembrie). Fara aceasta varianta, poarta ar fi
// validat mereu doar calea trimestriala: exemplul integrat e o firma pe micro, iar `D100-profit`
// exercita sistemul implicit. Acelasi motiv pentru care exista `D112-beneficii` — o cale fiscala
// noua fara referinta proprie trece pe LANGA validatorul oficial, nu prin el.
const vAnticipat = {
  company: Object.assign({}, vProfit.company, {
    sistemProfit: 'anual', impozitProfitAn: { 2025: 40000 }, ipcAnticipate: { 2026: 4.5 },
  }),
  openingBalances: {}, assets: [], entries: vProfit.entries,
};
const rAnticipat = rep.d100(vAnticipat, '2026-12'); // trimestrul IV — cel care NU exista in celalalt sistem
if (rAnticipat.blocat) throw new Error('D100-anticipat: plata anticipata nu s-a putut calcula');
if (rAnticipat.impozit !== 10450) throw new Error('D100-anticipat: plata anticipata neasteptata — ' + rAnticipat.impozit);
w('D100-anticipat', xml.d100Xml(vAnticipat.company, '2026-12', rAnticipat, who));
// D406 cu STORNO IN ROSU: stornoul generic scrie sume NEGATIVE (aceleasi conturi, suma negata),
// deci ajung asa in <DebitAmount>/<CreditAmount>. Exemplul n-are niciun storno, deci varianta
// periodica n-ar purta nicio suma negativa si poarta n-ar verifica niciodata ca schema le accepta.
const vStorno = (() => {
  const c = JSON.parse(JSON.stringify(v));
  const orig = c.entries.find((e) => (e.lines || []).some((l) => l.credit === '4427'));
  if (orig) {
    c.entries.push({ id: 'e-storno-rosu', firmaId: orig.firmaId, data: '2026-06-25', period: '2026-06',
      tip: 'storno', tipNume: 'Storno ' + orig.tipNume, partener: orig.partener, partenerCui: orig.partenerCui,
      document: 'Storno ' + orig.document, explicatie: 'Stornare', status: 'postat', system: true, stornoOf: orig.id,
      lines: orig.lines.map((l) => ({ debit: l.debit, credit: l.credit, suma: -l.suma, explicatie: 'Storno' })) });
  }
  return c;
})();
w('D406-storno', saft.saftXml(vStorno, '2026-06'));
// D101 (impozit pe profit, anual) — schema v10; exemplul are profit mic in 2026
// Calea REALA de productie trece prin `profitTaxOptions.pentruDeclaratie` — aceleasi reguli ca
// nota contabila 691 = 4411. Reperul o foloseste si el, altfel poarta ar valida un XML pe care
// aplicatia nu-l mai produce.
w('D101', xml.d101Xml(v.company, rep.d101(v, '2026', ptOpts.pentruDeclaratie(v, '2026')), who));
// D101 varianta DEFALCATA: exemplul de mai sus n-are cheltuieli cu plafon, deci nedeductibilele
// ies zero si randurile P23..P33 nu se exercita deloc — poarta ar fi verde fara sa fi verificat
// calea noua. Aici e un an cu protocol, cheltuieli sociale, auto, sponsorizare si amortizare
// contabila diferita de cea fiscala, adica toate formele de repartizare, inclusiv perechea
// P28/P11. Numele „D101-defalcare" duce tot la validatorul D101 (vezi valideaza-referinte.sh).
const vDef = {
  company: v.company, openingBalances: {},
  entries: [{
    id: 'x1', firmaId: 1, data: '2026-11-30', period: '2026-11', tip: 'diverse', tipNume: 'Ajustari', status: 'postat',
    lines: [
      { debit: '5121', credit: '704', suma: 400000 },  // venituri
      { debit: '623', credit: '401', suma: 20000 },    // protocol (plafon 2%)
      { debit: '6458', credit: '401', suma: 12000 },   // cheltuieli sociale (plafon 5% din 641)
      { debit: '641', credit: '421', suma: 120000 },   // fond de salarii
      { debit: '6582', credit: '401', suma: 8000 },    // sponsorizare
      { debit: '6811', credit: '281', suma: 30000 },   // amortizare contabila
    ],
  }],
};
w('D101-defalcare', xml.d101Xml(v.company, rep.d101(vDef, '2026', {
  plafoane: require('../src/fiscalConfig').RATES,
  cheltAuto: 15000,                                   // vehicule fara uz exclusiv business (50%)
  amortizare: { contabila: 30000, fiscala: 22000 },   // art. 28 -> P28 = 30000, P11 = 22000
}), who));
// D177 (redirectionarea impozitului catre beneficiari). Exemplul n-are sponsorizari, deci calea
// n-ar fi exercitata deloc — acelasi tipar ca la D390 / D300-report / D101-defalcare. Aici un an
// cu sponsorizare de 1.500 pe o cifra de afaceri care lasa plafon, si un beneficiar complet.
const vSpons = {
  company: v.company, openingBalances: {},
  partners: { 12345674: { cui: '12345674', den: 'ASOCIATIA TEST', adresa: 'Str. ONG 2', iban: 'RO49AAAA1B31007593840000', telefon: '0211111111', email: 'ong@test.ro' } },
  entries: [{ id: 'sp1', firmaId: 1, data: '2025-06-30', period: '2025-06', tip: 'diverse', tipNume: 'Sponsorizare',
    status: 'postat', partener: 'ASOCIATIA TEST', partenerCui: 'RO12345674', document: 'CTR 7/2025',
    lines: [{ debit: '5121', credit: '704', suma: 500000 }, { debit: '6582', credit: '5121', suma: 1500 }] }],
};
w('D177', xml.d177Xml(v.company, rep.d177(vSpons, '2025', { profitTax: { cota: 16, plafoane: require('../src/fiscalConfig').RATES } })));

// D390 + D300 varianta AUTOFACTURA (art. 320): cumparatorul emite factura in locul furnizorului
// care n-a trimis-o. Datoria sta pe 408, nu pe 401, iar TVA-ul e exigibil FARA factura — deci
// atat citirea bazei in D390, cat si incadrarea pe randul de autolichidare din decont trec pe cai
// care nu existau. Exemplul integrat nu are asa ceva, deci fara varianta asta poarta ar valida
// mereu doar achizitia intracomunitara obisnuita.
const vAuto = {
  company: v.company, openingBalances: {}, assets: [],
  entries: [{ id: 'af1', firmaId: 1, data: '2026-06-12', period: '2026-06', tip: 'autofactura_achizitie',
    tipNume: 'Autofactura (art. 320)', status: 'postat', partener: 'DE FURNIZOR GMBH',
    partenerCui: 'DE811907980', document: 'AUTOF 1/2026', naturaAutofactura: 'intracom',
    lines: [{ debit: '371', credit: '408', suma: 10000 }, { debit: '4426', credit: '4427', suma: 2100 }] }],
};
{
  const r390 = rep.d390(vAuto, '2026-06');
  if (r390.rows.length !== 1 || r390.rows[0].baza !== 10000) {
    throw new Error('D390-autofactura: baza citita gresit — ' + JSON.stringify(r390.rows));
  }
  const r300 = rep.d300(vAuto, '2026-06');
  if (r300.coteV.length) throw new Error('D300-autofactura: autofactura a ajuns pe randurile de livrare');
  w('D390-autofactura', xml.d390Xml(v.company, '2026-06', r390, who));
  w('D300-autofactura', xml.d300Xml(v.company, '2026-06', r300, who));
}

// D300 varianta PRO-RATA / TVA partial deductibila: „taxa dedusa" (R28) mai mica decat „taxa
// deductibila" (R27). Referinta de baza deduce integral, deci randul R28 n-ar fi exercitat
// niciodata — iar aici traieste tot mecanismul pro-ratei in decont. Include si o achizitie cu
// TAXARE INVERSA si deducere limitata: acolo perechea R5/R18 trebuie sa ramana pe sumele
// INTEGRALE (validatorul cere R18 = R5), iar limitarea sa iasa doar prin R28.
const vPr = {
  company: v.company, openingBalances: {}, assets: [],
  entries: [
    { id: 'pr1', firmaId: 1, data: '2026-06-08', period: '2026-06', tip: 'factura_imobilizare',
      tipNume: 'Achizitie imobilizare (destinatie mixta)', status: 'postat', partener: 'FURNIZOR SRL',
      partenerCui: '99887760', document: 'FI 7/2026',
      lines: [{ debit: '2131', credit: '404', suma: 10420 }, { debit: '4426', credit: '404', suma: 1680 }],
      tvaPartial: { baza: 10000, cota: 21, tvaFactura: 2100, tvaDedusa: 1680 } },
    { id: 'pr2', firmaId: 1, data: '2026-06-19', period: '2026-06', tip: 'achizitie_intracomunitara',
      tipNume: 'Achizitie intracomunitara (destinatie mixta)', status: 'postat', partener: 'GAMMA GMBH',
      partenerCui: 'DE811907980', document: 'IC 12/2026',
      lines: [{ debit: '371', credit: '401', suma: 5000 }, { debit: '4426', credit: '4427', suma: 840 },
        { debit: '371', credit: '4427', suma: 210 }],
      tvaPartial: { baza: 5000, cota: 21, tvaFactura: 1050, tvaDedusa: 840 } },
    { id: 'pr3', firmaId: 1, data: '2026-06-25', period: '2026-06', tip: 'factura_vanzare_servicii',
      tipNume: 'Vanzare', status: 'postat', partener: 'CLIENT SRL', partenerCui: '99887760',
      document: 'FV 30/2026',
      lines: [{ debit: '4111', credit: '704', suma: 20000 }, { debit: '4111', credit: '4427', suma: 4200 }] },
  ],
};
{
  const dPr = rep.d300(vPr, '2026-06');
  const aPr = xml.d300Rows(dPr);
  if (!(aPr.R28_2 < aPr.R27_2)) {
    throw new Error('D300-prorata: R28 nu e mai mic decat R27 — varianta nu exercita pro-rata ('
      + aPr.R27_2 + ' / ' + aPr.R28_2 + ')');
  }
  // Perechea de autolichidare trebuie sa ramana pe sumele INTEGRALE, altfel taxa colectata iese
  // subdeclarata si validatorul pica pe V7/V8.
  if (aPr.R18_1 !== aPr.R5_1 || aPr.R18_2 !== aPr.R5_2) {
    throw new Error('D300-prorata: perechea R5/R18 nu mai e egala — ' + JSON.stringify(aPr));
  }
  if (aPr.R5_2 !== 1050) throw new Error('D300-prorata: taxa colectata din autolichidare nu e integrala: ' + aPr.R5_2);
  w('D300-prorata', xml.d300Xml(v.company, '2026-06', dPr, who));
}

// D390 + D300 varianta SERVICII intracomunitare (art. 278 alin. (2), declarate prin art. 325).
// Referinta de mai sus are doar o livrare de BUNURI, deci codurile P si S — adaugate abia acum —
// n-ar fi exercitate niciodata la validatorul oficial. Aceeasi ratiune ca la varianta autofactura.
// In plus, calea pe servicii atinge in decont perechea R7/R20, nu R5/R18 ca bunurile.
const vServ = {
  company: v.company, openingBalances: {}, assets: [],
  entries: [
    { id: 'sv1', firmaId: 1, data: '2026-06-14', period: '2026-06', tip: 'prestare_servicii_intracomunitara',
      tipNume: 'Prestare servicii intracomunitara', status: 'postat', partener: 'ALFA GMBH',
      partenerCui: 'DE811907980', document: 'FS 44/2026',
      lines: [{ debit: '4111', credit: '704', suma: 7000 }] },
    { id: 'sv2', firmaId: 1, data: '2026-06-20', period: '2026-06', tip: 'achizitie_servicii_intracomunitara',
      tipNume: 'Achizitie servicii intracomunitara', status: 'postat', partener: 'BETA LIMITED',
      partenerCui: 'IE8256796U', document: 'INV-2026-0620',
      lines: [{ debit: '628', credit: '401', suma: 3000 }, { debit: '4426', credit: '4427', suma: 630 }] },
  ],
};
{
  const r390s = rep.d390(vServ, '2026-06');
  if (r390s.totaluri.P !== 7000 || r390s.totaluri.S !== 3000) {
    throw new Error('D390-servicii: codurile P/S citite gresit — ' + JSON.stringify(r390s.totaluri));
  }
  if (r390s.totaluri.L || r390s.totaluri.A) {
    throw new Error('D390-servicii: serviciile au ajuns pe codurile de bunuri — ' + JSON.stringify(r390s.totaluri));
  }
  const r300s = rep.d300(vServ, '2026-06');
  const auto = r300s.autolichidari || {};
  if ((auto.intracomBunuri || {}).baza) throw new Error('D300-servicii: serviciile au ajuns pe randul de bunuri (R5)');
  if (((auto.taxareInversaInterna || {}).baza || 0) !== 3000) {
    throw new Error('D300-servicii: serviciile nu au ajuns pe randul R7 — ' + JSON.stringify(auto));
  }
  w('D390-servicii', xml.d390Xml(v.company, '2026-06', r390s, who));
  w('D300-servicii', xml.d300Xml(v.company, '2026-06', r300s, who));
}

// D205 (retineri la sursa) — an incheiat, cu un beneficiar de dividende
const vDiv = { entries: [{ id: 'd1', data: '2025-08-10', period: '2025-08', tip: 'repartizare_dividende', tipNume: 'Div', partener: 'Ion', partenerCui: '1900101415238', lines: [{ debit: '457', credit: '5121', suma: 9200 }, { debit: '457', credit: '446', suma: 800 }, { debit: '117', credit: '457', suma: 10000 }] }], openingBalances: {} };
w('D205', xml.d205Xml(v.company, '2025', rep.d205(vDiv, '2025'), who));
// D205 varianta RETINERI PE VENITURI (chirii + premii): referinta de baza are doar dividende, unde
// baza impozabila E chiar brutul. Chiriile si premiile sunt singurele in care baza difera de brut
// (art. 84 — minus cota forfetara de 20%; art. 110 alin. (4) — minus 600 lei neimpozabili), deci
// fara varianta asta randul cu baza calculata n-ar fi validat niciodata oficial.
const T205 = require('../src/documentTypes');
const eRet = (id, tip, partener, cnp, baza) => ({ id, firmaId: 1, tip, status: 'postat',
  data: '2025-07-15', period: '2025-07', partener, partenerCui: cnp, document: id.toUpperCase(),
  lines: T205.getType(tip).build({ baza, cota: 10, cont: tip === 'chirie_pf' ? '5121' : '5311' }) });
const vRet = { openingBalances: {}, entries: [
  eRet('ch1', 'chirie_pf', 'Ionescu Maria', '2900101415231', 12000),
  eRet('pr1', 'premiu_pf', 'Popescu Ion', '1900101415238', 1000),
] };
{
  const d205r = rep.d205(vRet, '2025');
  const ch = d205r.rows.find((r) => r.tipVenit === 'Chirii');
  const pr = d205r.rows.find((r) => r.tipVenit === 'Premii');
  if (!ch || ch.bazaImpozabila !== 9600) throw new Error('D205-retineri: baza chiriei nu e brut - 20% — ' + JSON.stringify(ch));
  if (!pr || pr.bazaImpozabila !== 400) throw new Error('D205-retineri: baza premiului nu e brut - 600 — ' + JSON.stringify(pr));
  // Raportul impozit/baza trebuie sa dea exact cota; cu brutul drept baza dadea 8%, respectiv 6%.
  for (const r of [ch, pr]) {
    if (Math.round((r.impozit / r.bazaImpozabila) * 100) !== 10) {
      throw new Error('D205-retineri: raportul impozit/baza nu da cota — ' + JSON.stringify(r));
    }
  }
  w('D205-retineri', xml.d205Xml(v.company, '2025', d205r, who));
}

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
