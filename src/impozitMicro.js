'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  IMPOZITUL PE VENITURILE MICROINTREPRINDERILOR — baza (art. 53) si cota (art. 51)
//
//  DE CE EXISTA MODULUL. Baza era modelata ca „tot rulajul creditor al clasei 7", iar cota ca
//  procentul fix din configuratie. Amandoua sunt gresite, si in acelasi sens — in defavoarea
//  contribuabilului la baza, in favoarea lui la cota:
//
//  (1) BAZA. Art. 53 alin. (1) enumera scaderi care nu sunt marginale pentru o firma reala:
//      reluarea unui provizion, productia de imobilizari in regie proprie, variatia stocurilor de
//      produse si diferentele de curs sunt VENITURI CONTABILE care nu reprezinta incasari din
//      activitate. O firma cu 50.000 lei venit real, 30.000 reluare de provizion, 40.000 productie
//      de imobilizari si 10.000 diferente de curs era impozitata pe 130.000 — de 2,6 ori mai mult.
//      Alin. (2) adauga simetric reducerile comerciale primite si, in ultimul trimestru, diferenta
//      favorabila de curs cumulata pe an.
//
//  (2) COTA. Pentru anii pana la 2025, art. 51 alin. (1) avea DOUA cote: 1% sub prag/in afara
//      listei CAEN si 3% altfel. Din 2026 cota este UNICA, 1% — iar schema oficiala D100/D710
//      impune explicit `cota=1`. Regula istorica ramane necesara pentru rectificarea anilor vechi.
//
//  Modulul e PUR: primeste rulajul agregat {cod: {d, c}}, nu baza de date. Sursa unica pentru
//  D100 si pentru linia comparativa din registrul de evidenta fiscala — cat timp erau doua
//  formule, registrul arata alt impozit micro decat declaratia.
//
//  CE NU GHICESTE, deliberat: art. 53 alin. (1) mai are litere care nu se pot deduce din codul
//  contului — despagubirile de la asigurari (lit. g) stau pe 7581 amestecate cu amenzile si
//  penalitatile INCASATE, care raman in baza; veniturile impozitate deja in strainatate (lit. m)
//  nu au cont propriu. Taxonomia pe tranzactie si registrul de ajustari le modeleaza explicit;
//  partea neclasificata ramane prudent in baza si este semnalata in `note`.
// ─────────────────────────────────────────────────────────────────────────────

const { round2 } = require('./util');
const cfgFiscal = require('./fiscalConfig');

// Cazurile care nu se pot deduce sigur din cont. `effect` este diferenta fata de baza contabila:
// confirm = ramane asa cum a intrat, subtract/add = ajustare fiscala explicita. Codurile sunt
// stabile pentru API si export; etichetele pot evolua fara sa rescrie tranzactiile istorice.
const TAXONOMY = Object.freeze({
  taxable_confirmed: { effect: 'confirm', label: 'Venit impozabil confirmat', legalBasis: 'Art. 53 Cod fiscal' },
  insurance_compensation_own_assets: { effect: 'subtract', label: 'Despagubire de asigurare pentru stocuri/active proprii', legalBasis: 'Art. 53(1)(g)' },
  foreign_income_taxed: { effect: 'subtract', label: 'Venit din strainatate impozitat acolo', legalBasis: 'Art. 53(1)(m)' },
  other_legal_subtraction: { effect: 'subtract', label: 'Alta scadere documentata din baza micro', legalBasis: '' },
  other_legal_addition: { effect: 'add', label: 'Alta adaugare documentata la baza micro', legalBasis: '' },
});

