'use strict';

// Rutele de raportare (read-only): situatii financiare (bilant, P&L, fluxuri, capitaluri), recapitulatiile de
// declaratii in PDF (D112/D300/D100/Declaratia Unica), registrele si jurnalele in PDF, plus
// pro-rata si registrul de incasari-plati. Toate depind doar de vederea filtrata pe firma S(req)
// si de modulele de raportare — extrase din server.js fara schimbare de comportament.
// Modul de rute: register(app, ctx), ctx = { S }.

const db = require('../db');
const bunuriCapital = require('../bunuriCapital'); // registrul art. 305 alin. (4)
const ptOpts = require('../profitTaxOptions'); // sursa unica a optiunilor de impozit pe profit
const stmt = require('../statements');
const rep = require('../reporting');
const acc = require('../accounting');
const xml = require('../xml');
const etva = require('../etvaReconcile');
const fiscalProfile = require('../fiscalProfile');
const fiscal = require('../fiscal');
const pdf = require('../pdf');
const dosarAnual = require('../dosarAnual');
const annualArchiveIntegrity = require('../annualArchiveIntegrity');
const globalChain = require('../globalChain');
const auditLog = require('../auditLog');
const annualClose = require('../annualClose');
const permissions = require('../permissions');
const { analyticBalance } = require('../analytic');
const { sendList } = require('../paginate');
const { statPlataPostata } = require('../payroll');

