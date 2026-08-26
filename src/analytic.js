'use strict';

const { round2 } = require('./util');
const coa = require('./chartOfAccounts');
const { postedEntries } = require('./accounting'); // registrele analitice numara doar articole postate
const openItems = require('./openItems');

// Conturile de CREANTE si de DATORII pe partener — SURSA UNICA a perimetrului. Le folosesc si
// vechimea soldurilor (aging, mai jos), si fisele de partener (reconcile.js). Cat timp fiecare
// avea lista lui, acelasi lucru iesea cu doua cifre pe acelasi ecran: „De platit catre furnizori"
// citea doar 401, iar „Datorii de platit" citea tot perimetrul.
// SENSUL: la creante soldul creste pe DEBIT (factura emisa), la datorii pe CREDIT (factura primita).
// 419 (avansuri incasate de la clienti) sta la datorii desi contrapartea e un client: e o obligatie.
// 409 (avansuri plătite furnizorilor) este creanță, iar 419 (avansuri încasate de la clienți)
// este datorie. Efectele comerciale și clienții incerți rămân în același registru prin reclasificări.
const CONTURI_CREANTE = openItems.CONTURI_CREANTE;
const CONTURI_DATORII = openItems.CONTURI_DATORII;

// Conturi care se detaliaza pe partener (dimensiunea = partenerul)
const PARTNER_SYNTH = [...new Set([...CONTURI_CREANTE, ...CONTURI_DATORII])];
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

/** Situatia creantelor si datoriilor (scadentar): solduri restante per partener. */
function receivablesPayables(db) {
  const reg = openItems.registry(db, null);
  const grouped = (sens) => {
    const by = new Map();
    for (const d of reg.openDocuments.filter((x) => x.sens === sens)) {
      const key = d.account + '|' + d.partnerKey;
      const r = by.get(key) || { synth: d.account, nume: coa.accountName(d.account), partener: d.partener, cui: d.cui, sold: 0, documents: [] };
      r.sold = round2(r.sold + d.residual); r.documents.push(d); by.set(key, r);
    }
    return [...by.values()].sort((a, b) => b.sold - a.sold);
  };
  const clienti = grouped('creanta'); const furnizori = grouped('datorie');
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
  const a = openItems.groupedAging(db, asOf);
  return { asOf: a.asOf, clienti: a.clienti, furnizori: a.furnizori,
    totalClienti: a.totalClienti, totalFurnizori: a.totalFurnizori, registry: a.registry };
}

module.exports = { analyticBalance, receivablesPayables, aging, PARTNER_SYNTH, TAG_SYNTH, ANALYTIC_ACCOUNTS, partnerKey, CONTURI_CREANTE, CONTURI_DATORII };
