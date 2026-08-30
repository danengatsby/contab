'use strict';

// Eligibilitatea pentru impozitul pe veniturile microintreprinderilor NU se poate deduce din
// soldul clasei 7 sau din existenta unui rand in nomenclatorul de angajati. Din 2026, art. 47,
// 48, 51, 52 si 54 (astfel cum au fost modificate prin OUG 8/2026) cer:
//   - cifra de afaceri definita de reglementarile contabile, nu toate veniturile clasei 7;
//   - cumularea cu cifra de afaceri/veniturile persoanelor legate;
//   - o norma intreaga (inclusiv fractiuni cumulate) SAU un mandat remunerat cel putin la minim;
//   - reguli datate pentru suspendari, concedii medicale, inlocuire si firme nou-infiintate.
//
// Modulul este pur. Registrul versionat este persistat de microEligibilityService, iar acelasi
// verdict este consumat de controlul fiscal, D100, D101 si portile de depunere.

const acc = require('./accounting');
const bnr = require('./bnr');
const fiscal = require('./fiscal');
const fiscalProfile = require('./fiscalProfile');
const { round2, validIsoDate, naturalCompare } = require('./util');

const RELATIONS = new Set(['ownership', 'voting', 'control', 'common_control', 'management', 'family_economic']);
const ENTITY_KINDS = new Set(['company', 'pfa_actual', 'pfa_norm']);
const WORKFORCE_KINDS = new Set(['employment', 'mandate']);
const SUSPENSION_KINDS = new Set(['medical', 'other']);
const ASSET_KINDS = new Set(['fixed_asset', 'land']);
const DAY = 86400000;

function fail(message) { const e = new Error(message); e.status = 400; throw e; }
function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function number(value, label, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fail(label + ' trebuie sa fie intre ' + min + ' si ' + max + '.');
  return round2(n);
}
function date(value, label, optional) {
  const out = String(value || '');
  if (!out && optional) return '';
  if (!validIsoDate(out)) fail(label + ' trebuie sa fie o data valida (YYYY-MM-DD).');
  return out;
}
function interval(from, to, label) {
  if (to && to < from) fail(label + ': data de sfarsit nu poate fi anterioara datei de inceput.');
}
function id(value, prefix, index) {
  const out = text(value, 80) || (prefix + '-' + (index + 1));
  if (!/^[A-Za-z0-9_.:-]+$/.test(out)) fail('Identificator invalid: ' + out + '.');
  return out;
}
function unique(rows, label) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) fail(label + ': identificator duplicat „' + row.id + '”.');
    seen.add(row.id);
  }
}
function evidence(value, label) {
  const out = text(value, 500);
  if (out.length < 3) fail(label + ' cere documentul/sursa justificativa (minimum 3 caractere).');
  return out;
}

