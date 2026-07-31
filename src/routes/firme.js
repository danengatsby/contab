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
const { isDemoUser } = require('../session');

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
  // ── Cereri de acces la o firma EXISTENTA (contabil care preia firma unui client) ──
  // Inregistrate INAINTEA rutelor cu parametru: `/api/firme/:id` se potriveste si cu
  // „cerere-acces", deci le-ar inghiti si ar raspunde „Fara acces la aceasta firma".
  // Raspunsul e generic prin constructie (vezi serviciul): ruta nu are voie sa devina un oracol
  // prin care se afla ce firme exista in sistem.
  app.post('/api/firme/cerere-acces', (req, res) => run(res, () => {
    const r = svc.cerereAcces(req.user, (req.body || {}).cui);
    logAudit('firma.cerere-acces', 'cerere trimisa (CUI ' + String((req.body || {}).cui || '').slice(0, 20) + ')', { req, firmaId: null });
    return r;
  }));
  app.get('/api/firme/cereri', (req, res) => run(res, () => ({ cereri: svc.cereriPrimite(req.user) })));

  // ── Angajarea unui contabil: patron -> contabil (sensul invers fata de cererea de acces) ──
  // Tot INAINTEA rutelor cu parametru, din acelasi motiv: `/api/firme/:id` ar inghiti „contabili".
  app.get('/api/firme/contabili', (req, res) => run(res, () => ({ contabili: svc.listaContabili(req.user) })));
  app.get('/api/firme/servicii', (req, res) => run(res, () => svc.cereriServicii(req.user)));
  app.post('/api/firme/servicii', (req, res) => run(res, () => {
    const b = req.body || {};
    const r = svc.cerereServicii(req.user, b.firmaId, b);
    logAudit('firma.cerere-servicii', 'cerere catre ' + r.contabil, { req, firmaId: r.firmaId });
    return r;
  }));
  app.post('/api/firme/servicii/:id', (req, res) => run(res, () => {
    const r = svc.decideServicii(req.user, req.params.id, !!(req.body || {}).accept);
    logAudit('firma.servicii-' + r.status, 'firma ' + r.firmaId, { req, firmaId: r.firmaId });
    return r;
  }));
  app.post('/api/firme/servicii/:id/retrage', (req, res) => run(res, () => {
    const r = svc.retrageServicii(req.user, req.params.id);
    logAudit('firma.servicii-retrasa', 'cerere ' + req.params.id, { req, firmaId: null });
    return r;
  }));
  app.post('/api/firme/cereri/:id', (req, res) => run(res, () => {
    const r = svc.decideCerere(req.user, req.params.id, !!(req.body || {}).aprob);
    logAudit('firma.cerere-' + r.status, 'firma ' + r.firmaId, { req, firmaId: r.firmaId });
    return r;
  }));

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

  // A doua perioada de proba, ceruta explicit de utilizator dupa ce prima a expirat.
  app.post('/api/firme/:id/trial', wrap(async (req, res) => {
    try {
      const r = await svc.trialDinNou(req.user, req.params.id);
      logAudit('firma.trial', 'firma ' + req.params.id + ' -> proba ' + r.trialCount + '/' + plans.TRIAL_MAX, { req, firmaId: Number(req.params.id) });
      res.json(Object.assign({ ok: true }, r));
    } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
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
  // se aplica automat. VIZUALIZAREA (GET) e libera si pe demo. GESTIONAREA pe conturile demo e
  // permisa DOAR pe perechea demo<->demo-contabil (demonstratia patron<->contabil) — nu invitatii
  // noi, nu conturi arbitrare.
  function activeFirma(req) {
    const fid = activeId(req);
    if (!fid) { const e = new Error('Nicio firmă activă.'); e.status = 400; throw e; }
    return fid;
  }
  // Pe demo: tinta trebuie sa fie contul demo pereche; conturile reale nu au restrictia.
  function demoManageGuard(req, targetUsername) {
    if (!isDemoUser(req.user)) return;
    const counterpart = req.user.username === 'demo' ? 'demo-contabil' : 'demo';
    if (String(targetUsername || '').toLowerCase() !== counterpart) {
      const e = new Error('În contul demo poți gestiona doar contul „' + counterpart + '" (demonstrația patron↔contabil). Într-un cont propriu adaugi pe oricine.');
      e.status = 403; throw e;
    }
  }

  app.get('/api/colaboratori', (req, res) => run(res, () => {
    const fid = activeFirma(req);
    return { firmaActiva: fid, colaboratori: svc.listCollaborators(fid), eu: req.user && req.user.id, demo: isDemoUser(req.user) };
  }));

  app.post('/api/colaboratori', wrap(async (req, res) => {
    try {
      const fid = activeFirma(req);
      const b = req.body || {};
      if (b.mod === 'invite') {
        if (isDemoUser(req.user)) { const e = new Error('În contul demo nu poți crea invitații noi. Adaugă contul demo pereche pentru demonstrație.'); e.status = 403; throw e; }
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
      demoManageGuard(req, b.username || b.email); // demo: doar contul pereche
      const u = svc.addExistingCollaborator(fid, b);
      logAudit('colaborator.add', u.username + ' -> firma ' + fid, { req, firmaId: fid });
      return res.json({ ok: true, colaborator: u });
    } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  }));

  app.delete('/api/colaboratori/:uid', (req, res) => run(res, () => {
    const fid = activeFirma(req);
    if (isDemoUser(req.user)) { const t = db.get().users.find((u) => u.id === Number(req.params.uid)); demoManageGuard(req, t && t.username); }
    const r = svc.removeCollaborator(fid, req.params.uid);
    logAudit('colaborator.remove', r.username + ' <- firma ' + fid, { req, firmaId: fid });
    return { ok: true, removed: r };
  }));
};
