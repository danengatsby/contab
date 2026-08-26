'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  SITUATII FINANCIARE ANUALE — maparea pe randurile OFICIALE ANAF (F10 + F20)
//
//  Formularele (OMFP 1802/2014), dupa categoria de entitate:
//    S1120 — microentitati:      F10 prescurtat (51 randuri) + F20 prescurtat (14)
//    S1121 — entitati mici:      F10 prescurtat (ACELASI)    + F20 complet   (88)
//    S1122 — mijlocii/mari:      F10 complet    (104)        + F20 complet   (88)
//
//  F10 e IDENTIC intre S1120 si S1121 — o singura mapare serveste ambele formulare.
//
//  ATENTIE, distinctia care conteaza: `statements.js balanceSheetF10` da AGREGATE DE AFISAJ
//  (A_necorp, B_stocuri…), potrivite pentru PDF-ul intern. Formularul ANAF cere RANDURI
//  NUMEROTATE, cu alta granularitate si cu doua coloane (inceput/sfarsit de exercitiu).
//  Sunt doua lucruri diferite; acest modul NU il inlocuieste pe celalalt.
//
//  Sufixul de camp: `F10_00291` = randul 029, coloana 1 (INCEPUTUL exercitiului);
//                   `F10_00292` = acelasi rand, coloana 2 (SFARSITUL exercitiului).
//
//  INVARIANTUL CENTRAL: fiecare cont cade in EXACT UN rand, cu semnul corect. Numai asa
//  identitatea de bilant a validatorului se satisface prin CONSTRUCTIE, nu din noroc:
//    F10_049 = F10_004 + F10_009 + F10_010 - F10_013 - F10_016 - F10_017 - F10_018
//  Totalurile NU se aduna independent: se calculeaza cu formulele validatorului (vezi TOTALURI),
//  ca sa nu poata aparea divergenta intre ce spune formularul si ce verifica ANAF.
// ─────────────────────────────────────────────────────────────────────────────

const { round2 } = require('./util');
const coa = require('./chartOfAccounts');
const { finalBalances } = require('./statements');
const { postedEntries, resultLines, accumulate, trialBalance } = require('./accounting');
const { period: periodOf, validIsoDate } = require('./util');
const crypto = require('crypto');

const classOf = (cod) => (coa.getAccount(cod) || {}).clasa || Number(String(cod)[0]);
const starts = (cod, ...pre) => pre.some((p) => String(cod).startsWith(p));

// Diferența maximă care poate fi alocată automat exclusiv ca efect al raportării rândurilor în lei
// întregi. Alocarea deterministă este consemnată în raport și nu atinge rezultatul ori 117; peste
// acest prag diferența rămâne expusă și blochează XML-ul. Orice corecție economică se face numai
// prin registrul separat de ajustări aprobat și amprentat.
const TOLERANTA_ROTUNJIRE_LEI = 1;
// După alocare, validatorul cere identitate exactă. Pragul reziduului RĂMAS este deci zero.
const PRAG_REZIDUAL = 0;

const AFILIERI = new Set(['none', 'affiliate', 'associate']);
const LINII_F10_PRESCURTAT_ELEMENTARE = new Set([
  '001', '002', '003', '005', '007', '008', '011', '012', '013', '016', '017',
  '020', '021', '023', '024', '026', '027', '028', '030', '031', '032', '033',
  '034', '035', '036', '037', '038', '039', '040', '041', '042', '043', '044',
  '045', '047', '048', '301', '302',
]);
const LINII_F10_COMPLET_ELEMENTARE = new Set([
  ...Array.from({ length: 103 }, (_, i) => String(i + 1).padStart(3, '0')),
  '301',
]);
const LINII_F10_COMPLET_TOTAL = new Set([
  '007', '017', '024', '025', '030', '036', '039', '041', '042', '053', '054',
  '055', '064', '068', '069', '072', '075', '079', '085', '091', '100', '103',
]);
for (const row of LINII_F10_COMPLET_TOTAL) LINII_F10_COMPLET_ELEMENTARE.delete(row);
const LINII_F20_DIN_CARE_SIGURE = new Set([
  '301', '302', '303', '305', '307', '308', '309', '311', '313', '315', '317', '318',
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonical(value[key]);
  return out;
}
function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function hashRecord(record) {
  // `id` este cheia locala de persistenta si poate fi remapata la restaurarea aceleiasi firme;
  // continutul, firmaId si lantul raman semnate.
  const copy = Object.assign({}, record); delete copy.hash; delete copy.id;
  return sha256(copy);
}
function mappingRows(view) {
  return (view && (view.balanceSheetMappings || view.balance_sheet_mappings)) || [];
}
function adjustmentRows(view) {
  return (view && (view.balanceSheetAdjustments || view.balance_sheet_adjustments)) || [];
}
function ordered(rows, timeField) {
  return (rows || []).slice().sort((a, b) => {
    const as = Number(a.sequence); const bs = Number(b.sequence);
    if (Number.isInteger(as) && Number.isInteger(bs) && as !== bs) return as - bs;
    return String(a[timeField] || '').localeCompare(String(b[timeField] || ''))
      || String(a.id || '').localeCompare(String(b.id || ''));
  });
}

/** Ultima versiune valida a metadatelor pe cont/an; versiunile vechi raman append-only. */
function metadataState(view, year) {
  const selected = new Map(); const invalid = [];
  const relevant = ordered(mappingRows(view).filter((r) => String(r.year) === String(year)), 'recordedAt');
  const previous = new Map();
  for (const row of relevant) {
    const account = String(row.account || '');
    const expectedPrevious = previous.get(account) || '';
    const valid = /^[0-9a-f]{64}$/.test(String(row.hash || '')) && row.hash === hashRecord(row)
      && String(row.previousHash || '') === expectedPrevious;
    if (!valid) invalid.push({ year: String(year), account, id: row.id || null, value: 0,
      reason: 'Metadatele de bilanț au hash-ul sau lanțul invalid.' });
    else selected.set(account, row);
    previous.set(account, String(row.hash || ''));
  }
  return { byAccount: selected, invalid };
}

function sourceHash(view, year) {
  const state = metadataState(view, year);
  return sha256({
    schemaVersion: 1,
    year: String(year),
    balances: finalBalances(view, String(year) + '-12'),
    profitAndLossAccounts: plAcc(view, year),
    mappings: [...state.byAccount.values()].map((r) => ({ account: r.account, hash: r.hash }))
      .sort((a, b) => String(a.account).localeCompare(String(b.account))),
  });
}

function metadataRecord(view, firmaId, body, actor, id) {
  const b = body || {}; const year = String(b.year || ''); const account = String(b.account || '').trim();
  if (!/^\d{4}$/.test(year)) { const e = new Error('An invalid pentru metadatele de bilanț.'); e.status = 400; throw e; }
  if (!/^\d{3,}$/.test(account) || !coa.getAccount(account)) { const e = new Error('Cont invalid pentru metadatele de bilanț: ' + account); e.status = 400; throw e; }
  const reason = String(b.reason || '').trim();
  if (reason.length < 10) { const e = new Error('Metadatele de bilanț cer un motiv de minimum 10 caractere.'); e.status = 400; throw e; }
  const dueDate = String(b.dueDate || '').trim();
  if (dueDate && !validIsoDate(dueDate)) { const e = new Error('Scadența trebuie să fie o dată calendaristică YYYY-MM-DD.'); e.status = 400; throw e; }
  const currentPortion = b.currentPortion === '' || b.currentPortion == null ? null : Number(b.currentPortion);
  if (currentPortion != null && (!Number.isFinite(currentPortion) || currentPortion < 0)) {
    const e = new Error('Porțiunea curentă trebuie să fie o sumă pozitivă sau zero.'); e.status = 400; throw e;
  }
  const affiliation = String(b.affiliation || 'none');
  if (!AFILIERI.has(affiliation)) { const e = new Error('Afilierea trebuie să fie none, affiliate sau associate.'); e.status = 400; throw e; }
  const f10Line = String(b.f10Line || '').padStart(b.f10Line ? 3 : 0, '0');
  const f10CompleteLine = String(b.f10CompleteLine || '').padStart(b.f10CompleteLine ? 3 : 0, '0');
  if (f10Line && !LINII_F10_PRESCURTAT_ELEMENTARE.has(f10Line)) { const e = new Error('Linie F10 prescurtată invalidă sau total calculat: ' + f10Line); e.status = 400; throw e; }
  if (f10CompleteLine && !LINII_F10_COMPLET_ELEMENTARE.has(f10CompleteLine)) { const e = new Error('Linie F10 completă invalidă sau total calculat: ' + f10CompleteLine); e.status = 400; throw e; }
  const f20DetailLine = String(b.f20DetailLine || '').padStart(b.f20DetailLine ? 3 : 0, '0');
  if (f20DetailLine && !LINII_F20_DIN_CARE_SIGURE.has(f20DetailLine)) { const e = new Error('Linie F20 „din care” invalidă sau participantă la formule: ' + f20DetailLine); e.status = 400; throw e; }
  const previous = ordered(mappingRows(view).filter((r) => String(r.year) === year && String(r.account) === account), 'recordedAt').slice(-1)[0];
  const record = {
    schemaVersion: 1, id, firmaId: Number(firmaId), year, account,
    sequence: previous && Number.isInteger(Number(previous.sequence)) ? Number(previous.sequence) + 1 : 1,
    dueDate: dueDate || null, currentPortion: currentPortion == null ? null : round2(currentPortion),
    affiliation, f10Line: f10Line || null, f10CompleteLine: f10CompleteLine || null,
    f20DetailLine: f20DetailLine || null, mappingSign: ['net', 'credit', 'absolute'].includes(b.mappingSign) ? b.mappingSign : 'absolute',
    reason: reason.slice(0, 500), recordedAt: new Date().toISOString(),
    recordedBy: { id: actor && actor.id != null ? actor.id : null, username: String(actor && actor.username || '') },
    previousHash: previous ? String(previous.hash || '') : '',
  };
  record.hash = hashRecord(record);
  return record;
}

function adjustmentRecord(view, firmaId, body, actor, id) {
  const b = body || {}; const year = String(b.year || '');
  if (!/^\d{4}$/.test(year)) { const e = new Error('An invalid pentru ajustarea de bilanț.'); e.status = 400; throw e; }
  const scope = b.scope === 'complet' ? 'complet' : b.scope === 'prescurtat' ? 'prescurtat' : '';
  if (!scope) { const e = new Error('Ajustarea trebuie să indice formularul: prescurtat sau complet.'); e.status = 400; throw e; }
  const row = String(b.row || '').padStart(b.row ? 3 : 0, '0');
  const allowed = scope === 'complet' ? LINII_F10_COMPLET_ELEMENTARE : LINII_F10_PRESCURTAT_ELEMENTARE;
  if (!allowed.has(row)) { const e = new Error('Ajustarea poate viza numai un rând F10 elementar, nu un total calculat.'); e.status = 400; throw e; }
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || !amount) { const e = new Error('Ajustarea F10 trebuie exprimată în lei întregi și să fie diferită de zero.'); e.status = 400; throw e; }
  const reason = String(b.reason || '').trim();
  if (reason.length < 10) { const e = new Error('Ajustarea cere un motiv de minimum 10 caractere.'); e.status = 400; throw e; }
  const currentSourceHash = sourceHash(view, year);
  if (!/^[0-9a-f]{64}$/.test(String(b.sourceHash || '')) || String(b.sourceHash) !== currentSourceHash) {
    const e = new Error('Aprobarea ajustării cere SHA-256 al balanței și mapării curente; reîncarcă raportul de control.');
    e.status = 409; e.code = 'BILANT_ADJUSTMENT_SOURCE_MISMATCH'; e.currentSourceHash = currentSourceHash; throw e;
  }
  const previous = ordered(adjustmentRows(view).filter((r) => String(r.year) === year), 'approvedAt').slice(-1)[0];
  const record = {
    schemaVersion: 1, id, firmaId: Number(firmaId), year, form: 'F10', scope, row, amount,
    sequence: previous && Number.isInteger(Number(previous.sequence)) ? Number(previous.sequence) + 1 : 1,
    reason: reason.slice(0, 500), sourceHash: currentSourceHash,
    approvedAt: new Date().toISOString(),
    approvedBy: { id: actor && actor.id != null ? actor.id : null, username: String(actor && actor.username || '') },
    previousHash: previous ? String(previous.hash || '') : '',
  };
  record.hash = hashRecord(record);
  return record;
}

