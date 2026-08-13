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
// `fiscal`, `rep`, `assets` si `rulajCont` traiau aici doar pentru setul de optiuni al
// impozitului pe profit; au plecat odata cu el in src/profitTaxOptions.js.
const ptOpts = require('./profitTaxOptions'); // sursa unica a optiunilor de impozit pe profit
const d107 = require('./d107');
const { reqFirma } = require('./stocksService');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Regularizarea TVA pe o LUNA (nu an: data notei ar fi malformata si blocarea ineficienta).
 *  Posteaza nota doar daca exista TVA de regularizat, dar blocheaza perioada oricum. */
function closeVat(fid, period) {
  fid = reqFirma(fid);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) fail(400, 'Perioada trebuie sa fie o luna (YYYY-MM).');
  const firma = db.getFirma(fid);
  const v = acc.vatClosing(db.scoped(fid), period);
  if (v.lines.length) {
    db.pushEntry({
      id: db.nextId('e'), firmaId: fid, data: period + '-28', period, tip: 'inchidere_tva', tipNume: 'Inchidere TVA',
      partener: '', document: 'Nota TVA ' + period, explicatie: 'Regularizare TVA',
      fileId: null, system: true, lines: v.lines,
    }, { context: 'inchidere TVA' });
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
  const c = acc.annualClosing(db.scoped(fid), year);
  if (!c.lines.length) return { result: c, posted: false };
  db.pushEntry({
    id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12', tip: 'inchidere_an', tipNume: 'Inchidere conturi venituri/cheltuieli',
    partener: '', document: 'Inchidere ' + year, explicatie: 'Închidere clasa 6 și 7 în contul 121',
    fileId: null, system: true, lines: c.lines,
  }, { context: 'inchiderea anuala' });
  db.save();
  return { result: c, posted: true };
}

/** Optiunile de calcul ale impozitului pe profit: cota curenta + ajustarile din cerere;
 *  pierderea reportata explicita are prioritate fata de cea memorata pe firma (anul precedent). */
function profitTaxOptions(fid, src, year) {
  fid = reqFirma(fid);
  // Sursa unica, partajata cu calea DECLARATIEI (src/profitTaxOptions.js). Cat timp setul de
  // optiuni traia doar aici, D101 se genera fara el si raporta alt impozit decat nota postata.
  return ptOpts.construieste(db.scoped(fid), year, src);
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
  const view = db.scoped(fid);
  const pt = acc.profitTax(view, year, profitTaxOptions(fid, src, year));
  const firma = db.getFirma(fid);
  firma.pierdereFiscala = firma.pierdereFiscala || {};
  firma.pierdereFiscala[year] = pt.pierdereDeReportat; // pastrat: contract istoric + afisari vechi
  // Forma AUTORITARA e lista pe ani: numai ea poate fi imbatranita si expirata (art. 31).
  // Se scrie si cand nu s-a folosit nimic — anii urmatori pornesc de aici.
  if (pt.pierderiDeReportat) firma.pierderiFiscale = pt.pierderiDeReportat;
  // Reportul creditului de sponsorizare, pe acelasi tipar ca pierderea fiscala: se memoreaza si
  // cand creditul folosit e 0. Bucket-urile isi pastreaza ANUL, fiindca prescriptia (7 ani) se
  // masoara pe vechimea fiecaruia — un total unic n-ar mai putea fi prescris corect.
  if (pt.sponsorizare) {
    // D107 are nevoie de aceeași deducere ca D101, dar defalcată pe beneficiar. Instantaneul se
    // calculează ÎNAINTE de a înlocui reportul de intrare al firmei cu reportul de ieșire.
    const r107 = d107.report(view, year, pt, { ignoreHistory: true });
    // Un report agregat migrat fără beneficiari nu trebuie „înghețat” ca instantaneu invalid:
    // după completarea istoricului, raportul trebuie să se poată reconcilia din nou.
    if (!(r107.financialErrors || []).length) {
      firma.d107Istoric = firma.d107Istoric || {};
      firma.d107Istoric[year] = r107;
      firma.sponsorizareReportDetaliat = r107.reportNou;
    }
    firma.sponsorizareReport = pt.sponsorizare.reportNou;
  }
  if (!pt.lines.length) { db.save(); return { result: pt, posted: false }; }
  const lines = pt.lines.slice();
  const yearClosed = d.entries.some((e) => e.firmaId === fid && e.tip === 'inchidere_an' && e.period === year + '-12');
  let alsoClosed691 = false;
  if (yearClosed && pt.impozit > 0) { lines.push({ debit: '121', credit: '691', suma: pt.impozit, explicatie: 'Închidere impozit pe profit în rezultat (după închiderea anuală)' }); alsoClosed691 = true; }
  db.pushEntry({
    id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12', tip: 'impozit_profit', tipNume: 'Impozit pe profit',
    partener: '', document: 'Impozit profit ' + year, explicatie: 'Înregistrare impozit pe profit (' + pt.cota + '%)' + (alsoClosed691 ? ' + inchidere 691 in 121' : ''),
    fileId: null, system: true, lines,
    // INSTANTANEUL calculului, pastrat pe articol: D101 il refoloseste in loc sa recalculeze.
    // Fara el, declaratia generata dupa inchidere ar folosi pierderile RAMASE (inchiderea tocmai
    // le-a consumat) si ar raporta alta recuperare decat cea inregistrata — aceleasi reguli, dar
    // pe o stare schimbata. Vezi src/profitTaxOptions.js.
    rezultatFiscal: pt,
  }, { context: 'impozit pe profit' });
  db.save();
  return { result: pt, posted: true };
}

/** Repartizarea rezultatului: 121 -> 117 (profit) sau 117 -> 121 (pierdere). */
function distributeResult(fid, year) {
  fid = reqFirma(fid);
  if (!year) fail(400, 'Lipseste anul (YYYY).');
  const r = acc.resultDistribution(db.scoped(fid), year);
  if (!r.lines.length) return { result: r, posted: false };
  for (const l of r.lines) {
    if (!coa.getAccount(l.debit) || !coa.getAccount(l.credit)) fail(400, 'Cont inexistent in plan: ' + l.debit + '/' + l.credit);
  }
  db.pushEntry({
    id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12', tip: 'repartizare_rezultat', tipNume: 'Repartizarea rezultatului',
    partener: '', document: 'Repartizare ' + year, explicatie: r.profit ? 'Repartizarea profitului (121=117)' : 'Reportarea pierderii (117=121)',
    fileId: null, system: true, lines: r.lines,
  }, { context: 'repartizarea rezultatului' });
  db.save();
  return { result: r, posted: true };
}

module.exports = { closeVat, closeYear, profitTaxOptions, closeProfitTax, distributeResult };
