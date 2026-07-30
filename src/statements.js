'use strict';

const { round2, period: periodOf } = require('./util');
const coa = require('./chartOfAccounts');
const { allLines, resultLines, accumulate, postedEntries, periodEnd } = require('./accounting');

/** Solduri finale nete (cont -> net) la sfarsitul unei perioade (inclusiv), cumulat.
 *  `asOf` poate fi luna, trimestru sau an — comparatia se face pe ULTIMA luna acoperita, fiindca
 *  pe forma `YYYY-Qn` compararea directa de siruri ar include si lunile de dupa trimestru. */
function finalBalances(db, asOf) {
  const opening = db.openingBalances || {};
  const lastM = asOf ? periodEnd(asOf) : null;
  const ent = postedEntries(db).filter((e) => !lastM || (e.period || periodOf(e.data)) <= lastM);
  const acc = accumulate(allLines(ent));
  const codes = new Set([...Object.keys(opening), ...Object.keys(acc)]);
  const net = {};
  for (const cod of codes) {
    const op = opening[cod] || { d: 0, c: 0 };
    const a = acc[cod] || { d: 0, c: 0 };
    net[cod] = round2((op.d + a.d) - (op.c + a.c));
  }
  return net;
}

function sumNet(net, predicate, sign) {
  let s = 0;
  for (const cod of Object.keys(net)) {
    if (predicate(cod, coa.getAccount(cod))) s = round2(s + sign * net[cod]);
  }
  return s;
}

const classOf = (cod) => (coa.getAccount(cod) || {}).clasa || Number(String(cod)[0]);
const starts = (cod, ...pre) => pre.some((p) => String(cod).startsWith(p));

/** Contul de profit si pierdere pentru un an (din rulajele claselor 6 si 7). */
function profitLoss(db, year) {
  const ent = postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
  const acc = accumulate(resultLines(ent)); // fara inchiderile 6/7 -> 121
  const venit = (cod) => round2((acc[cod] ? acc[cod].c - acc[cod].d : 0));
  const chelt = (cod) => round2((acc[cod] ? acc[cod].d - acc[cod].c : 0));

  const codes = Object.keys(acc);
  // financiar = grupa 66 + 686 (ajustari financiare), respectiv 76 + 786 (venituri financiare din ajustari)
  const venitExpl = round2(codes.filter((c) => classOf(c) === 7 && !starts(c, '76', '786')).reduce((s, c) => s + venit(c), 0));
  const venitFin = round2(codes.filter((c) => starts(c, '76', '786')).reduce((s, c) => s + venit(c), 0));
  const cheltExpl = round2(codes.filter((c) => classOf(c) === 6 && !starts(c, '66', '686', '691', '698')).reduce((s, c) => s + chelt(c), 0));
  const cheltFin = round2(codes.filter((c) => starts(c, '66', '686')).reduce((s, c) => s + chelt(c), 0));
  const impozit = round2(codes.filter((c) => starts(c, '691', '698')).reduce((s, c) => s + chelt(c), 0));

  const rezExpl = round2(venitExpl - cheltExpl);
  const rezFin = round2(venitFin - cheltFin);
  const rezBrut = round2(rezExpl + rezFin);
  const rezNet = round2(rezBrut - impozit);

  // detaliere pe conturi (pentru raport)
  const detaliiVenituri = codes.filter((c) => classOf(c) === 7 && venit(c) !== 0)
    .map((c) => ({ cod: c, nume: coa.accountName(c), suma: venit(c) })).sort((a, b) => a.cod.localeCompare(b.cod));
  const detaliiCheltuieli = codes.filter((c) => classOf(c) === 6 && chelt(c) !== 0)
    .map((c) => ({ cod: c, nume: coa.accountName(c), suma: chelt(c) })).sort((a, b) => a.cod.localeCompare(b.cod));

  return {
    year, venitExpl, cheltExpl, rezExpl, venitFin, cheltFin, rezFin,
    venitTotal: round2(venitExpl + venitFin), cheltTotal: round2(cheltExpl + cheltFin),
    rezBrut, impozit, rezNet, detaliiVenituri, detaliiCheltuieli,
  };
}

