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
const bnr = require('../bnr');
const fiscalProfile = require('../fiscalProfile');
const fiscalControls = require('../fiscalControls');
const svc = require('../configService');
const log = require('../log');

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

  // Profilul fiscal COMPUT al firmei active — sursa unica din care se deriva declaratiile,
  // alertele si controalele (consumat de UI si de restul aplicatiei, nu boolean-uri ad-hoc).
  app.get('/api/fiscal-profile', (req, res) => {
    const v = S(req);
    res.json(fiscalProfile.build(v.company, { angajati: v.angajati }));
  });

  // Controale de coerenta derivate din profil (al treilea pilon, langa declaratii si alerte):
  // semnaleaza date incompatibile cu regimul declarat (neplatitor care colecteaza TVA, micro peste
  // plafon, plafon Intrastat...). ?year=YYYY (implicit anul curent).
  app.get('/api/fiscal-controls', (req, res) => {
    res.json(fiscalControls.check(S(req), { year: req.query.year || String(new Date().getFullYear()) }));
  });

  // ── Logo firma (layout documente): apare in antetul tuturor PDF-urilor emise ──
  app.post('/api/company/logo', upload.single('file'), (req, res) => run(res, () => {
    if (!req.file) { const e = new Error('Niciun fisier primit.'); e.status = 400; throw e; }
    const r = svc.setLogo(activeId(req), req.file.path);
    logAudit('company.logo', 'logo incarcat (' + r.format + ')', { req });
    return { ok: true, logoFile: r.logoFile };
  }));
  // „Firma nu are logo" e o stare NORMALA, nu o eroare — si de aceea raspunsul e 204, nu 404.
  // Cu 404, fiecare firma fara logo lasa o linie rosie in consola browserului la fiecare intrare
  // in „Firma mea": interfata trata corect raspunsul (ascundea previzualizarea), deci nimic nu se
  // vedea stricat, dar zgomotul asta conteaza acum ca aplicatia isi raporteaza erorile din client
  // — cu cat consola e mai curata, cu atat un semnal real se vede mai usor.
  // 404 ramane pentru ce chiar LIPSESTE: firma insasi.
  app.get('/api/company/logo', (req, res) => {
    const f = db.getFirma(activeId(req));
    if (!f) return res.status(404).send('Firma nu exista');
    if (!f.logoFile) return res.status(204).end();
    const p = path.join(db.UPLOAD_DIR, String(f.logoFile).replace(/[^a-zA-Z0-9._-]/g, ''));
    if (!fs.existsSync(p)) {
      // Baza spune ca exista un logo, discul spune ca nu: pentru client e tot „fara logo", dar
      // pentru noi e o NEPOTRIVIRE reala (fisier sters pe langa aplicatie, restaurare partiala).
      // Se scrie in jurnal, ca sa nu dispara tacut — nu poate spama, ruta se atinge doar cand
      // cineva deschide „Firma mea".
      log.warn('logo lipsa pe disc, desi firma il are inregistrat', { firmaId: f.id, logoFile: f.logoFile });
      return res.status(204).end();
    }
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

  // ── Curs de schimb BNR ──────────────────────────────────────────────────
  // Cursul la o DATA (nu cel de azi): o factura din martie se evalueaza la cursul din martie.
  // Zi nelucratoare -> ultimul curs publicat inainte, cu `exact:false` ca sa se vada in interfata
  // ca s-a folosit cursul altei zile. Lipsa cursului NU e eroare: se raspunde cu null si
  // utilizatorul tasteaza cursul, ca inainte.
  app.get('/api/curs-bnr', (req, res) => {
    const d = db.get();
    const colectie = d.cursuriBnr || [];
    const { moneda, data } = req.query;
    if (moneda) {
      const zi = data || new Date().toISOString().slice(0, 10);
      const r = bnr.rateAt(colectie, moneda, zi);
      return res.json({ moneda: String(moneda).toUpperCase(), data: zi, rezultat: r, valute: bnr.currencies(colectie) });
    }
    const ultima = colectie.length ? colectie.map((x) => x.id).sort().slice(-1)[0] : null;
    res.json({ zile: colectie.length, ultimaZi: ultima, valute: bnr.currencies(colectie) });
  });

  // Reimprospatare la cerere (admin): ziua curenta sau un an intreg de istoric (`?an=2026`).
  app.post('/api/curs-bnr/refresh', requireAdmin, async (req, res) => {
    try {
      const an = req.query.an || (req.body || {}).an;
      const randuri = an ? await bnr.fetchYear(String(an)) : await bnr.fetchDaily();
      const d = db.get();
      d.cursuriBnr = Array.isArray(d.cursuriBnr) ? d.cursuriBnr : [];
      const r = bnr.upsertRates(d.cursuriBnr, randuri);
      if (r.adaugate || r.actualizate) db.save();
      logAudit('curs.bnr', (an ? 'an ' + an : 'ziua curenta') + ': ' + r.adaugate + ' zile noi, ' + r.actualizate + ' actualizate', { req });
      res.json({ ok: true, adaugate: r.adaugate, actualizate: r.actualizate, zile: d.cursuriBnr.length });
    } catch (e) {
      // 503, nu 500: serviciul extern e jos, aplicatia e sanatoasa — iar cursul tastat manual
      // ramane disponibil, deci nu s-a pierdut nicio capacitate.
      res.status(503).json({ error: 'Cursul BNR nu e disponibil acum: ' + (e.message || e) + ' Poti introduce cursul manual.' });
    }
  });

  // Cote fiscale configurabile (admin): CAS/CASS/impozit/TVA/profit/salariu minim etc.
  app.get('/api/fiscal-config', requireAdmin, (req, res) => res.json({ current: fiscal.FISCAL, defaults: fiscal.DEFAULTS, custom: db.get().settings.fiscal || {}, vechime: fiscal.fiscalStaleness(new Date().getFullYear()) }));
  app.post('/api/fiscal-config', requireAdmin, (req, res) => run(res, () => {
    const r = svc.setFiscalConfig(req.body);
    logAudit('fiscal.config', r.reset ? 'reset la valori standard' : 'cote fiscale actualizate', { req, firmaId: null });
    return { ok: true, current: r.current };
  }));
};
