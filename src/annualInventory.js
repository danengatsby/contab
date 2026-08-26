'use strict';

// Matricea inventarierii generale. O singura lista fizica sau o singura valoare pe cont nu
// poate demonstra acoperirea tuturor elementelor patrimoniale. Fiecare domeniu trebuie confirmat
// explicit (cu trimitere la dovada) ori declarat neaplicabil (cu justificare), iar diferentele si
// guvernanta procesului au controale proprii.

const { canonicalJson, sha256 } = require('./globalChain');
const { validIsoDate } = require('./util');

const CATEGORIES = [
  { key: 'stocuri_gestiuni', label: 'Stocuri și gestiuni' },
  { key: 'mijloace_fixe', label: 'Mijloace fixe' },
  { key: 'casa_banci', label: 'Casă și bănci' },
  { key: 'clienti_furnizori', label: 'Clienți și furnizori' },
  { key: 'taxe_salarii', label: 'Taxe și salarii' },
  { key: 'imprumuturi_contracte', label: 'Împrumuturi și contracte' },
  { key: 'litigii_provizioane_confirmari', label: 'Litigii, provizioane și confirmări externe' },
];

const STATUS = new Set(['confirmat', 'nu_se_aplica']);

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function yearOf(value) {
  const year = String(value || '');
  if (!/^[1-9]\d{3}$/.test(year)) fail(400, 'Anul trebuie să aibă forma YYYY.');
  return year;
}
function clean(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function names(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\n,;]/);
  return [...new Set(list.map((x) => clean(typeof x === 'object' ? x.name : x, 120)).filter(Boolean))];
}
function entryIds(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  return [...new Set(list.map((x) => clean(x, 100)).filter(Boolean))];
}
function blank(year) {
  return {
    schemaVersion: 1,
    year: yearOf(year),
    categories: {},
    reconciliation: { differenceAmount: null, evidence: '', note: '', adjustmentEntryIds: [] },
    governance: { committee: [], minutesRef: '', minutesDate: '', signedBy: [], signatureEvidence: '', approval: null },
  };
}

/** Forma persistenta accepta numai campurile matricei; metadatele actorului sunt puse de ruta. */
function sanitize(input, year) {
  const src = input || {}; const out = blank(year);
  const cats = src.categories && typeof src.categories === 'object' ? src.categories : {};
  for (const def of CATEGORIES) {
    const row = cats[def.key] || {};
    out.categories[def.key] = {
      status: STATUS.has(row.status) ? row.status : '',
      evidence: clean(row.evidence, 300),
      note: clean(row.note, 500),
    };
  }
  const r = src.reconciliation || {};
  const diffEmpty = r.differenceAmount == null || String(r.differenceAmount).trim() === '';
  const diff = diffEmpty ? null : Number(r.differenceAmount);
  if (diff !== null && !Number.isFinite(diff)) fail(400, 'Diferența inventar–contabilitate trebuie să fie un număr finit.');
  out.reconciliation = {
    differenceAmount: diff == null ? null : Math.round(diff * 100) / 100,
    evidence: clean(r.evidence, 300), note: clean(r.note, 500),
    adjustmentEntryIds: entryIds(r.adjustmentEntryIds),
  };
  const g = src.governance || {};
  out.governance = {
    committee: names(g.committee),
    minutesRef: clean(g.minutesRef, 160),
    minutesDate: clean(g.minutesDate, 10),
    signedBy: names(g.signedBy),
    signatureEvidence: clean(g.signatureEvidence, 300),
    approval: g.approval && typeof g.approval === 'object' ? {
      approvedAt: clean(g.approval.approvedAt, 40),
      approvedBy: Number(g.approval.approvedBy) || null,
      approvedByName: clean(g.approval.approvedByName, 120),
      sourceHash: clean(g.approval.sourceHash, 64),
    } : null,
  };
  return out;
}

function approvalSource(control) {
  const c = sanitize(control, control && control.year);
  c.governance.approval = null;
  return sha256(Buffer.from(canonicalJson(c), 'utf8'));
}

function get(company, year) {
  year = yearOf(year);
  const saved = company && company.annualInventoryControls && company.annualInventoryControls[year];
  return sanitize(saved || {}, year);
}

function activeYearEntries(view, year) {
  return (view.entries || []).filter((e) => !e.stornat
    && (!e.status || e.status === 'postat')
    && Array.isArray(e.lines) && e.lines.length
    && String(e.period || e.data || '').slice(0, 4) === year);
}

