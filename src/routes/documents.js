'use strict';

// Rutele de documente primare: upload cu extragere (AI cu revenire pe reguli locale, sau
// reguli locale direct), upload fara extragere, servirea fisierului scanat (inline doar
// tipurile inerte), lista + galeria documentelor primite si galeria facturilor emise.
// Modul de rute: register(app, ctx). Plafonul zilnic de extrageri AI e local acestui modul
// (folosit doar de /api/upload).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const ai = require('../aiExtractor');
const log = require('../log');
const metrics = require('../metrics');
const legal = require('../legalCompliance');
const { extractFromPdf } = require('../extractor');
const extractQuality = require('../extractQuality');
const entriesService = require('../entriesService');
const fiscal = require('../fiscal');
const { getType } = require('../documentTypes');
const { round2, period: periodOf } = require('../util');
const { sendList } = require('../paginate');
const apiContract = require('../apiContract');

// Detaliul de audit al unui upload: DOAR metadate (nume, dimensiune) — niciodata continut.
const uploadDetail = (f) => f.originalname + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)';

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
  const { upload, S, activeId, allowedFirme, logAudit, buildEntry, upsertPartner } = ctx;

  app.post('/api/upload', upload.single('file'), ctx.wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
    const aiMode = String((req.body || {}).aiMode || 'firm-default');
    try { apiContract.assertSchema(apiContract.schemas.DocumentAiMode, aiMode, 'multipart.aiMode'); } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch (_) { /* fisier temporar deja absent */ }
      return res.status(400).json({ error: e.message, code: e.code });
    }
    const d = db.get();
    const ownCui = (db.getFirma(activeId(req)) || {}).cui;
    const buf = fs.readFileSync(req.file.path);
    const fileSha256 = crypto.createHash('sha256').update(buf).digest('hex');

    let extracted;
    let source = 'heuristic';
    let warning = null;
    let extra = {};
    const firma = db.getFirma(activeId(req));
    const aiConfigured = ai.aiAvailable() && d.settings.useAI !== false;
    // Alegerea documentului poate RESTRANGE opt-in-ul firmei, niciodata extinde: `allow` fara
    // consimtamantul firmei ramane local. Clientii vechi pastreaza comportamentul prin default.
    const documentAllowsAI = aiMode !== 'deny';
    const aiWanted = aiConfigured && legal.aiAllowed(firma) && documentAllowsAI;
    const useAI = aiWanted && aiQuotaLeft(req.user) > 0;
    if (aiConfigured && !aiWanted) warning = 'Documentul nu a fost trimis către AI: opt-in-ul firmei lipsește sau nu mai corespunde documentelor juridice curente. S-au folosit regulile locale.';
    if (legal.aiAllowed(firma) && !documentAllowsAI) warning = 'AI a fost dezactivat explicit pentru acest document. S-au folosit regulile locale.';
    if (aiWanted && !useAI) warning = 'Limita zilnica de extrageri AI a fost atinsa — s-au folosit regulile locale.';
    if (useAI) {
      bumpAiUsage(req.user); // numara si incercarile esuate (apelul se factureaza oricum)
      // instrumentare: fiecare apel costa bani — durata/succes in metrici (/api/metrics) si in
      // logul structurat cu reqId (corelabil cu utilizatorul/firma); DOAR metadate, fara continut
      const t0 = Date.now();
      try {
        const r = await ai.extractWithAI(buf, ownCui);
        extracted = { suggestedType: r.suggestedType, fields: r.fields, cuis: r.cuis, text: '' };
        source = 'ai';
        extra = { incredere: r.incredere, motiv: r.motiv, model: r.model, provider: r.provider };
        metrics.aiCall(Date.now() - t0, true);
        log.info('extragere AI reusita', log.ctx(req, { ms: Date.now() - t0, kb: Math.round(buf.length / 1024), tip: r.suggestedType, incredere: r.incredere }));
      } catch (e) {
        warning = 'Extragerea cu AI a esuat (' + (e.message || e) + '). S-au folosit reguli locale.';
        metrics.aiCall(Date.now() - t0, false, e.message || e);
        log.warn('extragere AI esuata — revenire pe reguli locale', log.ctx(req, { ms: Date.now() - t0, kb: Math.round(buf.length / 1024), err: e }));
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

    // CONTROLUL CALITATII: bateria de verificari peste datele firmei (aritmetica, cota, data,
    // partener cunoscut, duplicat, tip) + reconcilierea post-extragere. Intoarce si campurile cu
    // golurile derivabile completate — deci inlocuieste apelul separat catre extractCheck.
    const fid = activeId(req);
    const calitate = extractQuality.evalueaza(
      { fields: extracted.fields || {}, suggestedType: extracted.suggestedType, source, incredere: extra.incredere, fileName: req.file.originalname },
      { v: S(req), firma: db.getFirma(fid) || {}, standardCota: (() => {
        try { return fiscal.rulesAt((extracted.fields || {}).data).rates.tvaStandard; } catch (_) { return 0; }
      })() }
    );
    extracted.fields = calitate.fields;
    if (calitate.avertismente.length) extra.checkWarnings = calitate.avertismente;
    extra.needsReview = calitate.decizie !== 'auto';
    extra.calitate = { scor: calitate.scor, decizie: calitate.decizie, controale: calitate.controale, motive: calitate.motive };

    const docId = db.nextId('doc');
    d.documents.push({
      id: docId,
      firmaId: fid,
      fileName: req.file.originalname,
      storedName: req.file.filename,
      uploadedAt: new Date().toISOString(),
      sha256: fileSha256,
      text: (extracted.text || '').slice(0, 20000),
      // Ce a CITIT masina, pastrat ca atare. E referinta fata de care se masoara interventia
      // operatorului la salvare (vezi entriesService.createEntry): fara ea, „ce a corectat omul"
      // ar fi o intrebare fara raspuns, iar raportul pe furnizori/formate n-ar avea din ce trai.
      extras: {
        source, incredere: extra.incredere == null ? null : Number(extra.incredere),
        // Modelul care a produs `incredere`. `null` la regulile locale — acolo nu exista model,
        // iar un sir inventat („local") ar fi facut ca „nu se aplica" sa arate ca o valoare.
        model: extra.model || null,
        provider: extra.provider || null,
        aiDecision: {
          mode: aiMode,
          firmConsent: legal.aiAllowed(firma),
          transmitted: source === 'ai',
          provider: extra.provider || null,
          model: extra.model || null,
          transmittedAt: source === 'ai' ? new Date().toISOString() : null,
        },
        suggestedType: extracted.suggestedType,
        fields: extracted.fields,
        scor: calitate.scor,
        decizie: calitate.decizie,
        controalePicate: calitate.controale.filter((c) => !c.ok).map((c) => c.cod),
        format: extractQuality.formatFisier(req.file.originalname),
      },
    });
    logAudit('document.upload', uploadDetail(req.file) + ', extragere: ' + source
      + ', optiune AI document: ' + aiMode + ', calitate: ' + calitate.scor + '% ' + calitate.decizie, { req });
    logAudit(source === 'ai' ? 'document.ai.transmitted' : 'document.ai.not_transmitted',
      docId + ' · ' + (source === 'ai' ? (extra.provider + '/' + extra.model) : ('mod ' + aiMode))
        + ' · scop extragere campuri · ' + Math.max(1, Math.round(req.file.size / 1024)) + ' KB', { req });
    db.save();

    // POSTARE AUTOMATA — doar daca firma a cerut-o EXPLICIT si toate controalele blocante trec.
    // Optiunea e implicit oprita: a scrie in contabilitate fara om nu e o valoare implicita
    // rezonabila. Daca crearea esueaza dintr-un motiv de business (perioada inchisa, guard fiscal),
    // NU e o eroare a cererii: documentul ramane la revizuire, cu motivul aratat.
    const firmaCfg = db.getFirma(fid) || {};
    if (firmaCfg.autoPostDocumente && calitate.decizie === 'auto') {
      try {
        // Automatizarea propune o CIORNA trasabila. Calitatea tehnica a extragerii nu inlocuieste
        // verificarea documentului justificativ si nici aprobarea umana.
        const r = entriesService.createEntry(fid, { tip: extracted.suggestedType, fields: extracted.fields, fileId: docId, ciorna: true, automat: true }, { buildEntry, upsertPartner, actor: req.user });
        const doc = d.documents.find((x) => x.id === docId && x.firmaId === fid);
        if (doc && doc.extras) doc.extras.autoCiorna = { entryId: r.entry.id, at: new Date().toISOString() };
        logAudit('document.autodraft', r.entry.id + ' (' + extracted.suggestedType + ', scor ' + calitate.scor + '%)', { req });
        extra.autoCiorna = { entryId: r.entry.id, tip: extracted.suggestedType, status: 'ciorna' };
      } catch (e) {
        extra.needsReview = true;
        extra.calitate.decizie = 'revizuire';
        extra.calitate.motive = (extra.calitate.motive || []).concat(['Postarea automată a fost oprită: ' + (e.message || e)]);
      }
    }

    res.json(Object.assign({
      documentId: docId,
      fileName: req.file.originalname,
      suggestedType: extracted.suggestedType,
      fields: extracted.fields,
      cuis: extracted.cuis,
      source,
      provider: extra.provider || null,
      model: extra.model || null,
      aiDecision: { mode: aiMode, transmitted: source === 'ai' },
      warning,
    }, extra));
  }));

  /**
   * Defalcarea documentelor citite pe MODELUL care le-a citit.
   *
   * `incredere` e o auto-raportare a modelului, deci scala ei ii apartine LUI, nu documentului:
   * pe acelasi set de 6 documente, claude-sonnet-5 raporteaza in medie 74 acolo unde
   * claude-sonnet-4-6 raporta 87 — la acuratete identica pe campuri. Cum pragul de postare
   * automata (MIN_INCREDERE din extractQuality) a fost calibrat pe scala unui model anume,
   * o schimbare de model muta tacit intelesul numarului. Fara defalcarea asta, simptomul ar fi
   * „nu se mai pregateste nicio ciorna automat", fara vinovat si fara din ce reconstitui cauza.
   * Documentele citite cu reguli locale au `model: null` si se raporteaza ca atare.
   */
  function defalcarePeModel(docs) {
    const g = new Map();
    for (const x of docs) {
      const cheie = x.extras.model || null;
      const it = g.get(cheie) || { model: cheie, documente: 0, cuIncredere: 0, sumaIncredere: 0, eligibileAutomat: 0 };
      it.documente++;
      const inc = Number(x.extras.incredere);
      if (x.extras.incredere != null && Number.isFinite(inc)) { it.cuIncredere++; it.sumaIncredere += inc; }
      if (x.extras.decizie === 'auto') it.eligibileAutomat++;
      g.set(cheie, it);
    }
    return [...g.values()]
      .map((it) => ({
        model: it.model,
        documente: it.documente,
        // media DOAR peste documentele care chiar au o incredere raportata: regulile locale n-au,
        // iar un 0 pus in locul lipsei ar trage media in jos si ar inventa o tendinta
        incredereMedie: it.cuIncredere ? Math.round(it.sumaIncredere / it.cuIncredere) : null,
        eligibileAutomat: it.eligibileAutomat,
        postateAutomat: it.eligibileAutomat, // alias de compatibilitate pentru clienti vechi
      }))
      .sort((a, b) => b.documente - a.documente);
  }

  // ── Calitatea extragerii: raportul pe furnizori / formate / controale ──
  // Intrebarea operationala e „pe cine merita sa-l repari", deci raspunsul e sortat dupa numarul
  // de interventii, nu o medie generala. `?days=` restrange fereastra (implicit 90 de zile).
  app.get('/api/extract-quality', (req, res) => {
    const fid = activeId(req);
    const zile = Math.min(365, Math.max(1, Number(req.query.days) || 90));
    const dinCand = new Date(Date.now() - zile * 86400000).toISOString();
    const toate = (db.get().extractInterventions || []).filter((i) => i.firmaId === fid && i.at >= dinCand);
    // Raportul e despre CORECTII: interventiile fara nicio modificare (om care a confirmat
    // extragerea) intra doar in numitor, ca rata sa fie onesta.
    const corectate = toate.filter((i) => i.corectat);
    const rap = extractQuality.raport(corectate);
    const auto = (db.get().documents || []).filter((x) => x.firmaId === fid && x.extras && x.uploadedAt >= dinCand);
    res.json(Object.assign(rap, {
      zile,
      documenteCitite: auto.length,
      interventii: toate.length,
      corectii: corectate.length,
      rataCorectie: toate.length ? Math.round((corectate.length / toate.length) * 100) : 0,
      postateAutomat: auto.filter((x) => x.extras.decizie === 'auto').length,
      eligibileAutomat: auto.filter((x) => x.extras.decizie === 'auto').length,
      scorMediu: auto.length ? Math.round(auto.reduce((s, x) => s + (Number(x.extras.scor) || 0), 0) / auto.length) : null,
      modele: defalcarePeModel(auto),
      autoPostActiv: !!(db.getFirma(fid) || {}).autoPostDocumente,
      autoDraftActiv: !!(db.getFirma(fid) || {}).autoPostDocumente,
      controale: extractQuality.CONTROALE.map((c) => ({ cod: c.cod, nume: c.nume })),
      recente: corectate.slice(-20).reverse().map((i) => ({
        at: i.at, fileName: i.fileName, format: i.format, source: i.source, scor: i.scor,
        partener: i.partener, tipExtras: i.tipExtras, tipSalvat: i.tipSalvat,
        campuri: (i.diff || {}).campuri || [], motiv: i.motiv || '',
      })),
    }));
  });

  // Document fara extragere (introducere manuala / atasament)
  app.post('/api/upload-only', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
    const d = db.get();
    const docId = db.nextId('doc');
    const fileSha256 = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
    d.documents.push({
      id: docId, firmaId: activeId(req), fileName: req.file.originalname, storedName: req.file.filename,
      uploadedAt: new Date().toISOString(), text: '', sha256: fileSha256,
    });
    logAudit('document.upload', uploadDetail(req.file) + ', fara extragere', { req });
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
    sendList(req, res, S(req).documents.map((x) => ({ id: x.id, fileName: x.fileName, uploadedAt: x.uploadedAt })), { label: '/api/documents' });
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
    sendList(req, res, docs, { label: '/api/documents/gallery' });
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
    sendList(req, res, rows, { label: '/api/documents/emitted' });
  });
};
