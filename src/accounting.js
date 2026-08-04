'use strict';

const { round2, period: periodOf, naturalCompare } = require('./util');
const coa = require('./chartOfAccounts');
const deduct = require('./deductibilitate');
const fiscal = require('./fiscal'); // doar pentru plafoanele Legii 70/2015 (fiscal.js nu depinde de acest modul)

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

/** Comparatorul cronologic al articolelor: data, apoi id NATURAL (e2 inaintea lui e10). */
function entryChrono(a, b) {
  if (a.data !== b.data) return a.data < b.data ? -1 : 1;
  return naturalCompare(a.id, b.id);
}

/** Sorteaza entries cronologic (dupa data, apoi id). */
function sortEntries(entries) {
  return [...entries].sort(entryChrono);
}

/**
 * Ultimele `n` articole in ordine cronologica DESCRESCATOARE — identic cu
 * `sortEntries(entries).slice(-n).reverse()`, dar fara a sorta toata colectia:
 * o singura trecere cu o lista de n elemente (n e mic: 5 pe dashboard). Sortarea completa
 * pentru cinci randuri costa 176 ms la 22.000 de articole; asta costa sub 10 ms.
 */
function lastEntries(entries, n) {
  const k = Math.max(0, Number(n) || 0);
  const top = []; // cronologic DESCRESCATOR (cel mai nou primul)
  for (const e of (entries || [])) {
    if (top.length === k && k > 0 && entryChrono(e, top[k - 1]) <= 0) continue;
    let i = 0;
    while (i < top.length && entryChrono(e, top[i]) < 0) i += 1;
    top.splice(i, 0, e);
    if (top.length > k) top.pop();
  }
  return top;
}

// Perioada fiscala TVA a firmei pentru o luna: regim 'T' (trimestrial) -> trimestrul care
// contine luna ('YYYY-Qn'); altfel luna ca atare. Declaratiile TVA (D300/D394/D406) agrega
// astfel intreg trimestrul pentru platitorii trimestriali.
function vatPeriod(company, monthPeriod) {
  const m = String(monthPeriod || '').match(/^(\d{4})-(\d{2})$/);
  if (m && company && company.perioadaTva === 'T') return m[1] + '-Q' + Math.ceil(Number(m[2]) / 3);
  return monthPeriod;
}

// Un articol intra in CONTABILITATE (balanta, jurnale, cartea mare, declaratii) doar cand e
// POSTAT. Ciornele (status ciorna/validat/aprobat) sunt vizibile in liste, dar NU se agrega —
// filtrarea se face aici, la sursa, pentru toate agregarile. Articolele vechi si cele create
// direct nu au `status` => tratate ca postate (compatibilitate: zero schimbare pe date existente).
function isPosted(e) { return !e.status || e.status === 'postat'; }
function postedEntries(view) { return (view.entries || []).filter(isPosted); }

function inPeriod(e, period) {
  if (!period) return true;
  const q = String(period).match(/^(\d{4})-Q([1-4])$/);
  if (q) { // trimestru: cele 3 luni ale lui
    const ep = String(e.period || e.data || '').slice(0, 7);
    const yr = q[1]; const qn = Number(q[2]);
    const luni = [qn * 3 - 2, qn * 3 - 1, qn * 3].map((x) => yr + '-' + String(x).padStart(2, '0'));
    return luni.includes(ep);
  }
  const ep = e.period || periodOf(e.data);
  if (period.length === 4) return ep.slice(0, 4) === period; // an intreg (YYYY)
  return ep === period; // luna exacta (YYYY-MM)
}

/**
 * Prima / ultima luna (YYYY-MM) acoperita de o perioada, indiferent de forma ei: luna (YYYY-MM),
 * trimestru (YYYY-Qn) sau an intreg (YYYY).
 *
 * Compararea directa de siruri NU merge pe trimestre: `'2026-08' < '2026-Q2'` e ADEVARAT
 * lexicografic (cifra '0' < litera 'Q'). Asa, soldul initial al unui trimestru inghitea tot anul —
 * inclusiv lunile de DUPA el — iar rulajul trimestrului se numara si in sold, si in rulaj:
 *   Q2, cont 704 cu 1000 (ian) + 2000 (mai) + 3000 (aug)  ->  SI 6000, rulaj 2000, SF 8000.
 * Balanta ramanea `balanced: true` (eroarea e simetrica pe debit si credit), deci verificarea de
 * echilibru nu o putea prinde. `inPeriod` trata deja corect trimestrele; doar capetele nu.
 */
function periodStart(period) {
  const p = String(period || '');
  const q = p.match(/^(\d{4})-Q([1-4])$/);
  if (q) return q[1] + '-' + String(Number(q[2]) * 3 - 2).padStart(2, '0');
  return p.length === 4 ? p + '-01' : p;
}
function periodEnd(period) {
  const p = String(period || '');
  const q = p.match(/^(\d{4})-Q([1-4])$/);
  if (q) return q[1] + '-' + String(Number(q[2]) * 3).padStart(2, '0');
  return p.length === 4 ? p + '-12' : p;
}

function beforePeriod(e, period) {
  if (!period) return false;
  return (e.period || periodOf(e.data)) < periodStart(period);
}

