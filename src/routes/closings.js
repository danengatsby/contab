'use strict';

// Inchideri fiscale: regularizarea TVA (lunara/trimestriala, cu blocarea perioadei),
// inchiderea anuala a conturilor de venituri/cheltuieli in 121, impozitul pe profit
// (cu ajustari fiscale + reportarea pierderii) si repartizarea rezultatului (121 <-> 117).
// Modul de rute: register(app, ctx).

const db = require('../db');
const acc = require('../accounting');
const coa = require('../chartOfAccounts');
const fiscal = require('../fiscal');

module.exports = function register(app, ctx) {
  const { S, activeId, logAudit } = ctx;

  app.post('/api/close-vat', (req, res) => {
    const period = req.query.period;
    // Inchiderea TVA e strict LUNARA/trimestriala: cere o luna (YYYY-MM), nu un an — altfel data
    // notei ar fi malformata (YYYY-28) si blocarea perioadei ineficienta.
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) return res.status(400).json({ error: 'Perioada trebuie sa fie o luna (YYYY-MM).' });
    const d = db.get();
    const firma = db.getFirma(activeId(req));
    const v = acc.vatClosing(S(req), period);
    if (v.lines.length) {
      d.entries.push({
        id: db.nextId('e'), firmaId: activeId(req), data: period + '-28', period, tip: 'inchidere_tva', tipNume: 'Inchidere TVA',
        partener: '', document: 'Nota TVA ' + period, explicatie: 'Regularizare TVA',
        fileId: null, system: true, lines: v.lines,
      });
    }
    // Inchiderea lunii BLOCHEAZA perioada (read-only) — nu se mai poate inregistra/sterge in ea fara deblocare (admin).
    if (firma && (!firma.lockedUntil || period > firma.lockedUntil)) firma.lockedUntil = period;
    logAudit('inchidere.tva', period + ' (perioada blocata)', { req });
    db.save();
    res.json({ ok: true, result: v, lockedUntil: firma ? firma.lockedUntil : null, message: v.lines.length ? undefined : 'Fara TVA de regularizat; perioada a fost blocata.' });
  });

  app.post('/api/close-year', (req, res) => {
    const year = req.query.year;
    if (!year) return res.status(400).json({ error: 'Lipseste anul (YYYY).' });
    const d = db.get();
    const c = acc.annualClosing(S(req), year);
    if (!c.lines.length) return res.json({ ok: true, message: 'Nimic de inchis.', result: c });
    const data = year + '-12-31';
    d.entries.push({
      id: db.nextId('e'), firmaId: activeId(req), data, period: year + '-12', tip: 'inchidere_an', tipNume: 'Inchidere conturi venituri/cheltuieli',
      partener: '', document: 'Inchidere ' + year, explicatie: 'Inchidere clasa 6 si 7 in contul 121',
      fileId: null, system: true, lines: c.lines,
    });
    logAudit('inchidere.an', year, { req });
    db.save();
    res.json({ ok: true, result: c });
  });

  // Impozit pe profit — calcul cu ajustari fiscale (nedeductibile, deduceri, pierdere reportata) + 691 = 4411.
  function profitTaxOpts(req, year) {
    const firma = db.getFirma(activeId(req)) || {};
    const losses = firma.pierdereFiscala || {};
    const src = Object.assign({}, req.query, req.body || {});
    const pr = (src.pierdereReportata != null && src.pierdereReportata !== '') ? Number(src.pierdereReportata) : (Number(losses[Number(year) - 1]) || 0);
    return {
      cota: fiscal.FISCAL.impozitProfit,
      cheltNedeductibile: Number(src.cheltNedeductibile) || 0,
      deduceri: Number(src.deduceri) || 0,
      pierdereReportata: pr || 0,
    };
  }
  app.get('/api/profit-tax-preview', (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    res.json(acc.profitTax(S(req), year, profitTaxOpts(req, year)));
  });
  app.post('/api/close-profit-tax', (req, res) => {
    const year = req.query.year || (req.body || {}).year;
    if (!year) return res.status(400).json({ error: 'Lipseste anul (YYYY).' });
    const d = db.get(); const fid = activeId(req);
    const exists = d.entries.find((e) => e.firmaId === fid && e.tip === 'impozit_profit' && e.period === year + '-12');
    if (exists) return res.status(400).json({ error: 'Impozitul pe profit pe ' + year + ' este deja inregistrat.' });
    const pt = acc.profitTax(S(req), year, profitTaxOpts(req, year));
    // memoreaza pierderea fiscala de reportat (chiar daca impozitul e 0), pentru anii urmatori
    const firma = db.getFirma(fid);
    if (firma) { firma.pierdereFiscala = firma.pierdereFiscala || {}; firma.pierdereFiscala[year] = pt.pierdereDeReportat; }
    if (!pt.lines.length) { db.save(); return res.json({ ok: true, message: 'Profit impozabil 0 sau pierdere — niciun impozit. Pierdere fiscala de reportat: ' + pt.pierdereDeReportat + ' lei.', result: pt }); }
    const lines = pt.lines.slice();
    // Ordinea inchiderilor devine IRELEVANTA: daca inchiderea anuala s-a facut deja, 691 (postat acum)
    // ar ramane necuplat in 121 -> il inchidem aici (121 = 691), asa incat 121 arata rezultatul NET.
    // Daca inchiderea anuala nu s-a facut inca, ea va inchide 691 cand se ruleaza (comportament normal).
    const yearClosed = d.entries.some((e) => e.firmaId === fid && e.tip === 'inchidere_an' && e.period === year + '-12');
    let alsoClosed691 = false;
    if (yearClosed && pt.impozit > 0) { lines.push({ debit: '121', credit: '691', suma: pt.impozit, explicatie: 'Inchidere impozit pe profit in rezultat (dupa inchiderea anuala)' }); alsoClosed691 = true; }
    d.entries.push({
      id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12', tip: 'impozit_profit', tipNume: 'Impozit pe profit',
      partener: '', document: 'Impozit profit ' + year, explicatie: 'Inregistrare impozit pe profit (' + pt.cota + '%)' + (alsoClosed691 ? ' + inchidere 691 in 121' : ''),
      fileId: null, system: true, lines,
    });
    logAudit('impozit.profit', year + ': ' + pt.impozit, { req });
    db.save();
    res.json({ ok: true, result: pt });
  });

  // Repartizarea rezultatului: 121 -> 117 (profit) sau 117 -> 121 (pierdere)
  app.get('/api/distribute-preview', (req, res) => {
    res.json(acc.resultDistribution(S(req), req.query.year || String(new Date().getFullYear())));
  });
  app.post('/api/distribute-result', (req, res) => {
    const year = req.query.year;
    if (!year) return res.status(400).json({ error: 'Lipseste anul (YYYY).' });
    const d = db.get();
    const r = acc.resultDistribution(S(req), year);
    if (!r.lines.length) return res.json({ ok: true, message: 'Soldul contului 121 este zero — nimic de repartizat.', result: r });
    for (const l of r.lines) {
      if (!coa.getAccount(l.debit) || !coa.getAccount(l.credit)) return res.status(400).json({ error: 'Cont inexistent in plan: ' + l.debit + '/' + l.credit });
    }
    d.entries.push({
      id: db.nextId('e'), firmaId: activeId(req), data: year + '-12-31', period: year + '-12', tip: 'repartizare_rezultat', tipNume: 'Repartizarea rezultatului',
      partener: '', document: 'Repartizare ' + year, explicatie: r.profit ? 'Repartizarea profitului (121=117)' : 'Reportarea pierderii (117=121)',
      fileId: null, system: true, lines: r.lines,
    });
    logAudit('repartizare.rezultat', year + ' ' + (r.profit ? 'profit ' + r.profit : 'pierdere ' + r.pierdere), { req });
    db.save();
    res.json({ ok: true, result: r });
  });
};
