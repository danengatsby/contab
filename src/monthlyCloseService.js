'use strict';

// Service layer pentru inchiderea lunara: SCRIERILE fluxului (motorul de stare, pur, e in
// src/monthlyClose.js). Se persista numai ce nu se poate deriva din date:
//   - alocarea unui pas (responsabil, termen, nota),
//   - DOVADA VALIDARII unei declaratii (cine a rulat validarea, cand, cu ce verdict),
//   - aprobarea lunii (cine si cand si-a asumat-o),
//   - inchiderea (blocarea perioadei) si, daca a fost fortata peste blocaje, MOTIVUL fortarii.
//
// Autorizare dublata, ca la celelalte servicii: `reqFirma` (firma explicita si existenta — fara
// fallback pe firmaActiva), `reqPerioadaValida`, plus regula proprie fluxului: inchiderea peste
// blocaje deschise cere `control.override` (administrator) + motiv. Erorile poarta `err.status`.

const db = require('./db');
const mc = require('./monthlyClose');
const decl = require('./declarations');
const declCheck = require('./declarationCheck');
const permissions = require('./permissions');
const { reqFirma } = require('./stocksService');
const { capList } = require('./paginate');
const { period: periodOf } = require('./util');
const crypto = require('crypto');

function fail(status, message, code, details) {
  const e = new Error(message); e.status = status;
  if (code) e.code = code;
  if (details) e.details = details;
  throw e;
}

function reqPeriod(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) fail(400, 'Perioada trebuie să fie o lună (YYYY-MM).');
  return String(period);
}
function reqStep(key) {
  if (!mc.STEP_KEYS.includes(String(key))) fail(400, 'Pas necunoscut: ' + key + '.');
  return String(key);
}

/** Inregistrarea lunii, creata la nevoie (upsert pe (firmaId, period)). */
function ensureRecord(fid, period) {
  const d = db.get();
  d.closings = d.closings || [];
  let rec = mc.findRecord(d, fid, period);
  if (!rec) {
    rec = { id: db.nextId('cls'), firmaId: fid, period, steps: {}, validari: {}, aprobare: null, fortata: null, closedAt: null, closedBy: null };
    d.closings.push(rec);
  }
  rec.steps = rec.steps || {};
  rec.validari = rec.validari || {};
  return rec;
}

/** Vederea completa a lunii (motorul + numele utilizatorilor firmei pentru responsabili). */
function state(fid, period, opts) {
  fid = reqFirma(fid);
  period = reqPeriod(period);
  const d = db.get();
  return mc.status(d, db.scoped(fid), period, Object.assign({ users: firmUsers(fid) }, opts || {}));
}

/** Utilizatorii care pot fi responsabili: cei cu acces la firma + administratorii. */
function firmUsers(fid) {
  // proiectie marginita: lista alimenteaza un selector de responsabil, deci o taiere la plafon e
  // inofensiva functional — dar capList o si logheaza, ca sa nu fie tacuta daca se intampla
  return capList(db.get().users
    .filter((u) => !u.pending && (u.role === 'admin' || (Array.isArray(u.firme) && u.firme.includes(Number(fid)))))
    .map((u) => ({ id: u.id, username: u.username, role: u.role })), 0, 'inchidere.responsabili').items;
}

/** Aloca un pas: responsabil (cont din firma), termen si nota. Campurile absente raman neatinse. */
function setStep(fid, period, step, b, user) {
  fid = reqFirma(fid); period = reqPeriod(period); step = reqStep(step);
  if (user) permissions.assert(user, fid, 'write', db.getFirma(fid));
  b = b || {};
  const rec = ensureRecord(fid, period);
  const cur = rec.steps[step] || {};
  if ('responsabilId' in b) {
    if (b.responsabilId === null || b.responsabilId === '') delete cur.responsabilId;
    else {
      const uid = Number(b.responsabilId);
      if (!firmUsers(fid).some((u) => u.id === uid)) fail(400, 'Responsabilul trebuie să fie un utilizator cu acces la firmă.');
      cur.responsabilId = uid;
    }
  }
  if ('due' in b) {
    if (b.due === null || b.due === '') delete cur.due; // revine la termenul implicit (derivat)
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.due))) fail(400, 'Termenul trebuie să fie o dată (YYYY-MM-DD).');
    else cur.due = String(b.due);
  }
  if ('nota' in b) {
    const n = String(b.nota == null ? '' : b.nota).slice(0, 300);
    if (n) cur.nota = n; else delete cur.nota;
  }
  if (user) {
    cur.updatedBy = user.id == null ? null : user.id;
    cur.updatedByName = String(user.username || '').slice(0, 80);
    cur.updatedAt = new Date().toISOString();
  }
  if (Object.keys(cur).length) rec.steps[step] = cur; else delete rec.steps[step];
  db.save();
  return state(fid, period);
}

