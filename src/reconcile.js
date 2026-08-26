'use strict';

const { round2 } = require('./util');
const { sortEntries, postedEntries } = require('./accounting');
const { settle } = require('./matching');
const { CONTURI_CREANTE, CONTURI_DATORII } = require('./analytic');
const openItems = require('./openItems');

// Perimetrul vine din analytic.js, ca fisele de partener si vechimea soldurilor (aging) sa
// acopere prin constructie aceleasi conturi. Inainte erau doar 4111 si 401, deci o factura de
// imobilizari (404), una nesosita (408) sau un avans de la client (419) lipsea din scadentar,
// desi aparea in aging — a doua cifra pentru acelasi lucru.
const PARTNER_ACCOUNTS = [...CONTURI_CREANTE, ...CONTURI_DATORII];
const esteCreanta = (cont) => CONTURI_CREANTE.includes(cont);

/**
 * Fise de partener pe conturile 4111 (clienti) si 401 (furnizori), cu potrivirea
 * automata factura <-> plata/incasare de aceeasi suma.
 */
function reconcile(db) {
  const central = openItems.registry(db, null);
  const explicitByPayment = new Map();
  for (const a of central.allocations.filter((x) => x.source === 'manual' || x.source === 'legacy-link')) {
    const k = String(a.paymentId); const list = explicitByPayment.get(k) || [];
    if (!list.includes(String(a.documentId))) list.push(String(a.documentId));
    explicitByPayment.set(k, list);
  }
  const groups = new Map();
  const keyOf = (partener, cui) => (partener || cui || '').toUpperCase().trim();
  // Soldurile initiale pe partener (preluarea de la contabilitatea anterioara) sunt tot creante
  // si datorii deschise. Erau IGNORATE aici, desi analytic.aging() le citeste — de unde doua cifre
  // diferite pentru acelasi lucru pe acelasi ecran: „De platit catre furnizori 0" langa
  // „Datorii de platit 15.000". Nu era doar o nepotrivire de afisare: soldul iesea mai mic cu
  // exact preluarea, si in scadentar, si in previziunea de cash-flow.
  // N-au document sau data, deci intra ca cel mai VECHI element (se sting primele, FIFO) —
  // aceeasi conventie ca in analytic.aging().
  for (const o of (db.openingAnalytic || [])) {
    if (!PARTNER_ACCOUNTS.includes(o.cont)) continue;
    const key = keyOf(o.partener, o.cui); if (!key) continue;
    const d = round2(Number(o.d) || 0); const c = round2(Number(o.c) || 0);
    if (!d && !c) continue;
    const gkey = key + '|' + o.cont;
    const g = groups.get(gkey) || { key, cont: o.cont, den: o.partener || key, cui: o.cui || '', items: [] };
    if (!g.cui && o.cui) g.cui = o.cui;
    // `soldInitial` scoate randul din punctajul MANUAL din interfata: n-are articol contabil in
    // spate, deci n-ar avea ce lega (ruta /api/reconcile/link l-ar respinge oricum cu 404).
    g.items.push({ entryId: 'sold-initial|' + gkey, data: '1900-01-01', doc: 'Sold inițial preluat',
      tipNume: 'Sold inițial preluat', debit: d, credit: c, matched: false, stinge: null, soldInitial: true });
    groups.set(gkey, g);
  }
  // Doar articolele POSTATE: o ciorna nu e inca o creanta/datorie reala. aging() filtra deja
  // (postedEntries), scadentarul nu — a doua sursa de divergenta intre aceleasi doua cifre.
  for (const e of sortEntries(postedEntries(db))) {
    const key = keyOf(e.partener, e.partenerCui);
    if (!key) continue;
    // efectul net al intregului articol pe fiecare cont de partener (factura = un singur rand)
    for (const cont of PARTNER_ACCOUNTS) {
      let d = 0; let c = 0;
      for (const l of e.lines) {
        if (l.debit === cont) d = round2(d + l.suma);
        if (l.credit === cont) c = round2(c + l.suma);
      }
      if (d === 0 && c === 0) continue;
      const gkey = key + '|' + cont;
      const g = groups.get(gkey) || { key, cont, den: e.partener || key, cui: e.partenerCui || '', items: [] };
      if (!g.cui && e.partenerCui) g.cui = e.partenerCui;
      g.items.push({ entryId: e.id, data: e.data, doc: e.document || '', tipNume: e.tipNume,
        debit: round2(d), credit: round2(c), matched: false,
        stinge: explicitByPayment.get(String(e.id)) || e.stinge });
      groups.set(gkey, g);
    }
  }

  const result = [];
  for (const g of groups.values()) {
    // factura = creste creanta/datoria; decontare = o stinge. Sensul se deduce din CONT
    // (creanta -> debit, datorie -> credit); regula era scrisa ca `cont === '4111'`, deci orice
    // alt cont de creanta (418, 461) ar fi fost citit invers, ca datorie.
    const creanta = esteCreanta(g.cont);
    const isInvoice = (it) => (creanta ? it.debit > 0 : it.credit > 0);
    const amount = (it) => round2(it.debit || it.credit);
    const mk = (it) => ({ id: it.entryId, doc: it.doc, data: it.data, suma: amount(it), stinge: it.stinge });
    const invoices = g.items.filter(isInvoice).map(mk);
    const payments = g.items.filter((it) => !isInvoice(it)).map(mk);
    // potrivire graduala (exacta -> agregata -> partiala); soldurile raman sume, neafectate de potrivire
    const s = settle(invoices, payments);
    // marcheaza pe items (folosit de UI): "potrivit" = stins complet; deschis/avans = are rest
    const openIds = new Set([...s.deschise, ...s.avansuri].map((x) => x.id));
    for (const it of g.items) it.matched = !openIds.has(it.entryId);
    const facturat = round2(invoices.reduce((a, iv) => a + iv.suma, 0));
    const decontat = round2(payments.reduce((a, p) => a + p.suma, 0));
    const sold = round2(facturat - decontat);
    result.push({
      // `sens` calculat AICI si trimis mai departe: aceeasi regula era rescrisa in monthlyClose.js,
      // bank.js si public/livrabile.js, fiecare cu acelasi `cont === '4111'` de reparat.
      key: g.key, cont: g.cont, sens: creanta ? 'creanta' : 'datorie', den: g.den, cui: g.cui,
      facturat, decontat, sold,
      potriviri: s.perechi.length,
      nepotrivite: s.deschise.length + s.avansuri.length,
      items: g.items,
      perechi: s.perechi,
      deschise: s.deschise,
      avansuri: s.avansuri,
    });
  }
  result.sort((a, b) => Math.abs(b.sold) - Math.abs(a.sold) || a.den.localeCompare(b.den));
  // Totalurile NU compenseaza intre parteneri: o creanta la A nu scade ce datorezi lui B — sunt
  // drepturi distincte, iar compensarea e un act explicit (vezi compensablePartners mai jos, care
  // o propune doar pe acelasi partener, pe ambele sensuri). Deci soldul fiecarui partener intra
  // cu podea la zero, ca in analytic.aging(); soldul PER PARTENER ramane cu semn (un avans
  // trebuie sa se vada ca avans in fisa).
  const totalPe = (sens) => round2(result.filter((r) => r.sens === sens).reduce((s, r) => s + Math.max(r.sold, 0), 0));
  const totalClienti = totalPe('creanta');
  const totalFurnizori = totalPe('datorie');
  return { partners: result, totalClienti, totalFurnizori };
}

