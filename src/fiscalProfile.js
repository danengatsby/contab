'use strict';

// Motorul de PROFIL FISCAL pe firma: normalizeaza atributele fiscale ale unei firme intr-un
// profil STRUCTURAT, sursa UNICA din care se deriva declaratiile asteptate, alertele si
// controalele — in loc de boolean-uri raspandite (tvaPlatitor, perioadaTva, tipEntitate...)
// citite ad-hoc prin cod. Toate campurile au implicite compatibile cu firmele existente:
// un profil construit dintr-o firma veche (fara campurile noi) da exact comportamentul de dinainte.

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
  // D100 (impozit micro / avans profit): trimestrial, non-PFA
  if (!profile.pfa && sfarsitTrim) add('d100');
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

module.exports = { build, expected, vatPeriod, endOfQuarter, REGIMURI, CADENTE };
