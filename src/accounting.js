'use strict';

const { round2, period: periodOf } = require('./util');
const coa = require('./chartOfAccounts');

/** Toate liniile contabile, fiecare cu metadatele articolului din care provine. */
function allLines(entries) {
  const out = [];
  for (const e of entries) {
    for (const ln of e.lines) {
      out.push({
        entryId: e.id,
        data: e.data,
        period: e.period || periodOf(e.data),
        tipNume: e.tipNume,
        partener: e.partener,
        document: e.document,
        debit: String(ln.debit),
        credit: String(ln.credit),
        suma: round2(ln.suma),
        explicatie: ln.explicatie || e.explicatie || '',
      });
    }
  }
  return out;
}

/** Sorteaza entries cronologic (dupa data, apoi id). */
function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.data !== b.data) return a.data < b.data ? -1 : 1;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
}

function inPeriod(e, period) {
  if (!period) return true;
  const ep = e.period || periodOf(e.data);
  if (period.length === 4) return ep.slice(0, 4) === period; // an intreg (YYYY)
  return ep === period; // luna exacta (YYYY-MM)
}

function beforePeriod(e, period) {
  if (!period) return false;
  return (e.period || periodOf(e.data)) < period;
}

/** Acumuleaza miscarile {d,c} pe cont dintr-o lista de linii. */
function accumulate(lines) {
  const m = {};
  for (const ln of lines) {
    (m[ln.debit] = m[ln.debit] || { d: 0, c: 0 }).d = round2(m[ln.debit].d + ln.suma);
    (m[ln.credit] = m[ln.credit] || { d: 0, c: 0 }).c = round2(m[ln.credit].c + ln.suma);
  }
  return m;
}

/** Registrul-jurnal: liniile in ordine cronologica pentru o perioada (sau toate). */
function journal(db, period) {
  const entries = sortEntries(db.entries.filter((e) => inPeriod(e, period)));
  const rows = [];
  let total = 0;
  let nr = 0; // numar curent al articolului contabil (Nr. crt. din registrul-jurnal)
  for (const e of entries) {
    nr += 1;
    e.lines.forEach((ln, i) => {
      rows.push({
        nr: i === 0 ? nr : '',
        data: i === 0 ? e.data : '',
        document: i === 0 ? (e.document || '') : '',
        explicatie: ln.explicatie || e.explicatie || e.tipNume,
        debit: String(ln.debit),
        credit: String(ln.credit),
        suma: round2(ln.suma),
      });
      total = round2(total + ln.suma);
    });
  }
  return { rows, total, period };
}

/** TVA neexigibila (4428): cat TVA colectata/deductibila este inca neexigibila (regim TVA la incasare). */
function tvaNeexigibila(db, period) {
  let colIn = 0; let colOut = 0; let dedIn = 0; let dedOut = 0;
  const facturi = [];
  for (const e of db.entries.filter((x) => inPeriod(x, period) || !period)) {
    for (const l of e.lines) {
      // colectata neexigibila: la vanzare 4111 = 4428 ; devine exigibila 4428 = 4427
      if (l.credit === '4428' && /^411/.test(l.debit)) { colIn = round2(colIn + l.suma); facturi.push({ data: e.data, document: e.document, partener: e.partener, tip: 'colectata', stadiu: 'neexigibila', suma: l.suma }); }
      if (l.debit === '4428' && l.credit === '4427') { colOut = round2(colOut + l.suma); facturi.push({ data: e.data, document: e.document, partener: e.partener, tip: 'colectata', stadiu: 'exigibila', suma: l.suma }); }
      // deductibila neexigibila: la cumparare 4428 = 401 ; devine exigibila 4426 = 4428
      if (l.debit === '4428' && /^40/.test(l.credit)) { dedIn = round2(dedIn + l.suma); facturi.push({ data: e.data, document: e.document, partener: e.partener, tip: 'deductibila', stadiu: 'neexigibila', suma: l.suma }); }
      if (l.credit === '4428' && l.debit === '4426') { dedOut = round2(dedOut + l.suma); facturi.push({ data: e.data, document: e.document, partener: e.partener, tip: 'deductibila', stadiu: 'exigibila', suma: l.suma }); }
    }
  }
  return {
    period,
    colectataNeexigibila: round2(colIn - colOut),
    deductibilaNeexigibila: round2(dedIn - dedOut),
    colIn, colOut, dedIn, dedOut,
    facturi: facturi.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0)),
  };
}