function mappingValue(meta, value) {
  if (!meta || meta.mappingSign === 'absolute') return Math.abs(value);
  if (meta.mappingSign === 'credit') return -value;
  return value;
}

function attachReport(rows, report) {
  Object.defineProperty(rows, 'mappingReport', { value: report, enumerable: false, configurable: true });
  return rows;
}

// ── F10: BILANT PRESCURTAT (51 de randuri) ───────────────────────────────────

/**
 * Randurile de baza ale bilantului la o data, dintr-un set de solduri nete
 * (`net[cont]` > 0 = sold debitor). Intoarce doar randurile ELEMENTARE; totalurile
 * se calculeaza separat, din formulele validatorului.
 *
 * Conturile bifunctionale (clasa 4, trezorerie) se clasifica DUPA SEMN, nu dupa denumire:
 * un 401 cu sold debitor e o creanta (avans la furnizor), nu o datorie negativa.
 */
function maturitySplit(meta, total, year) {
  if (!meta) return null;
  if (meta.currentPortion != null) {
    const current = round2(Number(meta.currentPortion));
    if (current < 0 || current > round2(total) + 0.005) return { invalid: true, current, noncurrent: 0 };
    return { current, noncurrent: round2(total - current) };
  }
  if (meta.dueDate && validIsoDate(String(meta.dueDate))) {
    const cutoff = String(Number(year) + 1) + '-12-31';
    return String(meta.dueDate) <= cutoff ? { current: total, noncurrent: 0 } : { current: 0, noncurrent: total };
  }
  return null;
}

function newMappingReport(state, year) {
  return {
    year: String(year || ''), mapped: [], unmapped: [], missingMetadata: [],
    invalidMetadata: (state && state.invalid || []).slice(),
    roundingAdjustments: [],
    adjustments: { applied: [], invalid: [], stale: [] },
  };
}

function f10Base(net, options) {
  const opts = options || {}; const state = metadataState(opts.view, opts.year);
  const report = newMappingReport(state, opts.year);
  const R = {};
  const add = (rand, val, cod, source) => {
    R[rand] = round2((R[rand] || 0) + val);
    if (cod) report.mapped.push({ account: cod, name: coa.accountName(cod), value: round2(net[cod]),
      row: rand, allocatedValue: round2(val), source: source || 'standard' });
  };
  const unmapped = (cod, val, reason, metadata) => {
    const row = { year: String(opts.year || ''), account: cod, name: coa.accountName(cod), value: round2(val), reason };
    report.unmapped.push(row); if (metadata) report.missingMetadata.push(row);
  };

  // Rezultatul exercitiului NEINCHIS: pana la inchiderea anuala (6/7 -> 121) rezultatul nu e
  // pe 121, ci raspandit in clasele 6 si 7. Daca l-am sari, capitalurile proprii ar fi mai mici
  // cu exact profitul anului si identitatea de bilant a validatorului ar pica. Il acumulam
  // aici si il varsam pe randurile 043/044 IMPREUNA cu soldul lui 121 (cazul deja inchis),
  // deci formula merge identic inainte si dupa inchiderea anuala.
  let rezNeinchis = 0;

  for (const cod of Object.keys(net)) {
    const v = net[cod];
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v) < 0.005) continue;
    const cl = classOf(cod);
    if (cl === 6 || cl === 7) { rezNeinchis = round2(rezNeinchis - v); continue; } // venit(-) − cheltuiala(+)
    if (cl >= 8) continue; // conturi speciale/de gestiune — in afara bilantului
    const meta = state.byAccount.get(String(cod));
    if (meta && meta.f10Line) { add(meta.f10Line, mappingValue(meta, v), cod, 'metadata'); continue; }

    // ── ACTIVE IMOBILIZATE (clasa 2), NETE de amortizari/ajustari (28x/29x = sold creditor)
    if (cl === 2) {
      if (starts(cod, '20', '233', '280', '290')) add('001', v, cod);       // necorporale
      else if (starts(cod, '26', '296')) add('003', v, cod);                 // financiare
      else add('002', v, cod);                                              // corporale: 21x, 231, 235, 281x, 291x, 2931
      continue;
    }
    // ── STOCURI (clasa 3), nete de ajustari 39x
    if (cl === 3) { add('005', v, cod); continue; }
    // ── Cheltuieli in avans (471): portiunea curenta nu se mai deduce din prefix. ──
    if (starts(cod, '471')) {
      if (v <= 0) { unmapped(cod, v, 'Soldul creditor al contului 471 cere o linie F10 explicită.', true); continue; }
      const split = maturitySplit(meta, Math.abs(v), opts.year);
      if (!split || split.invalid) { unmapped(cod, v, split && split.invalid
        ? 'Porțiunea curentă depășește soldul contului 471.'
        : 'Lipsesc scadența sau porțiunea curentă pentru contul 471.', true); continue; }
      if (split.current) add('011', split.current, cod, 'maturity-metadata');
      if (split.noncurrent) add('012', split.noncurrent, cod, 'maturity-metadata');
      continue;
    }
    // ── Venituri in avans, pe cele patru componente ale randului 018
    if (starts(cod, '475')) { add('020', -v, cod); continue; }  // subventii pentru investitii (<= 1 an)
    if (starts(cod, '472')) { add('023', -v, cod); continue; }  // venituri inregistrate in avans
    if (starts(cod, '478')) { add('026', -v, cod); continue; }  // venituri in avans / active primite prin transfer

    // ── CAPITALURI PROPRII (clasa 1) — sold creditor => valoare pozitiva in formular
    if (cl === 1) {
      if (starts(cod, '1012')) { add('030', -v, cod); continue; }  // capital subscris varsat
      if (starts(cod, '1011')) { add('031', -v, cod); continue; }  // capital subscris nevarsat
      if (starts(cod, '1015')) { add('032', -v, cod); continue; }  // patrimoniul regiei
      if (starts(cod, '1018')) { add('033', -v, cod); continue; }  // patrimoniul institutelor nationale de C&D
      if (starts(cod, '1016')) { add('047', -v, cod); continue; }  // patrimoniul public
      if (starts(cod, '1017')) { add('048', -v, cod); continue; }  // patrimoniul privat
      if (starts(cod, '103')) { add('034', -v, cod); continue; }   // alte elemente de capitaluri proprii
      if (starts(cod, '104')) { add('035', -v, cod); continue; }   // prime de capital
      if (starts(cod, '105')) { add('036', -v, cod); continue; }   // rezerve din reevaluare
      if (starts(cod, '106')) { add('037', -v, cod); continue; }   // rezerve
      if (starts(cod, '109')) { add('038', v, cod); continue; }    // actiuni proprii (sold DEBITOR, se scade)
      if (starts(cod, '141')) { add('039', -v, cod); continue; }   // castiguri legate de instrumentele de capitaluri
      if (starts(cod, '149')) { add('040', v, cod); continue; }    // pierderi legate de instrumentele de capitaluri
      if (starts(cod, '117')) { add(v <= 0 ? '041' : '042', Math.abs(v), cod); continue; } // reportat: C / D
      if (starts(cod, '121')) { add(v <= 0 ? '043' : '044', Math.abs(v), cod); continue; } // exercitiu: C / D
      if (starts(cod, '129')) { add('045', v, cod); continue; }    // repartizarea profitului (sold debitor)
      if (starts(cod, '15')) { add('017', -v, cod); continue; }    // provizioane
      if (starts(cod, '16')) {
        if (v >= 0) { unmapped(cod, v, 'Soldul debitor al unui cont din grupa 16 cere o linie F10 explicită.', true); continue; }
        const split = maturitySplit(meta, -v, opts.year);
        if (!split || split.invalid) { unmapped(cod, v, split && split.invalid
          ? 'Porțiunea curentă depășește soldul datoriei din grupa 16.'
          : 'Lipsesc scadența sau porțiunea curentă pentru datoria din grupa 16.', true); continue; }
        if (split.current) add('013', split.current, cod, 'maturity-metadata');
        if (split.noncurrent) add('016', split.noncurrent, cod, 'maturity-metadata');
        continue;
      }
      // Un cont de clasa 1 necunoscut nu mai este ascuns in „alte capitaluri".
      unmapped(cod, v, 'Cont de clasa 1 fără regulă sau linie F10 explicită.'); continue;
    }
    // ── AJUSTARILE PENTRU DEPRECIERE (49x, 59x) — RECTIFICATIVE, nu datorii ──────────────────
    // Au sold CREDITOR, ca o datorie, dar nu sunt o obligatie catre nimeni: corecteaza in minus
    // activul pe care il insotesc. Bilantul cere activele NETE (OMFP 1802/2014), deci ajustarea
    // se scade din randul activului, nu se adauga la datorii.
    //
    // Trebuie tratate INAINTEA clasificarii dupa semn de mai jos: acolo orice sold creditor
    // devine datorie curenta, deci o ajustare de creante aparea simultan ca datorie fictiva SI
    // lasa creantele la valoarea BRUTA. Totalurile ramaneau echilibrate (ambele parti crescute cu
    // aceeasi suma), deci nicio verificare de echilibru nu o putea prinde — dar rd. 013 raporta
    // la ANAF o datorie inexistenta, iar rd. 301 creante neajustate.
    if (starts(cod, '491', '495', '496')) { add('301', v, cod); continue; } // ajustari de creante
    if (starts(cod, '59')) { add('007', v, cod); continue; }                // ajustari de investitii pe termen scurt
    // ── Investitii pe termen scurt (50x)
    if (starts(cod, '50')) { if (v >= 0) add('007', v, cod); else add('013', -v, cod); continue; }
    // ── Casa si conturi la banci; sold creditor (descoperit de cont) = datorie curenta
    if (starts(cod, '51', '52', '53', '54')) { if (v >= 0) add('008', v, cod); else add('013', -v, cod); continue; }
    // ── Clasa 4 (si rest): SEMNUL decide creanta vs. datorie curenta.
    //    Cand exista metadate, soldul se separa explicit in portiunea curenta/necurenta.
    if (cl === 4 || cl === 5) {
      const split = (meta && (meta.currentPortion != null || meta.dueDate))
        ? maturitySplit(meta, Math.abs(v), opts.year) : null;
      if (split && split.invalid) { unmapped(cod, v, 'Porțiunea curentă depășește soldul contului.', true); continue; }
      if (v > 0) {
        if (split) {
          if (split.current) add('301', split.current, cod, 'maturity-metadata');
          if (split.noncurrent) add('302', split.noncurrent, cod, 'maturity-metadata');
        } else add('301', v, cod);
      } else if (split) {
        if (split.current) add('013', split.current, cod, 'maturity-metadata');
        if (split.noncurrent) add('016', split.noncurrent, cod, 'maturity-metadata');
      } else add('013', -v, cod);
    } else unmapped(cod, v, 'Cont fără regulă F10 și fără linie explicită în metadate.');
  }

  // Rezultatul exercitiului: soldul lui 121 (deja pus pe 043/044 mai sus) PLUS partea neinchisa.
  // Se recompune net, ca profitul si pierderea sa nu apara simultan (validatorul respinge asta:
  // „F10_0431 si F10_0441 nu pot fi ambele > 0").
  if (Math.abs(rezNeinchis) >= 0.005) {
    const net121 = round2((R['043'] || 0) - (R['044'] || 0) + rezNeinchis);
    R['043'] = net121 > 0 ? net121 : 0;
    R['044'] = net121 < 0 ? round2(-net121) : 0;
  }
  return attachReport(R, report);
}

