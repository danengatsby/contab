'use strict';

const { round2 } = require('./util');
// Parametrii fiscali (cote, praguri, grile) traiesc intr-o sursa unica datata, cu referinta
// legala pe fiecare valoare: src/fiscalConfig.js. Aici e DOAR logica de calcul.
const cfg = require('./fiscalConfig');
const ben = require('./beneficii'); // plafonul de 33% (art. 76 alin. (4^1)) — motor pur

/** Parametri fiscali (an `cfg.AN`) — mutabili la runtime prin applyConfig (suprascrieri din Setari). */
const FISCAL = Object.assign({}, cfg.RATES);

// Valorile implicite (instantaneu, inainte de orice suprascriere) — pentru „reset la valori standard".
const DEFAULTS = Object.freeze(Object.assign({}, cfg.RATES));

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

/**
 * Vechimea cotelor: cotele implicite sunt fixate pentru un an fiscal (`FISCAL.an`) si trebuie
 * revizuite manual la modificari legislative. Semnaleaza cand anul calendaristic a depasit anul
 * de referinta al cotelor — riscul principal al valorilor hardcodate. Functie pura (an dat).
 * @returns {{ an:number, anCurent:number, stale:boolean }}
 */
function fiscalStaleness(anCurent) {
  const cur = Number(anCurent) || 0;
  const ref = Number(FISCAL.an) || 0;
  return { an: ref, anCurent: cur, stale: !!(cur && ref && cur > ref) };
}

