'use strict';

// Motorul de PROFIL FISCAL pe firma: normalizeaza atributele fiscale ale unei firme intr-un
// profil STRUCTURAT, sursa UNICA din care se deriva declaratiile asteptate, alertele si
// controalele — in loc de boolean-uri raspandite (tvaPlatitor, perioadaTva, tipEntitate...)
// citite ad-hoc prin cod. Toate campurile au implicite compatibile cu firmele existente:
// un profil construit dintr-o firma veche (fara campurile noi) da exact comportamentul de dinainte.

const crypto = require('crypto');
const { round2, validIsoDate } = require('./util');

const REGIMURI = ['micro', 'profit', 'pfa'];  // impozit pe venit/profit
const CADENTE = ['L', 'T', 'A'];              // cadenta de raportare (lunar/trimestrial/anual)
const TRIM_END = [3, 6, 9, 12];               // lunile de sfarsit de trimestru
const HISTORIC_FIELDS = [
  'tipEntitate', 'tvaPlatitor', 'tvaArt317', 'tvaLaIncasare', 'tvaCodAnulat',
  'dataAnulareTva', 'motivAnulareTva', 'dataReinregistrareTva', 'perioadaTva',
  'regimImpozit', 'd406Cadenta', 'intrastatObligat', 'scutiri', 'sistemProfit',
  'anticipatProfitContabil',
];
const FIELD_DEFAULTS = {
  tipEntitate: null, tvaPlatitor: false, tvaArt317: false, tvaLaIncasare: false,
  tvaCodAnulat: false, dataAnulareTva: '', motivAnulareTva: 'oficiu', dataReinregistrareTva: '',
  perioadaTva: null, regimImpozit: null, d406Cadenta: null, intrastatObligat: false,
  scutiri: {}, sistemProfit: null, anticipatProfitContabil: false,
};

function endOfQuarter(period) { return TRIM_END.includes(Number(String(period).slice(5, 7))); }

/** Data de referinta canonica: o luna/an inseamna ultima zi a perioadei. */
function asOfDate(value) {
  const raw = String(value || '');
  if (validIsoDate(raw)) return raw;
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const d = new Date(raw + '-01T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 1, 0);
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}$/.test(raw)) return raw + '-12-31';
  return new Date().toISOString().slice(0, 10);
}

function snapshot(company) {
  const c = company || {}; const out = {};
  for (const key of HISTORIC_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(c, key) ? c[key] : FIELD_DEFAULTS[key];
    out[key] = key === 'scutiri' ? Object.assign({}, value && typeof value === 'object' ? value : {}) : value;
  }
  return out;
}

/** Momentul tranzacțional al registrului fiscal: CÂND a fost consemnată versiunea în sistem,
 * distinct de `validFrom`/`validTo`, care spun PENTRU CE interval produce efecte. */
function recordedAtOf(row) {
  const raw = row && (row.recordedAt || row.createdAt);
  if (!raw) return null;
  const time = Date.parse(String(raw));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Normalizează registrul și închide mecanic intervalele. `validTo` este exclusiv; ultima
 *  versiune rămâne deschisă (`null`). Valorile fiscale nu sunt rescrise niciodată. */
function withIntervals(rows) {
  const out = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && !r.revoked && validIsoDate(r.validFrom) && r.values && typeof r.values === 'object')
    .map((r) => {
      const recordedAt = recordedAtOf(r);
      return Object.assign({}, r, {
        values: snapshot(r.values), recordedAt,
        // Alias read-only pentru clienții vechi. Scrierile noi folosesc `recordedAt` drept nume
        // canonic; nu pierdem însă integrațiile care încă afișează `createdAt`.
        createdAt: r.createdAt || recordedAt,
      });
    })
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom) || String(a.recordedAt || '').localeCompare(String(b.recordedAt || ''))
      || String(a.id || '').localeCompare(String(b.id || '')));
  return out.map((r, i) => Object.assign({}, r, { validTo: out[i + 1] ? out[i + 1].validFrom : null }));
}

/** Extrage istoricul fie din tabelul rădăcină `fiscal_profile_history`, fie dintr-o vedere
 *  scoped. `company.fiscalHistory` rămâne doar adaptor de citire pentru backup-urile vechi. */