function normalizeRegistry(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (r.version != null && Number(r.version) !== 1) fail('Versiunea registrului micro nu este suportata.');
  for (const [key, label, max] of [
    ['associates', 'Registrul asociatilor', 500], ['linkedEnterprises', 'Registrul intreprinderilor legate', 500],
    ['workforce', 'Registrul FTE/mandatelor', 2000], ['assetTransfers', 'Clasificarile cedarilor de active', 2000],
  ]) {
    if (!Array.isArray(r[key])) fail(label + ' trebuie sa fie o lista explicita, chiar daca este goala.');
    if (r[key].length > max) fail(label + ' depaseste limita de ' + max + ' randuri.');
  }
  const associates = (Array.isArray(r.associates) ? r.associates : []).map((x, i) => {
    x = x && typeof x === 'object' ? x : {};
    const validFrom = date(x.validFrom, 'Participatia ' + (i + 1) + ' — valabil de la');
    const validTo = date(x.validTo, 'Participatia ' + (i + 1) + ' — valabil pana la', true);
    interval(validFrom, validTo, 'Participatia ' + (i + 1));
    const name = text(x.name, 160); const identifier = text(x.identifier, 80);
    if (!name && !identifier) fail('Participatia ' + (i + 1) + ' cere numele sau identificatorul asociatului.');
    if (x.kind != null && !['person', 'company'].includes(x.kind)) fail('Tip invalid pentru participatia ' + (i + 1) + '.');
    return {
      id: id(x.id, 'associate', i), name, identifier,
      kind: x.kind === 'company' ? 'company' : 'person', targetId: text(x.targetId || 'self', 80),
      ownershipPercent: number(x.ownershipPercent == null ? 0 : x.ownershipPercent,
        'Procentul de participare', 0, 100),
      votingPercent: number(x.votingPercent == null ? 0 : x.votingPercent,
        'Procentul drepturilor de vot', 0, 100),
      validFrom, validTo, evidenceReference: evidence(x.evidenceReference, 'Participatia ' + (i + 1)),
    };
  });
  unique(associates, 'Registrul asociatilor');

  const linkedEnterprises = (Array.isArray(r.linkedEnterprises) ? r.linkedEnterprises : []).map((x, i) => {
    x = x && typeof x === 'object' ? x : {};
    const validFrom = date(x.validFrom, 'Intreprinderea legata ' + (i + 1) + ' — valabil de la');
    const validTo = date(x.validTo, 'Intreprinderea legata ' + (i + 1) + ' — valabil pana la', true);
    interval(validFrom, validTo, 'Intreprinderea legata ' + (i + 1));
    if (x.kind != null && !ENTITY_KINDS.has(x.kind)) fail('Tip invalid pentru intreprinderea legata ' + (i + 1) + '.');
    if (x.relation != null && !RELATIONS.has(x.relation)) fail('Temei de legatura invalid pentru intreprinderea ' + (i + 1) + '.');
    const kind = x.kind || 'company';
    const relation = x.relation || 'ownership';
    const name = text(x.name, 160); const cui = text(x.cui, 40);
    if (!name && !cui) fail('Intreprinderea legata ' + (i + 1) + ' cere denumirea sau identificatorul fiscal.');
    if (!Array.isArray(x.revenues)) fail('Veniturile intreprinderii legate ' + (i + 1) + ' trebuie sa fie o lista.');
    if (x.revenues.length > 20000) fail('Veniturile intreprinderii legate ' + (i + 1) + ' depasesc limita de 20.000 randuri.');
    const revenues = x.revenues.map((v, j) => ({
      date: date(v && v.date, 'Venitul ' + (j + 1) + ' al intreprinderii legate'),
      amount: number(v && v.amount, 'Valoarea venitului legat', -1e12, 1e12),
      source: evidence(v && v.source, 'Venitul legat ' + (j + 1)),
    })).sort((a, b) => a.date.localeCompare(b.date));
    if (kind === 'pfa_norm' && !Array.isArray(x.annualNorms)) fail(
      'PFA la norma „' + (name || cui || (i + 1)) + '” cere lista normelor anuale, pe ani.');
    const annualNorms = kind === 'pfa_norm' ? x.annualNorms.map((norm, j) => {
      const year = String(norm && norm.year || '');
      if (!/^\d{4}$/.test(year)) fail('An invalid pentru norma PFA ' + (j + 1) + '.');
      return { year, amount: number(norm && norm.amount, 'Norma anuala PFA', 0, 1e12),
        source: evidence(norm && norm.source, 'Norma PFA ' + year) };
    }).sort((a, b) => a.year.localeCompare(b.year)) : [];
    if (new Set(annualNorms.map((x) => x.year)).size !== annualNorms.length) fail(
      'PFA la norma „' + (name || cui || (i + 1)) + '” are doua norme pentru acelasi an.');
    const coverageFrom = date(x.revenueCoverageFrom || validFrom,
      'Inceputul acoperirii veniturilor pentru intreprinderea legata');
    const completeThrough = date(x.revenueCompleteThrough,
      'Data pana la care veniturile intreprinderii legate sunt complete');
    interval(coverageFrom, completeThrough, 'Acoperirea veniturilor intreprinderii legate');
    return {
      id: id(x.id, 'linked', i), name, cui, kind, relation,
      parentId: text(x.parentId || 'self', 80), ownershipPercent: number(x.ownershipPercent == null ? 0 : x.ownershipPercent,
        'Procentul de participare in intreprinderea legata', 0, 100),
      votingPercent: number(x.votingPercent == null ? 0 : x.votingPercent,
        'Procentul de vot in intreprinderea legata', 0, 100),
      control: !!x.control, validFrom, validTo, revenueCoverageFrom: coverageFrom,
      revenueCompleteThrough: completeThrough, annualNorms, revenues,
      evidenceReference: evidence(x.evidenceReference, 'Legatura cu intreprinderea ' + (i + 1)),
    };
  });
  unique(linkedEnterprises, 'Registrul intreprinderilor legate');
  const linkedIdentifiers = linkedEnterprises.map((x) => x.cui.toUpperCase()).filter(Boolean);
  if (new Set(linkedIdentifiers).size !== linkedIdentifiers.length) fail(
    'Aceeasi intreprindere legata apare de doua ori dupa identificatorul fiscal.');
  if (linkedEnterprises.some((x) => x.id === 'self')) fail('Identificatorul „self” este rezervat firmei analizate.');
  const graphIds = new Set(['self', ...linkedEnterprises.map((x) => x.id)]);
  for (const x of linkedEnterprises) if (!graphIds.has(x.parentId)) {
    fail('Intreprinderea legata „' + x.id + '” indica un parinte inexistent: ' + x.parentId + '.');
  }
  for (const a of associates) if (!graphIds.has(a.targetId)) {
    fail('Participatia „' + a.id + '” indica o intreprindere inexistenta: ' + a.targetId + '.');
  }
  const parentById = new Map(linkedEnterprises.map((x) => [x.id, x.parentId]));
  for (const entity of linkedEnterprises) {
    const seen = new Set([entity.id]); let parent = entity.parentId;
    while (parent !== 'self') {
      if (seen.has(parent)) fail('Graficul intreprinderilor legate contine un ciclu la „' + parent + '”.');
      seen.add(parent); parent = parentById.get(parent);
    }
  }

  const workforce = (Array.isArray(r.workforce) ? r.workforce : []).map((x, i) => {
    x = x && typeof x === 'object' ? x : {};
    if (x.kind != null && !WORKFORCE_KINDS.has(x.kind)) fail('Tip invalid pentru raportul de munca/mandat ' + (i + 1) + '.');
    const kind = x.kind || 'employment';
    const validFrom = date(x.validFrom, 'Raportul de munca/mandat ' + (i + 1) + ' — valabil de la');
    const validTo = date(x.validTo, 'Raportul de munca/mandat ' + (i + 1) + ' — valabil pana la', true);
    interval(validFrom, validTo, 'Raportul de munca/mandat ' + (i + 1));
    if (!Array.isArray(x.suspensions)) fail('Suspendarile raportului ' + (i + 1) + ' trebuie sa fie o lista.');
    if (x.suspensions.length > 1000) fail('Suspendarile raportului ' + (i + 1) + ' depasesc limita de 1.000 randuri.');
    const suspensions = x.suspensions.map((s, j) => {
      const from = date(s && s.from, 'Suspendarea ' + (j + 1) + ' — de la');
      const to = date(s && s.to, 'Suspendarea ' + (j + 1) + ' — pana la');
      interval(from, to, 'Suspendarea ' + (j + 1));
      if (s && s.kind != null && !SUSPENSION_KINDS.has(s.kind)) fail('Tip invalid pentru suspendarea ' + (j + 1) + '.');
      return { from, to, kind: s && s.kind || 'other',
        evidenceReference: evidence(s && s.evidenceReference, 'Suspendarea ' + (j + 1)) };
    }).sort((a, b) => a.from.localeCompare(b.from));
    const person = text(x.person, 160);
    if (!person) fail('Raportul de munca/mandat ' + (i + 1) + ' cere persoana sau rolul.');
    const indefinite = kind === 'employment' ? !!x.indefinite : false;
    if (kind === 'employment' && !indefinite && !validTo) fail(
      'CIM-ul pe durata determinata ' + (i + 1) + ' cere data de sfarsit.');
    return {
      id: id(x.id, 'workforce', i), kind, person, validFrom, validTo,
      fte: kind === 'employment' ? number(x.fte == null ? 1 : x.fte, 'Echivalentul de norma', 0.01, 1) : 0,
      remunerationMonthly: kind === 'mandate'
        ? number(x.remunerationMonthly, 'Remuneratia lunara a mandatului', 0, 1e12) : 0,
      indefinite,
      durationMonths: kind === 'employment'
        ? number(x.durationMonths == null ? 0 : x.durationMonths, 'Durata contractului', 0, 1200) : 0,
      suspensions, evidenceReference: evidence(x.evidenceReference, 'Raportul de munca/mandat ' + (i + 1)),
    };
  });
  unique(workforce, 'Registrul FTE/mandatelor');

  const assetTransfers = (Array.isArray(r.assetTransfers) ? r.assetTransfers : []).map((x, i) => {
    const kind = x && x.kind || 'fixed_asset';
    if (!ASSET_KINDS.has(kind)) fail('Natura cedarii de activ ' + (i + 1) + ' este invalida.');
    const row = { entryId: text(x && x.entryId, 120), kind,
      group: kind === 'fixed_asset' ? text(x && x.group, 80) : '',
      evidenceReference: evidence(x && x.evidenceReference, 'Clasificarea cedarii de activ ' + (i + 1)) };
    if (!row.entryId || (kind === 'fixed_asset' && !row.group)) fail(
      'Fiecare cedare clasificata cere articolul si, pentru mijloc fix, subgrupa din Catalog.');
    return row;
  });
  if (new Set(assetTransfers.map((x) => x.entryId)).size !== assetTransfers.length) fail('Aceeasi cedare de activ este clasificata de doua ori.');

  return {
    version: 1,
    registrationDate: date(r.registrationDate, 'Data inregistrarii firmei', true),
    ownershipCompleteThrough: date(r.ownershipCompleteThrough, 'Data pana la care graficul de participatii este complet'),
    workforceCompleteThrough: date(r.workforceCompleteThrough, 'Data pana la care registrul FTE/mandate este complet'),
    evidenceReference: evidence(r.evidenceReference, 'Registrul de eligibilitate micro'),
    associates, linkedEnterprises, workforce, assetTransfers,
  };
}

