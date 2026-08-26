'use strict';

// Registrul central al extraselor bancare. Extrasul si tranzactiile lui sunt fapte persistente;
// articolul contabil este rezultatul POSTARII unei tranzactii, nu inlocuitorul extrasului.

const crypto = require('crypto');
const acc = require('./accounting');
const { round2, validPeriod, validIsoDate } = require('./util');

const TX_STATES = new Set(['propusa', 'punctata', 'postata', 'exclusa']);
const TOL = 0.005;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileHash(buffer) { return sha256(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''))); }
function normalizeIban(value) { return String(value || '').replace(/\s+/g, '').toUpperCase(); }
function normalizeCurrency(value) { return String(value || 'RON').trim().toUpperCase(); }

/** Verificare ISO 13616 (lungime + mod 97), fara a limita conturile la Romania. */
function validIban(value) {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

function signed(tx) { return round2((tx.direction || tx.sens) === 'out' ? -Math.abs(Number(tx.amount != null ? tx.amount : tx.suma) || 0) : Math.abs(Number(tx.amount != null ? tx.amount : tx.suma) || 0)); }

/** Cheie stabila intre fisiere. ID-ul bancii este autoritar; fallback-ul e continut + aparitie. */
function transactionKey(statement, tx, occurrence) {
  const iban = normalizeIban(statement.iban || tx.iban);
  const currency = normalizeCurrency(tx.currency || statement.currency);
  const external = String(tx.externalId || tx.bankReference || '').trim().toUpperCase();
  if (external) return sha256(['BANK-ID', iban, currency, external].join('|'));
  return sha256(['BANK-FALLBACK', iban, currency, tx.bookingDate || tx.data || '', tx.valueDate || '', signed(tx),
    String(tx.description || tx.descriere || '').trim().replace(/\s+/g, ' ').toUpperCase(), Number(occurrence) || 1].join('|'));
}

function bankEffect(entry, currency) {
  if (!entry || !acc.isPosted(entry) || entry.stornat) return null;
  const cur = normalizeCurrency(currency);
  const account = cur === 'RON' ? '5121' : '5124';
  let net = 0;
  for (const l of (entry.lines || [])) {
    if (String(l.debit) === account) net += Number(l.suma) || 0;
    if (String(l.credit) === account) net -= Number(l.suma) || 0;
  }
  net = round2(net);
  if (cur === 'RON') return net;
  const vi = entry.valutaInfo || {};
  if (normalizeCurrency(vi.valuta) !== cur || !(Number(vi.sumaValuta) > 0) || Math.abs(net) <= TOL) return null;
  return round2(net < 0 ? -Number(vi.sumaValuta) : Number(vi.sumaValuta));
}

function statementTransactions(view, statementId) {
  return (view.bankTransactions || []).filter((x) => String(x.statementId) === String(statementId));
}

function resolveEvidence(tx, txById, entryById) {
  if (tx.status === 'postata') return { entry: entryById.get(String(tx.entryId || '')) || null, sourceTx: tx, kind: 'posted' };
  if (tx.status !== 'exclusa') return null;
  if (tx.linkedEntryId) return { entry: entryById.get(String(tx.linkedEntryId)) || null, sourceTx: tx, kind: 'linked' };
  const original = tx.duplicateOf ? txById.get(String(tx.duplicateOf)) : null;
  return original && original.status === 'postata' && original.entryId
    ? { entry: entryById.get(String(original.entryId)) || null, sourceTx: original, kind: 'duplicate' } : null;
}

function numericBalance(value) {
  if (value == null || String(value).trim() === '') return NaN;
  return Number(value);
}

/** Verdict complet: identitate, formula soldurilor si fiecare miscare dovedita in jurnal. */
function summarize(statement, transactions, entries, allTransactions) {
  const txs = transactions || [];
  const all = allTransactions || txs;
  const entryById = new Map((entries || []).map((e) => [String(e.id), e]));
  const txById = new Map(all.map((t) => [String(t.id), t]));
  const movement = round2(txs.reduce((s, t) => s + signed(t), 0));
  const opening = numericBalance(statement.openingBalance); const closing = numericBalance(statement.closingBalance);
  const balancesKnown = Number.isFinite(opening) && Number.isFinite(closing);
  const arithmeticDifference = balancesKnown ? round2(opening + movement - closing) : null;
  let evidenceDifference = 0; let unresolved = 0; let orphaned = 0; const linkedEvidenceUsed = new Set();
  for (const tx of txs) {
    if (!TX_STATES.has(tx.status)) { unresolved += 1; evidenceDifference += Math.abs(signed(tx)); continue; }
    const evidence = resolveEvidence(tx, txById, entryById);
    if (tx.status === 'propusa' || tx.status === 'punctata') {
      unresolved += 1; evidenceDifference += Math.abs(signed(tx)); continue;
    }
    if (!evidence || !evidence.entry) { orphaned += 1; evidenceDifference += Math.abs(signed(tx)); continue; }
    const proof = evidence.entry; const sourceTx = evidence.sourceTx || tx;
    if (evidence.kind === 'linked' && linkedEvidenceUsed.has(String(proof.id))) {
      orphaned += 1; evidenceDifference += Math.abs(signed(tx)); continue;
    }
    if (evidence.kind === 'linked') linkedEvidenceUsed.add(String(proof.id));
    // Pentru o linie POSTATA (inclusiv originalul unui duplicat), suma potrivita nu este singura
    // dovada: articolul trebuie sa poarte legatura inversa spre exact tranzactia si extrasul ei.
    // Altfel, doua miscari egale pot fi incrucisate accidental si ambele ar parea reconciliate.
    if (evidence.kind !== 'linked') {
      const ba = proof.bankAccount || {};
      const provenanceOk = String(proof.bankTransactionId || '') === String(sourceTx.id)
        && String(proof.bankStatementId || '') === String(sourceTx.statementId)
        && normalizeIban(ba.iban) === normalizeIban(statement.iban)
        && normalizeCurrency(ba.currency) === normalizeCurrency(tx.currency || statement.currency)
        // Un duplicat poate proveni dintr-un al doilea fisier valid; articolul doveditor poarta
        // hash-ul ORIGINALULUI, nu pe al extrasului care a detectat duplicatul.
        && (evidence.kind === 'duplicate' || !statement.fileHash || String(ba.fileHash || '') === String(statement.fileHash));
      if (!provenanceOk) { orphaned += 1; evidenceDifference += Math.abs(signed(tx)); continue; }
    }
    const observed = bankEffect(proof, tx.currency || statement.currency);
    if (observed == null) { orphaned += 1; evidenceDifference += Math.abs(signed(tx)); continue; }
    evidenceDifference += Math.abs(round2(signed(tx) - observed));
  }
  evidenceDifference = round2(evidenceDifference);
  const metadataMissing = [];
  if (!validIban(statement.iban)) metadataMissing.push('IBAN');
  if (!/^[A-Z]{3}$/.test(normalizeCurrency(statement.currency))) metadataMissing.push('monedă');
  if (!Number.isFinite(opening)) metadataMissing.push('sold inițial');
  if (!Number.isFinite(closing)) metadataMissing.push('sold final');
  const from = String(statement.periodFrom || ''); const to = String(statement.periodTo || '');
  if (!validIsoDate(from)) metadataMissing.push('data de început');
  if (!validIsoDate(to)) metadataMissing.push('data de sfârșit');
  const integrityProblems = [];
  if (validIsoDate(from) && validIsoDate(to) && from > to) integrityProblems.push({ code: 'statement-range', message: 'Data de început este ulterioară datei de sfârșit.' });
  for (const tx of txs) {
    const booking = String(tx.bookingDate || '');
    if (!validIsoDate(booking)) integrityProblems.push({ code: 'transaction-date', transactionId: tx.id, message: 'Data contabilizării este invalidă.' });
    else if (validIsoDate(from) && validIsoDate(to) && (booking < from || booking > to)) integrityProblems.push({ code: 'transaction-outside-statement', transactionId: tx.id, message: 'Tranzacția este în afara intervalului extrasului.' });
    if (normalizeCurrency(tx.currency || statement.currency) !== normalizeCurrency(statement.currency)) {
      integrityProblems.push({ code: 'transaction-currency', transactionId: tx.id, message: 'Moneda tranzacției diferă de moneda extrasului.' });
    }
  }
  const difference = round2(Math.abs(arithmeticDifference == null ? 0 : arithmeticDifference) + evidenceDifference);
  const arithmeticOk = arithmeticDifference != null && Math.abs(arithmeticDifference) <= TOL;
  const ok = !metadataMissing.length && integrityProblems.length === 0 && arithmeticOk
    && unresolved === 0 && orphaned === 0 && evidenceDifference <= TOL;
  let status = 'propusa';
  if (ok) status = 'postata';
  else if (txs.some((t) => t.status !== 'propusa')) status = 'punctata';
  return {
    statementId: statement.id, iban: normalizeIban(statement.iban), currency: normalizeCurrency(statement.currency),
    openingBalance: Number.isFinite(opening) ? round2(opening) : null, movement, calculatedClosing: Number.isFinite(opening) ? round2(opening + movement) : null,
    closingBalance: Number.isFinite(closing) ? round2(closing) : null, arithmeticDifference, arithmeticOk,
    evidenceDifference, difference, unresolved, orphaned, metadataMissing, integrityProblems, status, ok,
    counts: [...TX_STATES].reduce((o, state) => Object.assign(o, { [state]: txs.filter((t) => t.status === state).length }), {}),
  };
}

function periodControl(view, period) {
  if (!validPeriod(String(period || ''))) { const e = new Error('Perioada controlului bancar trebuie să fie YYYY-MM.'); e.status = 400; throw e; }
  const adoption = String((view.company || {}).bankReconciliationFrom || new Date().toISOString().slice(0, 7));
  const required = period >= adoption;
  const txInPeriod = (view.bankTransactions || []).filter((t) => String(t.bookingDate || '').slice(0, 7) === period);
  const statementIds = new Set(txInPeriod.map((t) => String(t.statementId)));
  for (const s of (view.bankStatements || [])) {
    const from = String(s.periodFrom || '').slice(0, 7); const to = String(s.periodTo || '').slice(0, 7);
    if (from && to && from <= period && to >= period) statementIds.add(String(s.id));
  }
  const statements = (view.bankStatements || []).filter((s) => statementIds.has(String(s.id)));
  const summaries = statements.map((s) => summarize(s, statementTransactions(view, s.id), view.entries, view.bankTransactions));
  // Cand aceeasi banca livreaza mai multe fragmente succesive in luna, soldul de iesire al unui
  // fragment trebuie sa fie soldul de intrare al urmatorului. Pentru intervale suprapuse nu
  // inventam o ordine; anti-duplicatul tranzactiilor ramane controlul relevant.
  const accountGroups = new Map();
  for (const s of statements) {
    const key = normalizeIban(s.iban) + '|' + normalizeCurrency(s.currency);
    if (!accountGroups.has(key)) accountGroups.set(key, []);
    accountGroups.get(key).push(s);
  }
  const continuity = [];
  for (const [account, group] of accountGroups) {
    group.sort((a, b) => String(a.periodFrom || '').localeCompare(String(b.periodFrom || ''))
      || String(a.periodTo || '').localeCompare(String(b.periodTo || '')) || String(a.id).localeCompare(String(b.id)));
    for (let i = 1; i < group.length; i += 1) {
      const previous = group[i - 1]; const current = group[i];
      if (!previous.periodTo || !current.periodFrom || String(previous.periodTo) >= String(current.periodFrom)) continue;
      const previousClosing = numericBalance(previous.closingBalance); const currentOpening = numericBalance(current.openingBalance);
      if (!Number.isFinite(previousClosing) || !Number.isFinite(currentOpening)) continue;
      const continuityDifference = round2(previousClosing - currentOpening);
      if (Math.abs(continuityDifference) > TOL) continuity.push({
        account, previousStatementId: previous.id, statementId: current.id,
        previousClosing: round2(previousClosing), currentOpening: round2(currentOpening), difference: continuityDifference,
      });
    }
  }
  const continuityDifference = round2(continuity.reduce((sum, x) => sum + Math.abs(x.difference), 0));
  const entryByTx = new Set((view.bankTransactions || []).map((t) => String(t.entryId || t.linkedEntryId || '')).filter(Boolean));
  const bankEntries = acc.postedEntries(view).filter((e) => String(e.data || '').slice(0, 7) === period && (e.lines || []).some((l) => ['5121', '5124'].includes(String(l.debit)) || ['5121', '5124'].includes(String(l.credit))));
  const unlinkedEntries = bankEntries.filter((e) => !entryByTx.has(String(e.id)) && !e.bankTransactionId);
  const unlinkedDifference = round2(unlinkedEntries.reduce((sum, e) => {
    let q = 0; for (const l of (e.lines || [])) if (['5121', '5124'].includes(String(l.debit)) || ['5121', '5124'].includes(String(l.credit))) q += Math.abs(Number(l.suma) || 0);
    return sum + q;
  }, 0));
  const difference = round2(summaries.reduce((s, x) => s + x.difference, 0)
    + (required ? unlinkedDifference + continuityDifference : 0));
  const missingStatement = required && bankEntries.length > 0 && statements.length === 0;
  const ok = !required || (!missingStatement && summaries.every((x) => x.ok)
    && unlinkedEntries.length === 0 && continuity.length === 0);
  return { period, adoption, required, statements: summaries, statementCount: summaries.length, bankEntryCount: bankEntries.length,
    unlinkedEntries: unlinkedEntries.map((e) => ({ id: e.id, data: e.data, document: e.document || '', tip: e.tip })),
    unlinkedDifference, continuity, continuityDifference, missingStatement, difference, ok };
}

module.exports = {
  TX_STATES, fileHash, normalizeIban, normalizeCurrency, validIban, signed, transactionKey,
  bankEffect, statementTransactions, summarize, periodControl,
};
