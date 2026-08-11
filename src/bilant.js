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
    // ── AJUSTARILE PENTRU DEPRECIERE (49x, 59x) — RECTIFICATIVE, nu datorii ──────────────────
    // Au sold CREDITOR, ca o datorie, dar nu sunt o obligatie catre nimeni: corecteaza in minus
    // activul pe care il insotesc. Bilantul cere activele NETE (OMFP 1802/2014), deci ajustarea
    // se scade din randul activului, nu se adauga la datorii.
    //
    // Trebuie tratate INAINTEA clasificarii dupa semn de mai jos: acolo orice sold creditor
    // devine datorie curenta, deci o ajustare de creante aparea simultan ca datorie fictiva SI
    // lasa creantele la valoarea BRUTA. Totalurile ramaneau echilibrate (ambele parti crescute cu
    // aceeasi suma), deci nicio verificare de echilibru nu o putea prinde — dar rd. 013 raporta
    // la ANAF o datorie inexistenta, iar rd. 301 creante neajustate.
    if (starts(cod, '491', '495', '496')) { add('301', v); continue; } // ajustari de creante
    if (starts(cod, '59')) { add('007', v); continue; }                // ajustari de investitii pe termen scurt
    // ── Investitii pe termen scurt (50x)
    if (starts(cod, '50')) { if (v >= 0) add('007', v); else add('013', -v); continue; }
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
/**
 * Peste ce reziduu incetam sa mai credem ca e rotunjire (lei).
 *
 * Identitatea se satisface prin insumarea a cateva agregate, fiecare compus din zeci de randuri
 * rotunjite independent la leu. Acumularea plauzibila e de ordinul zecilor de lei, niciodata al
 * sutelor. Pragul e deci generos fata de rotunjire si strans fata de o eroare de MAPARE, care
 * mereu se masoara in sute sau mii — un cont intreg cazut pe alt rand.
 */
const PRAG_REZIDUAL = 100;

/**
 * Absoarbe reziduul SI il face vizibil.
 *
 * Absorbtia nu e optionala: fara ea identitatea F10_64 pica la validator si situatiile nu se pot
 * depune. Problema era ca mecanismul nu avea nici prag, nici glas — inghitea la fel de tacut si
 * doi lei de rotunjire, si o eroare de mapare de doua sute de mii. Consecinta e perfida: un cont
 * mapat gresit nu produce NICIODATA un bilant dezechilibrat (plasa il rebalanseaza), ci un
 * REZULTAT REPORTAT gresit, pe care nu-l confrunta nimeni cu nimic.
 *
 * Azi reziduul ramane atasat de rezultat ca proprietate NEENUMERABILA: `Object.keys`, `for...in`
 * si `JSON.stringify` nu o vad, deci nu poate ajunge din greseala intr-un camp de formular sau in
 * XML-ul depus — dar `verificaRezidual` o poate citi.
 */
function absoarbeRezidul(R) {
  const g = (k) => R[k] || 0;
  const rezid = (g('004') + g('009') + g('010') - g('013') - g('016') - g('017') - g('018')) - g('049');
  if (!rezid) return marcheazaRezidual(R, 0);
  const reportatNet = g('041') - g('042') + rezid;
  R['041'] = reportatNet > 0 ? reportatNet : 0;
  R['042'] = reportatNet < 0 ? -reportatNet : 0;
  return marcheazaRezidual(f10Totals(R), rezid);
}

/** Ataseaza reziduul absorbit, fara sa-l faca parte din randurile formularului. */
function marcheazaRezidual(R, rezid) {
  Object.defineProperty(R, 'rezidual', { value: Math.round(Number(rezid) || 0), enumerable: false, configurable: true });
  return R;
}

/**
 * Verdictul asupra reziduului absorbit intr-un set de randuri F10.
 * `ok:false` NU inseamna ca formularul e invalid — el torna oricum; inseamna ca suma mutata in
 * rezultatul reportat e prea mare ca sa fie rotunjire, deci undeva exista un cont care nu cade
 * unde trebuie. Verificarea e a CONTABILULUI, nu a validatorului: ANAF nu are cum s-o faca.
 */