// Randurile pe care le calculam prin FORMULELE validatorului (nu prin insumare proprie).
// Ordinea conteaza: un total poate depinde de altul calculat mai devreme.
function f10Totals(R) {
  const g = (k) => round2(R[k] || 0);
  const set = (k, v) => { R[k] = round2(v); };

  set('302', g('302'));                                        // creante > 1 an (azi mereu 0)
  set('006', g('301') + g('302'));                             // creante — total
  set('004', g('001') + g('002') + g('003'));                  // active imobilizate — total
  set('009', g('005') + g('006') + g('007') + g('008'));       // active circulante — total
  set('012', g('012'));                                        // cheltuieli in avans > 1 an (azi 0)
  set('010', g('011') + g('012'));                             // cheltuieli in avans — total
  set('021', g('021')); set('024', g('024')); set('027', g('027')); set('028', g('028'));
  set('019', g('020') + g('021'));                             // subventii pentru investitii
  set('022', g('023') + g('024'));                             // venituri inregistrate in avans
  set('025', g('026') + g('027'));                             // venituri in avans / active prin transfer
  set('018', g('019') + g('022') + g('025') + g('028'));       // venituri in avans — total
  // active circulante nete / datorii curente nete
  set('014', g('009') + g('011') - g('013') - g('020') - g('023') - g('026'));
  set('015', g('004') + g('012') + g('014'));                  // total active minus datorii curente
  set('029', g('030') + g('031') + g('032') + g('033') + g('034')); // capital — total
  set('046', g('029') + g('035') + g('036') + g('037') - g('038') + g('039') - g('040')
    + g('041') - g('042') + g('043') - g('044') - g('045'));   // capitaluri proprii — total
  set('049', g('046') + g('047') + g('048'));                  // capitaluri — total
  return R;
}

// Formularul se raporteaza in LEI INTREGI (validatorul respinge zecimalele: „numar intreg eronat").
// Rotunjirea trebuie facuta pe randurile ELEMENTARE, INAINTE de totaluri — altfel un total rotunjit
// separat poate sa nu mai fie egal cu suma partilor lui rotunjite, si validatorul respinge exact asta.
const intLei = (x) => Math.round(Number(x) || 0);

// Identitatea de bilanț rezultă din partida dublă. După alocarea transparentă a unei eventuale
// diferențe de rotunjire, orice reziduu rămas este măsurat și nu este mutat într-un rând.
/** Calculeaza diferenta F10 fara a modifica vreun rand al formularului. */
function marcheazaDiferenta(R) {
  const g = (k) => R[k] || 0;
  const rezid = (g('004') + g('009') + g('010') - g('013') - g('016') - g('017') - g('018')) - g('049');
  return marcheazaRezidual(R, rezid);
}

/** Ataseaza diferenta masurata, fara sa o faca parte din randurile formularului. */
function marcheazaRezidual(R, rezid) {
  Object.defineProperty(R, 'rezidual', { value: Math.round(Number(rezid) || 0), enumerable: false, configurable: true });
  return R;
}

/**
 * Verdictul asupra diferentei nemodificate dintre cele doua parti ale F10.
 */
function verificaRezidual(R) {
  const rezid = (R && R.rezidual) || 0;
  const marime = Math.abs(rezid);
  return {
    rezidual: rezid,
    prag: PRAG_REZIDUAL,
    ok: marime <= PRAG_REZIDUAL,
    mesaj: marime <= PRAG_REZIDUAL ? '' : 'Diferența Activ−Pasiv de ' + rezid + ' lei a rămas după alocarea '
      + 'automată de rotunjire. Validatorul ANAF cere egalitate exactă. Generarea XML este blocată; verifică raportul '
      + 'conturilor nemapate și metadatele înainte de depunere.',
  };
}

function aplicaAjustari(R, view, year, complet) {
  const report = R.mappingReport || newMappingReport(metadataState(view, year), year);
  const expectedSource = sourceHash(view, year); const scope = complet ? 'complet' : 'prescurtat';
  let previousHash = '';
  for (const row of ordered(adjustmentRows(view).filter((r) => String(r.year) === String(year)), 'approvedAt')) {
    const identity = row.approvedBy && (row.approvedBy.id != null || String(row.approvedBy.username || '').trim());
    const valid = row.form === 'F10' && /^[0-9a-f]{64}$/.test(String(row.hash || ''))
      && row.hash === hashRecord(row) && String(row.previousHash || '') === previousHash && !!identity;
    previousHash = String(row.hash || '');
    if (!valid) { report.adjustments.invalid.push({ id: row.id || null, row: row.row || null,
      reason: 'Ajustare cu aprobator, hash sau lanț invalid.' }); continue; }
    if (row.sourceHash !== expectedSource) { report.adjustments.stale.push({ id: row.id || null, row: row.row,
      reason: 'Ajustarea a fost aprobată pe o balanță sau mapare care s-a modificat.' }); continue; }
    if (row.scope !== scope) continue;
    const allowed = complet ? LINII_F10_COMPLET_ELEMENTARE : LINII_F10_PRESCURTAT_ELEMENTARE;
    if (!allowed.has(String(row.row)) || !Number.isInteger(Number(row.amount)) || !Number(row.amount)) {
      report.adjustments.invalid.push({ id: row.id || null, row: row.row || null,
        reason: 'Ajustarea vizează un total calculat sau nu este în lei întregi.' }); continue;
    }
    R[row.row] = round2((R[row.row] || 0) + Number(row.amount));
    report.adjustments.applied.push({ id: row.id, row: row.row, amount: Number(row.amount),
      reason: row.reason, approvedBy: row.approvedBy, approvedAt: row.approvedAt, hash: row.hash });
  }
  attachReport(R, report);
  return R;
}

