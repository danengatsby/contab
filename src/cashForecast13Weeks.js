'use strict';

// Cash-flow direct pe 13 săptămâni. Fiecare flux are o sursă verificabilă: document deschis,
// șablon recurent, stat de salarii/configurația curentă, sold fiscal sau grafic de leasing.
// Ipotezele sunt returnate în răspuns și fotografiate; backtestingul nu recalculează prognoza.

const crypto = require('crypto');
const acc = require('./accounting');
const openItems = require('./openItems');
const recurring = require('./recurring');
const leasing = require('./leasing');
const payrollHistory = require('./payrollHistory');
const { statPlataPerioada } = require('./payroll');
const { round2, validIsoDate } = require('./util');

const WEEKS = 13;
const CASH_ACCOUNTS = new Set(['5121', '5124', '5311', '5314']);
const TAX_ACCOUNTS = ['4315', '4316', '436', '437', '4411', '4423', '444', '446', '447'];
const SCENARIOS = {
  base: { label: 'Bază', receivableFactor: 1, receivableDelayDays: 0, disputedDefaultProbability: 50 },
  prudent: { label: 'Prudent', receivableFactor: 0.7, receivableDelayDays: 14, disputedDefaultProbability: 25 },
  optimist: { label: 'Optimist', receivableFactor: 1, receivableDelayDays: 0, disputedDefaultProbability: 100 },
};

