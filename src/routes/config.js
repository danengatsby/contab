'use strict';

// Configurare firma si aplicatie — strat SUBTIRE peste src/configService.js: parseaza cererea,
// apeleaza serviciul si traduce erorile lui (`err.status`) in raspunsuri HTTP. Servirea
// logo-ului (citire pura) si redarea PDF a chitantei raman aici; chitanta si logo-ul raspund
// cu TEXT la erori (contract istoric), nu cu JSON.

const fs = require('fs');
const path = require('path');
const db = require('../db');
const pdf = require('../pdf');
const fiscal = require('../fiscal');
const svc = require('../configService');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit, requireAdmin, upload } = ctx;

  // Erorile de business poarta `status` (400/403/404); restul urca la handlerul global (500 + log).
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  app.post('/api/company', (req, res) => run(res, () => {
    const r = svc.updateCompany(activeId(req), req.body);
    return { ok: true, company: r.company };
  }));

  // ── Logo firma (layout documente): apare in antetul tuturor PDF-urilor emise ──
  app.post('/api/company/logo', upload.single('file'), (req, res) => run(res, () => {
    if (!req.file) { const e = new Error('Niciun fisier primit.'); e.status = 400; throw e; }
    const r = svc.setLogo(activeId(req), req.file.path);
    logAudit('company.logo', 'logo incarcat (' + r.format + ')', { req });
    return { ok: true, logoFile: r.logoFile };
  }));
  app.get('/api/company/logo', (req, res) => {
    const f = db.getFirma(activeId(req));
    if (!f || !f.logoFile) return res.status(404).send('Fara logo');
    const p = path.join(db.UPLOAD_DIR, String(f.logoFile).replace(/[^a-zA-Z0-9._-]/g, ''));
    if (!fs.existsSync(p)) return res.status(404).send('Fara logo');
    res.setHeader('Content-Type', /\.png$/i.test(p) ? 'image/png' : 'image/jpeg');
    res.sendFile(p);
  });
  app.delete('/api/company/logo', (req, res) => run(res, () => {
    svc.deleteLogo(activeId(req));
    return { ok: true };
  }));

  // Chitanta tiparibila pentru o incasare in numerar (531x): numarul se atribuie din seria CH
  // la prima tiparire; erorile raman TEXT (ruta serveste PDF, nu JSON).
  app.get('/pdf/chitanta/:id', (req, res) => {
    let r;
    try { r = svc.assignChitanta(activeId(req), req.params.id); } catch (e) {
      if (!e.status) throw e;
      return res.status(e.status).send(e.message);
    }
    if (r.justAssigned) logAudit('chitanta', r.nr + ' pentru ' + (r.entry.partener || r.entry.id), { req });
    pdf.chitantaPdf(res, S(req).company, r.entry, r.suma, r.nr);
  });

  app.post('/api/settings', (req, res) => run(res, () => {
    const r = svc.updateSettings(req.body, req.user && req.user.role === 'admin');
    return { ok: true, settings: r.settings };
  }));

  // Cote fiscale configurabile (admin): CAS/CASS/impozit/TVA/profit/salariu minim etc.
  app.get('/api/fiscal-config', requireAdmin, (req, res) => res.json({ current: fiscal.FISCAL, defaults: fiscal.DEFAULTS, custom: db.get().settings.fiscal || {}, vechime: fiscal.fiscalStaleness(new Date().getFullYear()) }));
  app.post('/api/fiscal-config', requireAdmin, (req, res) => run(res, () => {
    const r = svc.setFiscalConfig(req.body);
    logAudit('fiscal.config', r.reset ? 'reset la valori standard' : 'cote fiscale actualizate', { req, firmaId: null });
    return { ok: true, current: r.current };
  }));
};
