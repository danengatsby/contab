'use strict';

const { round2 } = require('./util');
const coa = require('./chartOfAccounts');
const { postedEntries } = require('./accounting'); // registrele analitice numara doar articole postate

// Conturi care se detaliaza pe partener (dimensiunea = partenerul)
const PARTNER_SYNTH = ['401', '404', '408', '409', '419', '4111', '418', '461', '462'];
// Conturi care se detaliaza pe o eticheta libera (banca, angajat, casierie etc.)
const TAG_SYNTH = ['5121', '5124', '5311', '5314', '542', '421', '425'];
const ANALYTIC_ACCOUNTS = [...PARTNER_SYNTH, ...TAG_SYNTH];

function partnerKey(partener, cui) {
  const nm = (partener || '').toUpperCase().trim();
  if (nm) return nm;
  if (cui) return 'CUI:' + String(cui).replace(/^ro/i, '').replace(/\s/g, '');
  return '(fara partener)';
}

/** Cheia analitica pentru un cont: partenerul (conturi de terti) sau eticheta libera. */
function dimKey(cont, ctx) {
  if (PARTNER_SYNTH.includes(cont)) return partnerKey(ctx.partener, ctx.cui);
  return (ctx.analitic || '(nealocat)').toUpperCase().trim() || '(nealocat)';
}
function dimName(cont, ctx) {
  if (PARTNER_SYNTH.includes(cont)) return ctx.partener || dimKey(cont, ctx);
  return ctx.analitic || '(nealocat)';
}

/** Balanta analitica (parteneri + etichete), cu solduri initiale. */
function analyticBalance(db) {
  const map = new Map(); // synth -> Map(key -> {den, cui, siNet, rd, rc})
  const ensure = (synth, key, den, cui) => {
    if (!map.has(synth)) map.set(synth, new Map());
    const pm = map.get(synth);
    const cur = pm.get(key) || { den: den || key, cui: cui || '', siNet: 0, rd: 0, rc: 0 };
    if (den && (!/[a-z]/i.test(cur.den) || cur.den === key)) cur.den = den;
    if (!cur.cui && cui) cur.cui = cui;
    pm.set(key, cur);
    return cur;
  };

  // solduri initiale analitice (campul "partener" tine si eticheta pentru conturile non-partener)
  for (const o of (db.openingAnalytic || [])) {
    if (!ANALYTIC_ACCOUNTS.includes(o.cont)) continue;
    const ctx = { partener: o.partener, cui: o.cui, analitic: o.partener };
    const rec = ensure(o.cont, dimKey(o.cont, ctx), dimName(o.cont, ctx), o.cui);
    rec.siNet = round2(rec.siNet + (Number(o.d) || 0) - (Number(o.c) || 0));
  }

  // rulaje din inregistrari
  for (const e of postedEntries(db)) {
    const ctx = { partener: e.partener, cui: e.partenerCui, analitic: e.analitic };
    for (const l of e.lines) {
      if (ANALYTIC_ACCOUNTS.includes(l.debit)) { const r = ensure(l.debit, dimKey(l.debit, ctx), dimName(l.debit, ctx), e.partenerCui); r.rd = round2(r.rd + l.suma); }
      if (ANALYTIC_ACCOUNTS.includes(l.credit)) { const r = ensure(l.credit, dimKey(l.credit, ctx), dimName(l.credit, ctx), e.partenerCui); r.rc = round2(r.rc + l.suma); }
    }
  }

  const opening = db.openingBalances || {};
  const result = [];
  for (const synth of ANALYTIC_ACCOUNTS) {
    const pm = map.get(synth);
    if (!pm) continue;
    const parts = [...pm.values()].sort((a, b) => a.den.localeCompare(b.den));
    let tSiD = 0; let tSiC = 0; let tRd = 0; let tRc = 0; let tSfD = 0; let tSfC = 0; let siNetSum = 0;
    const rows = parts.map((p, i) => {
      const sfNet = round2(p.siNet + p.rd - p.rc);
      siNetSum = round2(siNetSum + p.siNet);
      tRd = round2(tRd + p.rd); tRc = round2(tRc + p.rc);
      const siD = p.siNet > 0 ? p.siNet : 0; const siC = p.siNet < 0 ? -p.siNet : 0;
      const sfD = sfNet > 0 ? sfNet : 0; const sfC = sfNet < 0 ? -sfNet : 0;
      tSiD = round2(tSiD + siD); tSiC = round2(tSiC + siC); tSfD = round2(tSfD + sfD); tSfC = round2(tSfC + sfC);
      return { analitic: synth + '.' + String(i + 1).padStart(2, '0'), den: p.den, cui: p.cui, siD, siC, rd: p.rd, rc: p.rc, sfD, sfC };
    });
    const op = opening[synth] || { d: 0, c: 0 };
    const synthOpeningNet = round2((op.d || 0) - (op.c || 0));
    const concorda = synthOpeningNet === round2(siNetSum);
    result.push({
      synth, nume: coa.accountName(synth), kind: PARTNER_SYNTH.includes(synth) ? 'partener' : 'eticheta', rows,
      totalSiD: tSiD, totalSiC: tSiC, totalRd: tRd, totalRc: tRc, totalSfD: tSfD, totalSfC: tSfC,
      synthOpeningNet, concorda,
    });
  }
  return result;
}