function day(value) {
  const s = String(value || '').slice(0, 10);
  if (!validIsoDate(s)) { const e = new Error('Data de început trebuie să fie o dată reală YYYY-MM-DD.'); e.status = 400; throw e; }
  return s;
}
function dateObj(value) { return new Date(String(value) + 'T00:00:00Z'); }
function addDays(value, n) { const d = dateObj(value); d.setUTCDate(d.getUTCDate() + Number(n || 0)); return d.toISOString().slice(0, 10); }
function periodOf(value) { return String(value).slice(0, 7); }
function addMonths(period, n) {
  const d = new Date(String(period) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}
function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function dateInPeriod(period, requestedDay) {
  const y = Number(period.slice(0, 4)); const m = Number(period.slice(5, 7));
  return period + '-' + String(Math.min(lastDay(y, m), Math.max(1, Number(requestedDay) || 1))).padStart(2, '0');
}
function monthsInRange(startDate, endDate) {
  const out = []; let p = periodOf(startDate); const last = periodOf(endDate);
  while (p <= last && out.length < 24) { out.push(p); p = addMonths(p, 1); }
  return out;
}
function posted(view) { return acc.postedEntries(view || {}); }

function treasuryEffect(entry) {
  let value = 0;
  for (const line of (entry.lines || [])) {
    const q = Number(line.suma) || 0;
    if (CASH_ACCOUNTS.has(String(line.debit))) value += q;
    if (CASH_ACCOUNTS.has(String(line.credit))) value -= q;
  }
  return round2(value); // transferul între două conturi de trezorerie este zero
}

function balancesAtDate(view, beforeDate) {
  const balances = {};
  for (const [code, value] of Object.entries(view.openingBalances || {})) {
    balances[code] = round2((Number(value.d) || 0) - (Number(value.c) || 0));
  }
  for (const entry of posted(view)) {
    if (!entry.data || String(entry.data) >= beforeDate) continue;
    for (const line of (entry.lines || [])) {
      const q = Number(line.suma) || 0;
      balances[line.debit] = round2((balances[line.debit] || 0) + q);
      balances[line.credit] = round2((balances[line.credit] || 0) - q);
    }
  }
  return balances;
}

function recurringAmount(template) {
  const f = template.fields || {};
  return round2((Number(f.baza) || 0) + (Number(f.tva) || 0))
    || round2(Number(f.suma) || 0) || round2(Number(f.total) || 0);
}
function incomeTemplate(type) { return /vanzare|^livrare_intra|^bon_fiscal|^aviz|factura_simplificata|incasare/.test(String(type)); }

function canonicalHash(value) {
  function canonical(v) {
    if (Array.isArray(v)) return v.map(canonical);
    if (!v || typeof v !== 'object') return v;
    const out = {}; for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonical(v[k]); return out;
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function forecast(view, templates, opts) {
  opts = opts || {};
  const startDate = day(opts.startDate || new Date().toISOString().slice(0, 10));
  const scenarioKey = SCENARIOS[opts.scenario] ? opts.scenario : 'base'; const scenario = SCENARIOS[scenarioKey];
  const endDate = addDays(startDate, WEEKS * 7 - 1);
  const balances = balancesAtDate(view, startDate);
  const cashNow = round2([...CASH_ACCOUNTS].reduce((s, code) => s + (Number(balances[code]) || 0), 0));
  const rows = Array.from({ length: WEEKS }, (_, index) => ({
    week: index + 1, startDate: addDays(startDate, index * 7), endDate: addDays(startDate, index * 7 + 6),
    opening: 0, customerReceipts: 0, recurringIn: 0, supplierPayments: 0, payroll: 0,
    taxes: 0, leasing: 0, recurringOut: 0, plannedIn: 0, plannedOut: 0, net: 0, closing: 0,
    sources: [],
  }));
  const unplanned = { missingDueDateReceivables: 0, missingDueDatePayables: 0,
    outsideHorizonReceivables: 0, outsideHorizonPayables: 0, probabilityRisk: 0 };
  const basis = [];

  function place(date, key, amount, direction, source) {
    const q = round2(Number(amount) || 0); if (!(q > 0)) return false;
    if (!date || !validIsoDate(String(date))) return false;
    let idx = Math.floor((dateObj(date) - dateObj(startDate)) / (7 * 86400000));
    if (idx < 0) idx = 0; // scadențele restante sunt exigibile în prima săptămână
    if (idx >= WEEKS) return false;
    rows[idx][key] = round2(rows[idx][key] + q);
    rows[idx].sources.push(Object.assign({ date, category: key, direction, amount: q }, source || {}));
    basis.push(Object.assign({ date, key, direction, amount: q }, source || {})); return true;
  }

  // Documentele deschise sunt singura sursă pentru creanțe/datorii comerciale. Lipsa scadenței
  // nu este mascată prin data documentului: suma rămâne explicit în afara planificării.
  const registry = openItems.registry(view, startDate);
  for (const doc of registry.openDocuments) {
    if (!doc.dueKnown) {
      unplanned[doc.sens === 'creanta' ? 'missingDueDateReceivables' : 'missingDueDatePayables']
        = round2(unplanned[doc.sens === 'creanta' ? 'missingDueDateReceivables' : 'missingDueDatePayables'] + doc.residual);
      continue;
    }
    const explicitProbability = doc.collectionProbability == null ? null : Number(doc.collectionProbability);
    const baseProbability = doc.sens === 'creanta'
      ? (explicitProbability == null
        ? (doc.dispute === true ? scenario.disputedDefaultProbability : 100)
        : explicitProbability)
      : 100;
    const probability = doc.sens === 'creanta' ? Math.max(0, Math.min(100, baseProbability * scenario.receivableFactor)) : 100;
    const delay = (Number(doc.forecastDelayDays) || 0) + (doc.sens === 'creanta' ? scenario.receivableDelayDays : 0);
    const due = addDays(doc.dueDate, delay); const planned = round2(doc.residual * probability / 100);
    if (doc.sens === 'creanta') unplanned.probabilityRisk = round2(unplanned.probabilityRisk + doc.residual - planned);
    const key = doc.sens === 'creanta' ? 'customerReceipts' : 'supplierPayments';
    if (!place(due, key, planned, doc.sens === 'creanta' ? 'in' : 'out', {
      sourceType: 'open-item', sourceId: doc.id, document: doc.document, partner: doc.partener,
      residual: doc.residual, probability,
    })) {
      const outsideKey = doc.sens === 'creanta' ? 'outsideHorizonReceivables' : 'outsideHorizonPayables';
      unplanned[outsideKey] = round2(unplanned[outsideKey] + planned);
    }
  }

  // Șabloane recurente încă negenerate; după generare, documentul real trece în registrul de mai sus.
  for (const period of monthsInRange(startDate, endDate)) for (const template of recurring.dueForPeriod(templates || [], period)) {
    const incoming = incomeTemplate(template.tip); const due = dateInPeriod(period, template.ziua || 1);
    place(due, incoming ? 'recurringIn' : 'recurringOut', recurringAmount(template), incoming ? 'in' : 'out',
      { sourceType: 'recurring-template', sourceId: template.id, document: template.partener || template.tip });
  }

  // Obligațiile deja constituite, dar neachitate, din soldurile conturilor 421 și fiscale.
  const salaryDueDay = Number((view.company || {}).salaryPaymentDay) || 10;
  const taxDueDay = Number((view.company || {}).taxPaymentDay) || 25;
  const salaryOutstanding = Math.max(0, -(Number(balances['421']) || 0));
  place(startDate, 'payroll', salaryOutstanding, 'out',
    { sourceType: 'ledger-balance', sourceId: '421', document: 'Salarii nete deja constituite' });
  for (const code of TAX_ACCOUNTS) {
    const payable = Math.max(0, -(Number(balances[code]) || 0));
    place(startDate, 'taxes', payable, 'out',
      { sourceType: 'ledger-balance', sourceId: code, document: 'Obligație fiscală constituită' });
  }

  // Salariile viitoare folosesc fotografia postată când există; altfel configurația actuală a
  // angajaților. O fotografie a cărei notă este deja înainte de start se află în soldurile de mai sus.
  const activePayroll = payrollHistory.activeSnapshots(view.payrollHistory || [], view.entries || []);
  const byPayrollPeriod = new Map(activePayroll.map((x) => [String(x.period), x]));
  for (const payrollPeriod of monthsInRange(periodOf(startDate) + '-01', endDate)) {
    const salaryDate = dateInPeriod(addMonths(payrollPeriod, 1), salaryDueDay);
    const taxDate = dateInPeriod(addMonths(payrollPeriod, 1), taxDueDay);
    if (salaryDate > endDate && taxDate > endDate) continue;
    const snap = byPayrollPeriod.get(payrollPeriod);
    const linked = snap && (view.entries || []).find((e) => String(e.id) === String(snap.entryId));
    if (linked && linked.data && String(linked.data) < startDate) continue;
    const totals = snap && snap.totals ? snap.totals : statPlataPerioada(view, payrollPeriod, false).totals;
    place(salaryDate, 'payroll', totals.restPlata, 'out', { sourceType: snap ? 'payroll-snapshot' : 'payroll-current-config', sourceId: snap && snap.id || payrollPeriod, document: 'Salarii ' + payrollPeriod });
    place(taxDate, 'taxes', totals.totalBuget, 'out', { sourceType: snap ? 'payroll-snapshot' : 'payroll-current-config', sourceId: snap && snap.id || payrollPeriod, document: 'Contribuții și impozit salarii ' + payrollPeriod });
  }

  // Ratele nefacturate din contracte. Facturile deja postate înainte de start sunt documente
  // deschise și nu se dublează aici.
  for (const contract of (view.leasingContracts || [])) {
    let schedule; try { schedule = leasing.contractSchedule(contract); } catch (_) { continue; }
    const dayOfMonth = Number(String(contract.dataPrimeiRate || '').slice(8, 10)) || 1;
    for (const installment of schedule.rows) {
      const due = dateInPeriod(installment.period, dayOfMonth);
      if (due < startDate || due > endDate) continue;
      const alreadyPosted = posted(view).some((e) => e.leasingRef
        && String(e.leasingRef.contractId) === String(contract.id) && e.leasingRef.period === installment.period
        && String(e.data || '') < startDate);
      if (alreadyPosted) continue;
      place(due, 'leasing', installment.total, 'out', { sourceType: 'leasing-contract', sourceId: contract.id,
        document: contract.denumire || 'Leasing', installmentPeriod: installment.period });
    }
  }

  let cash = cashNow;
  for (const row of rows) {
    row.opening = cash;
    row.plannedIn = round2(row.customerReceipts + row.recurringIn);
    row.plannedOut = round2(row.supplierPayments + row.payroll + row.taxes + row.leasing + row.recurringOut);
    row.net = round2(row.plannedIn - row.plannedOut); cash = round2(cash + row.net); row.closing = cash;
  }
  const minClosing = rows.length ? Math.min(...rows.map((x) => x.closing)) : cashNow;
  const assumptions = {
    scenario: scenarioKey, scenarioLabel: scenario.label,
    receivableFactorPct: scenario.receivableFactor * 100, receivableExtraDelayDays: scenario.receivableDelayDays,
    defaultReceivableProbabilityPct: 100,
    disputedWithoutExplicitProbabilityPct: scenario.disputedDefaultProbability,
    payablesProbabilityPct: 100, salaryPaymentDay: salaryDueDay, taxPaymentDay: taxDueDay,
    existingPayrollAndTaxBalancesPolicy: 'exigibile în prima săptămână',
    missingDueDatesPolicy: 'excluse din săptămâni și prezentate separat',
  };
  return {
    modelVersion: 1, startDate, endDate, weeks: WEEKS, scenario: scenarioKey, assumptions,
    cashNow, rows, ending: cash, minClosing: round2(minClosing), liquidityRisk: minClosing < 0,
    openReceivables: registry.totals.receivables, openPayables: registry.totals.payables,
    unplanned, basisHash: canonicalHash({ startDate, scenario: scenarioKey, assumptions, basis, cashNow }),
  };
}

function makeSnapshot(forecastValue, meta) {
  const f = JSON.parse(JSON.stringify(forecastValue));
  const row = {
    id: meta.id, firmaId: Number(meta.firmaId), createdAt: meta.createdAt || new Date().toISOString(),
    createdBy: meta.createdBy || null, createdByName: String(meta.createdByName || ''),
    startDate: f.startDate, endDate: f.endDate, scenario: f.scenario, basisHash: f.basisHash,
    forecast: f, immutable: true,
  };
  row.forecastHash = canonicalHash(f); return row;
}
function verifySnapshot(snapshot) {
  if (!snapshot || !snapshot.forecast || !snapshot.forecastHash) return false;
  return canonicalHash(snapshot.forecast) === snapshot.forecastHash;
}

function backtest(view, snapshot, asOf) {
  if (!verifySnapshot(snapshot)) { const e = new Error('Fotografia de cash-flow este coruptă sau incompletă.'); e.status = 409; throw e; }
  const today = day(asOf || new Date().toISOString().slice(0, 10)); const f = snapshot.forecast;
  const rows = [];
  for (const planned of f.rows) {
    if (planned.endDate >= today) continue; // numai săptămâni complet încheiate
    let actualIn = 0; let actualOut = 0;
    for (const entry of posted(view)) {
      if (!entry.data || entry.data < planned.startDate || entry.data > planned.endDate) continue;
      const effect = treasuryEffect(entry);
      if (effect > 0) actualIn = round2(actualIn + effect);
      if (effect < 0) actualOut = round2(actualOut - effect);
    }
    const actualNet = round2(actualIn - actualOut);
    rows.push({ week: planned.week, startDate: planned.startDate, endDate: planned.endDate,
      plannedIn: planned.plannedIn, actualIn, plannedOut: planned.plannedOut, actualOut,
      plannedNet: planned.net, actualNet, varianceNet: round2(actualNet - planned.net) });
  }
  return {
    snapshotId: snapshot.id, forecastHash: snapshot.forecastHash, startDate: f.startDate,
    completedWeeks: rows.length, rows,
    plannedNet: round2(rows.reduce((s, x) => s + x.plannedNet, 0)),
    actualNet: round2(rows.reduce((s, x) => s + x.actualNet, 0)),
    varianceNet: round2(rows.reduce((s, x) => s + x.varianceNet, 0)),
  };
}

module.exports = { forecast, makeSnapshot, verifySnapshot, backtest, treasuryEffect, balancesAtDate,
  SCENARIOS, CASH_ACCOUNTS, WEEKS, addDays, dateInPeriod };