function historyFor(source, firmaId) {
  source = source || {};
  const company = source.company && typeof source.company === 'object' ? source.company : source;
  const fid = Number(firmaId != null ? firmaId : (source.firmaId != null ? source.firmaId : company.id));
  let rows = source.fiscalProfileHistory || source.fiscal_profile_history;
  if (Array.isArray(rows) && Number.isFinite(fid)) rows = rows.filter((r) => Number(r.firmaId) === fid);
  if (!Array.isArray(rows)) rows = company.fiscalHistory;
  return withIntervals(rows);
}

/** Firma vazuta la data/perioada ceruta. Reviziile sunt fotografii COMPLETE, nu patch-uri:
 *  astfel o setare curenta nu se poate scurge retroactiv intr-o declaratie veche. */
function resolve(company, asOf, explicitHistory) {
  company = company || {};
  const history = withIntervals(Array.isArray(explicitHistory) ? explicitHistory : company.fiscalHistory);
  if (!history.length) return Object.assign({}, company);
  const date = asOfDate(asOf);
  const rev = history.filter((r) => r.validFrom <= date && (!r.validTo || date < r.validTo)).pop()
    || history.filter((r) => r.validFrom <= date).pop();
  if (!rev) return Object.assign({}, company);
  return Object.assign({}, company, snapshot(rev.values), {
    fiscalRevisionId: rev.id || null,
    fiscalValidFrom: rev.validFrom,
    fiscalValidTo: rev.validTo || null,
    fiscalRecordedAt: rev.recordedAt || null,
    fiscalRecordedBy: rev.createdBy == null ? null : rev.createdBy,
  });
}

/** Adauga append-only o revizie. La prima folosire se creeaza o fotografie de baza 1900-01-01,
 *  ca perioadele anterioare noii schimbari sa nu citeasca valorile viitoare din campurile plate. */
function addRevision(company, validFrom, changes, meta) {
  company = company || {}; meta = meta || {};
  validFrom = String(validFrom || '');
  if (!validIsoDate(validFrom)) { const e = new Error('Data de intrare in vigoare trebuie sa fie valida (YYYY-MM-DD).'); e.status = 400; throw e; }
  const suppliedMoment = meta.recordedAt || meta.now;
  const recordedAt = recordedAtOf({ recordedAt: suppliedMoment || new Date().toISOString() });
  if (!recordedAt) { const e = new Error('Momentul înregistrării reviziei fiscale este invalid.'); e.status = 400; throw e; }
  const unknown = Object.keys(changes || {}).filter((k) => !HISTORIC_FIELDS.includes(k));
  if (unknown.length) { const e = new Error('Campuri fiscale necunoscute: ' + unknown.join(', ') + '.'); e.status = 400; throw e; }
  let history = withIntervals(Array.isArray(meta.history) ? meta.history : company.fiscalHistory);
  if (!history.length) {
    history.push({ id: meta.baselineId || 'fpr-baseline', validFrom: '1900-01-01', values: snapshot(company),
      validTo: null, firmaId: meta.firmaId != null ? meta.firmaId : company.id,
      note: 'Fotografie initiala creata automat', recordedAt, createdAt: recordedAt,
      recordedAtSource: 'baseline-on-first-revision', createdBy: meta.userId || null });
  }
  const values = snapshot(Object.assign({}, resolve(company, validFrom, history), changes || {}));
  const revision = { id: meta.id || ('fpr-' + Date.now()), validFrom, values,
    validTo: null, firmaId: meta.firmaId != null ? meta.firmaId : company.id,
    note: String(meta.note || '').slice(0, 300), recordedAt, createdAt: recordedAt,
    recordedAtSource: 'application', createdBy: meta.userId || null };
  history.push(revision);
  // Sunt permise mai multe revizii in aceeasi zi: ultima este corectia valabila, iar cele
  // anterioare raman in istoric. Altfel o eroare observata in ziua configurarii ar putea fi
  // reparata numai mintind data de intrare in vigoare.
  history = withIntervals(history);
  const savedRevision = history.find((r) => String(r.id) === String(revision.id)) || revision;
  const current = resolve(company, meta.today || new Date().toISOString().slice(0, 10), history);
  return { history, revision: savedRevision, currentValues: snapshot(current) };
}

/** Construieste profilul fiscal normalizat al firmei. `ctx.angajati` (optional) deriva
 *  `areAngajati`; in lipsa lui se foloseste flagul `company.areAngajati`. */