module.exports = function register(app, ctx) {
  const { S, wrap, activeId, logAudit } = ctx;
  const microYield = () => new Promise((resolve) => setImmediate(resolve));

  function globalDownloadGuard(res) {
    try {
      const report = globalChain.verifyGraph(db.get(), { auditResult: auditLog.verify(), requireAudit: true });
      if (!report.ok) {
        res.status(409).json({ error: 'Descărcarea a fost oprită: verificarea globală a lanțului a eșuat.',
          code: 'GLOBAL_CHAIN_INVALID' }); return null;
      }
      res.setHeader('X-Contab-Integrity-Root', report.rootHash);
      return report;
    } catch (_) {
      res.status(409).json({ error: 'Descărcarea a fost oprită: lanțul global nu a putut fi verificat.',
        code: 'GLOBAL_CHAIN_UNAVAILABLE' }); return null;
    }
  }

  // ── Registre si jurnale de baza (JSON) ──
  // Registrul-jurnal + cartea mare: pentru firmele MARI (peste prag) se calculeaza direct in SQL
  // (proiectia entry_lines), altfel din RAM. Rezultat identic; header de diagnostic pe fiecare.
  app.get('/api/journal', wrap(async (req, res) => {
    const fid = activeId(req); const period = req.query.period || null;
    if (db.sqlBalancePeriodOk(period) && db.largeFirma(fid)) {
      res.setHeader('X-Journal-Source', 'sql');
      return res.json(await db.journalSql(fid, period));
    }
    res.setHeader('X-Journal-Source', 'ram');
    res.json(acc.journal(S(req), period));
  }));
  app.get('/api/ledger', wrap(async (req, res) => {
    const fid = activeId(req); const period = req.query.period || null;
    if (db.sqlBalancePeriodOk(period) && db.largeFirma(fid)) {
      res.setHeader('X-Ledger-Source', 'sql');
      return sendList(req, res, await db.ledgerSql(fid, period), { label: 'ledger' });
    }
    res.setHeader('X-Ledger-Source', 'ram');
    sendList(req, res, acc.ledger(S(req), period), { label: 'ledger' });
  }));
  // Fisa de cont: miscarile unui cont cu contul corespondent si sold curent (orice cont din plan).
  // Pentru firmele MARI (peste prag) se interogheaza direct SQL (entry_lines), altfel RAM. Rezultat identic.
  app.get('/api/fisa-cont', wrap(async (req, res) => {
    const cont = req.query.cont; const period = req.query.period || null;
    if (!cont) return res.status(400).json({ error: 'Alege contul (ex. ?cont=4111).' });
    const fid = activeId(req);
    if (db.sqlBalancePeriodOk(period) && db.largeFirma(fid)) {
      res.setHeader('X-FisaCont-Source', 'sql');
      return res.json(await db.trialFisaContSql(fid, cont, period));
    }
    res.setHeader('X-FisaCont-Source', 'ram');
    res.json(acc.fisaCont(S(req), cont, period));
  }));
  app.get('/pdf/fisa-cont', (req, res) => {
    if (!req.query.cont) return res.status(400).send('Alege contul (ex. ?cont=4111).');
    pdf.fisaContPdf(res, S(req).company, acc.fisaCont(S(req), req.query.cont, req.query.period || null));
  });
  // Balanta: pentru firmele MARI (peste prag) se calculeaza direct in SQL (proiectia entry_lines),
  // altfel din RAM. Rezultat identic; header X-Balance-Source expune calea folosita (diagnostic).
  app.get('/api/balance', wrap(async (req, res) => {
    const fid = activeId(req); const period = req.query.period || null;
    if (db.sqlBalancePeriodOk(period) && db.largeFirma(fid)) {
      res.setHeader('X-Balance-Source', 'sql');
      return res.json(await db.trialBalanceSql(fid, period));
    }
    res.setHeader('X-Balance-Source', 'ram');
    res.json(acc.trialBalance(S(req), period));
  }));
  // Raportul articolelor stornate (perechi original -> nota de storno) pentru control intern
  app.get('/api/storno-report', (req, res) => res.json(rep.stornoReport(S(req), req.query.period || null)));
  app.get('/api/vat-preview', (req, res) => { const v = S(req); return res.json(acc.vatClosing(v, acc.vatPeriod(v, req.query.period || null))); });
  app.get('/api/vat-journals', (req, res) => {
    const v = S(req);
    const eff = acc.vatPeriod(v, req.query.period || null); // trimestru la regimul perioadei
    return res.json(Object.assign(acc.vatJournals(v, eff), { period: eff, trimestrial: /^\d{4}-Q[1-4]$/.test(String(eff)) }));
  });
  app.get('/api/tva-neexigibila', (req, res) => res.json(acc.tvaNeexigibila(S(req), req.query.period || null)));
  // Reconciliere TVA (pregatire e-TVA): pozitia perioadei + constatari (cote neconforme, e-Factura netrimise)
  app.get('/api/tva-reconciliere', (req, res) => {
    const v = S(req);
    const eff = acc.vatPeriod(v, req.query.period || null); // trimestru la regimul perioadei
    return res.json(Object.assign(rep.tvaReconciliation(v, eff), { trimestrial: /^\d{4}-Q[1-4]$/.test(String(eff)) }));
  });
  // Reconciliere e-TVA: decontul PRECOMPLETAT ANAF (XML lipit/incarcat) <-> D300-ul propriu, rand-cu-rand.
  // Perioada de comparat: luna/an din decont, sau ?period explicit (regim 'T' -> trimestrul).
  app.post('/api/etva-precompletat', (req, res) => {
    const v = S(req);
    let anaf;
    try { anaf = etva.parseD300((req.body || {}).xml || ''); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const xmlPeriod = /^\d{4}$/.test(anaf.an) && /^\d{1,2}$/.test(anaf.luna) ? anaf.an + '-' + String(anaf.luna).padStart(2, '0') : null;
    const reqPeriod = /^\d{4}-\d{2}$/.test(String(req.query.period || '')) ? req.query.period : null;
    const period = acc.vatPeriod(v, reqPeriod || xmlPeriod || null);
    const own = xml.d300Rows(rep.d300(v, period));
    return res.json(etva.reconcile(own, anaf.rows, {
      period, cuiPropriu: String(v.company.cui || '').replace(/^ro/i, ''),
      anafLuna: anaf.luna, anafAn: anaf.an, anafCui: anaf.cui,
    }));
  });
  app.get('/api/livrabile', (req, res) => res.json(rep.livrabile(S(req), req.query.period || new Date().toISOString().slice(0, 7))));
  // `plafoane` porneste motorul art. 25/40^2; fara el registrul ar arata doar procentele fixe.
  const optPlaf = (req) => ({
    plafoane: fiscal.rulesAt(String(req.query.year || new Date().getFullYear()) + '-12').rates,
    cursEur: Number(req.query.cursEur) || Number((S(req).company || {}).cursEur) || 0,
  });
  app.get('/api/registru-fiscal', (req, res) => res.json(rep.registruFiscal(S(req), req.query.year || String(new Date().getFullYear()), null, optPlaf(req))));
  app.get('/api/cashbook', (req, res) => res.json(acc.cashBankJournal(S(req), req.query.cont || '5121', req.query.period || null)));
  app.get('/api/cash-valuta', (req, res) => res.json(acc.cashRegisterValuta(S(req), req.query.period || null, req.query.moneda || 'EUR')));
  app.get('/api/cash-control', (req, res) => res.json(acc.cashControl(S(req), req.query.cont || '5311', req.query.period || null)));
  app.get('/api/notes', (req, res) => res.json(rep.notes(S(req), req.query.year || String(new Date().getFullYear()))));
  // Registre si jurnale de baza (PDF)
  app.get('/pdf/journal', (req, res) => pdf.journalPdf(res, S(req).company, acc.journal(S(req), req.query.period || null)));
  app.get('/pdf/ledger', (req, res) => pdf.ledgerPdf(res, S(req).company, acc.ledger(S(req), req.query.period || null), req.query.period || null));
  app.get('/pdf/balance', (req, res) => pdf.trialBalancePdf(res, S(req).company, acc.trialBalance(S(req), req.query.period || null)));

  // ── Situatii financiare (JSON) ──
  app.get('/api/statements/pl', (req, res) => res.json(stmt.profitLoss(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/api/statements/pl-f20', (req, res) => res.json(stmt.profitLossF20(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/api/statements/cashflow', (req, res) => res.json(stmt.cashFlow(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/api/statements/equity', (req, res) => res.json(stmt.equityChanges(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/api/statements/bilant', (req, res) => res.json(stmt.balanceSheet(S(req), req.query.period || null)));
  app.get('/api/statements/bilant-f10', (req, res) => res.json(stmt.balanceSheetF10(S(req), req.query.period || null)));

  // ── Situatii financiare (PDF) ──
  app.get('/pdf/pl', (req, res) => {
    const v = S(req); const year = req.query.year || String(new Date().getFullYear());
    pdf.plPdf(res, v.company, stmt.profitLossF20(v, year), stmt.profitLossF20(v, Number(year) - 1), stmt.profitLoss(v, year));
  });
  app.get('/pdf/bilant', (req, res) => {
    const v = S(req); const period = req.query.period || (String(new Date().getFullYear()) + '-12');
    const yr = Number(String(period).slice(0, 4));
    pdf.balanceSheetPdf(res, v.company, stmt.balanceSheetF10(v, period), stmt.balanceSheetF10(v, (yr - 1) + '-12'), stmt.balanceSheet(v, period));
  });

  // ── Recapitulatii declaratii + registre/jurnale (PDF) ──
  app.get('/pdf/vat', (req, res) => { const v = S(req); return pdf.vatPdf(res, v.company, acc.vatJournals(v, acc.vatPeriod(v, req.query.period || null))); });
  app.get('/pdf/d112', (req, res) => {
    const v = S(req); const period = req.query.period || new Date().toISOString().slice(0, 7);
    try {
      const sp = statPlataPostata(v, period);
      return pdf.d112Pdf(res, v.company, Object.assign({ period }, sp.totals));
    } catch (e) {
      if (e.status) return res.status(e.status).send(e.message);
      throw e;
    }
  });
  // (PDF stat de plata / fluturas: src/routes/payroll.js)
  app.get('/pdf/d300', (req, res) => {
    const v = S(req);
    if (!fiscalProfile.profileAt(v, req.query.period).tvaPlatitor) return res.status(400).send('Firma nu e plătitoare de TVA — nu depune D300.');
    const pd = acc.vatPeriod(v, req.query.period || null);
    return pdf.d300Pdf(res, v.company, rep.d300(v, pd));
  });
  app.get('/pdf/d100', (req, res) => pdf.d100Pdf(res, S(req).company, rep.d100micro(S(req), req.query.period || null)));
  // D101 — calculul impozitului pe profit anual (figuri semantice; XML-ul oficial nu e inca generat)
  // Registrul bunurilor de capital (art. 305 alin. (4)) — obligatoriu prin lege. Se DERIVA din
  // articole, deci nu are ruta de scriere: nu exista ce sa salvezi separat.
  app.get('/api/bunuri-capital', (req, res) => res.json(
    bunuriCapital.registru(S(req), { anReferinta: req.query.an })));

  app.get('/api/d101', (req, res) => {
    const v = S(req); const an = req.query.year || String(new Date().getFullYear());
    // ACELEASI reguli ca nota contabila 691 = 4411 (src/profitTaxOptions.js). Chemata fara
    // optiuni, `d101` calculeaza pe profitul contabil brut si raporteaza alt impozit decat cel
    // inregistrat.
    res.json(rep.d101(v, an, ptOpts.pentruDeclaratie(v, an)));
  });
  // Declaratia Unica (PFA, sistem real): estimarea venitului net anual si a CAS/CASS/impozitului
  app.get('/api/declaratia-unica', (req, res) => res.json(rep.declaratiaUnica(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/pdf/declaratia-unica', (req, res) => pdf.declaratiaUnicaPdf(res, S(req).company, rep.declaratiaUnica(S(req), req.query.year || String(new Date().getFullYear()))));
  // Pro-rata TVA (art. 300): definitiva calculata din jurnal + regularizarea achizitiilor mixte
  app.get('/api/pro-rata', (req, res) => res.json(rep.proRataTva(S(req), req.query.year || String(new Date().getFullYear()))));
  // Registrul special al regimului marjei (art. 312 alin. (13)) — obligatoriu la control.
  app.get('/api/registru-marja', (req, res) => res.json(rep.registruMarja(S(req), req.query.period || null)));
  // Registrul-jurnal de incasari si plati (partida simpla, PFA)
  app.get('/api/registru-incasari-plati', (req, res) => res.json(acc.registruIncasariPlati(S(req), req.query.period || null)));
  app.get('/pdf/registru-incasari-plati', (req, res) => pdf.registruIncasariPlatiPdf(res, S(req).company, acc.registruIncasariPlati(S(req), req.query.period || null)));
  // F4109 — declaratie de neutilizare a casei de marcat (o luna). Seria fiscala din ?serie= (sau setarea firmei).
  app.get('/pdf/f4109', (req, res) => {
    const v = S(req);
    const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.period || '')) ? req.query.period : new Date().toISOString().slice(0, 7);
    const seriiRaw = req.query.serie || (v.company && v.company.casaMarcatSerie) || '';
    const aparate = String(seriiRaw).split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ serie: s }));
    pdf.f4109Pdf(res, v.company, { period, aparate });
  });
  app.get('/pdf/obligatii', (req, res) => pdf.obligatiiPdf(res, S(req).company, rep.obligatii(S(req), req.query.period || null)));
  app.get('/api/dosar-anual/status', (req, res) => {
    const year = String(req.query.year || new Date().getFullYear()); const fid = activeId(req);
    const rows = dosarAnual.archiveRows(db.get(), fid, year).map((row) => {
      const check = annualArchiveIntegrity.verifyStored(row);
      return { id: row.id, year: row.year, version: row.version, createdAt: row.createdAt,
        createdByName: row.createdByName, reason: row.reason, fileName: row.fileName, bytes: row.bytes,
        zipSha256: row.zipSha256, contentRootHash: row.contentRootHash, verified: check.ok,
        verificationError: check.ok ? null : check.reason };
    });
    res.json({ year, closed: dosarAnual.isYearClosed(S(req), year), versions: rows });
  });

  // Sigilarea este o SCRIERE explicita, numai dupa finalizarea cockpitului anual. Repetarea este
  // idempotenta; o rectificativa ulterioara creeaza o versiune noua si o pastreaza pe cea veche.
  app.post('/api/dosar-anual/seal', wrap(async (req, res) => {
    const year = String(req.query.year || (req.body || {}).year || new Date().getFullYear()); const fid = activeId(req);
    permissions.assert(req.user, fid, 'annual.manage', db.getFirma(fid));
    const annual = annualClose.status(db.get(), S(req), year);
    if (!annual.sePoateFinaliza) {
      return res.status(409).json({ error: 'Dosarul se sigilează numai după finalizarea cockpitului anual.', blocante: annual.blocante });
    }
    const out = await dosarAnual.seal(db.get(), S(req), year, {
      uploadDir: db.UPLOAD_DIR, nextId: db.nextId, userId: req.user && req.user.id,
      username: req.user && req.user.username, newRevision: !!(req.body || {}).newRevision,
      reason: (req.body || {}).reason,
    });
    if (out.created) { db.save(); logAudit('dosar.anual.sigilat', year + ' v' + out.row.version + ' · ' + out.row.zipSha256.slice(0, 12), { req }); }
    res.json({ ok: true, created: out.created, year, version: out.row.version, fileName: out.row.fileName,
      bytes: out.row.bytes, zipSha256: out.row.zipSha256, contentRootHash: out.row.contentRootHash });
  }));

  // Descarcarea NU genereaza si NU modifica: citeste versiunea persistenta, ii verifica ZIP-ul,
  // toate fisierele si semnatura manifestului, apoi serveste exact octetii sigilati.
  app.get('/api/dosar-anual', wrap(async (req, res) => {
    const year = String(req.query.year || new Date().getFullYear()); const fid = activeId(req);
    permissions.assert(req.user, fid, 'data.export', db.getFirma(fid));
    if (!globalDownloadGuard(res)) return;
    const row = dosarAnual.stored(db.get(), fid, year, req.query.version);
    if (!row) {
      if (!dosarAnual.isYearClosed(S(req), year)) return res.status(409).json({ error: 'Exercițiul ' + year + ' nu este închis.' });
      return res.status(409).json({ error: 'Dosarul anual nu este încă sigilat. Finalizează cockpitul anual și folosește acțiunea de sigilare.' });
    }
    // O versiune deja sigilată este autonomă față de starea live: manifestul ei dovedește anul,
    // firma și închiderea de la momentul sigilării. Pierderea accidentală a unui marcaj derivat de
    // închidere nu are voie să facă artefactul persistent imposibil de recuperat.
    const verified = annualArchiveIntegrity.verifyStored(row);
    if (!verified.ok) return res.status(409).json({ error: 'Arhiva persistentă nu trece verificarea de integritate: ' + verified.reason });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + row.fileName + '"');
    res.setHeader('ETag', '"sha256-' + row.zipSha256 + '"');
    res.send(verified.buffer);
  }));
  app.get('/pdf/registru-inventar', (req, res) => {
    const an = req.query.an || String(new Date().getFullYear());
    pdf.registruInventarPdf(res, S(req).company, rep.registruInventar(S(req), req.query.period || (an + '-12'), an));
  });
  app.get('/pdf/registru-fiscal', (req, res) => pdf.registruFiscalPdf(res, S(req).company, rep.registruFiscal(S(req), req.query.year || String(new Date().getFullYear()), null, optPlaf(req))));
  app.get('/pdf/analytic', (req, res) => pdf.analyticPdf(res, S(req).company, analyticBalance(S(req))));
  app.get('/pdf/cashbook', (req, res) => pdf.cashBookPdf(res, S(req).company, acc.cashBankJournal(S(req), req.query.cont || '5121', req.query.period || null)));
  app.get('/pdf/cash-valuta', (req, res) => pdf.cashValutaPdf(res, S(req).company, acc.cashRegisterValuta(S(req), req.query.period || null, req.query.moneda || 'EUR')));
  app.get('/pdf/note', (req, res) => pdf.notesPdf(res, S(req).company, rep.notes(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/pdf/cashflow', (req, res) => pdf.cashFlowPdf(res, S(req).company, stmt.cashFlow(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/pdf/capital', (req, res) => pdf.equityPdf(res, S(req).company, stmt.equityChanges(S(req), req.query.year || String(new Date().getFullYear()))));
  // Set complet de situatii financiare anuale (bilant + P&L + fluxuri + capitaluri + note) intr-un singur PDF.
  // Setul complet de situatii financiare = 8 calcule grele (fiecare o trecere peste inregistrari)
  // + randare. La volume mari, secventa ar bloca event loop-ul; cedam intre calcule (aceleasi
  // date, doar timing-ul se schimba — PDF-ul e identic), deci alte cereri sunt servite intre ele.
  app.get('/pdf/situatii', wrap(async (req, res) => {
    const v = S(req); const year = req.query.year || String(new Date().getFullYear()); const Y0 = Number(year) - 1;
    const f20cur = stmt.profitLossF20(v, year); await microYield();
    const f20prev = stmt.profitLossF20(v, Y0); await microYield();
    const plDetail = stmt.profitLoss(v, year); await microYield();
    const f10cur = stmt.balanceSheetF10(v, year + '-12'); await microYield();
    const f10prev = stmt.balanceSheetF10(v, Y0 + '-12'); await microYield();
    const bsDetail = stmt.balanceSheet(v, year + '-12'); await microYield();
    const cashFlow = stmt.cashFlow(v, year); await microYield();
    const equity = stmt.equityChanges(v, year); await microYield();
    const notes = rep.notes(v, year);
    pdf.setStatementsPdf(res, v.company, { f20cur, f20prev, plDetail, f10cur, f10prev, bsDetail, cashFlow, equity, notes });
  }));
};
