'use strict';

// Generator grafic de rate leasing/credit: anuitati constante sau rate de capital egale.

const { round2 } = require('./util');

/**
 * @param principal valoarea finantata
 * @param months numarul de rate (luni)
 * @param annualRatePct dobanda anuala (%)
 * @param method 'anuitati' (rata fixa) sau 'rate_egale' (principal egal)
 */
function leasingSchedule(principal, months, annualRatePct, method) {
  const P = round2(Number(principal) || 0);
  const n = Math.max(1, Math.floor(Number(months) || 1));
  const r = (Number(annualRatePct) || 0) / 100 / 12;
  const m = method === 'rate_egale' ? 'rate_egale' : 'anuitati';
  const rows = [];
  let sold = P;

  if (m === 'rate_egale' || r === 0) {
    const principalLunar = round2(P / n);
    for (let i = 1; i <= n; i++) {
      const dob = round2(sold * r);
      const prnc = i === n ? round2(sold) : principalLunar;
      sold = round2(sold - prnc);
      rows.push({ luna: i, rata: round2(prnc + dob), principal: prnc, dobanda: dob, sold: Math.max(sold, 0) });
    }
  } else {
    const rataFixa = round2((P * r) / (1 - Math.pow(1 + r, -n)));
    for (let i = 1; i <= n; i++) {
      const dob = round2(sold * r);
      const prnc = i === n ? round2(sold) : round2(rataFixa - dob);
      sold = round2(sold - prnc);
      rows.push({ luna: i, rata: round2(prnc + dob), principal: prnc, dobanda: dob, sold: Math.max(sold, 0) });
    }
  }

  const totals = {
    rata: round2(rows.reduce((s, x) => s + x.rata, 0)),
    principal: round2(rows.reduce((s, x) => s + x.principal, 0)),
    dobanda: round2(rows.reduce((s, x) => s + x.dobanda, 0)),
  };
  return { principal: P, months: n, annualRatePct: Number(annualRatePct) || 0, method: m, rows, totals };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONTRACTUL DE LEASING — graficul legat de o luna calendaristica
//
//  `leasingSchedule` de mai sus numeroteaza ratele 1..n, atat. Ca factura lunara sa se poata
//  completa singura, rata trebuie gasita dupa LUNA in care se emite, nu dupa numar: contabilul
//  are in mana factura lui martie, nu „rata 15". Legarea se face de `dataPrimeiRate`.
// ─────────────────────────────────────────────────────────────────────────────

/** Luna (YYYY-MM) a ratei `n` (1-based), pornind de la data primei rate. */
function periodOfInstallment(dataPrimeiRate, n) {
  const d = new Date(dataPrimeiRate);
  if (isNaN(d)) return null;
  d.setDate(1); // ziua nu conteaza si ar putea sari o luna (31 ian + 1 luna)
  d.setMonth(d.getMonth() + (Math.max(1, Number(n) || 1) - 1));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/** Graficul unui contract, cu luna calendaristica si TVA-ul pe fiecare rata. */
function contractSchedule(contract) {
  const c = contract || {};
  const s = leasingSchedule(c.principal, c.months, c.dobandaAnuala, c.metoda);
  const cota = Number(c.cotaTva) || 0;
  s.rows = s.rows.map((r) => {
    // TVA-ul ratei de leasing FINANCIAR se aplica pe principal SI pe dobanda: dobanda e
    // contravaloarea unui serviciu de finantare prestat de locator, nu o operatiune scutita.
    const tva = round2(((r.principal + r.dobanda) * cota) / 100);
    return Object.assign({}, r, { period: periodOfInstallment(c.dataPrimeiRate, r.luna), tva, total: round2(r.rata + tva) });
  });
  s.totals.tva = round2(s.rows.reduce((x, r) => x + r.tva, 0));
  s.cotaTva = cota;
  return s;
}

/** Rata scadenta intr-o luna (YYYY-MM), sau null daca luna e in afara contractului. */
function installmentFor(contract, period) {
  const p = String(period || '').slice(0, 7);
  if (!p) return null;
  return contractSchedule(contract).rows.find((r) => r.period === p) || null;
}

module.exports = { leasingSchedule, contractSchedule, installmentFor, periodOfInstallment };
