'use strict';

// Rutele registrului depunerilor, portofoliului si notificarilor de termene.
// Modul de rute: `register(app, ctx)` primeste app-ul Express + helperii partajati
// din server.js (context injectat), ca sa nu duplice starea globala.

const decl = require('../declarations');
const plans = require('../plans');
const rep = require('../reporting');
const acc = require('../accounting');
const ptOpts = require('../profitTaxOptions');
const d107 = require('../d107');
const d301 = require('../d301');
const d307 = require('../d307');
const d311 = require('../d311');
const { statPlataPostata } = require('../payroll');
const fiscalReview = require('../fiscalReview');
const fiscalProfile = require('../fiscalProfile');
const permissions = require('../permissions');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const globalChain = require('../globalChain');
const auditLog = require('../auditLog');

module.exports = function register(app, ctx) {
  const { db, S, activeId, allowedFirme, logAudit, upload } = ctx;
  const filingExtensions = new Set(['.xml', '.zip', '.pdf']);

  function validFilingUpload(req, res) {
    const ext = path.extname(String(req.file && req.file.originalname || '')).toLowerCase();
    if (filingExtensions.has(ext)) return true;
    res.status(400).json({ error: 'Sunt acceptate numai fișiere XML, ZIP sau PDF.' });
    return false;
  }

  function filingTarget(req, res) {
    const tip = String(req.query.tip || ''); const period = String(req.query.period || '');
    if (!decl.TIPURI[tip] || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      res.status(400).json({ error: 'Declarația sau perioada este invalidă.' }); return null;
    }
    const rec = decl.find(db.get(), activeId(req), tip, period);
    if (!rec) { res.status(404).json({ error: 'Declarația nu există în firma activă.' }); return null; }
    const integrity = decl.verifyDossier(rec, activeId(req), tip, period);
    if (!integrity.valid) {
      res.status(409).json({ error: 'Dosarul de depunere nu trece verificarea de integritate.',
        code: 'FILING_DOSSIER_INTEGRITY_FAILED', issues: integrity.issues }); return null;
    }
    if (!validDossierReference(req.query, activeId(req), tip, period, res)) return null;
    const ordinal = Number(req.query.ordinal);
    const submission = (rec.depuneri || []).find((x) => Number(x.ordinal) === ordinal);
    if (!submission) { res.status(404).json({ error: 'Depunerea cerută nu există.' }); return null; }
    return { tip, period, rec, ordinal, submission };
  }

  function validDossierReference(source, firmaId, tip, period, res) {
    const supplied = String(source && source.dossierId || '').trim();
    if (!supplied) return true; // compatibilitate pentru clienții API anteriori dosarului explicit
    const expected = decl.dossierIdentity(firmaId, tip, period).id;
    if (supplied === expected) return true;
    res.status(409).json({ error: 'Identitatea dosarului nu corespunde declarației și perioadei cerute.',
      code: 'FILING_DOSSIER_REFERENCE_MISMATCH', expectedDossierId: expected });
    return false;
  }

  function dossierAuditRef(firmaId, tip, period) {
    const rec = decl.find(db.get(), firmaId, tip, period);
    const chain = rec && rec.stateChainHash ? ' · lanț ' + rec.stateChainHash : '';
    return ' · dosar ' + decl.dossierIdentity(firmaId, tip, period).id + chain;
  }

  function dossierCheckpoint(d, firmaId, tip, period) {
    d.declarations = d.declarations || [];
    const index = d.declarations.findIndex((row) => String(row.firmaId) === String(firmaId)
      && String(row.tip || '').toLowerCase() === String(tip || '').toLowerCase()
      && String(row.period || '') === String(period || ''));
    const before = index >= 0 ? JSON.parse(JSON.stringify(d.declarations[index])) : null;
    let committed = false;
    return {
      commit() { committed = true; },
      rollback() {
        if (committed) return;
        if (before) d.declarations[index] = before;
        else d.declarations = d.declarations.filter((row) => !(String(row.firmaId) === String(firmaId)
          && String(row.tip || '').toLowerCase() === String(tip || '').toLowerCase()
          && String(row.period || '') === String(period || '')));
      },
    };
  }

  function sendArchivedFile(res, blob, bytes, fallbackName) {
    const name = path.basename(String(blob.filename || fallbackName || 'fisier.bin')).slice(0, 180);
    res.setHeader('Content-Type', String(blob.mime || 'application/octet-stream').slice(0, 100));
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(name) + '"');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.setHeader('ETag', '"sha256-' + blob.sha256 + '"');
    res.send(bytes);
  }

  function globalDownloadGuard(res) {
    try {
      const report = globalChain.verifyGraph(db.get(), { auditResult: auditLog.verify(), requireAudit: true });
      if (!report.ok) {
        res.status(409).json({ error: 'Descărcarea a fost oprită: verificarea globală a lanțului a eșuat.',
          code: 'GLOBAL_CHAIN_INVALID' }); return null;
      }
      res.setHeader('X-Contab-Integrity-Root', report.rootHash);
      return report;
    } catch (_) {
      res.status(409).json({ error: 'Descărcarea a fost oprită: lanțul global nu a putut fi verificat.',
        code: 'GLOBAL_CHAIN_UNAVAILABLE' }); return null;
    }
  }

  function requireFiscalReview(res, operation) {
    try { return fiscalReview.assertReady(operation); } catch (e) {
      res.status(e.status || 409).json({ error: e.message, code: e.code || 'FISCAL_REVIEW_REQUIRED',
        review: e.review ? { fiscalYear: e.review.fiscalYear, approved: e.review.approved, total: e.review.total, invalid: e.review.invalid } : undefined });
      return false;
    }
  }

  function transitionAuthorization(req, action, firmaId) {
    return {
      authorized: true, action,
      actorId: req.user && req.user.id != null ? req.user.id : null,
      username: String(req.user && req.user.username || ''),
      role: permissions.roleFor(req.user, firmaId, db.getFirma(firmaId)) || '',
      source: 'http-api',
    };
  }

  // Păstrăm în dosar o dovadă verificabilă, dar nu copiem datele personale sau semnăturile
  // revizorilor. Hash-ul fiecărei aprobări leagă tranziția de bundle-ul extern exact.
  function fiscalApprovalEvidence(review) {
    const s = review || fiscalReview.status();
    const basis = {
      fiscalYear: s.fiscalYear, fiscalUpdatedAt: s.fiscalUpdatedAt,
      cases: (s.cases || []).map((c) => ({
        id: c.id, status: c.status, currentHash: c.currentHash,
        approvalHash: c.approval
          ? crypto.createHash('sha256').update(JSON.stringify(c.approval)).digest('hex') : '',
      })),
    };
    return {
      ready: s.ready === true, fiscalYear: s.fiscalYear, approved: s.approved,
      total: s.total, invalid: s.invalid,
      hash: crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex'),
    };
  }

  function archivedReceipt(req, bytes) {
    return {
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      filename: path.basename(req.file.originalname || 'recipisa.bin').slice(0, 180),
      mime: String(req.file.mimetype || 'application/octet-stream').slice(0, 100),
      uploadedAt: new Date().toISOString(), by: req.user && req.user.username || '',
      contentBase64: bytes.toString('base64'),
    };
  }

  app.get('/api/declarations', (req, res) => {
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    const review = fiscalReview.status();
    res.json({ period, rows: decl.registerForFirma(db.get(), S(req), period),
      fiscalReview: { ready: review.ready, fiscalYear: review.fiscalYear, approved: review.approved, pending: review.pending, invalid: review.invalid, total: review.total } });
  });

  // Proiecția canonică a unui singur dosar. Include întregul traseu și metadatele fișierelor, dar
  // nu base64; descărcarea octeților rămâne pe rutele care recalculează SHA-256 înainte de răspuns.
  app.get('/api/declarations/dosar', (req, res) => {
    const tip = String(req.query.tip || ''); const period = String(req.query.period || '');
    if (!decl.TIPURI[tip] || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      return res.status(400).json({ error: 'Declarația sau perioada este invalidă.' });
    }
    const fid = activeId(req); const view = S(req);
    const row = decl.registerForFirma(db.get(), view, period).find((x) => x.tip === tip);
    if (!row) return res.status(404).json({ error: 'Declarația nu aparține calendarului fiscal al firmei și nu are dosar materializat.' });
    const rec = decl.find(db.get(), fid, tip, period);
    return res.json(Object.assign(decl.publicDossier(rec, fid, tip, period, view), {
      name: row.nume, due: row.due, urgency: row.urgenta, links: row.links,
    }));
  });

  // Aprobatorul confirmă explicit hash-ul afișat. Momentul, actorul și dovada sunt construite pe
  // server; un client nu poate aproba „documentul curent” fără să numească SHA-256-ul verificat.
  app.post('/api/declarations/approve', (req, res) => {
    const b = req.body || {}; const tip = String(b.tip || ''); const period = String(b.period || '');
    if (!decl.TIPURI[tip] || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      return res.status(400).json({ error: 'Declarația sau perioada este invalidă.' });
    }
    if (!/^[0-9a-f]{64}$/.test(String(b.artifactHash || ''))) {
      return res.status(400).json({ error: 'Aprobarea cere SHA-256 complet al documentului verificat.', code: 'FILING_APPROVAL_ARTIFACT_MISMATCH' });
    }
    const review = requireFiscalReview(res, 'aprobarea ' + tip.toUpperCase() + ' ' + period);
    if (!review) return;
    const d = db.get(); const fid = activeId(req);
    try { permissions.assert(req.user, fid, 'declaration.approve', db.getFirma(fid)); } catch (e) {
      return res.status(e.status || 403).json({ error: e.message, permission: e.permission });
    }
    if (!validDossierReference(b, fid, tip, period, res)) return;
    const checkpoint = dossierCheckpoint(d, fid, tip, period);
    try {
      const result = decl.approveDocument(d, fid, tip, period, {
        artifactHash: String(b.artifactHash), note: String(b.note || ''),
        authorization: transitionAuthorization(req, 'declaration.approve', fid),
        fiscalReviewEvidence: fiscalApprovalEvidence(review),
      });
      logAudit('declaratie.aprobata', tip.toUpperCase() + ' ' + period
        + ' · document SHA-256 ' + result.approval.artifactHash
        + ' · aprobare ' + result.approval.approvalHash + dossierAuditRef(fid, tip, period), { req });
      db.save(); checkpoint.commit();
      return res.json({ ok: true, created: result.created, approval: result.approval,
        dossier: decl.publicDossier(result.rec, fid, tip, period, S(req)),
        rows: decl.registerForFirma(d, S(req), period) });
    } catch (e) {
      checkpoint.rollback();
      return res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
    }
  });

  // ── Declaratii rectificative ────────────────────────────────────────────
  // Cifrele-cheie ale unei depuneri, ca sa se poata arata DIFERENTA la rectificativa. Fara ele,
  // istoricul ar spune „s-a mai depus o data", fara sa spuna CE s-a schimbat.
  function sumeCheie(view, tip, period) {
    try {
      if (tip === 'd300') { const x = rep.d300(view, period); return { tvaColectata: x.tvaColectata, tvaDeductibila: x.tvaDeductibila, tvaDePlata: x.tvaDePlata, tvaDeRecuperat: x.tvaDeRecuperat }; }
      if (tip === 'd301') { const x = d301.report(view, period); return { baza: x.totalBaza, tvaDePlata: x.totalTva }; }
      if (tip === 'd307') { const x = d307.report(view, period); return { tvaA: x.totaluri.A, tvaL: x.totaluri.L, tvaC: x.totaluri.C, total: x.totalTva }; }
      if (tip === 'd311') { const x = d311.report(view, period); return { baza: x.totalBaza, tvaDePlata: x.totalTva }; }
      if (tip === 'd107') { const year = period.slice(0, 4); const po = ptOpts.pentruDeclaratie(view, year); const pt = po.rezultatFiscal || acc.profitTax(view, year, po); const x = d107.report(view, year, pt); return { acordat: x.totals.val1, reportat: x.totals.val2, dedus: x.totals.val3, beneficiari: x.nr }; }
      if (tip === 'd205') { const x = rep.d205(view, period.slice(0, 4)); return { beneficiari: x.nr, venitBrut: x.totalBrut, bazaImpozabila: x.totalBaza, impozit: x.totalImpozit }; }
      if (tip === 'd112') {
        const t = statPlataPostata(view, period).totals;
        return { brut: t.brut, impozit: t.impozit,
          cas: (t.cas || 0) + (t.casAngajator || 0),
          cass: (t.cass || 0) + (t.cassAngajator || 0),
          cam: t.cam, totalBuget: t.totalBuget };
      }
      if (tip === 'd394') { const x = rep.d300(view, period); return { tvaColectata: x.tvaColectata, tvaDeductibila: x.tvaDeductibila }; }
      if (tip === 'd100') return decl.d100Snapshot(rep.d100(view, period));
    } catch (e) { /* raportul nu se poate calcula: istoricul ramane fara sume, nu pica depunerea */ }
    return null;
  }

  app.get('/api/declarations/istoric', (req, res) => {
    const { tip, period } = req.query;
    if (!decl.TIPURI[tip]) return res.status(400).json({ error: 'Tip de declaratie necunoscut.' });
    if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    const rec = decl.find(db.get(), activeId(req), tip, period);
    const depuneri = decl.publicSubmissions((rec && rec.depuneri) || []);
    // Diferenta fata de ultima depunere, calculata pe datele DE ACUM: asta ar depune utilizatorul.
    const ultima = decl.lastSubmission(rec);
    const acum = { sume: sumeCheie(S(req), tip, period) };
    res.json({
      tip, period, depuneri,
      semnalizataInXml: !!decl.RECT_IN_XML[tip],
      diferenta: ultima ? decl.submissionDiff(ultima, acum) : [],
    });
  });

  app.post('/api/declarations/rectificativa', upload.single('file'), (req, res) => {
    let checkpoint = null;
    try {
      const b = req.body || {};
      if (!req.file) return res.status(400).json({ error: 'Rectificativa cere fișierul exact al recipisei.', code: 'FILING_EVIDENCE_RECEIPT_REQUIRED' });
      if (!validFilingUpload(req, res)) return;
      if (!decl.TIPURI[b.tip]) return res.status(400).json({ error: 'Tip de declaratie necunoscut.' });
      if (!/^\d{4}-\d{2}$/.test(String(b.period || ''))) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
      const review = requireFiscalReview(res, 'depunerea rectificativei ' + String(b.tip).toUpperCase() + ' ' + b.period);
      if (!review) return;
      const d = db.get();
      const fid = activeId(req);
      if (!validDossierReference(b, fid, b.tip, b.period, res)) return;
      const rec = decl.find(d, fid, b.tip, b.period);
      if (!rec || !decl.lastSubmission(rec)) {
        return res.status(400).json({ error: 'Nu exista o depunere anterioara pe ' + b.period + ': depune declaratia normal, nu rectificativ.' });
      }
      // Perioada inchisa NU blocheaza rectificativa — asta e chiar scopul ei — dar cere MOTIV SCRIS,
      // pe modelul fortarii inchiderii lunare. Fara motiv, corectia peste o luna deja raportata ar
      // fi invizibila la orice control ulterior.
      const firma = db.getFirma(fid) || {};
      const inchisa = firma.lockedUntil && String(b.period) <= String(firma.lockedUntil);
      const motiv = String(b.motiv || '').trim();
      const recipisa = String(b.recipisa || '').trim();
      if (inchisa && motiv.length < 5) {
        return res.status(400).json({ error: 'Perioada ' + b.period + ' este inchisa. Rectificativa e permisa, dar cere un motiv scris (minim 5 caractere).' });
      }
      if (recipisa.length < 2) {
        return res.status(400).json({ error: 'O rectificativa devine depusa numai cu numarul recipisei/indexul ANAF.' });
      }
      const approvedArtifactHash = decl.approvedArtifactHashOf(rec);
      if (!decl.exactArtifact(rec, approvedArtifactHash)) {
        return res.status(409).json({ error: 'Rectificativa nu poate fi confirmată fără binarul exact ales de aprobare. Generează și aprobă documentul înainte de depunere.' });
      }
      const bytes = fs.readFileSync(req.file.path); const receipt = archivedReceipt(req, bytes);
      const authorization = transitionAuthorization(req, 'declaration.submit', fid);
      const fiscalReviewEvidence = fiscalApprovalEvidence(review);
      checkpoint = dossierCheckpoint(d, fid, b.tip, b.period);
      const r = decl.addSubmission(d, fid, b.tip, b.period, {
        motiv, de: req.user.username, tipRec: b.tipRec, recipisa, receipts: [receipt],
        authorization, documentApproval: rec.documentApproval, fiscalReviewEvidence,
        artifactHash: approvedArtifactHash, generatedArtifactHash: approvedArtifactHash,
        submittedArtifactHash: approvedArtifactHash,
        profileSnapshot: rec.profileSnapshot || fiscalProfile.declarationSnapshot(S(req), b.period, { angajati: S(req).angajati }),
        sume: sumeCheie(S(req), b.tip, b.period),
      }, db.nextId);
      logAudit('declaratie.rectificativa', b.tip.toUpperCase() + ' ' + b.period
        + ' — depunerea #' + r.depunere.ordinal + (inchisa ? ' (perioada inchisa)' : '')
        + (motiv ? ': ' + motiv : '') + ' · recipisă ' + receipt.sha256.slice(0, 12)
        + dossierAuditRef(fid, b.tip, b.period), { req });
      db.save(); checkpoint.commit();
      return res.json({ ok: true, depunere: decl.publicSubmissions([r.depunere])[0],
        depuneri: decl.publicSubmissions(r.rec.depuneri), semnalizataInXml: !!decl.RECT_IN_XML[b.tip] });
    } catch (e) {
      if (checkpoint) checkpoint.rollback();
      return res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
    } finally {
      if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch (_) { /* staging best-effort */ }
    }
  });

  app.post('/api/declarations/set', (req, res) => {
    const b = req.body || {};
    if (!decl.TIPURI[b.tip]) return res.status(400).json({ error: 'Tip de declaratie necunoscut.' });
    if (!/^\d{4}-\d{2}$/.test(String(b.period || ''))) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    if (!decl.STATUSES.includes(b.status)) return res.status(400).json({ error: 'Stare invalida.' });
    if (b.status === 'aprobata') return res.status(409).json({
      error: 'Starea „aprobată” se creează numai prin confirmarea SHA-256 al documentului verificat.',
      code: 'FILING_EVIDENCE_APPROVAL_REQUIRED', endpoint: '/api/declarations/approve',
    });
    if (b.status === 'depusa') return res.status(409).json({
      error: 'Starea „depusă” se confirmă atomic numai cu numărul și fișierul exact al recipisei.',
      code: 'FILING_EVIDENCE_RECEIPT_REQUIRED', endpoint: '/api/declarations/confirm-filed',
    });
    const review = b.status === 'transmisa'
      ? requireFiscalReview(res, 'transmiterea ' + String(b.tip).toUpperCase() + ' ' + b.period) : null;
    if (b.status === 'transmisa' && !review) return;
    const d = db.get();
    const fid = activeId(req);
    if (!validDossierReference(b, fid, b.tip, b.period, res)) return;
    const existent = decl.find(d, fid, b.tip, b.period);
    const recipisa = String(b.recipisa || '').trim();
    const note = String(b.note || '').trim();
    if (existent && existent.status === 'depusa' && b.status !== 'depusa') {
      return res.status(409).json({ error: 'O declaratie depusa nu se retrogradeaza. Pentru corectie foloseste fluxul de rectificativa.' });
    }
    if (existent && existent.status === 'transmisa' && (b.status === 'generata' || b.status === 'nedepusa')) {
      return res.status(409).json({ error: 'O declaratie transmisa nu se retrogradeaza. Marcheaz-o depusa cu recipisa sau eroare cu explicatie.' });
    }
    if (existent && existent.status === 'aprobata' && b.status === 'generata') {
      return res.status(409).json({ error: 'Aprobarea nu se retrage prin selector. Numai generarea unor octeți diferiți revine controlat la „generată”.' });
    }
    if (existent && existent.status !== 'nedepusa' && b.status === 'nedepusa') {
      return res.status(409).json({ error: 'Starea nu se reseteaza la „nedepusa”; istoricul artefactului trebuie pastrat.' });
    }
    if ((b.status === 'generata' || b.status === 'transmisa') && !(existent && existent.artifactHash)) {
      return res.status(400).json({ error: 'Genereaza mai intai fisierul declaratiei; starea „' + b.status + '” trebuie legata de un artefact exact.' });
    }
    if (b.status === 'transmisa') {
      const approvedHash = decl.approvedArtifactHashOf(existent);
      if (!approvedHash) return res.status(409).json({
        error: 'Transmiterea cere aprobarea documentului exact selectat, pe același SHA-256.',
        code: 'FILING_EVIDENCE_APPROVAL_REQUIRED',
      });
      if (!decl.exactArtifact(existent, approvedHash)) return res.status(409).json({
        error: 'Transmiterea cere octeții exacți ai artefactului aprobat, nu ultima versiune disponibilă.',
        code: 'FILING_EVIDENCE_ARTIFACT_REQUIRED',
      });
    }
    if ((b.status === 'eroare' || b.status === 'scutita') && note.length < 3) {
      return res.status(400).json({ error: 'Starea „' + b.status + '” cere o explicatie scurta.' });
    }
    const checkpoint = dossierCheckpoint(d, fid, b.tip, b.period);
    try {
      decl.record(d, fid, b.tip, b.period, {
        status: b.status, recipisa, note, updatedBy: req.user.username,
        authorization: transitionAuthorization(req,
          b.status === 'generata' ? 'declaration.prepare' : 'declaration.submit', fid),
        ...(review ? { documentApproval: existent && existent.documentApproval,
          fiscalReviewEvidence: fiscalApprovalEvidence(review) } : {}),
      }, db.nextId);
      logAudit('declaratie.status', b.tip.toUpperCase() + ' ' + b.period + ' → ' + b.status
        + (b.recipisa ? ' (recipisa ' + b.recipisa + ')' : '') + dossierAuditRef(fid, b.tip, b.period), { req });
      // Depunerea este dovada pasului fiscal, nu o comanda de blocare. Numai ultima actiune din
      // cockpit (sau override-ul administrativ explicit) poate schimba `lockedUntil`.
      db.save(); checkpoint.commit();
    } catch (e) {
      checkpoint.rollback();
      return res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
    }
    res.json({ ok: true, locked: null, rows: decl.registerForFirma(d, S(req), b.period) });
  });

  // Confirmarea depunerii este o singură operațiune: proiecția nu ajunge niciodată la „depusă”
  // dacă numărul sau octeții recipisei lipsesc. Abia după verificarea ambelor se scriu tranziția
  // și prima depunere, consecutive în același lanț append-only.
  app.post('/api/declarations/confirm-filed', upload.single('file'), (req, res) => {
    let checkpoint = null;
    try {
      const b = req.body || {};
      if (!req.file) return res.status(400).json({ error: 'Confirmarea depunerii cere fișierul exact al recipisei.', code: 'FILING_EVIDENCE_RECEIPT_REQUIRED' });
      if (!validFilingUpload(req, res)) return;
      const tip = String(b.tip || ''); const period = String(b.period || '');
      if (!decl.TIPURI[tip] || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
        return res.status(400).json({ error: 'Declarația sau perioada este invalidă.' });
      }
      const recipisa = String(b.recipisa || '').trim();
      if (recipisa.length < 2) return res.status(400).json({
        error: 'Confirmarea depunerii cere numărul recipisei/indexul ANAF.', code: 'FILING_EVIDENCE_RECEIPT_REQUIRED',
      });
      const review = requireFiscalReview(res, 'confirmarea depunerii ' + tip.toUpperCase() + ' ' + period);
      if (!review) return;
      const d = db.get(); const fid = activeId(req);
      if (!validDossierReference(b, fid, tip, period, res)) return;
      const rec = decl.find(d, fid, tip, period);
      if (!rec) return res.status(404).json({ error: 'Declarația nu există în firma activă.' });
      if (rec.status !== 'transmisa') return res.status(409).json({
        error: 'Confirmarea depunerii este permisă numai după starea „transmisă”; starea curentă este „' + String(rec.status || 'nedepusa') + '”.',
        code: 'FILING_TRANSITION_NOT_ALLOWED',
      });
      const transmittedArtifactHash = decl.transmittedArtifactHashOf(rec);
      if (!decl.exactArtifact(rec, transmittedArtifactHash)) return res.status(409).json({
        error: 'Confirmarea cere binarul exact al artefactului transmis.', code: 'FILING_EVIDENCE_ARTIFACT_REQUIRED',
      });
      const bytes = fs.readFileSync(req.file.path); const receipt = archivedReceipt(req, bytes);
      if (!decl.exactContent(receipt)) return res.status(400).json({
        error: 'Fișierul recipisei nu poate fi verificat byte-identic.', code: 'FILING_EVIDENCE_RECEIPT_REQUIRED',
      });
      const authorization = transitionAuthorization(req, 'declaration.submit', fid);
      const fiscalReviewEvidence = fiscalApprovalEvidence(review);
      checkpoint = dossierCheckpoint(d, fid, tip, period);
      decl.record(d, fid, tip, period, {
        status: 'depusa', recipisa, updatedBy: req.user && req.user.username || '',
        authorization, documentApproval: rec.documentApproval, fiscalReviewEvidence, receiptEvidence: receipt,
      }, db.nextId);
      const filed = decl.addSubmission(d, fid, tip, period, {
        de: req.user && req.user.username || '', recipisa, receipts: [receipt],
        authorization, documentApproval: rec.documentApproval, fiscalReviewEvidence,
        artifactHash: transmittedArtifactHash, generatedArtifactHash: transmittedArtifactHash,
        submittedArtifactHash: transmittedArtifactHash,
        profileSnapshot: rec.profileSnapshot || fiscalProfile.declarationSnapshot(S(req), period, { angajati: S(req).angajati }),
        sume: sumeCheie(S(req), tip, period),
      }, db.nextId);
      logAudit('declaratie.depusa', tip.toUpperCase() + ' ' + period + ' · recipisa ' + recipisa
        + ' · SHA-256 ' + receipt.sha256.slice(0, 12) + dossierAuditRef(fid, tip, period), { req });
      db.save(); checkpoint.commit();
      return res.json({ ok: true, locked: null, depunere: decl.publicSubmissions([filed.depunere])[0],
        dossier: decl.publicDossier(filed.rec, fid, tip, period, S(req)),
        rows: decl.registerForFirma(d, S(req), period) });
    } catch (e) {
      if (checkpoint) checkpoint.rollback();
      return res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
    } finally {
      if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch (_) { /* staging best-effort */ }
    }
  });

  // Recipisa este un artefact, nu doar un numar tastat. Fisierul exact (ZIP/XML/PDF) este mutat
  // in registrul depunerii ca base64 + SHA-256; staging-ul multer se sterge imediat.
  app.post('/api/declarations/recipisa-file', upload.single('file'), (req, res) => {
    let checkpoint = null;
    try {
      if (!req.file) return res.status(400).json({ error: 'Selectează fișierul recipisei.' });
      if (!validFilingUpload(req, res)) return;
      const tip = String((req.body || {}).tip || ''); const period = String((req.body || {}).period || '');
      if (!decl.TIPURI[tip] || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return res.status(400).json({ error: 'Declarația sau perioada este invalidă.' });
      if (!validDossierReference(req.body, activeId(req), tip, period, res)) return;
      const rec = decl.find(db.get(), activeId(req), tip, period);
      if (!rec) return res.status(404).json({ error: 'Declarația nu există în firma activă.' });
      const ordinal = Number((req.body || {}).ordinal) || ((rec.depuneri || []).length);
      const submission = (rec.depuneri || []).find((x) => Number(x.ordinal) === ordinal);
      if (!submission || !submission.recipisa) return res.status(409).json({ error: 'Fișierul trebuie legat de o depunere confirmată cu număr de recipisă.' });
      checkpoint = dossierCheckpoint(db.get(), activeId(req), tip, period);
      decl.ensureDossier(rec, activeId(req), tip, period);
      decl.ensureStateLedger(rec, activeId(req), tip, period);
      const bytes = fs.readFileSync(req.file.path); const receipt = archivedReceipt(req, bytes); const sha256 = receipt.sha256;
      const attached = decl.attachReceipt(rec, activeId(req), tip, period, ordinal, receipt, {
        authorization: transitionAuthorization(req, 'declaration.submit', activeId(req)),
        by: req.user && req.user.username || '',
      });
      logAudit('declaratie.recipisa.atasata', tip.toUpperCase() + ' ' + period + ' depunerea #' + ordinal
        + ' · ' + sha256.slice(0, 12) + dossierAuditRef(activeId(req), tip, period), { req });
      db.save(); checkpoint.commit();
      return res.json({ ok: true, ordinal, created: attached.created,
        submissionId: submission.submissionId, submissionHash: submission.submissionHash,
        receipts: decl.publicSubmissions([submission])[0].receipts });
    } catch (e) {
      if (checkpoint) checkpoint.rollback();
      return res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
    } finally {
      if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch (_) { /* staging best-effort */ }
    }
  });

  // Fișierul efectiv transmis poate coincide cu XML-ul generat sau poate fi rezultatul unui
  // validator/semnări externe. Nu suprascriem niciodată artefactul generat: păstrăm un artefact
  // distinct și istoricul motivat al selecției făcute pentru depunere.
  app.post('/api/declarations/artifact-file', upload.single('file'), (req, res) => {
    let checkpoint = null;
    try {
      if (!req.file) return res.status(400).json({ error: 'Selectează fișierul exact care a fost depus.' });
      if (!validFilingUpload(req, res)) return;
      const tip = String((req.body || {}).tip || ''); const period = String((req.body || {}).period || '');
      if (!decl.TIPURI[tip] || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return res.status(400).json({ error: 'Declarația sau perioada este invalidă.' });
      if (!validDossierReference(req.body, activeId(req), tip, period, res)) return;
      const rec = decl.find(db.get(), activeId(req), tip, period);
      if (!rec) return res.status(404).json({ error: 'Declarația nu există în firma activă.' });
      const ordinal = Number((req.body || {}).ordinal) || ((rec.depuneri || []).length);
      const submission = (rec.depuneri || []).find((x) => Number(x.ordinal) === ordinal);
      if (!submission || !submission.artifactHash) return res.status(409).json({ error: 'Fișierul trebuie legat de o depunere care are deja amprenta artefactului generat.' });
      const bytes = fs.readFileSync(req.file.path); const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const selectedBefore = String(submission.submittedArtifactHash || submission.artifactHash || '');
      const reason = String((req.body || {}).reason || '').trim();
      if (sha256 !== selectedBefore && reason.length < 10) return res.status(409).json({
        error: 'Fișierul diferă de artefactul confirmat anterior. Corectarea este permisă fără ștergerea istoriei, dar cere un motiv de minimum 10 caractere.',
        expectedSha256: selectedBefore, actualSha256: sha256, reasonRequired: true,
      });
      checkpoint = dossierCheckpoint(db.get(), activeId(req), tip, period);
      decl.ensureDossier(rec, activeId(req), tip, period);
      decl.ensureStateLedger(rec, activeId(req), tip, period);
      rec.artifacts = Array.isArray(rec.artifacts) ? rec.artifacts : [];
      let artifact = rec.artifacts.find((x) => x.sha256 === sha256);
      const storedNow = !(artifact && artifact.contentBase64);
      if (!artifact) {
        artifact = { sha256, profileHash: submission.profileHash || rec.profileHash || '',
          generatedAt: submission.ts || rec.generatedAt || null, kind: 'submitted', source: 'upload-operator' };
        rec.artifacts.push(artifact);
      }
      artifact.bytes = bytes.length;
      artifact.filename = path.basename(req.file.originalname || rec.artifactFilename || (tip + '-' + period + '.xml')).slice(0, 180);
      artifact.mime = String(req.file.mimetype || 'application/octet-stream').slice(0, 100);
      artifact.contentBase64 = bytes.toString('base64');
      if (storedNow) artifact.originalUploadedAt = new Date().toISOString();
      if (storedNow) artifact.originalUploadedBy = req.user && req.user.username || '';
      artifact.submittedFor = Array.isArray(artifact.submittedFor) ? artifact.submittedFor : [];
      const ref = tip + '|' + period + '|' + ordinal;
      if (!artifact.submittedFor.includes(ref)) artifact.submittedFor.push(ref);
      const correctionAt = new Date().toISOString();
      if (sha256 !== selectedBefore) {
        submission.submittedArtifactHistory = Array.isArray(submission.submittedArtifactHistory)
          ? submission.submittedArtifactHistory : [];
        submission.submittedArtifactHistory.push({ from: selectedBefore, to: sha256,
          at: correctionAt, by: req.user && req.user.username || '', reason: reason.slice(0, 500) });
      }
      submission.generatedArtifactHash = submission.generatedArtifactHash || submission.artifactHash;
      let bindingChange = { previousSubmissionHash: '', submission: decl.submissionEvidence(rec, submission) };
      if (sha256 !== selectedBefore || !submission.submissionId || !submission.submissionHash) {
        bindingChange = decl.resealSubmission(rec, submission, { submittedArtifactHash: sha256 }, {
          at: correctionAt, by: req.user && req.user.username || '', reason,
        });
      }
      submission.submittedArtifactHash = sha256;
      submission.submittedArtifactConfirmedAt = correctionAt;
      submission.submittedArtifactConfirmedBy = req.user && req.user.username || '';
      if (storedNow || sha256 !== selectedBefore) decl.appendStateEvent(rec, activeId(req), tip, period, {
        type: sha256 !== selectedBefore ? 'submitted-artifact.corrected' : 'submitted-artifact.attached',
        from: rec.status, to: rec.status,
        authorization: transitionAuthorization(req, 'declaration.submit', activeId(req)),
        evidence: { ordinal, fromSha256: selectedBefore, toSha256: sha256, bytes: bytes.length,
          filename: artifact.filename, mime: artifact.mime, reason: reason.slice(0, 500),
          previousSubmissionHash: bindingChange.previousSubmissionHash,
          submission: bindingChange.submission },
      });
      logAudit('declaratie.artefact-original.atasat', tip.toUpperCase() + ' ' + period + ' depunerea #' + ordinal
        + ' · ' + sha256.slice(0, 12) + (reason ? ' · ' + reason.slice(0, 200) : '')
        + dossierAuditRef(activeId(req), tip, period), { req });
      db.save(); checkpoint.commit();
      return res.json({ ok: true, ordinal, stored: storedNow, submittedArtifactHash: sha256,
        artifacts: decl.publicArtifacts(rec.artifacts) });
    } catch (e) {
      if (checkpoint) checkpoint.rollback();
      return res.status(e.status || 400).json({ error: e.message || String(e) });
    } finally {
      if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch (_) { /* staging best-effort */ }
    }
  });

  // Arhiva nu este doar o listă de hash-uri: fiecare versiune depusă și fiecare recipisă pot fi
  // recuperate individual. Citirea verifică din nou SHA-256 și dimensiunea înainte de a servi
  // octeții, astfel încât o bază deteriorată să nu livreze o „dovadă” neverificată.
  app.get('/api/declarations/artifact-file', (req, res) => {
    if (!globalDownloadGuard(res)) return;
    const target = filingTarget(req, res); if (!target) return;
    const variant = req.query.variant === 'generated' ? 'generated' : 'submitted';
    const hash = variant === 'generated'
      ? (target.submission.generatedArtifactHash || target.submission.artifactHash)
      : (target.submission.submittedArtifactHash || target.submission.artifactHash);
    const artifact = (target.rec.artifacts || []).find((x) => String(x.sha256 || '') === String(hash || ''));
    const bytes = decl.exactContent(artifact);
    if (!bytes) return res.status(409).json({ error: 'Binarul arhivat nu trece verificarea SHA-256 și nu poate fi descărcat.' });
    return sendArchivedFile(res, artifact, bytes,
      target.tip + '-' + target.period + '-depunere-' + target.ordinal + '.xml');
  });

  app.get('/api/declarations/recipisa-file', (req, res) => {
    if (!globalDownloadGuard(res)) return;
    const target = filingTarget(req, res); if (!target) return;
    const hash = String(req.query.sha256 || '');
    if (!/^[0-9a-f]{64}$/.test(hash)) return res.status(400).json({ error: 'Amprenta recipisei este invalidă.' });
    const receipt = (target.submission.receipts || []).find((x) => String(x.sha256 || '') === hash);
    if (!receipt) return res.status(404).json({ error: 'Recipisa cerută nu aparține acestei depuneri.' });
    const bytes = decl.exactContent(receipt);
    if (!bytes) return res.status(409).json({ error: 'Recipisa arhivată nu trece verificarea SHA-256 și nu poate fi descărcată.' });
    return sendArchivedFile(res, receipt, bytes,
      'recipisa-' + target.tip + '-' + target.period + '-depunere-' + target.ordinal + '.bin');
  });

  app.get('/api/portfolio', (req, res) => {
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    const d = db.get();
    const fids = allowedFirme(req.user);
    const p = decl.portfolio(d, fids.map((id) => db.scoped(id)), period);
    // Imbogatire per firma: forma juridica (SRL/PFA), TVA si starea abonamentului (billing per-firma).
    p.firms.forEach((f) => {
      const firma = db.getFirma(f.firmaId) || {};
      const profile = fiscalProfile.profileAt(db.scoped(f.firmaId), period);
      f.tipEntitate = firma.tipEntitate === 'pfa' ? 'pfa' : 'srl';
      f.tvaPlatitor = profile.tvaPlatitor;
      f.regimImpozit = profile.regim;
      f.d406Cadenta = profile.d406;
      f.sub = plans.firmaStatus(firma);
    });
    // activitate recenta pe firmele accesibile (din jurnalul de audit)
    const recent = (d.audit || []).filter((a) => a.firmaId != null && fids.includes(a.firmaId)).slice(-12).reverse()
      .map((a) => ({ ts: a.ts, username: a.username, action: a.action, detail: a.detail, firma: (db.getFirma(a.firmaId) || {}).nume || '' }));
    res.json(Object.assign(p, { recent }));
  });

  app.get('/api/notifications', (req, res) => {
    const d = db.get();
    const fids = allowedFirme(req.user);
    res.json(decl.notifications(d, fids.map((id) => db.scoped(id))));
  });
};