function latestRegistry(view) {
  if (view && view.microEligibilityRegistry) return view.microEligibilityRegistry;
  const rows = (view && view.microEligibilityHistory) || [];
  const latest = rows.slice().sort((a, b) => String(a.recordedAt || '').localeCompare(String(b.recordedAt || ''))
    || String(a.id || '').localeCompare(String(b.id || ''))).pop();
  return latest && latest.registry || null;
}

function utc(value) { return new Date(String(value) + 'T00:00:00Z'); }
function iso(value) { return value.toISOString().slice(0, 10); }
function addDays(value, days) { return iso(new Date(utc(value).getTime() + days * DAY)); }
function daysInclusive(from, to) { return Math.floor((utc(to) - utc(from)) / DAY) + 1; }
function endOfMonth(period) {
  const m = String(period || '').match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m) return String(period).match(/^\d{4}$/) ? String(period) + '-12-31' : '';
  return iso(new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)));
}
function quarter(dateValue) { return Math.ceil(Number(String(dateValue).slice(5, 7)) / 3); }
function quarterPeriod(dateValue, next) {
  let year = Number(String(dateValue).slice(0, 4)); let q = quarter(dateValue) + (next ? 1 : 0);
  if (q === 5) { year += 1; q = 1; }
  return String(year) + '-Q' + q;
}
function quarterStart(period) {
  const m = String(period).match(/^(\d{4})-Q([1-4])$/);
  return m ? m[1] + '-' + String((Number(m[2]) - 1) * 3 + 1).padStart(2, '0') + '-01' : '';
}
function overlaps(row, from, to) { return row.validFrom <= to && (!row.validTo || row.validTo >= from); }
function activeOn(row, day) { return row.validFrom <= day && (!row.validTo || row.validTo >= day); }

