'use strict';

// Rutele de firme — strat SUBTIRE peste src/firmeService.js: parseaza cererea, apeleaza
// serviciul (care valideaza, aplica regulile si scrie) si traduce erorile lui (`err.status`)
// in raspunsuri HTTP. Autorizarea (apartenenta la firma, blocajul demo, garda de admin) e
// impusa in serviciu, nu doar aici. Modul de rute: register(app, ctx).

const multer = require('multer');
const plans = require('../plans');
const db = require('../db');
const svc = require('../firmeService');
const notify = require('../notify');

module.exports = function register(app, ctx) {
  const { activeId, allowedFirme, requireAdmin, wrap, logAudit } = ctx;

  // Erorile de business poarta `status` (400/403/404); restul urca la handlerul global (500 + log).
  // Daca fn a trimis deja raspunsul (export cu res.send) intoarce undefined — nu mai trimitem nimic.
  const run = (res, fn) => {
    try {
      const out = fn();
      if (out !== undefined) res.json(out);
    } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  app.get('/api/firme', (req, res) => {
    const d = db.get();
    const allowed = allowedFirme(req.user);
    const firme = d.firme.filter((f) => allowed.includes(f.id)).map((f) => Object.assign({}, f, { _sub: plans.firmaStatus(f) }));
    res.json({ firme, firmaActiva: activeId(req) });
  });

  app.post('/api/firme', (req, res) => run(res, () => {
    const r = svc.createFirma(req.user, req.body);
    logAudit('firma.create', r.firma.nume, { req, firmaId: r.firma.id });
    return { ok: true, firma: r.firma, firmaActiva: r.firmaActiva };
  }));

  // Export/import complet al unei firme (migrare/arhivare) — inainte de ruta /:id ca sa nu fie prinse de ea.
  // mode=replace: SUPRASCRIE firma activa cu datele din copie (cu plasa de siguranta salvata pe server).
  app.post('/api/firme/import', (req, res) => run(res, () => {
    const bundle = (req.body && req.body.firma) ? req.body : (req.body && req.body.bundle);
    const r = svc.importBundle(req.user, bundle, { replace: req.query.mode === 'replace', activeFid: activeId(req) });
    logAudit('firma.import', (r.replaced ? 'firma ' + r.firmaId + ' SUPRASCRISA din copie' : 'firma noua ' + r.firmaId + ' (restaurare din fisier)'), { req, firmaId: r.firmaId });
    return { ok: true, firmaId: r.firmaId, replaced: r.replaced };
  }));

  // Ramura de testare: cloneaza firma activa intr-o copie marcata [TEST] si comuta pe ea
  app.post('/api/firme/:id/test-clone', (req, res) => run(res, () => {
    const r = svc.testClone(req.user, req.params.id);
    logAudit('firma.test-clone', 'firma de test ' + r.firmaId + ' din ' + req.params.id, { req, firmaId: r.firmaId });
    return { ok: true, firmaId: r.firmaId, nume: r.nume };
  }));

  app.get('/api/firme/:id/export', (req, res) => run(res, () => {
    const r = svc.exportBundle(req.user, req.params.id);
    const fname = 'contabo-' + r.slug + '-' + new Date().toISOString().slice(0, 10) + '.json';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
    res.send(JSON.stringify(r.bundle, null, 2));
  }));

  // Copie completa (ZIP) a unei firme.
  app.get('/api/firme/:id/export-zip', (req, res) => run(res, () => {
    const z = svc.exportZip(req.user, req.params.id);
    logAudit('firma.export', 'copie ZIP (' + z.nFiles + ' fisiere)', { req, firmaId: Number(req.params.id) });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="contabo-' + z.slug + '-' + new Date().toISOString().slice(0, 10) + '.zip"');
    res.send(z.buffer);
  }));

  // Admin: TOATE firmele intr-o singura arhiva — cate un ZIP separat per firma (restaurabil individual).
  app.get('/api/firme/export-all', requireAdmin, (req, res) => run(res, () => {
    const r = svc.exportAllZip(req.user);
    logAudit('firma.export', 'export toate firmele (' + r.n + ' ZIP-uri)', { req });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="contabo-toate-firmele-' + new Date().toISOString().slice(0, 10) + '.zip"');
    res.send(r.buffer);
  }));

  // Restaurare din ZIP: firma.json + fisierele scanate, importate ca firma noua sau peste cea activa.
  // Plafon DEDICAT per utilizator: arhiva sta in RAM (pana la 200MB) cat se proceseaza —
  // importurile sunt rare prin natura lor, deci plafonul strans nu deranjeaza pe nimeni legitim.
  const uploadGuard = require('../uploadGuard');
  const RATE_IMPORT = Number(process.env.CONTAB_RATE_IMPORT || 10); // importuri/ora/utilizator
  const importLimiter = uploadGuard.userLimit('import-zip', RATE_IMPORT, 'Prea multe importuri de arhive.');
  const uploadRestore = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
  app.post('/api/firme/import-zip', importLimiter, uploadRestore.single('file'), (req, res) => run(res, () => {
    const r = svc.importZip(req.user, req.file && req.file.buffer, { replace: req.query.mode === 'replace', activeFid: activeId(req) });
    logAudit('firma.import', (r.replaced ? 'firma ' + r.firmaId + ' SUPRASCRISA din ZIP' : 'firma noua ' + r.firmaId) + ' (' + r.files + ' fisiere)', { req, firmaId: r.firmaId });
    return { ok: true, firmaId: r.firmaId, files: r.files, replaced: r.replaced };
  }));

  app.post('/api/firme/:id', (req, res) => run(res, () => {
    const r = svc.updateFirma(req.user, req.params.id, req.body);
    return { ok: true, firma: r.firma };
  }));

  // Abonamentul firmei — ruta DEDICATA, doar admin + audit (nu prin editarea de profil).
  app.post('/api/firme/:id/subscription', requireAdmin, (req, res) => run(res, () => {
    const r = svc.setFirmaSubscription(req.user, req.params.id, (req.body || {}).subscription);
    logAudit('firma.subscription', 'firma ' + r.firmaId + ' -> ' + (r.subscription.plan || '?') + '/' + (r.subscription.status || '?'), { req, firmaId: r.firmaId });
    return { ok: true, subscription: r.subscription };
  }));

  app.post('/api/firme/:id/activate', (req, res) => run(res, () => {
    const r = svc.activateFirma(req.user, req.params.id);
    return { ok: true, firmaActiva: r.firmaActiva };
  }));

  // Abonare pe FIRMA (billing strict per-firma): plata Stripe (activare la webhook) sau,
  // fara Stripe (dev/manual), activare directa pe luna curenta.
  app.post('/api/firme/:id/subscribe', wrap(async (req, res) => {
    try {
      const r = await svc.subscribeFirma(req.user, req.params.id, (req.body || {}).plan);
      logAudit('firma.subscribe', r.stripe
        ? 'firma ' + req.params.id + ' -> checkout ' + r.plan + ' (in asteptarea platii)'
        : 'firma ' + req.params.id + ' abonata (' + r.plan + ') pe ' + r.luna + ' (fara Stripe)', { req, firmaId: Number(req.params.id) });
      res.json(Object.assign({ ok: true }, r));
    } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  }));

  app.delete('/api/firme/:id', (req, res) => run(res, () => {
    svc.deleteFirma(req.user, req.params.id, req.impersonating);
    logAudit('firma.delete', 'firma ' + Number(req.params.id), { req, firmaId: null });
    return { ok: true };
  }));

  // ── Colaboratori pe firma ACTIVA (contabil <-> necontabil) ──────────────────────────────
  // Lucreaza pe firma activa (mereu in allowedFirme -> apartenenta implicita). Adaugarea/scoaterea
  // sunt POST/DELETE => garda readonly (un colaborator doar-citire nu poate) si paywall-ul per-firma
  // se aplica automat. VIZUALIZAREA (GET) e permisa si pe demo (firma partajata) — panoul e vizibil
  // pentru demonstratie; doar GESTIONAREA (POST/DELETE) e blocata pe demo.
  function activeFirma(req) {
    const fid = activeId(req);
    if (!fid) { const e = new Error('Nicio firmă activă.'); e.status = 400; throw e; }
    return fid;
  }
  function reqManageFirma(req) {
    const fid = activeFirma(req);
    if (req.user && req.user.username === 'demo') { const e = new Error('Contul demo nu gestionează colaboratori.'); e.status = 403; throw e; }
    return fid;
  }

  app.get('/api/colaboratori', (req, res) => run(res, () => {
    const fid = activeFirma(req);
    return { firmaActiva: fid, colaboratori: svc.listCollaborators(fid), eu: req.user && req.user.id, demo: !!(req.user && req.user.username === 'demo') };
  }));

  app.post('/api/colaboratori', wrap(async (req, res) => {
    try {
      const fid = reqManageFirma(req);
      const b = req.body || {};
      if (b.mod === 'invite') {
        const r = svc.inviteCollaborator(fid, b);
        logAudit('colaborator.invite', r.user.username + ' -> firma ' + fid, { req, firmaId: fid });
        const link = (req.protocol || 'http') + '://' + req.get('host') + '/?invite=' + r.token;
        let emailed = false;
        const smtp = db.get().settings.smtp;
        if (r.user.email && smtp && smtp.host) {
          try { await notify.sendMail(smtp, r.user.email, 'Invitație Contabo', 'Ai fost invitat să colaborezi într-o firmă din Contabo. Setează-ți parola aici:\n' + link); emailed = true; }
          catch (e) { console.error('SMTP invitatie colaborator:', e.message); }
        }
        return res.json({ ok: true, invite: r.user, link, emailed });
      }
      const u = svc.addExistingCollaborator(fid, b);
      logAudit('colaborator.add', u.username + ' -> firma ' + fid, { req, firmaId: fid });
      return res.json({ ok: true, colaborator: u });
    } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  }));

  app.delete('/api/colaboratori/:uid', (req, res) => run(res, () => {
    const fid = reqManageFirma(req);
    const r = svc.removeCollaborator(fid, req.params.uid);
    logAudit('colaborator.remove', r.username + ' <- firma ' + fid, { req, firmaId: fid });
    return { ok: true, removed: r };
  }));
};
