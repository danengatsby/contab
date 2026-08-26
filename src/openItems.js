'use strict';

// Registrul central al documentelor deschise (open-item accounting).
//
// Sursa primara ramane jurnalul POSTAT. Registrul nu memoreaza un al doilea „sold” care poate
// ramane in urma: documentele, platile, soldul rezidual, scadenta si aging-ul se proiecteaza la
// data ceruta din articole + alocarile explicite. Persistam numai faptele care nu pot fi deduse:
// metadatele creantei pe articol (`entry.openItem`) si alocarile document-cu-document
// (`openItemAllocations`, append-only la inlocuire/revocare).

const acc = require('./accounting');
const { round2, validIsoDate, validPeriod, naturalCompare } = require('./util');

// Întreg perimetrul comercial/pe partener din planul de conturi al aplicației. Avansurile sunt
// clasificate după natura soldului (409 = creanță față de furnizor, 419 = datorie față de client).
const CONTURI_CREANTE = ['409', '4111', '4118', '413', '418', '461'];
const CONTURI_DATORII = ['401', '403', '404', '405', '408', '419', '462'];
const TOL = 0.005;

function cuiKey(value) { return String(value || '').replace(/^ro/i, '').replace(/\s/g, '').toUpperCase(); }
function nameKey(value) { return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase(); }
function partnerKey(partener, cui) { return cuiKey(cui) ? 'CUI:' + cuiKey(cui) : (nameKey(partener) || '(FARA PARTENER)'); }

function dateUtc(iso) {
  const p = String(iso || '').split('-').map(Number);
  return new Date(Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1));
}
function addDays(iso, days) {
  const d = dateUtc(iso); d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function lastDay(period) {
  const p = String(period || '').split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1], 0)).toISOString().slice(0, 10);
}
function refDate(asOf) {
  if (!asOf) return new Date().toISOString().slice(0, 10);
  if (validPeriod(String(asOf))) return lastDay(String(asOf));
  if (validIsoDate(String(asOf))) return String(asOf);
  const e = new Error('Data registrului trebuie sa fie YYYY-MM sau o data calendaristica reala YYYY-MM-DD.');
  e.status = 400; throw e;
}
function daysBetween(from, to) { return Math.floor((dateUtc(to) - dateUtc(from)) / 86400000); }

function metaOf(entry) {
  const m = (entry && entry.openItem && typeof entry.openItem === 'object') ? entry.openItem : {};
  const term = Number(m.contractualTermDays != null ? m.contractualTermDays : entry && entry.contractualTermDays);
  let due = m.dueDate || (entry && (entry.dueDate || entry.scadenta)) || '';
  let source = due ? (m.dueSource || 'document') : '';
  if (!due && Number.isInteger(term) && term >= 0 && entry && validIsoDate(entry.data)) {
    due = addDays(entry.data, term); source = 'contract';
  }
  if (!validIsoDate(String(due))) { due = entry && validIsoDate(entry.data) ? entry.data : '1900-01-01'; source = 'fallback-document'; }
  const tri = (v) => (v === true ? true : v === false ? false : null);
  const probability = Number(m.collectionProbability);
  const delay = Number(m.forecastDelayDays);
  return {
    dueDate: String(due), dueSource: source, dueKnown: source !== 'fallback-document',
    contractualTermDays: Number.isInteger(term) && term >= 0 ? term : null,
    dispute: tri(m.dispute), disputeSince: validIsoDate(String(m.disputeSince || '')) ? m.disputeSince : null,
    disputeReference: String(m.disputeReference || '').slice(0, 200),
    affiliated: tri(m.affiliated), guaranteed: tri(m.guaranteed),
    guaranteeDetails: String(m.guaranteeDetails || '').slice(0, 300),
    collectionProbability: Number.isFinite(probability) && probability >= 0 && probability <= 100 ? probability : null,
    forecastDelayDays: Number.isInteger(delay) && delay >= 0 && delay <= 365 ? delay : 0,
  };
}

