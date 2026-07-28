'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  SITUATII FINANCIARE ANUALE — maparea pe randurile OFICIALE ANAF (F10 + F20)
//
//  Formularele (OMFP 1802/2014), dupa categoria de entitate:
//    S1120 — microentitati:      F10 prescurtat (51 randuri) + F20 prescurtat (14)
//    S1121 — entitati mici:      F10 prescurtat (ACELASI)    + F20 complet   (88)
//    S1122 — mijlocii/mari:      F10 complet    (104)        + F20 complet   (88)
//
//  F10 e IDENTIC intre S1120 si S1121 — o singura mapare serveste ambele formulare.
//
//  ATENTIE, distinctia care conteaza: `statements.js balanceSheetF10` da AGREGATE DE AFISAJ
//  (A_necorp, B_stocuri…), potrivite pentru PDF-ul intern. Formularul ANAF cere RANDURI
//  NUMEROTATE, cu alta granularitate si cu doua coloane (inceput/sfarsit de exercitiu).
//  Sunt doua lucruri diferite; acest modul NU il inlocuieste pe celalalt.
//
//  Sufixul de camp: `F10_00291` = randul 029, coloana 1 (INCEPUTUL exercitiului);
//                   `F10_00292` = acelasi rand, coloana 2 (SFARSITUL exercitiului).
//
//  INVARIANTUL CENTRAL: fiecare cont cade in EXACT UN rand, cu semnul corect. Numai asa
//  identitatea de bilant a validatorului se satisface prin CONSTRUCTIE, nu din noroc:
//    F10_049 = F10_004 + F10_009 + F10_010 - F10_013 - F10_016 - F10_017 - F10_018
//  Totalurile NU se aduna independent: se calculeaza cu formulele validatorului (vezi TOTALURI),
//  ca sa nu poata aparea divergenta intre ce spune formularul si ce verifica ANAF.
// ─────────────────────────────────────────────────────────────────────────────

const { round2 } = require('./util');
const coa = require('./chartOfAccounts');
const { finalBalances } = require('./statements');
const { postedEntries, resultLines, accumulate } = require('./accounting');
const { period: periodOf } = require('./util');

const classOf = (cod) => (coa.getAccount(cod) || {}).clasa || Number(String(cod)[0]);
const starts = (cod, ...pre) => pre.some((p) => String(cod).startsWith(p));

// ── F10: BILANT PRESCURTAT (51 de randuri) ───────────────────────────────────

/**
 * Randurile de baza ale bilantului la o data, dintr-un set de solduri nete
 * (`net[cont]` > 0 = sold debitor). Intoarce doar randurile ELEMENTARE; totalurile
 * se calculeaza separat, din formulele validatorului.
 *
 * Conturile bifunctionale (clasa 4, trezorerie) se clasifica DUPA SEMN, nu dupa denumire:
 * un 401 cu sold debitor e o creanta (avans la furnizor), nu o datorie negativa.
 */