/**
 * Randurile F10 pentru un an fiscal (incheiat la 31.12.`year`), in lei intregi.
 *
 * `rezultatNet` (optional) = rezultatul net al exercitiului, asa cum il raporteaza F20. Cand e dat,
 * randurile 043/044 se IAU DE ACOLO, nu se recalculeaza din solduri. Validatorul impune
 * `F10_043 = F20_069` / `F10_044 = F20_070`, iar doua calcule independente pe aceleasi date, fiecare
 * rotunjit la leu, diverg cu 1-2 lei — exact eroarea pe care o da ANAF. Contul de profit si pierdere
 * e AUTORITATEA asupra rezultatului; bilantul il preia. Orice diferenta ramane vizibila controlului.
 */
function f10At(db, year, rezultatNet) {
  const base = f10Base(finalBalances(db, String(year) + '-12'), { view: db, year });
  const raw = Object.fromEntries(Object.entries(base));
  for (const k of Object.keys(base)) base[k] = intLei(base[k]);
  if (rezultatNet != null) {
    const rez = intLei(rezultatNet);
    base['043'] = rez > 0 ? rez : 0;
    base['044'] = rez < 0 ? -rez : 0;
  }
  echilibreazaRotunjirea(base, raw, false);
  aplicaAjustari(base, db, year, false);
  return marcheazaDiferenta(f10Totals(base));
}

// ── F10 COMPLET (S1122, entitati mijlocii si mari) — 104 randuri ─────────────

/**
 * Bilantul COMPLET: aceleasi solduri, dar desfasurate pe randurile detaliate ale OMFP 1802/2014.
 * Diferenta fata de cel prescurtat e granularitatea, nu continutul — de aceea totalurile ies
 * identice, iar `f10CompletTotals` foloseste tot formulele validatorului.
 *
 * Relatiile AFILIATE/ASOCIATE se citesc din registrul anual de metadate. Lipsa confirmarii este
 * raportata si blocheaza XML-ul; nu mai este ascunsa prin trimiterea tuturor sumelor la randul general.
 */
function f10CompletBase(net, options) {
  const opts = options || {}; const state = metadataState(opts.view, opts.year);
  const report = newMappingReport(state, opts.year);
  const R = {};
  let currentCod = '';
  const add = (rand, val, source) => {
    R[rand] = round2((R[rand] || 0) + val);
    if (currentCod) report.mapped.push({ account: currentCod, name: coa.accountName(currentCod),
      value: round2(net[currentCod]), row: rand, allocatedValue: round2(val), source: source || 'standard' });
  };
  const unmapped = (cod, val, reason, metadata) => {
    const row = { year: String(opts.year || ''), account: cod, name: coa.accountName(cod), value: round2(val), reason };
    report.unmapped.push(row); if (metadata) report.missingMetadata.push(row);
  };
  let rezNeinchis = 0;

  for (const cod of Object.keys(net)) {
    currentCod = cod;
    const v = net[cod];
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v) < 0.005) continue;
    const cl = classOf(cod);
    if (cl === 6 || cl === 7) { rezNeinchis = round2(rezNeinchis - v); continue; }
    if (cl >= 8) continue;
    const meta = state.byAccount.get(String(cod));
    if (meta && meta.f10CompleteLine) { add(meta.f10CompleteLine, mappingValue(meta, v), 'metadata'); continue; }

    // ── A. IMOBILIZARI (clasa 2), nete de amortizari/ajustari ──
    if (cl === 2) {
      if (starts(cod, '201', '280 1', '2801')) { add('001', v); continue; }        // cheltuieli de constituire
      if (starts(cod, '203', '2803')) { add('002', v); continue; }                 // cheltuieli de dezvoltare
      if (starts(cod, '205', '208', '2805', '2808', '2905', '2908')) { add('003', v); continue; } // concesiuni, brevete, licente
      if (starts(cod, '206', '2806')) { add('004', v); continue; }                 // active necorporale de explorare
      if (starts(cod, '207', '2807', '2907')) { add('005', v); continue; }         // fond comercial
      if (starts(cod, '233', '4094')) { add('006', v); continue; }                 // imobilizari necorporale in curs / avansuri
      if (starts(cod, '211', '212', '2811', '2812', '2911', '2912')) { add('008', v); continue; } // terenuri si constructii
      if (starts(cod, '213', '2813', '2913')) { add('009', v); continue; }         // instalatii tehnice si masini
      if (starts(cod, '214', '2814', '2914')) { add('010', v); continue; }         // alte instalatii, utilaje si mobilier
      if (starts(cod, '215', '2815', '2915')) { add('011', v); continue; }         // investitii imobiliare
      if (starts(cod, '216', '2816')) { add('012', v); continue; }                 // active corporale de explorare
      if (starts(cod, '217', '2817')) { add('013', v); continue; }                 // active biologice productive
      if (starts(cod, '231', '2931')) { add('014', v); continue; }                 // imobilizari corporale in curs
      if (starts(cod, '235', '2935')) { add('015', v); continue; }                 // investitii imobiliare in curs
      if (starts(cod, '4093')) { add('016', v); continue; }                        // avansuri pentru imobilizari corporale
      if (starts(cod, '261', '2961')) { add('018', v); continue; }                 // actiuni detinute la filiale
      if (starts(cod, '2671', '2672')) { add('019', v); continue; }                // imprumuturi acordate entitatilor din grup
      if (starts(cod, '262', '263', '2962')) { add('020', v); continue; }          // actiuni la entitati asociate/controlate
      if (starts(cod, '2673', '2674')) { add('021', v); continue; }                // imprumuturi acordate entitatilor asociate
      if (starts(cod, '265', '2965')) { add('022', v); continue; }                 // alte investitii detinute ca imobilizari
      add('023', v); continue;                                                     // alte imprumuturi (2675-2679 etc.)
    }
    // ── B.I. STOCURI (clasa 3), nete de ajustari 39x ──
    if (cl === 3) {
      if (starts(cod, '30', '32', '390', '392')) { add('026', v); continue; }       // materii prime si materiale consumabile
      if (starts(cod, '33', '393')) { add('027', v); continue; }                    // productia in curs de executie
      add('028', v); continue;                                                      // produse finite si marfuri (34x-37x)
    }
    if (starts(cod, '4091')) { add('029', v); continue; }                            // avansuri pentru cumparari de stocuri
    // ── C. CHELTUIELI IN AVANS: separate numai pe baza scadentei/portiunii documentate. ──
    if (starts(cod, '471')) {
      if (v <= 0) { unmapped(cod, v, 'Soldul creditor al contului 471 cere o linie F10 explicită.', true); continue; }
      const split = maturitySplit(meta, Math.abs(v), opts.year);
      if (!split || split.invalid) { unmapped(cod, v, split && split.invalid
        ? 'Porțiunea curentă depășește soldul contului 471.'
        : 'Lipsesc scadența sau porțiunea curentă pentru contul 471.', true); continue; }
      if (split.current) add('043', split.current, 'maturity-metadata');
      if (split.noncurrent) add('044', split.noncurrent, 'maturity-metadata');
      continue;
    }
    // ── I. VENITURI IN AVANS ──
    if (starts(cod, '475')) { add('070', -v); continue; }                            // subventii pentru investitii
    if (starts(cod, '472')) { add('073', -v); continue; }                            // venituri inregistrate in avans
    if (starts(cod, '478')) { add('076', -v); continue; }                            // venituri in avans / active prin transfer

    // ── J. CAPITALURI PROPRII (clasa 1) ──
    if (cl === 1) {
      if (starts(cod, '1012')) { add('080', -v); continue; }
      if (starts(cod, '1011')) { add('081', -v); continue; }
      if (starts(cod, '1015')) { add('082', -v); continue; }
      if (starts(cod, '1018')) { add('083', -v); continue; }
      if (starts(cod, '1016')) { add('101', -v); continue; }                         // patrimoniul public
      if (starts(cod, '1017')) { add('102', -v); continue; }                         // patrimoniul privat
      if (starts(cod, '103')) { add('084', -v); continue; }
      if (starts(cod, '104')) { add('086', -v); continue; }                          // prime de capital
      if (starts(cod, '105')) { add('087', -v); continue; }                          // rezerve din reevaluare
      if (starts(cod, '1061')) { add('088', -v); continue; }                         // rezerve legale
      if (starts(cod, '1063')) { add('089', -v); continue; }                         // rezerve statutare
      if (starts(cod, '106')) { add('090', -v); continue; }                          // alte rezerve
      if (starts(cod, '109')) { add('092', v); continue; }                           // actiuni proprii (debitor)
      if (starts(cod, '141')) { add('093', -v); continue; }
      if (starts(cod, '149')) { add('094', v); continue; }
      if (starts(cod, '117')) { add(v <= 0 ? '095' : '096', Math.abs(v)); continue; } // reportat C / D
      if (starts(cod, '121')) { add(v <= 0 ? '097' : '098', Math.abs(v)); continue; } // exercitiu C / D
      if (starts(cod, '129')) { add('099', v); continue; }                            // repartizarea profitului
      if (starts(cod, '15')) { add(starts(cod, '1515') ? '066' : '067', -v); continue; } // provizioane
      if (starts(cod, '16')) {
        if (v >= 0) { unmapped(cod, v, 'Soldul debitor al unui cont din grupa 16 cere o linie F10 explicită.', true); continue; }
        const split = maturitySplit(meta, -v, opts.year);
        if (!split || split.invalid) { unmapped(cod, v, split && split.invalid
          ? 'Porțiunea curentă depășește soldul datoriei din grupa 16.'
          : 'Lipsesc scadența sau porțiunea curentă pentru datoria din grupa 16.', true); continue; }
        const currentRow = starts(cod, '161') ? '045' : starts(cod, '162') ? '046' : '052';
        const longRow = starts(cod, '161') ? '056' : starts(cod, '162', '166', '167', '168', '169') ? '057' : '063';
        if (split.current) add(currentRow, split.current, 'maturity-metadata');
        if (split.noncurrent) add(longRow, split.noncurrent, 'maturity-metadata');
        continue;
      }
      unmapped(cod, v, 'Cont de clasa 1 fără regulă sau linie F10 explicită.'); continue;
    }
    // ── AJUSTARILE PENTRU DEPRECIERE (49x) — rectificative de ACTIV, nu datorii (vezi f10Base) ──
    if (starts(cod, '491')) { add('031', v); continue; }          // ajustari de creante comerciale
    if (starts(cod, '495', '496')) { add('034', v); continue; }   // ajustari de alte creante
    // ── B.III. INVESTITII PE TERMEN SCURT (ajustarile 59x scad activul, indiferent de semn) ──
    if (starts(cod, '591')) { add('037', v); continue; }
    if (starts(cod, '59')) { add('038', v); continue; }
    if (starts(cod, '501')) { if (v >= 0) add('037', v); else add('052', -v); continue; }
    if (starts(cod, '50')) { if (v >= 0) add('038', v); else add('052', -v); continue; }
    // ── B.IV. CASA SI CONTURI LA BANCI; sold creditor = descoperit de cont (datorie curenta) ──
    if (starts(cod, '51', '52', '53', '54')) { if (v >= 0) add('040', v); else add('046', -v); continue; }
    // ── D. DATORII pana la un an / creante, dupa SEMN ──
    if (v > 0) {
      const split = (meta && (meta.currentPortion != null || meta.dueDate))
        ? maturitySplit(meta, v, opts.year) : null;
      if (split && split.invalid) { unmapped(cod, v, 'Porțiunea curentă depășește soldul creanței.', true); continue; }
      if (split && split.noncurrent) add('301', split.noncurrent, 'maturity-metadata');
      const current = split ? split.current : v;
      if (!current) continue;
      if (starts(cod, '411', '413', '418')) {
        if (!meta) report.missingMetadata.push({ year: String(opts.year || ''), account: cod, name: coa.accountName(cod), value: round2(v),
          reason: 'Afilierea creanței nu este confirmată pentru formularul F10 complet.' });
        add(meta && meta.affiliation === 'affiliate' ? '032' : meta && meta.affiliation === 'associate' ? '033' : '031', current,
          meta ? 'affiliation-metadata' : 'standard'); continue;
      }
      if (starts(cod, '456')) { add('035', current); continue; }                       // capital subscris si nevarsat
      add('034', current); continue;                                                   // alte creante
    }
    const s = -v;
    const split = (meta && (meta.currentPortion != null || meta.dueDate))
      ? maturitySplit(meta, s, opts.year) : { current: s, noncurrent: 0 };
    if (split && split.invalid) { unmapped(cod, v, 'Porțiunea curentă depășește soldul datoriei.', true); continue; }
    const affiliated = meta && meta.affiliation;
    if (starts(cod, '401', '403', '404', '405', '408', '419') && !meta) {
      report.missingMetadata.push({ year: String(opts.year || ''), account: cod, name: coa.accountName(cod), value: round2(v),
        reason: 'Afilierea datoriei nu este confirmată pentru formularul F10 complet.' });
    }
    if (split.noncurrent) {
      const longRow = affiliated === 'affiliate' ? '061' : affiliated === 'associate' ? '062'
        : starts(cod, '401', '404', '408') ? '059' : starts(cod, '403', '405') ? '060' : '063';
      add(longRow, split.noncurrent, 'maturity-metadata');
    }
    if (!split.current) continue;
    if (affiliated === 'affiliate') { add('050', split.current, 'affiliation-metadata'); continue; }
    if (affiliated === 'associate') { add('051', split.current, 'affiliation-metadata'); continue; }
    if (starts(cod, '419')) { add('047', split.current); continue; }                    // avansuri incasate in contul comenzilor
    if (starts(cod, '401', '404', '408')) { add('048', split.current); continue; }       // datorii comerciale — furnizori
    if (starts(cod, '403', '405')) { add('049', split.current); continue; }               // efecte de comert de platit
    if (cl === 4 || cl === 5) add('052', split.current);                                 // alte datorii (fiscale, sociale)
    else unmapped(cod, v, 'Cont fără regulă F10 completă și fără linie explicită în metadate.');
  }

  if (Math.abs(rezNeinchis) >= 0.005) {
    const net121 = round2((R['097'] || 0) - (R['098'] || 0) + rezNeinchis);
    R['097'] = net121 > 0 ? net121 : 0;
    R['098'] = net121 < 0 ? round2(-net121) : 0;
  }
  return attachReport(R, report);
}