/** Bilant simplificat la sfarsitul unei perioade. */
function balanceSheet(db, asOf) {
  const net = finalBalances(db, asOf);

  // ACTIV
  const imobilizari = sumNet(net, (c) => classOf(c) === 2, 1); // include amortizari (negative)
  const stocuri = sumNet(net, (c) => classOf(c) === 3 && net[c] > 0, 1);
  const creante = sumNet(net, (c) => classOf(c) === 4 && net[c] > 0, 1);
  const casa = sumNet(net, (c) => classOf(c) === 5 && net[c] > 0, 1);
  const totalActiv = round2(imobilizari + stocuri + creante + casa);

  // PASIV
  // capitaluri proprii: clasa 1 (capital, rezerve, 121/117) ...
  const capitaluriClasa1 = sumNet(net, (c) => classOf(c) === 1, -1); // pasiv -> credit pozitiv
  // ... plus rezultatul curent neinchis, aflat inca in conturile de clasa 6 si 7.
  // (dupa inchiderea anuala acesta este 0, fiind mutat in contul 121 din clasa 1)
  const rezultatCurent = round2(-sumNet(net, (c) => classOf(c) === 6 || classOf(c) === 7, 1));
  const capitaluri = round2(capitaluriClasa1 + rezultatCurent);
  const datoriiTerti = sumNet(net, (c) => classOf(c) === 4 && net[c] < 0, -1);
  const datoriiFin = sumNet(net, (c) => classOf(c) === 5 && net[c] < 0, -1);
  const totalPasiv = round2(capitaluri + datoriiTerti + datoriiFin);

  // detaliere pe conturi (doar clasele de bilant 1-5)
  const detalii = Object.keys(net).filter((c) => net[c] !== 0 && classOf(c) <= 5)
    .map((c) => ({ cod: c, nume: coa.accountName(c), clasa: classOf(c), net: net[c] }))
    .sort((a, b) => a.cod.localeCompare(b.cod));

  return {
    asOf, imobilizari, stocuri, creante, casa, totalActiv,
    capitaluriClasa1, rezultatCurent, capitaluri,
    datorii: round2(datoriiTerti + datoriiFin), totalPasiv,
    echilibrat: totalActiv === totalPasiv, detalii,
  };
}

/**
 * Bilant pe structura oficiala F10 (prescurtat, OMFP 1802/2014): conturile mapate pe randuri,
 * cu separarea datoriilor curente (sub 1 an) de cele pe termen lung (peste 1 an).
 * Conturile bifunctionale (clasa 4) se clasifica dupa semnul soldului (creanta vs datorie).
 */
