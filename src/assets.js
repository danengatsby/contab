'use strict';

// Registru de mijloace fixe + amortizare (OMFP 1802/2014, Cod fiscal art. 28, HG 2139/2004).
// Metode: liniara, degresiva (AD1, cu trecere la liniar) si accelerata (50% in primul an).
// Amortizarea incepe din luna URMATOARE punerii in functiune si se inregistreaza lunar
// prin articolul 6811 = 281x (sau 6811 = 280x pentru imobilizari necorporale).

const { round2 } = require('./util');
const coa = require('./chartOfAccounts');
// Plafonul auto (art. 28 alin. (12) lit. m) se citeste LA RULARE din `fiscal.FISCAL`, nu din
// fiscalConfig direct: acolo ajung si suprascrierile din Setari, iar o valoare capturata la
// import ar ramane cea implicita pentru firmele care si-au schimbat parametrii.
const fiscal = require('./fiscal');

const METHODS = ['liniara', 'degresiva', 'accelerata'];
function plafonAutoLunar() {
  const v = Number(fiscal.FISCAL.plafonAmortizareAutoLunar);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Contul de amortizare corespunzator contului de imobilizare. */
function contAmortizare(cont) {
  const c = String(cont || '');
  if (/^20/.test(c)) return '280' + (c.charAt(2) || '8'); // necorporale: 205 -> 2805
  if (/^21/.test(c)) return '281' + (c.charAt(2) || '3'); // corporale: 2131 -> 2813
  return '281';
}

/** Coeficientul degresiv in functie de durata normala de functionare (ani). */
function degressiveCoef(years) {
  if (years <= 5) return 1.5;
  if (years <= 10) return 2.0;
  return 2.5;
}

/** Prima luna de amortizare = luna urmatoare punerii in functiune (format YYYY-MM). */
function firstDepreciationMonth(dataPif) {
  const d = new Date(dataPif);
  if (isNaN(d)) return null;
  // TOT in UTC. `new Date('2026-01-01')` se parseaza ca miezul noptii UTC, dar `getMonth()` si
  // `getFullYear()` citesc in ora LOCALA — pe un calculator la vest de UTC aceeasi zi devine
  // 31 decembrie, iar amortizarea incepe cu o luna mai devreme. Nu e o subtilitate de test:
  // pachetul Windows ruleaza pe calculatorul clientului, cu fusul lui, deci acelasi mijloc fix
  // s-ar fi amortizat altfel la Bucuresti si altfel la New York. Verificat: TZ=America/New_York
  // dadea prima luna 2026-01 in loc de 2026-02.
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/**
 * Ultima luna in care activul se mai amortizeaza (YYYY-MM), sau null daca nu e limitat.
 *
 * SURSA UNICA a regulii, fiindca era scrisa in doua locuri care se contraziceau: `compute` o citea
 * din `dataCasare` (corect), iar `monthlyDepreciation` sarea peste ORICE activ casat, indiferent
 * de data. Rezultatul: marcarea unui mijloc fix ca fiind casat stergea retroactiv amortizarea
 * lunilor DINAINTE de casare. Registrul arata amortizarea cumulata, dar niciun articol nu o
 * inregistrase — se declansa la orice inchidere intarziata sau regenerare de luna, adica exact
 * cand contabilul marcheaza casarea si abia apoi inchide lunile anterioare.
 *
 * Luna casarii se amortizeaza INCLUSIV (activul a fost in gestiune o parte din ea) — asa numara
 * si `compute`, iar cele doua trebuie sa dea acelasi raspuns despre acelasi activ.
 *
 * Un activ casat FARA data ramane sarit complet: nu se poate sti pana cand s-a amortizat, iar a
 * ghici ar inregistra cheltuiala pe luni in care activul putea sa nu mai existe.
 */
function stopMonth(asset) {
  if (!asset || asset.status !== 'casat') return null;
  return asset.dataCasare ? String(asset.dataCasare).slice(0, 7) : '';
}

/** Cotele anuale de amortizare pentru metoda aleasa. */
function annualQuotas(base, durataLuni, metoda) {
  const years = durataLuni / 12;
  if (metoda === 'accelerata') {
    // 50% in primul an, restul liniar pe durata ramasa
    if (durataLuni <= 12) return [base];
    return null; // tratat la nivel lunar (blocuri inegale)
  }
  if (metoda === 'degresiva') {
    const coef = degressiveCoef(years);
    const degRate = (1 / years) * coef;
    const nYears = Math.ceil(years);
    let remaining = base; const out = [];
    for (let y = 0; y < nYears; y++) {
      const remainingYears = years - y;
      const deg = remaining * degRate;
      const lin = remaining / remainingYears;
      let annual = Math.max(deg, lin); // trecere la liniar cand degresivul scade sub liniar
      annual = Math.min(annual, remaining);
      out.push(annual);
      remaining = remaining - annual;
    }
    return out;
  }
  return null; // liniara
}

/** Planul de amortizare lunar (o linie pe luna), cu inchidere exacta pe valoarea amortizabila. */
function schedule(asset) {
  const cost = round2(Number(asset.cost) || 0);
  const rezidual = round2(Number(asset.valoareReziduala) || 0);
  const durata = Math.max(1, Number(asset.durataLuni) || 1);
  const base = round2(cost - rezidual);
  const metoda = METHODS.includes(asset.metoda) ? asset.metoda : 'liniara';
  const startM = firstDepreciationMonth(asset.dataPif);
  if (!startM) return [];

  // valoarea bruta a fiecarei luni (inainte de rotunjirea de inchidere)
  const monthly = [];
  if (metoda === 'liniara') {
    for (let i = 0; i < durata; i++) monthly.push(base / durata);
  } else if (metoda === 'accelerata' && durata > 12) {
    const firstHalf = (base * 0.5) / 12;
    const rest = (base * 0.5) / (durata - 12);
    for (let i = 0; i < durata; i++) monthly.push(i < 12 ? firstHalf : rest);
  } else if (metoda === 'degresiva') {
    const quotas = annualQuotas(base, durata, 'degresiva');
    for (let i = 0; i < durata; i++) {
      const block = Math.floor(i / 12);
      const blockStart = block * 12;
      const blockMonths = Math.min(12, durata - blockStart);
      monthly.push((quotas[block] || 0) / blockMonths);
    }
  } else {
    for (let i = 0; i < durata; i++) monthly.push(base / durata); // fallback liniar
  }

  const rows = [];
  let cumulat = 0;
  let [y, m] = startM.split('-').map(Number);
  for (let i = 0; i < durata; i++) {
    const last = i === durata - 1;
    const amount = last ? round2(base - cumulat) : round2(monthly[i]);
    cumulat = round2(cumulat + amount);
    rows.push({ period: y + '-' + String(m).padStart(2, '0'), amount, cumulat, ramas: round2(cost - cumulat) });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return rows;
}

/** Valorile calculate la o data de referinta (sfarsitul perioadei `asOf`, YYYY-MM sau data). */
function compute(asset, asOf) {
  const cost = round2(Number(asset.cost) || 0);
  const rezidual = round2(Number(asset.valoareReziduala) || 0);
  const durata = Math.max(1, Number(asset.durataLuni) || 1);
  const base = round2(cost - rezidual);
  const metoda = METHODS.includes(asset.metoda) ? asset.metoda : 'liniara';
  const sch = schedule(asset);
  const refM = String(asOf || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const stopM = stopMonth(asset) || refM;
  const limitM = stopM < refM ? stopM : refM;

  let cumulat = 0; let luni = 0; let current = 0;
  for (const r of sch) {
    if (r.period <= limitM) { cumulat = r.cumulat; luni += 1; }
    if (r.period === refM) current = r.amount;
  }
  return {
    metoda, contAmortizare: contAmortizare(asset.cont),
    bazaAmortizabila: base, amortizareLunara: current || (sch[0] ? sch[0].amount : 0),
    luniAmortizate: luni, durataLuni: durata,
    amortizareCumulata: round2(cumulat), valoareRamasa: round2(cost - cumulat),
    integralAmortizat: luni >= durata,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PLANUL FISCAL DE AMORTIZARE (art. 28 Cod fiscal)
//
//  Amortizarea fiscala poate folosi ALTA metoda si ALTA durata decat cea contabila (cazul uzual:
//  accelerata fiscal, liniara contabil). Diferenta dintre ele e o ajustare a rezultatului fiscal,
//  in ambele sensuri, si se anuleaza pe toata durata de viata — nu creeaza si nu distruge deducere,
//  o MUTA intre exercitii.
//
//  Planul fiscal e EXTRACONTABIL: nu genereaza articole. Doar planul contabil posteaza 6811 = 281x.
//
//  Nu exista migrare de date, deliberat: `metodaFiscala`/`durataFiscalaLuni` lipsa inseamna
//  „identic cu planul contabil", iar fallback-ul de mai jos o face fara sa scrie nimic. O migrare
//  care ar copia aceleasi valori in fiecare rand ar fi amplificare de scriere pentru zero efect,
//  iar la o schimbare ulterioara a metodei contabile planul fiscal trebuie sa o urmeze cat timp
//  utilizatorul nu l-a fixat explicit — exact ce face fallback-ul.
// ─────────────────────────────────────────────────────────────────────────────

/** Vederea FISCALA a unui mijloc fix: acelasi activ, cu metoda si durata fiscale. */
function fiscalView(asset) {
  const durataF = Number(asset.durataFiscalaLuni);
  return Object.assign({}, asset, {
    metoda: METHODS.includes(asset.metodaFiscala) ? asset.metodaFiscala : asset.metoda,
    durataLuni: Number.isFinite(durataF) && durataF > 0 ? durataF : asset.durataLuni,
  });
}

/** Are activul un plan fiscal DIFERIT de cel contabil? (pentru raportare, nu pentru calcul) */
function hasFiscalPlan(asset) {
  const f = fiscalView(asset);
  return f.metoda !== asset.metoda || Number(f.durataLuni) !== Number(asset.durataLuni);
}

/** Suma amortizarii dintr-un AN, pe planul dat (`schedule` e refolosit, nu reimplementat).
 *  `panaLa` (YYYY-MM) opreste cumularea la finalul unei luni — impozitul pe profit se declara
 *  trimestrial, cumulat de la inceputul anului, deci ajustarea art. 28 trebuie sa poata fi ceruta
 *  si la 31 martie. Fara el, anul intreg (comportamentul istoric). */
function annualFor(asset, year, fiscal, panaLa) {
  const rows = schedule(fiscal ? fiscalView(asset) : asset);
  const limita = panaLa ? String(panaLa).slice(0, 7) : null;
  // Art. 28 alin. (12) lit. m): la vehiculele de persoane cu maxim 9 scaune, amortizarea FISCALA
  // e deductibila cel mult `plafonAmortizareAutoLunar` PE LUNA. Plafonarea se face pe fiecare
  // luna, nu pe total: un an cu 11 luni de amortizare nu primeste plafonul lunii lipsa.
  // Se aplica DOAR planului fiscal — cel contabil ramane intreg (6811 se inregistreaza normal),
  // iar diferenta devine ajustare in registrul fiscal, ca la orice divergenta art. 28.
  const plafon = (fiscal && asset && asset.vehiculM1) ? plafonAutoLunar() : 0;
  let s = 0;
  for (const r of rows) {
    if (!String(r.period).startsWith(String(year))) continue;
    if (limita && String(r.period) > limita) continue;
    s = round2(s + (plafon > 0 ? Math.min(r.amount, plafon) : r.amount));
  }
  return s;
}

/**
 * Amortizarea contabila vs fiscala a unui an, pe tot registrul (art. 28).
 * `amortizareContabilaReala` (rulajul contului 6811), cand e dat, INLOCUIESTE suma din plan pe
 * partea contabila: registrul fiscal trebuie sa porneasca de la ce s-a inregistrat efectiv, nu de
 * la ce ar fi trebuit sa se inregistreze. Diferenta dintre ele e o problema de contabilitate, nu
 * una fiscala, si nu trebuie ascunsa intr-o ajustare.
 */
function depreciationDifference(assets, year, amortizareContabilaReala, panaLa) {
  let contabilaPlan = 0; let fiscala = 0;
  for (const a of assets || []) {
    contabilaPlan = round2(contabilaPlan + annualFor(a, year, false, panaLa));
    fiscala = round2(fiscala + annualFor(a, year, true, panaLa));
  }
  const contabila = (amortizareContabilaReala != null && Number.isFinite(Number(amortizareContabilaReala)))
    ? round2(Number(amortizareContabilaReala)) : contabilaPlan;
  return {
    contabila, contabilaPlan, fiscala,
    // > 0 => amortizarea contabila e mai mare => partea in plus e NEDEDUCTIBILA;
    // < 0 => amortizarea fiscala e mai mare => deducere suplimentara.
    diferenta: round2(contabila - fiscala),
    areDiferenta: round2(contabila - fiscala) !== 0,
  };
}

/** Amortizarea de inregistrat pentru o luna (pentru toate mijloacele active). */
function monthlyDepreciation(assets, period) {
  const lines = [];
  let total = 0;
  for (const a of assets) {
    // Casarea opreste amortizarea DUPA luna ei, nu retroactiv: lunile dinainte se inregistreaza
    // normal. Acelasi `stopMonth` pe care il foloseste `compute`, ca registrul si articolele sa nu
    // se mai contrazica. Sirul gol = casat fara data => sarit complet (vezi stopMonth).
    const stop = stopMonth(a);
    if (stop !== null && (stop === '' || period > stop)) continue;
    const row = schedule(a).find((r) => r.period === period);
    if (!row || row.amount <= 0) continue;
    lines.push({ assetId: a.id, denumire: a.denumire, cont: a.cont, contAmortizare: contAmortizare(a.cont), suma: row.amount });
    total = round2(total + row.amount);
  }
  return { period, lines, total };
}

/** Mijloacele fixe cu valorile calculate la o data (pentru liste/SAF-T). */
function register(db, asOf) {
  return (db.assets || []).map((a) => Object.assign({}, a, {
    contNume: coa.accountName(a.cont),
    calc: compute(a, asOf),
  }));
}

module.exports = { compute, schedule, monthlyDepreciation, register, contAmortizare, firstDepreciationMonth, degressiveCoef, METHODS,
  fiscalView, hasFiscalPlan, annualFor, depreciationDifference };