/** Totalurile bilantului complet, cu formulele validatorului (nu prin insumare proprie). */
function f10CompletTotals(R) {
  const g = (k) => round2(R[k] || 0);
  const set = (k, val) => { R[k] = round2(val); };
  set('007', g('001') + g('002') + g('003') + g('004') + g('005') + g('006'));         // imob. necorporale
  set('017', g('008') + g('009') + g('010') + g('011') + g('012') + g('013') + g('014') + g('015') + g('016'));
  set('024', g('018') + g('019') + g('020') + g('021') + g('022') + g('023'));         // imob. financiare
  set('025', g('007') + g('017') + g('024'));                                          // A. ACTIVE IMOBILIZATE
  set('030', g('026') + g('027') + g('028') + g('029'));                               // stocuri
  set('036', g('031') + g('032') + g('033') + g('034') + g('035') + g('301'));         // creante
  set('039', g('037') + g('038'));                                                     // investitii pe termen scurt
  set('041', g('030') + g('036') + g('039') + g('040'));                               // B. ACTIVE CIRCULANTE
  set('042', g('043') + g('044'));                                                     // C. CHELTUIELI IN AVANS
  set('053', g('045') + g('046') + g('047') + g('048') + g('049') + g('050') + g('051') + g('052'));
  set('069', g('070') + g('071')); set('072', g('073') + g('074')); set('075', g('076') + g('077'));
  set('079', g('069') + g('072') + g('075') + g('078'));                               // I. VENITURI IN AVANS
  set('054', g('041') + g('043') - g('053') - g('070') - g('073') - g('076'));         // E. active circ. nete
  set('055', g('025') + g('044') + g('054'));                                          // F. total active minus datorii curente
  set('064', g('056') + g('057') + g('058') + g('059') + g('060') + g('061') + g('062') + g('063'));
  set('068', g('065') + g('066') + g('067'));                                          // H. PROVIZIOANE
  set('085', g('080') + g('081') + g('082') + g('083') + g('084'));                    // capital
  set('091', g('088') + g('089') + g('090'));                                          // rezerve
  set('100', g('085') + g('086') + g('087') + g('091') - g('092') + g('093') - g('094')
    + g('095') - g('096') + g('097') - g('098') - g('099'));                           // capitaluri proprii
  set('103', g('100') + g('101') + g('102'));                                          // CAPITALURI — TOTAL
  return R;
}

// Validatorul ANAF cere egalitate EXACTĂ în lei întregi, nu acceptă toleranța contabilă de un
// leu. Rotunjirea independentă a rândurilor elementare poate lăsa însă ±1 leu chiar când balanța
// în bani este perfect echilibrată (de exemplu, 15.366,65 active și 20.127,50 datorii). Distribuim
// exclusiv acel reziduu de rotunjire pe rândul elementar care se îndepărtează cel mai puțin de
// valoarea sa în bani; rezultatul F20 și 117 rămân neatinse. Alegerea și suma rămân vizibile în
// raportul de mapare, ca XML-ul valid să nu ascundă proveniența leului alocat.
const LEAFS_PRESCURTAT = [
  ...['001', '002', '003', '005', '301', '302', '007', '008', '011', '012'].map((row) => ({ row, sign: 1 })),
  ...['013', '016', '017', '020', '021', '023', '024', '026', '027', '028'].map((row) => ({ row, sign: -1 })),
];
const LEAFS_COMPLET = [
  ...['001', '002', '003', '004', '005', '006',
    '008', '009', '010', '011', '012', '013', '014', '015', '016',
    '018', '019', '020', '021', '022', '023',
    '026', '027', '028', '029', '031', '032', '033', '034', '035', '301', '037', '038', '040',
    '043', '044'].map((row) => ({ row, sign: 1 })),
  ...['045', '046', '047', '048', '049', '050', '051', '052',
    '056', '057', '058', '059', '060', '061', '062', '063',
    '065', '066', '067', '070', '071', '073', '074', '076', '077', '078'].map((row) => ({ row, sign: -1 })),
];

function identityResidual(R, complet) {
  const g = (k) => Number(R[k]) || 0;
  return complet
    ? g('025') + g('041') + g('042') - g('053') - g('064') - g('068') - g('079') - g('103')
    : g('004') + g('009') + g('010') - g('013') - g('016') - g('017') - g('018') - g('049');
}

function echilibreazaRotunjirea(R, raw, complet) {
  const totals = complet ? f10CompletTotals : f10Totals;
  totals(R);
  const before = identityResidual(R, complet);
  if (!Number.isInteger(before) || before === 0 || Math.abs(before) > TOLERANTA_ROTUNJIRE_LEI) return R;
  const candidates = (complet ? LEAFS_COMPLET : LEAFS_PRESCURTAT).map(({ row, sign }, order) => {
    const exact = Number(raw[row]) || 0;
    if (Math.abs(exact) < 0.005) return null; // nu inventăm un rând care nu exista în balanță
    const current = Number(R[row]) || 0;
    const amount = -before / sign;
    const next = current + amount;
    if ((exact > 0 && next < 0) || (exact < 0 && next > 0)) return null;
    const cost = Math.abs(next - exact) - Math.abs(current - exact);
    return { row, amount, next, cost, magnitude: Math.abs(exact), order };
  }).filter(Boolean).sort((a, b) => a.cost - b.cost || b.magnitude - a.magnitude || a.order - b.order);
  const chosen = candidates[0];
  if (!chosen) return R;
  R[chosen.row] = chosen.next;
  totals(R);
  const after = identityResidual(R, complet);
  if (after !== 0) { R[chosen.row] -= chosen.amount; totals(R); return R; }
  const report = R.mappingReport;
  if (report) report.roundingAdjustments.push({
    row: chosen.row, amount: chosen.amount, residualBefore: before, residualAfter: after,
    reason: 'Alocare deterministă a diferenței de rotunjire la leu întreg cerută de validatorul ANAF.',
  });
  return R;
}

