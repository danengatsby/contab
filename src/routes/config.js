'use strict';

// Configurare firma si aplicatie: datele firmei (companie), logo-ul (validat PNG/JPEG, apare in
// antetul PDF-urilor emise), chitanta tiparibila pentru incasari in numerar (531x), setarile
// aplicatiei si cotele fiscale configurabile (admin). Modul de rute: register(app, ctx).
// ensureDocSeries e infrastructura partajata (serii de documente), primita prin ctx.

const fs = require('fs');
const path = require('path');
const db = require('../db');
const pdf = require('../pdf');
const fiscal = require('../fiscal');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit, requireAdmin, upload, ensureDocSeries } = ctx;

  app.post('/api/company', (req, res) => {
    const f = db.getFirma(activeId(req));
    const b = Object.assign({}, req.body || {});
    delete b.logoFile; // logo-ul se administreaza doar prin rutele dedicate (fisier validat)
    if (f) Object.assign(f, b, { id: f.id });
    db.save();
    res.json({ ok: true, company: f });
  });

  // ── Logo firma (layout documente): apare in antetul tuturor PDF-urilor emise ──
  app.post('/api/company/logo', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
    const p = req.file.path;
    let head;
    try { head = fs.readFileSync(p).slice(0, 4); } catch (e) { return res.status(400).json({ error: 'Fisier ilizibil.' }); }
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
    const isJpg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
    if (!isPng && !isJpg) {
      try { fs.unlinkSync(p); } catch (_) { /* */ }
      return res.status(400).json({ error: 'Logo-ul trebuie sa fie PNG sau JPEG (PDF-urile nu accepta alte formate).' });
    }
    const f = db.getFirma(activeId(req));
    if (!f) return res.status(400).json({ error: 'Firma inexistenta.' });
    if (f.logoFile) { try { fs.unlinkSync(path.join(db.UPLOAD_DIR, f.logoFile)); } catch (_) { /* logo vechi deja sters */ } }
    f.logoFile = path.basename(p);
    logAudit('company.logo', 'logo incarcat (' + (isPng ? 'PNG' : 'JPEG') + ')', { req });
    db.save();
    res.json({ ok: true, logoFile: f.logoFile });
  });
  app.get('/api/company/logo', (req, res) => {
    const f = db.getFirma(activeId(req));
    if (!f || !f.logoFile) return res.status(404).send('Fara logo');
    const p = path.join(db.UPLOAD_DIR, String(f.logoFile).replace(/[^a-zA-Z0-9._-]/g, ''));
    if (!fs.existsSync(p)) return res.status(404).send('Fara logo');
    res.setHeader('Content-Type', /\.png$/i.test(p) ? 'image/png' : 'image/jpeg');
    res.sendFile(p);
  });
  app.delete('/api/company/logo', (req, res) => {
    const f = db.getFirma(activeId(req));
    if (f && f.logoFile) {
      try { fs.unlinkSync(path.join(db.UPLOAD_DIR, f.logoFile)); } catch (_) { /* deja sters */ }
      delete f.logoFile;
      db.save();
    }
    res.json({ ok: true });
  });

  // Chitanta tiparibila pentru o incasare in numerar (531x): numarul se atribuie din seria CH la prima tiparire
  app.get('/pdf/chitanta/:id', (req, res) => {
    const d = db.get();
    const e = d.entries.find((x) => x.id === req.params.id && (x.firmaId == null ? d.firmaActiva : x.firmaId) === activeId(req));
    if (!e) return res.status(404).send('Inregistrare inexistenta');
    const suma = e.lines.reduce((s, l) => s + (/^531/.test(String(l.debit)) ? l.suma : 0), 0);
    if (suma <= 0) return res.status(400).send('Inregistrarea nu este o incasare in numerar (531x) — chitanta se emite doar pentru incasari in casa.');
    if (!e.chitantaNr) {
      const s = ensureDocSeries(d, activeId(req)).CH;
      e.chitantaNr = s.serie + '-' + String(s.next).padStart(5, '0');
      s.next += 1;
      logAudit('chitanta', e.chitantaNr + ' pentru ' + (e.partener || e.id), { req });
      db.save();
    }
    pdf.chitantaPdf(res, S(req).company, e, Math.round(suma * 100) / 100, e.chitantaNr);
  });

  app.post('/api/settings', (req, res) => {
    const d = db.get();
    d.settings = Object.assign({}, d.settings, req.body || {});
    db.save();
    res.json({ ok: true, settings: d.settings });
  });

  // Cote fiscale configurabile (admin): CAS/CASS/impozit/TVA/profit/salariu minim etc.
  app.get('/api/fiscal-config', requireAdmin, (req, res) => res.json({ current: fiscal.FISCAL, defaults: fiscal.DEFAULTS, custom: db.get().settings.fiscal || {} }));
  app.post('/api/fiscal-config', requireAdmin, (req, res) => {
    const d = db.get();
    const b = req.body || {};
    if (b.reset) { delete d.settings.fiscal; fiscal.applyConfig({}); logAudit('fiscal.config', 'reset la valori standard', { req, firmaId: null }); }
    else {
      const cfg = Object.assign({}, d.settings.fiscal || {});
      for (const k of Object.keys(fiscal.DEFAULTS)) { if (b[k] != null && b[k] !== '' && Number.isFinite(Number(b[k]))) cfg[k] = Number(b[k]); }
      d.settings.fiscal = cfg;
      fiscal.applyConfig(cfg);
      logAudit('fiscal.config', 'cote fiscale actualizate', { req, firmaId: null });
    }
    db.save();
    res.json({ ok: true, current: fiscal.FISCAL });
  });
};
