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
const fiscalProfile = require('../fiscalProfile');
const { statePlata } = require('../payroll');

module.exports = function register(app, ctx) {
  const { S, activeId, canAccess, wrap } = ctx;

  // Guard de profil: D300/D394 (decontul TVA) nu se genereaza pentru o firma NEPLATITOARE de TVA.
  function requireVatPayer(v, res) {
    if (fiscalProfile.build(v.company).tvaPlatitor) return true;
    res.status(400).send('Firma nu e plătitoare de TVA — nu depune D300/D394. Activează regimul TVA în Setări dacă e cazul.');
    return false;
  }

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
    if (e.status && e.status !== 'postat') return res.status(400).send('Factura e ciorna — posteaz-o inainte de a emite e-Factura.');
    const fid = e.firmaId || db.firmaActiva();
    if (!canAccess(req, fid)) return res.status(404).send('Inregistrare inexistenta'); // izolare multi-firma
    sendXml(res, xml.eFacturaXml(db.getFirma(fid) || {}, e, d.partners[fid] || {}), 'efactura-' + (e.document || e.id) + '.xml');
  });
  // PDF vizual al unei facturi emise (generat din articolul contabil).
  // Modelul vine din setarea firmei (pdfLayout) sau punctual din ?layout=clasic|compact|detaliat.
  app.get('/pdf/factura/:id', (req, res) => {
    const d = db.get();
    const e = d.entries.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).send('Inregistrare inexistenta');
    const fid = e.firmaId || db.firmaActiva();
    if (!canAccess(req, fid)) return res.status(404).send('Inregistrare inexistenta'); // izolare multi-firma
    pdf.facturaPdf(res, db.getFirma(fid) || {}, e, d.partners[fid] || {}, req.query.layout);
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
    if (!requireVatPayer(v, res)) return;
    recordDecl(req, 'd300', req.query.period);
    const pd300 = acc.vatPeriod(v.company, req.query.period || null); // agrega trimestrul la regim 'T'
    sendXml(res, xml.d300Xml(v.company, pd300, rep.d300(v, pd300), declarantOf(req)), 'd300.xml');
  });
  app.get('/xml/d394', (req, res) => {
    const v = S(req);
    if (!requireVatPayer(v, res)) return;
    const period = req.query.period || null;
    recordDecl(req, 'd394', period);
    const pd394 = acc.vatPeriod(v.company, period); // agrega trimestrul la regim 'T'
    sendXml(res, xml.d394Xml(v.company, pd394, acc.vatJournals(v, pd394), declarantOf(req), rep.achizitiiPfCarnet(v, pd394)), 'd394.xml');
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
  // Intrastat XML — se depune la INS (aplicatia Intrastat online), nu intra in registrul ANAF
  app.get('/xml/intrastat', (req, res) => {
    const v = S(req);
    const period = req.query.period || null;
    sendXml(res, xml.intrastatXml(v.company, period, rep.intrastat(v, period)), 'intrastat-' + (period || 'luna') + '.xml');
  });
  // D100 — impozit micro (trimestrial); descarcarea marcheaza declaratia "generata" in registru
  app.get('/xml/d100', (req, res) => {
    const v = S(req);
    const period = req.query.period || null;
    recordDecl(req, 'd100', period);
    sendXml(res, xml.d100Xml(v.company, period, rep.d100micro(v, period), declarantOf(req)), 'd100-' + (period || 'trim') + '.xml');
  });
  // D101 — impozitul pe profit ANUAL (?year=). Doar pentru firmele in regim de profit;
  // schema oficiala v10 (an sfarsit exercitiu >=2024). Descarcarea marcheaza declaratia in registru.
  app.get('/xml/d101', (req, res) => {
    const v = S(req);
    if (!fiscalProfile.build(v.company).profit) {
      return res.status(400).send('Firma nu e in regim de impozit pe profit — nu depune D101. Setează regimul „profit" în Setări dacă e cazul.');
    }
    const year = req.query.year || String(new Date().getFullYear());
    recordDecl(req, 'd101', year + '-12'); // registrul lucreaza pe perioade lunare; D101 = decembrie
    sendXml(res, xml.d101Xml(v.company, rep.d101(v, year), declarantOf(req)), 'd101-' + year + '.xml');
  });
  app.get('/xml/d112', (req, res) => {
    const v = S(req);
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    recordDecl(req, 'd112', period);
    sendXml(res, xml.d112Xml(v.company, period, statePlata(v.angajati, period, v.payrollHistory), declarantOf(req)), 'd112-' + period + '.xml');
  });
  app.get('/xml/saft', wrap(async (req, res) => {
    const v = S(req);
    // D406 se depune lunar/trimestrial: ?period=YYYY-MM genereaza luna; ?year= ramane pentru anual
    const monthReq = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.period || '')) ? req.query.period : null;
    // D406 urmeaza perioada TVA: platitor trimestrial -> trimestrul; altfel luna ceruta
    const period = monthReq ? acc.vatPeriod(v.company, monthReq) : null;
    const year = req.query.year || String(new Date().getFullYear());
    recordDecl(req, 'saft', monthReq || (year + '-12'));
    // saftXmlAsync: output byte-identic cu saftXml, dar cedeaza event loop-ul in buclele grele
    // (nu blocheaza celelalte cereri cat timp se genereaza SAF-T-ul la volume mari).
    // ?tip=C genereaza declaratia de STOCURI (la cerere ANAF); implicit L (lunar) / A (anual)
    const tip = req.query.tip === 'C' ? 'C' : undefined;
    sendXml(res, await saft.saftXmlAsync(v, period || year, tip), 'saft-d406' + (tip ? '-stocuri' : '') + '-' + (period || year) + '.xml');
  }));

  // Validare pre-depunere: genereaza XML-ul declaratiei si verifica bine-format + campuri obligatorii.
  app.get('/api/validate/:type', (req, res) => {
    const v = S(req); const type = req.params.type;
    const period = req.query.period || null;
    const year = req.query.year || String(new Date().getFullYear());
    let x = '';
    try {
      const pv = acc.vatPeriod(v.company, period); // D300/D394: agrega trimestrul la regim 'T'
      if (type === 'd300') x = xml.d300Xml(v.company, pv, rep.d300(v, pv), declarantOf(req));
      else if (type === 'd394') x = xml.d394Xml(v.company, pv, acc.vatJournals(v, pv), declarantOf(req), rep.achizitiiPfCarnet(v, pv));
      else if (type === 'd390') x = xml.d390Xml(v.company, period, rep.d390(v, period));
      else if (type === 'd100') x = xml.d100Xml(v.company, period, rep.d100micro(v, period), declarantOf(req));
      else if (type === 'd101') x = xml.d101Xml(v.company, rep.d101(v, year), declarantOf(req));
      else if (type === 'intrastat') x = xml.intrastatXml(v.company, period, rep.intrastat(v, period));
      else if (type === 'd205') x = xml.d205Xml(v.company, year, rep.d205(v, year));
      else if (type === 'd112') x = xml.d112Xml(v.company, period, statePlata(v.angajati, period, v.payrollHistory), declarantOf(req));
      else if (type === 'saft') x = saft.saftXml(v, year);
      else return res.status(400).json({ error: 'Tip de declaratie necunoscut: ' + type });
    } catch (e) { return res.status(400).json({ error: e.message }); }
    const result = validate.validateDeclaration(type, x, { cui: v.company.cui });
    // D100: adauga avertismentele de eligibilitate micro (plafon venituri + conditia de salariat)
    if (type === 'd100') result.warnings.push(...(rep.d100micro(v, period).avertismente || []));
    res.json(Object.assign({ type, period }, result));
  });
  app.get('/api/saft', (req, res) => res.json(saft.saftSummary(S(req), req.query.year || String(new Date().getFullYear()))));
};
