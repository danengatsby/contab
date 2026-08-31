'use strict';

const { round2 } = require('../util');

/**
 * Tipuri de documente primare si "traducerea" lor in articole contabile.
 *
 * Fiecare tip are:
 *   - id, nume
 *   - grup (pentru gruparea in UI)
 *   - fields: campurile pe care le confirma utilizatorul (pre-completate de extractor)
 *   - build(d): primeste valorile campurilor si returneaza liniile contabile
 *               [{ debit, credit, suma, explicatie }]
 *   - eFactura: 'da' | 'nu' — documentul e o FACTURA (sau o nota de credit) pe care o EMITEM?
 *               Decide daca se poate genera UBL si daca pleaca in SPV. Vezi mai jos.
 *
 * ── `eFactura`: de ce sta AICI si nu intr-o lista ──────────────────────────────────────────────
 * A fost o multime de patru id-uri scrisa de mana in `src/xml.js`, copiata inca de doua ori
 * (`declarations.js`, `reporting.js`). Consecinta: opt tipuri care emit facturi — avansul catre
 * client, facturarea avizului, vanzarea unui mijloc fix, taxarea inversa interna, reducerea
 * comerciala, factura in valuta, factura la incasare — nu puteau fi trimise in e-Factura deloc,
 * desi raportarea B2B e obligatorie din 1 iulie 2024 (OUG 120/2021), cu sanctiune de 15% din
 * valoarea facturii. O lista scrisa de mana intr-un fisier de generare XML nu are cum sa fie
 * completa: nimeni nu se duce s-o actualizeze cand adauga un tip de document.
 *
 * Raspunsul sta pe TIP fiindca e o proprietate a documentului („e factura sau nu"), nu a
 * partenerului. Intrebarea a doua — „beneficiarul e stabilit in Romania?", care decide daca
 * netrimiterea e o INCALCARE cu termen — se pune pe articol, dupa CUI-ul partenerului, in
 * `declarations.eFacturaNetrimise`. Cele doua conditii sunt independente si se greseau impreuna.
 *
 * Valoarea 'nu' se scrie EXPLICIT (cu motiv in comentariu) pe documentele care seamana cu o
 * factura dar nu sunt — bonul Z, avizul de insotire, diferenta de curs. Doua porti din
 * `test/run.js` cer decizia explicita: una structurala (orice tip care produce semnatura contabila
 * a unei facturi catre client) si una pe grup (tot ce e in grupul „Vanzari"). Un tip nou de vanzare
 * pica suita pana cand cineva raspunde la intrebare — asta e tot rostul.
 *
 * Tipuri de camp:
 *   number  -> input numeric
 *   text    -> input text
 *   date    -> input data
 *   select  -> lista (options: [{value,label}])
 *   account -> selector de cont din planul de conturi
 */

function L(debit, credit, suma, explicatie) {
  return { debit: String(debit), credit: String(credit), suma: round2(suma), explicatie };
}

/** Parametru din FiscalRuleSet-ul injectat de composeEntry pentru data documentului. */
function rate(d, key) {
  const value = Number((d && d._fiscalRates || {})[key]);
  if (!Number.isFinite(value)) {
    const e = new Error('Parametrul fiscal „' + key + '” nu poate fi dedus: data documentului nu are un FiscalRuleSet publicat. Completeaza valoarea explicit sau publica regulile perioadei.');
    e.status = 422; throw e;
  }
  return value;
}

/** Executa un tratament din fotografia documentului si retine urma pentru articolul contabil. */
function treatment(d, id, facts) {
  if (!d || !d._fiscalRuleSet) return null; // document istoric neacoperit, cu valori explicite
  const decision = require('../fiscal').evaluateTreatment(d._fiscalRuleSet, id, facts);
  if (decision.status !== 'computed') {
    const e = new Error('Tratamentul fiscal „' + id + '” nu poate fi aplicat: ' + (decision.reason || decision.status) + '.');
    e.status = 422; throw e;
  }
  if (!Object.prototype.hasOwnProperty.call(d, '_fiscalTreatmentDecisions')) {
    Object.defineProperty(d, '_fiscalTreatmentDecisions', { value: [], enumerable: false });
  }
  d._fiscalTreatmentDecisions.push(decision);
  return decision;
}