/**
 * Linia inchide un cont de rezultat in 121 (cheltuieli: 121 = 6xx; venituri: 7xx = 121)?
 *
 * Inchiderea NU e o operatiune economica — doar muta soldurile claselor 6/7 in rezultat — dar
 * pe cont produce un rulaj egal si de sens opus celui din cursul anului. Deci orice agregare a
 * claselor 6/7 pe an trebuie sa o EXCLUDA: altfel rulajele se anuleaza reciproc si, dupa
 * inchiderea anuala, TOATE rapoartele de rezultat ies zero — impozitul pe profit, contul de
 * profit si pierdere (F20), registrul fiscal, impozitul micro, Declaratia Unica.
 *
 * Regula e STRUCTURALA, nu dupa `tip`: prinde si nota contabila libera 121 = 6xx scrisa de mana,
 * si linia 121 = 691 atasata impozitului pe profit cand anul era deja inchis.
 *
 * Exceptia deliberata e `annualClosing`, care se bazeaza pe anulare ca sa calculeze CE A MAI
 * RAMAS de inchis — de aceea ramane pe `allLines` si o a doua rulare nu posteaza nimic.
 */
function isResultClosingLine(l) {
  const clasa = (cod) => {
    const a = coa.getAccount(cod);
    return a ? a.clasa : Number(String(cod)[0]);
  };
  const d = String(l.debit); const c = String(l.credit);
  if (d === '121') return clasa(c) === 6 || clasa(c) === 7;
  if (c === '121') return clasa(d) === 6 || clasa(d) === 7;
  return false;
}