function taxonomyError(message) { const e = new Error(message); e.status = 400; throw e; }
function entryRevenue(entry) {
  return round2((entry && entry.lines || []).reduce((s, line) => {
    const q = Number(line.suma) || 0; let delta = 0;
    if (String(line.credit || '').startsWith('7')) delta += q;
    if (String(line.debit || '').startsWith('7')) delta -= q;
    return s + delta;
  }, 0));
}
function entryRevenueAccounts(entry) {
  return [...new Set((entry && entry.lines || []).flatMap((line) => {
    const out = [];
    if (String(line.credit || '').startsWith('7')) out.push(String(line.credit));
    if (String(line.debit || '').startsWith('7')) out.push(String(line.debit));
    return out;
  }))];
}
function normalizeTaxonomy(value, entry) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const code = String(raw.code || ''); const category = TAXONOMY[code];
  if (!category) taxonomyError('Categoria fiscala micro „' + code + '” nu exista.');
  const derived = entryRevenue(entry);
  const amount = round2(raw.amount == null || raw.amount === '' ? Math.abs(derived) : Number(raw.amount));
  if (!(amount > 0)) taxonomyError('Taxonomia fiscala micro trebuie sa aiba o suma pozitiva.');
  const reason = String(raw.reason || '').trim();
  if (reason.length < 5 || reason.length > 500) taxonomyError('Taxonomia fiscala micro cere un motiv de 5-500 caractere.');
  const legalBasis = String(raw.legalBasis || category.legalBasis || '').trim().slice(0, 160);
  if (!legalBasis) taxonomyError('Categoria fiscala micro aleasa cere un temei legal explicit.');
  const accounts = entryRevenueAccounts(entry);
  return { code, label: category.label, effect: category.effect, amount, reason, legalBasis,
    sourceAccount: String(raw.sourceAccount || (accounts.length === 1 ? accounts[0] : '')).slice(0, 30) };
}

function taxonomyForEntries(entries) {
  const rows = [];
  for (const entry of entries || []) {
    const raw = entry && entry.fiscalTaxonomy && entry.fiscalTaxonomy.micro;
    if (!raw) continue;
    try {
      rows.push(Object.assign({ entryId: entry.id || null, data: entry.data || null,
        period: entry.period || String(entry.data || '').slice(0, 7), document: entry.document || '' }, normalizeTaxonomy(raw, entry)));
    } catch (e) {
      rows.push({ entryId: entry.id || null, data: entry.data || null, period: entry.period || '',
        document: entry.document || '', invalid: true, error: e.message, amount: 0, effect: 'confirm', sourceAccount: '' });
    }
  }
  return rows;
}

function activeAdjustments(company, periods) {
  const wanted = periods ? new Set(periods.map(String)) : null;
  return (company && Array.isArray(company.microTaxAdjustments) ? company.microTaxAdjustments : [])
    .filter((x) => x && x.active !== false && (!wanted || wanted.has(String(x.period))))
    .map((x) => ({ id: String(x.id), period: String(x.period), entryId: x.entryId || null,
      direction: String(x.direction), amount: round2(Number(x.amount) || 0), category: String(x.category || ''),
      legalBasis: String(x.legalBasis || ''), reason: String(x.reason || ''), createdAt: x.createdAt || null,
      createdBy: x.createdBy || null, createdByName: x.createdByName || '' }));
}

/** Soldul creditor net al conturilor care incep cu `prefix` (venituri). */
function venit(rulaj, prefix) {
  let s = 0;
  for (const cod of Object.keys(rulaj || {})) {
    if (String(cod).startsWith(prefix)) s = round2(s + (rulaj[cod].c - rulaj[cod].d));
  }
  return round2(s);
}
/** Soldul debitor net al conturilor care incep cu `prefix` (cheltuieli). */
function cheltuiala(rulaj, prefix) {
  let s = 0;
  for (const cod of Object.keys(rulaj || {})) {
    if (String(cod).startsWith(prefix)) s = round2(s + (rulaj[cod].d - rulaj[cod].c));
  }
  return round2(s);
}