function evaluate(view, year) {
  year = yearOf(year); view = view || {};
  const control = get(view.company || {}, year);
  const rows = [];
  for (const def of CATEGORIES) {
    const row = control.categories[def.key] || {};
    const blockers = [];
    if (!STATUS.has(row.status)) blockers.push('Alege „confirmat” sau „nu se aplică”.');
    if (row.status === 'confirmat' && !row.evidence) blockers.push('Indică documentul, confirmarea sau locația dovezii.');
    if (row.status === 'nu_se_aplica' && row.note.length < 3) blockers.push('Justifică de ce domeniul nu se aplică firmei.');
    rows.push({ key: def.key, label: def.label, status: row.status || 'necompletat',
      evidence: row.evidence, note: row.note, complete: blockers.length === 0, blockers });
  }

  const rec = control.reconciliation; const recBlockers = [];
  if (rec.differenceAmount == null) recBlockers.push('Consemnează diferența totală inventar–contabilitate, inclusiv zero.');
  if (!rec.evidence) recBlockers.push('Indică centralizatorul/punctajul care dovedește diferența.');
  const activeIds = new Set(activeYearEntries(view, year).map((e) => String(e.id)));
  const missingEntries = rec.adjustmentEntryIds.filter((id) => !activeIds.has(String(id)));
  if (rec.differenceAmount != null && Math.abs(rec.differenceAmount) >= 0.005) {
    if (!rec.adjustmentEntryIds.length) recBlockers.push('Diferența nenulă cere cel puțin o notă contabilă de regularizare.');
    if (rec.note.length < 3) recBlockers.push('Explică regularizarea diferenței.');
  }
  if (missingEntries.length) recBlockers.push('Notele de regularizare lipsesc, sunt stornate sau nu sunt postate în anul selectat: ' + missingEntries.join(', ') + '.');
  rows.push({ key: 'diferente_regularizare', label: 'Diferență inventar–contabilitate și nota de regularizare',
    status: recBlockers.length ? 'necompletat' : 'confirmat', complete: recBlockers.length === 0,
    blockers: recBlockers, differenceAmount: rec.differenceAmount, adjustmentEntryIds: rec.adjustmentEntryIds,
    evidence: rec.evidence, note: rec.note });

  const gov = control.governance; const govBlockers = [];
  if (gov.committee.length < 2) govBlockers.push('Comisia trebuie să aibă cel puțin doi membri identificați.');
  if (!gov.minutesRef) govBlockers.push('Indică numărul/referința procesului-verbal.');
  if (!validIsoDate(gov.minutesDate)) govBlockers.push('Data procesului-verbal trebuie să fie o dată calendaristică validă.');
  const signed = new Set(gov.signedBy.map((x) => x.toLocaleLowerCase('ro-RO')));
  const unsigned = gov.committee.filter((x) => !signed.has(x.toLocaleLowerCase('ro-RO')));
  if (unsigned.length) govBlockers.push('Lipsesc semnăturile membrilor comisiei: ' + unsigned.join(', ') + '.');
  if (!gov.signatureEvidence) govBlockers.push('Indică documentul/fișierul care conține semnăturile.');
  const currentHash = approvalSource(control);
  const approvalValid = !!(gov.approval && gov.approval.approvedAt && gov.approval.approvedBy
    && gov.approval.sourceHash === currentHash);
  if (!approvalValid) govBlockers.push(gov.approval ? 'Aprobarea a fost invalidată de modificarea matricei.' : 'Matricea nu este aprobată.');
  rows.push({ key: 'guvernanta', label: 'Comisie, proces-verbal, semnături și aprobare',
    status: govBlockers.length ? 'necompletat' : 'confirmat', complete: govBlockers.length === 0,
    blockers: govBlockers, committee: gov.committee, minutesRef: gov.minutesRef,
    minutesDate: gov.minutesDate, signedBy: gov.signedBy, signatureEvidence: gov.signatureEvidence,
    approval: gov.approval, approvalValid });

  const blockers = rows.filter((x) => !x.complete).map((x) => ({ key: x.key, label: x.label, blockers: x.blockers }));
  return { year, complete: blockers.length === 0, rows, blockers, control,
    progress: { complete: rows.length - blockers.length, total: rows.length } };
}

function assertComplete(view, year) {
  const result = evaluate(view, year);
  if (!result.complete) {
    const first = result.blockers[0];
    fail(409, 'Inventarierea generală este incompletă: ' + first.label + ' — ' + first.blockers[0]);
  }
  return result;
}

function save(company, year, input, actor) {
  if (!company) fail(404, 'Firma nu există.');
  year = yearOf(year);
  const next = sanitize(input, year);
  next.governance.approval = null; // orice salvare cere o aprobare noua pe continutul exact
  next.updatedAt = new Date().toISOString();
  next.updatedBy = actor && actor.id != null ? actor.id : null;
  next.updatedByName = clean(actor && actor.username, 120);
  company.annualInventoryControls = company.annualInventoryControls || {};
  company.annualInventoryControls[year] = next;
  return next;
}

function approve(view, year, actor) {
  year = yearOf(year);
  const company = view && view.company;
  if (!company) fail(404, 'Firma nu există.');
  const result = evaluate(view, year);
  const preApprovalBlockers = result.blockers.filter((x) => x.key !== 'guvernanta');
  const gov = result.rows.find((x) => x.key === 'guvernanta');
  const govWithoutApproval = (gov.blockers || []).filter((x) => !/aprobare|aprobată|invalidată/i.test(x));
  if (preApprovalBlockers.length || govWithoutApproval.length) {
    const first = preApprovalBlockers[0] || { label: gov.label, blockers: govWithoutApproval };
    fail(409, 'Matricea nu poate fi aprobată: ' + first.label + ' — ' + first.blockers[0]);
  }
  const control = get(company, year);
  control.governance.approval = {
    approvedAt: new Date().toISOString(),
    approvedBy: actor && actor.id != null ? Number(actor.id) : null,
    approvedByName: clean(actor && actor.username, 120),
    sourceHash: approvalSource(control),
  };
  control.updatedAt = control.governance.approval.approvedAt;
  control.updatedBy = control.governance.approval.approvedBy;
  control.updatedByName = control.governance.approval.approvedByName;
  company.annualInventoryControls = company.annualInventoryControls || {};
  company.annualInventoryControls[year] = control;
  return control;
}

module.exports = { CATEGORIES, blank, sanitize, get, evaluate, assertComplete, save, approve, approvalSource };
