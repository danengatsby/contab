'use strict';

// Extrasul bancar este document justificativ persistent. Uploadul creeaza extras + tranzactii
// PROPUSE; numai o tranzactie punctata poate produce articol, iar fiecare articol ramane legat
// de linia si de hash-ul fisierului din care provine.

const fs = require('fs');
const db = require('../db');
const bankLib = require('../bank');
const bankStatements = require('../bankStatements');
const duplicateGuard = require('../duplicateGuard');
const xml = require('../xml');
const acc = require('../accounting');
const { period: periodOf, round2, validIsoDate } = require('../util');
const { sendList } = require('../paginate');

function businessError(message, status) { const e = new Error(message); e.status = status || 400; return e; }
function fail(res, e) { return res.status(e.status || 400).json({ error: String(e.message || e) }); }
function numberOrNull(value) { if (value == null || value === '') return null; const n = Number(value); return Number.isFinite(n) ? round2(n) : null; }
function history(tx, status, actor, detail) {
  tx.statusHistory = Array.isArray(tx.statusHistory) ? tx.statusHistory : [];
  tx.statusHistory.push({ status, at: new Date().toISOString(), by: actor && actor.id || null, username: actor && actor.username || '', detail: detail || '' });
  tx.status = status;
}

module.exports = function register(app, ctx) {
  const { upload, S, activeId, buildEntry, composeEntry, upsertPartner, logAudit } = ctx;

  const ownedStatement = (req, id) => {
    const s = (db.get().bankStatements || []).find((x) => String(x.id) === String(id) && Number(x.firmaId) === Number(activeId(req)));
    if (!s) throw businessError('Extrasul bancar nu există în firma activă.', 404); return s;
  };
  const ownedTransaction = (req, id) => {
    const t = (db.get().bankTransactions || []).find((x) => String(x.id) === String(id) && Number(x.firmaId) === Number(activeId(req)));
    if (!t) throw businessError('Tranzacția bancară nu există în firma activă.', 404); return t;
  };
  const refresh = (statement) => {
    const d = db.get(); const txs = (d.bankTransactions || []).filter((t) => String(t.statementId) === String(statement.id));
    const verdict = bankStatements.summarize(statement, txs, d.entries, d.bankTransactions);
    Object.assign(statement, { status: verdict.status, movementNet: verdict.movement, calculatedClosing: verdict.calculatedClosing,
      arithmeticDifference: verdict.arithmeticDifference, evidenceDifference: verdict.evidenceDifference,
      reconciliationDifference: verdict.difference, reconciliationOk: verdict.ok, updatedAt: new Date().toISOString() });
    return verdict;
  };
  const rekeyTransactions = (statement, txs, actor) => {
    const d = db.get(); const own = new Set(txs.map((t) => String(t.id)));
    const outside = (d.bankTransactions || []).filter((t) => Number(t.firmaId) === Number(statement.firmaId) && !own.has(String(t.id)));
    const seen = []; const occurrences = new Map();
    for (const tx of txs.slice().sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))) {
      const occurrenceBase = [tx.externalId || '', tx.bookingDate, tx.direction, tx.amount, tx.description].join('|');
      const occurrence = (occurrences.get(occurrenceBase) || 0) + 1; occurrences.set(occurrenceBase, occurrence);
      const key = bankStatements.transactionKey(statement, tx, occurrence);
      // Preferam originalul postat/activ fata de o copie deja exclusa, ca lantul dovezii unui
      // al treilea import sa nu depinda de mai multe salturi duplicateOf.
      const duplicate = outside.concat(seen).filter((x) => x.uniqueKey === key)
        .sort((a, b) => Number(b.status === 'postata') - Number(a.status === 'postata')
          || Number(a.status === 'exclusa') - Number(b.status === 'exclusa'))[0];
      tx.uniqueKey = key;
      const autoExcluded = tx.status === 'exclusa' && tx.duplicateOf
        && /^Duplicat detectat automat/.test(String(tx.excludedReason || ''));
      if (duplicate && tx.status !== 'postata' && (tx.status !== 'exclusa' || autoExcluded)) {
        tx.duplicateOf = duplicate.id;
        tx.excludedReason = 'Duplicat detectat automat după corectarea identității extrasului.';
        if (!autoExcluded) history(tx, 'exclusa', actor, tx.excludedReason);
      } else if (!duplicate && autoExcluded) {
        tx.duplicateOf = null; tx.excludedReason = '';
        history(tx, 'propusa', actor, 'Cheia a fost recalculată după corectarea identității extrasului; conflictul nu mai există.');
      }
      seen.push(tx);
    }
  };

  app.post('/api/bank/parse', upload.single('file'), (req, res) => {
    try {
      if (!req.file) throw businessError('Niciun fișier primit.');
      const d = db.get(); const fid = activeId(req); const bytes = fs.readFileSync(req.file.path);
      const hash = bankStatements.fileHash(bytes);
      const prior = (d.bankStatements || []).filter((s) => Number(s.firmaId) === Number(fid) && s.fileHash === hash);
      if (prior.length) {
        try { fs.unlinkSync(req.file.path); } catch (_) { /* uploadul duplicat poate fi deja curatat */ }
        throw businessError('Acest fișier a fost deja importat. Extrase existente: ' + prior.map((x) => x.id).join(', ') + '.', 409);
      }
      const text = bytes.toString('utf8'); const parsed = bankLib.parseDetailed(text).filter((s) => (s.transactions || []).length);
      if (!parsed.length) { try { fs.unlinkSync(req.file.path); } catch (_) {} throw businessError('Fișierul nu conține tranzacții bancare recunoscute.'); }
      const docId = db.nextId('doc'); const now = new Date().toISOString();
      d.documents.push({ id: docId, firmaId: fid, fileName: req.file.originalname, storedName: req.file.filename,
        uploadedAt: now, text: '', sha256: hash, documentKind: 'bank_statement' });
      d.bankStatements = d.bankStatements || []; d.bankTransactions = d.bankTransactions || [];
      const createdStatements = []; const createdTransactions = [];
      for (let si = 0; si < parsed.length; si += 1) {
        const p = parsed[si]; const statementId = db.nextId('bst');
        const statement = { id: statementId, firmaId: fid, documentId: docId, fileName: req.file.originalname,
          fileHash: hash, fileIndex: si, format: p.format, statementExternalId: String(p.statementExternalId || '').slice(0, 160),
          iban: bankStatements.normalizeIban(p.iban), currency: bankStatements.normalizeCurrency(p.currency || 'RON'),
          periodFrom: p.periodFrom || '', periodTo: p.periodTo || '', openingBalance: numberOrNull(p.openingBalance),
          closingBalance: numberOrNull(p.closingBalance), status: 'propusa', importedAt: now,
          importedBy: req.user && req.user.id || null, importedByName: req.user && req.user.username || '' };
        d.bankStatements.push(statement); createdStatements.push(statement);
        const enriched = (p.transactions || []).map((t) => Object.assign({}, t, { iban: statement.iban, currency: t.currency || statement.currency }));
        const suggestions = bankLib.suggestTransactions(S(req), enriched); const occurrences = new Map();
        for (let i = 0; i < enriched.length; i += 1) {
          const raw = enriched[i]; const sug = suggestions[i];
          const occurrenceBase = [raw.externalId || '', raw.data, raw.sens, raw.suma, raw.descriere].join('|');
          const occurrence = (occurrences.get(occurrenceBase) || 0) + 1; occurrences.set(occurrenceBase, occurrence);
          const key = bankStatements.transactionKey(statement, raw, occurrence);
          const duplicate = [...(d.bankTransactions || []), ...createdTransactions].find((x) => Number(x.firmaId) === Number(fid) && x.uniqueKey === key);
          const id = db.nextId('btx'); const currency = bankStatements.normalizeCurrency(raw.currency || statement.currency);
          const fields = Object.assign({}, sug.fields, { data: raw.data, analitic: statement.iban,
            cont: currency === 'RON' ? '5121' : '5124', document: raw.externalId || sug.fields.document || '' });
          if (currency !== 'RON') Object.assign(fields, { suma: null, moneda: currency, sumaValuta: raw.suma, curs: null });
          const tx = { id, firmaId: fid, statementId, sequence: i + 1, uniqueKey: key,
            externalId: String(raw.externalId || '').slice(0, 200), bankReference: String(raw.bankReference || '').slice(0, 300),
            bookingDate: raw.data, valueDate: raw.valueDate || raw.data, description: String(raw.descriere || '').slice(0, 1000),
            amount: round2(raw.suma), direction: raw.sens, currency, counterpartyIban: bankStatements.normalizeIban(raw.counterpartyIban),
            proposal: { tip: sug.tip, fields, stinge: sug.stinge || [], matching: sug.potrivire || null, matched: !!sug.matched },
            status: duplicate ? 'exclusa' : 'propusa', duplicateOf: duplicate ? duplicate.id : null,
            excludedReason: duplicate ? 'Duplicat detectat automat după identificatorul unic al tranzacției.' : '',
            createdAt: now, statusHistory: [] };
          history(tx, tx.status, req.user, tx.excludedReason || 'Import extras');
          d.bankTransactions.push(tx); createdTransactions.push(tx);
        }
        refresh(statement);
      }
      logAudit('bank.statement.parse', req.file.originalname + ' · hash ' + hash.slice(0, 12) + ' · ' + createdTransactions.length + ' tranzacții', { req });
      db.save();
      const payload = createdStatements.map((s) => ({ statement: s, reconciliation: refresh(s),
        transactions: createdTransactions.filter((t) => t.statementId === s.id) }));
      const first = payload[0];
      res.json({ documentId: docId, statementId: first.statement.id, count: createdTransactions.length,
        transactions: first.transactions, statements: payload, fileHash: hash });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/bank/statements', (req, res) => {
    const v = S(req); const period = String(req.query.period || '');
    let list = (v.bankStatements || []).slice();
    if (period) list = list.filter((s) => {
      const from = String(s.periodFrom || '').slice(0, 7); const to = String(s.periodTo || '').slice(0, 7);
      return (from && to && from <= period && to >= period)
        || (v.bankTransactions || []).some((t) => t.statementId === s.id && String(t.bookingDate).slice(0, 7) === period);
    });
    list.sort((a, b) => String(b.periodTo || b.importedAt).localeCompare(String(a.periodTo || a.importedAt)));
    sendList(req, res, list.map((s) => Object.assign({}, s, { reconciliation: bankStatements.summarize(s,
      bankStatements.statementTransactions(v, s.id), v.entries, v.bankTransactions) })), { label: 'bank-statements' });
  });

  app.get('/api/bank/statements/:id', (req, res) => {
    try {
      const s = ownedStatement(req, req.params.id); const v = S(req);
      const transactions = bankStatements.statementTransactions(v, s.id);
      res.json({ statement: s, reconciliation: bankStatements.summarize(s, transactions, v.entries, v.bankTransactions), transactions });
    } catch (e) { fail(res, e); }
  });

  app.patch('/api/bank/statements/:id', (req, res) => {
    try {
      const s = ownedStatement(req, req.params.id); const b = req.body || {}; const changes = {};
      if (b.iban != null) { const iban = bankStatements.normalizeIban(b.iban); if (!bankStatements.validIban(iban)) throw businessError('IBAN invalid.'); changes.iban = iban; }
      if (b.currency != null) { const c = bankStatements.normalizeCurrency(b.currency); if (!/^[A-Z]{3}$/.test(c)) throw businessError('Moneda trebuie să fie un cod ISO din 3 litere.'); changes.currency = c; }
      for (const k of ['openingBalance', 'closingBalance']) if (b[k] != null) {
        const n = numberOrNull(b[k]);
        if (n == null && String(b[k]).trim() !== '') throw businessError((k === 'openingBalance' ? 'Soldul inițial' : 'Soldul final') + ' nu este numeric.');
        // Sirul gol inseamna „necunoscut”, nu zero. Zero este acceptat numai cand a fost introdus
        // explicit; altfel un extras fara solduri putea trece accidental drept complet.
        changes[k] = n;
      }
      for (const k of ['periodFrom', 'periodTo']) if (b[k] != null) { if (!validIsoDate(String(b[k]))) throw businessError('Intervalul extrasului conține o dată invalidă.'); changes[k] = String(b[k]); }
      const next = Object.assign({}, s, changes);
      if (next.periodFrom && next.periodTo && next.periodFrom > next.periodTo) throw businessError('Data de început a extrasului nu poate fi ulterioară datei de sfârșit.');
      const changed = Object.keys(changes).filter((k) => String(s[k] == null ? '' : s[k]) !== String(changes[k] == null ? '' : changes[k]));
      if (!changed.length) {
        const d = db.get(); const reconciliation = bankStatements.summarize(s,
          bankStatements.statementTransactions(d, s.id), d.entries, d.bankTransactions);
        return res.json({ ok: true, idempotent: true, statement: s, reconciliation });
      }
      const txs = (db.get().bankTransactions || []).filter((x) => String(x.statementId) === String(s.id));
      if (changed.some((k) => ['iban', 'currency'].includes(k))
          && txs.some((t) => t.status === 'postata' || (t.status === 'exclusa' && t.linkedEntryId))) {
        throw businessError('IBAN-ul sau moneda unui extras deja postat nu se modifică. Stornează articolele și reia importul pe identitatea corectă.', 409);
      }
      const outside = txs.find((t) => next.periodFrom && next.periodTo
        && (!validIsoDate(String(t.bookingDate || '')) || String(t.bookingDate) < next.periodFrom || String(t.bookingDate) > next.periodTo));
      if (outside) throw businessError('Intervalul propus nu cuprinde tranzacția ' + outside.id + ' din ' + outside.bookingDate + '.', 409);
      const overwrites = changed.some((k) => s[k] != null && s[k] !== '');
      const reason = String(b.reason || '').trim(); if (overwrites && reason.length < 5) throw businessError('Modificarea metadatelor existente cere un motiv de minimum 5 caractere.');
      const at = new Date().toISOString(); const old = Object.fromEntries(changed.map((k) => [k, s[k]]));
      Object.assign(s, changes, { metadataUpdatedAt: at, metadataUpdatedBy: req.user && req.user.id || null });
      s.metadataHistory = Array.isArray(s.metadataHistory) ? s.metadataHistory : [];
      s.metadataHistory.push({ at, by: req.user && req.user.id || null, username: req.user && req.user.username || '',
        reason: reason.slice(0, 300), old, next: Object.fromEntries(changed.map((k) => [k, s[k]])) });
      if (changed.some((k) => ['iban', 'currency'].includes(k))) rekeyTransactions(s, txs, req.user);
      for (const t of (db.get().bankTransactions || []).filter((x) => x.statementId === s.id && x.status !== 'postata')) {
        t.currency = s.currency; if (t.proposal && t.proposal.fields) { t.proposal.fields.analitic = s.iban; t.proposal.fields.cont = s.currency === 'RON' ? '5121' : '5124'; }
      }
      const reconciliation = refresh(s); logAudit('bank.statement.metadata', s.id + (reason ? ' · ' + reason : ''), { req }); db.save();
      res.json({ ok: true, statement: s, reconciliation });
    } catch (e) { fail(res, e); }
  });

  function proposalFor(req, tx, payload) {
    if (['postata', 'exclusa'].includes(tx.status)) throw businessError('Tranzacția este deja ' + tx.status + '.', 409);
    const s = ownedStatement(req, tx.statementId); const p = payload || {}; const prev = tx.proposal || {};
    const tip = String(p.tip || prev.tip || ''); const fields = Object.assign({}, prev.fields || {}, p.fields || {});
    fields.data = tx.bookingDate; fields.analitic = s.iban; fields.cont = s.currency === 'RON' ? '5121' : '5124';
    fields.document = fields.document || tx.externalId || '';
    if (s.currency === 'RON') fields.suma = tx.amount;
    else {
      const rate = Number(fields.curs); if (!(rate > 0)) throw businessError('Tranzacția în ' + s.currency + ' cere cursul de contabilizare.');
      fields.moneda = s.currency; fields.sumaValuta = tx.amount; fields.curs = round2(rate); fields.suma = round2(tx.amount * rate);
    }
    const validIds = new Set(db.get().entries.filter((e) => Number(e.firmaId) === Number(activeId(req))).map((e) => String(e.id)));
    const stinge = [...new Set((Array.isArray(p.stinge) ? p.stinge : (prev.stinge || [])).map(String).filter((id) => validIds.has(id)))];
    composeEntry(tip, fields, s.documentId || null, activeId(req));
    return { tip, fields, stinge, matching: prev.matching || null, matched: !!prev.matched };
  }

  app.patch('/api/bank/transactions/:id', (req, res) => {
    try {
      const tx = ownedTransaction(req, req.params.id); tx.proposal = proposalFor(req, tx, req.body || {});
      history(tx, 'punctata', req.user, 'Clasificare și punctaj confirmate'); refresh(ownedStatement(req, tx.statementId));
      logAudit('bank.transaction.score', tx.id, { req }); db.save(); res.json({ ok: true, transaction: tx });
    } catch (e) { fail(res, e); }
  });

  function buildPosted(req, tx, proposal) {
    const s = ownedStatement(req, tx.statementId);
    const entry = buildEntry(proposal.tip, proposal.fields, s.documentId || null, activeId(req));
    if (proposal.stinge.length) entry.stinge = proposal.stinge;
    Object.assign(entry, { bankStatementId: s.id, bankTransactionId: tx.id, bankReference: tx.externalId || tx.bankReference || '',
      bankAccount: { iban: s.iban, currency: s.currency, amount: tx.amount, direction: tx.direction, fileHash: s.fileHash } });
    const at = new Date().toISOString();
    Object.assign(entry, { createdBy: req.user && req.user.id || null, createdByName: req.user && req.user.username || '',
      createdAt: at, postedBy: req.user && req.user.id || null, postedAt: at,
      statusHistory: [{ status: 'postat', by: req.user && req.user.id || null,
        username: req.user && req.user.username || '', at }] });
    const observed = bankStatements.bankEffect(entry, s.currency); const expected = bankStatements.signed(tx);
    if (observed == null || Math.abs(round2(observed - expected)) > 0.005) throw businessError('Nota propusă nu reproduce mișcarea extrasului în ' + s.currency + '.', 409);
    return entry;
  }

  app.post('/api/bank/import', (req, res) => {
    try {
      const b = req.body || {}; if (!b.statementId) throw businessError('Lipsește identitatea extrasului bancar. Reîncarcă extrasul înainte de postare.');
      const statement = ownedStatement(req, b.statementId); const requested = Array.isArray(b.transactions) ? b.transactions : [];
      if (!requested.length) throw businessError('Selectează cel puțin o tranzacție.');
      const seen = new Set(); const staged = [];
      for (const item of requested) {
        const tx = ownedTransaction(req, item.id); if (tx.statementId !== statement.id) throw businessError('Tranzacția ' + tx.id + ' nu aparține extrasului selectat.');
        if (seen.has(tx.id)) throw businessError('Tranzacția ' + tx.id + ' apare de două ori.'); seen.add(tx.id);
        const proposal = proposalFor(req, tx, item); const entry = buildPosted(req, tx, proposal);
        duplicateGuard.assertUnique(db.get().entries.concat(staged.map((x) => x.entry)), entry, 'import extras bancar');
        staged.push({ tx, proposal, entry });
      }
      const current = S(req);
      const before = bankStatements.summarize(statement, bankStatements.statementTransactions(current, statement.id), current.entries, current.bankTransactions);
      if (before.metadataMissing.length) throw businessError('Extras incomplet: lipsesc ' + before.metadataMissing.join(', ') + '.');
      if (before.integrityProblems.length) throw businessError('Extras inconsistent: ' + before.integrityProblems.map((x) => x.message).join(' '), 409);
      if (!before.arithmeticOk) throw businessError('Extras dezechilibrat: sold inițial + mișcări − sold final = ' + before.arithmeticDifference + ' ' + statement.currency + '.', 409);
      // Preflight pentru INTREGUL lot, inainte de prima mutatie. `pushEntry` ramane poarta
      // autoritara si repeta aceste verificari la commit; aici evitam ca o perioada inchisa sau
      // un cont invalid pe linia N sa lase liniile 1..N-1 deja postate in memorie.
      for (const x of staged) db.assertEntryBasics(x.entry, { context: 'import extras bancar' });
      for (const x of staged) {
        db.pushEntry(x.entry, { context: 'import extras bancar' }); upsertPartner(activeId(req), x.entry);
        x.tx.proposal = x.proposal; history(x.tx, 'punctata', req.user, 'Punctaj confirmat la postare');
        x.tx.entryId = x.entry.id; x.tx.postedAt = new Date().toISOString(); history(x.tx, 'postata', req.user, 'Articol ' + x.entry.id);
      }
      const reconciliation = refresh(statement); logAudit('bank.statement.post', statement.id + ' · ' + staged.length + ' tranzacții', { req }); db.save();
      res.json({ ok: true, created: staged.length, errors: [], entryIds: staged.map((x) => x.entry.id), reconciliation });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/bank/transactions/:id/exclude', (req, res) => {
    try {
      const tx = ownedTransaction(req, req.params.id); if (tx.status === 'postata') throw businessError('O tranzacție deja postată se corectează prin storno, nu prin excludere.', 409);
      const reason = String((req.body || {}).reason || '').trim(); if (reason.length < 5) throw businessError('Excluderea cere un motiv de minimum 5 caractere.');
      const entryId = String((req.body || {}).entryId || '');
      if (entryId) {
        const e = db.get().entries.find((x) => String(x.id) === entryId && Number(x.firmaId) === Number(activeId(req)));
        if (!e) throw businessError('Articolul contabil indicat nu există în firma activă.', 404);
        const observed = bankStatements.bankEffect(e, tx.currency); if (observed == null || Math.abs(round2(observed - bankStatements.signed(tx))) > 0.005) throw businessError('Articolul indicat nu reproduce suma și sensul tranzacției.', 409);
        const alreadyEvidence = (db.get().bankTransactions || []).find((x) => Number(x.firmaId) === Number(activeId(req))
          && String(x.id) !== String(tx.id) && (String(x.entryId || '') === entryId || String(x.linkedEntryId || '') === entryId));
        if (alreadyEvidence) throw businessError('Articolul ' + entryId + ' dovedește deja tranzacția ' + alreadyEvidence.id + ' și nu poate justifica încă o linie de extras.', 409);
        tx.linkedEntryId = e.id;
      }
      if (!tx.duplicateOf && !tx.linkedEntryId) throw businessError('Excluderea trebuie justificată printr-o tranzacție duplicat sau printr-un articol contabil existent.', 409);
      tx.excludedReason = reason; tx.excludedAt = new Date().toISOString(); history(tx, 'exclusa', req.user, reason);
      const reconciliation = refresh(ownedStatement(req, tx.statementId)); logAudit('bank.transaction.exclude', tx.id + ' · ' + reason, { req }); db.save();
      res.json({ ok: true, transaction: tx, reconciliation });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/bank/reconciliation', (req, res) => {
    try { res.json(bankStatements.periodControl(S(req), String(req.query.period || new Date().toISOString().slice(0, 7)))); }
    catch (e) { fail(res, e); }
  });

  app.get('/api/efactura-list', (req, res) => {
    const { period } = req.query;
    let list = S(req).entries.filter((e) => acc.isPosted(e) && xml.isEFacturaEligible(e));
    if (period) list = list.filter((e) => (e.period || periodOf(e.data)) === period);
    sendList(req, res, acc.sortEntries(list).map((e) => ({ id: e.id, data: e.data, document: e.document, partener: e.partener, partenerCui: e.partenerCui || '' })), { label: 'efactura-list' });
  });
};