// Conturi de creante (clienti/debitori) si de datorii (furnizori/creditori)
const CREANTE = ['4111', '418', '461'];
const DATORII = ['401', '404', '408', '419', '462'];

/** Situatia creantelor si datoriilor (scadentar): solduri restante per partener. */
function receivablesPayables(db) {
  const sections = analyticBalance(db);
  const clienti = []; const furnizori = [];
  for (const s of sections) {
    if (CREANTE.includes(s.synth)) {
      for (const r of s.rows) if (r.sfD > 0) clienti.push({ synth: s.synth, nume: s.nume, partener: r.den, cui: r.cui, sold: r.sfD });
    } else if (DATORII.includes(s.synth)) {
      for (const r of s.rows) if (r.sfC > 0) furnizori.push({ synth: s.synth, nume: s.nume, partener: r.den, cui: r.cui, sold: r.sfC });
    }
  }
  clienti.sort((a, b) => b.sold - a.sold);
  furnizori.sort((a, b) => b.sold - a.sold);
  return {
    clienti, furnizori,
    totalClienti: round2(clienti.reduce((t, x) => t + x.sold, 0)),
    totalFurnizori: round2(furnizori.reduce((t, x) => t + x.sold, 0)),
  };
}

/**
 * Vechimea soldurilor (aging) per partener, prin stingere FIFO a facturilor cu platile
 * (cele mai vechi facturi se sting primele). Buckets: 0-30, 31-60, 61-90, >90 zile.
 */
function aging(db, asOf) {
  const ref = asOf ? new Date(String(asOf).length === 7 ? asOf + '-28' : asOf) : new Date();

  function build(accounts, chargeOnDebit) {
    const map = new Map();
    const ensure = (key, den, cui) => {
      if (!map.has(key)) map.set(key, { partener: den || key, cui: cui || '', charges: [], paid: 0 });
      const r = map.get(key);
      if (den && (r.partener === key || !/[a-z]/i.test(r.partener))) r.partener = den;
      if (!r.cui && cui) r.cui = cui;
      return r;
    };
    // solduri initiale analitice (fara data) -> factura cea mai veche
    for (const o of (db.openingAnalytic || [])) {
      if (!accounts.includes(o.cont)) continue;
      const r = ensure(partnerKey(o.partener, o.cui), o.partener, o.cui);
      const net = chargeOnDebit ? (Number(o.d) || 0) - (Number(o.c) || 0) : (Number(o.c) || 0) - (Number(o.d) || 0);
      if (net > 0) r.charges.push({ date: '1900-01-01', amount: round2(net) });
      else if (net < 0) r.paid = round2(r.paid - net);
    }
    for (const e of postedEntries(db)) {
      const key = partnerKey(e.partener, e.partenerCui);
      for (const l of e.lines) {
        const onDebit = accounts.includes(l.debit);
        const onCredit = accounts.includes(l.credit);
        if (!onDebit && !onCredit) continue;
        const r = ensure(key, e.partener, e.partenerCui);
        const isCharge = chargeOnDebit ? onDebit : onCredit;
        if (isCharge) r.charges.push({ date: e.data, amount: round2(l.suma) });
        else r.paid = round2(r.paid + l.suma);
      }
    }
    const out = [];
    for (const r of map.values()) {
      r.charges.sort((a, b) => (a.date < b.date ? -1 : 1));
      let paid = r.paid;
      const b = { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
      let total = 0;
      for (const c of r.charges) {
        let open = c.amount;
        if (paid > 0) { const used = Math.min(paid, open); open = round2(open - used); paid = round2(paid - used); }
        if (open <= 0) continue;
        const age = Math.floor((ref - new Date(c.date)) / 86400000);
        const k = age <= 30 ? 'b0_30' : age <= 60 ? 'b31_60' : age <= 90 ? 'b61_90' : 'b90plus';
        b[k] = round2(b[k] + open);
        total = round2(total + open);
      }
      if (total > 0.005) out.push({ partener: r.partener, cui: r.cui, total, ...b });
    }
    return out.sort((a, b) => b.total - a.total);
  }

  const clienti = build(['4111', '418', '461'], true);
  const furnizori = build(['401', '404', '408', '419', '462'], false);
  const sum = (list) => {
    const t = { total: 0, b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
    for (const x of list) for (const k of Object.keys(t)) t[k] = round2(t[k] + x[k]);
    return t;
  };
  return { asOf: ref.toISOString().slice(0, 10), clienti, furnizori, totalClienti: sum(clienti), totalFurnizori: sum(furnizori) };
}

module.exports = { analyticBalance, receivablesPayables, aging, PARTNER_SYNTH, TAG_SYNTH, ANALYTIC_ACCOUNTS, partnerKey };