function balanceSheetF10(db, asOf) {
  const net = finalBalances(db, asOf);
  const R = {}; // randuri -> suma
  const add = (row, val) => { R[row] = round2((R[row] || 0) + val); };
  const starts = (c, ...p) => p.some((x) => String(c).startsWith(x));

  for (const cod of Object.keys(net)) {
    const v = net[cod]; // pozitiv = sold debitor
    if (Math.abs(v) < 0.005) continue;
    const cl = classOf(cod);
    if (cl >= 6) continue; // clasele 6/7/8/9 nu sunt de bilant (efectul intra prin rezultatul curent)
    // ── ACTIVE imobilizate (clasa 2) — net de amortizari/ajustari (28x/29x au sold creditor => v negativ)
    if (cl === 2) {
      if (starts(cod, '20', '233', '234', '280', '290')) add('A_necorp', v);
      else if (starts(cod, '26', '296')) add('A_financ', v);
      else add('A_corp', v); // 21x, 231, 235, 281x, 291x, 2931
      continue;
    }
    // ── STOCURI (clasa 3), net de ajustari 39x
    if (cl === 3) { add('B_stocuri', v); continue; }
    // ── Cheltuieli in avans
    if (starts(cod, '471')) { add('C_cheltAvans', v); continue; }
    // ── Venituri in avans
    if (starts(cod, '472', '475')) { add('I_venitAvans', -v); continue; }
    // ── Capitaluri proprii (capital, prime, rezerve, reportat, rezultat) — sold creditor
    if (cl === 1 && starts(cod, '101', '102', '103', '104', '105', '106', '108', '117', '121', '129')) { add('J_capital', -v); continue; }
    // ── Datorii pe termen lung (>1 an): imprumuturi si datorii asimilate, leasing (clasa 1, grupa 16)
    if (cl === 1 && starts(cod, '16')) { add('G_datoriiLT', -v); continue; }
    // ── Provizioane
    if (cl === 1 && starts(cod, '15')) { add('H_provizioane', -v); continue; }
    // ── Investitii pe termen scurt (clasa 5, grupa 50), net de ajustari 59x
    if (starts(cod, '50', '59')) { add(v >= 0 ? 'B_investTS' : 'D_datorii', v >= 0 ? v : -v); continue; }
    // ── Casa si conturi la banci (51x/53x/54x) — daca e sold creditor (descoperit) -> datorie curenta
    if (starts(cod, '51', '52', '53', '54')) { if (v >= 0) add('B_casa', v); else add('D_datorii', -v); continue; }
    // ── Clasa 4 si rest clasa 5 (bifunctionale): semnul decide creanta vs datorie curenta
    if (v > 0) add('B_creante', v); else add('D_datorii', -v);
  }

  // Rezultatul curent neinchis (clasa 6/7) intra in capitaluri pana la inchiderea anuala
  const rezultatCurent = round2(-sumNet(net, (c) => classOf(c) === 6 || classOf(c) === 7, 1));
  R.J_capital = round2((R.J_capital || 0) + rezultatCurent);

  const g = (k) => round2(R[k] || 0);
  const A = round2(g('A_necorp') + g('A_corp') + g('A_financ'));
  const B = round2(g('B_stocuri') + g('B_creante') + g('B_investTS') + g('B_casa'));
  const C = g('C_cheltAvans');
  const D = g('D_datorii');
  const G = g('G_datoriiLT');
  const H = g('H_provizioane');
  const I = g('I_venitAvans');
  const J = g('J_capital');
  const totalActiv = round2(A + B + C);
  const totalPasiv = round2(J + D + G + H + I);
  const activeCircNete = round2(B + C - D - I); // E (oficial)
  return {
    asOf,
    randuri: {
      A_necorp: g('A_necorp'), A_corp: g('A_corp'), A_financ: g('A_financ'), A,
      B_stocuri: g('B_stocuri'), B_creante: g('B_creante'), B_investTS: g('B_investTS'), B_casa: g('B_casa'), B,
      C_cheltAvans: C, D_datorii: D, E_activeCircNete: activeCircNete, F_totalMinusDat: round2(A + activeCircNete),
      G_datoriiLT: G, H_provizioane: H, I_venitAvans: I, J_capital: J, rezultatCurent,
    },
    totalActiv, totalPasiv, echilibrat: totalActiv === totalPasiv,
  };
}

/**
 * Contul de profit si pierdere pe structura oficiala F20 (prescurtat, OMFP 1802/2014):
 * rulajele claselor 6 si 7 mapate pe randurile oficiale, cu separarea exploatare/financiar.
 * Sumele „alte..." sunt reziduale, ca totalurile sa fie garantat consistente cu rulajul total.
 */