function build(company, ctx) {
  ctx = ctx || {};
  const source = company || {};
  const isView = source.company && typeof source.company === 'object';
  company = isView ? source.company : source;
  const history = Array.isArray(ctx.history) ? ctx.history : historyFor(source, ctx.firmaId);
  company = resolve(company, ctx.asOf || ctx.period || ctx.year, history);
  const pfa = company.tipEntitate === 'pfa';
  // Codul ANULAT nu transforma firma intr-o neplatitoare obisnuita: ramane obligata sa colecteze
  // taxa, dar prin D311 si 446, fara drept de deducere. Pentru restul motorului, codul anulat
  // inseamna ca D300/D394 si conturile normale de TVA nu sunt disponibile.
  const tvaCodAnulat = !!company.tvaCodAnulat;
  const tvaPlatitor = !!company.tvaPlatitor && !tvaCodAnulat;
  const tvaArt317 = !tvaPlatitor && !!company.tvaArt317;
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
    tvaCodAnulat,
    dataAnulareTva: String(company.dataAnulareTva || ''),
    motivAnulareTva: company.motivAnulareTva === 'cerere' ? 'cerere' : 'oficiu',
    dataReinregistrareTva: String(company.dataReinregistrareTva || ''),
    tvaArt317,                         // cod special pentru operatiuni intracomunitare, art. 317
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
    fiscalRevisionId: company.fiscalRevisionId || null,
    fiscalValidFrom: company.fiscalValidFrom || null,
    fiscalValidTo: company.fiscalValidTo || null,
    fiscalRecordedAt: company.fiscalRecordedAt || null,
    fiscalRecordedBy: company.fiscalRecordedBy == null ? null : company.fiscalRecordedBy,
  };
}

/** API explicit pentru orice calcul istoric. Acceptă fie firma, fie vederea scoped care conține
 *  `company` + rândurile sale din `fiscal_profile_history`. */
function profileAt(source, when, ctx) {
  return build(source, Object.assign({}, ctx || {}, { asOf: when }));
}

/** Obiectul firmei cu atributele fiscale valabile la reper; identitatea și celelalte setări
 *  rămân cele ale firmei. Este forma transmisă generatoarelor XML care citesc câmpuri brute. */
function companyAt(source, when) {
  source = source || {};
  const company = source.company && typeof source.company === 'object' ? source.company : source;
  return resolve(company, when, historyFor(source, source.firmaId));
}

/** Clonă superficială a vederii scoped, cu `company` rezolvat temporal. */
function viewAt(source, when) {
  if (!source || !source.company) return companyAt(source, when);
  return Object.assign({}, source, { company: companyAt(source, when) });
}

/** Fotografia imuabilă legată de artefactul și depunerea unei declarații. Hash-ul acoperă profilul
 *  normalizat, revizia și data efectivă — nu obiectul mutabil al firmei. */
function declarationSnapshot(source, period, ctx) {
  const profile = profileAt(source, period, ctx);
  const values = {
    tipEntitate: profile.tipEntitate, pfa: profile.pfa, tvaPlatitor: profile.tvaPlatitor,
    tvaCodAnulat: profile.tvaCodAnulat, tvaArt317: profile.tvaArt317,
    perioadaTva: profile.perioadaTva, tvaLaIncasare: profile.tvaLaIncasare,
    regim: profile.regim, sistemProfit: profile.sistemProfit,
    anticipatProfitContabil: profile.anticipatProfitContabil, areAngajati: profile.areAngajati,
    d406: profile.d406, intrastat: profile.intrastat, scutiri: Object.assign({}, profile.scutiri || {}),
  };
  const body = {
    schemaVersion: 1, asOf: asOfDate(period), revisionId: profile.fiscalRevisionId || null,
    validFrom: profile.fiscalValidFrom || null, validTo: profile.fiscalValidTo || null,
    recordedAt: profile.fiscalRecordedAt || null, recordedBy: profile.fiscalRecordedBy == null ? null : profile.fiscalRecordedBy,
    values,
  };
  // `validTo` se închide abia când apare următoarea revizie; dacă ar intra în hash, simpla
  // programare a unei schimbări viitoare ar altera amprenta aceleiași perioade istorice.
  const semantic = { schemaVersion: body.schemaVersion, asOf: body.asOf, values: body.values };
  const provenance = { schemaVersion: body.schemaVersion, revisionId: body.revisionId,
    validFrom: body.validFrom, recordedAt: body.recordedAt, recordedBy: body.recordedBy, values: body.values };
  return Object.assign(body, {
    hash: crypto.createHash('sha256').update(JSON.stringify(semantic)).digest('hex'),
    provenanceHash: crypto.createHash('sha256').update(JSON.stringify(provenance)).digest('hex'),
  });
}