function f10Base(net) {
  const R = {};
  const add = (rand, val) => { R[rand] = round2((R[rand] || 0) + val); };

  // Rezultatul exercitiului NEINCHIS: pana la inchiderea anuala (6/7 -> 121) rezultatul nu e
  // pe 121, ci raspandit in clasele 6 si 7. Daca l-am sari, capitalurile proprii ar fi mai mici
  // cu exact profitul anului si identitatea de bilant a validatorului ar pica. Il acumulam
  // aici si il varsam pe randurile 043/044 IMPREUNA cu soldul lui 121 (cazul deja inchis),
  // deci formula merge identic inainte si dupa inchiderea anuala.
  let rezNeinchis = 0;

  for (const cod of Object.keys(net)) {
    const v = net[cod];
    if (Math.abs(v) < 0.005) continue;
    const cl = classOf(cod);
    if (cl === 6 || cl === 7) { rezNeinchis = round2(rezNeinchis - v); continue; } // venit(-) − cheltuiala(+)
    if (cl >= 8) continue; // conturi speciale/de gestiune — in afara bilantului

    // ── ACTIVE IMOBILIZATE (clasa 2), NETE de amortizari/ajustari (28x/29x = sold creditor)
    if (cl === 2) {
      if (starts(cod, '20', '233', '280', '290')) add('001', v);       // necorporale
      else if (starts(cod, '26', '296')) add('003', v);                 // financiare
      else add('002', v);                                              // corporale: 21x, 231, 235, 281x, 291x, 2931
      continue;
    }
    // ── STOCURI (clasa 3), nete de ajustari 39x
    if (cl === 3) { add('005', v); continue; }
    // ── Cheltuieli in avans (471). Fara evidenta de scadenta -> integral „pana la un an" (011).
    if (starts(cod, '471')) { add('011', v); continue; }
    // ── Venituri in avans, pe cele patru componente ale randului 018
    if (starts(cod, '475')) { add('020', -v); continue; }  // subventii pentru investitii (<= 1 an)
    if (starts(cod, '472')) { add('023', -v); continue; }  // venituri inregistrate in avans
    if (starts(cod, '478')) { add('026', -v); continue; }  // venituri in avans / active primite prin transfer

    // ── CAPITALURI PROPRII (clasa 1) — sold creditor => valoare pozitiva in formular
    if (cl === 1) {
      if (starts(cod, '1012')) { add('030', -v); continue; }  // capital subscris varsat
      if (starts(cod, '1011')) { add('031', -v); continue; }  // capital subscris nevarsat
      if (starts(cod, '1015')) { add('032', -v); continue; }  // patrimoniul regiei
      if (starts(cod, '1018')) { add('033', -v); continue; }  // patrimoniul institutelor nationale de C&D
      if (starts(cod, '1016')) { add('047', -v); continue; }  // patrimoniul public
      if (starts(cod, '1017')) { add('048', -v); continue; }  // patrimoniul privat
      if (starts(cod, '103')) { add('034', -v); continue; }   // alte elemente de capitaluri proprii
      if (starts(cod, '104')) { add('035', -v); continue; }   // prime de capital
      if (starts(cod, '105')) { add('036', -v); continue; }   // rezerve din reevaluare
      if (starts(cod, '106')) { add('037', -v); continue; }   // rezerve
      if (starts(cod, '109')) { add('038', v); continue; }    // actiuni proprii (sold DEBITOR, se scade)
      if (starts(cod, '141')) { add('039', -v); continue; }   // castiguri legate de instrumentele de capitaluri
      if (starts(cod, '149')) { add('040', v); continue; }    // pierderi legate de instrumentele de capitaluri
      if (starts(cod, '117')) { add(v <= 0 ? '041' : '042', Math.abs(v)); continue; } // reportat: C / D
      if (starts(cod, '121')) { add(v <= 0 ? '043' : '044', Math.abs(v)); continue; } // exercitiu: C / D
      if (starts(cod, '129')) { add('045', v); continue; }    // repartizarea profitului (sold debitor)
      if (starts(cod, '15')) { add('017', -v); continue; }    // provizioane
      if (starts(cod, '16')) { add('016', -v); continue; }    // datorii > 1 an
      // orice alt cont de clasa 1 ramas: tot capitaluri proprii („alte elemente")
      add('034', -v); continue;
    }
    // ── Investitii pe termen scurt (50x) si ajustarile lor (59x)
    if (starts(cod, '50', '59')) { if (v >= 0) add('007', v); else add('013', -v); continue; }
    // ── Casa si conturi la banci; sold creditor (descoperit de cont) = datorie curenta
    if (starts(cod, '51', '52', '53', '54')) { if (v >= 0) add('008', v); else add('013', -v); continue; }
    // ── Clasa 4 (si rest): SEMNUL decide creanta vs. datorie curenta.
    //    Creantele fara evidenta de scadenta merg integral pe „pana la un an" (301).
    if (v > 0) add('301', v); else add('013', -v);
  }

  // Rezultatul exercitiului: soldul lui 121 (deja pus pe 043/044 mai sus) PLUS partea neinchisa.
  // Se recompune net, ca profitul si pierderea sa nu apara simultan (validatorul respinge asta:
  // „F10_0431 si F10_0441 nu pot fi ambele > 0").
  if (Math.abs(rezNeinchis) >= 0.005) {
    const net121 = round2((R['043'] || 0) - (R['044'] || 0) + rezNeinchis);
    R['043'] = net121 > 0 ? net121 : 0;
    R['044'] = net121 < 0 ? round2(-net121) : 0;
  }
  return R;
}