function profitLossF20(db, year) {
  const ent = postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
  const acc = accumulate(resultLines(ent)); // fara inchiderile 6/7 -> 121
  const venit = (cod) => round2((acc[cod] ? acc[cod].c - acc[cod].d : 0));
  const chelt = (cod) => round2((acc[cod] ? acc[cod].d - acc[cod].c : 0));
  const codes = Object.keys(acc);
  const sv = (pred) => round2(codes.filter(pred).reduce((s, c) => s + venit(c), 0));
  const sc = (pred) => round2(codes.filter(pred).reduce((s, c) => s + chelt(c), 0));

  // ── VENITURI din exploatare (toata clasa 7 mai putin 76/786 = financiar)
  const venitExpl = sv((c) => classOf(c) === 7 && !starts(c, '76', '786'));
  const cifraAfaceri = sv((c) => starts(c, '70'));                       // 701-708 (709 = reduceri, sold debitor -> scade)
  const venitProductie = sv((c) => starts(c, '711', '712', '721', '722')); // variatia stocurilor + productie imobilizata
  const alteVenitExpl = round2(venitExpl - cifraAfaceri - venitProductie); // 74x/75x/78x si rest

  // ── CHELTUIELI de exploatare (toata clasa 6 mai putin 66/686 = financiar si 691/698 = impozit)
  const cheltExpl = sc((c) => classOf(c) === 6 && !starts(c, '66', '686', '691', '698'));
  const cheltMateriale = sc((c) => starts(c, '60'));   // 601-609 (materii, marfuri, energie)
  const cheltPersonal = sc((c) => starts(c, '64'));    // salarii + contributii angajator
  const amortizare = sc((c) => starts(c, '681'));      // ajustari de valoare (amortizari/ajustari exploatare)
  const alteCheltExpl = round2(cheltExpl - cheltMateriale - cheltPersonal - amortizare); // 61x/62x/63x/65x si rest

  const rezExpl = round2(venitExpl - cheltExpl);

  // ── FINANCIAR
  const venitFin = sv((c) => starts(c, '76', '786'));
  const cheltFin = sc((c) => starts(c, '66', '686'));
  const rezFin = round2(venitFin - cheltFin);

  // ── TOTALURI
  const venitTotal = round2(venitExpl + venitFin);
  const cheltTotal = round2(cheltExpl + cheltFin);
  const rezBrut = round2(rezExpl + rezFin);
  const impozit = sc((c) => starts(c, '691', '698'));
  const rezNet = round2(rezBrut - impozit);

  return {
    year: String(year),
    cifraAfaceri, venitProductie, alteVenitExpl, venitExpl,
    cheltMateriale, cheltPersonal, amortizare, alteCheltExpl, cheltExpl,
    rezExpl, venitFin, cheltFin, rezFin,
    venitTotal, cheltTotal, rezBrut, impozit, rezNet,
  };
}

/**
 * Situatia fluxurilor de trezorerie (F30) — metoda directa.
 * Fiecare miscare de numerar (linie ce atinge un cont de trezorerie) e clasificata dupa contrapartida
 * in exploatare / investitie / finantare; semnul = incasare (+) / plata (-). Transferurile interne
 * intre conturi de trezorerie se ignora. Prin constructie: variatia = numerar final - numerar initial.
 */
function cashFlow(db, year) {
  const y = String(year);
  const Y0 = String(Number(y) - 1);
  const isCash = (c) => /^(512|531|541|542|5125|5114)/.test(String(c));
  const open = finalBalances(db, Y0 + '-12');
  const close = finalBalances(db, y + '-12');
  const sumCash = (o) => round2(Object.keys(o).filter(isCash).reduce((s, c) => s + o[c], 0));
  const numerarInitial = sumCash(open);
  const numerarFinal = sumCash(close);

  const b = {
    ex_clienti: 0, ex_furnizoriAngajati: 0, ex_impozite: 0, ex_dobanzi: 0, ex_altele: 0,
    inv_imobilizari: 0, inv_dobanziDiv: 0, fin_credite: 0, fin_capital: 0, fin_dividende: 0,
  };
  const addB = (k, v) => { b[k] = round2(b[k] + v); };
  const cls = (cont) => {
    const c = String(cont);
    if (/^(20|21|22|23|26|27|404|405)/.test(c)) return 'inv_imobilizari';
    if (/^(761|762|763|764|765)/.test(c)) return 'inv_dobanziDiv';
    if (/^(16|159|519|455|509|269)/.test(c)) return 'fin_credite';
    if (/^(101|102|103|104|105|108|456)/.test(c)) return 'fin_capital';
    if (/^457/.test(c)) return 'fin_dividende';
    if (/^(40|419)/.test(c) || /^(42|43)/.test(c)) return 'ex_furnizoriAngajati';
    if (/^44/.test(c)) return 'ex_impozite';
    if (/^(666|518)/.test(c)) return 'ex_dobanzi';
    if (/^(41|418|70)/.test(c)) return 'ex_clienti';
    return 'ex_altele';
  };

  const ents = postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(y));
  for (const e of ents) {
    for (const ln of (e.lines || [])) {
      const dCash = isCash(ln.debit); const cCash = isCash(ln.credit);
      if (dCash === cCash) continue; // ambele trezorerie (transfer intern) sau niciuna
      const sign = dCash ? 1 : -1;   // numerar in cont => incasare; numerar in credit => plata
      addB(cls(dCash ? ln.credit : ln.debit), round2(sign * round2(ln.suma)));
    }
  }

  const ex_net = round2(b.ex_clienti + b.ex_furnizoriAngajati + b.ex_impozite + b.ex_dobanzi + b.ex_altele);
  const inv_net = round2(b.inv_imobilizari + b.inv_dobanziDiv);
  const fin_net = round2(b.fin_credite + b.fin_capital + b.fin_dividende);
  const variatie = round2(ex_net + inv_net + fin_net);
  const variatieControl = round2(numerarFinal - numerarInitial);
  return Object.assign({ year: y, numerarInitial, numerarFinal }, b, {
    ex_net, inv_net, fin_net, variatie, variatieControl,
    echilibrat: Math.abs(variatie - variatieControl) < 0.01,
  });
}