/** Diferenta F10 complet, masurata fara a modifica rezultatul reportat sau alt rand. */
function marcheazaDiferentaComplet(R) {
  const g = (k) => R[k] || 0;
  const rezid = (g('025') + g('041') + g('042') - g('053') - g('064') - g('068') - g('079')) - g('103');
  return marcheazaRezidual(R, rezid);
}

/** Randurile F10 COMPLET pentru un an fiscal, in lei intregi. */
function f10CompletAt(db, year, rezultatNet) {
  const base = f10CompletBase(finalBalances(db, String(year) + '-12'), { view: db, year });
  const raw = Object.fromEntries(Object.entries(base));
  for (const k of Object.keys(base)) base[k] = intLei(base[k]);
  if (rezultatNet != null) {
    const rez = intLei(rezultatNet);
    base['097'] = rez > 0 ? rez : 0;
    base['098'] = rez < 0 ? -rez : 0;
  }
  echilibreazaRotunjirea(base, raw, true);
  aplicaAjustari(base, db, year, true);
  return marcheazaDiferentaComplet(f10CompletTotals(base));
}

// ── F20: CONTUL DE PROFIT SI PIERDERE ────────────────────────────────────────

/** Rulajele claselor 6/7 pentru un an, pe cod de cont (fara inchiderile 6/7 -> 121). */
function plAcc(db, year) {
  const ent = postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
  return accumulate(resultLines(ent));
}

function aplicaDetaliiF20(R, db, year, allowed) {
  const acc = plAcc(db, year); const state = metadataState(db, year); const applied = [];
  for (const [account, meta] of state.byAccount) {
    if (!meta.f20DetailLine || !allowed.has(meta.f20DetailLine) || !acc[account]) continue;
    const value = intLei(Math.abs(round2((acc[account].c || 0) - (acc[account].d || 0))));
    if (!value) continue;
    R[meta.f20DetailLine] = intLei((R[meta.f20DetailLine] || 0) + value);
    applied.push({ account, name: coa.accountName(account), row: meta.f20DetailLine, value,
      metadataHash: meta.hash });
  }
  Object.defineProperty(R, 'detailReport', { value: { applied, invalidMetadata: state.invalid.slice() },
    enumerable: false, configurable: true });
  return R;
}

/**
 * F20 PRESCURTAT (microentitati, S1120) — 9 randuri de fond + 5 randuri „din care".
 * Structura oficiala:
 *   001 Cifra de afaceri neta            005 Ajustari de valoare
 *   002 Alte venituri                    006 Alte cheltuieli
 *   003 Costul materiilor prime          007 Impozitul pe profit/venit
 *   004 Cheltuieli cu personalul         008 Profit net / 009 Pierdere neta
 * Randurile 301-305 sunt detalii „din care" si se completeaza numai cand registrul anual indica
 * explicit linia F20 a contului; altfel raman zero.
 */
function f20Micro(db, year) {
  const acc = plAcc(db, year);
  const codes = Object.keys(acc);
  const venit = (c) => round2(acc[c] ? acc[c].c - acc[c].d : 0);
  const chelt = (c) => round2(acc[c] ? acc[c].d - acc[c].c : 0);
  const sv = (p) => round2(codes.filter(p).reduce((s, c) => s + venit(c), 0));
  const sc = (p) => round2(codes.filter(p).reduce((s, c) => s + chelt(c), 0));

  const R = {};
  R['001'] = sv((c) => starts(c, '70'));                                   // cifra de afaceri neta (70x, net de 709)
  const venitTot = sv((c) => classOf(c) === 7);
  R['002'] = round2(venitTot - R['001']);                                  // alte venituri (rest clasa 7, inclusiv financiare)
  R['003'] = sc((c) => starts(c, '60'));                                   // materii prime, materiale, marfuri, utilitati
  R['004'] = sc((c) => starts(c, '64'));                                   // cheltuieli cu personalul
  R['005'] = sc((c) => starts(c, '68'));                                   // ajustari de valoare (amortizari + ajustari)
  R['007'] = sc((c) => starts(c, '691', '698'));                           // impozit pe profit / pe venit
  const cheltTot = sc((c) => classOf(c) === 6);
  R['006'] = round2(cheltTot - R['003'] - R['004'] - R['005'] - R['007']);  // alte cheltuieli (rezidual => total garantat)
  for (const d of ['301', '302', '303', '304', '305']) R[d] = 0;
  aplicaDetaliiF20(R, db, year, new Set(['301', '302', '303', '305']));
  // lei intregi INAINTE de rezultat, ca F20_008/009 sa fie exact suma randurilor rotunjite
  for (const k of Object.keys(R)) R[k] = intLei(R[k]);

  // Rezultatul, exact cu formula validatorului (F20_008 / F20_009)
  const rez = round2(R['001'] + R['002'] - R['003'] - R['004'] - R['005'] - R['006'] - R['007'] + R['304']);
  R['008'] = rez > 0 ? rez : 0;
  R['009'] = rez < 0 ? round2(-rez) : 0;
  return R;
}

/**
 * F20 COMPLET (entitati mici, S1121) — 70 de randuri de fond + 18 „din care"/speciale.
 *
 * Disciplina care garanteaza corectitudinea: randurile de DETALIU se mapeaza explicit pe conturi,
 * iar cate un rand pe fiecare sectiune e REZIDUAL (013 alte venituri din exploatare, 037 alte
 * cheltuieli, 050 alte venituri financiare, 058 alte cheltuieli financiare). Asa, totalurile
 * 016/042/052/059 egaleaza EXACT rulajul claselor 6 si 7 — un cont pe care nu l-am prevazut
 * nominal nu dispare din formular, ci aterizeaza in rezidualul sectiunii lui.
 *
 * Randurile „din care" care nu participa la formule se completeaza din metadatele explicite ale
 * contului. Liniile care schimba formulele nu accepta un override generic.
 */
