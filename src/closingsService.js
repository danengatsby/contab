'use strict';

// Service layer pentru inchiderile fiscale: regularizarea TVA (lunara/trimestriala),
// inchiderea anuala a conturilor de venituri/cheltuieli in 121,
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
const fiscalReview = require('./fiscalReview');
const annualInventory = require('./annualInventory');
const { reqFirma } = require('./stocksService');
const { validIsoDate, period: periodOf } = require('./util');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

function reqYear(year) {
  const y = String(year || '');
  if (!/^[1-9]\d{3}$/.test(y)) fail(400, 'Anul trebuie sa aiba forma YYYY.');
  return y;
}

function activeAnnualEntry(fid, tip, year) {
  const entries = db.get().entries || [];
  const found = entries.find((e) => Number(e.firmaId) === Number(fid) && !e.stornat
    && e.tip === tip && String(e.rezultatAn || e.period || e.data || '').slice(0, 4) === String(year));
  return found || null;
}

/** Perioada 13 este un spatiu TEHNIC: decembrie trebuie sa fie deja blocat, iar nota ramane
 *  datata 31 decembrie. Bypass-ul nu este generic; exista numai in cele doua servicii anuale
 *  autorizate prin `annual.manage`, iar articolul poarta explicit urma perioadei tehnice. */
function assertAdjustmentWindow(fid, year, operation) {
  const firma = db.getFirma(fid) || {};
  const december = year + '-12';
  if (!firma.lockedUntil || firma.lockedUntil < december) {
    fail(400, (operation || 'Operațiunea anuală') + ' se execută în perioada tehnică ' + year
      + '-13, după finalizarea și blocarea lunii decembrie din cockpit.');
  }
  return year + '-13';
}

/** Regularizarea TVA pe o LUNA. Posteaza nota doar daca exista TVA de regularizat.
 *  NU blocheaza luna: blocarea este ultimul pas separat al cockpitului de inchidere, dupa
 *  documente, banca, declaratii si aprobare. */
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
  if (v.lines.length) db.save();
  return { result: v, lockedUntil: firma.lockedUntil || null, posted: v.lines.length > 0 };
}

/** Inchiderea anuala: clasa 6 si 7 in 121. Fara rulaje, nu posteaza nimic. */
function closeYear(fid, year) {
  fid = reqFirma(fid);
  year = reqYear(year);
  const firma = db.getFirma(fid);
  const istoric = firma.annualCloseHistory && firma.annualCloseHistory[year];
  const existent = activeAnnualEntry(fid, 'inchidere_an', year);
  if (existent || istoric) {
    return { result: (istoric && istoric.result) || { lines: (existent && existent.lines) || [],
      rezultat: existent && existent.rezultat || 0 }, posted: false, idempotent: true,
    entry: existent || null, adjustmentPeriod: year + '-13' };
  }
  fiscalReview.assertReady('închiderea anuală ' + year);
  annualInventory.assertComplete(db.scoped(fid), year);
  const adjustmentPeriod = assertAdjustmentWindow(fid, year, 'Închiderea anuală');
  const c = acc.annualClosing(db.scoped(fid), year);
  let entry = null;
  if (c.lines.length) {
    entry = db.pushEntry({
      id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12',
      adjustmentPeriod, rezultatAn: year, adjustmentAuthorized: true,
      tip: 'inchidere_an', tipNume: 'Inchidere conturi venituri/cheltuieli', rezultat: c.rezultat,
      partener: '', document: 'Inchidere ' + year, explicatie: 'Închidere clasa 6 și 7 în contul 121 (perioada tehnică 13)',
      fileId: null, system: true, lines: c.lines,
    }, { context: 'inchiderea anuala — perioada tehnica 13', allowClosedPeriod: true });
  }
  firma.annualCloseHistory = firma.annualCloseHistory || {};
  firma.annualCloseHistory[year] = { at: new Date().toISOString(), adjustmentPeriod,
    accountingDate: year + '-12-31', entryId: entry && entry.id || null, result: c };
  db.save();
  return { result: c, posted: !!entry, idempotent: false, entry, adjustmentPeriod };
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
  year = reqYear(year);
  const firma = db.getFirma(fid);
  const existent = activeAnnualEntry(fid, 'impozit_profit', year);
  if (existent) return { result: existent.rezultatFiscal || {}, posted: false, idempotent: true,
    entry: existent, adjustmentPeriod: year + '-13' };
  if (firma.pierdereFiscala && Object.prototype.hasOwnProperty.call(firma.pierdereFiscala, year)) {
    return { result: (firma.profitTaxHistory && firma.profitTaxHistory[year]) || {
      impozit: 0, pierdereDeReportat: firma.pierdereFiscala[year] }, posted: false,
    idempotent: true, entry: null, adjustmentPeriod: year + '-13' };
  }
  fiscalReview.assertReady('definitivarea impozitului pe profit ' + year);
  const adjustmentPeriod = assertAdjustmentWindow(fid, year, 'Definitivarea impozitului pe profit');
  const d = db.get();
  const view = db.scoped(fid);
  const pt = acc.profitTax(view, year, profitTaxOptions(fid, src, year));
  firma.pierdereFiscala = firma.pierdereFiscala || {};
  firma.pierdereFiscala[year] = pt.pierdereDeReportat; // pastrat: contract istoric + afisari vechi
  firma.profitTaxHistory = firma.profitTaxHistory || {};
  firma.profitTaxHistory[year] = pt;
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
  if (!pt.lines.length) { db.save(); return { result: pt, posted: false, idempotent: false, adjustmentPeriod }; }
  const lines = pt.lines.slice();
  const yearClosed = d.entries.some((e) => e.firmaId === fid && e.tip === 'inchidere_an' && e.period === year + '-12')
    || !!(firma.annualCloseHistory && firma.annualCloseHistory[year]);
  let alsoClosed691 = false;
  if (yearClosed && pt.impozit > 0) { lines.push({ debit: '121', credit: '691', suma: pt.impozit, explicatie: 'Închidere impozit pe profit în rezultat (după închiderea anuală)' }); alsoClosed691 = true; }
  db.pushEntry({
    id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12', adjustmentPeriod,
    rezultatAn: year, adjustmentAuthorized: true, tip: 'impozit_profit', tipNume: 'Impozit pe profit',
    partener: '', document: 'Impozit profit ' + year, explicatie: 'Înregistrare impozit pe profit (' + pt.cota + '%), perioada tehnică 13' + (alsoClosed691 ? ' + inchidere 691 in 121' : ''),
    fileId: null, system: true, lines,
    // INSTANTANEUL calculului, pastrat pe articol: D101 il refoloseste in loc sa recalculeze.
    // Fara el, declaratia generata dupa inchidere ar folosi pierderile RAMASE (inchiderea tocmai
    // le-a consumat) si ar raporta alta recuperare decat cea inregistrata — aceleasi reguli, dar
    // pe o stare schimbata. Vezi src/profitTaxOptions.js.
    rezultatFiscal: pt,
  }, { context: 'impozit pe profit — perioada tehnica 13', allowClosedPeriod: true });
  db.save();
  return { result: pt, posted: true, idempotent: false, adjustmentPeriod };
}