// Scaderile din art. 53 alin. (1), pe prefix de cont. Prefix, nu potrivire exacta: analiticele
// (`741.01`) trebuie sa intre. Ordinea e cea din lege, ca randul din raport sa se poata confrunta
// cu textul. `7584` e prefix mai lung decat `758`, deci NU atrage si 7581/7588 — corect: doar
// subventiile pentru investitii se scad, restul lui 758 ramane in baza.
const SCADERI = [
  { prefix: '711', temei: 'Art. 53(1)(a)', nume: 'Venituri aferente costurilor stocurilor de produse' },
  { prefix: '712', temei: 'Art. 53(1)(b)', nume: 'Venituri aferente costurilor serviciilor in curs de executie' },
  { prefix: '721', temei: 'Art. 53(1)(c)', nume: 'Venituri din productia de imobilizari necorporale' },
  { prefix: '722', temei: 'Art. 53(1)(c)', nume: 'Venituri din productia de imobilizari corporale' },
  { prefix: '74', temei: 'Art. 53(1)(d)', nume: 'Venituri din subventii de exploatare' },
  { prefix: '7584', temei: 'Art. 53(1)(d)', nume: 'Venituri din subventii pentru investitii' },
  { prefix: '781', temei: 'Art. 53(1)(e)', nume: 'Venituri din provizioane si ajustari pentru depreciere (exploatare)' },
  { prefix: '786', temei: 'Art. 53(1)(e)', nume: 'Venituri din ajustari pentru pierderea de valoare (financiare)' },
  { prefix: '765', temei: 'Art. 53(1)(h)', nume: 'Venituri din diferente de curs valutar' },
  { prefix: '768', temei: 'Art. 53(1)(i)', nume: 'Venituri financiare din creante/datorii decontate la curs' },
];

// Adaugarile din art. 53 alin. (2). Reducerile comerciale PRIMITE stau pe 609, un cont de clasa 6
// cu sold CREDITOR — deci nu sunt in clasa 7 si nu intra in baza de la sine.
const ADAUGARI = [
  { prefix: '609', temei: 'Art. 53(2)(a)', nume: 'Reduceri comerciale primite ulterior facturarii' },
];

// Diferenta favorabila de curs se adauga in ULTIMUL trimestru, cumulat de la inceputul anului
// (art. 53 alin. (2) lit. b): peste an, doar excedentul de venit din curs este impozitat, iar in
// trimestrele I-III se scade integral. Perechile venit/cheltuiala sunt cele din lege.
const PERECHI_CURS = [{ venit: '765', chelt: '665' }, { venit: '768', chelt: '668' }];

/**
 * Baza impozabila a unui trimestru (art. 53).
 *
 * @param {object} rulaj      rulajul TRIMESTRULUI, {cod: {d, c}} — fara inchiderile 6/7 (vezi
 *                            `accounting.resultLines`), altfel totul iese zero dupa inchiderea anuala
 * @param {object} opts       { ultimulTrimestru, rulajAn } — `rulajAn` e rulajul CUMULAT al anului,
 *                            necesar doar pentru diferenta de curs din ultimul trimestru
 * @returns {{ venitClasa7, scaderi, totalScaderi, adaugari, totalAdaugari, baza, note }}
 */
