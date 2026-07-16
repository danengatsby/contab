'use strict';

// Import extras bancar (CSV / MT940): parsarea extrasului cu sugerarea articolelor, importul
// tranzactiilor confirmate (fiecare devine articol contabil) si lista facturilor eligibile
// pentru e-Factura (UBL). Modul de rute: register(app, ctx).

const fs = require('fs');
const db = require('../db');
const bankLib = require('../bank');
const xml = require('../xml');
const acc = require('../accounting');
const { period: periodOf } = require('../util');

module.exports = function register(app, ctx) {
  const { upload, S, activeId, buildEntry, upsertPartner, logAudit } = ctx;

  app.post('/api/bank/parse', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
    const d = db.get();
    const text = fs.readFileSync(req.file.path, 'utf8');
    const transactions = bankLib.parseAndSuggest(S(req), text);
    const docId = db.nextId('doc');
    d.documents.push({ id: docId, firmaId: activeId(req), fileName: req.file.originalname, storedName: req.file.filename, uploadedAt: new Date().toISOString(), text: '' });
    logAudit('bank.parse', req.file.originalname + ' (' + transactions.length + ' tranzactii)', { req });
    db.save();
    res.json({ documentId: docId, count: transactions.length, transactions });
  });
  app.post('/api/bank/import', (req, res) => {
    const { transactions, fileId } = req.body || {};
    if (!Array.isArray(transactions)) return res.status(400).json({ error: 'Lipsesc tranzactiile.' });
    const d = db.get();
    const fid = activeId(req);
    let created = 0; const errors = [];
    for (const t of transactions) {
      try { const e = buildEntry(t.tip, t.fields || {}, fileId || null, fid); d.entries.push(e); upsertPartner(fid, e); created++; }
      catch (e) { errors.push(String(e.message || e)); }
    }
    if (created) logAudit('bank.import', created + ' tranzactii inregistrate', { req });
    db.save();
    res.json({ ok: true, created, errors });
  });
  app.get('/api/efactura-list', (req, res) => {
    const { period } = req.query;
    let list = S(req).entries.filter((e) => xml.isEFacturaEligible(e));
    if (period) list = list.filter((e) => (e.period || periodOf(e.data)) === period);
    res.json(acc.sortEntries(list).map((e) => ({ id: e.id, data: e.data, document: e.document, partener: e.partener, partenerCui: e.partenerCui || '' })));
  });
};
