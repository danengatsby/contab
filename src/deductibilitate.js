'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  PLAFOANELE DE DEDUCTIBILITATE LA IMPOZITUL PE PROFIT (art. 25 si 40^2)
//
//  De ce exista modulul: pana acum deductibilitatea era modelata ca PROCENT FIX PE CONT
//  (tabela NEDEDUCTIBILE din reporting.js). Asta acopera corect cheltuielile integral
//  nedeductibile (amenzi, provizioane), dar NU si pe cele cu PLAFON — unde partea
//  nedeductibila depinde de o baza de calcul, nu de un procent aplicat cheltuielii.
//  Diferenta e intreaga substanta a art. 25: la protocol, 2% NU inseamna „2% e nedeductibil",
//  ci „e deductibil pana la 2% dintr-o baza care include cheltuiala insasi".
//
//  ORDINEA DE APLICARE E PARTE DIN CONTRACT, si e motivul pentru care modulul are DOUA faze:
//    faza 1 (`ajustari`)  — ajustarile care nu depind de impozit: protocol, social, auto,
//                           sponsorizare (ca CHELTUIALA), dobanzi excedentare;
//    faza 2 (`credit`)    — creditul fiscal al sponsorizarii, care depinde de impozitul deja
//                           calculat pe baza fiscala din faza 1.
//  Inversarea fazelor ar da un rezultat plauzibil si gresit: creditul s-ar calcula pe un impozit
//  care inca nu tine cont de nedeductibile.
//
//  Modulul e PUR: primeste cifrele deja agregate (rulaj pe conturi, profit contabil, cifra de
//  afaceri…), nu baza de date. Asta il face testabil direct si independent de driver.
// ─────────────────────────────────────────────────────────────────────────────

const { round2 } = require('./util');

// Conturile citite de reguli. Prefix, nu potrivire exacta: orice cont poate avea analitice
// (`623.01`), iar o cautare exacta ar rata exact firmele care isi tin analitic cheltuielile.
const CONT = {
  protocol: '623',
  social: '6458',
  salarii: '641',
  sponsorizare: '6582',
  dobanzi: '666',
  venitDobanzi: '766',
};

/** Soldul debitor net al conturilor care incep cu `prefix` (cheltuieli). */
function cheltuiala(rulaj, prefix) {
  let s = 0;
  for (const cod of Object.keys(rulaj || {})) {
    if (String(cod).startsWith(prefix)) s = round2(s + (rulaj[cod].d - rulaj[cod].c));
  }
  return round2(s);
}

/** Soldul creditor net al conturilor care incep cu `prefix` (venituri). */
function venit(rulaj, prefix) {
  let s = 0;
  for (const cod of Object.keys(rulaj || {})) {
    if (String(cod).startsWith(prefix)) s = round2(s + (rulaj[cod].c - rulaj[cod].d));
  }
  return round2(s);
}

/** Un rand de ajustare, in forma pe care o consuma registrul fiscal si D101. */
function rand(regula, temei, cont, baza, plafon, cheltuit, nedeductibil, nota) {
  return {
    regula, temei, cont,
    baza: round2(baza), plafon: round2(plafon), cheltuit: round2(cheltuit),
    deductibil: round2(cheltuit - nedeductibil), nedeductibil: round2(nedeductibil),
    nota: nota || '',
  };
}

/**
 * FAZA 1 — ajustarile care nu depind de impozitul pe profit.
 *
 * @param {object} i  intrarea agregata:
 *   rulaj             {cod: {d, c}} — rulajul anului pe conturi de venituri/cheltuieli
 *   profitContabil    venituri - cheltuieli (fara 691/698)
 *   cheltAuto         baza cheltuielilor pe vehicule fara uz exclusiv business (marcaj auto50)
 *   cheltImpozitProfit cheltuiala cu impozitul pe profit deja inregistrata (cont 691), daca exista
 *   amortizareFiscala  amortizarea fiscala a anului (baza art. 40^2)
 *   cursEur            cursul de schimb pentru plafonul de 1.000.000 EUR
 * @param {object} cfg cotele (fiscal.FISCAL)
 */