/** Numarul de inregistrare al unui articol in registrul-jurnal (pozitia cronologica, toate articolele). */
function journalNr(db, entryId) {
  const sorted = sortEntries(db.entries);
  const idx = sorted.findIndex((e) => e.id === entryId);
  return idx < 0 ? null : idx + 1;
}

/** Cartea mare: pentru fiecare cont, soldul initial, miscarile perioadei si soldul final. */
function ledger(db, period) {
  // solduri initiale = opening + miscari inainte de perioada
  const before = accumulate(allLines(db.entries.filter((e) => beforePeriod(e, period))));
  const opening = db.openingBalances || {};
  const accounts = new Set([...Object.keys(opening), ...Object.keys(before)]);

  const periodLines = allLines(db.entries.filter((e) => inPeriod(e, period)));
  for (const ln of periodLines) { accounts.add(ln.debit); accounts.add(ln.credit); }

  const result = [];
  for (const cod of [...accounts].sort()) {
    const op = opening[cod] || { d: 0, c: 0 };
    const bf = before[cod] || { d: 0, c: 0 };
    const siNet = round2((op.d + bf.d) - (op.c + bf.c)); // net sold initial
    const moves = periodLines
      .filter((l) => l.debit === cod || l.credit === cod)
      .map((l) => ({
        data: l.data,
        explicatie: l.explicatie,
        document: l.document,
        debit: l.debit === cod ? l.suma : 0,
        credit: l.credit === cod ? l.suma : 0,
      }));
    const rd = round2(moves.reduce((s, m) => s + m.debit, 0));
    const rc = round2(moves.reduce((s, m) => s + m.credit, 0));
    const sfNet = round2(siNet + rd - rc);
    if (siNet === 0 && rd === 0 && rc === 0 && sfNet === 0) continue;
    result.push({
      cod, nume: coa.accountName(cod),
      siD: siNet > 0 ? siNet : 0, siC: siNet < 0 ? -siNet : 0,
      moves, rd, rc,
      sfD: sfNet > 0 ? sfNet : 0, sfC: sfNet < 0 ? -sfNet : 0,
    });
  }
  return result;
}

/** Balanta de verificare cu patru egalitati. */
function trialBalance(db, period) {
  const before = accumulate(allLines(db.entries.filter((e) => beforePeriod(e, period))));
  const opening = db.openingBalances || {};
  const periodLines = allLines(db.entries.filter((e) => inPeriod(e, period)));
  const rulaj = accumulate(periodLines);

  const accounts = new Set([
    ...Object.keys(opening), ...Object.keys(before), ...Object.keys(rulaj),
  ]);

  const rows = [];
  const tot = { siD: 0, siC: 0, rd: 0, rc: 0, tsD: 0, tsC: 0, sfD: 0, sfC: 0 };
  for (const cod of [...accounts].sort()) {
    const op = opening[cod] || { d: 0, c: 0 };
    const bf = before[cod] || { d: 0, c: 0 };
    const ru = rulaj[cod] || { d: 0, c: 0 };
    const siNet = round2((op.d + bf.d) - (op.c + bf.c));
    const siD = siNet > 0 ? siNet : 0;
    const siC = siNet < 0 ? -siNet : 0;
    const rd = round2(ru.d);
    const rc = round2(ru.c);
    const tsD = round2(siD + rd);
    const tsC = round2(siC + rc);
    const sfNet = round2(tsD - tsC);
    const sfD = sfNet > 0 ? sfNet : 0;
    const sfC = sfNet < 0 ? -sfNet : 0;
    if (siD === 0 && siC === 0 && rd === 0 && rc === 0) continue;
    const r = { cod, nume: coa.accountName(cod), clasa: (coa.getAccount(cod) || {}).clasa || Number(cod[0]), siD, siC, rd, rc, tsD, tsC, sfD, sfC };
    rows.push(r);
    tot.siD = round2(tot.siD + siD); tot.siC = round2(tot.siC + siC);
    tot.rd = round2(tot.rd + rd); tot.rc = round2(tot.rc + rc);
    tot.tsD = round2(tot.tsD + tsD); tot.tsC = round2(tot.tsC + tsC);
    tot.sfD = round2(tot.sfD + sfD); tot.sfC = round2(tot.sfC + sfC);
  }
  const balanced =
    tot.siD === tot.siC && tot.rd === tot.rc && tot.tsD === tot.tsC && tot.sfD === tot.sfC;
  return { rows, tot, balanced, period };
}

