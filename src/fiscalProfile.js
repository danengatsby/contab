'use strict';

// Motorul de PROFIL FISCAL pe firma: normalizeaza atributele fiscale ale unei firme intr-un
// profil STRUCTURAT, sursa UNICA din care se deriva declaratiile asteptate, alertele si
// controalele — in loc de boolean-uri raspandite (tvaPlatitor, perioadaTva, tipEntitate...)
// citite ad-hoc prin cod. Toate campurile au implicite compatibile cu firmele existente:
// un profil construit dintr-o firma veche (fara campurile noi) da exact comportamentul de dinainte.

const { round2 } = require('./util');

const REGIMURI = ['micro', 'profit', 'pfa'];  // impozit pe venit/profit
const CADENTE = ['L', 'T', 'A'];              // cadenta de raportare (lunar/trimestrial/anual)
const TRIM_END = [3, 6, 9, 12];               // lunile de sfarsit de trimestru

function endOfQuarter(period) { return TRIM_END.includes(Number(String(period).slice(5, 7))); }

/** Construieste profilul fiscal normalizat al firmei. `ctx.angajati` (optional) deriva
 *  `areAngajati`; in lipsa lui se foloseste flagul `company.areAngajati`. */
function build(company, ctx) {
  company = company || {};
  ctx = ctx || {};
  const pfa = company.tipEntitate === 'pfa';
  const tvaPlatitor = !!company.tvaPlatitor;
  const perioadaTva = tvaPlatitor ? (company.perioadaTva === 'T' ? 'T' : 'L') : null;
  // regim de impozitare: explicit (regimImpozit) sau derivat (pfa -> pfa; altfel implicit micro,
  // ca pana acum). PFA nu are micro/profit.
  let regim = REGIMURI.includes(company.regimImpozit) ? company.regimImpozit : (pfa ? 'pfa' : 'micro');
  if (pfa) regim = 'pfa';
  const areAngajati = Array.isArray(ctx.angajati) ? ctx.angajati.length > 0 : !!company.areAngajati;
  // cadenta D406 (SAF-T): explicita (d406Cadenta) sau derivata din regimul TVA — pastreaza
  // comportamentul istoric: TVA lunar -> lunar; TVA trimestrial / neplatitor -> trimestrial.
  const d406 = CADENTE.includes(company.d406Cadenta) ? company.d406Cadenta
    : (tvaPlatitor ? (perioadaTva === 'T' ? 'T' : 'L') : 'T');
  const scutiri = (company.scutiri && typeof company.scutiri === 'object') ? company.scutiri : {};
  // SISTEMUL de declarare a impozitului pe profit (art. 41). Implicit cel TRIMESTRIAL, alin. (1) —
  // regula generala. Sistemul anual cu plati anticipate, alin. (2), e o OPTIUNE pe care firma o
  // comunica pana pe 31 ianuarie si care o leaga cel putin 2 ani fiscali; nu se poate deduce din
  // date, deci se tine explicit. Are inteles doar la regimul de profit.
  const sistemProfit = (regim === 'profit' && company.sistemProfit === 'anual') ? 'anual' : 'trimestrial';
  // Ramura de EXCEPTIE a sistemului anual (art. 41 alin. (7)): firmele care in anul precedent au
  // fost nou-infiintate, au inregistrat pierdere fiscala, n-au datorat impozit pe profit anual sau
  // au fost platitoare de impozit pe veniturile microintreprinderilor NU platesc o patrime din
  // impozitul anului trecut — platesc cota aplicata PROFITULUI CONTABIL al perioadei, si doar
  // pentru trimestrele I-III.
  //
  // De ce e un camp DECLARAT si nu unul derivat, desi restul aplicatiei deriva starile: din cele
  // patru situatii, una singura se citeste sigur din datele noastre (pierderea fiscala a anului
  // precedent). „A fost microintreprindere" cere un istoric al regimului pe care aplicatia nu-l
  // pastreaza, iar „nou-infiintat" nu se poate distinge de „firma preluata cu istoric importat".
  // O derivare care ghiceste trei sferturi din conditie ar alege TACUT alta formula de plata si
  // alt calendar. Ce se poate verifica se verifica: `reporting.d100profit` confrunta bifa cu
  // pierderea fiscala din date si avertizeaza cand cele doua nu se potrivesc.
  const anticipatProfitContabil = sistemProfit === 'anual' && !!company.anticipatProfitContabil;
  return {
    tipEntitate: pfa ? 'pfa' : (company.tipEntitate || 'srl'),
    pfa,
    tvaPlatitor,
    perioadaTva,                       // 'L' | 'T' | null (neplatitor)
    trimestrialTva: perioadaTva === 'T',
    tvaLaIncasare: !!company.tvaLaIncasare,
    regim,                             // 'micro' | 'profit' | 'pfa'
    micro: regim === 'micro',
    profit: regim === 'profit',
    sistemProfit,                      // 'trimestrial' (art. 41(1)) | 'anual' (art. 41(2), cu plati anticipate)
    profitAnticipat: regim === 'profit' && sistemProfit === 'anual',
    anticipatProfitContabil,           // art. 41 alin. (7) — plata anticipata pe profitul CONTABIL al trimestrului
    areAngajati,
    d406,                              // 'L' | 'T' | 'A'
    saftLunar: d406 === 'L',
    intrastat: !!company.intrastatObligat,  // obligatie declarativa Intrastat (peste prag INS)
    scutiri,                           // { <tip>: true } — declaratii pe care firma NU le datoreaza
  };
}