function f20Complet(db, year) {
  const acc = plAcc(db, year);
  const codes = Object.keys(acc);
  const venit = (c) => round2(acc[c] ? acc[c].c - acc[c].d : 0);
  const chelt = (c) => round2(acc[c] ? acc[c].d - acc[c].c : 0);
  const sv = (p) => round2(codes.filter(p).reduce((s, c) => s + venit(c), 0));
  const sc = (p) => round2(codes.filter(p).reduce((s, c) => s + chelt(c), 0));

  const R = {};
  for (let i = 1; i <= 70; i++) R[String(i).padStart(3, '0')] = 0;
  for (const d of ['301', '302', '303', '304', '305', '306', '307', '308', '309', '310',
    '311', '312', '313', '314', '315', '316', '317', '318']) R[d] = 0;

  // Ce e „financiar" (si deci NU intra in exploatare): 76x + 786 la venituri, 66x + 686 la
  // cheltuieli. Exceptie: 7418 (subventii pentru dobanda) e cont de clasa 74, dar formularul il
  // cere pe randul 049, INAUNTRUL veniturilor financiare — deci se scoate din exploatare.
  const eVenitFin = (c) => starts(c, '76', '786', '7418');
  const eCheltFin = (c) => starts(c, '66', '686');
  const eImpozit = (c) => starts(c, '691', '698');

  // ── VENITURI DIN EXPLOATARE ──
  R['002'] = sv((c) => starts(c, '701', '702', '703', '704', '705', '706', '708')); // productia vanduta
  R['003'] = sv((c) => starts(c, '707'));                       // venituri din vanzarea marfurilor
  R['004'] = round2(-sv((c) => starts(c, '709')));              // reduceri comerciale acordate (sold debitor)
  R['006'] = sv((c) => starts(c, '7411'));                      // subventii aferente cifrei de afaceri
  R['001'] = round2(R['002'] + R['003'] - R['004'] + R['005'] + R['006']);
  const varStoc = sv((c) => starts(c, '711', '712'));           // variatia stocurilor: C = venit, D = cost
  R['007'] = varStoc > 0 ? varStoc : 0;
  R['008'] = varStoc < 0 ? round2(-varStoc) : 0;
  R['009'] = sv((c) => starts(c, '721', '722'));                // productia de imobilizari
  R['010'] = sv((c) => starts(c, '755'));                       // reevaluarea imobilizarilor corporale
  R['011'] = sv((c) => starts(c, '725'));                       // productia de investitii imobiliare
  R['012'] = sv((c) => starts(c, '741') && !starts(c, '7411', '7418')); // alte subventii de exploatare
  const venitExplTot = sv((c) => classOf(c) === 7 && !eVenitFin(c));
  // rezidual: tot ce n-a fost prins nominal (758, 7815, 7588…) ramane „alte venituri din exploatare"
  R['013'] = round2(venitExplTot - R['001'] - varStoc - R['009'] - R['010'] - R['011'] - R['012']);
  R['016'] = round2(R['001'] + R['007'] - R['008'] + R['009'] + R['010'] + R['011'] + R['012'] + R['013']);

  // ── CHELTUIELI DE EXPLOATARE ──
  R['017'] = sc((c) => starts(c, '601', '602'));                // materii prime si materiale consumabile
  R['018'] = sc((c) => starts(c, '603', '604', '606', '608'));  // alte cheltuieli materiale
  R['019'] = sc((c) => starts(c, '605'));                       // energie si apa
  R['020'] = sc((c) => starts(c, '607'));                       // cheltuieli privind marfurile
  R['021'] = round2(-sc((c) => starts(c, '609')));              // reduceri comerciale primite (sold creditor)
  R['023'] = sc((c) => starts(c, '641', '642', '643', '644'));  // salarii si indemnizatii
  R['024'] = sc((c) => starts(c, '645', '646'));                // asigurari si protectie sociala
  R['022'] = round2(R['023'] + R['024']);
  R['026'] = sc((c) => starts(c, '6811', '6813'));              // ajustari imobilizari — cheltuieli
  R['027'] = sv((c) => starts(c, '7813'));                      // ajustari imobilizari — venituri
  R['025'] = round2(R['306'] + R['026'] - R['027']);
  R['029'] = sc((c) => starts(c, '6814'));                      // ajustari active circulante — cheltuieli
  R['030'] = sv((c) => starts(c, '7814'));                      // ajustari active circulante — venituri
  R['028'] = round2(R['029'] - R['030']);
  R['040'] = sc((c) => starts(c, '6812'));                      // provizioane — cheltuieli
  R['041'] = sv((c) => starts(c, '7812'));                      // provizioane — venituri
  R['039'] = round2(R['040'] - R['041']);
  R['032'] = sc((c) => /^6(1|2)/.test(String(c)));              // prestatii externe (61x + 62x)
  R['033'] = sc((c) => starts(c, '635'));                       // alte impozite, taxe si varsaminte
  R['034'] = sc((c) => starts(c, '652'));                       // protectia mediului
  R['035'] = sc((c) => starts(c, '655'));                       // cheltuieli din reevaluare
  R['036'] = sc((c) => starts(c, '6587'));                      // calamitati si evenimente similare
  const cheltExplTot = sc((c) => classOf(c) === 6 && !eCheltFin(c) && !eImpozit(c));
  // rezidual „alte cheltuieli": diferenta pana la totalul real al exploatarii
  R['037'] = round2(cheltExplTot - R['017'] - R['018'] - R['019'] - R['020'] + R['021']
    - R['022'] - R['026'] - R['029'] - R['040']
    - R['032'] - R['033'] - R['034'] - R['035'] - R['036']);
  R['031'] = round2(R['032'] + R['033'] + R['034'] + R['035'] + R['036'] + R['037'] + R['038']
    + R['310'] + R['312'] + R['314'] + R['316']);
  R['042'] = round2(R['017'] + R['018'] + R['019'] + R['020'] - R['021'] + R['022']
    + R['025'] + R['028'] + R['031'] + R['039']);

  // ── FINANCIAR ──
  R['045'] = sv((c) => starts(c, '761'));                       // interese de participare
  R['047'] = sv((c) => starts(c, '766'));                       // venituri din dobanzi
  R['049'] = sv((c) => starts(c, '7418'));                      // subventii pentru dobanda datorata
  const venitFinTot = sv(eVenitFin);
  R['050'] = round2(venitFinTot - R['045'] - R['047'] - R['049']); // rezidual: alte venituri financiare
  R['052'] = round2(R['045'] + R['047'] + R['049'] + R['050']);
  R['054'] = sc((c) => starts(c, '686'));                       // ajustari imobilizari financiare — cheltuieli
  R['055'] = sv((c) => starts(c, '786'));                       // ...si venituri
  R['053'] = round2(R['054'] - R['055']);
  R['056'] = sc((c) => starts(c, '666'));                       // cheltuieli privind dobanzile
  const cheltFinTot = sc(eCheltFin);
  R['058'] = round2(cheltFinTot - R['054'] - R['056']);          // rezidual: alte cheltuieli financiare
  R['059'] = round2(R['053'] + R['056'] + R['058']);

  // ── TOTALURI, impozit, rezultat ──
  R['062'] = round2(R['016'] + R['052']);
  R['063'] = round2(R['042'] + R['059']);
  R['066'] = sc((c) => starts(c, '691'));                       // impozitul pe profit
  R['068'] = sc((c) => starts(c, '698'));                       // alte impozite (inclusiv impozitul micro)

  aplicaDetaliiF20(R, db, year, LINII_F20_DIN_CARE_SIGURE);

  // lei intregi pe randurile elementare, INAINTE de rezultat (acelasi motiv ca la F10)
  for (const k of Object.keys(R)) R[k] = intLei(R[k]);
  // ...si recompunem agregatele din valorile rotunjite, cu formulele validatorului
  R['001'] = R['002'] + R['003'] - R['004'] + R['005'] + R['006'];
  R['016'] = R['001'] + R['007'] - R['008'] + R['009'] + R['010'] + R['011'] + R['012'] + R['013'];
  R['022'] = R['023'] + R['024'];
  R['025'] = R['306'] + R['026'] - R['027'];
  R['028'] = R['029'] - R['030'];
  R['039'] = R['040'] - R['041'];
  R['031'] = R['032'] + R['033'] + R['034'] + R['035'] + R['036'] + R['037'] + R['038']
    + R['310'] + R['312'] + R['314'] + R['316'];
  R['042'] = R['017'] + R['018'] + R['019'] + R['020'] - R['021'] + R['022']
    + R['025'] + R['028'] + R['031'] + R['039'];
  R['053'] = R['054'] - R['055'];
  R['052'] = R['045'] + R['047'] + R['049'] + R['050'];
  R['059'] = R['053'] + R['056'] + R['058'];
  R['062'] = R['016'] + R['052'];
  R['063'] = R['042'] + R['059'];

  const rezExpl = R['016'] - R['042'];
  R['043'] = rezExpl > 0 ? rezExpl : 0;
  R['044'] = rezExpl <= 0 ? -rezExpl : 0;
  const rezFin = R['052'] - R['059'];
  R['060'] = rezFin > 0 ? rezFin : 0;
  R['061'] = rezFin <= 0 ? -rezFin : 0;
  const rezBrut = R['062'] - R['063'];
  R['064'] = rezBrut > 0 ? rezBrut : 0;
  R['065'] = rezBrut <= 0 ? -rezBrut : 0;
  // rezultatul net, exact cu formulele F20_069 / F20_070
  const net = R['064'] - R['065'] - R['066'] - R['068'] - R['304'] - R['317'] + R['305'];
  R['069'] = net > 0 ? net : 0;
  R['070'] = net < 0 ? -net : 0;
  return R;
}

// ── ANTETUL formularului ─────────────────────────────────────────────────────

const nom = require('./bilantNomenclator');

/** Codurile de formular, dupa categoria de entitate. */
const FORMULARE = {
  micro: { cod: 'S1120', radacina: 'Bilant1120', ns: 's1120', tipBIL: 'UU' },
  mic: { cod: 'S1121', radacina: 'Bilant1121', ns: 's1121', tipBIL: 'BS' },
  mare: { cod: 'S1122', radacina: 'Bilant1122', ns: 's1122', tipBIL: 'BL' },
};

/**
 * Antetul, din datele firmei. Intoarce `{ attrs, lipsa }`:
 *  - `attrs` = perechile pentru XML (valorile ABSENTE nu se pun deloc — un atribut gol
 *    NU e neutru pentru validator, il respinge);
 *  - `lipsa` = lista campurilor obligatorii necompletate, in limbaj de utilizator.
 *
 * NU inventam valori implicite pentru identificare (judet, forma de proprietate, administrator,
 * intocmitor): un antet plauzibil dar gresit trece validatorul si ajunge la ANAF ca declaratie
 * gresita. Mai bine refuzam generarea si spunem ce lipseste.
 */
function antet(firma, year, categorie, totalCapital) {
  const f = firma || {};
  const F = FORMULARE[categorie] || FORMULARE.micro;
  const lipsa = [];
  const cer = (val, eticheta) => { if (val == null || String(val).trim() === '') lipsa.push(eticheta); return val; };

  const codJJ = nom.codJudet(f.judet);
  if (!codJJ) lipsa.push('judetul firmei (nu se poate deduce codul ANAF din „' + (f.judet || '') + '")');
  // codTT e tot un cod de judet, independent de codJJ in schema; implicit e acelasi judet
  // (administratia fiscala a firmei e, in mod normal, in judetul ei).
  const codTT = String(f.codTeritorial || codJJ || '');
  if (codTT && !nom.COD_JUDET.has(codTT)) lipsa.push('codul teritorial (valoare in afara nomenclatorului)');

  const forma = String(f.formaProprietate || '');
  if (!forma) lipsa.push('forma de proprietate');
  else if (!nom.COD_FORMA.has(forma)) lipsa.push('forma de proprietate (valoare in afara nomenclatorului)');

  const calit = String(f.intocmitCalitate || '');
  if (!calit) lipsa.push('calitatea celui care intocmeste situatiile');
  else if (!nom.COD_CALITATE.has(calit)) lipsa.push('calitatea (valoare in afara nomenclatorului)');

  const audit = String(f.auditStatut || '3'); // implicit: neauditat — cazul obisnuit la micro/mici
  if (!nom.COD_AUDIT.has(audit)) lipsa.push('statutul de audit (valoare in afara nomenclatorului)');

  cer(f.nume, 'denumirea firmei');
  cer(f.cui, 'CUI-ul');
  cer(f.adresa, 'adresa');
  cer(f.telefon, 'telefonul');
  cer(f.caen, 'codul CAEN');
  cer(f.administrator, 'numele administratorului');
  cer(f.intocmitNume, 'numele persoanei care intocmeste situatiile');

  const y = String(year);
  const attrs = {
    luna: '12', an: y, an_i: y,
    // CUI-ul se raporteaza fara prefixul „RO" si fara separatori
    cui: String(f.cui || '').replace(/[^0-9]/g, ''),
    den: f.nume || '', adresa: f.adresa || '', telefon: String(f.telefon || ''),
    caen: String(f.caen || ''), caenE: String(f.caenE || f.caen || ''),
    bifaMC: '0', tipBIL: F.tipBIL, interes_public: '0',
    codTT, codJJ: codJJ || '', codPP: forma,
    nume_admin: f.administrator || '',
    nume_intocmit: f.intocmitNume || '', calit_intocmit: calit,
    totalPlata_A: String(Math.round(totalCapital || 0)),
    // exercitiu financiar NEMODIFICAT: 01.01 - 31.12, trimestrul 4
    data_I: '01.01.' + y, data_S: '31.12.' + y, d_trim: '4', d_modif: '0',
    d_audit: audit, bifaGG: '0', bifaAA: '0',
  };

  // R26: numarul din Registrul CECCAR e obligatoriu la calitatile 21/22 si INTERZIS la restul.
  if (nom.CALITATI_CU_NR.has(calit)) {
    if (!String(f.intocmitNr || '').trim()) lipsa.push('numarul din Registrul CECCAR (obligatoriu pentru calitatea aleasa)');
    else attrs.nri_intocmit = String(f.intocmitNr).trim();
  }
  // d_audit=3 (neauditat): denumirea e ceruta, dar numarul si CIF-ul auditorului trebuie sa LIPSEASCA.
  attrs.den_audi = String(f.auditorNume || '').trim() || 'NEAUDITAT';
  if (audit !== '3') {
    if (String(f.auditorNr || '').trim()) attrs.nr_audi = String(f.auditorNr).trim();
    if (String(f.auditorCif || '').trim()) attrs.cif_audi = String(f.auditorCif).trim();
  }
  return { attrs, lipsa, formular: F };
}