function baza(rulaj, opts) {
  opts = opts || {};
  const r = rulaj || {};
  let venitClasa7 = 0;
  for (const cod of Object.keys(r)) {
    if (Number(String(cod)[0]) === 7) venitClasa7 = round2(venitClasa7 + (r[cod].c - r[cod].d));
  }

  const scaderi = [];
  for (const s of SCADERI) {
    const suma = venit(r, s.prefix);
    if (suma > 0) scaderi.push({ cont: s.prefix, nume: s.nume, temei: s.temei, suma });
  }
  const adaugari = [];
  for (const a of ADAUGARI) {
    const suma = venit(r, a.prefix); // 609 are sold creditor: `venit` il ia cu semnul corect
    if (suma > 0) adaugari.push({ cont: a.prefix, nume: a.nume, temei: a.temei, suma });
  }

  // Taxonomia pe tranzactie si registrul de ajustari sunt RANDURI, nu un „override de total".
  // Astfel baza poate fi refacuta pana la articol, document, temei si actor.
  const taxonomies = Array.isArray(opts.taxonomies) ? opts.taxonomies : [];
  const registerAdjustments = Array.isArray(opts.adjustments) ? opts.adjustments : [];
  for (const row of taxonomies.filter((x) => !x.invalid && (x.effect === 'subtract' || x.effect === 'add'))) {
    const out = { cont: row.sourceAccount || ('articol ' + row.entryId), nume: row.label,
      temei: row.legalBasis, suma: round2(row.amount), source: 'transaction-taxonomy', entryId: row.entryId || null };
    if (row.effect === 'subtract') scaderi.push(out); else adaugari.push(out);
  }
  for (const row of registerAdjustments) {
    const out = { cont: row.entryId ? ('articol ' + row.entryId) : ('registru ' + row.id),
      nume: row.category || row.reason, temei: row.legalBasis, suma: round2(row.amount),
      source: 'adjustment-register', adjustmentId: row.id };
    if (row.direction === 'subtract') scaderi.push(out);
    else if (row.direction === 'add') adaugari.push(out);
  }

  // Ultimul trimestru: diferenta favorabila de curs a ANULUI reintra in baza. Se calculeaza pe
  // rulajul anual, nu pe cel al trimestrului — legea spune „cumulat de la inceputul anului".
  if (opts.ultimulTrimestru) {
    const ra = opts.rulajAn || r;
    let favorabil = 0;
    for (const p of PERECHI_CURS) favorabil = round2(favorabil + venit(ra, p.venit) - cheltuiala(ra, p.chelt));
    if (favorabil > 0) {
      adaugari.push({ cont: '765/768', temei: 'Art. 53(2)(b)',
        nume: 'Diferenta favorabila de curs valutar, cumulata pe an (ultimul trimestru)', suma: favorabil });
    }
  }

  const totalScaderi = round2(scaderi.reduce((s, x) => s + x.suma, 0));
  const totalAdaugari = round2(adaugari.reduce((s, x) => s + x.suma, 0));
  // Baza nu poate fi negativa: un trimestru in care scaderile depasesc veniturile nu produce
  // impozit negativ (nu exista rambursare la impozitul micro).
  const rezultat = round2(venitClasa7 - totalScaderi + totalAdaugari);

  const note = [];
  const invalidTaxonomies = taxonomies.filter((x) => x.invalid);
  for (const row of invalidTaxonomies) note.push('Taxonomia fiscală a articolului ' + row.entryId + ' este invalidă: ' + row.error);
  const classified7581 = round2(taxonomies.filter((x) => !x.invalid && String(x.sourceAccount).startsWith('7581'))
    .reduce((s, x) => s + (Number(x.amount) || 0), 0));
  const unresolved7581 = round2(Math.max(0, venit(r, '7581') - classified7581));
  if (unresolved7581 > 0) {
    note.push('Din contul 7581 au rămas neclasificați fiscal ' + unresolved7581 + ' lei: despăgubirile de la '
      + 'asigurări pentru stocuri și active proprii se scad (art. 53(1)(g)), dar amenzile și '
      + 'penalitățile încasate NU — iar cele două stau pe același cont. Verifică și, dacă e cazul, '
      + 'atașează taxonomia tranzacției.');
  }
  return { venitClasa7, scaderi, totalScaderi, adaugari, totalAdaugari, baza: Math.max(0, rezultat), note,
    taxonomies, registerAdjustments, unresolved: { account7581: unresolved7581 } };
}

/**
 * Cota aplicabila (art. 51 alin. (1) si (4)).
 *
 * @param {object} i   { an, venitCumulatLei, curs, caen } — venitul cumulat de la inceputul anului
 *                     PANA LA FINALUL trimestrului raportat (alin. (4): comutarea opereaza de la
 *                     trimestrul depasirii, deci contorul e cumulat, nu pe trimestru)
 * @param {object} cfg cotele (fiscal.FISCAL)
 * @returns {{ cota, motiv, prin, pragLei, venitCumulatLei, avertismente }}
 */