// Randurile pe care le calculam prin FORMULELE validatorului (nu prin insumare proprie).
// Ordinea conteaza: un total poate depinde de altul calculat mai devreme.
function f10Totals(R) {
  const g = (k) => round2(R[k] || 0);
  const set = (k, v) => { R[k] = round2(v); };

  set('302', g('302'));                                        // creante > 1 an (azi mereu 0)
  set('006', g('301') + g('302'));                             // creante — total
  set('004', g('001') + g('002') + g('003'));                  // active imobilizate — total
  set('009', g('005') + g('006') + g('007') + g('008'));       // active circulante — total
  set('012', g('012'));                                        // cheltuieli in avans > 1 an (azi 0)
  set('010', g('011') + g('012'));                             // cheltuieli in avans — total
  set('021', g('021')); set('024', g('024')); set('027', g('027')); set('028', g('028'));
  set('019', g('020') + g('021'));                             // subventii pentru investitii
  set('022', g('023') + g('024'));                             // venituri inregistrate in avans
  set('025', g('026') + g('027'));                             // venituri in avans / active prin transfer
  set('018', g('019') + g('022') + g('025') + g('028'));       // venituri in avans — total
  // active circulante nete / datorii curente nete
  set('014', g('009') + g('011') - g('013') - g('020') - g('023') - g('026'));
  set('015', g('004') + g('012') + g('014'));                  // total active minus datorii curente
  set('029', g('030') + g('031') + g('032') + g('033') + g('034')); // capital — total
  set('046', g('029') + g('035') + g('036') + g('037') - g('038') + g('039') - g('040')
    + g('041') - g('042') + g('043') - g('044') - g('045'));   // capitaluri proprii — total
  set('049', g('046') + g('047') + g('048'));                  // capitaluri — total
  return R;
}

// Formularul se raporteaza in LEI INTREGI (validatorul respinge zecimalele: „numar intreg eronat").
// Rotunjirea trebuie facuta pe randurile ELEMENTARE, INAINTE de totaluri — altfel un total rotunjit
// separat poate sa nu mai fie egal cu suma partilor lui rotunjite, si validatorul respinge exact asta.
const intLei = (x) => Math.round(Number(x) || 0);

/**
 * Reziduul de rotunjire: identitatea de bilant (F10_64) e o CONSECINTA a partidei duble pe sume
 * exacte; dupa rotunjirea a zeci de randuri la leu, cele doua parti pot diferi cu cativa lei.
 * Diferenta se duce in REZULTATUL REPORTAT (randurile 041/042) — practica uzuala la intocmirea
 * situatiilor anuale, si singurul loc liber: 029/034 si 043/044 sunt legate prin reguli proprii
 * (`totalPlata_A = F10_029`, `F10_043 = F20_069`), deci nu pot absorbi nimic.
 */
function absoarbeRezidul(R) {
  const g = (k) => R[k] || 0;
  const rezid = (g('004') + g('009') + g('010') - g('013') - g('016') - g('017') - g('018')) - g('049');
  if (!rezid) return R;
  const reportatNet = g('041') - g('042') + rezid;
  R['041'] = reportatNet > 0 ? reportatNet : 0;
  R['042'] = reportatNet < 0 ? -reportatNet : 0;
  return f10Totals(R);
}

