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
  plafonScutire: 10000, // plafonul brut pana la care se aplica scutirile sectoriale (IT/constructii/agro)
  tvaStandard: 21, // %
  tvaRedus: 11,
  impozitMicro: 1,
  impozitProfit: 16,
  impozitDividende: 10,
  deductibilitateTvaAutoLimitat: 50,
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
  const sm = round2(o.salariuMinim || FISCAL.salariuMinimS1);
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

/**
 * Calculul salariului dintr-un brut (cotele 2026).
 * @param {number} brut
 * @param {number} deducere - deducerea totala scazuta din baza de impozit (deducere personala + sume neimpozabile)
 * @param {{tichete?:number, sector?:'normal'|'it'|'constructii'|'agro'}} [opts]
 *   - tichete: valoarea tichetelor de masa (suporta CASS 10% + impozit 10%, din 2024; NU CAS)
 *   - sector: scutiri sectoriale — IT (scutire impozit); constructii/agro (scutire impozit + CASS),
 *     aplicate pana la plafonul lunar (FISCAL.plafonScutire). Peste plafon -> flag de verificat manual.
 */
function payroll(brut, deducere, opts) {
  const o = opts || {};
  const b = round2(brut) || 0;
  const ded = round2(deducere) || 0;
  const tichete = round2(o.tichete) || 0;
  const sector = o.sector || 'normal';
  const scutImpozitSector = sector === 'it' || sector === 'constructii' || sector === 'agro';
  const scutCassSector = sector === 'constructii' || sector === 'agro';
  // scutirile se aplica pana la plafon; peste -> nu le aplicam automat (semnalam pentru verificare manuala)
  const overPlafon = (scutImpozitSector || scutCassSector) && b > (FISCAL.plafonScutire || 10000);
  const scutImpozit = scutImpozitSector && !overPlafon;
  const scutCass = scutCassSector && !overPlafon;
  const cas = round2((b * FISCAL.cas) / 100);
  // tichetele de masa suporta CASS (din 2024) si impozit, dar NU CAS
  const cass = scutCass ? 0 : round2(((b + tichete) * FISCAL.cass) / 100);
  const baza = Math.max(0, round2(b + tichete - cas - cass - ded));
  const impozit = scutImpozit ? 0 : round2((baza * FISCAL.impozitVenit) / 100);
  const cam = round2((b * FISCAL.cam) / 100);
  const net = round2(b - cas - cass - impozit); // tichetele se acorda ca valori, nu in numerar
  return { brut: b, tichete, cas, cass, baza, impozit, cam, net, costTotal: round2(b + cam + tichete), sector, scutImpozit, scutCass, overPlafon };
}

module.exports = { FISCAL, DEFAULTS, applyConfig, payroll, deducerePersonala };