function accountingTurnoverOperations(entries, year, asOf) {
  const out = [];
  for (const e of entries || []) {
    const day = String(e.data || (e.period ? e.period + '-01' : ''));
    if (!day.startsWith(String(year)) || day > asOf) continue;
    let amount = 0;
    for (const line of acc.resultLines([e])) {
      const d = String(line.debit || ''); const c = String(line.credit || ''); const sum = Number(line.suma) || 0;
      if (/^70[1-9]/.test(c)) amount = round2(amount + sum);
      if (/^70[1-9]/.test(d)) amount = round2(amount - sum);
    }
    if (amount) out.push({ date: day, amount, source: 'own-accounting-turnover', entryId: e.id,
      document: e.document || e.tip || e.id });
  }
  return out;
}

function assetTransferOperations(entries, year, asOf, registry, blockers) {
  const candidates = [];
  const byId = new Map();
  for (const e of entries || []) if (e && e.id != null) byId.set(String(e.id), e);
  for (const e of entries || []) {
    const day = String(e.data || (e.period ? e.period + '-01' : ''));
    if (!day.startsWith(String(year)) || day > asOf) continue;
    let amount = 0;
    for (const line of acc.resultLines([e])) {
      if (/^7583/.test(String(line.credit || ''))) amount = round2(amount + (Number(line.suma) || 0));
      if (/^7583/.test(String(line.debit || ''))) amount = round2(amount - (Number(line.suma) || 0));
    }
    if (amount) candidates.push({ entry: e, date: day, amount });
  }
  const originals = candidates.filter((x) => x.amount > 0 && !x.entry.stornoOf);
  if (originals.length <= 1) return [];
  const classes = new Map((registry.assetTransfers || []).map((x) => [String(x.entryId), x]));
  const unresolved = originals.filter((x) => !classes.has(String(x.entry.id)));
  if (unresolved.length) {
    blockers.push({ code: 'asset-transfers-unclassified', message: unresolved.length
      + ' cedare/cedari de active nu au subgrupa HG/teren documentata; nu se poate aplica exact art. 54 alin. (1).',
    entries: unresolved.map((x) => ({ entryId: x.entry.id, date: x.date, document: x.entry.document || '' })) });
    return [];
  }
  const counts = {}; let landCount = 0;
  for (const x of originals) {
    const classification = classes.get(String(x.entry.id));
    if (classification.kind === 'land') landCount += 1;
    else counts[classification.group] = (counts[classification.group] || 0) + 1;
  }
  // Art. 54 alin. (1): dupa ce exista mai mult de un activ din ORICARE subgrupa ori mai mult de
  // un teren, se includ veniturile din transferurile de mijloace fixe/terenuri cumulate de la
  // inceputul anului — nu doar veniturile subgrupei care a declansat regula.
  const triggered = landCount > 1 || Object.values(counts).some((count) => count > 1);
  if (!triggered) return [];
  const out = [];
  for (const x of candidates) {
    const originalId = x.entry.stornoOf || x.entry.id;
    const classification = classes.get(String(originalId));
    if (classification) out.push({ date: x.date, amount: x.amount,
      source: 'own-asset-transfer', entryId: x.entry.id, assetKind: classification.kind,
      group: classification.kind === 'land' ? 'land' : classification.group,
      document: x.entry.document || x.entry.id });
  }
  return out;
}

function graph(registry, company) {
  const nodes = [{ id: 'self', type: 'company', label: (company && company.nume) || 'Firma analizata',
    cui: (company && company.cui) || '' }];
  for (const e of registry.linkedEnterprises || []) nodes.push({ id: e.id, type: e.kind, label: e.name || e.cui || e.id, cui: e.cui });
  for (const a of registry.associates || []) nodes.push({ id: 'owner:' + a.id, type: a.kind, label: a.name || a.identifier || a.id });
  const edges = [];
  for (const a of registry.associates || []) edges.push({ from: 'owner:' + a.id, to: a.targetId,
    relation: 'participation', ownershipPercent: a.ownershipPercent, votingPercent: a.votingPercent,
    validFrom: a.validFrom, validTo: a.validTo });
  for (const e of registry.linkedEnterprises || []) edges.push({ from: e.parentId, to: e.id,
    relation: e.relation, ownershipPercent: e.ownershipPercent, votingPercent: e.votingPercent,
    control: e.control, validFrom: e.validFrom, validTo: e.validTo });
  return { nodes, edges };
}