/** Repartizarea rezultatului: 121 -> 117 (profit) sau 117 -> 121 (pierdere).
 *  Articolul apartine exercitiului urmator celui inchis, la data aprobata/selectata, nu la
 *  31 decembrie in exercitiul care tocmai a produs rezultatul. */
function distributeResult(fid, year, data, aga) {
  fid = reqFirma(fid);
  year = reqYear(year);
  const existent = activeAnnualEntry(fid, 'repartizare_rezultat', year);
  if (existent) return { result: existent.rezultatDistribuit || acc.resultDistribution(db.scoped(fid), year),
    posted: false, idempotent: true, data: existent.data, aga: existent.aga || null, entry: existent };
  fiscalReview.assertReady('repartizarea rezultatului ' + year);
  const nextYear = String(Number(year) + 1);
  aga = aga || {};
  const agaNumar = String(aga.numar || '').trim();
  const agaData = String(aga.data || data || '');
  if (agaNumar.length < 1) fail(400, 'Repartizarea cere numărul hotărârii AGA care aprobă operațiunea.');
  if (!validIsoDate(agaData) || agaData.slice(0, 4) !== nextYear) {
    fail(400, 'Data hotărârii AGA trebuie să fie o dată calendaristică din anul următor (' + nextYear + ').');
  }
  data = String(data || agaData);
  if (!validIsoDate(data)) fail(400, 'Data repartizarii trebuie sa fie o data calendaristica valida (YYYY-MM-DD).');
  if (data.slice(0, 4) !== nextYear) fail(400, 'Repartizarea rezultatului anului ' + year + ' trebuie inregistrata in anul urmator (' + nextYear + ').');
  if (data !== agaData) fail(400, 'Data articolului trebuie să coincidă cu data hotărârii AGA care îl justifică.');
  db.assertPeriodOpen(fid, data, 'Repartizarea rezultatului');
  const r = acc.resultDistribution(db.scoped(fid), year);
  if (!r.lines.length) return { result: r, posted: false, idempotent: false, data,
    aga: { numar: agaNumar, data: agaData } };
  for (const l of r.lines) {
    if (!coa.getAccount(l.debit) || !coa.getAccount(l.credit)) fail(400, 'Cont inexistent in plan: ' + l.debit + '/' + l.credit);
  }
  db.pushEntry({
    id: db.nextId('e'), firmaId: fid, data, period: periodOf(data), tip: 'repartizare_rezultat', tipNume: 'Repartizarea rezultatului',
    partener: '', document: 'Hotărârea AGA nr. ' + agaNumar, explicatie: r.profit ? 'Repartizarea profitului (121=117)' : 'Reportarea pierderii (117=121)',
    fileId: null, system: true, rezultatAn: year, aga: { numar: agaNumar, data: agaData },
    rezultatDistribuit: r, lines: r.lines,
  }, { context: 'repartizarea rezultatului' });
  db.save();
  return { result: r, posted: true, idempotent: false, data, aga: { numar: agaNumar, data: agaData } };
}

module.exports = { closeVat, closeYear, profitTaxOptions, closeProfitTax, distributeResult };