/** Calculeaza articolul de inchidere TVA pentru o perioada (nu il salveaza). */
function vatClosing(db, period) {
  const rulaj = accumulate(allLines(db.entries.filter((e) => inPeriod(e, period))));
  const c4427 = rulaj['4427'] || { d: 0, c: 0 };
  const c4426 = rulaj['4426'] || { d: 0, c: 0 };
  const colectata = round2(c4427.c - c4427.d);
  const deductibila = round2(c4426.d - c4426.c);
  const lines = [];
  const comp = Math.min(colectata, deductibila);
  if (comp > 0) lines.push({ debit: '4427', credit: '4426', suma: round2(comp), explicatie: 'Compensare TVA colectata cu TVA deductibila' });
  const diff = round2(colectata - deductibila);
  if (diff > 0) lines.push({ debit: '4427', credit: '4423', suma: diff, explicatie: 'TVA de plata' });
  else if (diff < 0) lines.push({ debit: '4424', credit: '4426', suma: round2(-diff), explicatie: 'TVA de recuperat' });
  return { colectata, deductibila, diff, lines };
}

/** Calculeaza articolele de inchidere a conturilor de venituri si cheltuieli (clasa 6/7) intr-un an. */
function annualClosing(db, year) {
  const yearEntries = db.entries.filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
  const acc = accumulate(allLines(yearEntries));
  const linesChelt = [];
  const linesVen = [];
  let totalChelt = 0;
  let totalVen = 0;
  for (const cod of Object.keys(acc).sort()) {
    const a = coa.getAccount(cod);
    const clasa = a ? a.clasa : Number(cod[0]);
    const net = round2(acc[cod].d - acc[cod].c);
    if (clasa === 6 && net !== 0) {
      // include si conturile rectificative (ex. 609 sold creditor -> suma negativa, in rosu)
      linesChelt.push({ debit: '121', credit: cod, suma: net, explicatie: `Inchidere cont ${cod} ${coa.accountName(cod)}` });
      totalChelt = round2(totalChelt + net);
    } else if (clasa === 7) {
      const netV = round2(acc[cod].c - acc[cod].d);
      if (netV !== 0) {
        // include si conturile rectificative (ex. 709 sold debitor -> suma negativa, in rosu)
        linesVen.push({ debit: cod, credit: '121', suma: netV, explicatie: `Inchidere cont ${cod} ${coa.accountName(cod)}` });
        totalVen = round2(totalVen + netV);
      }
    }
  }
  const rezultat = round2(totalVen - totalChelt);
  return { lines: [...linesVen, ...linesChelt], totalVen, totalChelt, rezultat };
}

/**
 * Impozitul pe profit pentru un an, cu ajustari fiscale:
 *   profit impozabil = profit contabil + cheltuieli nedeductibile − deduceri − pierdere fiscala reportata
 *   impozit = max(0, profit impozabil) × cota%   →   691 = 4411
 * Pierderea fiscala reportata reduce baza doar pana la 0; restul + pierderea anului curent se reporteaza.
 * `opts` = { cota, cheltNedeductibile, deduceri, pierdereReportata } (sau un numar = cota, pentru compat.).
 */
