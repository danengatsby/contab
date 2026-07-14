'use strict';

// Rutele de documente primare: upload cu extragere (AI cu revenire pe reguli locale, sau
// reguli locale direct), upload fara extragere, servirea fisierului scanat (inline doar
// tipurile inerte), lista + galeria documentelor primite si galeria facturilor emise.
// Modul de rute: register(app, ctx). Plafonul zilnic de extrageri AI e local acestui modul
// (folosit doar de /api/upload).

const fs = require('fs');
const path = require('path');
const db = require('../db');
const ai = require('../aiExtractor');
const { extractFromPdf } = require('../extractor');
const { getType } = require('../documentTypes');
const { round2, period: periodOf } = require('../util');

// Plafon zilnic de extrageri AI per utilizator — fiecare apel costa bani; contul demo e public,
// deci are o limita stricta. Peste plafon se revine automat la regulile locale (fara eroare).
const AI_DAILY_LIMIT = Number(process.env.CONTAB_AI_DAILY_LIMIT) || 200;
const AI_DAILY_LIMIT_DEMO = Number(process.env.CONTAB_AI_DAILY_LIMIT_DEMO) || 10;
function aiQuotaLeft(u) {
  const today = new Date().toISOString().slice(0, 10);
  const used = u.aiUsage && u.aiUsage.date === today ? u.aiUsage.count : 0;
  return (u.username === 'demo' ? AI_DAILY_LIMIT_DEMO : AI_DAILY_LIMIT) - used;
}
function bumpAiUsage(u) {
  const today = new Date().toISOString().slice(0, 10);
  u.aiUsage = u.aiUsage && u.aiUsage.date === today
    ? { date: today, count: u.aiUsage.count + 1 }
    : { date: today, count: 1 };
}