function verificaRezidual(R) {
  const rezid = (R && R.rezidual) || 0;
  const marime = Math.abs(rezid);
  return {
    rezidual: rezid,
    prag: PRAG_REZIDUAL,
    ok: marime <= PRAG_REZIDUAL,
    mesaj: marime <= PRAG_REZIDUAL ? '' : 'Diferența de ' + rezid + ' lei mutată în rezultatul reportat '
      + 'depășește pragul de rotunjire (' + PRAG_REZIDUAL + ' lei). Formularul se depune corect, dar cifra '
      + 'sugerează un cont care nu cade pe rândul potrivit — verifică soldurile înainte de depunere.',
  };
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

// ── F10 COMPLET (S1122, entitati mijlocii si mari) — 104 randuri ─────────────

/**
 * Bilantul COMPLET: aceleasi solduri, dar desfasurate pe randurile detaliate ale OMFP 1802/2014.
 * Diferenta fata de cel prescurtat e granularitatea, nu continutul — de aceea totalurile ies
 * identice, iar `f10CompletTotals` foloseste tot formulele validatorului.
 *
 * Unde aplicatia NU tine evidenta ceruta de formular (creante/datorii fata de entitati AFILIATE
 * vs. ASOCIATE — nu exista marcaj de grup pe partener), randurile respective raman 0, iar sumele
 * merg pe randul general (creante comerciale / alte datorii). E o pierdere de detaliu declarata,
 * nu o eroare de sold: totalurile si identitatea de bilant raman exacte.
 */
function f10CompletBase(net) {
  const R = {};
  const add = (rand, val) => { R[rand] = round2((R[rand] || 0) + val); };
  let rezNeinchis = 0;

  for (const cod of Object.keys(net)) {
    const v = net[cod];
    if (Math.abs(v) < 0.005) continue;
    const cl = classOf(cod);
    if (cl === 6 || cl === 7) { rezNeinchis = round2(rezNeinchis - v); continue; }
    if (cl >= 8) continue;

    // ── A. IMOBILIZARI (clasa 2), nete de amortizari/ajustari ──
    if (cl === 2) {
      if (starts(cod, '201', '280 1', '2801')) { add('001', v); continue; }        // cheltuieli de constituire
      if (starts(cod, '203', '2803')) { add('002', v); continue; }                 // cheltuieli de dezvoltare
      if (starts(cod, '205', '208', '2805', '2808', '2905', '2908')) { add('003', v); continue; } // concesiuni, brevete, licente
      if (starts(cod, '206', '2806')) { add('004', v); continue; }                 // active necorporale de explorare
      if (starts(cod, '207', '2807', '2907')) { add('005', v); continue; }         // fond comercial
      if (starts(cod, '233', '4094')) { add('006', v); continue; }                 // imobilizari necorporale in curs / avansuri
      if (starts(cod, '211', '212', '2811', '2812', '2911', '2912')) { add('008', v); continue; } // terenuri si constructii
      if (starts(cod, '213', '2813', '2913')) { add('009', v); continue; }         // instalatii tehnice si masini
      if (starts(cod, '214', '2814', '2914')) { add('010', v); continue; }         // alte instalatii, utilaje si mobilier
      if (starts(cod, '215', '2815', '2915')) { add('011', v); continue; }         // investitii imobiliare
      if (starts(cod, '216', '2816')) { add('012', v); continue; }                 // active corporale de explorare
      if (starts(cod, '217', '2817')) { add('013', v); continue; }                 // active biologice productive
      if (starts(cod, '231', '2931')) { add('014', v); continue; }                 // imobilizari corporale in curs
      if (starts(cod, '235', '2935')) { add('015', v); continue; }                 // investitii imobiliare in curs
      if (starts(cod, '4093')) { add('016', v); continue; }                        // avansuri pentru imobilizari corporale
      if (starts(cod, '261', '2961')) { add('018', v); continue; }                 // actiuni detinute la filiale
      if (starts(cod, '2671', '2672')) { add('019', v); continue; }                // imprumuturi acordate entitatilor din grup
      if (starts(cod, '262', '263', '2962')) { add('020', v); continue; }          // actiuni la entitati asociate/controlate
      if (starts(cod, '2673', '2674')) { add('021', v); continue; }                // imprumuturi acordate entitatilor asociate
      if (starts(cod, '265', '2965')) { add('022', v); continue; }                 // alte investitii detinute ca imobilizari
      add('023', v); continue;                                                     // alte imprumuturi (2675-2679 etc.)
    }
    // ── B.I. STOCURI (clasa 3), nete de ajustari 39x ──
    if (cl === 3) {
      if (starts(cod, '30', '32', '390', '392')) { add('026', v); continue; }       // materii prime si materiale consumabile
      if (starts(cod, '33', '393')) { add('027', v); continue; }                    // productia in curs de executie
      add('028', v); continue;                                                      // produse finite si marfuri (34x-37x)
    }
    if (starts(cod, '4091')) { add('029', v); continue; }                            // avansuri pentru cumparari de stocuri
    // ── C. CHELTUIELI IN AVANS (fara evidenta de scadenta -> integral „pana la un an") ──
    if (starts(cod, '471')) { add('043', v); continue; }
    // ── I. VENITURI IN AVANS ──
    if (starts(cod, '475')) { add('070', -v); continue; }                            // subventii pentru investitii
    if (starts(cod, '472')) { add('073', -v); continue; }                            // venituri inregistrate in avans
    if (starts(cod, '478')) { add('076', -v); continue; }                            // venituri in avans / active prin transfer

    // ── J. CAPITALURI PROPRII (clasa 1) ──
    if (cl === 1) {
      if (starts(cod, '1012')) { add('080', -v); continue; }
      if (starts(cod, '1011')) { add('081', -v); continue; }
      if (starts(cod, '1015')) { add('082', -v); continue; }
      if (starts(cod, '1018')) { add('083', -v); continue; }
      if (starts(cod, '1016')) { add('101', -v); continue; }                         // patrimoniul public
      if (starts(cod, '1017')) { add('102', -v); continue; }                         // patrimoniul privat
      if (starts(cod, '103')) { add('084', -v); continue; }
      if (starts(cod, '104')) { add('086', -v); continue; }                          // prime de capital
      if (starts(cod, '105')) { add('087', -v); continue; }                          // rezerve din reevaluare
      if (starts(cod, '1061')) { add('088', -v); continue; }                         // rezerve legale
      if (starts(cod, '1063')) { add('089', -v); continue; }                         // rezerve statutare
      if (starts(cod, '106')) { add('090', -v); continue; }                          // alte rezerve
      if (starts(cod, '109')) { add('092', v); continue; }                           // actiuni proprii (debitor)
      if (starts(cod, '141')) { add('093', -v); continue; }
      if (starts(cod, '149')) { add('094', v); continue; }
      if (starts(cod, '117')) { add(v <= 0 ? '095' : '096', Math.abs(v)); continue; } // reportat C / D
      if (starts(cod, '121')) { add(v <= 0 ? '097' : '098', Math.abs(v)); continue; } // exercitiu C / D
      if (starts(cod, '129')) { add('099', v); continue; }                            // repartizarea profitului
      if (starts(cod, '15')) { add(starts(cod, '1515') ? '066' : '067', -v); continue; } // provizioane
      if (starts(cod, '161')) { add('056', -v); continue; }                            // imprumuturi din emisiuni de obligatiuni (>1 an)
      if (starts(cod, '162', '166', '167', '168', '169')) { add('057', -v); continue; } // credite bancare si alte datorii >1 an
      if (starts(cod, '16')) { add('063', -v); continue; }                             // rest grupa 16
      add('084', -v); continue;                                                        // alt cont de clasa 1 -> alte elemente de capitaluri
    }
    // ── AJUSTARILE PENTRU DEPRECIERE (49x) — rectificative de ACTIV, nu datorii (vezi f10Base) ──
    if (starts(cod, '491')) { add('031', v); continue; }          // ajustari de creante comerciale
    if (starts(cod, '495', '496')) { add('034', v); continue; }   // ajustari de alte creante
    // ── B.III. INVESTITII PE TERMEN SCURT (ajustarile 59x scad activul, indiferent de semn) ──
    if (starts(cod, '591')) { add('037', v); continue; }
    if (starts(cod, '59')) { add('038', v); continue; }
    if (starts(cod, '501')) { if (v >= 0) add('037', v); else add('052', -v); continue; }
    if (starts(cod, '50')) { if (v >= 0) add('038', v); else add('052', -v); continue; }
    // ── B.IV. CASA SI CONTURI LA BANCI; sold creditor = descoperit de cont (datorie curenta) ──
    if (starts(cod, '51', '52', '53', '54')) { if (v >= 0) add('040', v); else add('046', -v); continue; }
    // ── D. DATORII pana la un an / creante, dupa SEMN ──
    if (v > 0) {
      if (starts(cod, '411', '413', '418')) { add('031', v); continue; }               // creante comerciale
      if (starts(cod, '456')) { add('035', v); continue; }                             // capital subscris si nevarsat
      add('034', v); continue;                                                         // alte creante
    }
    const s = -v;
    if (starts(cod, '419')) { add('047', s); continue; }                               // avansuri incasate in contul comenzilor
    if (starts(cod, '401', '404', '408')) { add('048', s); continue; }                  // datorii comerciale — furnizori
    if (starts(cod, '403', '405')) { add('049', s); continue; }                          // efecte de comert de platit
    add('052', s);                                                                      // alte datorii (fiscale, sociale, 43x/44x/45x/46x)
  }

  if (Math.abs(rezNeinchis) >= 0.005) {
    const net121 = round2((R['097'] || 0) - (R['098'] || 0) + rezNeinchis);
    R['097'] = net121 > 0 ? net121 : 0;
    R['098'] = net121 < 0 ? round2(-net121) : 0;
  }
  return R;
}

/** Totalurile bilantului complet, cu formulele validatorului (nu prin insumare proprie). */
function f10CompletTotals(R) {
  const g = (k) => round2(R[k] || 0);
  const set = (k, val) => { R[k] = round2(val); };
  set('007', g('001') + g('002') + g('003') + g('004') + g('005') + g('006'));         // imob. necorporale
  set('017', g('008') + g('009') + g('010') + g('011') + g('012') + g('013') + g('014') + g('015') + g('016'));
  set('024', g('018') + g('019') + g('020') + g('021') + g('022') + g('023'));         // imob. financiare
  set('025', g('007') + g('017') + g('024'));                                          // A. ACTIVE IMOBILIZATE
  set('030', g('026') + g('027') + g('028') + g('029'));                               // stocuri
  set('036', g('031') + g('032') + g('033') + g('034') + g('035') + g('301'));         // creante
  set('039', g('037') + g('038'));                                                     // investitii pe termen scurt
  set('041', g('030') + g('036') + g('039') + g('040'));                               // B. ACTIVE CIRCULANTE
  set('042', g('043') + g('044'));                                                     // C. CHELTUIELI IN AVANS
  set('053', g('045') + g('046') + g('047') + g('048') + g('049') + g('050') + g('051') + g('052'));
  set('069', g('070') + g('071')); set('072', g('073') + g('074')); set('075', g('076') + g('077'));
  set('079', g('069') + g('072') + g('075') + g('078'));                               // I. VENITURI IN AVANS
  set('054', g('041') + g('043') - g('053') - g('070') - g('073') - g('076'));         // E. active circ. nete
  set('055', g('025') + g('044') + g('054'));                                          // F. total active minus datorii curente
  set('064', g('056') + g('057') + g('058') + g('059') + g('060') + g('061') + g('062') + g('063'));
  set('068', g('065') + g('066') + g('067'));                                          // H. PROVIZIOANE
  set('085', g('080') + g('081') + g('082') + g('083') + g('084'));                    // capital
  set('091', g('088') + g('089') + g('090'));                                          // rezerve
  set('100', g('085') + g('086') + g('087') + g('091') - g('092') + g('093') - g('094')
    + g('095') - g('096') + g('097') - g('098') - g('099'));                           // capitaluri proprii
  set('103', g('100') + g('101') + g('102'));                                          // CAPITALURI — TOTAL
  return R;
}

/** Reziduul de rotunjire pentru bilantul complet (acelasi principiu ca la cel prescurtat). */
function absoarbeRezidulComplet(R) {
  const g = (k) => R[k] || 0;
  const rezid = (g('025') + g('041') + g('042') - g('053') - g('064') - g('068') - g('079')) - g('103');
  if (!rezid) return marcheazaRezidual(R, 0);
  const reportatNet = g('095') - g('096') + rezid;
  R['095'] = reportatNet > 0 ? reportatNet : 0;
  R['096'] = reportatNet < 0 ? -reportatNet : 0;
  return marcheazaRezidual(f10CompletTotals(R), rezid);
}

/** Randurile F10 COMPLET pentru un an fiscal, in lei intregi. */
function f10CompletAt(db, year, rezultatNet) {
  const base = f10CompletBase(finalBalances(db, String(year) + '-12'));
  for (const k of Object.keys(base)) base[k] = intLei(base[k]);
  if (rezultatNet != null) {
    const rez = intLei(rezultatNet);
    base['097'] = rez > 0 ? rez : 0;
    base['098'] = rez < 0 ? -rez : 0;
  }
  return absoarbeRezidulComplet(f10CompletTotals(base));
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

/**
 * F20 COMPLET (entitati mici, S1121) — 70 de randuri de fond + 18 „din care"/speciale.
 *
 * Disciplina care garanteaza corectitudinea: randurile de DETALIU se mapeaza explicit pe conturi,
 * iar cate un rand pe fiecare sectiune e REZIDUAL (013 alte venituri din exploatare, 037 alte
 * cheltuieli, 050 alte venituri financiare, 058 alte cheltuieli financiare). Asa, totalurile
 * 016/042/052/059 egaleaza EXACT rulajul claselor 6 si 7 — un cont pe care nu l-am prevazut
 * nominal nu dispare din formular, ci aterizeaza in rezidualul sectiunii lui.
 *
 * Randurile „din care" (301-318, mai putin cele care intra in formule) raman 0: validatorul le cere
 * doar <= randul-parinte, iar aplicatia nu tine evidenta separata (ex. tranzactii cu entitati
 * afiliate). Mai bine gol decat completat gresit.
 */
function f20Complet(db, year) {
  const acc = plAcc(db, year);
  const codes = Object.keys(acc);
  const venit = (c) => round2(acc[c] ? acc[c].c - acc[c].d : 0);
  const chelt = (c) => round2(acc[c] ? acc[c].d - acc[c].c : 0);
  const sv = (p) => round2(codes.filter(p).reduce((s, c) => s + venit(c), 0));
  const sc = (p) => round2(codes.filter(p).reduce((s, c) => s + chelt(c), 0));

  const R = {};
  for (let i = 1; i <= 70; i++) R[String(i).padStart(3, '0')] = 0;
  for (const d of ['301', '302', '303', '304', '305', '306', '307', '308', '309', '310',
    '311', '312', '313', '314', '315', '316', '317', '318']) R[d] = 0;

  // Ce e „financiar" (si deci NU intra in exploatare): 76x + 786 la venituri, 66x + 686 la
  // cheltuieli. Exceptie: 7418 (subventii pentru dobanda) e cont de clasa 74, dar formularul il
  // cere pe randul 049, INAUNTRUL veniturilor financiare — deci se scoate din exploatare.
  const eVenitFin = (c) => starts(c, '76', '786', '7418');
  const eCheltFin = (c) => starts(c, '66', '686');
  const eImpozit = (c) => starts(c, '691', '698');

  // ── VENITURI DIN EXPLOATARE ──
  R['002'] = sv((c) => starts(c, '701', '702', '703', '704', '705', '706', '708')); // productia vanduta
  R['003'] = sv((c) => starts(c, '707'));                       // venituri din vanzarea marfurilor
  R['004'] = round2(-sv((c) => starts(c, '709')));              // reduceri comerciale acordate (sold debitor)
  R['006'] = sv((c) => starts(c, '7411'));                      // subventii aferente cifrei de afaceri
  R['001'] = round2(R['002'] + R['003'] - R['004'] + R['005'] + R['006']);
  const varStoc = sv((c) => starts(c, '711', '712'));           // variatia stocurilor: C = venit, D = cost
  R['007'] = varStoc > 0 ? varStoc : 0;
  R['008'] = varStoc < 0 ? round2(-varStoc) : 0;
  R['009'] = sv((c) => starts(c, '721', '722'));                // productia de imobilizari
  R['010'] = sv((c) => starts(c, '755'));                       // reevaluarea imobilizarilor corporale
  R['011'] = sv((c) => starts(c, '725'));                       // productia de investitii imobiliare
  R['012'] = sv((c) => starts(c, '741') && !starts(c, '7411', '7418')); // alte subventii de exploatare
  const venitExplTot = sv((c) => classOf(c) === 7 && !eVenitFin(c));
  // rezidual: tot ce n-a fost prins nominal (758, 7815, 7588…) ramane „alte venituri din exploatare"
  R['013'] = round2(venitExplTot - R['001'] - varStoc - R['009'] - R['010'] - R['011'] - R['012']);
  R['016'] = round2(R['001'] + R['007'] - R['008'] + R['009'] + R['010'] + R['011'] + R['012'] + R['013']);

  // ── CHELTUIELI DE EXPLOATARE ──
  R['017'] = sc((c) => starts(c, '601', '602'));                // materii prime si materiale consumabile
  R['018'] = sc((c) => starts(c, '603', '604', '606', '608'));  // alte cheltuieli materiale
  R['019'] = sc((c) => starts(c, '605'));                       // energie si apa
  R['020'] = sc((c) => starts(c, '607'));                       // cheltuieli privind marfurile
  R['021'] = round2(-sc((c) => starts(c, '609')));              // reduceri comerciale primite (sold creditor)
  R['023'] = sc((c) => starts(c, '641', '642', '643', '644'));  // salarii si indemnizatii
  R['024'] = sc((c) => starts(c, '645', '646'));                // asigurari si protectie sociala
  R['022'] = round2(R['023'] + R['024']);
  R['026'] = sc((c) => starts(c, '6811', '6813'));              // ajustari imobilizari — cheltuieli
  R['027'] = sv((c) => starts(c, '7813'));                      // ajustari imobilizari — venituri
  R['025'] = round2(R['306'] + R['026'] - R['027']);
  R['029'] = sc((c) => starts(c, '6814'));                      // ajustari active circulante — cheltuieli
  R['030'] = sv((c) => starts(c, '7814'));                      // ajustari active circulante — venituri
  R['028'] = round2(R['029'] - R['030']);
  R['040'] = sc((c) => starts(c, '6812'));                      // provizioane — cheltuieli
  R['041'] = sv((c) => starts(c, '7812'));                      // provizioane — venituri
  R['039'] = round2(R['040'] - R['041']);
  R['032'] = sc((c) => /^6(1|2)/.test(String(c)));              // prestatii externe (61x + 62x)
  R['033'] = sc((c) => starts(c, '635'));                       // alte impozite, taxe si varsaminte
  R['034'] = sc((c) => starts(c, '652'));                       // protectia mediului
  R['035'] = sc((c) => starts(c, '655'));                       // cheltuieli din reevaluare
  R['036'] = sc((c) => starts(c, '6587'));                      // calamitati si evenimente similare
  const cheltExplTot = sc((c) => classOf(c) === 6 && !eCheltFin(c) && !eImpozit(c));
  // rezidual „alte cheltuieli": diferenta pana la totalul real al exploatarii
  R['037'] = round2(cheltExplTot - R['017'] - R['018'] - R['019'] - R['020'] + R['021']
    - R['022'] - R['026'] - R['029'] - R['040']
    - R['032'] - R['033'] - R['034'] - R['035'] - R['036']);
  R['031'] = round2(R['032'] + R['033'] + R['034'] + R['035'] + R['036'] + R['037'] + R['038']
    + R['310'] + R['312'] + R['314'] + R['316']);
  R['042'] = round2(R['017'] + R['018'] + R['019'] + R['020'] - R['021'] + R['022']
    + R['025'] + R['028'] + R['031'] + R['039']);

  // ── FINANCIAR ──
  R['045'] = sv((c) => starts(c, '761'));                       // interese de participare
  R['047'] = sv((c) => starts(c, '766'));                       // venituri din dobanzi
  R['049'] = sv((c) => starts(c, '7418'));                      // subventii pentru dobanda datorata
  const venitFinTot = sv(eVenitFin);
  R['050'] = round2(venitFinTot - R['045'] - R['047'] - R['049']); // rezidual: alte venituri financiare
  R['052'] = round2(R['045'] + R['047'] + R['049'] + R['050']);
  R['054'] = sc((c) => starts(c, '686'));                       // ajustari imobilizari financiare — cheltuieli
  R['055'] = sv((c) => starts(c, '786'));                       // ...si venituri
  R['053'] = round2(R['054'] - R['055']);
  R['056'] = sc((c) => starts(c, '666'));                       // cheltuieli privind dobanzile
  const cheltFinTot = sc(eCheltFin);
  R['058'] = round2(cheltFinTot - R['054'] - R['056']);          // rezidual: alte cheltuieli financiare
  R['059'] = round2(R['053'] + R['056'] + R['058']);

  // ── TOTALURI, impozit, rezultat ──
  R['062'] = round2(R['016'] + R['052']);
  R['063'] = round2(R['042'] + R['059']);
  R['066'] = sc((c) => starts(c, '691'));                       // impozitul pe profit
  R['068'] = sc((c) => starts(c, '698'));                       // alte impozite (inclusiv impozitul micro)

  // lei intregi pe randurile elementare, INAINTE de rezultat (acelasi motiv ca la F10)
  for (const k of Object.keys(R)) R[k] = intLei(R[k]);
  // ...si recompunem agregatele din valorile rotunjite, cu formulele validatorului
  R['001'] = R['002'] + R['003'] - R['004'] + R['005'] + R['006'];
  R['016'] = R['001'] + R['007'] - R['008'] + R['009'] + R['010'] + R['011'] + R['012'] + R['013'];
  R['022'] = R['023'] + R['024'];
  R['025'] = R['306'] + R['026'] - R['027'];
  R['028'] = R['029'] - R['030'];
  R['039'] = R['040'] - R['041'];
  R['031'] = R['032'] + R['033'] + R['034'] + R['035'] + R['036'] + R['037'] + R['038']
    + R['310'] + R['312'] + R['314'] + R['316'];
  R['042'] = R['017'] + R['018'] + R['019'] + R['020'] - R['021'] + R['022']
    + R['025'] + R['028'] + R['031'] + R['039'];
  R['053'] = R['054'] - R['055'];
  R['052'] = R['045'] + R['047'] + R['049'] + R['050'];
  R['059'] = R['053'] + R['056'] + R['058'];
  R['062'] = R['016'] + R['052'];
  R['063'] = R['042'] + R['059'];

  const rezExpl = R['016'] - R['042'];
  R['043'] = rezExpl > 0 ? rezExpl : 0;
  R['044'] = rezExpl <= 0 ? -rezExpl : 0;
  const rezFin = R['052'] - R['059'];
  R['060'] = rezFin > 0 ? rezFin : 0;
  R['061'] = rezFin <= 0 ? -rezFin : 0;
  const rezBrut = R['062'] - R['063'];
  R['064'] = rezBrut > 0 ? rezBrut : 0;
  R['065'] = rezBrut <= 0 ? -rezBrut : 0;
  // rezultatul net, exact cu formulele F20_069 / F20_070
  const net = R['064'] - R['065'] - R['066'] - R['068'] - R['304'] - R['317'] + R['305'];
  R['069'] = net > 0 ? net : 0;
  R['070'] = net < 0 ? -net : 0;
  return R;
}

// ── ANTETUL formularului ─────────────────────────────────────────────────────

const nom = require('./bilantNomenclator');

/** Codurile de formular, dupa categoria de entitate. */
const FORMULARE = {
  micro: { cod: 'S1120', radacina: 'Bilant1120', ns: 's1120', tipBIL: 'UU' },
  mic: { cod: 'S1121', radacina: 'Bilant1121', ns: 's1121', tipBIL: 'BS' },
  mare: { cod: 'S1122', radacina: 'Bilant1122', ns: 's1122', tipBIL: 'BL' },
};

/**
 * Antetul, din datele firmei. Intoarce `{ attrs, lipsa }`:
 *  - `attrs` = perechile pentru XML (valorile ABSENTE nu se pun deloc — un atribut gol
 *    NU e neutru pentru validator, il respinge);
 *  - `lipsa` = lista campurilor obligatorii necompletate, in limbaj de utilizator.
 *
 * NU inventam valori implicite pentru identificare (judet, forma de proprietate, administrator,
 * intocmitor): un antet plauzibil dar gresit trece validatorul si ajunge la ANAF ca declaratie
 * gresita. Mai bine refuzam generarea si spunem ce lipseste.
 */
function antet(firma, year, categorie, totalCapital) {
  const f = firma || {};
  const F = FORMULARE[categorie] || FORMULARE.micro;
  const lipsa = [];
  const cer = (val, eticheta) => { if (val == null || String(val).trim() === '') lipsa.push(eticheta); return val; };

  const codJJ = nom.codJudet(f.judet);
  if (!codJJ) lipsa.push('judetul firmei (nu se poate deduce codul ANAF din „' + (f.judet || '') + '")');
  // codTT e tot un cod de judet, independent de codJJ in schema; implicit e acelasi judet
  // (administratia fiscala a firmei e, in mod normal, in judetul ei).
  const codTT = String(f.codTeritorial || codJJ || '');
  if (codTT && !nom.COD_JUDET.has(codTT)) lipsa.push('codul teritorial (valoare in afara nomenclatorului)');

  const forma = String(f.formaProprietate || '');
  if (!forma) lipsa.push('forma de proprietate');
  else if (!nom.COD_FORMA.has(forma)) lipsa.push('forma de proprietate (valoare in afara nomenclatorului)');

  const calit = String(f.intocmitCalitate || '');
  if (!calit) lipsa.push('calitatea celui care intocmeste situatiile');
  else if (!nom.COD_CALITATE.has(calit)) lipsa.push('calitatea (valoare in afara nomenclatorului)');

  const audit = String(f.auditStatut || '3'); // implicit: neauditat — cazul obisnuit la micro/mici
  if (!nom.COD_AUDIT.has(audit)) lipsa.push('statutul de audit (valoare in afara nomenclatorului)');

  cer(f.nume, 'denumirea firmei');
  cer(f.cui, 'CUI-ul');
  cer(f.adresa, 'adresa');
  cer(f.telefon, 'telefonul');
  cer(f.caen, 'codul CAEN');
  cer(f.administrator, 'numele administratorului');
  cer(f.intocmitNume, 'numele persoanei care intocmeste situatiile');

  const y = String(year);
  const attrs = {
    luna: '12', an: y, an_i: y,
    // CUI-ul se raporteaza fara prefixul „RO" si fara separatori
    cui: String(f.cui || '').replace(/[^0-9]/g, ''),
    den: f.nume || '', adresa: f.adresa || '', telefon: String(f.telefon || ''),
    caen: String(f.caen || ''), caenE: String(f.caenE || f.caen || ''),
    bifaMC: '0', tipBIL: F.tipBIL, interes_public: '0',
    codTT, codJJ: codJJ || '', codPP: forma,
    nume_admin: f.administrator || '',
    nume_intocmit: f.intocmitNume || '', calit_intocmit: calit,
    totalPlata_A: String(Math.round(totalCapital || 0)),
    // exercitiu financiar NEMODIFICAT: 01.01 - 31.12, trimestrul 4
    data_I: '01.01.' + y, data_S: '31.12.' + y, d_trim: '4', d_modif: '0',
    d_audit: audit, bifaGG: '0', bifaAA: '0',
  };

  // R26: numarul din Registrul CECCAR e obligatoriu la calitatile 21/22 si INTERZIS la restul.
  if (nom.CALITATI_CU_NR.has(calit)) {
    if (!String(f.intocmitNr || '').trim()) lipsa.push('numarul din Registrul CECCAR (obligatoriu pentru calitatea aleasa)');
    else attrs.nri_intocmit = String(f.intocmitNr).trim();
  }
  // d_audit=3 (neauditat): denumirea e ceruta, dar numarul si CIF-ul auditorului trebuie sa LIPSEASCA.
  attrs.den_audi = String(f.auditorNume || '').trim() || 'NEAUDITAT';
  if (audit !== '3') {
    if (String(f.auditorNr || '').trim()) attrs.nr_audi = String(f.auditorNr).trim();
    if (String(f.auditorCif || '').trim()) attrs.cif_audi = String(f.auditorCif).trim();
  }
  return { attrs, lipsa, formular: F };
}

// ── Listele de campuri cerute de schema ──────────────────────────────────────
// Numele atributelor sunt `<formular>_<rand><coloana>`; coloana 1 = inceputul exercitiului,
// 2 = sfarsitul. Numarul lor e VERIFICAT in teste fata de schema reala (51/14/88 de randuri) —
// un rand lipsa ar da un formular pe care ANAF il asteapta completat si nu l-ar gasi.
const interval = (de, la) => Array.from({ length: la - de + 1 }, (_, i) => String(de + i).padStart(3, '0'));
const campuri = (prefix, randuri) => randuri.flatMap((r) => [prefix + '_' + r + '1', prefix + '_' + r + '2']);

const RANDURI_F10 = [...interval(1, 49), '301', '302'];                  // 51 (prescurtat)
const RANDURI_F10_COMPLET = [...interval(1, 103), '301'];                // 104 (S1122)
const RANDURI_F20_MICRO = [...interval(1, 9), ...interval(301, 305)];    // 14
const RANDURI_F20_COMPLET = [...interval(1, 70), ...interval(301, 318)]; // 88

const CAMPURI_F10 = campuri('F10', RANDURI_F10);
const CAMPURI_F10_COMPLET = campuri('F10', RANDURI_F10_COMPLET);
const CAMPURI_F20_MICRO = campuri('F20', RANDURI_F20_MICRO);
const CAMPURI_F20_COMPLET = campuri('F20', RANDURI_F20_COMPLET);

/**
 * Situatiile financiare anuale complete pentru un an, gata de serializat.
 * `categorie`: 'micro' (S1120) sau 'mic' (S1121). Intoarce si `lipsa` — campurile de antet
 * necompletate; cine cheama decide daca refuza generarea (ruta o face).
 */
function situatii(view, firma, year, categorie) {
  const cat = ['mic', 'mare'].includes(categorie) ? categorie : 'micro';
  const complet = cat !== 'micro';                 // F20 complet la 'mic' SI la 'mare' (identice)
  const bilComplet = cat === 'mare';               // F10 complet doar la 'mare'
  const f20fn = complet ? f20Complet : f20Micro;
  const randProfit = complet ? '069' : '008';
  const randPierdere = complet ? '070' : '009';

  const f20cur = f20fn(view, year);
  const f20pre = f20fn(view, Number(year) - 1);
  const rez = (r) => r[randProfit] - r[randPierdere];
  // rezultatul din F20 e AUTORITATEA; bilantul il preia (vezi f10At / f10CompletAt)
  const f10fn = bilComplet ? f10CompletAt : f10At;
  const f10cur = f10fn(view, year, rez(f20cur));
  const f10pre = f10fn(view, Number(year) - 1, rez(f20pre));

  // suma de control (totalPlata_A) = randul de CAPITAL: 029 la prescurtat, 085 la complet
  const a = antet(firma, year, cat, f10cur[bilComplet ? '085' : '029']);
  // Reziduul absorbit in rezultatul reportat, pe fiecare an. Nu opreste generarea — formularul
  // torna oricum — dar trebuie SPUS: e singurul simptom al unui cont care nu cade unde trebuie.
  const rezidCur = verificaRezidual(f10cur);
  const rezidPre = verificaRezidual(f10pre);
  const avertismente = [];
  if (!rezidCur.ok) avertismente.push('Exercițiul ' + year + ': ' + rezidCur.mesaj);
  if (!rezidPre.ok) avertismente.push('Exercițiul ' + (Number(year) - 1) + ': ' + rezidPre.mesaj);
  return {
    antet: a, lipsa: a.lipsa, categorie: cat,
    rezidual: { curent: rezidCur, precedent: rezidPre }, avertismente,
    f10: { 1: f10pre, 2: f10cur },
    f20: { 1: f20pre, 2: f20cur },
    randuriF10: bilComplet ? CAMPURI_F10_COMPLET : CAMPURI_F10,
    randuriF20: complet ? CAMPURI_F20_COMPLET : CAMPURI_F20_MICRO,
  };
}

module.exports = {
  f10Base, f10Totals, f10At, f10CompletBase, f10CompletTotals, f10CompletAt,
  f20Micro, f20Complet, plAcc, antet, situatii, verificaRezidual, PRAG_REZIDUAL, FORMULARE,
  RANDURI_F10, RANDURI_F10_COMPLET, RANDURI_F20_MICRO, RANDURI_F20_COMPLET,
  CAMPURI_F10, CAMPURI_F10_COMPLET, CAMPURI_F20_MICRO, CAMPURI_F20_COMPLET,
};