function effect(entry, accounts, chargeOnDebit) {
  const by = new Map();
  for (const l of (entry.lines || [])) {
    const q = round2(Number(l.suma) || 0);
    if (accounts.includes(String(l.debit))) by.set(String(l.debit), round2((by.get(String(l.debit)) || 0) + (chargeOnDebit ? q : -q)));
    if (accounts.includes(String(l.credit))) by.set(String(l.credit), round2((by.get(String(l.credit)) || 0) + (chargeOnDebit ? -q : q)));
  }
  const rows = [...by].filter(([, value]) => Math.abs(value) > TOL).map(([account, value]) => ({ account, value }));
  const total = round2(rows.reduce((s, x) => s + x.value, 0));
  const account = (rows.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0] || {}).account || accounts[0];
  return { total, account, rows };
}

function rawItems(view, asOf) {
  const ref = refDate(asOf); const documents = []; const payments = []; const transfers = [];
  // Articolele de plata introduse manual au adesea doar denumirea, desi factura are si CUI.
  // Construim aliasul NUME -> CUI numai cand este neambiguu in firma; altfel raman separate.
  const aliasSets = new Map();
  for (const x of [...(view.openingAnalytic || []), ...acc.postedEntries(view)]) {
    const n = nameKey(x.partener); const c = cuiKey(x.cui || x.partenerCui);
    if (n && c) { if (!aliasSets.has(n)) aliasSets.set(n, new Set()); aliasSets.get(n).add(c); }
  }
  const keyOf = (partener, cui) => {
    const c = cuiKey(cui); if (c) return 'CUI:' + c;
    const set = aliasSets.get(nameKey(partener));
    return set && set.size === 1 ? 'CUI:' + [...set][0] : partnerKey(partener, cui);
  };
  const addOpening = (o, sens, accounts, chargeOnDebit) => {
    const inc = chargeOnDebit ? round2((Number(o.d) || 0) - (Number(o.c) || 0)) : round2((Number(o.c) || 0) - (Number(o.d) || 0));
    if (Math.abs(inc) <= TOL) return;
    const base = { id: 'sold-initial|' + sens + '|' + o.cont + '|' + keyOf(o.partener, o.cui), entryId: null,
      opening: true, sens, account: o.cont, partnerKey: keyOf(o.partener, o.cui), partener: o.partener || '(fara partener)',
      cui: o.cui || '', document: 'Sold initial preluat', data: '1900-01-01', dueDate: '1900-01-01',
      dueSource: 'fallback-document', dueKnown: false, contractualTermDays: null,
      dispute: null, disputeSince: null, disputeReference: '', affiliated: null, guaranteed: null, guaranteeDetails: '' };
    if (inc > 0) documents.push(Object.assign(base, { gross: inc }));
    else payments.push(Object.assign(base, { amount: round2(-inc), stinge: [] }));
  };
  for (const o of (view.openingAnalytic || [])) {
    if (CONTURI_CREANTE.includes(o.cont)) addOpening(o, 'creanta', CONTURI_CREANTE, true);
    if (CONTURI_DATORII.includes(o.cont)) addOpening(o, 'datorie', CONTURI_DATORII, false);
  }
  const entries = acc.sortEntries(acc.postedEntries(view).filter((e) => String(e.data || '') <= ref));
  for (const e of entries) {
    for (const cfg of [
      { sens: 'creanta', accounts: CONTURI_CREANTE, chargeOnDebit: true },
      { sens: 'datorie', accounts: CONTURI_DATORII, chargeOnDebit: false },
    ]) {
      const ef = effect(e, cfg.accounts, cfg.chargeOnDebit);
      if (Math.abs(ef.total) <= TOL) {
        if (ef.rows.length) transfers.push({ entryId: e.id, data: e.data, sens: cfg.sens, partnerKey: keyOf(e.partener, e.partenerCui), rows: ef.rows });
        continue; // mutare 418=4111 / 408=401: nu este nici factura noua, nici plata
      }
      const common = { id: String(e.id), entryId: e.id, opening: false, sens: cfg.sens, account: ef.account,
        accountEffects: ef.rows, partnerKey: keyOf(e.partener, e.partenerCui), partener: e.partener || '(fara partener)',
        cui: e.partenerCui || '', document: e.document || '', data: e.data, tipNume: e.tipNume || e.tip || '',
        metadataHistoryCount: Array.isArray(e.openItemHistory) ? e.openItemHistory.length : 0 };
      if (ef.total > 0) documents.push(Object.assign(common, metaOf(e), { gross: ef.total }));
      else payments.push(Object.assign(common, { amount: round2(-ef.total), stinge: Array.isArray(e.stinge) ? e.stinge.map(String) : [] }));
    }
  }
  return { asOf: ref, documents, payments, transfers };
}