/** Declaratiile ASTEPTATE (lista de `tip`) derivate din profil pentru luna `period` (YYYY-MM).
 *  `hasIntracom(period)` = callback optional: firma a avut operatiuni intracomunitare cu BUNURI.
 *  `hasIntracomServicii(period)` = idem, cu SERVICII. Cele doua sunt separate fiindca declanseaza
 *  declaratii diferite: D390 le cere pe amandoua (art. 325), Intrastat doar bunurile — asa ca o
 *  firma care cumpara numai reclama din UE datoreaza D390, nu si raportarea statistica.
 *  `hasIntrastat(period)` separa miscarea fizica de eligibilitatea D390 (de exemplu bunuri D301).
 *  `hasD205(period)` = raportul anual are cel putin un beneficiar cu retinere la sursa.
 *  Scutirile din profil suprima orice tip. */
function expected(profile, period, hasIntracom, hasIntracomServicii, hasD301, hasD307, hasD311, hasD107, hasD205, hasIntrastat) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return [];
  const sfarsitTrim = endOfQuarter(period);
  const intracom = typeof hasIntracom === 'function' && hasIntracom(period);
  const intracomServicii = typeof hasIntracomServicii === 'function' && hasIntracomServicii(period);
  const miscariIntrastat = typeof hasIntrastat === 'function' ? hasIntrastat(period) : intracom;
  const d301 = typeof hasD301 === 'function' && hasD301(period);
  const d307 = typeof hasD307 === 'function' && hasD307(period);
  const d311 = typeof hasD311 === 'function' && hasD311(period);
  const d107 = typeof hasD107 === 'function' && hasD107(period);
  // Raportul D205 scaneaza anul intreg; nu-l calculam pentru cele 11 luni in care declaratia
  // anuala oricum nu poate aparea (important in portofolii cu multe firme/perioade).
  const d205 = Number(period.slice(5, 7)) === 12
    && typeof hasD205 === 'function' && hasD205(period);
  const tips = [];
  const add = (t) => { if (!profile.scutiri[t] && !tips.includes(t)) tips.push(t); };
  // TVA: D300 + D394 (lunar sau la sfarsit de trimestru, dupa perioada fiscala)
  if (profile.tvaPlatitor && (!profile.trimestrialTva || sfarsitTrim)) { add('d300'); add('d394'); }
  // D390 (VIES): doar in lunile cu operatiuni intracomunitare efective — bunuri SAU servicii
  if (intracom || intracomServicii) add('d390');
  // D301 nu este o declaratie „pe zero": apare numai in lunile in care exista o operatiune
  // speciala efectiva, indiferent daca persoana are sau nu codul special art. 317.
  if (d301) add('d301');
  // D307 si D311, la fel ca D301, se depun numai pentru lunile cu operatiuni efective.
  if (d307) add('d307');
  if (d311) add('d311');
  // Intrastat (INS): firma obligata (peste prag) + miscari de BUNURI in luna. Serviciile nu conteaza
  // aici, oricat de mari ar fi: Intrastatul e statistica de comert cu bunuri.
  if (profile.intrastat && miscariIntrastat) add('intrastat');
  // D112: firme cu salariati
  if (profile.areAngajati) add('d112');
  // D100: trimestrial, non-PFA. Cine il datoreaza pe trimestrul IV depinde de REGIM si, la
  // impozitul pe profit, de SISTEMUL ales (art. 41):
  //  - MICRO: toate patru trimestrele (al patrulea pana pe 25 ianuarie);
  //  - PROFIT, sistem trimestrial (alin. (1)): doar trimestrele I-III — definitivarea anului se
  //    face prin D101, pana pe 25 iunie. Asteptarea unui D100 pe trimestrul IV impingea firma
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
  // D101 (impozit pe profit, ANUAL): doar regimul de profit, la sfarsitul anului (termen 25 iunie
  // anul urmator). Micro NU depune D101.
  if (profile.profit && Number(period.slice(5, 7)) === 12) add('d101');
  // D107 are aceeași cadență ca D101, dar numai când există sponsorizări sau report fiscal.
  // Din 2024 formularul nu se mai depune de microîntreprinderi.
  if (profile.profit && Number(period.slice(5, 7)) === 12 && d107) add('d107');
  // D205 este anuala si se asteapta numai cand raportul are cel putin un beneficiar. Nu depinde
  // de regimul micro/profit, ci de existenta efectiva a veniturilor cu retinere la sursa.
  if (Number(period.slice(5, 7)) === 12 && d205) add('d205');
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
  if (entry && entry.tip === 'achizitie_tva_speciala_d301') {
    if (profile && profile.tvaCodAnulat) {
      return 'Firma are codul normal de TVA anulat. Pentru taxa datorată în această perioadă folosește operațiunea D311, nu D301.';
    }
    if (profile && profile.tvaPlatitor) {
      return 'D301 este decontul special pentru persoane neînregistrate normal în scopuri de TVA. Firma este plătitoare de TVA — folosește achiziția intracomunitară/taxarea inversă și D300.';
    }
    const op = Number(entry.d301 && entry.d301.tipOperatie);
    if (profile && !profile.tvaArt317 && (op === 1 || op === 5)) {
      return 'Operațiunea D301 din secțiunea ' + op + ' cere înregistrarea specială în scopuri de TVA conform art. 317. Activează „Cod special TVA art. 317” în Setări după obținerea codului.';
    }
  }
  if (entry && entry.tip === 'ajustare_regularizare_tva_d307') {
    const tip = String(entry.d307 && entry.d307.tip || '').toUpperCase();
    if ((tip === 'A' || tip === 'L') && profile && profile.tvaPlatitor) {
      return 'Operațiunea D307 de tip ' + tip + ' se depune de persoana care nu este înregistrată normal în scopuri de TVA. Pentru o firmă plătitoare, ajustarea intră în D300.';
    }
    if (tip === 'C') {
      if (!profile || !/^\d{4}-\d{2}-\d{2}$/.test(profile.dataAnulareTva)) {
        return 'Operațiunea D307 de tip C cere data anulării codului TVA, completată în Setări → Firmă.';
      }
      if (entry.data && entry.data < profile.dataAnulareTva) {
        return 'Ajustarea D307 de tip C nu poate fi anterioară datei anulării codului TVA.';
      }
    }
  }
  if (entry && entry.tip === 'operatiune_tva_cod_anulat_d311') {
    const op = Number(entry.d311 && entry.d311.operatie);
    if (op === 61) {
      if (!profile || !profile.tvaPlatitor || !/^\d{4}-\d{2}-\d{2}$/.test(profile.dataReinregistrareTva)) {
        return 'Categoria 61 din D311 cere ca firma să fie reînregistrată normal în scopuri de TVA și data reînregistrării să fie completată în Setări → Firmă.';
      }
      if (entry.data && entry.data < profile.dataReinregistrareTva) return 'Categoria 61 D311 poate fi înregistrată numai la sau după data reînregistrării în scopuri de TVA.';
    } else if (!profile || !profile.tvaCodAnulat || !/^\d{4}-\d{2}-\d{2}$/.test(profile.dataAnulareTva)) {
      return 'Operațiunea D311 cere profilul „Cod normal de TVA anulat” și data anulării, completate în Setări → Firmă.';
    } else if (entry.data && entry.data < profile.dataAnulareTva) {
      return 'Exigibilitatea operațiunii D311 nu poate fi anterioară datei anulării codului TVA.';
    }
    if ((op === 11 || op === 21) && profile.motivAnulareTva === 'cerere') {
      return 'Categoriile 11 și 21 sunt pentru codul TVA anulat din oficiu. La anularea la cerere se declară numai exigibilitatea ulterioară din sistemul TVA la încasare (categoria 41).';
    }
  }
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

module.exports = { build, profileAt, companyAt, viewAt, resolve, snapshot, declarationSnapshot, historyFor, withIntervals, addRevision, recordedAtOf, asOfDate, expected, vatPeriod, endOfQuarter, entryGuard,
  REGIMURI, CADENTE, HISTORIC_FIELDS };