// ── Listele de campuri cerute de schema ──────────────────────────────────────
// Numele atributelor sunt `<formular>_<rand><coloana>`; coloana 1 = inceputul exercitiului,
// 2 = sfarsitul. Numarul lor e VERIFICAT in teste fata de schema reala (51/14/88 de randuri) —
// un rand lipsa ar da un formular pe care ANAF il asteapta completat si nu l-ar gasi.
const interval = (de, la) => Array.from({ length: la - de + 1 }, (_, i) => String(de + i).padStart(3, '0'));
const campuri = (prefix, randuri) => randuri.flatMap((r) => [prefix + '_' + r + '1', prefix + '_' + r + '2']);

const RANDURI_F10 = [...interval(1, 49), '301', '302'];                  // 51 (prescurtat)
const RANDURI_F10_COMPLET = [...interval(1, 103), '301'];                // 104 (S1122)
const RANDURI_F20_MICRO = [...interval(1, 9), ...interval(301, 305)];    // 14
const RANDURI_F20_COMPLET = [...interval(1, 70), ...interval(301, 318)]; // 88

const CAMPURI_F10 = campuri('F10', RANDURI_F10);
const CAMPURI_F10_COMPLET = campuri('F10', RANDURI_F10_COMPLET);
const CAMPURI_F20_MICRO = campuri('F20', RANDURI_F20_MICRO);
const CAMPURI_F20_COMPLET = campuri('F20', RANDURI_F20_COMPLET);

function reconciliereAn(view, year, f10, f20, bilComplet, f20CompletFlag) {
  const map = f10.mappingReport || newMappingReport(metadataState(view, year), year);
  const balanta = trialBalance(view, String(year) + '-12');
  const residual = verificaRezidual(f10);
  const f10Result = bilComplet ? (f10['097'] || 0) - (f10['098'] || 0)
    : (f10['043'] || 0) - (f10['044'] || 0);
  const f20Result = f20CompletFlag ? (f20['069'] || 0) - (f20['070'] || 0)
    : (f20['008'] || 0) - (f20['009'] || 0);
  const adjustmentProblems = [...map.adjustments.invalid, ...map.adjustments.stale];
  const controls = {
    balanta: {
      ok: balanta.balanced === true, totalDebit: balanta.tot.sfD, totalCredit: balanta.tot.sfC,
      difference: round2(balanta.tot.sfD - balanta.tot.sfC),
    },
    f10Balanta: {
      ok: residual.ok, difference: residual.rezidual, tolerance: residual.prag,
      // Acoperirea este verificata cont-cu-cont, nu numai prin egalitatea totalurilor.
      mappedAccounts: new Set(map.mapped.map((x) => x.account)).size,
      unmappedAccounts: map.unmapped.length,
    },
    f10F20: { ok: f10Result === f20Result, f10Result, f20Result,
      difference: round2(f10Result - f20Result) },
    mapping: { ok: map.unmapped.length === 0 && map.missingMetadata.length === 0
      && map.invalidMetadata.length === 0, unmapped: map.unmapped,
      missingMetadata: map.missingMetadata, invalidMetadata: map.invalidMetadata },
    adjustments: { ok: adjustmentProblems.length === 0, applied: map.adjustments.applied,
      invalid: map.adjustments.invalid, stale: map.adjustments.stale },
  };
  controls.ok = controls.balanta.ok && controls.f10Balanta.ok && controls.f10F20.ok
    && controls.mapping.ok && controls.adjustments.ok;
  return controls;
}

/**
 * Situatiile financiare anuale complete pentru un an, gata de serializat.
 * `categorie`: 'micro' (S1120) sau 'mic' (S1121). Intoarce si `lipsa` — campurile de antet
 * necompletate; cine cheama decide daca refuza generarea (ruta o face).
 */
function situatii(view, firma, year, categorie) {
  const cat = ['mic', 'mare'].includes(categorie) ? categorie : 'micro';
  const complet = cat !== 'micro';                 // F20 complet la 'mic' SI la 'mare' (identice)
  const bilComplet = cat === 'mare';               // F10 complet doar la 'mare'
  const f20fn = complet ? f20Complet : f20Micro;
  const randProfit = complet ? '069' : '008';
  const randPierdere = complet ? '070' : '009';

  const f20cur = f20fn(view, year);
  const f20pre = f20fn(view, Number(year) - 1);
  const rez = (r) => r[randProfit] - r[randPierdere];
  // rezultatul din F20 e AUTORITATEA; bilantul il preia (vezi f10At / f10CompletAt)
  const f10fn = bilComplet ? f10CompletAt : f10At;
  const f10cur = f10fn(view, year, rez(f20cur));
  const f10pre = f10fn(view, Number(year) - 1, rez(f20pre));

  // suma de control (totalPlata_A) = randul de CAPITAL: 029 la prescurtat, 085 la complet
  const a = antet(firma, year, cat, f10cur[bilComplet ? '085' : '029']);
  // Diferenta ramane nemodificata si este reconciliata cu balanta si F20, pe fiecare exercitiu.
  const rezidCur = verificaRezidual(f10cur);
  const rezidPre = verificaRezidual(f10pre);
  const avertismente = [];
  if (!rezidCur.ok) avertismente.push('Exercițiul ' + year + ': ' + rezidCur.mesaj);
  if (!rezidPre.ok) avertismente.push('Exercițiul ' + (Number(year) - 1) + ': ' + rezidPre.mesaj);
  const controlCur = reconciliereAn(view, year, f10cur, f20cur, bilComplet, complet);
  const controlPre = reconciliereAn(view, Number(year) - 1, f10pre, f20pre, bilComplet, complet);
  const blocaje = [];
  for (const [label, control] of [[String(year), controlCur], [String(Number(year) - 1), controlPre]]) {
    if (!control.balanta.ok) blocaje.push('Exercițiul ' + label + ': balanța de verificare nu are cele patru egalități.');
    if (!control.f10Balanta.ok) blocaje.push('Exercițiul ' + label + ': diferența F10 față de balanță este '
      + control.f10Balanta.difference + ' lei (toleranță ' + control.f10Balanta.tolerance + ' leu).');
    if (!control.f10F20.ok) blocaje.push('Exercițiul ' + label + ': rezultatul F10 diferă de F20 cu '
      + control.f10F20.difference + ' lei.');
    if (!control.mapping.ok) blocaje.push('Exercițiul ' + label + ': există '
      + control.mapping.unmapped.length + ' conturi nemapate, ' + control.mapping.missingMetadata.length
      + ' metadate obligatorii lipsă și ' + control.mapping.invalidMetadata.length + ' metadate cu hash invalid.');
    if (!control.adjustments.ok) blocaje.push('Exercițiul ' + label + ': registrul ajustărilor conține '
      + control.adjustments.invalid.length + ' înregistrări invalide și ' + control.adjustments.stale.length + ' aprobări expirate.');
  }
  return {
    antet: a, lipsa: a.lipsa, categorie: cat,
    rezidual: { curent: rezidCur, precedent: rezidPre }, avertismente, blocaje,
    reconciliere: { curent: controlCur, precedent: controlPre,
      ok: controlCur.ok && controlPre.ok },
    raportMapare: {
      curent: f10cur.mappingReport || null, precedent: f10pre.mappingReport || null,
      conturiNemapate: [...(f10cur.mappingReport && f10cur.mappingReport.unmapped || []),
        ...(f10pre.mappingReport && f10pre.mappingReport.unmapped || [])],
    },
    f10: { 1: f10pre, 2: f10cur },
    f20: { 1: f20pre, 2: f20cur },
    randuriF10: bilComplet ? CAMPURI_F10_COMPLET : CAMPURI_F10,
    randuriF20: complet ? CAMPURI_F20_COMPLET : CAMPURI_F20_MICRO,
  };
}

module.exports = {
  f10Base, f10Totals, f10At, f10CompletBase, f10CompletTotals, f10CompletAt,
  f20Micro, f20Complet, plAcc, antet, situatii, verificaRezidual,
  metadataState, metadataRecord, adjustmentRecord, sourceHash,
  PRAG_REZIDUAL, TOLERANTA_ROTUNJIRE_LEI, FORMULARE,
  RANDURI_F10, RANDURI_F10_COMPLET, RANDURI_F20_MICRO, RANDURI_F20_COMPLET,
  CAMPURI_F10, CAMPURI_F10_COMPLET, CAMPURI_F20_MICRO, CAMPURI_F20_COMPLET,
};