/** Liniile articolelor, fara inchiderile de rezultat — vederea pentru orice agregare 6/7. */
function resultLines(entries) {
  return allLines(entries).filter((l) => !isResultClosingLine(l));
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
  const entries = sortEntries(postedEntries(db).filter((e) => inPeriod(e, period)));
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
  for (const e of postedEntries(db).filter((x) => inPeriod(x, period) || !period)) {
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
  const sorted = sortEntries(postedEntries(db));
  const idx = sorted.findIndex((e) => e.id === entryId);
  return idx < 0 ? null : idx + 1;
}

/** Cartea mare: pentru fiecare cont, soldul initial, miscarile perioadei si soldul final. */
function ledger(db, period) {
  // solduri initiale = opening + miscari inainte de perioada
  const before = accumulate(allLines(postedEntries(db).filter((e) => beforePeriod(e, period))));
  const opening = db.openingBalances || {};
  const accounts = new Set([...Object.keys(opening), ...Object.keys(before)]);

  // miscarile in ordine CRONOLOGICA (data + id natural), nu in ordinea colectiei — cartea mare
  // se citeste cronologic; ordinea identica face si calea SQL (ledgerSql) echivalenta bit cu bit
  const periodLines = allLines(sortEntries(postedEntries(db).filter((e) => inPeriod(e, period))));
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
  const before = accumulate(allLines(postedEntries(db).filter((e) => beforePeriod(e, period))));
  const opening = db.openingBalances || {};
  const periodLines = allLines(postedEntries(db).filter((e) => inPeriod(e, period)));
  const rulaj = accumulate(periodLines);
  return buildBalanceRows(before, opening, rulaj, period);
}

/** Construieste randurile+totalurile balantei din cele trei acumulari {cont:{d,c}}: `before`
 *  (rulaj inainte de perioada), `opening` (solduri de preluare), `rulaj` (rulajul perioadei).
 *  Extras din trialBalance ca sa fie alimentabil SI din SQL (store.linesTurnover), nu doar din RAM. */
function buildBalanceRows(before, opening, rulaj, period) {
  before = before || {}; opening = opening || {}; rulaj = rulaj || {};
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
  const rulaj = accumulate(allLines(postedEntries(db).filter((e) => inPeriod(e, period))));
  const c4427 = rulaj['4427'] || { d: 0, c: 0 };
  const c4426 = rulaj['4426'] || { d: 0, c: 0 };
  const colectata = round2(c4427.c - c4427.d);
  const deductibila = round2(c4426.d - c4426.c);
  const lines = [];
  const comp = Math.min(colectata, deductibila);
  if (comp > 0) lines.push({ debit: '4427', credit: '4426', suma: round2(comp), explicatie: 'Compensare TVA colectată cu TVA deductibilă' });
  const diff = round2(colectata - deductibila);
  if (diff > 0) lines.push({ debit: '4427', credit: '4423', suma: diff, explicatie: 'TVA de plată' });
  else if (diff < 0) lines.push({ debit: '4424', credit: '4426', suma: round2(-diff), explicatie: 'TVA de recuperat' });
  return { colectata, deductibila, diff, lines };
}

/** Calculeaza articolele de inchidere a conturilor de venituri si cheltuieli (clasa 6/7) intr-un an. */
function annualClosing(db, year) {
  const yearEntries = postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
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

// Plafonul de recuperare a pierderii fiscale (Legea 296/2023): din anul fiscal 2024, pierderea
// reportata se recupereaza in limita a 70% din profitul impozabil al anului; pentru anii <= 2023
// se pastreaza regimul vechi (100%). Plafonul se aplica dupa ANUL recuperarii, deci norma
// tranzitorie il extinde si asupra pierderilor pre-2024 ramase de recuperat dupa 31.12.2023.
const CAP_PIERDERE_AN = 2024;
const CAP_PIERDERE_PCT = 70;

/**
 * Impozitul pe profit pentru un an, cu ajustari fiscale:
 *   profit impozabil = profit contabil + cheltuieli nedeductibile − deduceri − pierdere fiscala reportata
 *   impozit = max(0, profit impozabil) × cota%   →   691 = 4411
 * Nedeductibilele si veniturile neimpozabile vin din `src/deductibilitate.js` — ACELASI motor pe
 * care il citeste registrul de evidenta fiscala (`reporting.registruFiscal`), ca raportul si nota
 * contabila sa nu mai poata da doua impozite diferite pe aceleasi conturi.
 * Pierderea reportata reduce baza pana la 0 (regim vechi, <= 2023) sau doar pana la limita de 70%
 * din profitul impozabil (Legea 296/2023, de la anul fiscal 2024). Restul neacoperit + pierderea
 * anului curent se reporteaza mai departe.
 * `opts` = { cota, cheltNedeductibile, deduceri, pierdereReportata, pierdereRecuperabilaPct }
 * (sau un numar = cota, pentru compat.). `pierdereRecuperabilaPct` suprascrie plafonul de 70%.
 */
function profitTax(db, year, opts) {
  opts = (typeof opts === 'number') ? { cota: opts } : (opts || {});
  const cota = opts.cota || 16;
  const pierdereReportata = round2(Number(opts.pierdereReportata) || 0);
  const yearEntries = postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
  const acc = accumulate(resultLines(yearEntries)); // fara inchiderile 6/7 -> 121 (vezi isResultClosingLine)
  let venit = 0; let chelt = 0;
  for (const cod of Object.keys(acc)) {
    const a = coa.getAccount(cod);
    const clasa = a ? a.clasa : Number(String(cod)[0]);
    if (clasa === 7) venit = round2(venit + (acc[cod].c - acc[cod].d));
    else if (clasa === 6 && !/^(691|698)/.test(String(cod))) chelt = round2(chelt + (acc[cod].d - acc[cod].c));
  }
  const profitContabil = round2(venit - chelt);
  // Ajustarile fiscale: CALCULATE din `src/deductibilitate.js` cand apelantul da cotele
  // (`opts.plafoane`), altfel din valorile transmise. Motorul acopera AMBELE feluri — procentele
  // fixe pe cont (amenzi, provizioane) si plafoanele art. 25/40^2 — fiindca e acelasi pe care il
  // citeste registrul de evidenta fiscala. Cat timp `profitTax` vedea doar plafoanele, nota
  // contabila 691 = 4411 si D101 raportau un impozit mai mic decat propriul registru fiscal.
  const ded = opts.plafoane
    ? deduct.ajustari({
      rulaj: acc, profitContabil,
      cheltAuto: opts.cheltAuto, cheltImpozitProfit: opts.cheltImpozitProfit,
      amortizare: opts.amortizare, // { contabila, fiscala } — art. 28, poate da si deducere
      amortizareFiscala: opts.amortizareFiscala, cursEur: opts.cursEur,
    }, opts.plafoane)
    : null;
  // `cheltNedeductibile` / `deduceri` raman suprascrieri explicite — contract istoric, si singura
  // portita cand contabilul stie o ajustare pe care motorul n-o poate deduce din conturi. ATENTIE:
  // suprascrierea se recunoaste dupa PREZENTA campului, deci un 0 transmis inseamna „zero, exact",
  // nu „calculeaza tu" — formularul trebuie sa trimita campul gol ca sa lase motorul sa lucreze.
  const nedeductibile = (opts.cheltNedeductibile != null && opts.cheltNedeductibile !== '')
    ? round2(Number(opts.cheltNedeductibile) || 0)
    : (ded ? ded.totalNedeductibil : 0);
  const venituriNeimpozabile = ded ? ded.totalNeimpozabil : 0;
  const deduceri = (opts.deduceri != null && opts.deduceri !== '')
    ? round2(Number(opts.deduceri) || 0)
    : venituriNeimpozabile;
  const bazaInainteReportare = round2(profitContabil + nedeductibile - deduceri);
  // Plafonul de 70% (configurabil) se aplica doar pentru anii fiscali >= 2024; altfel recuperare 100%.
  const capPct = (opts.pierdereRecuperabilaPct != null && Number.isFinite(Number(opts.pierdereRecuperabilaPct)))
    ? Number(opts.pierdereRecuperabilaPct) : CAP_PIERDERE_PCT;
  const plafonReportarePct = Number(year) >= CAP_PIERDERE_AN ? capPct : 100;
  const pierdereRecuperabilaMax = bazaInainteReportare > 0 ? round2(bazaInainteReportare * plafonReportarePct / 100) : 0;
  const pierdereFolosita = bazaInainteReportare > 0 ? round2(Math.min(pierdereReportata, pierdereRecuperabilaMax)) : 0;
  const profitImpozabil = round2(bazaInainteReportare - pierdereFolosita);
  const impozitBrut = profitImpozabil > 0 ? round2(profitImpozabil * cota / 100) : 0;
  // FAZA 2 — creditul fiscal al sponsorizarii, care se scade DIN IMPOZIT (nu din baza). Depinde de
  // impozitul de mai sus, deci nu poate fi calculat odata cu nedeductibilele.
  const cifraAfaceri = round2(Object.keys(acc).filter((c) => /^70/.test(String(c)))
    .reduce((s, c) => s + (acc[c].c - acc[c].d), 0));
  const cr = (ded && opts.plafoane)
    ? deduct.credit({
      cifraAfaceri, impozit: impozitBrut, an: Number(year),
      sponsorizareAn: ded.sponsorizareCheltuita, report: opts.sponsorizareReport || [],
    }, opts.plafoane)
    : null;
  const impozit = cr ? cr.impozitDupaCredit : impozitBrut;
  const pierdereCurenta = bazaInainteReportare < 0 ? round2(-bazaInainteReportare) : 0;
  const pierdereDeReportat = round2(pierdereReportata - pierdereFolosita + pierdereCurenta);
  const lines = impozit > 0 ? [{ debit: '691', credit: '4411', suma: impozit, explicatie: 'Impozit pe profit (' + cota + '%)' }] : [];
  return {
    year: String(year), venit, chelt, profitContabil, cheltNedeductibile: nedeductibile, deduceri,
    pierdereReportata, plafonReportarePct, pierdereRecuperabilaMax, pierdereFolosita, profitImpozabil,
    cota, impozit, pierdereCurenta, pierdereDeReportat, lines,
    // Campuri NOI (aditive — forma istorica de mai sus e neatinsa): detaliul plafoanelor si creditul.
    impozitBrut, cifraAfaceri,
    ajustari: ded ? ded.randuri : [],
    // Veniturile neimpozabile (art. 23) intra in `deduceri` de mai sus; aici stau desfasurate,
    // ca raportul sa poata arata DIN CE se compune scaderea, nu doar totalul.
    venituriNeimpozabile, ajustariNeimpozabile: ded ? ded.randuriNeimpozabile : [],
    sponsorizare: cr,
  };
}

/**
 * Soldul net cumulat, la finalul unui an, al conturilor care incep cu `prefix` (pozitiv = debitor),
 * inclusiv soldurile de preluare.
 *
 * PREFIX, nu potrivire exacta: contul sintetic 101 NU exista in planul de conturi — capitalul
 * social sta pe 1011/1012 — iar orice cont poate avea analitice. O cautare exacta pe '101' ar da
 * mereu zero, deci rezerva legala nu s-ar constitui niciodata.
 */
function soldLaFinal(db, year, prefix) {
  const upTo = postedEntries(db).filter((e) => String(e.period || periodOf(e.data)) <= year + '-12');
  const acc = accumulate(allLines(upTo));
  const op = db.openingBalances || {};
  let net = 0;
  for (const cod of new Set([...Object.keys(op), ...Object.keys(acc)])) {
    if (!String(cod).startsWith(prefix)) continue;
    const o = op[cod] || { d: 0, c: 0 }; const a = acc[cod] || { d: 0, c: 0 };
    net = round2(net + (o.d + a.d) - (o.c + a.c));
  }
  return net;
}

/**
 * Rezerva legala de constituit pentru un an: **5% din profitul contabil BRUT** (inainte de
 * impozit), pana cand rezerva atinge **20% din capitalul social** subscris si varsat.
 * Art. 183 din Legea 31/1990 („se va prelua in fiecare an cel putin 5% ... pana ce acesta va
 * atinge minimum a cincea parte din capitalul social") + art. 26 Cod fiscal pentru deductibilitate.
 * Constituirea e OBLIGATORIE cat timp plafonul nu e atins — nu optionala.
 *
 * Baza e profitul BRUT, nu cel net: `profitTax().profitContabil` exclude deja 691/698, deci e
 * exact rezultatul brut din contul de profit si pierdere (F20 `rezBrut`).
 */
function legalReserve(db, year) {
  const brut = profitTax(db, year).profitContabil;
  const capitalSocial = round2(-soldLaFinal(db, year, '101'));   // sold creditor -> pozitiv
  const rezervaExist = round2(-soldLaFinal(db, year, '1061'));
  const plafon = round2(Math.max(0, capitalSocial * 0.20 - rezervaExist));
  const rezerva = brut > 0 ? round2(Math.min(round2(brut * 0.05), plafon)) : 0;
  return { year: String(year), profitBrut: brut, capitalSocial, rezervaExistenta: rezervaExist, plafon, rezerva };
}

/**
 * Repartizarea rezultatului la inceputul anului urmator (dupa aprobarea situatiilor financiare).
 * Profitul NU trece direct in rezultat reportat: intai se constituie rezerva legala, prin contul
 * de repartizare 129, apoi restul merge la 117.
 *   rezerva:   129 = 1061  (constituirea)  si  121 = 129  (inchiderea contului de repartizare)
 *   restul:    121 = 117
 *   pierdere:  117 = 121
 * Calculat pe soldul CUMULAT al lui 121 la sfarsitul anului (dupa inchiderea conturilor 6/7),
 * deci pe profitul NET; rezerva se calculeaza insa pe cel BRUT (vezi legalReserve).
 */
function resultDistribution(db, year) {
  const c121 = soldLaFinal(db, year, '121');
  const net = round2(-c121); // > 0 = profit (sold creditor)
  const rez = legalReserve(db, year);
  // rezerva nu poate depasi profitul de repartizat (an cu impozit mare fata de profitul brut)
  const rezerva = net > 0 ? round2(Math.min(rez.rezerva, net)) : 0;
  const reportat = net > 0 ? round2(net - rezerva) : 0;
  const lines = [];
  if (rezerva > 0) {
    lines.push({ debit: '129', credit: '1061', suma: rezerva, explicatie: 'Constituirea rezervei legale (5% din profitul brut, plafon 20% din capitalul social)' });
    lines.push({ debit: '121', credit: '129', suma: rezerva, explicatie: 'Închiderea contului de repartizare a profitului' });
  }
  if (reportat > 0) lines.push({ debit: '121', credit: '117', suma: reportat, explicatie: 'Repartizarea profitului la rezultat reportat' });
  else if (net < 0) lines.push({ debit: '117', credit: '121', suma: round2(-net), explicatie: 'Reportarea pierderii contabile' });
  return { year: String(year), sold121: net, profit: net > 0 ? net : 0, pierdere: net < 0 ? round2(-net) : 0,
    rezervaLegala: rezerva, rezervaInfo: rez, reportat, lines };
}

/**
 * Livrarile FARA TVA pe factura care intra totusi in decont, pe randul lor din D300.
 *
 * Cheia e TIPUL documentului, nu absenta TVA-ului. Regula „venit din clasa 7 fara 4427" ar
 * prinde si diferentele de curs, reluarile de provizioane, subventiile, lucrarile in curs si
 * sconturile — care nu sunt operatiuni de decont si i-ar umfla baza cu sume inventate.
 *
 * Nu intra in `vanzari`: acolo se uita d394Xml, iar D394 e raportarea B2B INTERNA — livrarile
 * intracomunitare se declara in D390, nu in D394.
 */
const LIVRARI_SCUTITE = {
  // scutita cu drept de deducere, art. 294 alin. (2) — se declara in D390, nu in D394 (CUI strain)
  livrare_intracomunitara: { cat: 'intracom', d394: false },
  // taxare inversa interna, art. 331 — operatiune INTERNA, deci intra si in D394 (ca tip 'V')
  taxare_inversa_interna_livrare: { cat: 'taxareInversa', d394: true },
};

/**
 * Achizitiile cu AUTOLICHIDARE (taxare inversa la beneficiar): TVA-ul se colecteaza si se deduce
 * pe acelasi articol (4426 = 4427). In decont NU merg pe randurile de cota, ci pe perechea lor
 * proprie colectata/deductibila — validatorul oficial leaga perechile prin reguli: V7/V8 cer
 * `R18_1 = R5_1`, V13/V14 cer `R20_1 = R7_1`. Raportate pe randurile de cota, umflau si livrarile
 * taxabile (R9), si achizitiile taxabile (R22), cu o operatiune care nu e nici una, nici alta.
 *
 * `d394` = intra in D394. Achizitiile intracomunitare NU: partenerul are CUI strain, iar
 * declaratia — care e raportare B2B INTERNA — le respinge („cuiP trebuie sa fie un CUI valid",
 * plus tip 'V' cu cota != 0). Ele se declara in D390.
 */
const AUTOLICHIDARE = {
  achizitie_intracomunitara: { cat: 'intracomBunuri', d394: false },        // R5 / R18
  taxare_inversa_interna_achizitie: { cat: 'taxareInversaInterna', d394: true }, // R7 / R20
};

/** Jurnalele de TVA (vanzari/cumparari) si sumarul pentru decontul D300. */
function vatJournals(db, period) {
  const entries = sortEntries(postedEntries(db).filter((e) => inPeriod(e, period)));
  const isClass7 = (cod) => {
    const a = coa.getAccount(cod);
    return (a ? a.clasa : Number(String(cod)[0])) === 7;
  };
  const vanzari = [];
  const cumparari = [];
  const scutite = [];
  const tot = { bazaV: 0, colectata: 0, bazaC: 0, deductibila: 0 };
  const totScutite = { intracom: 0, taxareInversa: 0 };
  const totAuto = { intracomBunuri: { baza: 0, tva: 0 }, taxareInversaInterna: { baza: 0, tva: 0 } };

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
    // Baza de achizitie = contravaloarea fara TVA, luata de pe liniile care NU sunt de TVA.
    //
    // Doua corecturi fata de forma veche („liniile de debit, mai putin cele cu TVA pe debit"):
    //  a) linia de TVA se sare indiferent de LATURA pe care sta contul de taxa. La o reducere
    //     comerciala primita, TVA-ul se storneaza prin CREDITUL lui 4426 (401 = 4426), deci linia
    //     trecea de filtru si TVA-ul intra in baza: 1000 + 210 = 1210, adica o cota de -17%;
    //  b) semnul vine din POZITIA furnizorului. Cand datoria (40x, mai putin 409 care e o creanta)
    //     sta pe DEBIT, operatiunea REDUCE achizitia — reducere comerciala, nota de credit — deci
    //     baza e negativa. Stornarile care isi pastreaza sensul si isi neaga suma (401 pe credit,
    //     suma negativa) ies corect si asa.
    const CONT_TVA = (c) => c === '4426' || c === '4427' || c === '4428';
    const esteDatorieFurnizor = (c) => /^40/.test(String(c)) && !/^409/.test(String(c));
    let bazaC = 0;
    for (const l of e.lines) {
      if (CONT_TVA(l.debit) || CONT_TVA(l.credit)) continue;
      bazaC = round2(bazaC + (esteDatorieFurnizor(l.debit) ? -l.suma : l.suma));
    }
    // TVA la incasare devenita exigibila: articolul (4428=4427 / 4426=4428) nu are baza pe linii,
    // dar baza aferenta e memorata pe articol (e.tvaExig) si intra in D300 in perioada exigibilitatii.
    if (e.tvaExig) {
      if (e.tvaExig.side === 'deductibila') bazaC = round2(bazaC + (Number(e.tvaExig.baza) || 0));
      else bazaV = round2(bazaV + (Number(e.tvaExig.baza) || 0));
    }
    // La taxarea inversa interna aceeasi baza se raporteaza si la colectata, si la deductibila (D300).
    const autolich = AUTOLICHIDARE[e.tip];
    if (reverseCharge && bazaV === 0) bazaV = bazaC;
    if (ded !== 0) {
      // TVA partial deductibila (auto 50% art. 298, pro-rata art. 300): partea nededusa a intrat
      // in linia de cost, deci `bazaC` calculat din linii e umflat cu ea si raportul ded/bazaC da
      // o cota fantoma (105/1105 = 10%) care nu exista in nomenclatorul de randuri al D300 —
      // articolul disparea tacut din decont. `e.tvaPartial` pastreaza factura asa cum a fost emisa.
      const tp = e.tvaPartial;
      const bazaJurnal = tp ? tp.baza : bazaC;                 // factura reala (jurnal, D394)
      const tvaJurnal = tp ? tp.tvaFactura : ded;              // TVA-ul de pe factura, nu cel dedus
      // Cota se deduce din RAPORT, nu din semn: la un storno / o nota de credit / o reducere
      // comerciala, si baza si TVA-ul sunt NEGATIVE, iar raportul lor ramane cota facturii
      // (-210 / -1000 = 21%). Conditia veche `> 0` le trimitea pe toate la cota 0 — vezi `byCota`.
      const cota = tp ? tp.cota : (bazaC !== 0 && ded !== 0 ? Math.round((ded / bazaC) * 100) : 0);
      // In decont intra doar partea DEDUSA, cu baza ei proportionala: validatorul oficial cere
      // raportul baza/TVA egal cu cota (regula R84), iar `pro_rata` declarat nu il relaxeaza.
      const bazaDedusa = tp ? (cota > 0 ? round2((ded * 100) / cota) : 0) : bazaC;
      cumparari.push({ data: e.data, document: e.document, partener: e.partener, cui: e.partenerCui || '',
        baza: bazaJurnal, tva: tvaJurnal, total: round2(bazaJurnal + tvaJurnal), cota,
        tvaDedusa: ded, bazaDedusa, tvaNedeductibila: round2(tvaJurnal - ded), taxareInversa: reverseCharge,
        // categoria de autolichidare (randul propriu din decont) si daca articolul intra in D394
        autolichidare: autolich ? autolich.cat : null, inD394: autolich ? autolich.d394 : true,
        // codul de bun art. 331 (nomenclatorul D394) — sectiunea op11 a randului din D394
        codCategorie331: Number(e.codCategorie331) || 0 });
      tot.deductibila = round2(tot.deductibila + ded);
      tot.bazaC = round2(tot.bazaC + bazaJurnal);
      if (autolich) { const a = totAuto[autolich.cat]; a.baza = round2(a.baza + bazaDedusa); a.tva = round2(a.tva + ded); }
    }
    if (col !== 0) {
      tot.colectata = round2(tot.colectata + col);
      // Colectata din autolichidare NU e o livrare: nu intra in jurnalul de vanzari (de acolo o
      // lua si D394, unde ajungea ca livrare interna cu taxare inversa) si nici in `coteV`.
      // Baza si TVA-ul ei sunt deja acumulate in `totAuto`, pe latura deductibila a aceluiasi articol.
      if (!autolich) {
        // Cota din RAPORT, nu din semn (vezi si latura de achizitii): storno, nota de credit si
        // reducere comerciala au baza SI TVA negative, iar raportul ramane cota facturii.
        vanzari.push({ data: e.data, document: e.document, partener: e.partener, cui: e.partenerCui || '', baza: bazaV, tva: col, total: round2(bazaV + col), cota: bazaV !== 0 && col !== 0 ? Math.round((col / bazaV) * 100) : 0, taxareInversa: reverseCharge });
        tot.bazaV = round2(tot.bazaV + bazaV);
      }
    }
    // Livrari scutite / cu taxare inversa la beneficiar: nu au TVA, deci nu ajung nici in
    // `vanzari` (filtrat pe col !== 0), nici in `coteV` — dar au rand propriu in decont.
    const scutit = LIVRARI_SCUTITE[e.tip];
    if (scutit && col === 0 && bazaV !== 0) {
      scutite.push({ cat: scutit.cat, data: e.data, document: e.document, partener: e.partener,
        cui: e.partenerCui || '', baza: bazaV, inD394: scutit.d394,
        codCategorie331: Number(e.codCategorie331) || 0 });
      totScutite[scutit.cat] = round2(totScutite[scutit.cat] + bazaV);
    }
  }
  const deplata = round2(Math.max(tot.colectata - tot.deductibila, 0));
  const derecuperat = round2(Math.max(tot.deductibila - tot.colectata, 0));
  // Defalcare pe cote de TVA (21% / 11% / 0% scutit) pentru D300. Cota vine de pe RAND (unde e
  // deja cea a facturii), nu recalculata din tva/baza: la TVA partial deductibila raportul ar da
  // o cota inexistenta. In decont intra partea dedusa cu baza ei proportionala (`bazaDedusa`/
  // `tvaDedusa`); pentru facturile normale cele doua coincid cu baza si TVA-ul de pe factura.
  const byCota = (rows) => {
    const m = {};
    for (const r of rows) {
      const cota = r.cota || 0;
      const baza = r.bazaDedusa != null ? r.bazaDedusa : r.baza;
      const tva = r.tvaDedusa != null ? r.tvaDedusa : r.tva;
      m[cota] = m[cota] || { cota, baza: 0, tva: 0 };
      m[cota].baza = round2(m[cota].baza + baza);
      m[cota].tva = round2(m[cota].tva + tva);
    }
    return Object.values(m).sort((a, b) => b.cota - a.cota);
  };
  // Achizitiile cu autolichidare ies din defalcarea pe cote: au randurile lor in decont.
  return { period, vanzari, cumparari, scutite,
    coteV: byCota(vanzari), coteC: byCota(cumparari.filter((r) => !r.autolichidare)),
    totals: Object.assign(tot, { deplata, derecuperat, scutite: totScutite, autolichidari: totAuto }) };
}

/** Jurnal de banca / casa pentru un cont de trezorerie, cu sold curent (running balance). */
function cashBankJournal(db, cont, period) {
  cont = cont || '5121';
  const opening = (db.openingBalances || {})[cont] || { d: 0, c: 0 };
  const before = accumulate(allLines(postedEntries(db).filter((e) => beforePeriod(e, period))))[cont] || { d: 0, c: 0 };
  let sold = round2((opening.d + before.d) - (opening.c + before.c)); // sold initial
  const siInitial = sold;
  const periodLines = allLines(postedEntries(db).filter((e) => inPeriod(e, period)))
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

/**
 * Registrul-jurnal de incasari si plati (OMFP 170/2015, partida simpla — pentru PFA):
 * toate miscarile prin casa (531x) si banca (512x/581), cronologic, cu coloane separate
 * numerar/banca si clasificarea fiecarei operatiuni:
 *  - intern: viramente intre propriile conturi de trezorerie (nu sunt venit/cheltuiala)
 *  - neutru: aporturi/retrageri intreprinzator (455-458), credite (16x/519), alte nefiscale
 *  - taxe:   plati de TVA / impozit pe venit-profit (441x/442x) — nu sunt cheltuieli deductibile
 *  - fiscal: restul — incasarile si platile activitatii (baza pentru venitul net pe incasari)
 * `period` accepta luna (YYYY-MM), anul (YYYY) sau null (tot).
 */
function registruIncasariPlati(db, period) {
  const TREZ = /^(512|531|581)/;
  const NEUTRU = /^(45[5-8]|16\d|519|89)/;
  const TAXE = /^44[12]/;
  const q = String(period || '');
  const ents = sortEntries(postedEntries(db).filter((e) => {
    const p = String(e.period || periodOf(e.data));
    return !q || (q.length === 4 ? p.startsWith(q) : p === q);
  }));
  const rows = [];
  const tot = { incNumerar: 0, incBanca: 0, platiNumerar: 0, platiBanca: 0, incFiscale: 0, platiFiscale: 0, taxePlatite: 0 };
  let nr = 0;
  for (const e of ents) {
    for (const l of (e.lines || [])) {
      const dT = TREZ.test(String(l.debit)); const cT = TREZ.test(String(l.credit));
      if (!dT && !cT) continue;
      const intern = dT && cT;
      const inc = dT && !cT;
      const contra = intern ? '' : String(inc ? l.credit : l.debit);
      const trez = String(inc || intern ? l.debit : l.credit);
      const numerar = /^531/.test(trez);
      const cat = intern ? 'intern' : NEUTRU.test(contra) ? 'neutru' : TAXE.test(contra) ? 'taxe' : 'fiscal';
      nr += 1;
      const r = {
        nr, data: e.data, document: e.document || '', cat, contra,
        explicatie: (e.partener ? e.partener + ' — ' : '') + (l.explicatie || e.explicatie || e.tipNume || ''),
        incNumerar: inc && numerar ? round2(l.suma) : 0, incBanca: inc && !numerar ? round2(l.suma) : 0,
        platiNumerar: !inc && !intern && numerar ? round2(l.suma) : 0, platiBanca: !inc && !intern && !numerar ? round2(l.suma) : 0,
      };
      rows.push(r);
      tot.incNumerar = round2(tot.incNumerar + r.incNumerar); tot.incBanca = round2(tot.incBanca + r.incBanca);
      tot.platiNumerar = round2(tot.platiNumerar + r.platiNumerar); tot.platiBanca = round2(tot.platiBanca + r.platiBanca);
      if (cat === 'fiscal') {
        if (inc) tot.incFiscale = round2(tot.incFiscale + l.suma);
        else tot.platiFiscale = round2(tot.platiFiscale + l.suma);
      }
      if (cat === 'taxe' && !inc && !intern) tot.taxePlatite = round2(tot.taxePlatite + l.suma);
    }
  }
  return { period: q || null, rows, tot, venitNetIncasat: round2(tot.incFiscale - tot.platiFiscale) };
}

/** Fisa de cont: toate miscarile unui cont in perioada, cu contul corespondent si sold curent.
 *  Generalizarea jurnalului de banca/casa la orice cont din plan (401, 4111, 371, 601...). */
function fisaCont(db, cont, period) {
  cont = String(cont || '').trim();
  const opening = (db.openingBalances || {})[cont] || { d: 0, c: 0 };
  const before = accumulate(allLines(postedEntries(db).filter((e) => beforePeriod(e, period))))[cont] || { d: 0, c: 0 };
  let sold = round2((opening.d + before.d) - (opening.c + before.c));
  const siInitial = sold;
  const lines = allLines(postedEntries(db).filter((e) => inPeriod(e, period)))
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
  for (const e of postedEntries(db).filter((x) => beforePeriod(x, period))) {
    for (const l of (e.lines || [])) { if (l.debit === cont) soldLei = round2(soldLei + l.suma); if (l.credit === cont) soldLei = round2(soldLei - l.suma); }
  }
  const siLei = soldLei;
  let soldVal = 0; const rows = [];
  let rdLei = 0; let rcLei = 0; let rdVal = 0; let rcVal = 0;
  const ents = postedEntries(db).filter((e) => inPeriod(e, period) && (e.lines || []).some((l) => l.debit === cont || l.credit === cont))
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
function cashControl(db, cont, period, opts) {
  cont = cont || '5311';
  // Plafoanele stau in fiscalConfig (sursa unica, datata), nu in cod: erau hardcodate aici, deci
  // o modificare a Legii 70/2015 ar fi cerut vanatoare prin module. `fiscal.FISCAL` poarta si
  // suprascrierile din Setari, deci o firma poate stabili o limita interna mai stricta.
  const lim = Object.assign({}, fiscal.FISCAL, opts || {});
  const limJuridic = Number(lim.plafonNumerarJuridic) || 5000;
  const limFizic = Number(lim.plafonNumerarFizic) || 10000;
  const limSold = Number(lim.plafonSoldCasa) || 50000;
  const opening = (db.openingBalances || {})[cont] || { d: 0, c: 0 };
  const before = accumulate(allLines(postedEntries(db).filter((e) => beforePeriod(e, period))))[cont] || { d: 0, c: 0 };
  let sold = round2((opening.d + before.d) - (opening.c + before.c));
  const movs = [];
  for (const e of postedEntries(db).filter((x) => inPeriod(x, period))) {
    for (const l of e.lines) {
      if (l.debit === cont || l.credit === cont) {
        movs.push({ data: e.data, partener: e.partener || '', cui: e.partenerCui || '', document: e.document || '',
          incasare: l.debit === cont ? round2(l.suma) : 0, plata: l.credit === cont ? round2(l.suma) : 0 });
      }
    }
  }
  movs.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  // (1) sold negativ + (3) soldul la SFARSITUL FIECAREI ZILE (vezi mai jos)
  const negative = [];
  const soldZi = []; // { data, sold } — soldul dupa ultima operatiune a zilei
  for (let i = 0; i < movs.length; i++) {
    const m = movs[i];
    sold = round2(sold + m.incasare - m.plata);
    if (sold < -0.005) negative.push({ data: m.data, document: m.document, sold });
    const ultimaDinZi = i === movs.length - 1 || movs[i + 1].data !== m.data;
    if (ultimaDinZi) soldZi.push({ data: m.data, sold });
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
    const limita = juridic ? limJuridic : limFizic;
    if (g.plati > limita) plafon.push({ data: g.data, partener: g.partener || g.cui, juridic, tip: 'plata', suma: g.plati, limita });
    if (g.incasari > limita) plafon.push({ data: g.data, partener: g.partener || g.cui, juridic, tip: 'incasare', suma: g.incasari, limita });
  }
  // (3) SOLDUL DE CASIERIE — art. 4 alin. (4) plafoneaza soldul la sfarsitul FIECAREI ZILE, nu la
  // sfarsitul perioadei. Verificarea pe soldul final rata exact cazul tipic: firma trece de plafon
  // pe 10 martie, depune excedentul la banca pe 25 si inchide luna sub limita — nesemnalata, desi
  // abaterea (si sanctiunea) exista. Se raporteaza toate zilele depasite; `soldPesteLimita`
  // pastreaza forma istorica, dar arata acum ziua cea mai grava, nu ultima.
  const zilePesteLimita = soldZi.filter((z) => z.sold > limSold)
    .map((z) => ({ data: z.data, sold: z.sold, limita: limSold }));
  const soldPesteLimita = zilePesteLimita.length
    ? zilePesteLimita.reduce((a, b) => (b.sold > a.sold ? b : a))
    : null;
  return { cont, period, soldFinal: sold, negative, plafon, soldPesteLimita, zilePesteLimita,
    ok: !negative.length && !plafon.length && !zilePesteLimita.length };
}

module.exports = { vatPeriod, isPosted, postedEntries, buildBalanceRows, inPeriod,
  allLines, resultLines, isResultClosingLine, sortEntries, entryChrono, lastEntries, accumulate, periodStart, periodEnd, journal, journalNr, ledger, trialBalance, vatClosing, annualClosing, profitTax, resultDistribution, legalReserve, vatJournals, cashBankJournal, fisaCont, registruIncasariPlati, cashRegisterValuta, cashControl, tvaNeexigibila,
};