function linkedOperations(registry, year, asOf, blockers) {
  const from = String(year) + '-01-01'; const out = [];
  for (const entity of registry.linkedEnterprises || []) {
    if (!overlaps(entity, from, asOf)) continue;
    const needFrom = entity.validFrom > from ? entity.validFrom : from;
    const needThrough = entity.validTo && entity.validTo < asOf ? entity.validTo : asOf;
    if (entity.revenueCoverageFrom > needFrom || entity.revenueCompleteThrough < needThrough) {
      blockers.push({ code: 'linked-revenue-incomplete', entityId: entity.id, message: 'Veniturile întreprinderii legate „'
        + (entity.name || entity.cui || entity.id) + '” nu sunt confirmate pentru întreg intervalul '
        + needFrom + '–' + needThrough + '.' });
      continue;
    }
    if (entity.kind === 'pfa_norm') {
      // Art. 52 alin. (5^2) cere o patrime din norma ANUALA curenta, nu cate o patrime
      // acumulata pentru fiecare trimestru scurs. Valoarea intra o singura data, de la inceputul
      // intervalului in care entitatea este legata.
      const norm = entity.annualNorms.find((x) => x.year === String(year));
      if (!norm) {
        blockers.push({ code: 'linked-annual-norm-missing', entityId: entity.id,
          message: 'Lipsește norma anuală ' + year + ' pentru activitatea legată „'
            + (entity.name || entity.cui || entity.id) + '”.' });
        continue;
      }
      out.push({ date: needFrom, amount: round2(norm.amount / 4),
        source: 'linked-annual-norm-quarter', entityId: entity.id, evidence: norm.source });
    } else {
      for (const revenue of entity.revenues) {
        if (revenue.date.startsWith(String(year)) && revenue.date <= asOf
            && revenue.date >= entity.validFrom && (!entity.validTo || revenue.date <= entity.validTo)) {
          out.push({ date: revenue.date, amount: revenue.amount, source: 'linked-accounting-turnover',
            entityId: entity.id, entityName: entity.name, evidence: revenue.source });
        }
      }
    }
  }
  return out;
}

function suspensionState(record, day, year) {
  const suspensions = record.suspensions.filter((s) => s.from <= day && s.to >= day);
  if (!suspensions.length) return { counts: true, reason: null };
  const medical = record.suspensions.filter((s) => s.kind === 'medical'
    && s.from <= year + '-12-31' && s.to >= year + '-01-01');
  // Exceptia medicala se consuma cronologic: zilele 1–30 conteaza, iar pierderea conditiei apare
  // in ziua 31 cumulata, nu retroactiv in prima zi a unui certificat care ulterior trece pragul.
  const medicalDays = medical.reduce((sum, s) => {
    const from = s.from < year + '-01-01' ? year + '-01-01' : s.from;
    const yearToDay = day < year + '-12-31' ? day : year + '-12-31';
    const to = s.to > yearToDay ? yearToDay : s.to;
    if (to < from) return sum;
    return sum + daysInclusive(from, to);
  }, 0);
  if (suspensions.every((s) => s.kind === 'medical') && medicalDays <= 30) return { counts: true, reason: null };
  const nonMedical = record.suspensions.filter((s) => s.kind === 'other' && s.from.startsWith(year))
    .sort((a, b) => a.from.localeCompare(b.from));
  const currentOther = suspensions.find((s) => s.kind === 'other');
  // Pentru suspendarea obisnuita legea priveste PERIOADA suspendarii, deja documentata, nu
  // numarul de zile scurs pana azi. O decizie pe 30+ zile nu beneficiaza de exceptie in primele
  // 29 de zile; doar prima suspendare inregistrata in anul respectiv si mai scurta de 30 conteaza.
  if (currentOther && suspensions.every((s) => s.kind === 'other')
      && nonMedical[0] === currentOther && daysInclusive(currentOther.from, currentOther.to) < 30) {
    return { counts: true, reason: null };
  }
  return { counts: false, reason: suspensions.some((s) => s.kind === 'medical')
    ? 'Concediul medical cumulat depaseste 30 de zile.'
    : 'Suspendarea nu este prima din an sau nu este mai scurta de 30 de zile.' };
}

function workforceAt(registry, day, year) {
  let fte = 0; let mandate = false; const active = []; const excluded = [];
  for (const row of registry.workforce || []) {
    if (!activeOn(row, day)) continue;
    const suspension = suspensionState(row, day, year);
    if (!suspension.counts) { excluded.push({ id: row.id, reason: suspension.reason }); continue; }
    if (row.kind === 'employment') { fte = round2(fte + row.fte); active.push(row.id); }
    else {
      const minimum = fiscal.salariuMinimLa(day.slice(0, 7));
      if (row.remunerationMonthly >= minimum) { mandate = true; active.push(row.id); }
      else excluded.push({ id: row.id, reason: 'Remuneratia mandatului este sub salariul minim de ' + minimum + ' lei.' });
    }
  }
  return { qualifies: fte >= 1 || mandate, fte, mandate, active, excluded };
}

function fixedContractAtLeast12Months(row) {
  if (row.indefinite) return true;
  if (!row.validTo) return false;
  const start = utc(row.validFrom);
  const anniversary = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()));
  // CIM-ul 20.02.2026–19.02.2027 acopera 12 luni: capatul este inclus, de aceea comparam ziua
  // imediat urmatoare incetarii cu aniversarea.
  return utc(addDays(row.validTo, 1)) >= anniversary;
}