function applyAllocation(doc, pay, amount, source, rec, out) {
  const q = round2(Math.min(Number(amount) || 0, doc.residual, pay.unallocated));
  if (!(q > TOL)) return 0;
  doc.residual = round2(doc.residual - q); pay.unallocated = round2(pay.unallocated - q);
  const a = { id: rec && rec.id || null, documentId: doc.id, paymentId: pay.id, amount: q,
    source, allocationDate: (rec && rec.allocationDate) || pay.data, createdAt: rec && rec.createdAt || null };
  doc.allocations.push(a); pay.allocations.push(a); out.push(a); return q;
}

function registry(view, asOf) {
  const raw = rawItems(view, asOf);
  const documents = raw.documents.map((d) => Object.assign({}, d, { residual: round2(d.gross), allocations: [] }));
  const payments = raw.payments.map((p) => Object.assign({}, p, { unallocated: round2(p.amount), allocations: [] }));
  const byDoc = new Map(documents.map((d) => [String(d.id), d]));
  const byPay = new Map(payments.map((p) => [String(p.id), p]));
  const allocations = []; const problems = [];

  // 1. Alocari explicite cu SUMA, append-only. Au prioritate fata de legaturile legacy/FIFO.
  const manual = (view.openItemAllocations || []).filter((a) => a.active !== false && String(a.allocationDate || raw.asOf) <= raw.asOf)
    .slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || naturalCompare(a.id, b.id));
  for (const a of manual) {
    const doc = byDoc.get(String(a.documentId)); const pay = byPay.get(String(a.paymentId));
    if (!doc || !pay) { problems.push({ code: 'allocation-orphan', allocationId: a.id, message: 'Alocare cu document sau plata inexistenta la data de referinta.' }); continue; }
    if (doc.sens !== pay.sens || doc.partnerKey !== pay.partnerKey) {
      problems.push({ code: 'allocation-cross-partner', allocationId: a.id, message: 'Alocare intre sensuri sau parteneri diferiti.' }); continue;
    }
    const asked = round2(Number(a.amount) || 0); const used = applyAllocation(doc, pay, asked, 'manual', a, allocations);
    if (Math.abs(asked - used) > TOL) problems.push({ code: 'allocation-overflow', allocationId: a.id, message: 'Alocarea depaseste soldul rezidual al documentului sau al platii.', asked, used });
  }
  // 2. Legaturi explicite istorice (`payment.stinge`), pentru compatibilitate.
  for (const pay of payments) for (const id of pay.stinge || []) {
    const doc = byDoc.get(String(id));
    if (doc && doc.sens === pay.sens && doc.partnerKey === pay.partnerKey) applyAllocation(doc, pay, pay.unallocated, 'legacy-link', null, allocations);
  }
  // 3. Restul se stinge FIFO dupa SCADENTA, apoi data documentului. Este determinist si explicabil.
  const groups = new Map();
  for (const d of documents) { const k = d.sens + '|' + d.partnerKey; if (!groups.has(k)) groups.set(k, { docs: [], pays: [] }); groups.get(k).docs.push(d); }
  for (const p of payments) { const k = p.sens + '|' + p.partnerKey; if (!groups.has(k)) groups.set(k, { docs: [], pays: [] }); groups.get(k).pays.push(p); }
  for (const g of groups.values()) {
    g.docs.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.data.localeCompare(b.data) || naturalCompare(a.id, b.id));
    g.pays.sort((a, b) => a.data.localeCompare(b.data) || naturalCompare(a.id, b.id));
    for (const pay of g.pays) for (const doc of g.docs) {
      if (pay.unallocated <= TOL) break;
      if (doc.residual > TOL) applyAllocation(doc, pay, pay.unallocated, 'fifo', null, allocations);
    }
  }

  for (const d of documents) {
    d.overdueDays = Math.max(0, daysBetween(d.dueDate, raw.asOf));
    d.daysToDue = Math.max(0, daysBetween(raw.asOf, d.dueDate));
    d.status = d.residual > TOL ? (d.dueDate > raw.asOf ? 'nescadent' : 'restant') : 'stins';
    d.termClass = addDays(raw.asOf, 365) < d.dueDate ? 'peste1an' : 'sub1an';
  }
  const openDocuments = documents.filter((d) => d.residual > TOL);
  const openPayments = payments.filter((p) => p.unallocated > TOL);
  const sum = (rows, field) => round2(rows.reduce((s, x) => s + (Number(x[field]) || 0), 0));
  const totals = {
    receivables: sum(openDocuments.filter((d) => d.sens === 'creanta'), 'residual'),
    payables: sum(openDocuments.filter((d) => d.sens === 'datorie'), 'residual'),
    customerAdvances: sum(openPayments.filter((p) => p.sens === 'creanta'), 'unallocated'),
    supplierAdvances: sum(openPayments.filter((p) => p.sens === 'datorie'), 'unallocated'),
  };
  return { asOf: raw.asOf, documents, openDocuments, payments, openPayments, allocations, transfers: raw.transfers, problems, totals };
}

