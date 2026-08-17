'use strict';

// Generarea XML-urilor de declaratii (e-Factura, D300/D394/D390/D205/D112, SAF-T) +
// validarea pre-depunere. Contine helperii sendXml, declarantOf (intocmitorul din datele
// personale) si recordDecl (marcheaza declaratia "generata" la descarcarea XML-ului).
// Modul de rute: register(app, ctx).

const db = require('../db');
const ptOpts = require('../profitTaxOptions'); // sursa unica a optiunilor de impozit pe profit
const xml = require('../xml');
const rep = require('../reporting');
const acc = require('../accounting');
const saft = require('../saft');
const bilant = require('../bilant');
const bilantNom = require('../bilantNomenclator');
const pdf = require('../pdf');
const decl = require('../declarations');
const plans = require('../plans');
const declCheck = require('../declarationCheck');
const fiscalProfile = require('../fiscalProfile');
const d107 = require('../d107');
const d301 = require('../d301');
const d307 = require('../d307');
const d311 = require('../d311');
const { statePlata } = require('../payroll');

module.exports = function register(app, ctx) {
  const { S, activeId, canAccess, wrap, logAudit } = ctx;

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
    // `?dupaRezerva=1` pune temei=2 (art. 105 alin. (6) CPF). D300 nu are steag de rectificare:
    // decontul corectat se redepune ca atare — vezi nota din src/declarations.js.
    sendXml(res, xml.d300Xml(v.company, pd300, rep.d300(v, pd300), declarantOf(req),
      { dupaRezerva: req.query.dupaRezerva === '1' }), 'd300.xml');
  });
  app.get('/xml/d394', (req, res) => {
    const v = S(req);
    if (!requireVatPayer(v, res)) return;
    const period = req.query.period || null;
    recordDecl(req, 'd394', period);
    const pd394 = acc.vatPeriod(v.company, period); // agrega trimestrul la regim 'T'
    sendXml(res, xml.d394Xml(v.company, pd394, acc.vatJournals(v, pd394), declarantOf(req), rep.achizitiiPfCarnet(v, pd394)), 'd394.xml');
  });
  // Recapitulatia D394 pe hartie: aceeasi expresie de date ca ruta XML de mai sus, ca sa nu poata
  // drifta una fata de cealalta, si aceeasi agregare (`xml.d394Operatiuni`) din care se compune XML-ul.
  // Pana acum D394 se putea depune fara sa poata fi CITITA — tocmai declaratia unde ochiul prinde
  // un CUI gresit sau un partener lipsa.
  app.get('/pdf/d394', (req, res) => {
    const v = S(req);
    if (!requireVatPayer(v, res)) return;
    const pd394 = acc.vatPeriod(v.company, req.query.period || null);
    return pdf.d394Pdf(res, v.company, {
      period: pd394,
      ops: xml.d394Operatiuni(acc.vatJournals(v, pd394), rep.achizitiiPfCarnet(v, pd394)),
    });
  });
  app.get('/pdf/saft', (req, res) => {
    const year = req.query.year || String(new Date().getFullYear());
    return pdf.saftPdf(res, S(req).company, saft.saftSummary(S(req), year));
  });

  app.get('/api/d390', (req, res) => res.json(rep.d390(S(req), req.query.period || null)));

  app.get('/api/d301', (req, res) => res.json(d301.report(S(req), req.query.period || null)));

  app.get('/xml/d301', (req, res) => {
    const period = req.query.period;
    if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return res.status(400).send('Perioadă invalidă pentru D301 (folosește YYYY-MM).');
    const v = S(req);
    let out;
    const recD301 = decl.find(db.get(), activeId(req), 'd301', period);
    const depusaDeja = !!decl.lastSubmission(recD301);
    try { out = xml.d301Xml(v.company, period, d301.report(v, period), declarantOf(req), { rectificativa: depusaDeja }); }
    catch (e) { return res.status(400).send(e.message); }
    recordDecl(req, 'd301', period);
    sendXml(res, out, 'd301.xml');
  });
  app.get('/api/d307', (req, res) => res.json(d307.report(S(req), req.query.period || null)));

  app.get('/xml/d307', (req, res) => {
    const period = req.query.period;
    if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return res.status(400).send('Perioadă invalidă pentru D307 (folosește YYYY-MM).');
    const v = S(req);
    const recD307 = decl.find(db.get(), activeId(req), 'd307', period);
    const depusaDeja = !!decl.lastSubmission(recD307);
    let out;
    try {
      out = xml.d307Xml(v.company, period, d307.report(v, period), declarantOf(req), {
        rectificativa: depusaDeja,
        dupaRezerva: req.query.dupaRezerva === '1',
        temei: Number(req.query.temei) === 2 ? 2 : 1,
      });
    } catch (e) { return res.status(400).send(e.message); }
    recordDecl(req, 'd307', period);
    sendXml(res, out, 'd307.xml');
  });
  app.get('/api/d311', (req, res) => res.json(d311.report(S(req), req.query.period || null)));

  app.get('/xml/d311', (req, res) => {
    const period = req.query.period;
    if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return res.status(400).send('Perioadă invalidă pentru D311 (folosește YYYY-MM).');
    const v = S(req);
    const recD311 = decl.find(db.get(), activeId(req), 'd311', period);
    const depusaDeja = !!decl.lastSubmission(recD311);
    let out;
    try {
      out = xml.d311Xml(v.company, period, d311.report(v, period), declarantOf(req), {
        rectificativa: depusaDeja,
        dupaRezerva: req.query.dupaRezerva === '1',
        temei: Number(req.query.temei) === 2 ? 2 : 1,
      });
    } catch (e) { return res.status(400).send(e.message); }
    recordDecl(req, 'd311', period);
    sendXml(res, out, 'd311.xml');
  });
  app.get('/xml/d390', (req, res) => {
    const v = S(req);
    recordDecl(req, 'd390', req.query.period);
    sendXml(res, xml.d390Xml(v.company, req.query.period || null, rep.d390(v, req.query.period || null)), 'd390.xml');
  });
  app.get('/api/d205', (req, res) => {
    const y = String(req.query.year || (new Date().getFullYear() - 1));
    if (!/^\d{4}$/.test(y)) return res.status(400).json({ error: 'An invalid pentru D205.' });
    res.json(rep.d205(S(req), y));
  });
  app.get('/xml/d205', (req, res) => {
    const v = S(req); const y = String(req.query.year || (new Date().getFullYear() - 1));
    if (!/^\d{4}$/.test(y)) return res.status(400).send('An invalid pentru D205.');
    const rec = decl.find(db.get(), activeId(req), 'd205', y + '-12');
    const out = xml.d205Xml(v.company, y, rep.d205(v, y), declarantOf(req), {
      rectificativa: !!decl.lastSubmission(rec),
    });
    recordDecl(req, 'd205', y + '-12');
    sendXml(res, out, 'd205-' + y + '.xml');
  });
  app.get('/api/intrastat', (req, res) => {
    const period = req.query.period || null;
    if (period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))) return res.status(400).json({ error: 'Perioadă Intrastat invalidă (folosește YYYY-MM).' });
    res.json(rep.intrastat(S(req), period));
  });
  // (csv/intrastat: src/routes/csv.js)
  // Centralizator Intrastat de lucru. Nu pretindem compatibilitate cu schema oficiala INS pana nu
  // avem toate campurile obligatorii. Descarcarea marcheaza totusi sarcina ca generata in registru.
  app.get('/xml/intrastat', (req, res) => {
    const v = S(req);
    const period = req.query.period;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) return res.status(400).send('Perioadă Intrastat invalidă (folosește YYYY-MM).');
    recordDecl(req, 'intrastat', period);
    sendXml(res, xml.intrastatXml(v.company, period, rep.intrastat(v, period)), 'intrastat-centralizator-' + period + '.xml');
  });
  // D100 — trimestrial, dupa REGIMUL firmei: impozit micro (cod 121) sau impozit pe profit
  // (cod 103, art. 41); descarcarea marcheaza declaratia "generata" in registru
  app.get('/xml/d100', (req, res) => {
    const v = S(req);
    const period = req.query.period || null;
    const r = rep.d100(v, period);
    // REFUZ, nu declaratie cu zero. La sistemul anual de impozit pe profit (art. 41), plata
    // anticipata are nevoie de impozitul anului precedent SI de indicele preturilor de consum;
    // fara ele suma ar iesi 0, iar zero e o suma perfect plauzibila pe D100 — deci ar pleca la
    // ANAF o declaratie FALSA, nu una lipsa, si nimic n-ar semnala. Acelasi tipar ca la /xml/d177,
    // care refuza cand sumele redirectionate nu se sustin.
    if (r.blocat) {
      return res.status(400).send('Nu se poate genera D100: ' + (r.avertismente || []).join(' '));
    }
    recordDecl(req, 'd100', period);
    sendXml(res, xml.d100Xml(v.company, period, r, declarantOf(req)), 'd100-' + (period || 'trim') + '.xml');
  });
  // D710 — rectificarea unei D100 DEJA depuse. Valoarea initiala vine exclusiv din fotografia
  // depunerii din registru; recalcularea ei din datele actuale ar face I=C si ar ascunde corectia.
  app.get('/xml/d710', (req, res) => {
    const period = req.query.period;
    if (!/^\d{4}-\d{2}$/.test(String(period || ''))) {
      return res.status(400).send('Perioadă invalidă pentru D710 (folosește YYYY-MM).');
    }
    const v = S(req);
    const rec = decl.find(db.get(), activeId(req), 'd100', period);
    const depuneri = (rec && Array.isArray(rec.depuneri)) ? rec.depuneri : [];
    const dep = decl.lastSubmission(rec);
    let initial = dep && dep.sume;
    if (!initial || !Number.isFinite(Number(initial.impozit)) || !initial.codOblig || !initial.codBugetar) {
      return res.status(400).send('D710 cere o D100 depusă anterior cu fotografia fiscală păstrată. '
        + 'Pentru depunerile vechi fără aceste date, completează rectificarea în aplicația ANAF.');
    }
    const current = rep.d100(v, period);
    if (current.blocat) {
      return res.status(400).send('Nu se poate genera D710: ' + (current.avertismente || []).join(' '));
    }
    let corrected = current;
    // Dupa ce rectificativa a fost marcata depusa, ultima fotografie este deja valoarea C si
    // contabilitatea curenta ii este egala. Pastram posibilitatea de a redescarca EXACT D710
    // depusa: I = fotografia penultima, C = ultima. Daca apar alte modificari ulterior, `current`
    // difera din nou de ultima si devine in mod natural urmatoarea corectie.
    const aceeasiSuma = Math.round(Number(initial.impozit)) === Math.round(Number(current.impozit));
    if (aceeasiSuma && dep && dep.rectificativa && depuneri.length > 1) {
      const penultima = depuneri[depuneri.length - 2];
      if (penultima && penultima.sume) { initial = penultima.sume; corrected = dep.sume; }
    }
    let out;
    try { out = xml.d710Xml(v.company, period, initial, corrected, declarantOf(req)); }
    catch (e) { return res.status(400).send(e.message); }
    recordDecl(req, 'd100', period); // pastreaza `depusa`; actualizeaza doar data ultimei generari
    sendXml(res, out, 'd710-' + period + '.xml');
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
    sendXml(res, xml.d101Xml(v.company, rep.d101(v, year, ptOpts.pentruDeclaratie(v, year)), declarantOf(req)), 'd101-' + year + '.xml');
  });
  // Nomenclatoarele antetului de bilant, pentru listele din Setari. Valorile sunt cele EXTRASE
  // din validatorul oficial ANAF — servite de aici ca sa existe o singura sursa; o lista copiata
  // in frontend ar putea drifta fata de ce accepta ANAF.
  app.get('/api/bilant-nomenclator', (req, res) => res.json(bilantNom.optiuni()));

  // Situatiile financiare ANUALE (S1120 microentitati / S1121 entitati mici).
  // Categoria vine din ?categorie=, implicit dupa regimul fiscal al firmei: micro -> S1120.
  // Antetul cere date pe care doar firma le stie (administrator, intocmitor, forma de
  // proprietate). Daca lipsesc, REFUZAM generarea si spunem exact ce — un formular cu antet
  // inventat trece validatorul si ajunge la ANAF ca declaratie gresita.
  // D107 — declarația anuală a beneficiarilor sponsorizărilor/mecenatului.
  function raportD107(v, year) {
    const po = ptOpts.pentruDeclaratie(v, year);
    const pt = po.rezultatFiscal || acc.profitTax(v, year, po);
    return d107.report(v, year, pt);
  }
  app.get('/api/d107', (req, res) => {
    const year = String(req.query.year || (new Date().getFullYear() - 1));
    if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'An invalid pentru D107.' });
    res.json(raportD107(S(req), year));
  });
  app.get('/xml/d107', (req, res) => {
    const year = String(req.query.year || (new Date().getFullYear() - 1));
    if (!/^\d{4}$/.test(year)) return res.status(400).send('An invalid pentru D107.');
    const v = S(req);
    if (!fiscalProfile.build(v.company).profit) {
      return res.status(400).send('D107 în forma valabilă din 2024 se depune de plătitorii de impozit pe profit, nu de microîntreprinderi/PFA.');
    }
    const rec = decl.find(db.get(), activeId(req), 'd107', year + '-12');
    let out;
    try {
      out = xml.d107Xml(v.company, raportD107(v, year), declarantOf(req), {
        rectificativa: !!decl.lastSubmission(rec),
      });
    } catch (e) { return res.status(400).send(e.message); }
    recordDecl(req, 'd107', year + '-12');
    sendXml(res, out, 'd107-' + year + '.xml');
  });

  // D177 — cerere de redirectionare a impozitului catre beneficiari (sponsorizari).
  // Refuza generarea cand beneficiarilor le lipsesc date: un IBAN gresit trimite banii altcuiva,
  // iar validatorul ANAF nu are cum sa prinda asta — acceptă orice IBAN care incepe cu RO.
  app.get('/xml/d177', (req, res) => {
    const v = S(req);
    const year = String(req.query.year || (new Date().getFullYear() - 1));
    const d = rep.d177(v, year);
    if (!d.beneficiari.length) return res.status(400).json({ error: 'Nicio sponsorizare inregistrata in ' + year + ' (cont 6582) — nu exista ce redirectiona.' });
    if (d.sumaRest <= 0) return res.status(400).json({ error: 'Creditul de sponsorizare pe ' + year + ' e deja folosit integral in declaratia de impozit; nu mai ramane nimic de redirectionat.' });
    if (d.lipsa.length) return res.status(400).json({ error: 'Date lipsa la beneficiari (completeaza-le in Parteneri): ' + d.lipsa.join('; ') });
    // Validatorul ANAF nu prinde depasirea (probat), dar legea o impune: nu poti redirectiona
    // mai mult decat ti-a ramas. Refuzam noi, altfel cererea pleaca si e respinsa la fond.
    if (d.depaseste) return res.status(400).json({ error: 'Sumele beneficiarilor (' + d.total + ' lei) depasesc ce mai poate fi redirectionat (' + d.sumaRest + ' lei). Ajusteaza sumele.' });
    recordDecl(req, 'd177', year + '-12');
    sendXml(res, xml.d177Xml(v.company, d), 'd177-' + year + '.xml');
  });

  app.get('/xml/bilant', (req, res) => {
    const v = S(req);
    const year = String(req.query.year || (new Date().getFullYear() - 1));
    const implicit = fiscalProfile.build(v.company).micro ? 'micro' : 'mic';
    const categorie = ['micro', 'mic', 'mare'].includes(req.query.categorie) ? req.query.categorie : implicit;
    const s = bilant.situatii(v, v.company, year, categorie);
    if (s.lipsa.length) {
      return res.status(400).send('Situațiile financiare nu pot fi generate — completează în Setări → Firmă: '
        + s.lipsa.join('; ') + '.');
    }
    recordDecl(req, 'bilant', year + '-12'); // registrul lucreaza pe perioade lunare
    // Reziduul de rotunjire absorbit in rezultatul reportat NU blocheaza generarea — formularul
    // torna si e acceptat de ANAF — dar peste pragul de rotunjire pleaca in jurnal, ca sa existe o
    // urma. E singurul simptom al unui cont care nu cade pe randul potrivit, iar validatorul nu
    // are cum sa-l vada.
    if (s.avertismente && s.avertismente.length) {
      logAudit('bilant.rezidual', year + ': ' + s.avertismente.join(' | '), { req });
    }
    sendXml(res, xml.bilantXml(s), s.antet.formular.cod.toLowerCase() + '-bilant-' + year + '.xml');
  });

  app.get('/xml/d112', (req, res) => {
    const v = S(req);
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    recordDecl(req, 'd112', period);
    // Steagul de rectificare se DERIVA din istoricul depunerilor, nu se cere din interfata: daca
    // exista deja o depunere pe perioada, urmatorul XML e rectificativ prin definitie. O bifa
    // manuala ar putea fi uitata, si D112-ul ar pleca la ANAF ca declaratie initiala.
    const recD112 = decl.find(db.get(), activeId(req), 'd112', period);
    const depusaDeja = !!decl.lastSubmission(recD112);
    sendXml(res, xml.d112Xml(v.company, period, statePlata(v.angajati, period, v.payrollHistory), declarantOf(req),
      { rectificativa: depusaDeja, tipRec: req.query.tipRec }), 'd112-' + period + '.xml');
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
  // Validare pre-depunere: genereaza XML-ul declaratiei si verifica bine-format + campuri
  // obligatorii. Logica sta in src/declarationCheck.js — acelasi verdict il foloseste si
  // cockpitul de inchidere lunara („dovada validarii"), deci nu are voie sa existe in doua locuri.
  app.get('/api/validate/:type', (req, res) => {
    const type = req.params.type;
    if (!declCheck.TYPES.includes(type)) return res.status(400).json({ error: 'Tip de declaratie necunoscut: ' + type });
    try {
      res.json(declCheck.validateFor(S(req), type, {
        period: req.query.period || null,
        year: req.query.year || String(new Date().getFullYear()),
        declarant: declarantOf(req),
      }));
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  app.get('/api/saft', (req, res) => res.json(saft.saftSummary(S(req), req.query.year || String(new Date().getFullYear()))));
};