/** Urmele de pregatire ale utilizatorului in luna pe care ar urma sa o aprobe. Nu deducem
 * contributia din rol, ci din dovezile persistente: articole, banca, pasi, validari si XML-uri. */
function monthContributions(fid, period, user) {
  fid = reqFirma(fid); period = reqPeriod(period);
  const uid = Number(user && user.id); const username = String(user && user.username || '');
  if (!Number.isFinite(uid) || uid <= 0) return [];
  const d = db.get(); const out = [];
  const add = (kind, id, label) => out.push({ kind, id, label });
  for (const e of (d.entries || [])) {
    if (Number(e.firmaId) === Number(fid) && String(e.period || periodOf(e.data)) === period
        && Number(e.createdBy) === uid) add('entry', e.id, e.document || e.tipNume || e.tip || ('Articol ' + e.id));
  }
  for (const tx of (d.bankTransactions || [])) {
    if (Number(tx.firmaId) !== Number(fid) || String(tx.bookingDate || '').slice(0, 7) !== period) continue;
    if ((tx.statusHistory || []).some((h) => Number(h.by) === uid)) add('bank', tx.id, tx.externalId || tx.description || ('Tranzactie ' + tx.id));
  }
  const rec = mc.findRecord(d, fid, period);
  if (rec) {
    for (const [key, step] of Object.entries(rec.steps || {})) {
      if (Number(step.updatedBy) === uid) add('step', key, 'Pas cockpit: ' + key);
    }
    for (const [tip, val] of Object.entries(rec.validari || {})) {
      if (Number(val.by) === uid) add('validation', tip, 'Validare ' + tip.toUpperCase());
    }
    for (const [key, val] of Object.entries(rec.operationalEvidence || {})) {
      if (Number(val.by) === uid) add('evidence', key, 'Dovada operationala: ' + key);
    }
  }
  for (const row of (d.declarations || [])) {
    if (Number(row.firmaId) === Number(fid) && String(row.period) === period
        && username && String(row.updatedBy || '') === username) add('declaration', row.id || row.tip, 'Declaratie ' + String(row.tip || '').toUpperCase());
  }
  // Raspunsul HTTP ramane marginit; numarul total nu influenteaza verdictul (orice urma ajunge).
  return out.slice(0, 50);
}

/** Aplica maker-checker pe aprobarea lunii si intoarce metadatele derogarii, daca exista. */
function approvalException(fid, period, user, options) {
  options = options || {};
  const contributii = monthContributions(fid, period, user);
  if (!contributii.length) {
    if (options.override) fail(400, 'Override-ul nu este necesar: nu exista contributii proprii detectate in aceasta luna.');
    return null;
  }
  if (!options.override) {
    fail(409, 'Nu iti poti aproba propria luna: exista operatiuni pregatite sau validate de tine. Aprobarea trebuie data de alta persoana.',
      'SELF_APPROVAL_REQUIRED', { contributions: contributii });
  }
  permissions.assert(user, fid, 'control.override', db.getFirma(fid));
  const motiv = String(options.motiv || '').trim();
  if (motiv.length < 10) fail(400, 'Exceptia de la separarea atributiilor cere un motiv scris de minimum 10 caractere.');
  return { type: 'self_approval', motiv: motiv.slice(0, 500), by: user.id, username: user.username || '',
    at: new Date().toISOString(), contributions: contributii };
}

