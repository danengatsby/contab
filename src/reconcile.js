'use strict';

const { round2, period: periodOf } = require('./util');
const { sortEntries } = require('./accounting');
const { settle } = require('./matching');

const PARTNER_ACCOUNTS = ['4111', '401'];

/**
 * Fise de partener pe conturile 4111 (clienti) si 401 (furnizori), cu potrivirea
 * automata factura <-> plata/incasare de aceeasi suma.
 */
function reconcile(db) {
  const groups = new Map();
  for (const e of sortEntries(db.entries)) {
    const key = (e.partener || e.partenerCui || '').toUpperCase().trim();
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
      g.items.push({ entryId: e.id, data: e.data, doc: e.document || '', tipNume: e.tipNume, debit: round2(d), credit: round2(c), matched: false, stinge: e.stinge });
      groups.set(gkey, g);
    }
  }

  const result = [];
  for (const g of groups.values()) {
    // factura = creste creanta/datoria; decontare = o stinge
    const isInvoice = (it) => (g.cont === '4111' ? it.debit > 0 : it.credit > 0);
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
      key: g.key, cont: g.cont, den: g.den, cui: g.cui,
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
  const totalClienti = round2(result.filter((r) => r.cont === '4111').reduce((s, r) => s + r.sold, 0));
  const totalFurnizori = round2(result.filter((r) => r.cont === '401').reduce((s, r) => s + r.sold, 0));
  return { partners: result, totalClienti, totalFurnizori };
}

/**
 * Parteneri care sunt si client, si furnizor (au sold debitor pe 4111 SI sold creditor pe 401):
 * suma compensabila = minimul celor doua. Compensarea se inregistreaza prin 401 = 4111.
 */
function compensablePartners(db) {
  const rc = reconcile(db);
  const byKey = {};
  for (const p of rc.partners) {
    const key = p.cui || p.den;
    if (!key) continue;
    byKey[key] = byKey[key] || { cui: p.cui || '', den: p.den || key };
    if (p.den && /[a-z]/i.test(p.den)) byKey[key].den = p.den;
    if (p.cont === '4111' && p.sold > 0) byKey[key].creanta = round2((byKey[key].creanta || 0) + p.sold);
    if (p.cont === '401' && p.sold > 0) byKey[key].datorie = round2((byKey[key].datorie || 0) + p.sold);
  }
  const out = [];
  for (const k of Object.keys(byKey)) {
    const b = byKey[k];
    if ((b.creanta || 0) > 0 && (b.datorie || 0) > 0) {
      out.push({ cui: b.cui, den: b.den, creanta: round2(b.creanta), datorie: round2(b.datorie), compensabil: round2(Math.min(b.creanta, b.datorie)) });
    }
  }
  return out.sort((a, b) => b.compensabil - a.compensabil);
}

module.exports = { reconcile, compensablePartners, PARTNER_ACCOUNTS };
