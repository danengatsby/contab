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
// blocaje deschise e ADMIN + motiv obligatoriu. Erorile de business poarta `err.status`.

const db = require('./db');
const mc = require('./monthlyClose');
const decl = require('./declarations');
const declCheck = require('./declarationCheck');
const { reqFirma } = require('./stocksService');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

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
  return db.get().users
    .filter((u) => !u.pending && (u.role === 'admin' || (Array.isArray(u.firme) && u.firme.includes(Number(fid)))))
    .map((u) => ({ id: u.id, username: u.username, role: u.role }));
}

/** Aloca un pas: responsabil (cont din firma), termen si nota. Campurile absente raman neatinse. */
function setStep(fid, period, step, b) {
  fid = reqFirma(fid); period = reqPeriod(period); step = reqStep(step);
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
  if (Object.keys(cur).length) rec.steps[step] = cur; else delete rec.steps[step];
  db.save();
  return state(fid, period);
}

/**
 * Ruleaza validarea pre-depunere a unei declaratii si PASTREAZA verdictul ca dovada.
 * Dovada e datata si semnata (cine a rulat-o) — asta e „dovada validarii" din dosarul lunii.
 * Verdictul se recalculeaza la fiecare apel: nu se poate falsifica marcand doar un bifat.
 */
function validateDeclaration(fid, period, tip, user) {
  fid = reqFirma(fid); period = reqPeriod(period);
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
  };
  db.save();
  return { rezultat, state: state(fid, period) };
}

/** Aprobarea lunii: asumare explicita, cu numele si momentul. Refuzata cat timp mai sunt blocaje. */
function approve(fid, period, user, nota) {
  fid = reqFirma(fid); period = reqPeriod(period);
  const st = state(fid, period);
  const inaintea = st.steps.filter((s) => !['aprobare', 'blocare'].includes(s.key) && s.stare !== 'gata' && s.stare !== 'nuseaplica');
  if (inaintea.length) {
    fail(400, 'Nu poți aproba luna cât timp sunt pași nerezolvați: ' + inaintea.map((s) => s.nume).join(', ') + '.');
  }
  const rec = ensureRecord(fid, period);
  rec.aprobare = {
    by: user ? user.id : null,
    username: user ? user.username : '',
    at: new Date().toISOString(),
    nota: String(nota == null ? '' : nota).slice(0, 300),
  };
  db.save();
  return state(fid, period);
}

/** Retragerea aprobarii (cat timp luna NU e inca blocata) — o luna blocata se redeschide din Setari. */
function unapprove(fid, period) {
  fid = reqFirma(fid); period = reqPeriod(period);
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
 * Cu blocaje deschise se refuza — si doar un ADMIN o poate forta, obligatoriu cu motiv, care
 * ramane pe dosarul lunii (si in audit, prin ruta). Fortarea e o exceptie explicabila, nu o
 * portita tacuta: fara motiv scris nu se intampla.
 */
function close(fid, period, user, b) {
  fid = reqFirma(fid); period = reqPeriod(period);
  b = b || {};
  const st = state(fid, period);
  // Doar o luna deja FINALIZATA prin flux se respinge. O luna doar `inchisa` (blocata) poate ajunge
  // asa si pe scurtatura veche — marcarea unei declaratii ca depusa blocheaza automat perioada —
  // caz in care inchiderea de aici nu mai are ce bloca, dar tot trebuie sa consemneze dosarul
  // (cine a inchis, cand, si daca a fost fortata). Gardele de mai jos raman aceleasi.
  if (st.finalizata) fail(400, 'Luna ' + period + ' este deja închisă.');
  const force = !!b.force;
  if (!st.sePoateInchide) {
    if (!force) {
      fail(400, 'Luna nu poate fi închisă: ' + st.blocante.map((x) => x.nume).join(', ')
        + '. Rezolvă pașii sau cere unui administrator să forțeze închiderea cu motiv.');
    }
    if (!user || user.role !== 'admin') fail(403, 'Doar un administrator poate forța închiderea peste pași nerezolvați.');
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
  return { state: state(fid, period), fortata: !!rec.fortata, lockedUntil: firma.lockedUntil };
}

/** Declaratiile asteptate ale lunii care se pot valida (pentru butoanele din cockpit). */
function validatableTypes(fid, period) {
  fid = reqFirma(fid); period = reqPeriod(period);
  return decl.expectedForFirma(db.scoped(fid), period)
    .filter((e) => declCheck.TYPES.includes(e.tip))
    .map((e) => ({ tip: e.tip, nume: e.nume, due: e.due }));
}

module.exports = { state, setStep, validateDeclaration, approve, unapprove, close, firmUsers, validatableTypes };
