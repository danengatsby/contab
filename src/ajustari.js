'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  AJUSTARILE PENTRU DEPRECIERE — evaluarea la inventar si urmarile ei
//
//  La inventariere (Legea 82/1991 art. 7-8, OMFP 2861/2009) elementele se evalueaza la VALOAREA DE
//  INVENTAR. Cand aceasta e sub valoarea contabila, minusul NU se scoate din cont — se inregistreaza
//  o AJUSTARE, care lasa valoarea de intrare neatinsa si se poate relua cand deprecierea dispare.
//  Asta o deosebeste de amortizare (ireversibila, planificata) si de o scoatere din evidenta.
//
//  Lipsea complet: nici conturi in plan, nici monografii, nici rute. Nu era o lipsa de interfata —
//  garda din `composeEntry` face imposibila si o nota contabila manuala pe un cont care nu exista.
//  Intre timp patru module scriau deja reguli pentru aceste conturi: `bilant.js` le scadea pe
//  randurile F10, `reporting.js` in situatia imobilizarilor, `statements.js` in bilantul de afisaj,
//  iar `impozitMicro.js` scadea veniturile din reluare din baza impozitului pe micro. Randuri care
//  nu se puteau completa niciodata.
//
//  HARTA E EXPLICITA, nu compusa din cifre. Aceeasi lectie ca la conturile de amortizare, unde
//  `'281' + cod.charAt(2)` producea conturi inexistente care plecau in SAF-T la ANAF: o regula care
//  INVENTEAZA coduri se strica in tacere. Ce nu e in harta nu are ajustare, si se spune raspicat.
//
//  Contul de CHELTUIALA depinde de natura activului, nu de felul deprecierii:
//    imobilizari (clasa 2) -> 6813 / 7813 la reluare;
//    active circulante (clasa 3, si creantele pe 49x) -> 6814 / 7814.
//  6814 e deci COMUN stocurilor si creantelor — de aceea partea deductibila (art. 26 alin. (1)
//  lit. c, numai la creante) nu se poate citi din rulajul contului, ci din contrapartida.
// ─────────────────────────────────────────────────────────────────────────────

const coa = require('./chartOfAccounts');
const { round2 } = require('./util');

/** Cont de activ -> contul lui de ajustare pentru depreciere. */
const CONT_AJUSTARE = {
  // imobilizari necorporale
  205: '290', 208: '290', 203: '290', 201: '290',
  // imobilizari corporale
  211: '2911', 2111: '2911', 2112: '2911',
  212: '2912',
  213: '2913', 2131: '2913', 2132: '2913', 2133: '2913',
  214: '2914',
  // imobilizari in curs si financiare
  231: '2931', 232: '2931', 233: '2931',
  267: '296', 2678: '296', 261: '296', 263: '296',
  // stocuri
  301: '391',
  302: '3921', 3021: '3921', 3022: '3921',
  303: '3922',
  331: '393', 332: '393',
  341: '394', 345: '394', 346: '394',
  351: '395', 354: '395', 356: '395', 357: '395', 358: '395',
  371: '397',
  381: '398',
};

/** Contul de cheltuiala / de venit al ajustarii, dupa clasa activului. */
function conturiRezultat(contAjustare) {
  return String(contAjustare || '').startsWith('2')
    ? { cheltuiala: '6813', venit: '7813' }
    : { cheltuiala: '6814', venit: '7814' };
}

/**
 * Ajustarea potrivita pentru un cont de activ.
 * @returns {{ ajustare, cheltuiala, venit }} sau `null` daca activul nu are ajustare definita.
 */
function pentruCont(cont) {
  const c = String(cont || '').trim();
  let aj = CONT_AJUSTARE[c];
  if (!aj) {
    // analitic propriu (ex. 371.01): se cauta sinteticul cel mai lung care se potriveste
    for (let n = c.length - 1; n >= 3 && !aj; n -= 1) aj = CONT_AJUSTARE[c.slice(0, n)];
  }
  if (!aj || !coa.getAccount(aj)) return null; // niciodata un cod inventat
  return Object.assign({ ajustare: aj }, conturiRezultat(aj));
}

/** Are contul o ajustare definita? (pentru interfata si pentru registrul-inventar) */
function areAjustare(cont) { return !!pentruCont(cont); }

/**
 * Articolul contabil al unei ajustari: constituire (crestere) sau reluare (scadere).
 * `diferenta` > 0 inseamna depreciere NOUA de inregistrat; < 0 inseamna reluare.
 * Functie PURA — nu scrie nimic; apelantul decide daca posteaza.
 */
function linii(cont, diferenta) {
  const a = pentruCont(cont);
  const suma = round2(Math.abs(Number(diferenta) || 0));
  if (!a || suma <= 0) return [];
  // Denumirea contului se pune ca APOZITIE, nu la genitiv: „deprecierea" + numele contului ar da
  // „deprecierea mărfuri" / „deprecierea construcții". Textul ajunge in jurnal, in fisa contului si
  // in SAF-T, deci se citeste de om.
  const eticheta = coa.accountName(cont) + ' (' + cont + ')';
  return Number(diferenta) > 0
    ? [{ debit: a.cheltuiala, credit: a.ajustare, suma, explicatie: 'Ajustare pentru depreciere — ' + eticheta }]
    : [{ debit: a.ajustare, credit: a.venit, suma, explicatie: 'Reluare ajustare pentru depreciere — ' + eticheta }];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Perimetrul citit de raportare: care conturi sunt de ajustare, si din ce familie.
//  Se DERIVA din harta, nu se scrie a doua oara — o lista paralela ar drifta.
// ─────────────────────────────────────────────────────────────────────────────
const TOATE = [...new Set(Object.values(CONT_AJUSTARE))].sort();
const IMOBILIZARI = TOATE.filter((c) => c.startsWith('2'));
const STOCURI = TOATE.filter((c) => c.startsWith('3'));

/** Familia unui cont de ajustare: 'imobilizari' | 'stocuri' | 'creante' | null. */
function familie(cont) {
  const c = String(cont || '');
  if (/^29/.test(c)) return 'imobilizari';
  if (/^39/.test(c)) return 'stocuri';
  if (/^49/.test(c)) return 'creante';
  return null;
}

module.exports = { CONT_AJUSTARE, pentruCont, areAjustare, linii, familie, conturiRezultat, TOATE, IMOBILIZARI, STOCURI };