/** Declaratiile ASTEPTATE (lista de `tip`) derivate din profil pentru luna `period` (YYYY-MM).
 *  `hasIntracom(period)` = callback optional care spune daca firma a avut operatiuni
 *  intracomunitare in luna (pentru D390 / Intrastat). Scutirile din profil suprima orice tip. */
function expected(profile, period, hasIntracom) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return [];
  const sfarsitTrim = endOfQuarter(period);
  const intracom = typeof hasIntracom === 'function' && hasIntracom(period);
  const tips = [];
  const add = (t) => { if (!profile.scutiri[t] && !tips.includes(t)) tips.push(t); };
  // TVA: D300 + D394 (lunar sau la sfarsit de trimestru, dupa perioada fiscala)
  if (profile.tvaPlatitor && (!profile.trimestrialTva || sfarsitTrim)) { add('d300'); add('d394'); }
  // D390 (VIES): doar in lunile cu operatiuni intracomunitare efective
  if (intracom) add('d390');
  // Intrastat (INS): firma obligata (peste prag) + miscari intracomunitare in luna
  if (profile.intrastat && intracom) add('intrastat');
  // D112: firme cu salariati
  if (profile.areAngajati) add('d112');
  // D100: trimestrial, non-PFA. Cine il datoreaza pe trimestrul IV depinde de REGIM si, la
  // impozitul pe profit, de SISTEMUL ales (art. 41):
  //  - MICRO: toate patru trimestrele (al patrulea pana pe 25 ianuarie);
  //  - PROFIT, sistem trimestrial (alin. (1)): doar trimestrele I-III — definitivarea anului se
  //    face prin D101, pana pe 25 martie. Asteptarea unui D100 pe trimestrul IV impingea firma
  //    sa-si declare impozitul de doua ori;
  //  - PROFIT, sistem anual cu plati anticipate (alin. (2)): TOATE PATRU, fiindca plata anticipata
  //    a trimestrului IV se declara si se plateste separat, pana pe 25 DECEMBRIE (alin. (8)) —
  //    singurul termen din aplicatie care cade in ACEEASI luna cu perioada, nu in cea urmatoare.
  //    EXCEPTIE (alin. (7)): firmele care in anul precedent au fost nou-infiintate, au avut
  //    pierdere fiscala, n-au datorat impozit pe profit anual sau au fost microintreprinderi fac
  //    plati anticipate „pentru trimestrele I-III" — deci pentru ELE trimestrul IV nu se declara,
  //    ca la sistemul trimestrial.
  const d100Trim4 = Number(period.slice(5, 7)) === 12;
  const profitFaraTrim4 = profile.profit
    && (!profile.profitAnticipat || profile.anticipatProfitContabil);
  if (!profile.pfa && sfarsitTrim && !(profitFaraTrim4 && d100Trim4)) add('d100');
  // D101 (impozit pe profit, ANUAL): doar regimul de profit, la sfarsitul anului (termen 25 martie
  // anul urmator). Micro NU depune D101.
  if (profile.profit && Number(period.slice(5, 7)) === 12) add('d101');
  // D406 (SAF-T): dupa cadenta profilului, non-PFA
  if (!profile.pfa && (profile.d406 === 'L'
    || (profile.d406 === 'T' && sfarsitTrim)
    || (profile.d406 === 'A' && Number(period.slice(5, 7)) === 12))) add('saft');
  return tips;
}

/** Perioada de raportare TVA pentru o luna: 'YYYY-Qn' la regim trimestrial, altfel luna. */
function vatPeriod(profile, monthPeriod) {
  const m = String(monthPeriod || '').match(/^(\d{4})-(\d{2})$/);
  if (m && profile && profile.trimestrialTva) return m[1] + '-Q' + Math.ceil(Number(m[2]) / 3);
  return monthPeriod;
}

/** GUARD de SCRIERE: reguli HARD derivate din profil, verificate pe articolul concret la creare.
 *  Intoarce un mesaj de BLOCARE (string) sau null daca articolul e permis. Spre deosebire de
 *  controalele advisory (fiscalControls), guardul OPRESTE scrierea datelor clar incorecte. */
function entryGuard(profile, entry) {
  const lines = (entry && entry.lines) || [];
  const sumBy = (test) => round2(lines.reduce((s, l) => s + (test(l) ? Number(l.suma) || 0 : 0), 0));
  // Neplatitor de TVA nu poate COLECTA TVA (vanzare cu TVA). Taxarea inversa (4426=4427, net 0)
  // ramane permisa: se blocheaza doar colectarea NETA pozitiva, nu prezenta conturilor de TVA.
  if (profile && !profile.tvaPlatitor) {
    const colectata = sumBy((l) => /^442[78]/.test(String(l.credit)));
    const deductibila = sumBy((l) => /^442[68]/.test(String(l.debit)));
    if (round2(colectata - deductibila) > 0) {
      return 'Firma nu e plătitoare de TVA — nu poți înregistra TVA colectată (' + round2(colectata - deductibila) + ' lei). Emite documentul fără TVA sau schimbă regimul TVA în Setări.';
    }
  }
  return null;
}

module.exports = { build, expected, vatPeriod, endOfQuarter, entryGuard, REGIMURI, CADENTE };