/** Dovada operationala pentru un calcul executat corect, dar fara nota (de ex. reevaluare cu
 * diferenta zero). Este legata de amprenta perioadei; orice modificare contabila o invalideaza. */
function recordOperationalEvidence(fid, period, step, payload, user) {
  fid = reqFirma(fid); period = reqPeriod(period); step = reqStep(step);
  if (user) permissions.assert(user, fid, 'entry.validate', db.getFirma(fid));
  if (step !== 'reevaluare_valutara') fail(400, 'Acest pas nu acceptă dovadă operațională fără articol.');
  const body = payload || {};
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const currentHash = mc.periodFingerprint(db.scoped(fid), period);
  let rec = mc.findRecord(db.get(), fid, period);
  const old = rec && rec.operationalEvidence && rec.operationalEvidence[step];
  if (old && old.sourceHash === currentHash && old.payloadHash === payloadHash) return { evidence: old, idempotent: true };
  db.assertPeriodOpen(fid, period, 'Consemnarea dovezii operaționale pentru ' + step);
  rec = rec || ensureRecord(fid, period);
  rec.operationalEvidence = rec.operationalEvidence || {};
  rec.operationalEvidence[step] = {
    kind: 'diferenta_zero', at: new Date().toISOString(), by: user ? user.id : null,
    username: user ? user.username : '', sourceHash: currentHash, payloadHash,
  };
  db.save();
  return { evidence: rec.operationalEvidence[step], idempotent: false };
}

/**
 * Ruleaza validarea pre-depunere a unei declaratii si PASTREAZA verdictul ca dovada.
 * Dovada e datata si semnata (cine a rulat-o) — asta e „dovada validarii" din dosarul lunii.
 * Verdictul se recalculeaza la fiecare apel: nu se poate falsifica marcand doar un bifat.
 */
function validateDeclaration(fid, period, tip, user) {
  fid = reqFirma(fid); period = reqPeriod(period);
  if (user) permissions.assert(user, fid, 'entry.validate', db.getFirma(fid));
  if (!declCheck.TYPES.includes(String(tip))) fail(400, 'Tip de declarație necunoscut: ' + tip + '.');
  const v = db.scoped(fid);
  const rezultat = declCheck.validateFor(v, String(tip), { period, year: period.slice(0, 4) });
  const rec = ensureRecord(fid, period);
  rec.validari[String(tip)] = {
    at: new Date().toISOString(),
    by: user ? user.id : null,
    username: user ? user.username : '',
    ok: !!rezultat.ok,
    errors: (rezultat.errors || []).length,
    warnings: (rezultat.warnings || []).length,
    mesaje: (rezultat.errors || []).slice(0, 10),
    contentHash: rezultat.contentHash || null,
    sourceHash: mc.periodFingerprint(v, period),
  };
  db.save();
  return { rezultat, state: state(fid, period) };
}

/** Aprobarea lunii: asumare explicita, cu numele si momentul. Refuzata cat timp mai sunt blocaje. */
function approve(fid, period, user, nota, options) {
  fid = reqFirma(fid); period = reqPeriod(period);
  if (user) permissions.assert(user, fid, 'close.approve', db.getFirma(fid));
  if (nota && typeof nota === 'object') { options = nota; nota = options.nota; }
  options = options || {};
  const st = state(fid, period);
  const inaintea = st.steps.filter((s) => !['aprobare', 'blocare'].includes(s.key) && s.stare !== 'gata' && s.stare !== 'nuseaplica');
  if (inaintea.length) {
    fail(400, 'Nu poți aproba luna cât timp sunt pași nerezolvați: ' + inaintea.map((s) => s.nume).join(', ') + '.');
  }
  const rec = ensureRecord(fid, period);
  const contentHash = mc.approvalFingerprint(db.get(), db.scoped(fid), period);
  // Retry-ul aceleiasi aprobari este idempotent: nu fabrica un nou eveniment istoric.
  if (rec.aprobare && rec.aprobare.contentHash === contentHash) return state(fid, period);
  const exceptie = approvalException(fid, period, user, options);
  if (rec.aprobare) {
    rec.aprobariAnterioare = Array.isArray(rec.aprobariAnterioare) ? rec.aprobariAnterioare : [];
    rec.aprobariAnterioare.push(Object.assign({}, rec.aprobare, { inlocuitaLa: new Date().toISOString() }));
  }
  rec.aprobare = {
    by: user ? user.id : null,
    username: user ? user.username : '',
    at: new Date().toISOString(),
    nota: String(nota == null ? '' : nota).slice(0, 300),
    contentHash,
    exceptie,
  };
  db.save();
  return state(fid, period);
}