const F = {
  data: { name: 'data', label: 'Data document', type: 'date', required: true },
  partener: { name: 'partener', label: 'Partener (client/furnizor)', type: 'text' },
  document: { name: 'document', label: 'Serie/numar document', type: 'text' },
  scadenta: { name: 'scadenta', label: 'Scadenta documentului', type: 'date' },
  termenContractual: { name: 'termenContractual', label: 'Termen contractual (zile)', type: 'number', min: 0, max: 36500 },
  baza: { name: 'baza', label: 'Valoarea fara TVA', type: 'number', required: true },
  tva: { name: 'tva', label: 'TVA (lei)', type: 'number', default: 0 },
  cota: { name: 'cota', label: 'Cota TVA (%)', type: 'number', default: 0, fiscalRate: 'tvaStandard' },
  suma: { name: 'suma', label: 'Suma (lei)', type: 'number', required: true },
  explicatie: { name: 'explicatie', label: 'Explicatie', type: 'text' },
  cuiPartener: { name: 'cuiPartener', label: 'CUI client (pentru e-Factura)', type: 'text' },
  cuiFurnizor: { name: 'cuiPartener', label: 'CUI furnizor (pentru D394)', type: 'text' },
  analiticBanca: { name: 'analitic', label: 'Analitic bancă/casă (ex. BCR, ING)', type: 'text' },
  analiticAngajat: { name: 'analitic', label: 'Analitic angajat (ex. Ion Popescu)', type: 'text' },
  items: { name: 'items', label: 'Linii factura (optional, pentru e-Factura)', type: 'items' },
  stoc: { name: 'stoc', label: 'Descarcare din stoc (produs + gestiune + cantitate) — cost CMP/FIFO, automat', type: 'stoc' },
  auto50: { name: 'auto50', label: 'Cheltuiala este pentru o mașină folosită și personal (aplicația deduce 50% din TVA)', type: 'checkbox', special: true },
  tratamentFiscal635Auto: { name: 'tratamentFiscalCheltuiala', label: 'Utilizarea vehiculului pentru taxa de drum (tratament impozit pe profit)', type: 'select', required: true,
    options: [{ value: '', label: 'Alege obligatoriu…' },
      { value: 'vehicle_exclusive', label: 'Exclusiv pentru activitatea economica — 100% deductibila' },
      { value: 'vehicle_mixed', label: 'Utilizare economica si personala — 50% deductibila' }] },
  tratamentFiscal654: { name: 'tratamentFiscalCheltuiala', label: 'Motivul fiscal al scoaterii creantei din evidenta', type: 'select', required: true,
    options: [{ value: '', label: 'Alege obligatoriu…' },
      { value: 'general_bad_debt', label: 'Fara exceptie legala — nedeductibila' },
      { value: 'reorganization_plan', label: 'Plan de reorganizare confirmat de instanta' },
      { value: 'bankruptcy_closed', label: 'Faliment inchis prin hotarare judecatoreasca' },
      { value: 'deceased_no_heirs', label: 'Debitor decedat, nerecuperabila de la mostenitori' },
      { value: 'dissolved_without_successor', label: 'Debitor dizolvat/lichidat fara succesor' },
      { value: 'major_financial_difficulty', label: 'Dificultati financiare majore asupra intregului patrimoniu' },
      { value: 'insurance_covered', label: 'Creanta acoperita de asigurare' }] },
  documenteJustificativeFiscal: { name: 'documenteJustificativeFiscal', label: 'Document justificativ fiscal (numar hotarare/decizie/polita; fisierul incarcat se leaga automat)', type: 'text' },
  // Art. 310 alin. (2): aceeasi nota de credit/factura in valuta poate ajusta o operatiune
  // taxabila, un export, o operatiune cu locul in strainatate ori o cedare de activ exclusa.
  // Contul de venit nu raspunde la aceasta intrebare; natura se cere explicit.
  naturaTvaArt310: { name: 'naturaTvaArt310', label: 'Natura operatiei pentru plafonul TVA (art. 310)', type: 'select', required: true,
    options: [{ value: '', label: 'Alege obligatoriu…' },
      { value: 'taxable', label: 'Taxabila in Romania (sau ar fi taxabila fara scutirea de mica intreprindere)' },
      { value: 'exempt_with_deduction', label: 'Scutita cu drept de deducere (ex. export/livrare intracomunitara)' },
      { value: 'exempt_without_deduction_main', label: 'Scutita fara drept art. 292(2) a/b/e/f, NEACCESORIE activitatii principale' },
      { value: 'exempt_without_deduction_other', label: 'Alta scutire fara drept / operatiune accesorie — exclusa' },
      { value: 'outside_romania', label: 'Locul livrarii/prestarii este in afara Romaniei — exclusa' },
      { value: 'fixed_asset_transfer', label: 'Cedare de activ fix corporal — exclusa' },
      { value: 'intangible_asset_transfer', label: 'Cesiune/transfer de activ necorporal — exclusa' }] },
  proRataMixt: { name: 'proRataMixt', label: 'Achiziția este folosită și pentru activități fără drept de deducere TVA', type: 'checkbox', special: true },
  // Codul de bun art. 331 (nomenclatorul oficial D394, sectiunea op11). Fara el, D394 e respins
  // („R233.5: trebuie completata cel putin o sectiune op11"). Se cere codul, nu o denumire aleasa
  // dintr-o lista: nomenclatorul nu e expus de validator si o lista ghicita ar da o declaratie
  // valida dar gresita. Acceptate pentru persoane juridice: 22-31 si 36.
  codCategorie331: { name: 'codCategorie331', label: 'Cod categorie bun (nomenclatorul D394, art. 331) — acceptate 22-31 și 36', type: 'number', default: 0 },
  // Intrastat (doar pentru operatiuni intracomunitare de bunuri)
  codNC: { name: 'codNC', label: 'Cod NC8 (Intrastat)', type: 'text' },
  masaNeta: { name: 'masaNeta', label: 'Masa neta kg (Intrastat)', type: 'number', default: 0 },
  naturaTranz: { name: 'naturaTranz', label: 'Natura tranzactiei (Intrastat)', type: 'text', default: '11' },
  conditieLivrare: { name: 'conditieLivrare', label: 'Conditie de livrare (Intrastat, ex. EXW)', type: 'text' },
};

const TROZ = [
  { value: '5311', label: '5311 Casa in lei' },
  { value: '5121', label: '5121 Banca in lei' },
];

const TVAL = [
  { value: '4111', label: '4111 Clienti (creanta in valuta)' },
  { value: '401', label: '401 Furnizori (datorie in valuta)' },
  { value: '5124', label: '5124 Banca in valuta' },
  { value: '5314', label: '5314 Casa in valuta' },
];

module.exports = { L, F, TROZ, TVAL, rate, treatment };