function ajustari(i, cfg) {
  i = i || {}; cfg = cfg || {};
  const rulaj = i.rulaj || {};
  const randuri = [];

  // ── Protocol (art. 25(3)(a)) ──────────────────────────────────────────────
  // Baza include cheltuiala de protocol INSASI si cheltuiala cu impozitul pe profit. Un plafon
  // calculat pe profitul contabil simplu ar fi mai mic si ar da nedeductibil in plus.
  const protocol = cheltuiala(rulaj, CONT.protocol);
  if (protocol > 0) {
    const bazaP = round2(Number(i.profitContabil || 0) + protocol + Number(i.cheltImpozitProfit || 0));
    // Baza negativa (an pe pierdere) => plafon 0 => intreaga cheltuiala e nedeductibila.
    const plafonP = bazaP > 0 ? round2((bazaP * Number(cfg.protocolPct || 0)) / 100) : 0;
    randuri.push(rand('Protocol', 'Art. 25(3)(a)', CONT.protocol, bazaP, plafonP, protocol,
      Math.max(0, round2(protocol - plafonP)),
      bazaP > 0 ? '' : 'Baza de calcul <= 0 (an pe pierdere): plafonul e zero, cheltuiala e integral nedeductibila.'));
  }

  // ── Cheltuieli sociale (art. 25(3)(b)) ────────────────────────────────────
  const social = cheltuiala(rulaj, CONT.social);
  if (social > 0) {
    const fond = cheltuiala(rulaj, CONT.salarii);
    const plafonS = fond > 0 ? round2((fond * Number(cfg.socialPct || 0)) / 100) : 0;
    randuri.push(rand('Cheltuieli sociale', 'Art. 25(3)(b)', CONT.social, fond, plafonS, social,
      Math.max(0, round2(social - plafonS)),
      fond > 0 ? '' : 'Fara fond de salarii: plafonul e zero.'));
  }

  // ── Cheltuieli auto (art. 25(3)(l)) ───────────────────────────────────────
  // Separat de TVA-ul auto (art. 298, aplicat la inregistrare): acolo se limiteaza TVA-ul
  // deductibil, aici JUMATATE DIN CHELTUIALA. Sunt doua limitari distincte pe acelasi document.
  const auto = round2(Number(i.cheltAuto || 0));
  if (auto > 0) {
    const pctDed = Number(cfg.autoCheltuialaDeductibilPct || 0);
    const dedA = round2((auto * pctDed) / 100);
    randuri.push(rand('Cheltuieli auto', 'Art. 25(3)(l)', '', auto, dedA, auto,
      round2(auto - dedA), 'Deductibile ' + pctDed + '% (vehicule fara utilizare exclusiv business).'));
  }

  // ── Sponsorizare, ca CHELTUIALA (art. 25(4)(i)) ───────────────────────────
  // Integral nedeductibila. Beneficiul fiscal nu vine din deducere, ci din CREDITUL de la faza 2 —
  // confuzia intre cele doua e clasica si duce la deducerea sumei de doua ori.
  const sponsor = cheltuiala(rulaj, CONT.sponsorizare);
  if (sponsor > 0) {
    randuri.push(rand('Sponsorizare (cheltuiala)', 'Art. 25(4)(i)', CONT.sponsorizare, sponsor, 0, sponsor,
      sponsor, 'Integral nedeductibila; se recupereaza ca CREDIT FISCAL din impozit (vezi creditul).'));
  }

  // ── Amortizare: contabila vs fiscala (art. 28) ────────────────────────────
  // Singura regula care poate produce un nedeductibil NEGATIV, adica o DEDUCERE: cand amortizarea
  // fiscala e mai mare decat cea contabila (cazul accelerata fiscal / liniara contabil, in primul
  // an). Pe toata durata de viata suma diferentelor e zero — ajustarea muta deducerea intre
  // exercitii, nu o creeaza. Forma randului se potriveste exact: „cheltuit" = amortizarea
  // contabila, „deductibil" (plafon) = cea fiscala.
  if (i.amortizare && (Number(i.amortizare.contabila) || Number(i.amortizare.fiscala))) {
    const ac = round2(Number(i.amortizare.contabila) || 0);
    const af = round2(Number(i.amortizare.fiscala) || 0);
    const dif = round2(ac - af);
    if (dif !== 0) {
      randuri.push(rand('Amortizare (contabila vs fiscala)', 'Art. 28', '6811', ac, af, ac, dif,
        dif > 0
          ? 'Amortizarea contabila depaseste pe cea fiscala: diferenta e nedeductibila in acest exercitiu.'
          : 'Amortizarea fiscala depaseste pe cea contabila: diferenta e o DEDUCERE suplimentara (nedeductibil negativ).'));
    }
  }

  // ── Costuri excedentare ale indatorarii (art. 40^2) ───────────────────────
  // INTERPRETARE (de confirmat de revizor, vezi test/cazuri-aprobate.js): pana la echivalentul a
  // 1.000.000 EUR costul excedentar e deductibil neconditionat; ce depaseste e deductibil doar
  // pana la 30% din baza (rezultat fiscal + costuri excedentare + amortizare fiscala).
  const dob = cheltuiala(rulaj, CONT.dobanzi);
  const vdob = venit(rulaj, CONT.venitDobanzi);
  const excedent = round2(dob - vdob);
  if (excedent > 0) {
    const curs = Number(i.cursEur || 0);
    const plafonEur = curs > 0 ? round2(Number(cfg.dobanziPlafonEur || 0) * curs) : 0;
    let nedeductibilD = 0; let plafonAplicat = plafonEur; let nota = ''; let alternativa = null;
    if (excedent <= plafonEur) {
      nota = 'Sub plafonul de ' + (cfg.dobanziPlafonEur || 0) + ' EUR: integral deductibil.';
    } else {
      const bazaD = round2(Number(i.rezultatFiscalInainteDobanzi || 0) + excedent + Number(i.amortizareFiscala || 0));
      const plafon30 = bazaD > 0 ? round2((bazaD * Number(cfg.dobanziEbitdaPct || 0)) / 100) : 0;
      const peste = round2(excedent - plafonEur);
      // DOUA CITIRI ALE ART. 40^2, ambele calculate — decizia e a revizorului, nu a codului.
      //  A („cumulativ", implicita): plafonul in EUR e deductibil neconditionat, iar cei 30% se
      //     aplica DOAR partii care il depaseste.  ded = plafonEur + min(peste; 30% x baza)
      //  B („alternativa"): deductibilul e maximul dintre cele doua plafoane.
      //     ded = max(plafonEur; 30% x baza)
      // Pe cifre mari diferenta e uriasa, de aceea ambele sunt expuse in rezultat si in cazul
      // PLF-05 din corpusul de revizie. Cand `art402Interpretare === 'max'`, se aplica B.
      const dedA = round2(plafonEur + Math.max(0, Math.min(peste, plafon30)));
      const dedB = round2(Math.max(plafonEur, plafon30));
      const alegeB = String(i.art402Interpretare || cfg.art402Interpretare || 'cumulativ') === 'max';
      plafonAplicat = alegeB ? dedB : dedA;
      nedeductibilD = Math.max(0, round2(excedent - plafonAplicat));
      alternativa = {
        cumulativ: { deductibil: dedA, nedeductibil: Math.max(0, round2(excedent - dedA)) },
        max: { deductibil: dedB, nedeductibil: Math.max(0, round2(excedent - dedB)) },
        aplicata: alegeB ? 'max' : 'cumulativ',
        baza: bazaD, plafonEur, plafon30,
      };
      nota = 'Peste plafonul in EUR. Doua citiri posibile ale art. 40^2 — aplicata: '
        + (alegeB ? 'max(plafon EUR; ' : 'plafon EUR + min(excedent; ') + (cfg.dobanziEbitdaPct || 0)
        + '% din baza ' + round2(bazaD) + ')'
        + '. Cealalta ar da un nedeductibil de '
        + (alegeB ? Math.max(0, round2(excedent - dedA)) : Math.max(0, round2(excedent - dedB)))
        + ' lei. Partea nedeductibila se reporteaza NELIMITAT.';
    }
    const randDob = rand('Costuri excedentare ale indatorarii', 'Art. 40^2', CONT.dobanzi,
      excedent, plafonAplicat, excedent, nedeductibilD, nota);
    if (alternativa) randDob.alternativa = alternativa; // ambele cifre, pentru revizor si pentru UI
    randuri.push(randDob);
  }

  const totalNedeductibil = round2(randuri.reduce((s, r) => s + r.nedeductibil, 0));
  return { randuri, totalNedeductibil, sponsorizareCheltuita: sponsor };
}