function longTermReplacement(registry, after, deadline) {
  const starts = (registry.workforce || []).filter((x) => x.kind === 'employment'
    && x.validFrom > after && x.validFrom <= deadline && fixedContractAtLeast12Months(x));
  const dates = [...new Set(starts.map((x) => x.validFrom))].sort();
  return dates.find((day) => workforceAt(registry, day, day.slice(0, 4)).fte >= 1) || null;
}

function workforceAssessment(registry, year, asOf, blockers) {
  const from = year + '-01-01';
  if (registry.workforceCompleteThrough < asOf) blockers.push({ code: 'workforce-coverage-incomplete',
    message: 'Registrul FTE/mandate este confirmat numai până la ' + registry.workforceCompleteThrough
      + ', nu până la ' + asOf + '.' });
  const registration = registry.registrationDate;
  const isNew = registration && registration.startsWith(year);
  const start = isNew && registration > from ? registration : from;
  const openingDay = addDays(from, -1);
  const openingState = isNew ? null : workforceAt(registry, openingDay, openingDay.slice(0, 4));
  // Pentru o firma existenta, un CIM/mandat inceput abia la 1 ianuarie nu poate repara
  // retroactiv conditia de intrare verificata la inchiderea exercitiului precedent. Daca
  // fotografia de la 31 decembrie nu sustine conditia, regimul micro nu este disponibil din T1.
  if (openingState && !openingState.qualifies) return { complete: true, qualifies: false,
    failureDate: openingDay, exitPeriod: year + '-Q1',
    reason: 'Conditia de salariat/FTE/mandat nu era indeplinita la 31 decembrie ' + openingDay.slice(0, 4) + '.' };
  let firstQualified = null; let firstFailure = null; let previous = openingState;
  for (let cursor = utc(start); iso(cursor) <= asOf; cursor = new Date(cursor.getTime() + DAY)) {
    const day = iso(cursor); const state = workforceAt(registry, day, year);
    if (state.qualifies && !firstQualified) firstQualified = day;
    if (previous && previous.qualifies && !state.qualifies) { firstFailure = { date: day, previous, state }; break; }
    previous = state;
  }
  if (isNew) {
    const deadline = addDays(registration, 90);
    if (!firstQualified || firstQualified > deadline) {
      if (asOf <= deadline) return { complete: true, qualifies: true, pendingUntil: deadline,
        reason: 'Firma nou-infiintata se afla in termenul de 90 de zile pentru indeplinirea conditiei de salariat.' };
      return { complete: true, qualifies: false, failureDate: deadline,
        exitPeriod: quarterPeriod(deadline, true), reason: 'Firma nou-infiintata nu a indeplinit conditia de salariat in 90 de zile.' };
    }
  }
  if (!firstFailure) return { complete: true, qualifies: true, fteAtEnd: workforceAt(registry, asOf, year).fte };

  const previousDay = addDays(firstFailure.date, -1);
  const previousContributors = new Set((firstFailure.previous && firstFailure.previous.active) || []);
  const endedContributors = (registry.workforce || []).filter((x) => x.validTo === previousDay
    && previousContributors.has(x.id));
  const endedEmployment = endedContributors.filter((x) => x.kind === 'employment');
  const employmentBeforeFailure = (registry.workforce || []).filter((x) => x.kind === 'employment'
    && activeOn(x, previousDay));
  // Art. 52 alin. (3) acorda termenul de inlocuire numai microintreprinderii „cu un singur
  // salariat”. Doua CIM-uri fractionate care alcatuiesc impreuna un FTE indeplinesc conditia de
  // la art. 47, dar nu devin, prin aceasta echivalenta, un singur salariat pentru derogarea de
  // 30 de zile. Acordarea termenului si in acel caz ar mentine nelegal regimul micro.
  if (endedEmployment.length === 1 && employmentBeforeFailure.length === 1) {
    const deadline = addDays(previousDay, 30);
    const replacement = longTermReplacement(registry, previousDay, deadline);
    if (replacement) return { complete: true, qualifies: true, replacementDate: replacement,
      reason: 'Salariatul a fost inlocuit in 30 de zile prin CIM eligibil.' };
    if (asOf <= deadline) return { complete: true, qualifies: true, pendingUntil: deadline,
      reason: 'Termenul de 30 de zile pentru inlocuirea salariatului nu a expirat.' };
    return { complete: true, qualifies: false, failureDate: previousDay,
      exitPeriod: quarterPeriod(previousDay, true), reason: 'Raportul de munca a incetat si nu exista inlocuire eligibila in 30 de zile.' };
  }
  if (endedContributors.length) return { complete: true, qualifies: false, failureDate: previousDay,
    exitPeriod: quarterPeriod(previousDay, true),
    reason: endedEmployment.length
      ? 'Conditia FTE s-a pierdut prin incetarea unui raport de munca; derogarea de 30 de zile se aplica numai firmei cu un singur salariat.'
      : 'Conditia de salariat/FTE/mandat s-a pierdut prin incetarea mandatului eligibil.' };
  return { complete: true, qualifies: false, failureDate: firstFailure.date,
    exitPeriod: quarterPeriod(firstFailure.date, true),
    reason: (firstFailure.state.excluded[0] && firstFailure.state.excluded[0].reason)
      || 'Echivalentul de norma intreaga/mandatul eligibil nu mai este indeplinit.' };
}