function groupedAging(view, asOf) {
  const reg = registry(view, asOf);
  function side(sens) {
    const by = new Map();
    for (const d of reg.openDocuments.filter((x) => x.sens === sens)) {
      const r = by.get(d.partnerKey) || { partener: d.partener, cui: d.cui, total: 0, nescadent: 0,
        b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0, b270plus: 0, dueDateMissing: 0, documents: [] };
      r.total = round2(r.total + d.residual); r.documents.push(d);
      if (!d.dueKnown) r.dueDateMissing = round2(r.dueDateMissing + d.residual);
      if (d.dueDate > reg.asOf) r.nescadent = round2(r.nescadent + d.residual);
      else if (d.overdueDays <= 30) r.b0_30 = round2(r.b0_30 + d.residual);
      else if (d.overdueDays <= 60) r.b31_60 = round2(r.b31_60 + d.residual);
      else if (d.overdueDays <= 90) r.b61_90 = round2(r.b61_90 + d.residual);
      else r.b90plus = round2(r.b90plus + d.residual);
      if (d.dueKnown && d.overdueDays > 270) r.b270plus = round2(r.b270plus + d.residual);
      by.set(d.partnerKey, r);
    }
    return [...by.values()].sort((a, b) => b.total - a.total);
  }
  const clienti = side('creanta'); const furnizori = side('datorie');
  const total = (rows) => {
    const t = { total: 0, nescadent: 0, b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0, b270plus: 0, dueDateMissing: 0 };
    for (const r of rows) for (const k of Object.keys(t)) t[k] = round2(t[k] + (Number(r[k]) || 0));
    return t;
  };
  return { asOf: reg.asOf, clienti, furnizori, totalClienti: total(clienti), totalFurnizori: total(furnizori), registry: reg };
}

