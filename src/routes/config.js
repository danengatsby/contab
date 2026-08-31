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
const balanceCategory = require('../balanceCategory');
const bilant = require('../bilant');
const fiscalControls = require('../fiscalControls');
const fiscalReview = require('../fiscalReview');
const permissions = require('../permissions');
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
    const fid = activeId(req);
    if (Object.keys(req.body || {}).some((key) => fiscalProfile.HISTORIC_FIELDS.includes(key))) {
      permissions.assert(req.user, fid, 'fiscal.manage', db.getFirma(fid));
    }
    const r = svc.updateCompany(fid, req.body, req.user);
    return { ok: true, company: r.company };
  }));

  // Profilul fiscal COMPUT al firmei active — sursa unica din care se deriva declaratiile,
  // alertele si controalele (consumat de UI si de restul aplicatiei, nu boolean-uri ad-hoc).
  app.get('/api/fiscal-profile', (req, res) => {
    const v = S(req);
    res.json(fiscalProfile.profileAt(v, req.query.asOf, { angajati: v.angajati }));
  });

  app.get('/api/fiscal-profile/history', (req, res) => {
    const history = fiscalProfile.historyFor(db.get(), activeId(req));
    res.json({ fields: fiscalProfile.HISTORIC_FIELDS, history: history.slice()
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom)
        || String(b.recordedAt || '').localeCompare(String(a.recordedAt || ''))) });
  });

  // Status READ-ONLY al reviziei de produs. Aprobarea nu se poate fabrica din interfață: registrul
  // semnat și registrul separat al cheilor se gestionează controlat pe server; aici se vede verdictul.
  app.get('/api/fiscal-review', (req, res) => res.json(fiscalReview.status()));

  app.post('/api/fiscal-profile/history', (req, res) => run(res, () => {
    const fid = activeId(req); const firma = db.getFirma(fid);
    permissions.assert(req.user, fid, 'fiscal.manage', firma);
    const r = svc.addFiscalRevision(fid, req.body, req.user);
    logAudit('profil.fiscal.revizie', 'valabilă ' + r.revision.validFrom + ' · înregistrată '
      + r.revision.recordedAt + (r.revision.note ? ': ' + r.revision.note : ''), { req });
    return { ok: true, revision: r.revision, company: r.company, history: r.history };
  }));

  // Incadrarea CONTABILA anuala: indicatori calculati, regula celor doua exercitii si decizia
  // confirmata. Nu foloseste si nu expune `regimImpozit` drept intrare in calcul.
  app.get('/api/balance-category', (req, res) => run(res, () => {
    const year = req.query.year || String(new Date().getFullYear() - 1);
    const v = S(req);
    const confirmation = balanceCategory.confirmationFor(v.balanceCategoryHistory, year);
    const averageEmployees = Object.prototype.hasOwnProperty.call(req.query, 'numarMediuSalariati')
      ? req.query.numarMediuSalariati
      : confirmation && confirmation.indicatorOverrides && confirmation.indicatorOverrides.numarMediuSalariati;
    const assessment = balanceCategory.assess(v, year, { averageEmployees });
    return {
      assessment,
      confirmation,
      confirmedAndCurrent: !!confirmation && confirmation.inputHash === assessment.inputHash,
    };
  }));

  app.get('/api/balance-category/history', (req, res) => {
    const rows = balanceCategory.activeRows(S(req).balanceCategoryHistory)
      .sort((a, b) => Number(b.year) - Number(a.year) || String(b.confirmedAt || '').localeCompare(String(a.confirmedAt || '')));
    res.json({ history: rows, labels: balanceCategory.LABELS });
  });

  app.post('/api/balance-category/confirm', (req, res) => run(res, () => {
    const fid = activeId(req); const firma = db.getFirma(fid);
    const verdict = permissions.assert(req.user, fid, 'balance.category.confirm', firma);
    // Rolul operational `aprobator` spune CE poate face in firma; `tipCont` spune CINE este.
    // Un patron poate consulta calculul, dar confirmarea profesionala ramane la contabil (adminul
    // instalatiei este exceptia operationala, necesara migrarilor si remedierilor controlate).
    const ownsFirma = req.user && (db.get().firme || []).some((x) => Number(x.ownerId) === Number(req.user.id));
    // Aceeasi compatibilitate ca proiectia sesiunii: utilizatorii vechi nu aveau `tipCont`;
    // daca nu sunt proprietari, sunt colaboratori contabili, nu patroni retroactiv inventati.
    const accountingUser = req.user && (req.user.tipCont === 'contabil'
      || (!req.user.tipCont && !ownsFirma));
    if (req.user && req.user.role !== 'admin' && !accountingUser) {
      const e = new Error('Confirmarea categoriei bilanțului trebuie făcută de un cont de contabil cu dreptul dedicat.');
      e.status = 403; throw e;
    }
    const result = svc.confirmBalanceCategory(fid, req.body, req.user, verdict.role);
    logAudit('bilant.categorie.confirmata', result.confirmation.year + ': '
      + result.confirmation.category + (result.confirmation.justification ? ' — ' + result.confirmation.justification : ''), { req });
    return Object.assign({ ok: true }, result);
  }));

  // Dosarul de mapare F10: metadatele sunt versionate append-only. O versiune noua nu rescrie
  // aprobarea veche, iar hash-ul inlantuit face istoricul verificabil.
  app.get('/api/balance-sheet-mappings', (req, res) => {
    const year = String(req.query.year || (new Date().getFullYear() - 1));
    const rows = (S(req).balanceSheetMappings || []).filter((x) => String(x.year) === year)
      .slice().sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')));
    res.json({ year, rows });
  });

  app.post('/api/balance-sheet-mappings', (req, res) => run(res, () => {
    const fid = activeId(req);
    permissions.assert(req.user, fid, 'fiscal.manage', db.getFirma(fid));
    const record = bilant.metadataRecord(S(req), fid, req.body, req.user, db.nextId('bsm'));
    db.get().balance_sheet_mappings.push(record);
    logAudit('bilant.mapare.metadata', record.year + ' · ' + record.account + ' · SHA-256 '
      + record.hash.slice(0, 12) + ' · ' + record.reason, { req });
    db.save();
    return { ok: true, record };
  }));

  app.get('/api/balance-sheet-adjustments', (req, res) => {
    const year = String(req.query.year || (new Date().getFullYear() - 1));
    const rows = (S(req).balanceSheetAdjustments || []).filter((x) => String(x.year) === year)
      .slice().sort((a, b) => String(b.approvedAt || '').localeCompare(String(a.approvedAt || '')));
    res.json({ year, rows });
  });

  app.post('/api/balance-sheet-adjustments', (req, res) => run(res, () => {
    const fid = activeId(req);
    permissions.assert(req.user, fid, 'declaration.approve', db.getFirma(fid));
    const record = bilant.adjustmentRecord(S(req), fid, req.body, req.user, db.nextId('bsa'));
    db.get().balance_sheet_adjustments.push(record);
    logAudit('bilant.ajustare.aprobata', record.year + ' · F10 ' + record.row + ' '
      + (record.amount > 0 ? '+' : '') + record.amount + ' · aprobator ' + record.approvedBy.username
      + ' · SHA-256 ' + record.hash, { req });
    db.save();
    return { ok: true, record };
  }));

  // Raportul reuneste conturile nemapate, metadatele lipsa, registrul ajustarilor si cele trei
  // reconcilieri. Este aceeasi functie consumata de poarta XML, nu o verificare paralela.
  app.get('/api/balance-sheet-controls', (req, res) => run(res, () => {
    const year = String(req.query.year || (new Date().getFullYear() - 1));
    const category = ['micro', 'mic', 'mare'].includes(String(req.query.category || ''))
      ? String(req.query.category) : String((S(req).company || {}).categorieRaportare || 'micro');
    const s = bilant.situatii(S(req), S(req).company, year, category);
    return { year, category, ok: s.reconciliere.ok, blockers: s.blocaje,
      sourceHashes: { curent: bilant.sourceHash(S(req), year),
        precedent: bilant.sourceHash(S(req), Number(year) - 1) },
      reconciliation: s.reconciliere, mappingReport: s.raportMapare };
  }));

  // Controale de coerenta derivate din profil (al treilea pilon, langa declaratii si alerte):
  // semnaleaza date incompatibile cu regimul declarat (neplatitor care colecteaza TVA, micro peste
  // plafon, plafon Intrastat...). ?year=YYYY (implicit anul curent).
  app.get('/api/fiscal-controls', (req, res) => {
    res.json(fiscalControls.check(S(req), { year: req.query.year || String(new Date().getFullYear()),
      period: req.query.period }));
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

  // Registru temporal fiscal: citire completa + publicare append-only cu surse si aprobare.
  app.get('/api/fiscal-config', requireAdmin, (req, res) => {
    const today = new Date().toISOString().slice(0, 10); let current = null;
    try { current = fiscal.rulesAt(today); } catch (_) { /* lipsa acoperirii este raportata de vechime */ }
    res.json({ current, defaults: fiscal.DEFAULTS, ruleSets: fiscal.allRuleSets(),
      registryHash: fiscal.registryHash(), vechime: fiscal.fiscalStaleness(new Date().getFullYear()) });
  });
  app.get('/api/fiscal-rules-at', (req, res) => run(res, () => {
    const r = fiscal.rulesAt(req.query.date);
    return { ruleSetId: r.id, fiscalRulesHash: r.hash, fiscalTreatmentsHash: r.treatmentsHash,
      validFrom: r.validFrom, validTo: r.validTo, rates: r.rates,
      treatments: r.treatments.map((rule) => ({ id: rule.id, hash: rule.hash, title: rule.title,
        domain: rule.domain, risk: rule.risk, legalBasis: rule.legalBasis })) };
  }));
  app.post('/api/fiscal-config', requireAdmin, (req, res) => run(res, () => {
    const r = svc.setFiscalConfig(req.body);
    logAudit('fiscal.rules.publish', r.ruleSet.id + ' · ' + r.ruleSet.validFrom + '..'
      + (r.ruleSet.validTo || '∞') + ' · ' + r.ruleSet.hash, { req, firmaId: null });
    return { ok: true, ruleSet: r.ruleSet, registryHash: fiscal.registryHash() };
  }));
};