// Procentele MAXIME ale deducerii personale de baza (la nivelul salariului minim), dupa numarul
// de persoane in intretinere: 0, 1, 2, 3, 4+ (art. 77 Cod fiscal, Legea 34/2023) — vezi fiscalConfig.
const DP_PCT_MAX = cfg.DEDUCERE.pctMax;
const DP_PLAFON_PESTE_MINIM = cfg.DEDUCERE.plafonPesteMinim; // se acorda pana la salariul minim + acest plafon

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
  if (o.sub26 && b <= sm) supl = round2(supl + (sm * cfg.DEDUCERE.suplTineriPct) / 100); // % din SM, tineri <=26 ani
  if (o.copii) supl = round2(supl + cfg.DEDUCERE.suplCopilLei * (Number(o.copii) || 0)); // lei/copil in invatamant
  const rot = cfg.DEDUCERE.rotunjireLei;
  const total = baza + supl > 0 ? Math.ceil(round2(baza + supl) / rot) * rot : 0; // rotunjire in favoarea angajatului
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
 * Suma neimpozabila din salariul minim, pentru o luna (art. 76 Cod fiscal): 300 lei S1 / 200 S2.
 *
 * `neimpozabilLa` de mai sus da doar CUANTUMUL lunii; aici stau CONDITIILE, fiindca facilitatea
 * nu se acorda tuturor. Se cer amandoua:
 *   1. salariul de baza brut lunar = salariul minim (nu „in jurul lui" — egal);
 *   2. brutul realizat in luna nu depaseste salariul minim + suma.
 * A doua conditie o taie la depasire, deci un spor care ridica brutul peste plafon anuleaza
 * facilitatea in intregime (nu o reduce proportional).
 *
 * Se DERIVA din salariu si luna, nu se bifeaza pe angajat: un cuantum stocat ar ramane adevarat
 * dupa ce salariul creste, si s-ar aplica tacit la un brut care nu mai da dreptul la el.
 *
 * @returns {{ suma:number, eligibil:boolean, motiv:string }} `motiv` explica refuzul, ca sa poata
 *   fi aratat in statul de plata — o facilitate lipsa fara explicatie pare o eroare de calcul.
 */
function neimpozabilMinim(brut, salariuBaza, period) {
  const sm = salariuMinimLa(period);
  const suma = neimpozabilLa(period);
  const b = round2(Number(brut) || 0);
  const baza = round2(Number(salariuBaza != null ? salariuBaza : brut) || 0);
  if (!(sm > 0) || !(suma > 0)) return { suma: 0, eligibil: false, motiv: 'Fara salariu minim sau suma neimpozabila configurate.' };
  if (baza !== sm) return { suma: 0, eligibil: false, motiv: 'Salariul de baza (' + baza + ' lei) nu e la nivelul salariului minim (' + sm + ' lei).' };
  const plafon = round2(sm + suma);
  if (b > plafon) return { suma: 0, eligibil: false, motiv: 'Brutul lunii (' + b + ' lei) depaseste plafonul de ' + plafon + ' lei (salariul minim + ' + suma + ').' };
  return { suma: Math.min(suma, b), eligibil: true, motiv: '' };
}

/**
 * Categoriile art. 76 alin. (4^1), cu limitele ACTUALIZATE din parametrii curenti.
 *
 * Cuantumurile care le alimenteaza (tichetul de masa, castigul salarial mediu, diurna legala) se
 * schimba prin alte acte decat Codul fiscal, deci se invechesc primele. Stau in `RATES`, unde
 * `applyConfig` le poate suprascrie din Setari, iar aici se REAPLICA peste tabelul de categorii
 * la fiecare apel. Citite direct din `cfg.BENEFICII`, ar fi ramas inghetate la valorile implicite
 * si suprascrierea utilizatorului n-ar fi avut niciun efect — un knob care pare ca merge.
 */
function categoriiBeneficii() {
  return cfg.BENEFICII.map((cat) => {
    const cheie = (cat.limita || {}).sursaRate;
    if (!cheie) return cat;
    const v = Number(FISCAL[cheie]);
    if (!Number.isFinite(v) || v <= 0) return cat;
    const multiplu = Number(cat.limita.multiplu) || 1;
    return Object.assign({}, cat, { limita: Object.assign({}, cat.limita, { lei: round2(v * multiplu) }) });
  });
}

/**
 * Avantajele din plafonul de 33% (art. 76 alin. (4^1)) — vezi `src/beneficii.js` pentru mecanica.
 * Aici se INJECTEAZA doar parametrii (categoriile datate + procentul suprascriabil din Setari),
 * ca motorul sa ramana pur si testabil, exact ca la deducerea personala.
 */
function beneficii(intrare) {
  return ben.calcul(intrare, {
    categorii: categoriiBeneficii(),
    pct: FISCAL.plafonBeneficiiPct,
    cursEur: FISCAL.cursEurBeneficii,
  });
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
  // Partea din avantajele art. 76 alin. (4^1) care a depasit limita ei individuala sau plafonul
  // de 33% (calculata de `beneficii()`). Se impoziteaza EXACT ca un avantaj in natura — impozit,
  // CAS (art. 139(1)(v)), CASS (art. 157(1)(v)) si CAM — si nu se plateste in bani. E tinuta
  // separat de `avantaje` doar ca statul de plata sa poata arata DE CE a aparut: un avantaj
  // devenit impozabil dintr-un plafon depasit nu se poate explica dintr-un total comun.
  const beneficiiImpozabile = round2(o.beneficiiImpozabile) || 0;
  // Indemnizatii de concediu medical (OUG 158/2005): datoreaza CAS si impozit, dar NU CASS;
  // CAM doar pe partea suportata de angajator (partea FNUASS o suporta fondul si se recupereaza).
  const cmA = round2(o.cmAngajator) || 0;
  const cmF = round2(o.cmFnuass) || 0;
  const sector = o.sector || 'normal';
  // Suma neimpozabila din salariul minim (art. 76): NU e o simpla deducere. `deducere` (deducerea
  // personala) scade doar baza de IMPOZIT; suma asta iese din TOATE bazele — impozit, CAS, CASS si
  // CAM. Tratata ca deducere, ar fi lasat contributiile calculate pe intreg brutul, deci CAS/CASS
  // si CAM supraevaluate — si asta merge direct in D112.
  const nm = Math.max(0, Math.min(round2(o.neimpozabilMinim) || 0, b));
  const bazaCasReala = round2(b + avantaje + beneficiiImpozabile + cmA + cmF - nm);
  const cas = round2((bazaCasReala * FISCAL.cas) / 100);
  // tichetele de masa suporta CASS (din 2024) si impozit, dar NU CAS; indemnizatiile CM sunt exceptate de la CASS
  const bazaCassReala = round2(b + tichete + avantaje + beneficiiImpozabile - nm);
  const cass = round2((bazaCassReala * FISCAL.cass) / 100);
  // Norma partiala (OUG 16/2022, art. 146 Cod fiscal): cand venitul brut e sub salariul minim,
  // CAS si CASS se datoreaza la nivelul salariului minim (o.bazaMinima); DIFERENTA fata de
  // contributiile retinute angajatului o SUPORTA ANGAJATORUL (nu se retine din net).
  const bmin = round2(o.bazaMinima) || 0;
  const casAngajator = bmin > bazaCasReala ? round2(((bmin - bazaCasReala) * FISCAL.cas) / 100) : 0;
  const cassAngajator = bmin > bazaCassReala ? round2(((bmin - bazaCassReala) * FISCAL.cass) / 100) : 0;
  const baza = Math.max(0, round2(b + tichete + avantaje + beneficiiImpozabile + cmA + cmF - nm - cas - cass - ded));
  const impozit = round2((baza * FISCAL.impozitVenit) / 100);
  const cam = round2(((b + avantaje + beneficiiImpozabile + cmA - nm) * FISCAL.cam) / 100);
  // Netul creste, dar nu fiindca se adauga ceva: suma ramane in brut, doar nu mai e taxata.
  const net = round2(b + cmA + cmF - cas - cass - impozit); // tichetele si avantajele se acorda ca valori, nu in numerar
  // costTotal NU include avantajele si beneficiile: ele se inregistreaza pe conturile lor cand se
  // acorda (6458, 626...), deci adunate si aici s-ar numara de doua ori. Tichetele fac exceptie
  // istorica — sunt cumparate de angajator odata cu statul.
  return { brut: b, tichete, avantaje, beneficiiImpozabile, cmAngajator: cmA, cmFnuass: cmF, neimpozabilMinim: nm, cas, cass, casAngajator, cassAngajator, baza, impozit, cam, net, costTotal: round2(b + cmA + cam + tichete + casAngajator + cassAngajator), sector, scutImpozit: false, scutCass: false, overPlafon: false };
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
  // salariul minim: cel dat explicit, altfel cel aplicabil lunii (FISCAL nu are un camp `salariuMinim` unic — e S1/S2)
  const sm = round2(Number(o.salariuMinim) || salariuMinimLa(o.period));
  const vn = Math.max(0, round2(venitNet) || 0);
  const p6 = round2(sm * cfg.PFA.plafonCassInf); const p12 = round2(sm * cfg.PFA.cas12); const p24 = round2(sm * cfg.PFA.cas24); const p60 = round2(sm * cfg.PFA.plafonCassSup);
  const bazaCas = vn >= p24 ? p24 : vn >= p12 ? p12 : 0;
  const cas = round2((bazaCas * FISCAL.cas) / 100);
  let bazaCass = 0;
  if (vn > 0) bazaCass = vn < p6 ? (o.areAlteVenituri ? vn : p6) : Math.min(vn, p60);
  bazaCass = round2(bazaCass);
  const cass = round2((bazaCass * FISCAL.cass) / 100);
  const impozit = round2((Math.max(0, vn - cas - cass) * FISCAL.impozitVenit) / 100);
  return { venitNet: vn, salariuMinim: sm, plafon6: p6, plafon12: p12, plafon24: p24, plafon60: p60, bazaCas, cas, bazaCass, cass, impozit, total: round2(cas + cass + impozit) };
}

module.exports = { FISCAL, DEFAULTS, applyConfig, categoriiBeneficii, fiscalStaleness, payroll, taxePfa, deducerePersonala, salariuMinimLa, neimpozabilLa, neimpozabilMinim, beneficii, CATEGORII_BENEFICII: cfg.BENEFICII };