function profitTax(db, year, opts) {
  opts = (typeof opts === 'number') ? { cota: opts } : (opts || {});
  const cota = opts.cota || 16;
  const nedeductibile = round2(Number(opts.cheltNedeductibile) || 0);
  const deduceri = round2(Number(opts.deduceri) || 0);
  const pierdereReportata = round2(Number(opts.pierdereReportata) || 0);
  const yearEntries = db.entries.filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
  const acc = accumulate(allLines(yearEntries));
  let venit = 0; let chelt = 0;
  for (const cod of Object.keys(acc)) {
    const a = coa.getAccount(cod);
    const clasa = a ? a.clasa : Number(String(cod)[0]);
    if (clasa === 7) venit = round2(venit + (acc[cod].c - acc[cod].d));
    else if (clasa === 6 && !/^(691|698)/.test(String(cod))) chelt = round2(chelt + (acc[cod].d - acc[cod].c));
  }
  const profitContabil = round2(venit - chelt);
  const bazaInainteReportare = round2(profitContabil + nedeductibile - deduceri);
  const pierdereFolosita = bazaInainteReportare > 0 ? round2(Math.min(bazaInainteReportare, pierdereReportata)) : 0;
  const profitImpozabil = round2(bazaInainteReportare - pierdereFolosita);
  const impozit = profitImpozabil > 0 ? round2(profitImpozabil * cota / 100) : 0;
  const pierdereCurenta = bazaInainteReportare < 0 ? round2(-bazaInainteReportare) : 0;
  const pierdereDeReportat = round2(pierdereReportata - pierdereFolosita + pierdereCurenta);
  const lines = impozit > 0 ? [{ debit: '691', credit: '4411', suma: impozit, explicatie: 'Impozit pe profit (' + cota + '%)' }] : [];
  return { year: String(year), venit, chelt, profitContabil, cheltNedeductibile: nedeductibile, deduceri, pierdereReportata, pierdereFolosita, profitImpozabil, cota, impozit, pierdereCurenta, pierdereDeReportat, lines };
}

/**
 * Repartizarea rezultatului la inceputul anului urmator (dupa aprobarea situatiilor financiare):
 * soldul contului 121 „Profit si pierdere" se transfera la 117 „Rezultatul reportat".
 *   profit (121 sold creditor):  121 = 117
 *   pierdere (121 sold debitor): 117 = 121
 * Calculat pe soldul CUMULAT al lui 121 la sfarsitul anului (dupa inchiderea conturilor 6/7).
 */
function resultDistribution(db, year) {
  const upTo = db.entries.filter((e) => String(e.period || periodOf(e.data)) <= year + '-12');
  const c121 = accumulate(allLines(upTo))['121'] || { d: 0, c: 0 };
  const net = round2(c121.c - c121.d); // > 0 = profit (sold creditor)
  const lines = [];
  if (net > 0) lines.push({ debit: '121', credit: '117', suma: net, explicatie: 'Repartizarea profitului la rezultat reportat' });
  else if (net < 0) lines.push({ debit: '117', credit: '121', suma: round2(-net), explicatie: 'Reportarea pierderii contabile' });
  return { year: String(year), sold121: net, profit: net > 0 ? net : 0, pierdere: net < 0 ? round2(-net) : 0, lines };
}

