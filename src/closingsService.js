'use strict';

// Service layer pentru inchiderile fiscale: regularizarea TVA (lunara/trimestriala, cu
// blocarea perioadei), inchiderea anuala a conturilor de venituri/cheltuieli in 121,
// impozitul pe profit (cu ajustari fiscale + reportarea pierderii) si repartizarea
// rezultatului (121 <-> 117). Rutele (src/routes/closings.js) raman puncte de intrare
// subtiri; functiile intorc `posted` ca ruta sa stie daca s-a scris o nota (audit +
// mesajele istorice de no-op raman in ruta).

const db = require('./db');
const acc = require('./accounting');
const coa = require('./chartOfAccounts');
const fiscal = require('./fiscal');
const { reqFirma } = require('./stocksService');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Regularizarea TVA pe o LUNA (nu an: data notei ar fi malformata si blocarea ineficienta).
 *  Posteaza nota doar daca exista TVA de regularizat, dar blocheaza perioada oricum. */
function closeVat(fid, period) {
  fid = reqFirma(fid);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) fail(400, 'Perioada trebuie sa fie o luna (YYYY-MM).');
  const d = db.get();
  const firma = db.getFirma(fid);
  const v = acc.vatClosing(db.scoped(fid), period);
  if (v.lines.length) {
    d.entries.push({
      id: db.nextId('e'), firmaId: fid, data: period + '-28', period, tip: 'inchidere_tva', tipNume: 'Inchidere TVA',
      partener: '', document: 'Nota TVA ' + period, explicatie: 'Regularizare TVA',
      fileId: null, system: true, lines: v.lines,
    });
  }
  // Inchiderea lunii BLOCHEAZA perioada (read-only) — deblocarea e doar de admin.
  if (!firma.lockedUntil || period > firma.lockedUntil) firma.lockedUntil = period;
  db.save();
  return { result: v, lockedUntil: firma.lockedUntil, posted: v.lines.length > 0 };
}

/** Inchiderea anuala: clasa 6 si 7 in 121. Fara rulaje, nu posteaza nimic. */
function closeYear(fid, year) {
  fid = reqFirma(fid);
  if (!year) fail(400, 'Lipseste anul (YYYY).');
  const d = db.get();
  const c = acc.annualClosing(db.scoped(fid), year);
  if (!c.lines.length) return { result: c, posted: false };
  d.entries.push({
    id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12', tip: 'inchidere_an', tipNume: 'Inchidere conturi venituri/cheltuieli',
    partener: '', document: 'Inchidere ' + year, explicatie: 'Inchidere clasa 6 si 7 in contul 121',
    fileId: null, system: true, lines: c.lines,
  });
  db.save();
  return { result: c, posted: true };
}

/** Optiunile de calcul ale impozitului pe profit: cota curenta + ajustarile din cerere;
 *  pierderea reportata explicita are prioritate fata de cea memorata pe firma (anul precedent). */
function profitTaxOptions(fid, src, year) {
  fid = reqFirma(fid);
  const losses = db.getFirma(fid).pierdereFiscala || {};
  src = src || {};
  const pr = (src.pierdereReportata != null && src.pierdereReportata !== '') ? Number(src.pierdereReportata) : (Number(losses[Number(year) - 1]) || 0);
  return {
    cota: fiscal.FISCAL.impozitProfit,
    cheltNedeductibile: Number(src.cheltNedeductibile) || 0,
    deduceri: Number(src.deduceri) || 0,
    pierdereReportata: pr || 0,
  };
}

/** Impozitul pe profit (691 = 4411), o singura data pe an. Pierderea fiscala de reportat se
 *  memoreaza pe firma chiar si cand impozitul e 0 (baza anilor urmatori). Daca inchiderea
 *  anuala s-a facut deja, 691 se inchide aici in 121 — ordinea inchiderilor devine irelevanta. */
function closeProfitTax(fid, src, year) {
  fid = reqFirma(fid);
  if (!year) fail(400, 'Lipseste anul (YYYY).');
  const d = db.get();
  const exists = d.entries.find((e) => e.firmaId === fid && e.tip === 'impozit_profit' && e.period === year + '-12');
  if (exists) fail(400, 'Impozitul pe profit pe ' + year + ' este deja inregistrat.');
  const pt = acc.profitTax(db.scoped(fid), year, profitTaxOptions(fid, src, year));
  const firma = db.getFirma(fid);
  firma.pierdereFiscala = firma.pierdereFiscala || {};
  firma.pierdereFiscala[year] = pt.pierdereDeReportat;
  if (!pt.lines.length) { db.save(); return { result: pt, posted: false }; }
  const lines = pt.lines.slice();
  const yearClosed = d.entries.some((e) => e.firmaId === fid && e.tip === 'inchidere_an' && e.period === year + '-12');
  let alsoClosed691 = false;
  if (yearClosed && pt.impozit > 0) { lines.push({ debit: '121', credit: '691', suma: pt.impozit, explicatie: 'Inchidere impozit pe profit in rezultat (dupa inchiderea anuala)' }); alsoClosed691 = true; }
  d.entries.push({
    id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12', tip: 'impozit_profit', tipNume: 'Impozit pe profit',
    partener: '', document: 'Impozit profit ' + year, explicatie: 'Inregistrare impozit pe profit (' + pt.cota + '%)' + (alsoClosed691 ? ' + inchidere 691 in 121' : ''),
    fileId: null, system: true, lines,
  });
  db.save();
  return { result: pt, posted: true };
}

/** Repartizarea rezultatului: 121 -> 117 (profit) sau 117 -> 121 (pierdere). */
function distributeResult(fid, year) {
  fid = reqFirma(fid);
  if (!year) fail(400, 'Lipseste anul (YYYY).');
  const d = db.get();
  const r = acc.resultDistribution(db.scoped(fid), year);
  if (!r.lines.length) return { result: r, posted: false };
  for (const l of r.lines) {
    if (!coa.getAccount(l.debit) || !coa.getAccount(l.credit)) fail(400, 'Cont inexistent in plan: ' + l.debit + '/' + l.credit);
  }
  d.entries.push({
    id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12', tip: 'repartizare_rezultat', tipNume: 'Repartizarea rezultatului',
    partener: '', document: 'Repartizare ' + year, explicatie: r.profit ? 'Repartizarea profitului (121=117)' : 'Reportarea pierderii (117=121)',
    fileId: null, system: true, lines: r.lines,
  });
  db.save();
  return { result: r, posted: true };
}

module.exports = { closeVat, closeYear, profitTaxOptions, closeProfitTax, distributeResult };
