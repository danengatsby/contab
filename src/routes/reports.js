'use strict';

// Rutele de raportare (read-only): situatii financiare (F20/F10/F30/F40), recapitulatiile de
// declaratii in PDF (D112/D300/D100/Declaratia Unica), registrele si jurnalele in PDF, plus
// pro-rata si registrul de incasari-plati. Toate depind doar de vederea filtrata pe firma S(req)
// si de modulele de raportare — extrase din server.js fara schimbare de comportament.
// Modul de rute: register(app, ctx), ctx = { S }.

const stmt = require('../statements');
const rep = require('../reporting');
const acc = require('../accounting');
const pdf = require('../pdf');
const { analyticBalance } = require('../analytic');

module.exports = function register(app, ctx) {
  const { S, wrap } = ctx;
  const microYield = () => new Promise((resolve) => setImmediate(resolve));

  // ── Registre si jurnale de baza (JSON) ──
  app.get('/api/journal', (req, res) => res.json(acc.journal(S(req), req.query.period || null)));
  app.get('/api/ledger', (req, res) => res.json(acc.ledger(S(req), req.query.period || null)));
  // Fisa de cont: miscarile unui cont cu contul corespondent si sold curent (orice cont din plan)
  app.get('/api/fisa-cont', (req, res) => {
    if (!req.query.cont) return res.status(400).json({ error: 'Alege contul (ex. ?cont=4111).' });
    res.json(acc.fisaCont(S(req), req.query.cont, req.query.period || null));
  });
  app.get('/pdf/fisa-cont', (req, res) => {
    if (!req.query.cont) return res.status(400).send('Alege contul (ex. ?cont=4111).');
    pdf.fisaContPdf(res, S(req).company, acc.fisaCont(S(req), req.query.cont, req.query.period || null));
  });
  app.get('/api/balance', (req, res) => res.json(acc.trialBalance(S(req), req.query.period || null)));
  app.get('/api/vat-preview', (req, res) => res.json(acc.vatClosing(S(req), req.query.period || null)));
  app.get('/api/vat-journals', (req, res) => res.json(acc.vatJournals(S(req), req.query.period || null)));
  app.get('/api/tva-neexigibila', (req, res) => res.json(acc.tvaNeexigibila(S(req), req.query.period || null)));
  app.get('/api/livrabile', (req, res) => res.json(rep.livrabile(S(req), req.query.period || new Date().toISOString().slice(0, 7))));
  app.get('/api/registru-fiscal', (req, res) => res.json(rep.registruFiscal(S(req), req.query.year || String(new Date().getFullYear()))));
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
  app.get('/pdf/vat', (req, res) => pdf.vatPdf(res, S(req).company, acc.vatJournals(S(req), req.query.period || null)));
  app.get('/pdf/d112', (req, res) => pdf.d112Pdf(res, S(req).company, rep.d112(S(req), req.query.period || null)));
  // (PDF stat de plata / fluturas: src/routes/payroll.js)
  app.get('/pdf/d300', (req, res) => pdf.d300Pdf(res, S(req).company, rep.d300(S(req), req.query.period || null)));
  app.get('/pdf/d100', (req, res) => pdf.d100Pdf(res, S(req).company, rep.d100micro(S(req), req.query.period || null)));
  // Declaratia Unica (PFA, sistem real): estimarea venitului net anual si a CAS/CASS/impozitului
  app.get('/api/declaratia-unica', (req, res) => res.json(rep.declaratiaUnica(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/pdf/declaratia-unica', (req, res) => pdf.declaratiaUnicaPdf(res, S(req).company, rep.declaratiaUnica(S(req), req.query.year || String(new Date().getFullYear()))));
  // Pro-rata TVA (art. 300): definitiva calculata din jurnal + regularizarea achizitiilor mixte
  app.get('/api/pro-rata', (req, res) => res.json(rep.proRataTva(S(req), req.query.year || String(new Date().getFullYear()))));
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
  app.get('/pdf/registru-inventar', (req, res) => pdf.registruInventarPdf(res, S(req).company, rep.registruInventar(S(req), req.query.period || null)));
  app.get('/pdf/registru-fiscal', (req, res) => pdf.registruFiscalPdf(res, S(req).company, rep.registruFiscal(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/pdf/analytic', (req, res) => pdf.analyticPdf(res, S(req).company, analyticBalance(S(req))));
  app.get('/pdf/cashbook', (req, res) => pdf.cashBookPdf(res, S(req).company, acc.cashBankJournal(S(req), req.query.cont || '5121', req.query.period || null)));
  app.get('/pdf/cash-valuta', (req, res) => pdf.cashValutaPdf(res, S(req).company, acc.cashRegisterValuta(S(req), req.query.period || null, req.query.moneda || 'EUR')));
  app.get('/pdf/note', (req, res) => pdf.notesPdf(res, S(req).company, rep.notes(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/pdf/cashflow', (req, res) => pdf.cashFlowPdf(res, S(req).company, stmt.cashFlow(S(req), req.query.year || String(new Date().getFullYear()))));
  app.get('/pdf/capital', (req, res) => pdf.equityPdf(res, S(req).company, stmt.equityChanges(S(req), req.query.year || String(new Date().getFullYear()))));
  // Set complet de situatii financiare anuale (F20 + F10 + F30 + F40 + Note) intr-un singur PDF.
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