/** Jurnalele de TVA (vanzari/cumparari) si sumarul pentru decontul D300. */
function vatJournals(db, period) {
  const entries = sortEntries(db.entries.filter((e) => inPeriod(e, period)));
  const isClass7 = (cod) => {
    const a = coa.getAccount(cod);
    return (a ? a.clasa : Number(String(cod)[0])) === 7;
  };
  const vanzari = [];
  const cumparari = [];
  const tot = { bazaV: 0, colectata: 0, bazaC: 0, deductibila: 0 };

  for (const e of entries) {
    let col = 0; let ded = 0; let bazaV = 0; let reverseCharge = false;
    for (const l of e.lines) {
      if (l.credit === '4427') col = round2(col + l.suma);
      if (l.debit === '4427') col = round2(col - l.suma);
      if (l.debit === '4426') ded = round2(ded + l.suma);
      if (l.credit === '4426') ded = round2(ded - l.suma);
      if (isClass7(l.credit)) bazaV = round2(bazaV + l.suma);
      if (isClass7(l.debit)) bazaV = round2(bazaV - l.suma);
      // avansuri facturate: baza avansului (419) intra in jurnalul de vanzari cu semnul liniei
      // (factura de avans: credit 419 pozitiv; regularizarea la factura finala: credit 419 negativ)
      if (l.credit === '419') bazaV = round2(bazaV + l.suma);
      if (l.debit === '419') bazaV = round2(bazaV - l.suma);
      // taxare inversa interna (art. 331): autolichidarea TVA pe acelasi articol (4426 = 4427)
      if (l.debit === '4426' && l.credit === '4427') reverseCharge = true;
    }
    // baza de achizitie = liniile de debit, exclusiv conturile de TVA
    let bazaC = 0;
    for (const l of e.lines) if (l.debit !== '4426' && l.debit !== '4427' && l.debit !== '4428') bazaC = round2(bazaC + l.suma);
    // TVA la incasare devenita exigibila: articolul (4428=4427 / 4426=4428) nu are baza pe linii,
    // dar baza aferenta e memorata pe articol (e.tvaExig) si intra in D300 in perioada exigibilitatii.
    if (e.tvaExig) {
      if (e.tvaExig.side === 'deductibila') bazaC = round2(bazaC + (Number(e.tvaExig.baza) || 0));
      else bazaV = round2(bazaV + (Number(e.tvaExig.baza) || 0));
    }
    // La taxarea inversa interna aceeasi baza se raporteaza si la colectata, si la deductibila (D300).
    if (reverseCharge && bazaV === 0) bazaV = bazaC;
    if (ded !== 0) {
      cumparari.push({ data: e.data, document: e.document, partener: e.partener, cui: e.partenerCui || '', baza: bazaC, tva: ded, total: round2(bazaC + ded), cota: bazaC > 0 && ded > 0 ? Math.round((ded / bazaC) * 100) : 0, taxareInversa: reverseCharge });
      tot.deductibila = round2(tot.deductibila + ded);
      tot.bazaC = round2(tot.bazaC + bazaC);
    }
    if (col !== 0) {
      vanzari.push({ data: e.data, document: e.document, partener: e.partener, cui: e.partenerCui || '', baza: bazaV, tva: col, total: round2(bazaV + col), cota: bazaV > 0 && col > 0 ? Math.round((col / bazaV) * 100) : 0, taxareInversa: reverseCharge });
      tot.colectata = round2(tot.colectata + col);
      tot.bazaV = round2(tot.bazaV + bazaV);
    }
  }
  const deplata = round2(Math.max(tot.colectata - tot.deductibila, 0));
  const derecuperat = round2(Math.max(tot.deductibila - tot.colectata, 0));
  // defalcare pe cote de TVA (21% / 11% / 0% scutit) pentru D300
  const byCota = (rows) => {
    const m = {};
    for (const r of rows) {
      const cota = r.baza > 0 && r.tva > 0 ? Math.round((r.tva / r.baza) * 100) : 0;
      m[cota] = m[cota] || { cota, baza: 0, tva: 0 };
      m[cota].baza = round2(m[cota].baza + r.baza);
      m[cota].tva = round2(m[cota].tva + r.tva);
    }
    return Object.values(m).sort((a, b) => b.cota - a.cota);
  };
  return { period, vanzari, cumparari, coteV: byCota(vanzari), coteC: byCota(cumparari), totals: Object.assign(tot, { deplata, derecuperat }) };
}