function ledgerReconciliation(view, asOf) {
  const reg = registry(view, asOf); const rows = [];
  for (const cfg of [
    { sens: 'creanta', accounts: CONTURI_CREANTE, chargeOnDebit: true },
    { sens: 'datorie', accounts: CONTURI_DATORII, chargeOnDebit: false },
  ]) {
    // Cartea mare pornește din soldurile SINTETICE. Subregistrul pornește separat din soldurile
    // analitice/documentele deschise; dacă preluarea a uitat analiticul, controlul trebuie să pice.
    const gl = new Map();
    for (const account of cfg.accounts) {
      const o = (view.openingBalances || {})[account] || {};
      const value = cfg.chargeOnDebit ? (Number(o.d) || 0) - (Number(o.c) || 0) : (Number(o.c) || 0) - (Number(o.d) || 0);
      gl.set(account, round2(value));
    }
    for (const e of acc.postedEntries(view).filter((x) => String(x.data || '') <= reg.asOf)) {
      for (const x of effect(e, cfg.accounts, cfg.chargeOnDebit).rows) gl.set(x.account, round2((gl.get(x.account) || 0) + x.value));
    }

    // Soldul documentelor rămas după stingeri este ținut pe contul lui curent. Reclasificările
    // fără efect total (418=4111 / 408=401) mută numai soldul încă deschis, document-cu-document.
    const docStates = reg.openDocuments.filter((d) => d.sens === cfg.sens).map((doc) => ({
      doc, balances: new Map([[doc.account, round2(doc.residual)]]),
    }));
    const orderedDocs = (partner) => docStates.filter((x) => x.doc.partnerKey === partner)
      .sort((a, b) => a.doc.dueDate.localeCompare(b.doc.dueDate) || a.doc.data.localeCompare(b.doc.data) || naturalCompare(a.doc.id, b.doc.id));
    for (const transfer of reg.transfers.filter((t) => t.sens === cfg.sens)
      .sort((a, b) => String(a.data).localeCompare(String(b.data)) || naturalCompare(a.entryId, b.entryId))) {
      const targets = transfer.rows.filter((x) => x.value > TOL).map((x) => ({ account: x.account, left: round2(x.value) }));
      for (const source of transfer.rows.filter((x) => x.value < -TOL)) {
        let left = round2(-source.value);
        for (const state of orderedDocs(transfer.partnerKey)) {
          if (left <= TOL) break;
          let available = round2(state.balances.get(source.account) || 0);
          while (available > TOL && left > TOL) {
            const target = targets.find((x) => x.left > TOL); if (!target) break;
            const moved = round2(Math.min(available, left, target.left));
            state.balances.set(source.account, round2(available - moved));
            state.balances.set(target.account, round2((state.balances.get(target.account) || 0) + moved));
            available = round2(available - moved); left = round2(left - moved); target.left = round2(target.left - moved);
          }
        }
      }
    }

    const sub = new Map(cfg.accounts.map((account) => [account, 0]));
    for (const state of docStates) for (const [account, value] of state.balances) {
      if (cfg.accounts.includes(account)) sub.set(account, round2((sub.get(account) || 0) + value));
    }
    // O plată nealocată este avans/sold creditor în același cont și reduce soldul net analitic.
    for (const pay of reg.openPayments.filter((p) => p.sens === cfg.sens)) {
      if (cfg.accounts.includes(pay.account)) sub.set(pay.account, round2((sub.get(pay.account) || 0) - pay.unallocated));
    }
    for (const account of cfg.accounts) {
      const ledger = round2(gl.get(account) || 0); const registerBalance = round2(sub.get(account) || 0);
      rows.push({ sens: cfg.sens, account, ledger, register: registerBalance, difference: round2(registerBalance - ledger), ok: Math.abs(registerBalance - ledger) <= TOL });
    }
  }
  // Egalitatea numerica nu este suficienta daca o alocare explicita este orfana, depaseste
  // soldul sau leaga parteneri diferiti. Inainte, astfel de probleme ramaneau doar intr-un camp
  // informativ al registrului, iar cockpitul putea inchide luna cu un control aparent „verde”.
  return { asOf: reg.asOf, rows, problems: reg.problems,
    ok: rows.every((r) => r.ok) && reg.problems.length === 0,
    difference: round2(rows.reduce((s, r) => s + Math.abs(r.difference), 0)) };
}

