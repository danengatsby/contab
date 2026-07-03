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

module.exports = { leasingSchedule };
