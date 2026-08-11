'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  SURSA UNICA a optiunilor de calcul al impozitului pe profit
//
//  Ce rezolva: `acc.profitTax` accepta ajustarile ca OPTIUNI, iar cine nu i le da primeste un
//  impozit calculat pe profitul contabil brut — corect ca aritmetica, gresit ca fiscalitate.
//  Inchiderea (`closingsService.closeProfitTax`) le dadea pe toate; cele PATRU locuri care
//  genereaza D101 (`/api/d101`, `/xml/d101`, dosarul anual, pre-validarea declaratiilor) chemau
//  `reporting.d101(v, year)` FARA optiuni. Deci nota contabila 691 = 4411 si declaratia depusa
//  la ANAF ieseau din acelasi motor cu doua seturi diferite de reguli.
//
//  Masurat pe un an cu venituri 100.000 si o amenda de 20.000 (integral nedeductibila,
//  art. 25(4)(b)): D101 raporta impozit 12.800, nota contabila 16.000 — cu 20% mai putin
//  DECLARAT decat INREGISTRAT. Aceeasi clasa de defect pe care proiectul a reparat-o o data
//  intre `registruFiscal` si `profitTax` („doua motoare pe aceeasi lege se contrazic garantat"),
//  ramasa pe a treia cale.
//
//  DOUA lucruri, nu unul. Al doilea nu se vede din prima:
//    (1) declaratia trebuie sa primeasca ACELEASI optiuni ca inchiderea — `construieste()`;
//    (2) dupa ce impozitul e postat, recalcularea nu mai poate reproduce cifra, fiindca
//        `firma.pierderiFiscale` a fost deja CONSUMATA de inchidere: aceleasi reguli pe o stare
//        schimbata dau alt rezultat. De aceea inchiderea isi salveaza rezultatul pe articol
//        (`entry.rezultatFiscal`), iar declaratia il REFOLOSESTE — `pentruDeclaratie()`.
//        Asa divergenta devine imposibila structural, nu doar improbabila.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('./db');
const fiscal = require('./fiscal');
const assets = require('./assets');
const acc = require('./accounting');
const rep = require('./reporting');

/** Rulajul net debitor al unui cont de cheltuiala intr-un an (amortizarea contabila REALA, din 6811).
 *  `resultLines`, NU `allLines`: dupa inchiderea anuala contul 6811 e creditat de articolul
 *  121 = 6811, iar o insumare oarba l-ar aduce la zero — deci amortizarea contabila ar disparea
 *  si ajustarea art. 28 ar iesi inversata. Aceeasi capcana pe care o evita si `reporting.d101`
 *  la veniturile si cheltuielile din declaratie. */
function rulajCont(view, year, cont) {
  const lines = acc.resultLines(acc.postedEntries(view)
    .filter((e) => String(e.period || '').startsWith(String(year))));
  const x = acc.accumulate(lines)[cont];
  return x ? Math.round((x.d - x.c) * 100) / 100 : 0;
}

/**
 * Optiunile complete de calcul, din starea firmei. `src` = suprascrierile din formularul de
 * inchidere (goale pentru calea declaratiei, care nu are formular).
 *
 * @param {object} view vederea scoped a firmei (`db.scoped(fid)`) — poarta si `company`
 * @param {string|number} year
 * @param {object} [src] suprascrieri manuale (cheltNedeductibile, deduceri, pierdereReportata, cursEur)
 */
function construieste(view, year, src) {
  src = src || {};
  const firma = (view && view.company) || {};
  const losses = firma.pierdereFiscala || {};
  const manualPierdere = src.pierdereReportata != null && src.pierdereReportata !== '';
  const pr = manualPierdere ? Number(src.pierdereReportata) : (Number(losses[Number(year) - 1]) || 0);
  return {
    cota: fiscal.FISCAL.impozitProfit,
    // Suprascrierea manuala ramane posibila, dar NU e implicita: transmisa goala, motorul de
    // plafoane calculeaza singur nedeductibilele din conturi (art. 25/40^2).
    cheltNedeductibile: (src.cheltNedeductibile != null && src.cheltNedeductibile !== '')
      ? Number(src.cheltNedeductibile) : null,
    deduceri: (src.deduceri != null && src.deduceri !== '') ? Number(src.deduceri) : null,
    pierdereReportata: pr || 0,
    // Vintage-urile (art. 31) bat scalarul: doar ele pot expira. Cand contabilul tasteaza o suma,
    // ea n-are an, deci nu poate fi imbatranita — atunci lista se ignora deliberat.
    ...(manualPierdere ? {} : { pierderi: firma.pierderiFiscale || [] }),
    plafoane: fiscal.FISCAL,
    cheltAuto: rep.cheltuieliAuto(view, year),
    cheltLipsaNeimputabila: rep.cheltuieliLipsaNeimputabila(view, year),
    // Baza ajustarilor de creante care indeplinesc conditiile art. 26 alin. (1) lit. c). Trece
    // PRIN AICI, ca `cheltAuto`: altfel declaratia ar recalcula fara ea si ar iesi alt impozit
    // decat nota contabila — exact divergenta pe care modulul acesta exista ca s-o inchida.
    ajustariCreanteBaza: rep.ajustariCreanteArt26(view, year),
    // Ajustarile de depreciere SPARTE pe familii: 6814 e comun creantelor si stocurilor, iar cele
    // doua se deduc diferit (30% din baza eligibila, respectiv deloc).
    ajustariDepreciere: rep.ajustariDepreciere(view, year),
    // Amortizarea contabila vine din rulajul REAL al contului 6811, nu din plan.
    amortizare: assets.depreciationDifference(view.assets || [], year, rulajCont(view, year, '6811')),
    cursEur: Number(src.cursEur) || Number(firma.cursEur) || 0,
    sponsorizareReport: firma.sponsorizareReport || [],
  };
}

/** Articolul de impozit pe profit al anului, daca a fost postat (nestornat). */
function articolImpozit(view, year) {
  return acc.postedEntries(view).find((e) => e.tip === 'impozit_profit'
    && String(e.period || '') === String(year) + '-12' && !e.stornat) || null;
}

/**
 * Optiunile pentru calea DECLARATIEI (D101).
 *
 * Daca impozitul e deja postat, se intoarce instantaneul salvat atunci (`rezultatFiscal`):
 * declaratia raporteaza EXACT ce s-a inregistrat, nu o recalculare care ar folosi o stare deja
 * consumata. Daca nu e postat inca, se calculeaza cu aceleasi reguli ca inchiderea — deci
 * previzualizarea si nota vor coincide cand se posteaza.
 */
function pentruDeclaratie(view, year) {
  const art = articolImpozit(view, year);
  if (art && art.rezultatFiscal) return { rezultatFiscal: art.rezultatFiscal };
  return construieste(view, year, {});
}

/** Varianta pe firmaId, pentru apelantii care au doar id-ul (rutele de inchidere). */
function pentruFirma(fid, year, src) {
  return construieste(db.scoped(fid), year, src);
}

module.exports = { construieste, pentruDeclaratie, pentruFirma, articolImpozit, rulajCont };