/**
 * Randurile F10 pentru un an fiscal (incheiat la 31.12.`year`), in lei intregi.
 *
 * `rezultatNet` (optional) = rezultatul net al exercitiului, asa cum il raporteaza F20. Cand e dat,
 * randurile 043/044 se IAU DE ACOLO, nu se recalculeaza din solduri. Validatorul impune
 * `F10_043 = F20_069` / `F10_044 = F20_070`, iar doua calcule independente pe aceleasi date, fiecare
 * rotunjit la leu, diverg cu 1-2 lei — exact eroarea pe care o da ANAF. Contul de profit si pierdere
 * e AUTORITATEA asupra rezultatului; bilantul il preia. Diferenta ramasa se duce in reportat.
 */
function f10At(db, year, rezultatNet) {
  const base = f10Base(finalBalances(db, String(year) + '-12'));
  for (const k of Object.keys(base)) base[k] = intLei(base[k]);
  if (rezultatNet != null) {
    const rez = intLei(rezultatNet);
    base['043'] = rez > 0 ? rez : 0;
    base['044'] = rez < 0 ? -rez : 0;
  }
  return absoarbeRezidul(f10Totals(base));
}

// ── F20: CONTUL DE PROFIT SI PIERDERE ────────────────────────────────────────

/** Rulajele claselor 6/7 pentru un an, pe cod de cont (fara inchiderile 6/7 -> 121). */
function plAcc(db, year) {
  const ent = postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
  return accumulate(resultLines(ent));
}

/**
 * F20 PRESCURTAT (microentitati, S1120) — 9 randuri de fond + 5 randuri „din care".
 * Structura oficiala:
 *   001 Cifra de afaceri neta            005 Ajustari de valoare
 *   002 Alte venituri                    006 Alte cheltuieli
 *   003 Costul materiilor prime          007 Impozitul pe profit/venit
 *   004 Cheltuieli cu personalul         008 Profit net / 009 Pierdere neta
 * Randurile 301-305 sunt detalii „din care"; raman 0 cat timp nu avem evidenta separata
 * (validatorul le cere doar <= randul-parinte, deci 0 e valid si onest — mai bine gol
 * decat completat gresit).
 */
function f20Micro(db, year) {
  const acc = plAcc(db, year);
  const codes = Object.keys(acc);
  const venit = (c) => round2(acc[c] ? acc[c].c - acc[c].d : 0);
  const chelt = (c) => round2(acc[c] ? acc[c].d - acc[c].c : 0);
  const sv = (p) => round2(codes.filter(p).reduce((s, c) => s + venit(c), 0));
  const sc = (p) => round2(codes.filter(p).reduce((s, c) => s + chelt(c), 0));

  const R = {};
  R['001'] = sv((c) => starts(c, '70'));                                   // cifra de afaceri neta (70x, net de 709)
  const venitTot = sv((c) => classOf(c) === 7);
  R['002'] = round2(venitTot - R['001']);                                  // alte venituri (rest clasa 7, inclusiv financiare)
  R['003'] = sc((c) => starts(c, '60'));                                   // materii prime, materiale, marfuri, utilitati
  R['004'] = sc((c) => starts(c, '64'));                                   // cheltuieli cu personalul
  R['005'] = sc((c) => starts(c, '68'));                                   // ajustari de valoare (amortizari + ajustari)
  R['007'] = sc((c) => starts(c, '691', '698'));                           // impozit pe profit / pe venit
  const cheltTot = sc((c) => classOf(c) === 6);
  R['006'] = round2(cheltTot - R['003'] - R['004'] - R['005'] - R['007']);  // alte cheltuieli (rezidual => total garantat)
  for (const d of ['301', '302', '303', '304', '305']) R[d] = 0;
  // lei intregi INAINTE de rezultat, ca F20_008/009 sa fie exact suma randurilor rotunjite
  for (const k of Object.keys(R)) R[k] = intLei(R[k]);

  // Rezultatul, exact cu formula validatorului (F20_008 / F20_009)
  const rez = round2(R['001'] + R['002'] - R['003'] - R['004'] - R['005'] - R['006'] - R['007'] + R['304']);
  R['008'] = rez > 0 ? rez : 0;
  R['009'] = rez < 0 ? round2(-rez) : 0;
  return R;
}

module.exports = { f10Base, f10Totals, f10At, f20Micro, plAcc };