/** Parteneri care sunt simultan debitori si creditori. Pe langa total, pastram conturile reale:
 * nota de compensare trebuie sa stinga 404/408/418/419/461/462 la fel de fidel ca 401/4111. */
function compensablePartners(db) {
  const rc = reconcile(db);
  const byKey = {};
  for (const p of rc.partners) {
    const key = p.cui || p.den;
    if (!key) continue;
    byKey[key] = byKey[key] || { cui: p.cui || '', den: p.den || key, creanteConturi: [], datoriiConturi: [] };
    if (p.den && /[a-z]/i.test(p.den)) byKey[key].den = p.den;
    if (p.sens === 'creanta' && p.sold > 0) {
      byKey[key].creanta = round2((byKey[key].creanta || 0) + p.sold);
      byKey[key].creanteConturi.push({ cont: p.cont, suma: round2(p.sold) });
    }
    if (p.sens === 'datorie' && p.sold > 0) {
      byKey[key].datorie = round2((byKey[key].datorie || 0) + p.sold);
      byKey[key].datoriiConturi.push({ cont: p.cont, suma: round2(p.sold) });
    }
  }
  const out = [];
  for (const k of Object.keys(byKey)) {
    const b = byKey[k];
    if ((b.creanta || 0) > 0 && (b.datorie || 0) > 0) {
      b.creanteConturi.sort((a, z) => a.cont.localeCompare(z.cont));
      b.datoriiConturi.sort((a, z) => a.cont.localeCompare(z.cont));
      out.push({ cui: b.cui, den: b.den, creanta: round2(b.creanta), datorie: round2(b.datorie),
        compensabil: round2(Math.min(b.creanta, b.datorie)),
        creanteConturi: b.creanteConturi, datoriiConturi: b.datoriiConturi });
    }
  }
  return out.sort((a, b) => b.compensabil - a.compensabil);
}

/** Aloca suma solicitata intre conturile reale, fara sa inventeze sold in 401/4111. */
function compensationLines(candidate, amount) {
  let ramas = round2(Number(amount));
  const creante = ((candidate && candidate.creanteConturi) || []).map((x) => ({ cont: x.cont, suma: round2(x.suma) }));
  const datorii = ((candidate && candidate.datoriiConturi) || []).map((x) => ({ cont: x.cont, suma: round2(x.suma) }));
  const lines = [];
  for (const datorie of datorii) {
    for (const creanta of creante) {
      if (!(ramas > 0) || !(datorie.suma > 0) || !(creanta.suma > 0)) continue;
      const suma = round2(Math.min(ramas, datorie.suma, creanta.suma));
      if (!(suma > 0)) continue;
      lines.push({ debit: datorie.cont, credit: creanta.cont, suma });
      datorie.suma = round2(datorie.suma - suma);
      creanta.suma = round2(creanta.suma - suma);
      ramas = round2(ramas - suma);
    }
  }
  return { lines, ramas };
}

module.exports = { reconcile, compensablePartners, compensationLines, PARTNER_ACCOUNTS };
