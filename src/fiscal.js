'use strict';

const { round2 } = require('./util');

/** Parametri fiscali 2026 (orientativi — conform ghidului, ed. 2026). */
const FISCAL = {
  an: 2026,
  // contributii si impozit pe salarii
  cas: 25, // %
  cass: 10,
  impozitVenit: 10,
  cam: 2.25,
  // salariul minim si suma neimpozabila
  salariuMinimS1: 4050,
  salariuMinimS2: 4325,
  salariuMinimConstructii: 4582,
  neimpozabilS1: 300,
  neimpozabilS2: 200,
  // TVA si impozite la nivelul firmei
  plafonScutire: 10000, // istoric (scutirile sectoriale au fost eliminate din 2025) — pastrat pt. compat. setari
  tvaStandard: 21, // %
  tvaRedus: 11,
  impozitMicro: 1,
  impozitProfit: 16,
  impozitDividende: 16, // 16% pentru dividendele distribuite de la 1 ianuarie 2026 (Legea 141/2025)
  deductibilitateTvaAutoLimitat: 50,
  // Eligibilitate micro (art. 47 Cod fiscal, OUG 156/2024): plafon 100.000 EUR din 2026.
  // Cursul pentru plafon e orientativ (legal: cursul de la inchiderea exercitiului precedent) — configurabil.
  plafonMicroEur: 100000,
  cursPlafonMicro: 5.0,
};

// Valorile implicite (instantaneu, inainte de orice suprascriere) — pentru „reset la valori standard".
const DEFAULTS = Object.freeze(Object.assign({}, FISCAL));

/**
 * Aplica cotele configurate de utilizator peste valorile implicite, mutand obiectul FISCAL in loc
 * (toate calculele care citesc `fiscal.FISCAL.*` la runtime preiau noile valori). Idempotent:
 * reseteaza la DEFAULTS, apoi aplica doar suprascrierile numerice valide.
 */
function applyConfig(cfg) {
  cfg = cfg || {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = cfg[k];
    FISCAL[k] = (v != null && v !== '' && Number.isFinite(Number(v))) ? Number(v) : DEFAULTS[k];
  }
  return FISCAL;
}

// Procentele MAXIME ale deducerii personale de baza (la nivelul salariului minim),
// dupa numarul de persoane in intretinere: 0, 1, 2, 3, 4+ (art. 77 Cod fiscal, Legea 34/2023).
const DP_PCT_MAX = [20, 25, 30, 35, 45];
const DP_PLAFON_PESTE_MINIM = 2000; // se acorda pana la salariul minim + 2000 lei

/**
 * Deducerea personala (art. 77 Cod fiscal): de baza (functie de venit + persoane in intretinere)
 * + suplimentara (tineri <=26 ani; copii in invatamant). Functie pura.
 *
 * NOTA: deducerea de baza la salariul minim foloseste procentele oficiale (20/25/30/35/45%).
 * Peste salariul minim, valoarea scade pana la 0 la (salariu minim + 2000 lei) — aproximata
 * prin interpolare liniara a grilei ANAF (pasi de 50 lei). Pentru valori exacte la leu se poate
 * folosi suprascrierea manuala. Rezultatul se rotunjeste la 10 lei in favoarea angajatului.
 * @returns {{ baza:number, suplimentara:number, total:number }}
 */
function deducerePersonala(brut, persoane, opts) {
  const o = opts || {};
  const sm = round2(o.salariuMinim || salariuMinimLa(o.period)); // S1/S2 dupa luna (trecerea de la 1 iulie)
  const b = round2(brut) || 0;
  let baza = 0;
  if (sm > 0 && b <= round2(sm + DP_PLAFON_PESTE_MINIM)) {
    const p = Math.max(0, Math.min(DP_PCT_MAX.length - 1, Math.round(Number(persoane) || 0)));
    const peste = Math.max(0, round2(b - sm)); // cat depaseste salariul minim
    const factor = Math.max(0, 1 - peste / DP_PLAFON_PESTE_MINIM); // taper liniar -> 0
    baza = round2(((sm * DP_PCT_MAX[p]) / 100) * factor);
  }
  let supl = 0;
  if (o.sub26 && b <= sm) supl = round2(supl + (sm * 15) / 100); // 15% din salariul minim, tineri <=26 ani
  if (o.copii) supl = round2(supl + 100 * (Number(o.copii) || 0)); // 100 lei/copil in invatamant (un singur parinte)
  const total = baza + supl > 0 ? Math.ceil(round2(baza + supl) / 10) * 10 : 0; // rotunjire la 10 lei
  return { baza, suplimentara: supl, total };
}

/** Salariul minim aplicabil unei luni: S1 pana la 30 iunie, S2 de la 1 iulie (trecerea 4.050 -> 4.325). */
function salariuMinimLa(period) {
  const m = Number(String(period || new Date().toISOString().slice(0, 7)).slice(5, 7)) || 1;
  return m >= 7 ? FISCAL.salariuMinimS2 : FISCAL.salariuMinimS1;
}
/** Suma neimpozabila din salariul minim aplicabila unei luni (300 lei S1 / 200 lei S2). */
function neimpozabilLa(period) {
  const m = Number(String(period || new Date().toISOString().slice(0, 7)).slice(5, 7)) || 1;
  return m >= 7 ? FISCAL.neimpozabilS2 : FISCAL.neimpozabilS1;
}

