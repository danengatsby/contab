'use strict';

// Generarea XML-urilor de declaratii (e-Factura, D300/D394/D390/D205/D112, SAF-T) +
// validarea pre-depunere. Contine helperii sendXml, declarantOf (intocmitorul din datele
// personale) si recordDecl (marcheaza declaratia "generata" la descarcarea XML-ului).
// Modul de rute: register(app, ctx).

const db = require('../db');
const xml = require('../xml');
const rep = require('../reporting');
const acc = require('../accounting');
const saft = require('../saft');
const pdf = require('../pdf');
const decl = require('../declarations');
const plans = require('../plans');
const validate = require('../validate');
const { statePlata } = require('../payroll');

module.exports = function register(app, ctx) {
  const { S, activeId } = ctx;

  function sendXml(res, str, filename) {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
    res.send(str);
  }

  app.get('/xml/efactura/:id', (req, res) => {
    const d = db.get();
    const e = d.entries.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).send('Inregistrare inexistenta');
    if (!xml.isEFacturaEligible(e)) return res.status(400).send('Inregistrarea nu este o factura emisa.');
    const fid = e.firmaId || db.firmaActiva();
    sendXml(res, xml.eFacturaXml(db.getFirma(fid) || {}, e, d.partners[fid] || {}), 'efactura-' + (e.document || e.id) + '.xml');
  });
  // PDF vizual al unei facturi emise (generat din articolul contabil).
  app.get('/pdf/factura/:id', (req, res) => {
    const d = db.get();
    const e = d.entries.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).send('Inregistrare inexistenta');
    const fid = e.firmaId || db.firmaActiva();
    pdf.facturaPdf(res, db.getFirma(fid) || {}, e, d.partners[fid] || {});
  });
  // Declarantul pentru XML-urile ANAF — din datele personale ale utilizatorului (Setari -> Contul meu)
  function declarantOf(req) {
    const p = (req.user && req.user.profil) || {};
    if (!p.numeComplet) return null;
    const parts = String(p.numeComplet).trim().split(/\s+/);
    const nume = parts.pop() || '';
    return { nume, prenume: parts.join(' '), functie: plans.userKind(req.user) === 'contabil' ? 'Contabil' : 'Administrator' };
  }

  // Registrul depunerilor: descarcarea XML-ului marcheaza declaratia (firma, tip, luna) drept „generata"
  function recordDecl(req, tip, period) {
    if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return;
    try {
      decl.record(db.get(), activeId(req), tip, period, { status: 'generata', generatedAt: new Date().toISOString(), updatedBy: req.user && req.user.username }, db.nextId);
      db.save();
    } catch (e) { console.error('registru declaratii:', e.message); }
  }

  app.get('/xml/d300', (req, res) => {
    const v = S(req);
    recordDecl(req, 'd300', req.query.period);
    sendXml(res, xml.d300Xml(v.company, req.query.period || null, rep.d300(v, req.query.period || null), declarantOf(req)), 'd300.xml');
  });
  app.get('/xml/d394', (req, res) => {
    const v = S(req);
    recordDecl(req, 'd394', req.query.period);
    sendXml(res, xml.d394Xml(v.company, req.query.period || null, acc.vatJournals(v, req.query.period || null), declarantOf(req)), 'd394.xml');
  });
  app.get('/api/d390', (req, res) => res.json(rep.d390(S(req), req.query.period || null)));
  app.get('/xml/d390', (req, res) => {
    const v = S(req);
    recordDecl(req, 'd390', req.query.period);
    sendXml(res, xml.d390Xml(v.company, req.query.period || null, rep.d390(v, req.query.period || null)), 'd390.xml');
  });
  app.get('/api/d205', (req, res) => res.json(rep.d205(S(req), req.query.year || new Date().getFullYear())));
  app.get('/xml/d205', (req, res) => {
    const v = S(req); const y = req.query.year || new Date().getFullYear();
    sendXml(res, xml.d205Xml(v.company, y, rep.d205(v, y)), 'd205.xml');
  });
  app.get('/api/intrastat', (req, res) => res.json(rep.intrastat(S(req), req.query.period || null)));
  // (csv/intrastat: src/routes/csv.js)
  app.get('/xml/d112', (req, res) => {
    const v = S(req);
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    recordDecl(req, 'd112', period);
    sendXml(res, xml.d112Xml(v.company, period, statePlata(v.angajati, period), declarantOf(req)), 'd112-' + period + '.xml');
  });
  app.get('/xml/saft', (req, res) => {
    const v = S(req);
    // D406 se depune lunar/trimestrial: ?period=YYYY-MM genereaza luna; ?year= ramane pentru anual
    const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.period || '')) ? req.query.period : null;
    const year = req.query.year || String(new Date().getFullYear());
    recordDecl(req, 'saft', period || (year + '-12'));
    sendXml(res, saft.saftXml(v, period || year), 'saft-d406-' + (period || year) + '.xml');
  });

  // Validare pre-depunere: genereaza XML-ul declaratiei si verifica bine-format + campuri obligatorii.
  app.get('/api/validate/:type', (req, res) => {
    const v = S(req); const type = req.params.type;
    const period = req.query.period || null;
    const year = req.query.year || String(new Date().getFullYear());
    let x = '';
    try {
      if (type === 'd300') x = xml.d300Xml(v.company, period, rep.d300(v, period), declarantOf(req));
      else if (type === 'd394') x = xml.d394Xml(v.company, period, acc.vatJournals(v, period), declarantOf(req));
      else if (type === 'd390') x = xml.d390Xml(v.company, period, rep.d390(v, period));
      else if (type === 'd205') x = xml.d205Xml(v.company, year, rep.d205(v, year));
      else if (type === 'd112') x = xml.d112Xml(v.company, period, statePlata(v.angajati, period), declarantOf(req));
      else if (type === 'saft') x = saft.saftXml(v, year);
      else return res.status(400).json({ error: 'Tip de declaratie necunoscut: ' + type });
    } catch (e) { return res.status(400).json({ error: e.message }); }
    res.json(Object.assign({ type, period }, validate.validateDeclaration(type, x, { cui: v.company.cui })));
  });
  app.get('/api/saft', (req, res) => res.json(saft.saftSummary(S(req), req.query.year || String(new Date().getFullYear()))));
};