/**
 * FAZA 2 — creditul fiscal al sponsorizarii (art. 25(4)(i)).
 *
 * Plafon = min(procent din cifra de afaceri, procent din impozitul pe profit). Suma disponibila =
 * sponsorizarea anului + reportul neconsumat din anii anteriori, consumat CEL MAI VECHI INTAI
 * (asa se si prescrie). Ce ramane peste `sponsorizareReportAni` ani se pierde.
 *
 * @param {object} i  { cifraAfaceri, impozit, sponsorizareAn, report: [{an, suma}], an }
 * @param {object} cfg cotele
 */
function credit(i, cfg) {
  i = i || {}; cfg = cfg || {};
  const ca = round2(Number(i.cifraAfaceri || 0));
  const impozit = round2(Number(i.impozit || 0));
  const plafonCa = round2((ca * Number(cfg.sponsorizareCaPct || 0)) / 100);
  const plafonImpozit = round2((impozit * Number(cfg.sponsorizareImpozitPct || 0)) / 100);
  const plafon = round2(Math.min(plafonCa, plafonImpozit));

  const anCurent = Number(i.an) || 0;
  const maxAni = Number(cfg.sponsorizareReportAni || 0);
  // Bucket-urile mai vechi decat fereastra de report sunt PRESCRISE: nu se mai pot folosi.
  const toate = (i.report || []).map((r) => ({ an: Number(r.an), suma: round2(Number(r.suma) || 0) }))
    .filter((r) => r.suma > 0);
  const prescrise = toate.filter((r) => anCurent && maxAni && (anCurent - r.an) >= maxAni);
  const utilizabile = toate.filter((r) => !prescrise.includes(r)).sort((a, b) => a.an - b.an);

  const sponsorizareAn = round2(Number(i.sponsorizareAn || 0));
  const disponibil = round2(utilizabile.reduce((s, r) => s + r.suma, 0) + sponsorizareAn);
  const folosit = round2(Math.min(disponibil, Math.max(0, plafon)));

  // Consum FIFO pe ani, ca reportul ramas sa-si pastreze vechimea (altfel prescriptia n-ar mai avea sens).
  let ramas = folosit;
  const reportNou = [];
  for (const b of utilizabile) {
    const ia = Math.min(ramas, b.suma);
    ramas = round2(ramas - ia);
    const rest = round2(b.suma - ia);
    if (rest > 0) reportNou.push({ an: b.an, suma: rest });
  }
  const restAnCurent = round2(sponsorizareAn - ramas);
  if (restAnCurent > 0 && anCurent) reportNou.push({ an: anCurent, suma: restAnCurent });

  return {
    plafonCa, plafonImpozit, plafon, disponibil, folosit,
    reportNou, prescris: round2(prescrise.reduce((s, r) => s + r.suma, 0)),
    impozitDupaCredit: Math.max(0, round2(impozit - folosit)),
  };
}

module.exports = { ajustari, credit, CONT, cheltuiala, venit };
