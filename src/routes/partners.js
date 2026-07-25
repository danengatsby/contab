'use strict';

// Nomenclatoare si solduri initiale — strat SUBTIRE peste src/partnersService.js: parseaza
// cererea, apeleaza serviciul si traduce erorile lui (`err.status`, plus `err.extra` pentru
// detaliile de dezechilibru la solduri) in raspunsuri HTTP. Citirile raman pe vederea scoped.

const svc = require('../partnersService');

module.exports = function register(app, ctx) {
  const { upload, S, activeId, logAudit, requireAdmin } = ctx;

  // Erorile de business poarta `status` (400/403); `extra` intra in corpul raspunsului
  // (contractul istoric al soldurilor dezechilibrate). Restul urca la handlerul global.
  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json(Object.assign({ error: e.message }, e.extra || {}));
    }
  };

  // Import plan de conturi personalizat din CSV: Cod;Denumire;Clasa;Tip (upsert in customAccounts).
  // requireAdmin fiindca planul de conturi e GLOBAL, partajat de toate firmele (vezi
  // partnersService.importAccounts): fara garda, un cont legat de o singura firma putea redenumi
  // conturi standard pentru toate celelalte — denumirile ajung in cartea mare, balanta, PDF-uri
  // si SAF-T. Aceeasi regula ca la /api/settings: stare globala = doar adminul o scrie.
  app.post('/api/accounts/import', requireAdmin, (req, res) => run(res, () => {
    const r = svc.importAccounts((req.body || {}).csv);
    logAudit('accounts.import', r.importati + ' conturi', { req });
    return { ok: true, importati: r.importati, totalConturi: r.totalConturi };
  }));

  app.get('/api/partners', (req, res) => res.json(S(req).partners));
  app.post('/api/partners', (req, res) => run(res, () => {
    const r = svc.upsertPartner(activeId(req), req.body);
    return { ok: true, partner: r.partner };
  }));
  // Import parteneri din CSV: coloane CUI;Denumire;Adresa;Oras;Judet;Tara (header optional)
  app.post('/api/partners/import', (req, res) => run(res, () => {
    const r = svc.importPartners(activeId(req), (req.body || {}).csv);
    logAudit('partners.import', r.importati + ' parteneri', { req });
    return { ok: true, importati: r.importati, erori: r.erori };
  }));
  // Conversie XLSX (Excel modern) / XLS / DBF (dBASE-FoxPro) -> CSV, pentru fluxurile de import.
  app.post('/api/xlsx-to-csv', upload.single('file'), (req, res) => run(res, () => {
    if (!req.file) { const e = new Error('Niciun fisier primit.'); e.status = 400; throw e; }
    const r = svc.convertUploadToCsv(req.file.path, req.file.originalname);
    return { ok: true, rows: r.rows, csv: r.csv };
  }));

  app.get('/api/opening-analytic', (req, res) => res.json(S(req).openingAnalytic));
  app.post('/api/opening-analytic', (req, res) => run(res, () => {
    const r = svc.saveOpeningAnalytic(activeId(req), req.body);
    return { ok: true, openingAnalytic: r.openingAnalytic };
  }));
  app.delete('/api/opening-analytic/:idx', (req, res) => run(res, () => {
    svc.deleteOpeningAnalytic(activeId(req), req.params.idx);
    return { ok: true };
  }));

  app.get('/api/opening', (req, res) => res.json(S(req).openingBalances));
  app.post('/api/opening', (req, res) => run(res, () => {
    const r = svc.setOpening(activeId(req), (req.body || {}).openingBalances);
    logAudit('opening.set', 'solduri initiale (' + r.conturi + ' conturi, echilibrat)', { req });
    return { ok: true, totalDebit: r.totalDebit, totalCredit: r.totalCredit };
  }));
};
