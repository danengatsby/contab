'use strict';

// Matricea UNICA de permisiuni pe firma. Rolul global (`admin`/`user`) spune cine administreaza
// instalarea; rolul de mai jos spune ce poate face un colaborator in firma concreta. Orice ruta
// sensibila trebuie sa foloseasca una dintre actiunile de aici, nu sa deduca dreptul din simplul
// fapt ca utilizatorul poate scrie documente contabile.

const ACTIONS = [
  { key: 'read', label: 'Vizualizare date contabile' },
  { key: 'write', label: 'Operare documente contabile' },
  { key: 'payroll.read', label: 'Vizualizare salarii' },
  { key: 'payroll.write', label: 'Operare salarii' },
  { key: 'treasury.read', label: 'Vizualizare trezorerie' },
  { key: 'treasury.write', label: 'Pregatire operatiuni de trezorerie' },
  { key: 'treasury.approve', label: 'Aprobare/postare trezorerie' },
  { key: 'entry.validate', label: 'Validare articole' },
  { key: 'entry.approve', label: 'Aprobare articole' },
  { key: 'entry.post', label: 'Postare articole' },
  { key: 'declaration.prepare', label: 'Pregatire declaratii' },
  { key: 'declaration.approve', label: 'Aprobare document declaratie' },
  { key: 'declaration.submit', label: 'Confirmare/transmitere declaratii' },
  { key: 'fiscal.manage', label: 'Administrare profil si configurare fiscala' },
  { key: 'balance.category.confirm', label: 'Confirmare categorie bilant' },
  { key: 'close.approve', label: 'Aprobare luna' },
  { key: 'close.manage', label: 'Inchidere luna' },
  { key: 'annual.manage', label: 'Inchidere si arhivare anuala' },
  { key: 'data.export', label: 'Export date si documente' },
  { key: 'control.override', label: 'Aprobare exceptii de control' },
  { key: 'period.lock', label: 'Blocare/deblocare administrativa' },
  { key: 'team.manage', label: 'Gestionare colaboratori' },
];

const ALL = new Set(ACTIONS.map((a) => a.key));
const matrix = {
  vizualizare: new Set(['read']),
  operator: new Set([
    'read', 'write', 'payroll.read', 'payroll.write', 'treasury.read', 'treasury.write',
    'entry.validate', 'declaration.prepare',
  ]),
  verificator: new Set([
    'read', 'write', 'payroll.read', 'payroll.write', 'treasury.read', 'treasury.write',
    'treasury.approve', 'entry.validate', 'entry.approve', 'declaration.prepare', 'data.export',
  ]),
  aprobator: new Set([
    'read', 'write', 'payroll.read', 'payroll.write', 'treasury.read', 'treasury.write',
    'treasury.approve', 'entry.validate', 'entry.approve', 'entry.post',
    'declaration.prepare', 'declaration.approve', 'declaration.submit', 'fiscal.manage', 'balance.category.confirm',
    'close.approve', 'close.manage', 'annual.manage', 'data.export',
  ]),
  // Exceptiile de control si deblocarea administrativa raman la administratorul instalatiei;
  // proprietarul poate aproba/inchide normal, dar nu isi acorda singur derogari.
  proprietar: new Set([...ALL].filter((x) => !['control.override', 'period.lock'].includes(x))),
  administrator: ALL,
};
const ROLES = ['vizualizare', 'operator', 'verificator', 'aprobator', 'proprietar', 'administrator'];

// Alias numai pentru apelurile vechi din extensii/instalari. Matricea publicata si codul nou
// folosesc exclusiv numele canonic `fiscal.manage`.
const ALIASES = { 'profile.manage': 'fiscal.manage' };
function canonical(action) { return ALIASES[action] || action; }

function roleFor(user, fid, firma) {
  if (!user) return null;
  if (user.role === 'admin') return 'administrator';
  if (firma && Number(firma.ownerId) === Number(user.id)) return 'proprietar';
  const roles = user.firmaRoluri || {};
  const explicit = roles[String(fid)] || roles[fid];
  if (explicit) return explicit;
  const member = Array.isArray(user.firme) && user.firme.some((id) => Number(id) === Number(fid));
  if (!member) return null;
  // Rolurile istorice sunt materializate o singura data de migrarea v7. Dupa acel punct, o
  // absenta nu mai poate insemna implicit aprobare/postare/inchidere: membrul ramane strict la
  // vizualizare pana cand proprietarul sau administratorul ii atribuie explicit alt rol.
  return 'vizualizare';
}

function verdict(user, fid, requestedAction, firma) {
  const action = canonical(requestedAction);
  if (!ALL.has(action)) return { ok: false, role: roleFor(user, fid, firma), reason: 'Actiune de permisiune necunoscuta: ' + requestedAction };
  const role = roleFor(user, fid, firma);
  if (!role || !matrix[role]) return { ok: false, role, reason: 'Nu ai un rol activ pe aceasta firma.' };
  const rights = user && user.drepturi || {};
  if (rights.faraSalarii && action.startsWith('payroll.')) {
    return { ok: false, role, reason: 'Nu ai acces la modulul de salarizare (drept restrictionat de administrator).' };
  }
  // `readonly` permite citirea si exportul numai daca rolul de firma le acorda deja. Pregatirea
  // unei declaratii nu este citire: creeaza si amprenteaza artefactul in registrul depunerilor.
  const readOnlyActions = ['read', 'payroll.read', 'treasury.read', 'data.export'];
  if (rights.readonly && !readOnlyActions.includes(action)) {
    return { ok: false, role, reason: 'Cont doar-citire: poti vizualiza datele, dar nu le poti modifica.' };
  }
  if (!matrix[role].has(action)) {
    return { ok: false, role, reason: 'Rolul „' + role + '” nu permite actiunea „' + action + '”.' };
  }
  return { ok: true, role, action };
}