function earliestExit(revenueExit, workforceExit) {
  return [revenueExit, workforceExit].filter(Boolean).sort((a, b) => a.period.localeCompare(b.period))[0] || null;
}

function thresholdCrossing(operations, threshold) {
  let running = 0; let crossing = null;
  for (const operation of operations) {
    const before = running; running = round2(running + operation.amount);
    if (!crossing && threshold > 0 && running > threshold) crossing = Object.assign({}, operation,
      { totalBefore: before, totalAfter: running, threshold, period: quarterPeriod(operation.date, false) });
  }
  return { total: running, crossing };
}

function analyze(view, when) {
  const asOf = endOfMonth(when) || String(when || '');
  const year = asOf.slice(0, 4);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) fail('Perioada controlului micro trebuie sa fie YYYY sau YYYY-MM.');
  const registry = latestRegistry(view);
  const blockers = [];
  const posted = acc.postedEntries(view || {});
  const ruleSet = fiscal.rulesAt(asOf.slice(0, 7));
  const course = bnr.cursPlafonMicro((view && view.cursuriBnr) || [], Number(year), ruleSet.rates.cursPlafonMicro);
  const threshold = round2((Number(ruleSet.rates.plafonMicroEur) || 0) * (Number(course.curs) || 0));
  const ownBase = accountingTurnoverOperations(posted, year, asOf);
  const openingYear = String(Number(year) - 1);
  const openingAsOf = openingYear + '-12-31';
  const openingOwnBase = Number(year) >= 2026
    ? accountingTurnoverOperations(posted, openingYear, openingAsOf) : [];
  if (!registry) {
    blockers.push({ code: 'registry-missing', message: 'Lipsește registrul versionat al asociaților, întreprinderilor legate și al condiției FTE/mandat.' });
    const ownRevenue = round2(ownBase.reduce((sum, x) => sum + x.amount, 0));
    // Lipsa registrului impiedica verdictul de eligibilitate, dar nu are voie sa ascunda o
    // depasire deja demonstrata numai de cifra firmei. Veniturile persoanelor legate pot doar sa
    // mute data mai devreme, nu sa infirme aceasta depasire certa.
    const currentCheck = thresholdCrossing(ownBase, threshold);
    const openingCheck = thresholdCrossing(openingOwnBase, threshold);
    const crossing = currentCheck.crossing && Object.assign(currentCheck.crossing, { provisional: true });
    const openingCrossing = openingCheck.crossing && Object.assign(openingCheck.crossing, { provisional: true });
    const currentExit = crossing ? { period: crossing.period, date: crossing.date,
      reason: 'threshold', details: crossing, provisional: true } : null;
    const openingExit = openingCrossing ? { period: year + '-Q1', date: year + '-01-01',
      reason: 'opening-threshold', details: openingCrossing, provisional: true } : null;
    const exit = earliestExit(openingExit, currentExit);
    const warnings = [];
    if (!crossing && threshold > 0 && ownRevenue >= round2(threshold * 0.8)) warnings.push(
      'Numai cifra de afaceri proprie a ajuns la ' + Math.round((ownRevenue / threshold) * 100)
      + '% din plafon; totalul cu întreprinderile legate poate fi mai mare.');
    return { year, asOf, complete: false, status: 'review_required', blockers, warnings,
      thresholdEur: ruleSet.rates.plafonMicroEur, thresholdLei: threshold, exchangeRate: course,
      ownRevenue, linkedRevenue: 0, combinedRevenue: ownRevenue, crossing, exit,
      opening: { year: openingYear, ownRevenue: openingCheck.total, linkedRevenue: 0,
        combinedRevenue: openingCheck.total, crossing: openingCrossing },
      workforce: { complete: false, qualifies: null }, graph: { nodes: [], edges: [] }, operations: ownBase };
  }
  if (registry.ownershipCompleteThrough < asOf) blockers.push({ code: 'ownership-coverage-incomplete',
    message: 'Graficul asociaților și întreprinderilor legate este confirmat numai până la '
      + registry.ownershipCompleteThrough + ', nu până la ' + asOf + '.' });
  if (!registry.registrationDate) blockers.push({ code: 'registration-date-missing',
    message: 'Lipsește data înregistrării la registrul comerțului; termenul de 90 de zile pentru o firmă nou-înființată nu poate fi verificat.' });
  else if (registry.registrationDate > asOf) blockers.push({ code: 'registration-date-after-control',
    message: 'Data înregistrării firmei (' + registry.registrationDate + ') este ulterioară datei controlului (' + asOf + ').' });
  const assetOps = assetTransferOperations(posted, year, asOf, registry, blockers);
  const linkedOps = linkedOperations(registry, year, asOf, blockers);
  const openingAssetOps = Number(year) >= 2026
    ? assetTransferOperations(posted, openingYear, openingAsOf, registry, blockers) : [];
  const openingLinkedOps = Number(year) >= 2026
    ? linkedOperations(registry, openingYear, openingAsOf, blockers) : [];
  const openingOperations = openingOwnBase.concat(openingAssetOps, openingLinkedOps)
    .sort((a, b) => a.date.localeCompare(b.date)
      || naturalCompare(a.entryId || a.entityId || '', b.entryId || b.entityId || ''));
  const operations = ownBase.concat(assetOps, linkedOps).sort((a, b) => a.date.localeCompare(b.date)
    || naturalCompare(a.entryId || a.entityId || '', b.entryId || b.entityId || ''));
  const currentCheck = thresholdCrossing(operations, threshold);
  const openingCheck = thresholdCrossing(openingOperations, threshold);
  const running = currentCheck.total; const crossing = currentCheck.crossing;
  const ownRevenue = round2(ownBase.concat(assetOps).reduce((sum, x) => sum + x.amount, 0));
  const linkedRevenue = round2(linkedOps.reduce((sum, x) => sum + x.amount, 0));
  const openingOwnRevenue = round2(openingOwnBase.concat(openingAssetOps).reduce((sum, x) => sum + x.amount, 0));
  const openingLinkedRevenue = round2(openingLinkedOps.reduce((sum, x) => sum + x.amount, 0));
  const workforce = workforceAssessment(registry, year, asOf, blockers);
  const revenueExit = crossing ? { period: crossing.period, date: crossing.date, reason: 'threshold', details: crossing } : null;
  const openingExit = openingCheck.crossing ? { period: year + '-Q1', date: year + '-01-01',
    reason: 'opening-threshold', details: openingCheck.crossing } : null;
  const workforceExit = workforce.exitPeriod ? { period: workforce.exitPeriod, date: workforce.failureDate,
    reason: 'workforce', details: workforce } : null;
  const exit = earliestExit(openingExit, earliestExit(revenueExit, workforceExit));
  const warnings = [];
  if (course.sursa !== 'bnr' && threshold > 0 && running >= round2(threshold * 0.9)) warnings.push('Plafonul este calculat cu un curs orientativ; lipsește cursul BNR de la închiderea exercițiului precedent.');
  if (!crossing && threshold > 0 && running >= round2(threshold * 0.8)) warnings.push('Cifra de afaceri cumulată a ajuns la '
    + Math.round((running / threshold) * 100) + '% din plafonul micro.');
  if (workforce.pendingUntil) warnings.push(workforce.reason + ' Termen: ' + workforce.pendingUntil + '.');
  const complete = blockers.length === 0;
  return { year, asOf, complete, status: !complete ? 'review_required' : (exit ? 'profit_required' : 'eligible'),
    blockers, warnings, thresholdEur: ruleSet.rates.plafonMicroEur, thresholdLei: threshold,
    exchangeRate: course, ownRevenue, linkedRevenue, combinedRevenue: round2(ownRevenue + linkedRevenue),
    crossing, exit, opening: { year: openingYear, ownRevenue: openingOwnRevenue,
      linkedRevenue: openingLinkedRevenue, combinedRevenue: round2(openingOwnRevenue + openingLinkedRevenue),
      crossing: openingCheck.crossing, operations: openingOperations },
    workforce, graph: graph(registry, view && view.company), operations };
}

