'use strict';

// Generator grafic de rate leasing/credit: anuitati constante sau rate de capital egale.

const { round2, validIsoDate } = require('./util');

const MAX_MONTHS = 1200; // 100 de ani; plafon de siguranta pentru bucle si raspunsuri HTTP
const MAX_PRINCIPAL = 90000000000000; // ultimul ordin de marime cu bani la cent in zona safe integer
const MAX_RATE_PCT = 1000;

function inputError(message) { const e = new RangeError(message); e.status = 400; throw e; }

/**
 * @param principal valoarea finantata
 * @param months numarul de rate (luni)
 * @param annualRatePct dobanda anuala (%)
 * @param method 'anuitati' (rata fixa) sau 'rate_egale' (principal egal)
 */
function leasingSchedule(principal, months, annualRatePct, method) {
  const rawP = Number(principal); const rawN = Number(months);
  const rawRate = annualRatePct == null || annualRatePct === '' ? 0 : Number(annualRatePct);
  if (!Number.isFinite(rawP) || !(rawP > 0) || rawP > MAX_PRINCIPAL) inputError('Valoarea finantata trebuie sa fie finita, pozitiva si in limita monetara acceptata.');
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_MONTHS) inputError('Numarul de rate trebuie sa fie un intreg intre 1 si ' + MAX_MONTHS + '.');
  if (!Number.isFinite(rawRate) || rawRate < 0 || rawRate > MAX_RATE_PCT) inputError('Dobanda anuala trebuie sa fie intre 0 si ' + MAX_RATE_PCT + '%.');
  const P = round2(rawP);
  const n = rawN;
  const r = rawRate / 100 / 12;
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
  return { principal: P, months: n, annualRatePct: rawRate, method: m, rows, totals };
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
  const nr = Number(n);
  if (!validIsoDate(dataPrimeiRate) || !Number.isInteger(nr) || nr < 1 || nr > MAX_MONTHS) return null;
  const d = new Date(dataPrimeiRate + 'T00:00:00Z');
  // TOT in UTC, ca la `assets.firstDepreciationMonth`: data se parseaza ca miezul noptii UTC, deci
  // citirea cu getteri LOCALI muta luna cu una intreaga pe orice calculator la vest de UTC. Rata
  // lunii ar fi cazut atunci pe luna gresita — iar pachetul Windows ruleaza pe fusul clientului.
  d.setUTCDate(1); // ziua nu conteaza si ar putea sari o luna (31 ian + 1 luna)
  d.setUTCMonth(d.getUTCMonth() + nr - 1);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/** Graficul unui contract, cu luna calendaristica si TVA-ul pe fiecare rata. */
function contractSchedule(contract) {
  const c = contract || {};
  const s = leasingSchedule(c.principal, c.months, c.dobandaAnuala, c.metoda);
  if (!validIsoDate(c.dataPrimeiRate)) inputError('Data primei rate nu este o data calendaristica valida (YYYY-MM-DD).');
  const cota = c.cotaTva == null || c.cotaTva === '' ? 0 : Number(c.cotaTva);
  if (!Number.isFinite(cota) || cota < 0 || cota > 100) inputError('Cota TVA trebuie sa fie intre 0 si 100%.');
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

module.exports = { leasingSchedule, contractSchedule, installmentFor, periodOfInstallment, MAX_MONTHS };