function can(user, fid, action, firma) { return verdict(user, fid, action, firma).ok; }

function assert(user, fid, action, firma) {
  const v = verdict(user, fid, action, firma);
  if (!v.ok) { const e = new Error(v.reason); e.status = 403; e.permission = canonical(action); throw e; }
  return v;
}

/**
 * Permisiunile transversale cerute de o ruta. Catalog pur si testabil; serviciile critice
 * dubleaza verificarea, ca un apel intern sa nu poata ocoli middleware-ul.
 */
function requiredActions(method, path, body) {
  method = String(method || 'GET').toUpperCase(); path = String(path || ''); body = body || {};
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(method); const out = new Set();
  const add = (action) => out.add(action);

  const payroll = /^\/(?:api\/(?:angajati|stat-plata|registru-salarii|dosar-cm)|pdf\/(?:stat-plata|fluturas|adeverinta|registru-salarii|dosar-cm)|xml\/d112)(?:\/|$)/;
  if (payroll.test(path)) add(safe ? 'payroll.read' : 'payroll.write');

  if (/^\/api\/bank(?:\/|$)/.test(path)) {
    if (safe) add('treasury.read');
    else if (/^\/api\/bank\/(?:import|transactions\/[^/]+\/exclude)$/.test(path)) add('treasury.approve');
    else add('treasury.write');
  }
  if (/^\/api\/plati(?:\/|$)/.test(path)) add(safe ? 'treasury.read' : 'treasury.write');
  if (!safe && (path === '/api/open-items/allocate' || path === '/api/reconcile/link')) add('treasury.write');
  if (/^\/api\/(?:cashbook|cash-valuta|cash-control)(?:\/|$)/.test(path)) add('treasury.read');
  if (/^\/api\/cash-forecast(?:\/|$)/.test(path)) add(safe ? 'treasury.read' : 'treasury.write');
  if (path === '/pdf/cash-forecast-13-weeks') add('treasury.read');
  if (path === '/xml/pain001' || path === '/api/stat-plata/pay') add('treasury.approve');

  if (/^\/xml\//.test(path) && path !== '/xml/pain001') add('declaration.prepare');
  if (/^\/api\/declarations\/(?:recipisa-file|artifact-file)$/.test(path)) add(safe ? 'data.export' : 'declaration.submit');
  if (path === '/api/declarations/approve') add('declaration.approve');
  if (path === '/api/declarations/confirm-filed') add('declaration.submit');
  if (path === '/api/declarations/rectificativa') add('declaration.submit');
  if (path === '/api/declarations/set') add(body.status === 'generata' ? 'declaration.prepare' : 'declaration.submit');
  if (/^\/api\/anaf\/send(?:\/|$)/.test(path)) add('declaration.submit');
  if (/^\/api\/anaf\/(?:status|download|poll|inbox|spv-mesaje|spv-descarca)(?:\/|$)/.test(path)) add('declaration.prepare');
  if (/^\/api\/anaf\/(?:config|authorize|callback|fisa-rol)(?:\/|$)/.test(path)) add('fiscal.manage');
  if (/^\/api\/etransport\/send(?:\/|$)/.test(path)) add('declaration.submit');
  if (/^\/api\/etransport\/(?:validate|status)(?:\/|$)/.test(path)) add('declaration.prepare');
  if (!safe && /^\/api\/(?:fiscal-profile|balance-category)(?:\/|$)/.test(path)) add('fiscal.manage');
  if (!safe && /^\/api\/balance-sheet-mappings(?:\/|$)/.test(path)) add('fiscal.manage');
  if (!safe && /^\/api\/balance-sheet-adjustments(?:\/|$)/.test(path)) add('declaration.approve');

  if (/^\/api\/monthly-close\/(?:approve|unapprove)$/.test(path)) add('close.approve');
  if (path === '/api/monthly-close/close') add('close.manage');
  if (!safe && /^\/api\/(?:close-year|close-profit-tax|distribute-result|annual-inventory-control|dosar-anual\/seal)(?:\/|$)/.test(path)) add('annual.manage');

  // Exportul este un drept distinct chiar daca transportul este HTTP GET. PDF-urile salariale
  // cer cumulativ si payroll.read; cele de casa/banca cer si treasury.read.
  if (/^\/(?:csv|pdf)\//.test(path) || path === '/api/dosar-anual') add('data.export');

  return [...out];
}

function describe() {
  return {
    roles: ROLES.map((role) => ({ role, actions: ACTIONS.map((a) => ({ key: a.key, label: a.label, allowed: matrix[role].has(a.key) })) })),
    actions: ACTIONS.map((a) => Object.assign({}, a)),
  };
}

module.exports = { ACTIONS, ROLES, roleFor, verdict, can, assert, requiredActions, describe };