/** Jurnal de banca / casa pentru un cont de trezorerie, cu sold curent (running balance). */
function cashBankJournal(db, cont, period) {
  cont = cont || '5121';
  const opening = (db.openingBalances || {})[cont] || { d: 0, c: 0 };
  const before = accumulate(allLines(db.entries.filter((e) => beforePeriod(e, period))))[cont] || { d: 0, c: 0 };
  let sold = round2((opening.d + before.d) - (opening.c + before.c)); // sold initial
  const siInitial = sold;
  const periodLines = allLines(db.entries.filter((e) => inPeriod(e, period)))
    .filter((l) => l.debit === cont || l.credit === cont)
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  let rd = 0; let rc = 0;
  const rows = periodLines.map((l) => {
    const incasare = l.debit === cont ? l.suma : 0;
    const plata = l.credit === cont ? l.suma : 0;
    rd = round2(rd + incasare); rc = round2(rc + plata);
    sold = round2(sold + incasare - plata);
    return { data: l.data, document: l.document, explicatie: l.explicatie, partener: l.partener, incasare, plata, sold };
  });
  return { cont, nume: coa.accountName(cont), period, siInitial, rows, rd, rc, sfFinal: sold };
}

/** Fisa de cont: toate miscarile unui cont in perioada, cu contul corespondent si sold curent.
 *  Generalizarea jurnalului de banca/casa la orice cont din plan (401, 4111, 371, 601...). */
function fisaCont(db, cont, period) {
  cont = String(cont || '').trim();
  const opening = (db.openingBalances || {})[cont] || { d: 0, c: 0 };
  const before = accumulate(allLines(db.entries.filter((e) => beforePeriod(e, period))))[cont] || { d: 0, c: 0 };
  let sold = round2((opening.d + before.d) - (opening.c + before.c));
  const siInitial = sold;
  const lines = allLines(db.entries.filter((e) => inPeriod(e, period)))
    .filter((l) => l.debit === cont || l.credit === cont)
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  let rd = 0; let rc = 0;
  const rows = lines.map((l) => {
    const d = l.debit === cont ? l.suma : 0;
    const c = l.credit === cont ? l.suma : 0;
    rd = round2(rd + d); rc = round2(rc + c);
    sold = round2(sold + d - c);
    return { data: l.data, document: l.document, explicatie: l.explicatie, partener: l.partener, corespondent: l.debit === cont ? l.credit : l.debit, d, c, sold };
  });
  return { cont, nume: coa.accountName(cont), period, siInitial, rows, rd, rc, sfFinal: sold };
}

/**
 * Registru de casa in valuta (cont 5314): pentru fiecare miscare, suma in lei (din linie) si suma in
 * valuta (din e.valutaInfo), cu solduri curente in ambele. Soldul in valuta acumuleaza doar moneda
 * selectata; soldul in lei reflecta tot ce trece prin 5314. Diferentele de curs (665/765=5314) ajusteaza
 * doar leii (fara valutaInfo -> 0 valuta), corect.
 */
function cashRegisterValuta(db, period, moneda) {
  const cont = '5314';
  moneda = String(moneda || 'EUR').toUpperCase();
  const opening = (db.openingBalances || {})[cont] || { d: 0, c: 0 };
  let soldLei = round2(opening.d - opening.c);
  for (const e of db.entries.filter((x) => beforePeriod(x, period))) {
    for (const l of (e.lines || [])) { if (l.debit === cont) soldLei = round2(soldLei + l.suma); if (l.credit === cont) soldLei = round2(soldLei - l.suma); }
  }
  const siLei = soldLei;
  let soldVal = 0; const rows = [];
  let rdLei = 0; let rcLei = 0; let rdVal = 0; let rcVal = 0;
  const ents = db.entries.filter((e) => inPeriod(e, period) && (e.lines || []).some((l) => l.debit === cont || l.credit === cont))
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  for (const e of ents) {
    for (const l of (e.lines || [])) {
      if (l.debit !== cont && l.credit !== cont) continue;
      const isIn = l.debit === cont;
      const vi = e.valutaInfo; const sameCur = !!(vi && vi.valuta === moneda);
      const incasareLei = isIn ? l.suma : 0; const plataLei = isIn ? 0 : l.suma;
      const incasareVal = (isIn && sameCur) ? vi.sumaValuta : 0; const plataVal = (!isIn && sameCur) ? vi.sumaValuta : 0;
      rdLei = round2(rdLei + incasareLei); rcLei = round2(rcLei + plataLei);
      rdVal = round2(rdVal + incasareVal); rcVal = round2(rcVal + plataVal);
      soldLei = round2(soldLei + incasareLei - plataLei);
      soldVal = round2(soldVal + incasareVal - plataVal);
      rows.push({ data: e.data, document: e.document || '', explicatie: e.explicatie || e.tipNume || '', partener: e.partener || '',
        moneda: vi ? vi.valuta : '', curs: vi ? vi.curs : 0, incasareVal, plataVal, incasareLei, plataLei, soldLei, soldVal });
    }
  }
  return { cont, nume: coa.accountName(cont), moneda, period, siLei, rows, rdLei, rcLei, rdVal, rcVal, soldFinalLei: soldLei, soldFinalVal: soldVal };
}