function wasMicroDuringYear(view, year) {
  return [1, 4, 7, 10].some((month) => fiscalProfile.profileAt(view || {}, year + '-'
    + String(month).padStart(2, '0')).micro);
}

function declarationBlockers(view, type, when) {
  type = String(type || '').toLowerCase();
  const year = String(when || '').slice(0, 4);
  if (!['d100', 'd101'].includes(type) || !/^\d{4}$/.test(year)) return [];
  const profile = fiscalProfile.profileAt(view || {}, when);
  if (type === 'd100' && !profile.micro) return [];
  if (type === 'd101' && !wasMicroDuringYear(view, year)) return [];
  const result = analyze(view, type === 'd101' ? year : when);
  const out = result.blockers.map((x) => x.message);
  if (type === 'd100' && result.exit) out.push('Regimul micro a încetat în ' + result.exit.period
    + ' (' + (result.exit.reason === 'workforce' ? 'condiția de salariat/FTE/mandat'
      : (result.exit.reason === 'opening-threshold' ? 'plafonul era depășit la închiderea exercițiului precedent'
        : 'depășirea plafonului cumulat')) + ').');
  if (type === 'd101' && result.exit) {
    const expected = quarterStart(result.exit.period);
    if (!fiscalProfile.profileAt(view || {}, expected).profit) out.push('Profilul fiscal trebuie trecut la impozit pe profit începând cu '
      + expected + ', conform ieșirii determinate pentru ' + result.exit.period + '.');
  }
  return [...new Set(out)];
}

function assertCanDeclare(view, type, when) {
  const blockers = declarationBlockers(view, type, when);
  if (!blockers.length) return;
  const e = new Error(type.toUpperCase() + ' este blocată de controlul eligibilității micro: ' + blockers.join(' '));
  e.status = 409; e.code = 'MICRO_ELIGIBILITY_BLOCKED'; e.blockers = blockers; throw e;
}

module.exports = {
  normalizeRegistry, latestRegistry, analyze, accountingTurnoverOperations, workforceAt,
  declarationBlockers, assertCanDeclare, wasMicroDuringYear, quarterPeriod,
};
