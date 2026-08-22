'use strict';

const { round2 } = require('../util');
const fiscal = require('../fiscal');

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

const F = {
  data: { name: 'data', label: 'Data document', type: 'date', required: true },
  partener: { name: 'partener', label: 'Partener (client/furnizor)', type: 'text' },
  document: { name: 'document', label: 'Serie/numar document', type: 'text' },
  baza: { name: 'baza', label: 'Valoarea fara TVA', type: 'number', required: true },
  tva: { name: 'tva', label: 'TVA (lei)', type: 'number', default: 0 },
  cota: { name: 'cota', label: 'Cota TVA (%)', type: 'number', default: fiscal.FISCAL.tvaStandard },
  suma: { name: 'suma', label: 'Suma (lei)', type: 'number', required: true },
  explicatie: { name: 'explicatie', label: 'Explicatie', type: 'text' },
  cuiPartener: { name: 'cuiPartener', label: 'CUI client (pentru e-Factura)', type: 'text' },
  cuiFurnizor: { name: 'cuiPartener', label: 'CUI furnizor (pentru D394)', type: 'text' },
  analiticBanca: { name: 'analitic', label: 'Analitic bancă/casă (ex. BCR, ING)', type: 'text' },
  analiticAngajat: { name: 'analitic', label: 'Analitic angajat (ex. Ion Popescu)', type: 'text' },
  items: { name: 'items', label: 'Linii factura (optional, pentru e-Factura)', type: 'items' },
  stoc: { name: 'stoc', label: 'Descarcare din stoc (produs + gestiune + cantitate) — cost CMP/FIFO, automat', type: 'stoc' },
  auto50: { name: 'auto50', label: 'Deductibilitate auto 50% (vehicul fara uz exclusiv): 50% din TVA devine nedeductibil si intra in cost', type: 'checkbox' },
  proRataMixt: { name: 'proRataMixt', label: 'Achizitie cu destinatie mixta (pro-rata, art. 300): TVA deductibila doar in procentul pro-rata setat pe firma, restul intra in cost', type: 'checkbox' },
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

module.exports = { L, F, TROZ, TVAL };
