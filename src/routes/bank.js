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
const { sendList } = require('../paginate');

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
    // id-uri de articole ale firmei — pentru validarea legaturilor de decontare (`stinge`)
    const validIds = new Set(d.entries.filter((e) => e.firmaId === fid).map((e) => e.id));
    let created = 0; const errors = [];
    for (const t of transactions) {
      try {
        const e = buildEntry(t.tip, t.fields || {}, fileId || null, fid);
        // punctaj: leaga plata de facturile stinse (doar id-uri reale ale firmei — fara referinte straine)
        if (Array.isArray(t.stinge)) {
          const ref = [...new Set(t.stinge.filter((id) => validIds.has(id)))];
          if (ref.length) e.stinge = ref;
        }
        db.pushEntry(e, { context: 'import extras bancar' }); upsertPartner(fid, e); created++;
      } catch (e) { errors.push(String(e.message || e)); }
    }
    if (created) logAudit('bank.import', created + ' tranzactii inregistrate', { req });
    db.save();
    res.json({ ok: true, created, errors });
  });
  app.get('/api/efactura-list', (req, res) => {
    const { period } = req.query;
    let list = S(req).entries.filter((e) => acc.isPosted(e) && xml.isEFacturaEligible(e));
    if (period) list = list.filter((e) => (e.period || periodOf(e.data)) === period);
    sendList(req, res, acc.sortEntries(list).map((e) => ({ id: e.id, data: e.data, document: e.document, partener: e.partener, partenerCui: e.partenerCui || '' })), { label: 'efactura-list' });
  });
};
