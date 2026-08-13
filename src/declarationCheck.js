'use strict';

// Validarea pre-depunere a unei declaratii, ca FUNCTIE (nu ca ruta): construieste XML-ul tipului
// cerut din vederea scoped si il trece prin src/validate.js, cu contextul suplimentar pe care
// XML-ul nu-l poate arata singur (cote D300 fara rand in schema, articole D394 fara codul art. 331).
//
// Extrasa din ruta GET /api/validate/:type ca sa aiba UN SINGUR loc: cockpitul de inchidere lunara
// are nevoie de acelasi verdict ca butonul „Validează" din tabul de declaratii. Doua implementari ar
// fi divergent in timp, iar „dovada validarii" din dosarul lunii ar dovedi altceva decat ce vede
// contabilul pe ecran.

const xml = require('./xml');
const ptOpts = require('./profitTaxOptions'); // sursa unica a optiunilor de impozit pe profit
const rep = require('./reporting');
const acc = require('./accounting');
const saft = require('./saft');
const validate = require('./validate');
const { statePlata } = require('./payroll');
const d301 = require('./d301');
const d311 = require('./d311');

/** Tipurile pentru care stim sa construim XML (si deci sa validam). */
const TYPES = ['d300', 'd301', 'd311', 'd394', 'd390', 'd100', 'd101', 'intrastat', 'd205', 'd112', 'saft'];

/** Construieste XML-ul declaratiei. Arunca erorile generatoarelor (apelantul le traduce in 400). */
function buildXml(v, type, opts) {
  const o = opts || {};
  const period = o.period || null;
  const year = o.year || String(new Date().getFullYear());
  const declarant = o.declarant || null;
  const pv = acc.vatPeriod(v.company, period); // D300/D394: agrega trimestrul la regim 'T'
  if (type === 'd300') return xml.d300Xml(v.company, pv, rep.d300(v, pv), declarant);
  if (type === 'd301') return xml.d301Xml(v.company, period, d301.report(v, period), declarant);
  if (type === 'd311') return xml.d311Xml(v.company, period, d311.report(v, period), declarant);
  if (type === 'd394') return xml.d394Xml(v.company, pv, acc.vatJournals(v, pv), declarant, rep.achizitiiPfCarnet(v, pv));
  if (type === 'd390') return xml.d390Xml(v.company, period, rep.d390(v, period));
  if (type === 'd100') return xml.d100Xml(v.company, period, rep.d100(v, period), declarant);
  if (type === 'd101') return xml.d101Xml(v.company, rep.d101(v, year, ptOpts.pentruDeclaratie(v, year)), declarant);
  if (type === 'intrastat') return xml.intrastatXml(v.company, period, rep.intrastat(v, period));
  if (type === 'd205') return xml.d205Xml(v.company, year, rep.d205(v, year));
  if (type === 'd112') return xml.d112Xml(v.company, period, statePlata(v.angajati, period, v.payrollHistory), declarant);
  if (type === 'saft') return saft.saftXml(v, year);
  const e = new Error('Tip de declaratie necunoscut: ' + type);
  e.status = 400;
  throw e;
}

/**
 * Verdictul de validare pentru (firma, tip, perioada): { type, period, ok, errors[], warnings[] }.
 * Erorile de GENERARE (date incomplete care fac XML-ul imposibil) devin `ok:false` cu mesajul lor —
 * pentru cockpit e acelasi lucru ca o eroare de validare: declaratia nu se poate depune asa.
 */
function validateFor(v, type, opts) {
  const o = opts || {};
  let x = '';
  try {
    x = buildXml(v, type, o);
  } catch (e) {
    if (!TYPES.includes(type)) throw e; // tip necunoscut: eroare de apel, nu verdict
    return { type, period: o.period || null, ok: false, errors: [e.message], warnings: [] };
  }
  const ctxVal = { cui: v.company.cui };
  const pv = acc.vatPeriod(v.company, o.period || null);
  // D300: cotele fara rand in v12 nu se vad in XML (tocmai fiindca nu le mai emitem) — se
  // calculeaza din aceeasi sursa ca decontul si se dau validarii ca sa le poata raporta.
  if (type === 'd300') ctxVal.coteFaraRand = xml.d300CoteFaraRand(rep.d300(v, pv));
  // D394: articolele cu taxare inversa fara cod de bun art. 331 nu se vad in XML (op11 lipseste
  // tocmai pentru ca nu inventam un cod) — se calculeaza din jurnal, ca sa le putem numi.
  if (type === 'd394') ctxVal.faraCodCategorie = xml.d394FaraCodCategorie(acc.vatJournals(v, pv));
  const result = validate.validateDeclaration(type, x, ctxVal);
  // D100: adauga avertismentele de eligibilitate micro (plafon venituri + conditia de salariat)
  if (type === 'd100') result.warnings.push(...(rep.d100(v, o.period || null).avertismente || []));
  // D390: operatiunile cu taxare inversa pe care nu le-am putut incadra pe o tara UE. Nu sunt erori
  // — un serviciu primit dintr-un stat tert chiar nu se declara — dar nici nu au voie sa dispara
  // tacut: din date nu se poate distinge intre „prestator din afara UE" si „am uitat codul de TVA
  // al partenerului", iar a doua varianta lasa declaratia incompleta. Cazul tipic e furnizorul de
  // reclama sau gazduire inregistrat cu denumirea, fara cod. XML-ul nu le poate arata (tocmai
  // fiindca nu sunt in el), deci vin din raport, ca la cotele D300 fara rand.
  if (type === 'd390') {
    for (const a of rep.d390(v, o.period || null).avertismente || []) {
      result.warnings.push('Operatiune cu taxare inversa neinclusa in D390 (cod ' + a.cod + ', '
        + a.baza + ' lei, ' + (a.partener || 'partener necompletat') + ', articolul ' + a.entryId + '): '
        + (a.cui ? 'codul de TVA „' + a.cui + '" nu are prefix de stat membru UE' : 'partenerul nu are cod de TVA')
        + '. Daca prestatorul e din UE, completeaza-i codul de TVA; daca e din afara UE, operatiunea '
        + 'se taxeaza invers dar corect nu se declara.');
    }
  }
  return Object.assign({ type, period: o.period || null }, result);
}

module.exports = { TYPES, buildXml, validateFor };
