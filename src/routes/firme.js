'use strict';

// Rutele de firme: listare, creare, editare, activare, stergere, abonare (billing per-firma)
// si export/import complet (JSON + ZIP cu fisierele scanate) pentru migrare/arhivare.
// Modul de rute: register(app, ctx). demoContLock (setari de cont) ramane in server.js
// pentru ca e folosit si de rutele de profil/2FA/SPV.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const AdmZip = require('adm-zip');
const db = require('../db');
const plans = require('../plans');
const billing = require('../billing');

module.exports = function register(app, ctx) {
  const { activeId, allowedFirme, canAccess, requireAdmin, wrap, logAudit } = ctx;

  app.get('/api/firme', (req, res) => {
    const d = db.get();
    const allowed = allowedFirme(req.user);
    const firme = d.firme.filter((f) => allowed.includes(f.id)).map((f) => Object.assign({}, f, { _sub: plans.firmaStatus(f) }));
    res.json({ firme, firmaActiva: activeId(req) });
  });
  // Contul demo (public) nu adauga si nu gestioneaza firme: lucreaza doar pe firma demo,
  // care se reseteaza periodic. Pentru o firma proprie: cont propriu (Inscrie firma).
  function demoFirmeLock(req, res) {
    if (req.user && req.user.username === 'demo') {
      res.status(403).json({ error: 'Contul demo nu poate adăuga sau gestiona firme. Înscrie-ți firma ta (gratuit 30 de zile) dintr-un cont propriu.' });
      return true;
    }
    return false;
  }
  app.post('/api/firme', (req, res) => {
    if (demoFirmeLock(req, res)) return;
    const d = db.get();
    const id = db.nextFirmaId();
    const b = req.body || {};
    const f = Object.assign(db.defaultFirma(id), {
      nume: b.nume || ('Firma ' + id), cui: b.cui || '', regCom: b.regCom || '',
      adresa: b.adresa || '', oras: b.oras || '', judet: b.judet || 'RO-B',
      tvaPlatitor: b.tvaPlatitor != null ? !!b.tvaPlatitor : true,
      tipEntitate: b.tipEntitate === 'pfa' ? 'pfa' : 'srl',
    }, { id });
    // Billing per-firma: firma noua a unui utilizator porneste cu proba de 30 de zile (apoi abonament).
    // Firmele create de admin sunt active direct (adminul nu e taxat).
    f.subscription = req.user.role === 'admin'
      ? { status: 'active', plan: 'grandfathered', since: new Date().toISOString() }
      : plans.firmaTrialSub();
    d.firme.push(f);
    d.partners[id] = {}; d.openingBalances[id] = {};
    // utilizatorul care creeaza firma capata acces (adminul are oricum)
    if (req.user.role !== 'admin') { req.user.firme = req.user.firme || []; req.user.firme.push(id); }
    req.user.firmaActiva = id;
    logAudit('firma.create', f.nume, { req, firmaId: id });
    db.save();
    res.json({ ok: true, firma: f, firmaActiva: id });
  });
  // Export/import complet al unei firme (migrare/arhivare) — inainte de ruta /:id ca sa nu fie prinse de ea
  // mode=replace: SUPRASCRIE firma activa cu datele din copie (cu plasa de siguranta salvata pe server).
  // altfel: fisierul devine o firma NOUA (id-uri remapate), datele existente raman neatinse.
  function restoreTarget(req, res) {
    if (req.query.mode !== 'replace') return { targetFid: null };
    const fid = activeId(req);
    if (!allowedFirme(req.user).includes(fid)) { res.status(403).json({ error: 'Fara acces la firma activa.' }); return null; }
    // plasa de siguranta: starea curenta a firmei, salvata pe server inainte de suprascriere
    try {
      const dir = path.join(db.DATA_DIR, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pre-restore-firma' + fid + '-' + Date.now() + '.json'), JSON.stringify(db.exportFirma(fid)));
    } catch (e) { console.error('pre-restore backup:', e.message); }
    return { targetFid: fid };
  }
  app.post('/api/firme/import', (req, res) => {
    if (demoFirmeLock(req, res)) return;
    try {
      const bundle = (req.body && req.body.firma) ? req.body : (req.body && req.body.bundle);
      const t = restoreTarget(req, res); if (!t) return;
      const newFid = db.importFirma(bundle, { targetFid: t.targetFid });
      if (!t.targetFid && req.user && req.user.role !== 'admin') { req.user.firme = req.user.firme || []; req.user.firme.push(newFid); }
      if (req.user) req.user.firmaActiva = newFid;
      logAudit('firma.import', (t.targetFid ? 'firma ' + newFid + ' SUPRASCRISA din copie' : 'firma noua ' + newFid + ' (restaurare din fisier)'), { req, firmaId: newFid });
      db.save();
      res.json({ ok: true, firmaId: newFid, replaced: !!t.targetFid });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Ramura de testare: cloneaza firma activa intr-o copie marcata [TEST] si comuta pe ea
  app.post('/api/firme/:id/test-clone', (req, res) => {
    if (demoFirmeLock(req, res)) return;
    if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
    try {
      const src = db.getFirma(req.params.id) || {};
      const newFid = db.importFirma(db.exportFirma(req.params.id));
      const nf = db.getFirma(newFid);
      if (nf) { nf.nume = '[TEST] ' + String(src.nume || 'Firma').replace(/^\[TEST\]\s*/, ''); nf.test = true; }
      if (req.user) { req.user.firmaActiva = newFid; if (req.user.role !== 'admin') { req.user.firme = req.user.firme || []; req.user.firme.push(newFid); } }
      logAudit('firma.test-clone', 'firma de test ' + newFid + ' din ' + req.params.id, { req, firmaId: newFid });
      db.save();
      res.json({ ok: true, firmaId: newFid, nume: nf ? nf.nume : '' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  function firmaSlug(bundle) {
    return String((bundle.firma && bundle.firma.nume) || 'firma').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'firma';
  }
  app.get('/api/firme/:id/export', (req, res) => {
    const id = Number(req.params.id);
    if (!allowedFirme(req.user).includes(id)) return res.status(403).json({ error: 'Firma neautorizata.' });
    const bundle = db.exportFirma(id);
    const fname = 'contabo-' + firmaSlug(bundle) + '-' + new Date().toISOString().slice(0, 10) + '.json';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
    res.send(JSON.stringify(bundle, null, 2));
  });
  // Construieste ZIP-ul complet al unei firme: firma.json + fisierele scanate atasate (files/*).
  function firmaZipBuffer(id) {
    const bundle = db.exportFirma(id);
    const zip = new AdmZip();
    zip.addFile('firma.json', Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'));
    let nFiles = 0;
    for (const doc of (bundle.documents || [])) {
      if (!doc.storedName) continue;
      const p = path.join(db.UPLOAD_DIR, path.basename(doc.storedName));
      if (fs.existsSync(p)) { zip.addLocalFile(p, 'files'); nFiles++; }
    }
    return { buffer: zip.toBuffer(), slug: firmaSlug(bundle), nFiles };
  }
  // Copie completa (ZIP) a unei firme.
  app.get('/api/firme/:id/export-zip', (req, res) => {
    const id = Number(req.params.id);
    if (!allowedFirme(req.user).includes(id)) return res.status(403).json({ error: 'Firma neautorizata.' });
    const z = firmaZipBuffer(id);
    logAudit('firma.export', 'copie ZIP (' + z.nFiles + ' fisiere)', { req, firmaId: id });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="contabo-' + z.slug + '-' + new Date().toISOString().slice(0, 10) + '.zip"');
    res.send(z.buffer);
  });
  // Admin: TOATE firmele intr-o singura arhiva — cate un ZIP separat per firma (fiecare restaurabil individual).
  app.get('/api/firme/export-all', requireAdmin, (req, res) => {
    const outer = new AdmZip();
    let n = 0;
    for (const f of db.get().firme) {
      const z = firmaZipBuffer(f.id);
      outer.addFile('firma-' + f.id + '-' + z.slug + '.zip', z.buffer);
      n++;
    }
    logAudit('firma.export', 'export toate firmele (' + n + ' ZIP-uri)', { req });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="contabo-toate-firmele-' + new Date().toISOString().slice(0, 10) + '.zip"');
    res.send(outer.toBuffer());
  });
  // Restaurare din ZIP: extrage firma.json + scrie fisierele sub nume NOI (anti-coliziune), apoi importa.
  const uploadRestore = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
  app.post('/api/firme/import-zip', uploadRestore.single('file'), (req, res) => {
    if (demoFirmeLock(req, res)) return;
    try {
      if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
      const zip = new AdmZip(req.file.buffer);
      const je = zip.getEntry('firma.json');
      if (!je) return res.status(400).json({ error: 'Arhiva nu contine firma.json — nu pare o copie Contabo.' });
      const bundle = JSON.parse(zip.readAsText(je));
      const storedNameMap = {};
      for (const en of zip.getEntries()) {
        if (en.isDirectory || !en.entryName.startsWith('files/')) continue;
        const base = path.basename(en.entryName);
        if (!base) continue;
        const newName = crypto.randomBytes(8).toString('hex') + (path.extname(base) || '.bin');
        fs.writeFileSync(path.join(db.UPLOAD_DIR, newName), en.getData());
        storedNameMap[base] = newName;
      }
      const t = restoreTarget(req, res); if (!t) return;
      const newFid = db.importFirma(bundle, { storedNameMap, targetFid: t.targetFid });
      if (!t.targetFid && req.user && req.user.role !== 'admin') { req.user.firme = req.user.firme || []; req.user.firme.push(newFid); }
      if (req.user) req.user.firmaActiva = newFid;
      logAudit('firma.import', (t.targetFid ? 'firma ' + newFid + ' SUPRASCRISA din ZIP' : 'firma noua ' + newFid) + ' (' + Object.keys(storedNameMap).length + ' fisiere)', { req, firmaId: newFid });
      db.save();
      res.json({ ok: true, firmaId: newFid, files: Object.keys(storedNameMap).length, replaced: !!t.targetFid });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/firme/:id', (req, res) => {
    if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
    const f = db.getFirma(req.params.id);
    if (!f) return res.status(404).json({ error: 'Firma inexistenta' });
    Object.assign(f, req.body || {}, { id: f.id });
    db.save();
    res.json({ ok: true, firma: f });
  });
  app.post('/api/firme/:id/activate', (req, res) => {
    if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
    req.user.firmaActiva = Number(req.params.id);
    db.save();
    res.json({ ok: true, firmaActiva: req.user.firmaActiva });
  });
  // Abonare pe FIRMA (billing strict per-firma): deschide plata Stripe pentru planul potrivit
  // (Start pentru necontabili / Pro pentru contabili) si activeaza abonamentul FIRMEI pe luna curenta,
  // deblocand scrierile. Fiecare firma se plateste separat.
  app.post('/api/firme/:id/subscribe', wrap(async (req, res) => {
    if (demoFirmeLock(req, res)) return;
    if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
    const f = db.getFirma(req.params.id);
    if (!f) return res.status(404).json({ error: 'Firma inexistenta.' });
    // planul: din cerere, altfel dupa tipul utilizatorului (contabil -> Pro, necontabil/tester -> Start)
    const b = req.body || {};
    const plan = b.plan === 'pro' ? 'pro' : b.plan === 'start' ? 'start' : (plans.userKind(req.user) === 'contabil' ? 'pro' : 'start');
    const luna = new Date().toISOString().slice(0, 7);
    const prev = f.subscription || {};
    if (billing.configured()) {
      // PLATA-GATED: NU deblocam optimist. Firma se activeaza abia dupa confirmarea platii (webhook).
      // Marcam doar intentia (pendingPlan) — starea/proba raman neschimbate pana la plata.
      const u = db.get().users.find((x) => x.id === req.user.id);
      let url;
      try { const s = await billing.createCheckoutSession(u, plan, f.id); url = s.url; }
      catch (e) { return res.status(400).json({ error: e.message }); }
      f.subscription = Object.assign({}, prev, { pendingPlan: plan, pendingSince: new Date().toISOString() });
      logAudit('firma.subscribe', 'firma ' + f.id + ' -> checkout ' + plan + ' (in asteptarea platii)', { req, firmaId: f.id });
      db.save();
      return res.json({ ok: true, plan, url, stripe: true, pending: true });
    }
    // Fara Stripe (dev/manual): activare directa a abonamentului firmei.
    f.subscription = {
      status: 'active', plan, since: prev.since || new Date().toISOString(),
      trialEndsAt: prev.trialEndsAt || null,
      abonamente: Object.assign({}, prev.abonamente || {}, { [luna]: plan }),
    };
    logAudit('firma.subscribe', 'firma ' + f.id + ' abonata (' + plan + ') pe ' + luna + ' (fara Stripe)', { req, firmaId: f.id });
    db.save();
    res.json({ ok: true, plan, luna, url: null, stripe: false });
  }));
  app.delete('/api/firme/:id', (req, res) => {
    if (demoFirmeLock(req, res)) return;
    const d = db.get();
    const id = Number(req.params.id);
    const isAdmin = req.user.role === 'admin' && !req.impersonating;
    // Un utilizator obisnuit isi poate sterge doar propriile firme; adminul, orice firma.
    if (!isAdmin && !(req.user.firme || []).includes(id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
    // Garda „cel putin o firma ramane": global pentru admin, respectiv in contul utilizatorului.
    const remaining = isAdmin ? d.firme.length : (req.user.firme || []).length;
    if (remaining <= 1) return res.status(400).json({ error: 'Trebuie sa ramana cel putin o firma.' });
    d.firme = d.firme.filter((f) => f.id !== id);
    d.entries = d.entries.filter((e) => e.firmaId !== id);
    d.documents = d.documents.filter((x) => x.firmaId !== id);
    d.openingAnalytic = d.openingAnalytic.filter((o) => o.firmaId !== id);
    delete d.partners[id]; delete d.openingBalances[id];
    d.users.forEach((u) => { if (Array.isArray(u.firme)) u.firme = u.firme.filter((x) => x !== id); });
    // daca firma stearsa era cea activa a utilizatorului, muta-l pe prima ramasa a lui
    if (req.user.firmaActiva === id) req.user.firmaActiva = (req.user.firme || [])[0] || (d.firme[0] && d.firme[0].id) || null;
    logAudit('firma.delete', 'firma ' + id, { req, firmaId: null });
    db.save();
    res.json({ ok: true });
  });
};
