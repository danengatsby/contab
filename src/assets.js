'use strict';

// Registru de mijloace fixe + amortizare (OMFP 1802/2014, Cod fiscal art. 28, HG 2139/2004).
// Metode: liniara, degresiva (AD1, cu trecere la liniar) si accelerata (50% in primul an).
// Amortizarea incepe din luna URMATOARE punerii in functiune si se inregistreaza lunar
// prin articolul 6811 = 281x (sau 6811 = 280x pentru imobilizari necorporale).

const { round2 } = require('./util');
const coa = require('./chartOfAccounts');

const METHODS = ['liniara', 'degresiva', 'accelerata'];

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

function monthsBetween(from, to) {
  const a = new Date(from); const b = new Date(to);
  if (isNaN(a) || isNaN(b)) return 0;
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

/** Prima luna de amortizare = luna urmatoare punerii in functiune (format YYYY-MM). */
function firstDepreciationMonth(dataPif) {
  const d = new Date(dataPif);
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
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
  const stopM = asset.status === 'casat' && asset.dataCasare ? String(asset.dataCasare).slice(0, 7) : refM;
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

/** Amortizarea de inregistrat pentru o luna (pentru toate mijloacele active). */
function monthlyDepreciation(assets, period) {
  const lines = [];
  let total = 0;
  for (const a of assets) {
    if (a.status === 'casat') continue;
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

module.exports = { compute, schedule, monthlyDepreciation, register, contAmortizare, firstDepreciationMonth, degressiveCoef, METHODS };