function cotaAplicabila(i, cfg) {
  i = i || {}; cfg = cfg || {};
  const c1 = Number(cfg.impozitMicro) || 1;
  const c3 = Number(cfg.impozitMicro3) || 3;
  const pragEur = Number(cfg.pragMicro3Eur) || 0;
  const curs = Number(i.curs) || 0;
  const pragLei = round2(pragEur * curs);
  const venitCumulatLei = round2(Number(i.venitCumulatLei) || 0);
  const caen = String(i.caen || '').trim();
  const avertismente = [];

  // Din 2026 nu mai exista pragul de 60.000 EUR si nici ramura CAEN de 3%. O evaluare a regulii
  // vechi ar calcula 3%, in timp ce XML-ul oficial este obligat sa poarte `cota=1` — fisier valid
  // formal, dar cu o suma de trei ori prea mare. Taierea pe an tine rectificarile 2025 corecte.
  if (Number(i.an) >= 2026) {
    return { cota: c1, prin: 'cota-unica-2026', pragLei: 0, venitCumulatLei, avertismente,
      motiv: 'Cota unică de ' + c1 + '% aplicabilă microîntreprinderilor din 2026.' };
  }

  const peCaen = caen && cfgFiscal.CAEN_MICRO_3.includes(caen);
  const pestePrag = pragLei > 0 && venitCumulatLei > pragLei;

  if (!caen) {
    avertismente.push('Codul CAEN al firmei nu e completat, deci condiția de activitate de la '
      + 'art. 51 alin. (1) lit. b) pct. 2 (IT, HoReCa, juridic, medical → 3% indiferent de venituri) '
      + 'NU a putut fi verificată. Completează-l în Setări.');
  } else if (!peCaen) {
    avertismente.push('Cota s-a verificat pe codul CAEN principal (' + caen + '). Condiția legală '
      + 'privește și activitățile SECUNDARE: dacă firma desfășoară vreuna din lista art. 51 '
      + '(IT, HoReCa, juridic, medical), cota e 3% indiferent de venituri.');
  }
  if (pragLei <= 0) {
    avertismente.push('Cursul pentru pragul de ' + pragEur + ' EUR nu e configurat, deci pragul '
      + 'dintre cotele de ' + c1 + '% și ' + c3 + '% nu a putut fi aplicat.');
  }

  if (peCaen) {
    return { cota: c3, prin: 'caen', pragLei, venitCumulatLei, avertismente,
      motiv: 'Cota de ' + c3 + '% — codul CAEN ' + caen + ' e în lista art. 51 alin. (1) lit. b) pct. 2, '
        + 'unde cota se aplică indiferent de venituri.' };
  }
  if (pestePrag) {
    return { cota: c3, prin: 'prag', pragLei, venitCumulatLei, avertismente,
      motiv: 'Cota de ' + c3 + '% — veniturile cumulate ale anului (' + venitCumulatLei + ' lei) '
        + 'depășesc pragul de ' + pragEur + ' EUR (~' + pragLei + ' lei). Art. 51 alin. (4): '
        + 'comutarea se aplică începând cu trimestrul depășirii.' };
  }
  return { cota: c1, prin: 'implicit', pragLei, venitCumulatLei, avertismente,
    motiv: 'Cota de ' + c1 + '% — venituri sub pragul de ' + pragEur + ' EUR'
      + (pragLei > 0 ? ' (~' + pragLei + ' lei)' : '') + ' și în afara codurilor CAEN de la art. 51.' };
}

module.exports = { baza, cotaAplicabila, SCADERI, ADAUGARI, PERECHI_CURS, TAXONOMY,
  normalizeTaxonomy, taxonomyForEntries, activeAdjustments, entryRevenue };