/**
 * Situatia modificarilor capitalurilor proprii (F40): pentru fiecare element de capital propriu,
 * sold la inceput -> cresteri (rulaj creditor) - reduceri (rulaj debitor) -> sold la sfarsit.
 * Include rezultatul curent neinchis (inca in clasele 6/7), pentru reconciliere cu F10.
 */
function equityChanges(db, year) {
  const y = String(year);
  const Y0 = String(Number(y) - 1);
  const open = finalBalances(db, Y0 + '-12');
  const close = finalBalances(db, y + '-12');
  const ru = accumulate(allLines(postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(y))));
  const sumO = (o, m) => round2(Object.keys(o).filter(m).reduce((s, c) => s + o[c], 0));
  const sumRu = (m, k) => round2(Object.keys(ru).filter(m).reduce((s, c) => s + ((ru[c] && ru[c][k]) || 0), 0));
  const st = (c, ...p) => p.some((x) => String(c).startsWith(x));

  const groups = [
    { nume: 'Capital subscris', m: (c) => st(c, '101') },
    { nume: 'Prime de capital', m: (c) => st(c, '104') },
    { nume: 'Rezerve din reevaluare', m: (c) => st(c, '105') },
    { nume: 'Rezerve legale', m: (c) => st(c, '1061') },
    { nume: 'Alte rezerve', m: (c) => st(c, '106') && !st(c, '1061') },
    { nume: 'Rezultatul reportat', m: (c) => st(c, '117') },
    { nume: 'Rezultatul exercițiului', m: (c) => st(c, '121') },
    { nume: 'Repartizarea profitului', m: (c) => st(c, '129') },
  ];
  const rows = groups.map((g) => ({
    nume: g.nume,
    soldI: round2(-sumO(open, g.m)),
    cresteri: sumRu(g.m, 'c'),
    reduceri: sumRu(g.m, 'd'),
    soldF: round2(-sumO(close, g.m)),
  })).filter((r) => r.soldI || r.cresteri || r.reduceri || r.soldF);

  // rezultatul curent neinchis (inca in clasele 6 si 7) — apare in capitaluri pana la inchiderea anuala
  const rezultatNeinchis = round2(-sumNet(close, (c) => classOf(c) === 6 || classOf(c) === 7, 1));
  if (Math.abs(rezultatNeinchis) >= 0.005) {
    rows.push({
      nume: 'Rezultatul exercițiului (neînchis)',
      soldI: 0, cresteri: rezultatNeinchis > 0 ? rezultatNeinchis : 0, reduceri: rezultatNeinchis < 0 ? round2(-rezultatNeinchis) : 0, soldF: rezultatNeinchis,
    });
  }

  const tot = (k) => round2(rows.reduce((s, r) => s + r[k], 0));
  const total = { soldI: tot('soldI'), cresteri: tot('cresteri'), reduceri: tot('reduceri'), soldF: tot('soldF') };
  const f10 = balanceSheetF10(db, y + '-12');
  return { year: y, rows, total, capitalPropriiF10: f10.randuri.J_capital, echilibrat: Math.abs(total.soldF - f10.randuri.J_capital) < 0.01 };
}

module.exports = { profitLoss, profitLossF20, balanceSheet, balanceSheetF10, cashFlow, equityChanges, finalBalances };