/**
 * Calculul salariului dintr-un brut (cotele 2026).
 * @param {number} brut
 * @param {number} deducere - deducerea totala scazuta din baza de impozit (deducere personala + sume neimpozabile)
 * @param {{tichete?:number, sector?:string}} [opts]
 *   - tichete: valoarea tichetelor de masa (suporta CASS 10% + impozit 10%, din 2024; NU CAS)
 *   - sector: doar informativ. Facilitatile sectoriale (IT/constructii/agro — scutire impozit/CASS)
 *     au fost ELIMINATE de la 1 ianuarie 2025 (OUG 156/2024); toate sectoarele se impoziteaza standard.
 */
function payroll(brut, deducere, opts) {
  const o = opts || {};
  const b = round2(brut) || 0;
  const ded = round2(deducere) || 0;
  const tichete = round2(o.tichete) || 0;
  // Avantaje in natura IMPOZABILE (auto in folosinta personala, chirie platita de firma, prime
  // in natura): intra in baza CAS + CASS + impozit + CAM, dar NU se platesc in bani — netul cash
  // scade doar cu contributiile/impozitul aferente avantajului.
  const avantaje = round2(o.avantaje) || 0;
  // Indemnizatii de concediu medical (OUG 158/2005): datoreaza CAS si impozit, dar NU CASS;
  // CAM doar pe partea suportata de angajator (partea FNUASS o suporta fondul si se recupereaza).
  const cmA = round2(o.cmAngajator) || 0;
  const cmF = round2(o.cmFnuass) || 0;
  const sector = o.sector || 'normal';
  const bazaCasReala = round2(b + avantaje + cmA + cmF);
  const cas = round2((bazaCasReala * FISCAL.cas) / 100);
  // tichetele de masa suporta CASS (din 2024) si impozit, dar NU CAS; indemnizatiile CM sunt exceptate de la CASS
  const bazaCassReala = round2(b + tichete + avantaje);
  const cass = round2((bazaCassReala * FISCAL.cass) / 100);
  // Norma partiala (OUG 16/2022, art. 146 Cod fiscal): cand venitul brut e sub salariul minim,
  // CAS si CASS se datoreaza la nivelul salariului minim (o.bazaMinima); DIFERENTA fata de
  // contributiile retinute angajatului o SUPORTA ANGAJATORUL (nu se retine din net).
  const bmin = round2(o.bazaMinima) || 0;
  const casAngajator = bmin > bazaCasReala ? round2(((bmin - bazaCasReala) * FISCAL.cas) / 100) : 0;
  const cassAngajator = bmin > bazaCassReala ? round2(((bmin - bazaCassReala) * FISCAL.cass) / 100) : 0;
  const baza = Math.max(0, round2(b + tichete + avantaje + cmA + cmF - cas - cass - ded));
  const impozit = round2((baza * FISCAL.impozitVenit) / 100);
  const cam = round2(((b + avantaje + cmA) * FISCAL.cam) / 100);
  const net = round2(b + cmA + cmF - cas - cass - impozit); // tichetele si avantajele se acorda ca valori, nu in numerar
  return { brut: b, tichete, avantaje, cmAngajator: cmA, cmFnuass: cmF, cas, cass, casAngajator, cassAngajator, baza, impozit, cam, net, costTotal: round2(b + cmA + cam + tichete + casAngajator + cassAngajator), sector, scutImpozit: false, scutCass: false, overPlafon: false };
}

/**
 * Taxele PFA in sistem real (Declaratia Unica) — ESTIMARE:
 *  - CAS 25%: datorata de la 12 salarii minime venit net (baza minima 12 SM;
 *    de la 24 SM in sus baza minima 24 SM); sub 12 SM e optionala (aici 0).
 *  - CASS 10%: pe venitul net, intre 6 SM (baza minima cand exista venit si nu
 *    exista alte venituri asigurate) si plafonul de 60 SM.
 *  - Impozit 10%: pe venitul net minus CAS si CASS datorate.
 * Optiunile individuale (baza CAS mai mare, alte venituri) raman la contribuabil.
 */
function taxePfa(venitNet, opts) {
  const o = opts || {};
  const sm = round2(Number(o.salariuMinim) || FISCAL.salariuMinim);
  const vn = Math.max(0, round2(venitNet) || 0);
  const p6 = round2(sm * 6); const p12 = round2(sm * 12); const p24 = round2(sm * 24); const p60 = round2(sm * 60);
  const bazaCas = vn >= p24 ? p24 : vn >= p12 ? p12 : 0;
  const cas = round2((bazaCas * FISCAL.cas) / 100);
  let bazaCass = 0;
  if (vn > 0) bazaCass = vn < p6 ? (o.areAlteVenituri ? vn : p6) : Math.min(vn, p60);
  bazaCass = round2(bazaCass);
  const cass = round2((bazaCass * FISCAL.cass) / 100);
  const impozit = round2((Math.max(0, vn - cas - cass) * FISCAL.impozitVenit) / 100);
  return { venitNet: vn, salariuMinim: sm, plafon6: p6, plafon12: p12, plafon24: p24, plafon60: p60, bazaCas, cas, bazaCass, cass, impozit, total: round2(cas + cass + impozit) };
}

module.exports = { FISCAL, DEFAULTS, applyConfig, payroll, taxePfa, deducerePersonala, salariuMinimLa, neimpozabilLa };