module.exports = function register(app, ctx) {
  const { upload, S, activeId, allowedFirme, logAudit } = ctx;

  app.post('/api/upload', upload.single('file'), ctx.wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
    const d = db.get();
    const ownCui = (db.getFirma(activeId(req)) || {}).cui;
    const buf = fs.readFileSync(req.file.path);

    let extracted;
    let source = 'heuristic';
    let warning = null;
    let extra = {};
    const aiWanted = ai.aiAvailable() && d.settings.useAI !== false;
    const useAI = aiWanted && aiQuotaLeft(req.user) > 0;
    if (aiWanted && !useAI) warning = 'Limita zilnica de extrageri AI a fost atinsa — s-au folosit regulile locale.';
    if (useAI) {
      bumpAiUsage(req.user); // numara si incercarile esuate (apelul se factureaza oricum)
      try {
        const r = await ai.extractWithAI(buf, ownCui);
        extracted = { suggestedType: r.suggestedType, fields: r.fields, cuis: r.cuis, text: '' };
        source = 'ai';
        extra = { incredere: r.incredere, motiv: r.motiv };
      } catch (e) {
        warning = 'Extragerea cu AI a esuat (' + (e.message || e) + '). S-au folosit reguli locale.';
        console.error('AI extract failed:', e.message || e);
      }
    }
    const mediaType = ai.detectMediaType(buf);
    const isImage = mediaType && mediaType.startsWith('image/');
    if (!extracted) {
      if (isImage) {
        // imaginile nu pot fi citite cu reguli locale (text) — necesita extragerea cu AI
        extracted = { suggestedType: 'nota_contabila', fields: {}, cuis: [], text: '' };
        if (!warning) warning = useAI ? warning : 'Pentru imagini (JPG/PNG) e nevoie de extragerea cu AI (configureaz-o in Setari). Completeaza manual campurile.';
      } else {
        extracted = await extractFromPdf(buf, ownCui);
      }
    }

    const docId = db.nextId('doc');
    d.documents.push({
      id: docId,
      firmaId: activeId(req),
      fileName: req.file.originalname,
      storedName: req.file.filename,
      uploadedAt: new Date().toISOString(),
      text: (extracted.text || '').slice(0, 20000),
    });
    db.save();
    res.json(Object.assign({
      documentId: docId,
      fileName: req.file.originalname,
      suggestedType: extracted.suggestedType,
      fields: extracted.fields,
      cuis: extracted.cuis,
      source,
      warning,
    }, extra));
  }));

  // Document fara extragere (introducere manuala / atasament)
  app.post('/api/upload-only', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
    const d = db.get();
    const docId = db.nextId('doc');
    d.documents.push({
      id: docId, firmaId: activeId(req), fileName: req.file.originalname, storedName: req.file.filename,
      uploadedAt: new Date().toISOString(), text: '',
    });
    db.save();
    res.json({ documentId: docId, fileName: req.file.originalname });
  });

  // Inline doar tipurile inerte (viewer PDF/galerie); restul se descarca fortat, ca octeti,
  // ca sa nu se randeze niciodata continut incarcat de utilizatori in origin-ul aplicatiei.
  const DOC_INLINE_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
  app.get('/api/document/:id/file', (req, res) => {
    const d = db.get();
    const doc = d.documents.find((x) => x.id === req.params.id);
    if (!doc) return res.status(404).send('Document inexistent');
    const fid = doc.firmaId == null ? d.firmaActiva : doc.firmaId;
    if (!allowedFirme(req.user).includes(fid)) return res.status(403).json({ error: 'Nu ai acces la acest document.' });
    const p = path.join(db.UPLOAD_DIR, path.basename(doc.storedName || ''));
    if (!fs.existsSync(p)) return res.status(404).send('Fisier negasit pe server');
    const ext = path.extname(p).toLowerCase();
    if (DOC_INLINE_EXT.has(ext)) return res.sendFile(p);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(doc.fileName || doc.storedName) + '"');
    fs.createReadStream(p).pipe(res);
  });

  app.get('/api/documents', (req, res) => {
    res.json(S(req).documents.map((x) => ({ id: x.id, fileName: x.fileName, uploadedAt: x.uploadedAt })));
  });

  // Galerie documente primite: fiecare fisier incarcat, cu tipul (imagine/pdf) si articolul asociat.
  app.get('/api/documents/gallery', (req, res) => {
    const v = S(req);
    const byFile = {};
    for (const e of v.entries) if (e.fileId) byFile[e.fileId] = e;
    const typeOf = (name) => {
      const x = (String(name || '').match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'tif', 'tiff'].includes(x)) return 'image';
      if (x === 'pdf') return 'pdf';
      return 'other';
    };
    const docs = v.documents.map((d) => {
      const e = byFile[d.id];
      return {
        id: d.id, fileName: d.fileName, uploadedAt: d.uploadedAt, type: typeOf(d.storedName || d.fileName),
        entry: e ? { id: e.id, tip: e.tip, tipNume: e.tipNume, data: e.data, partener: e.partener || '', document: e.document || '' } : null,
      };
    }).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
    res.json(docs);
  });

  // Galerie documente emise: facturile catre clienti (grup Vanzari), fiecare cu PDF vizual + e-Factura.
  app.get('/api/documents/emitted', (req, res) => {
    const v = S(req);
    const EFACT = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare']);
    const rows = v.entries.filter((e) => { const t = getType(e.tip); return t && t.grup === 'Vanzari'; }).map((e) => {
      let baza = 0; let tva = 0;
      for (const l of e.lines) {
        if (Number(String(l.credit)[0]) === 7) baza = round2(baza + l.suma);
        if (Number(String(l.debit)[0]) === 7) baza = round2(baza - l.suma);
        if (l.credit === '4427' || l.credit === '4428') tva = round2(tva + l.suma);
        if (l.debit === '4427' || l.debit === '4428') tva = round2(tva - l.suma);
      }
      return { id: e.id, tip: e.tip, tipNume: e.tipNume, data: e.data, period: e.period || periodOf(e.data), partener: e.partener || '', document: e.document || '', baza, tva, total: round2(baza + tva), eFactura: EFACT.has(e.tip) };
    }).sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
    res.json(rows);
  });
};