/** Retragerea aprobarii (cat timp luna NU e inca blocata) — o luna blocata se redeschide din Setari. */
function unapprove(fid, period, user) {
  fid = reqFirma(fid); period = reqPeriod(period);
  if (user) permissions.assert(user, fid, 'close.approve', db.getFirma(fid));
  const rec = mc.findRecord(db.get(), fid, period);
  if (!rec || !rec.aprobare) fail(400, 'Luna nu e aprobată.');
  const st = state(fid, period);
  if (st.inchisa) fail(400, 'Luna e deja blocată — deblocheaz-o din Setări → Blocare perioadă înainte de a retrage aprobarea.');
  rec.aprobare = null;
  db.save();
  return state(fid, period);
}

/**
 * INCHIDEREA: blocheaza perioada (read-only) si dateaza dosarul lunii.
 * Cu blocaje deschise se refuza — si doar administratorul o poate forta, obligatoriu cu motiv,
 * ramane pe dosarul lunii (si in audit, prin ruta). Fortarea e o exceptie explicabila, nu o
 * portita tacuta: fara motiv scris nu se intampla.
 */
function close(fid, period, user, b) {
  fid = reqFirma(fid); period = reqPeriod(period);
  if (user) permissions.assert(user, fid, 'close.manage', db.getFirma(fid));
  b = b || {};
  const st = state(fid, period);
  // Retry-ul ultimei actiuni este succes idempotent, nu eroare si nu un al doilea audit.
  if (st.finalizata) return { state: st, fortata: !!st.fortata, lockedUntil: st.lockedUntil, idempotent: true };
  const force = !!b.force;
  if (!st.sePoateInchide) {
    if (!force) {
      fail(400, 'Luna nu poate fi închisă: ' + st.blocante.map((x) => x.nume).join(', ')
        + '. Rezolva pasii sau cere administratorului sa forteze inchiderea cu motiv.');
    }
    permissions.assert(user, fid, 'control.override', db.getFirma(fid));
    const motiv = String(b.motiv || '').trim();
    if (motiv.length < 10) fail(400, 'Forțarea închiderii cere un motiv scris (minim 10 caractere) — rămâne pe dosarul lunii.');
  }
  const rec = ensureRecord(fid, period);
  const firma = db.getFirma(fid);
  if (!firma.lockedUntil || firma.lockedUntil < period) firma.lockedUntil = period;
  rec.closedAt = new Date().toISOString();
  rec.closedBy = user ? user.id : null;
  rec.closedByName = user ? user.username : '';
  rec.fortata = (!st.sePoateInchide && force)
    ? { motiv: String(b.motiv || '').trim().slice(0, 500), by: user ? user.id : null, username: user ? user.username : '', at: new Date().toISOString(), blocante: st.blocante.map((x) => x.nume) }
    : null;
  db.save();
  return { state: state(fid, period), fortata: !!rec.fortata, lockedUntil: firma.lockedUntil, idempotent: false };
}

/** Declaratiile asteptate ale lunii care se pot valida (pentru butoanele din cockpit). */
function validatableTypes(fid, period) {
  fid = reqFirma(fid); period = reqPeriod(period);
  const anuale = new Set(['d101', 'd107', 'd205', 'bilant']);
  return decl.expectedForFirma(db.scoped(fid), period)
    .filter((e) => !anuale.has(e.tip))
    .filter((e) => declCheck.TYPES.includes(e.tip))
    .map((e) => ({ tip: e.tip, nume: e.nume, due: e.due }));
}

module.exports = { state, setStep, recordOperationalEvidence, validateDeclaration, approve, unapprove, close,
  firmUsers, validatableTypes, monthContributions, approvalException };