function replaceAllocations(data, firmaId, paymentId, requested, actor, nextId) {
  const view = Object.assign({}, data, {
    entries: (data.entries || []).filter((e) => Number(e.firmaId) === Number(firmaId)),
    openingAnalytic: (data.openingAnalytic || []).filter((o) => Number(o.firmaId) === Number(firmaId)),
    openItemAllocations: (data.openItemAllocations || []).filter((a) => Number(a.firmaId) === Number(firmaId)),
  });
  const reg = registry(view, null); const pay = reg.payments.find((p) => String(p.id) === String(paymentId) && !p.opening);
  if (!pay) { const e = new Error('Articolul de decontare nu exista in registrul documentelor deschise.'); e.status = 404; throw e; }
  const list = Array.isArray(requested) ? requested : [];
  const activeOther = (data.openItemAllocations || []).filter((a) => a.active !== false && Number(a.firmaId) === Number(firmaId)
    && String(a.paymentId) !== String(paymentId));
  const normalized = []; const seenDocs = new Set(); let total = 0;
  for (const x of list) {
    const documentId = String(x.documentId || x.invoiceId || ''); const doc = reg.documents.find((d) => String(d.id) === documentId && !d.opening);
    if (!doc || doc.sens !== pay.sens || doc.partnerKey !== pay.partnerKey) { const e = new Error('Documentul ' + documentId + ' nu apartine aceluiasi partener si aceluiasi sens cu plata.'); e.status = 400; throw e; }
    if (seenDocs.has(documentId)) { const e = new Error('Documentul ' + documentId + ' apare de mai multe ori in aceeasi alocare.'); e.status = 400; throw e; }
    seenDocs.add(documentId);
    const occupied = round2(activeOther.filter((a) => String(a.documentId) === documentId).reduce((s, a) => s + (Number(a.amount) || 0), 0));
    const capacity = round2(Math.max(0, doc.gross - occupied));
    const amount = x.amount == null || x.amount === '' ? round2(Math.min(pay.amount - total, capacity)) : round2(Number(x.amount));
    if (!(amount > TOL)) { const e = new Error('Fiecare alocare trebuie sa aiba o suma pozitiva.'); e.status = 400; throw e; }
    if (amount > capacity + TOL) { const e = new Error('Alocarea pe documentul ' + documentId + ' depaseste soldul disponibil de ' + capacity + '.'); e.status = 409; throw e; }
    // Stingerea nu poate produce efect inainte sa existe ambele fapte economice. Pentru un avans
    // platit inaintea facturii, data implicita devine data facturii; astfel, o fotografie intre
    // plata si factura arata corect un avans, nu o alocare orfana catre un document viitor.
    const earliest = String(pay.data) > String(doc.data) ? String(pay.data) : String(doc.data);
    const allocationDate = x.allocationDate == null || x.allocationDate === '' ? earliest : String(x.allocationDate);
    if (!validIsoDate(allocationDate)) { const e = new Error('Data alocarii pe documentul ' + documentId + ' trebuie sa fie YYYY-MM-DD.'); e.status = 400; throw e; }
    if (allocationDate < earliest) { const e = new Error('Alocarea pe documentul ' + documentId + ' nu poate fi anterioara datei ' + earliest + ', cand exista atat documentul, cat si plata.'); e.status = 409; throw e; }
    total = round2(total + amount); normalized.push({ documentId, amount, allocationDate });
  }
  if (total > pay.amount + TOL) { const e = new Error('Alocarile (' + total + ') depasesc valoarea platii (' + pay.amount + ').'); e.status = 409; throw e; }
  normalized.sort((a, b) => naturalCompare(a.documentId, b.documentId));
  const active = (data.openItemAllocations || []).filter((a) => a.active !== false && Number(a.firmaId) === Number(firmaId) && String(a.paymentId) === String(paymentId));
  const old = active.map((a) => ({ documentId: String(a.documentId), amount: round2(a.amount),
    allocationDate: String(a.allocationDate || pay.data) })).sort((a, b) => naturalCompare(a.documentId, b.documentId));
  if (JSON.stringify(old) === JSON.stringify(normalized)) return { idempotent: true, allocations: active };
  const at = new Date().toISOString(); const by = actor && actor.id || null;
  for (const a of active) { a.active = false; a.revokedAt = at; a.revokedBy = by; }
  data.openItemAllocations = data.openItemAllocations || [];
  const created = normalized.map((x) => ({ id: nextId('oia'), firmaId: Number(firmaId), paymentId: String(paymentId),
    documentId: x.documentId, amount: x.amount, allocationDate: x.allocationDate, active: true, createdAt: at, createdBy: by,
    createdByName: actor && actor.username || '' }));
  data.openItemAllocations.push(...created);
  return { idempotent: false, allocations: created, revoked: active.length };
}

module.exports = {
  CONTURI_CREANTE, CONTURI_DATORII, partnerKey, refDate, registry, groupedAging, ledgerReconciliation,
  replaceAllocations, metaOf,
};