/**
 * Controlul casei: depisteaza (1) soldul de casa NEGATIV (imposibil fizic -> eroare de inregistrare)
 * si (2) depasirea plafoanelor de numerar (Legea 70/2015): 5.000 lei/zi/persoana juridica,
 * 10.000 lei/zi/persoana fizica, plus soldul de casierie peste 50.000 lei.
 */
function cashControl(db, cont, period) {
  cont = cont || '5311';
  const opening = (db.openingBalances || {})[cont] || { d: 0, c: 0 };
  const before = accumulate(allLines(db.entries.filter((e) => beforePeriod(e, period))))[cont] || { d: 0, c: 0 };
  let sold = round2((opening.d + before.d) - (opening.c + before.c));
  const movs = [];
  for (const e of db.entries.filter((x) => inPeriod(x, period))) {
    for (const l of e.lines) {
      if (l.debit === cont || l.credit === cont) {
        movs.push({ data: e.data, partener: e.partener || '', cui: e.partenerCui || '', document: e.document || '',
          incasare: l.debit === cont ? round2(l.suma) : 0, plata: l.credit === cont ? round2(l.suma) : 0 });
      }
    }
  }
  movs.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  // (1) sold negativ
  const negative = [];
  for (const m of movs) {
    sold = round2(sold + m.incasare - m.plata);
    if (sold < -0.005) negative.push({ data: m.data, document: m.document, sold });
  }
  // (2) plafon pe (zi × partener)
  const byKey = {};
  for (const m of movs) {
    if (!m.partener && !m.cui) continue;
    const key = m.data + '|' + (m.cui || m.partener);
    const g = byKey[key] || (byKey[key] = { data: m.data, partener: m.partener, cui: m.cui, incasari: 0, plati: 0 });
    g.incasari = round2(g.incasari + m.incasare); g.plati = round2(g.plati + m.plata);
  }
  const plafon = [];
  for (const g of Object.values(byKey)) {
    const juridic = !!g.cui;
    const limita = juridic ? 5000 : 10000;
    if (g.plati > limita) plafon.push({ data: g.data, partener: g.partener || g.cui, juridic, tip: 'plata', suma: g.plati, limita });
    if (g.incasari > limita) plafon.push({ data: g.data, partener: g.partener || g.cui, juridic, tip: 'incasare', suma: g.incasari, limita });
  }
  const soldPesteLimita = sold > 50000 ? { sold, limita: 50000 } : null;
  return { cont, period, soldFinal: sold, negative, plafon, soldPesteLimita, ok: !negative.length && !plafon.length && !soldPesteLimita };
}

module.exports = {
  allLines, sortEntries, accumulate, journal, journalNr, ledger, trialBalance, vatClosing, annualClosing, profitTax, resultDistribution, vatJournals, cashBankJournal, fisaCont, cashRegisterValuta, cashControl, tvaNeexigibila,
};
