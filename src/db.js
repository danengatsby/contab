'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const migrations = require('./migrations');
const { stringifyDb, naturalCompare } = require('./util');

// CONTAB_DATA_DIR: izolare pentru teste (backup/restore, uploads) — implicit data/ din repo.
const DATA_DIR = process.env.CONTAB_DATA_DIR || path.join(__dirname, '..', 'data');

// Driver de persistenta: 'pg'/'postgres' (PostgreSQL), 'sqlite' sau 'json' (vechi — rollback rapid).
const DRIVER_RAW = (process.env.CONTAB_DB_DRIVER || 'sqlite').toLowerCase();
const DRIVER = DRIVER_RAW === 'postgres' ? 'pg' : DRIVER_RAW;
// Fisierul JSON ramane: oglinda pentru backup (cron) + rollback. Calea SQLite e derivata.
const JSON_FILE = process.env.CONTAB_DB_FILE || path.join(DATA_DIR, 'db.json');
const SQLITE_FILE = process.env.CONTAB_DB_FILE
  ? process.env.CONTAB_DB_FILE.replace(/\.json$/i, '') + '.sqlite'
  : path.join(DATA_DIR, 'contab.sqlite');
// Oglinda JSON doar pe instalarea live (nu in teste, unde CONTAB_DB_FILE e setat).
const JSON_MIRROR = (DRIVER === 'sqlite' || DRIVER === 'pg') && !process.env.CONTAB_DB_FILE && process.env.CONTAB_JSON_MIRROR !== '0';
const store = DRIVER === 'sqlite' ? require('./store') : DRIVER === 'pg' ? require('./storePg') : null;
const DB_FILE = JSON_FILE; // pastrat pentru compatibilitate (backup/restore folosesc oglinda JSON)

// Campurile firmei EDITABILE prin rutele generice de profil (/api/company, /api/firme/:id).
// Restul — lockedUntil (perioada inchisa), subscription (abonament), anaf (credentiale SPV),
// id/test/logoFile/timestamps — se ating DOAR prin rutele lor dedicate (period-lock cu
// requireAdmin, billing, anaf/config). Un Object.assign brut ar fi permis ocolirea perioadei
// inchise sau a paywall-ului si injectarea de credentiale.
const FIRMA_EDITABLE = new Set([
  'nume', 'cui', 'regCom', 'adresa', 'oras', 'judet', 'tara',                       // identificare
  'tvaPlatitor', 'tvaLaIncasare', 'tipEntitate', 'proRataTva', 'caen', 'perioadaTva', 'capitalSocial', // profil fiscal
  'regimImpozit', 'd406Cadenta', 'intrastatObligat', 'scutiri',                     // motor profil fiscal (regim, cadenta D406, Intrastat, exceptii)
  'autoPostDocumente',                                                              // postarea automata a documentelor citite (implicit oprita)
  'metodaEvaluareStoc',                                                             // evaluarea iesirilor din stoc: 'cmp' (implicit) sau 'fifo'
  'iban', 'bic', 'banca', 'cont', 'telefon', 'email', 'numeComplet', 'autorizatie',        // banca / contact / reprezentant
  'accentColor', 'pdfLayout', 'pdfFooter', 'asociatiText',                          // prezentare facturi/PDF
  // Antetul situatiilor financiare anuale (S1120/S1121). Valorile admise sunt cele din
  // validatorul oficial — vezi src/bilantNomenclator.js; codul de judet se DEDUCE din `judet`.
  'caenE', 'codTeritorial', 'formaProprietate', 'administrator',                    // identificare in bilant
  'intocmitNume', 'intocmitCalitate', 'intocmitNr',                                 // cine intocmeste (regula R26)
  'auditStatut', 'auditorNume', 'auditorNr', 'auditorCif',                          // statutul de audit
]);
/** Pastreaza din `body` DOAR campurile de profil permise (allowlist). */
function pickFirmaFields(body) {
  const out = {};
  if (body && typeof body === 'object') for (const k of Object.keys(body)) if (FIRMA_EDITABLE.has(k)) out[k] = body[k];
  return out;
}

function defaultFirma(id) {
  return {
    id: id || 1,
    nume: 'S.C. EXEMPLU PROD S.R.L.',
    cui: '12345678',
    regCom: 'J40/1234/2020',
    adresa: 'Bucuresti',
    oras: 'Bucuresti',
    judet: 'RO-B',
    tvaPlatitor: true,
  };
}

const DEFAULT_DB = {
  users: [],           // { id, username, salt, hash, role: 'admin'|'user', firme: [firmaId], firmaActiva }
  firme: [defaultFirma(1)], // tabelul de firme
  firmaActiva: 1,
  documents: [],       // { id, firmaId, ... }
  entries: [],         // { id, firmaId, ... }
  assets: [],          // { id, firmaId, denumire, cont, cost, dataPif, durataLuni, ... } - mijloace fixe
  angajati: [],        // { id, firmaId, nume, cnp, functie, salariuBrut, neimpozabil } - salarizare
  payrollHistory: [],  // { id, firmaId, period, rows:[per angajat], totals } - istoric state de plata
  products: [],        // { id, firmaId, cod, denumire, um, grupa, cont, codNC } - nomenclator produse
  gestiuni: [],        // { id, firmaId, cod, denumire, gestionar, cont } - depozite/gestiuni
  stockMovements: [],  // { id, firmaId, data, tip, productId, gestiuneId, gestiuneDestId, cantitate, pretUnitar, document }
  inventories: [],     // { id, firmaId, gestiuneId, data, lines, totaluri } - procese-verbale de inventariere
  partners: {},        // { [firmaId]: { [cui]: {...} } }
  openingBalances: {}, // { [firmaId]: { [cont]: { d, c } } }
  openingAnalytic: [], // { firmaId, cont, partener, cui, d, c }
  audit: [],           // { id, ts, userId, username, firmaId, action, detail }
  messages: [],        // { id, userId, fromAdmin, text, author, createdAt, readByUser, readByAdmin } - suport user<->admin
  recurringInvoices: [], // { id, firmaId, tip, partener, cuiPartener, fields, frecventa, ziua, activ, startDate, lastGenerated } - facturi recurente
  cursuriBnr: [],      // { id: 'YYYY-MM-DD', cursuri: { EUR: 5.231, ... } } - curs oficial BNR, GLOBAL (nu per firma)
  recipes: [],         // { id, firmaId, nume, productId, gestiuneId, cantitateBaza, costUnitar, materiale:[{productId, gestiuneId, cantitate}] } - retete/BOM productie
  budgets: [],         // { id, firmaId, an, cont, suma } - buget anual per cont (clasa 6/7)
  declarations: [],    // { id, firmaId, tip, period, status, generatedAt, submittedAt, recipisa, note } - registrul depunerilor
  closings: [],        // { id, firmaId, period, steps, validari, aprobare, fortata, closedAt } - dosarul inchiderii lunare
  extractInterventions: [], // { id, firmaId, documentId, entryId, diff, controalePicate, partener, format } - corectiile operatorului peste extragere
  customAccounts: [],  // { cod, nume, clasa, tip } - conturi personalizate (import)
  settings: {
    useAI: true,
    anaf: { env: 'test', clientId: '', clientSecret: '', redirectUri: '', cif: '', accessToken: '', refreshToken: '', tokenExpiry: 0 },
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    backup: { auto: true, lastAt: null },
    docSeries: {}, // { [firmaId]: { NIR:{serie,next}, BC:{serie,next}, AVIZ:{serie,next} } }
  },
  seq: 1,
};

let db = null;

// Revizia globala de scriere: avanseaza la FIECARE persistare (save/restore/load). E cheia de
// validitate a memo-urilor de citire din src/cache.js — o valoare calculata la revizia R ramane
// valabila exact cat timp revizia e tot R. NU se persista (e per proces): dupa restart porneste
// de la 0, cu cache-urile goale, deci nu poate „invia" un rezultat vechi.
let rev = 0;
function dataRev() { return rev; }

function chmodSafe(p, mode) {
  try { fs.chmodSync(p, mode); } catch (_) { /* platforma/permisiuni: nu masca pornirea */ }
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const up = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(up)) fs.mkdirSync(up, { recursive: true });
  // Date fiscale, salariale si documente justificative: accesibile doar contului serviciului.
  // Corecteaza si instalari vechi, nu doar fisierele create dupa acest patch.
  chmodSafe(DATA_DIR, 0o700);
  chmodSafe(up, 0o700);
  chmodSafe(path.join(DATA_DIR, 'backups'), 0o700);
  chmodSafe(path.join(DATA_DIR, 'audit'), 0o700);
  for (const f of [JSON_FILE, SQLITE_FILE]) if (fs.existsSync(f)) chmodSafe(f, 0o600);
}

/** Migreaza o baza veche (o singura firma, fara firmaId) la structura multi-firma. */
// Sigilarea secretelor operationale (parola SMTP, credentialele/token-urile SPV) cu cheia
// externa CONTAB_SECRETS_KEY. Ruleaza la FIECARE incarcare (idempotent — valorile deja
// sigilate trec neatinse), ca sa prinda si secretele salvate inainte de setarea cheii.
function sealSecrets(d) {
  const secretbox = require('./secretbox');
  if (!secretbox.hasKey()) return;
  if (d.settings && d.settings.smtp && d.settings.smtp.pass) d.settings.smtp.pass = secretbox.seal(d.settings.smtp.pass);
  for (const f of d.firme || []) {
    if (!f.anaf) continue;
    for (const k of ['clientSecret', 'accessToken', 'refreshToken']) {
      if (f.anaf[k]) f.anaf[k] = secretbox.seal(f.anaf[k]);
    }
  }
}

function migrate(d) {
  if (!d.firme && d.company) {
    const f = Object.assign({ id: 1 }, d.company);
    d.firme = [f];
    d.firmaActiva = 1;
    (d.entries || []).forEach((e) => { if (e.firmaId == null) e.firmaId = 1; });
    (d.documents || []).forEach((x) => { if (x.firmaId == null) x.firmaId = 1; });
    d.partners = { 1: d.partners || {} };
    d.openingBalances = { 1: d.openingBalances || {} };
    d.openingAnalytic = (d.openingAnalytic || []).map((o) => Object.assign({ firmaId: 1 }, o));
    delete d.company;
  }
  if (!d.firme || !d.firme.length) { d.firme = [defaultFirma(1)]; d.firmaActiva = 1; }
  if (d.firmaActiva == null) d.firmaActiva = d.firme[0].id;
  // asigura cheile pe firma
  for (const f of d.firme) {
    if (!d.partners[f.id]) d.partners[f.id] = {};
    if (!d.openingBalances[f.id]) d.openingBalances[f.id] = {};
    // Billing strict per-firma: fiecare firma are propriul abonament (firma.subscription).
    if (!f.subscription) {
      if (f.trial && f.trialEndsAt) {
        // convertesc proba per-firma introdusa anterior (f.trial/trialEndsAt/abonamente)
        f.subscription = { plan: 'trial', trialStartedAt: f.trialStartedAt || null, trialEndsAt: f.trialEndsAt, abonamente: f.abonamente || {} };
      } else if (f.abonamente && Object.keys(f.abonamente).length) {
        f.subscription = { status: 'active', plan: Object.values(f.abonamente).pop() || 'activ', since: new Date().toISOString(), abonamente: f.abonamente };
      } else {
        // firma existenta (dinainte de billing per-firma) -> pastrata activa („grandfathered")
        f.subscription = { status: 'active', plan: 'grandfathered', since: new Date().toISOString() };
      }
    }
    delete f.trial; delete f.trialStartedAt; delete f.trialEndsAt; delete f.abonamente;
  }
  d.openingAnalytic = (d.openingAnalytic || []).map((o) => (o.firmaId == null ? Object.assign({ firmaId: d.firmaActiva }, o) : o));
  // Produsele au acum un statut explicit `activ` (dezactivarea inlocuieste stergerea distructiva).
  // Backfill idempotent: cele fara camp devin active — datele raman consistente, nu se bazeaza pe
  // `activ === false` implicit (undefined).
  for (const p of d.products || []) { if (p.activ == null) p.activ = true; }
  // utilizatori + secret de sesiune
  if (!d.settings) d.settings = JSON.parse(JSON.stringify(DEFAULT_DB.settings));
  if (!d.settings.authSecret) d.settings.authSecret = crypto.randomBytes(32).toString('hex');
  // Conexiunea SPV a devenit PER-FIRMA (multi-tenant): config-ul global istoric se muta
  // pe firma cu CUI-ul potrivit (altfel pe firma activa) si dispare din settings.
  if (d.settings.anaf) {
    const a = d.settings.anaf;
    const digits = (s) => String(s || '').replace(/\D/g, '');
    const target = (digits(a.cif) && d.firme.find((f) => digits(f.cui) === digits(a.cif)))
      || d.firme.find((f) => f.id === d.firmaActiva) || d.firme[0];
    if (target && !target.anaf && (a.clientId || a.cif)) target.anaf = a;
    delete d.settings.anaf;
  }
  if (!Array.isArray(d.audit)) d.audit = [];
  if (!Array.isArray(d.messages)) d.messages = [];
  if (!Array.isArray(d.recipes)) d.recipes = [];
  if (!Array.isArray(d.budgets)) d.budgets = [];
  if (!Array.isArray(d.recurringInvoices)) d.recurringInvoices = [];
  if (!Array.isArray(d.cursuriBnr)) d.cursuriBnr = [];
  if (!Array.isArray(d.declarations)) d.declarations = [];
  if (!Array.isArray(d.closings)) d.closings = [];
  if (!Array.isArray(d.extractInterventions)) d.extractInterventions = [];
  if (!Array.isArray(d.customAccounts)) d.customAccounts = [];
  if (!Array.isArray(d.assets)) d.assets = [];
  if (!Array.isArray(d.angajati)) d.angajati = [];
  if (!Array.isArray(d.payrollHistory)) d.payrollHistory = [];
  if (!Array.isArray(d.products)) d.products = [];
  if (!Array.isArray(d.gestiuni)) d.gestiuni = [];
  if (!Array.isArray(d.stockMovements)) d.stockMovements = [];
  if (!Array.isArray(d.inventories)) d.inventories = [];
  if (!Array.isArray(d.users)) d.users = [];
  if (!d.users.length) {
    const { salt, hash } = auth.hashPassword('admin');
    d.users.push({ id: 1, username: 'admin', salt, hash, role: 'admin', firme: [], firmaActiva: d.firmaActiva, mustChange: true });
    console.log('[contab] utilizator initial creat: admin / admin — schimba parola din Setari!');
  }
  // Securitate: orice cont care are INCA parola implicita „admin" este obligat sa o schimbe
  // (re-armeaza flagul chiar daca a fost stins candva fara schimbarea reala a parolei).
  for (const u of d.users) {
    if (auth.verifyPassword('admin', u.salt, u.hash)) {
      if (!u.mustChange) console.log('[contab] cont cu parola implicita „admin": ' + u.username + ' — schimbare fortata la urmatoarea autentificare.');
      u.mustChange = true;
    }
  }
  // Dupa normalizarea de baza (idempotenta), aplica pasii de migrare VERSIONATI (o singura data,
  // urmariti prin d.schemaVersion). migrate() e apelat pe toate caile de load -> un singur hook.
  migrations.runMigrations(d);
  sealSecrets(d);
  return d;
}

function applyDefaults(d) {
  d = Object.assign({}, DEFAULT_DB, d || {});
  d.settings = Object.assign({}, DEFAULT_DB.settings, d.settings || {});
  return d;
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, stringifyDb(data, 2));
  fs.renameSync(tmp, file);
  chmodSafe(file, 0o600);
}
function backupLegacyJson() {
  try {
    const bak = path.join(DATA_DIR, DRIVER === 'pg' ? 'db.pre-pg.json' : 'db.pre-sqlite.json');
    if (!fs.existsSync(bak) && fs.existsSync(JSON_FILE)) fs.copyFileSync(JSON_FILE, bak);
  } catch (_) { /* best-effort */ }
}

// Driver vechi (rollback prin CONTAB_DB_DRIVER=json): persistenta pur JSON, atomica.
// Nimic nu mai ruleaza implicit pe el (teste/dev/productie sunt pe sqlite/pg) — doar cale
// de intoarcere de urgenta; avertizeaza ca sa nu ramana o instanta uitata pe el.
function loadJson() {
  console.warn('[contab] ATENTIE: driverul JSON e pastrat doar ca rollback (vechi). Foloseste sqlite (implicit) sau pg.');
  if (fs.existsSync(JSON_FILE)) {
    try { db = migrate(applyDefaults(JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')))); }
    catch (e) { db = JSON.parse(JSON.stringify(DEFAULT_DB)); }
  } else {
    // fisier nou: migrate() creeaza utilizatorul initial admin/admin + authSecret
    // (fara el, prima pornire ramanea fara cont si fara semnarea sesiunilor)
    db = migrate(applyDefaults({}));
    writeJson(JSON_FILE, db);
  }
  return db;
}

// Driver PostgreSQL (async): load() intoarce o PROMISIUNE — serverul o asteapta la pornire
// (bootstrap in server.js). Aceeasi migrare unica din db.json ca la trecerea pe SQLite.
async function loadPg() {
  rev += 1; // (re)hidratare: baza din RAM se schimba sub picioarele memo-urilor
  await store.open();
  if (await store.isEmpty()) {
    if (fs.existsSync(JSON_FILE)) {
      // Migrare unica din fisierul JSON (instalare live sau baza de test pregatita cu CONTAB_DB_FILE).
      let legacy = {};
      try { legacy = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); } catch (_) { legacy = {}; }
      db = migrate(applyDefaults(legacy));
      if (!process.env.CONTAB_DB_FILE) {
        backupLegacyJson();
        console.log('[contab] Migrare unica db.json -> PostgreSQL efectuata (copie de siguranta: data/db.pre-pg.json).');
      }
    } else {
      db = migrate(applyDefaults({}));
    }
    await store.persist(db);
  } else {
    db = migrate(applyDefaults(await store.hydrate(DEFAULT_DB)));
    await store.persist(db); // persista eventualele normalizari migrate() + initializeaza dirty-tracking
  }
  if (JSON_MIRROR) writeJson(JSON_FILE, db);
  return db;
}

function load() {
  ensureDir();
  rev += 1; // (re)hidratare: baza din RAM se schimba sub picioarele memo-urilor
  if (DRIVER === 'pg') return loadPg();
  if (DRIVER !== 'sqlite') return loadJson();
  store.open(SQLITE_FILE);
  if (store.isEmpty()) {
    // Baza SQLite proaspata.
    if (fs.existsSync(JSON_FILE)) {
      // Import unic din fisierul JSON (instalare live sau baza de test pregatita cu CONTAB_DB_FILE).
      let legacy = {};
      try { legacy = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); } catch (_) { legacy = {}; }
      db = migrate(applyDefaults(legacy));
      if (!process.env.CONTAB_DB_FILE) {
        backupLegacyJson();
        console.log('[contab] Migrare unica db.json -> SQLite efectuata (copie de siguranta: data/db.pre-sqlite.json).');
      }
    } else {
      // instalare noua / teste — migrate() creeaza utilizatorul initial admin/admin + authSecret
      // (fara el, prima pornire pe SQLite gol ramanea fara niciun cont de autentificare)
      db = migrate(applyDefaults({}));
    }
    store.persist(db);
  } else {
    db = migrate(applyDefaults(store.hydrate(DEFAULT_DB)));
    store.persist(db); // persista eventualele normalizari migrate() + initializeaza dirty-tracking
  }
  if (JSON_MIRROR) writeJson(JSON_FILE, db);
  return db;
}

// Oglinda JSON se scrie cu intarziere (debounce): serializarea intregii baze la fiecare save()
// ar deveni costisitoare pe masura ce datele cresc. SQLite ramane persistat sincron, la zi.
const MIRROR_DELAY_MS = 30 * 1000;
let mirrorTimer = null;
function scheduleMirror() {
  if (mirrorTimer) return;
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    try { writeJson(JSON_FILE, db); } catch (e) { console.error('[contab] oglinda JSON:', e.message); }
  }, MIRROR_DELAY_MS);
  if (mirrorTimer.unref) mirrorTimer.unref(); // nu tine procesul in viata doar pentru oglinda
}
/** Scrie imediat oglinda JSON in asteptare (inainte de backup / la oprire). `force`: scrie
 *  chiar si cu oglinda dezactivata — backup-ul copiaza ACEST fisier, deci trebuie adus la zi,
 *  altfel arhiva ar fi un instantaneu vechi (sau inexistent) al bazei. */
function flushMirror(force) {
  if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
  if (db && (JSON_MIRROR || force)) { try { writeJson(JSON_FILE, db); } catch (e) { console.error('[contab] oglinda JSON:', e.message); } }
}

function save() {
  ensureDir();
  rev += 1; // inainte de orice iesire: si pe calea `json`, si daca driverul arunca (RAM e deja mutat)
  if (DRIVER === 'json') { writeJson(JSON_FILE, db); return; }
  store.persist(db); // sqlite: sincron; pg: fotografiaza sincron + scrie printr-o coada seriala
  if (JSON_MIRROR) scheduleMirror(); // oglinda pentru backup/rollback, scrisa cu intarziere
}

/** Asteapta scrierile in zbor ale driverului (pg are coada async; sqlite/json scriu sincron). */
function flushStore() {
  return DRIVER === 'pg' ? store.flush() : Promise.resolve();
}

// Restaurare dintr-un fisier JSON (folosita de ruta /api/restore): seteaza in memorie + persista in driver.
function restoreFromJson(jsonPath) {
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  rev += 1; // baza e INLOCUITA integral — orice memo calculat pe cea veche devine invalid
  db = migrate(applyDefaults(parsed));
  if (DRIVER !== 'json') { store.resetDirty(); store.persist(db); }
  if (JSON_MIRROR || DRIVER === 'json') writeJson(JSON_FILE, db);
  return db;
}

function get() {
  if (!db) {
    if (DRIVER === 'pg') throw new Error('Baza PostgreSQL nu e inca hidratata — porneste prin db.load() (asincron) inainte de primul get().');
    load();
  }
  return db;
}

// Aloca un id; NU salveaza — apelantul persista oricum obiectul creat (seq e in `meta`).
// Un id alocat dar nesalvat (crash inainte de save) se refoloseste fara conflict: nici
// inregistrarea care l-ar fi purtat nu a fost persistata.
function nextId(prefix) {
  const d = get();
  const id = d.seq++;
  return (prefix || '') + id;
}

// ───────────────────────── multi-firma ─────────────────────────
function firmaActiva() {
  return get().firmaActiva;
}
function getFirma(id) {
  return get().firme.find((f) => f.id === Number(id));
}

// PERIOADA INCHISA — garda unica pentru TOATE serviciile de scriere datata (articole, stocuri,
// inventare, amortizare, salarii). O luna raportata/inchisa (firma.lockedUntil, setata de admin
// prin /api/period-lock sau la inchiderea de TVA) nu se mai modifica: corectiile se fac EXCLUSIV
// prin storno intr-o perioada deschisa. `dataOriPerioada` accepta 'YYYY-MM-DD' sau 'YYYY-MM'.
function assertPeriodOpen(fid, dataOriPerioada, actiune) {
  const firma = getFirma(fid);
  const per = String(dataOriPerioada || '').slice(0, 7);
  if (firma && firma.lockedUntil && per && per <= firma.lockedUntil) {
    const e = new Error('Perioada ' + per + ' este inchisa (blocata pana la ' + firma.lockedUntil + '). '
      + (actiune || 'Operatiunea') + ' intr-o perioada inchisa se corecteaza prin STORNO intr-o perioada deschisa.');
    e.status = 400;
    throw e;
  }
}
function nextFirmaId() {
  const d = get();
  return d.firme.reduce((m, f) => Math.max(m, f.id), 0) + 1;
}
function getUser(id) {
  return get().users.find((u) => u.id === Number(id));
}
function getUserByName(name) {
  return get().users.find((u) => u.username === name);
}
function nextUserId() {
  const d = get();
  return d.users.reduce((m, u) => Math.max(m, u.id), 0) + 1;
}

/** Vedere filtrata pe o firma — consumata de modulele de raportare ca un "db". */
function scoped(firmaId) {
  const d = get();
  const id = Number(firmaId) || d.firmaActiva;
  return {
    firmaId: id,
    company: getFirma(id) || {},
    entries: d.entries.filter((e) => (e.firmaId == null ? d.firmaActiva : e.firmaId) === id),
    documents: d.documents.filter((x) => (x.firmaId == null ? d.firmaActiva : x.firmaId) === id),
    assets: (d.assets || []).filter((a) => (a.firmaId == null ? d.firmaActiva : a.firmaId) === id),
    angajati: (d.angajati || []).filter((a) => (a.firmaId == null ? d.firmaActiva : a.firmaId) === id),
    payrollHistory: (d.payrollHistory || []).filter((h) => (h.firmaId == null ? d.firmaActiva : h.firmaId) === id),
    products: (d.products || []).filter((p) => (p.firmaId == null ? d.firmaActiva : p.firmaId) === id),
    gestiuni: (d.gestiuni || []).filter((g) => (g.firmaId == null ? d.firmaActiva : g.firmaId) === id),
    stockMovements: (d.stockMovements || []).filter((m) => (m.firmaId == null ? d.firmaActiva : m.firmaId) === id),
    inventories: (d.inventories || []).filter((iv) => (iv.firmaId == null ? d.firmaActiva : iv.firmaId) === id),
    partners: d.partners[id] || {},
    openingBalances: d.openingBalances[id] || {},
    openingAnalytic: (d.openingAnalytic || []).filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === id),
    settings: d.settings,
  };
}

/** Exporta toate datele unei firme intr-un pachet portabil (migrare/arhivare). */
function exportFirma(fid) {
  const d = get();
  const id = Number(fid);
  const byFid = (arr) => (arr || []).filter((x) => (x.firmaId == null ? d.firmaActiva : x.firmaId) === id);
  // firma.anaf (credentiale OAuth + token-uri SPV) NU pleaca in export: secretele
  // raman pe instanta; o copie restaurata isi reface conexiunea din Setari.
  const firma = Object.assign({}, getFirma(id) || {});
  delete firma.anaf;
  return {
    _format: 'contab-firma-v1',
    firma,
    entries: byFid(d.entries),
    documents: byFid(d.documents),
    partners: d.partners[id] || {},
    openingBalances: d.openingBalances[id] || {},
    openingAnalytic: byFid(d.openingAnalytic),
    assets: byFid(d.assets),
    products: byFid(d.products),
    gestiuni: byFid(d.gestiuni),
    stockMovements: byFid(d.stockMovements),
    inventories: byFid(d.inventories),
    angajati: byFid(d.angajati),
    payrollHistory: byFid(d.payrollHistory),
    declarations: byFid(d.declarations),
  };
}

/**
 * Importa un pachet de firma, remapand toate id-urile si referintele interne.
 * opts.storedNameMap: { numeVechiFisier: numeNou } — la restaurarea din ZIP, fisierele scanate
 * sunt scrise pe disc sub nume noi (anti-coliziune), iar documentele importate arata spre ele.
 * opts.targetFid: SUPRASCRIE firma indicata — datele ei curente sunt sterse si inlocuite cu cele
 * din pachet (id-ul firmei si accesul utilizatorilor raman; fisierele fizice vechi raman pe disc,
 * ca restaurarile JSON care refera aceleasi fisiere sa nu ramana fara ele).
 */
function importFirma(bundle, opts) {
  const o = opts || {};
  const d = get();
  if (!bundle || !bundle.firma) throw new Error('Pachet de firma invalid.');
  let newFid;
  if (o.targetFid) {
    newFid = Number(o.targetFid);
    const f = d.firme.find((x) => x.id === newFid);
    if (!f) throw new Error('Firma tinta inexistenta.');
    for (const k of ['entries', 'documents', 'assets', 'angajati', 'payrollHistory', 'products', 'gestiuni', 'stockMovements', 'inventories', 'openingAnalytic', 'declarations']) {
      d[k] = d[k].filter((x) => (x.firmaId == null ? d.firmaActiva : x.firmaId) !== newFid);
    }
    Object.assign(f, bundle.firma, { id: newFid }); // preia datele firmei din copie, pastreaza id-ul
  } else {
    newFid = nextFirmaId();
    d.firme.push(Object.assign({}, bundle.firma, { id: newFid, nume: (bundle.firma.nume || 'Firma') + ' (import)' }));
  }
  d.partners[newFid] = JSON.parse(JSON.stringify(bundle.partners || {}));
  d.openingBalances[newFid] = JSON.parse(JSON.stringify(bundle.openingBalances || {}));
  d.openingAnalytic.push(...(bundle.openingAnalytic || []).map((o) => Object.assign({}, o, { firmaId: newFid })));

  const remap = (arr, prefix) => {
    const m = {};
    const out = (arr || []).map((x) => { const id = nextId(prefix); m[x.id] = id; return Object.assign({}, x, { id, firmaId: newFid }); });
    return { m, out };
  };
  const prod = remap(bundle.products, 'prod');
  const gest = remap(bundle.gestiuni, 'gest');
  const asset = remap(bundle.assets, 'mf');
  const ang = remap(bundle.angajati, 'ang');
  const entMap = {}; (bundle.entries || []).forEach((e) => { entMap[e.id] = nextId('e'); });
  const movMap = {}; (bundle.stockMovements || []).forEach((mv) => { movMap[mv.id] = nextId('sm'); });

  d.products.push(...prod.out); d.gestiuni.push(...gest.out); d.assets.push(...asset.out); d.angajati.push(...ang.out);

  // documente atasate (fisiere scanate): id nou + storedName remapat daca fisierul a venit din ZIP
  const docMap = {};
  for (const doc of (bundle.documents || [])) {
    const id = nextId('doc'); docMap[doc.id] = id;
    const stored = (o.storedNameMap && doc.storedName && o.storedNameMap[doc.storedName]) || doc.storedName;
    d.documents.push(Object.assign({}, doc, { id, firmaId: newFid, storedName: stored }));
  }

  for (const e of (bundle.entries || [])) d.entries.push(Object.assign({}, e, { id: entMap[e.id], firmaId: newFid, fileId: e.fileId ? (docMap[e.fileId] || null) : null, movementId: e.movementId ? movMap[e.movementId] : e.movementId }));
  for (const mv of (bundle.stockMovements || [])) {
    d.stockMovements.push(Object.assign({}, mv, {
      id: movMap[mv.id], firmaId: newFid,
      productId: prod.m[mv.productId] || mv.productId,
      gestiuneId: mv.gestiuneId ? (gest.m[mv.gestiuneId] || mv.gestiuneId) : mv.gestiuneId,
      gestiuneDestId: mv.gestiuneDestId ? (gest.m[mv.gestiuneDestId] || mv.gestiuneDestId) : mv.gestiuneDestId,
      entryId: mv.entryId ? entMap[mv.entryId] : mv.entryId,
    }));
  }
  for (const iv of (bundle.inventories || [])) {
    d.inventories.push(Object.assign({}, iv, {
      id: nextId('inv'), firmaId: newFid,
      gestiuneId: gest.m[iv.gestiuneId] || iv.gestiuneId,
      entryIds: (iv.entryIds || []).map((x) => entMap[x] || x),
      movementIds: (iv.movementIds || []).map((x) => movMap[x] || x),
      lines: (iv.lines || []).map((l) => Object.assign({}, l, { productId: prod.m[l.productId] || l.productId })),
    }));
  }
  for (const h of (bundle.payrollHistory || [])) {
    d.payrollHistory.push(Object.assign({}, h, { id: nextId('ph'), firmaId: newFid, rows: (h.rows || []).map((r) => Object.assign({}, r, { angajatId: ang.m[r.angajatId] || r.angajatId })) }));
  }
  for (const dc of (bundle.declarations || [])) d.declarations.push(Object.assign({}, dc, { id: nextId('dcl'), firmaId: newFid }));
  d.firmaActiva = newFid;
  save();
  return newFid;
}

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// ── Citiri per-cerere din SQL pentru firmele MARI (pas 5 al migrarii; RAM ramane implicit) ──
// Peste un prag de articole/firma, agregarile grele (ex. balanta) se pot calcula direct in SQL prin
// proiectia entry_lines, in loc de a itera graful din RAM. Gate pe prag REAL: sub prag, RAM e mai
// simplu si mai rapid. Driverul json (fara SQL) cade mereu pe RAM. Rezultatul e IDENTIC (dovedit in teste).
//
// PRAGUL A FOST RIDICAT 20.000 -> 100.000 (2026-07-27), pe masuratoare, nu pe intuitie: la 22.000 de
// articole pe pg (si 27.350 pe sqlite) calea SQL e mai LENTA decat RAM pe FIECARE ruta gate-uita
// (jurnal 3,9x, cartea mare 2,9x, fisa de cont 1,6x, balanta 1,2x — docs/scalare-crestere.md).
// Pragul vechi comuta pe calea mai lenta exact in clipa in care se activa. Codul SQL ramane: scopul
// lui declarat e SEAM-ul catre hidratarea lazy (reducerea RAM-ului), nu viteza; pragul spune doar
// „pe ce criteriu se activeaza". 100.000 e un prag deliberat NEMASURAT (punctul unde SQL ar castiga
// e necunoscut) — pana la o masuratoare acolo, calea implicita e cea dovedit mai rapida.
const SQL_READ_THRESHOLD = Number.isFinite(Number(process.env.CONTAB_SQL_READ_THRESHOLD)) && process.env.CONTAB_SQL_READ_THRESHOLD !== ''
  ? Number(process.env.CONTAB_SQL_READ_THRESHOLD) : 100000; // 0 e valid (forteaza SQL); gol/absent -> 100000

/** Driverul suporta citiri SQL din proiectii (pg/sqlite au linesTurnover; json nu)? */
function canSqlRead() { return !!(store && typeof store.linesTurnover === 'function'); }

/** Fencing multi-scriitor: alt proces a scris in baza (persistenta inghetata)? json -> false. */
function storeConflicted() { return !!(store && typeof store.conflicted === 'function' && store.conflicted()); }

/** Starea cozii de persistenta a driverului (vezi store*.queueStats). Pe driverul `json` nu
 *  exista coada: scrierea e sincrona in fisier, deci nimic nu asteapta niciodata. */
function persistStats() {
  if (store && typeof store.queueStats === 'function') return store.queueStats();
  return { driver: DRIVER, pending: false, pendingAgeMs: 0, pendingBytes: 0, draining: false, commits: 0, failStreak: 0, lastCommitAt: null, lastError: null, conflicted: false };
}

/** Firma are destule articole ca sa merite calculul in SQL (peste prag)? Scurt-circuit la prag. */
function largeFirma(fid) {
  if (!canSqlRead()) return false;
  const target = Number(fid);
  if (!Number.isFinite(target)) return false;
  const d = get(); let n = 0;
  for (const e of (d.entries || [])) if (Number(e.firmaId == null ? firmaActiva() : e.firmaId) === target) { n += 1; if (n > SQL_READ_THRESHOLD) return true; }
  return false;
}

/** Perioada suportata de calea SQL a balantei: YYYY sau YYYY-MM (trimestrele/gol -> RAM). */
function sqlBalancePeriodOk(period) { return typeof period === 'string' && /^\d{4}(-\d{2})?$/.test(period); }

// CITIRE-DUPA-SCRIERE pe calea SQL: pe pg, `save()` fotografiaza sincron dar COMITE printr-o coada
// asincrona, deci proiectiile (entry_lines) pot fi in urma cu cateva milisecunde. Calea RAM nu are
// problema asta (citeste chiar obiectul mutat), dar o citire SQL imediat dupa o scriere vedea starea
// DE DINAINTE — de exemplu un articol tocmai postat lipsea din balanta si din jurnal. Asteptam coada
// inainte de orice citire din proiectii: pe sqlite e o promisiune deja rezolvata (persist sincron).
function sqlReady() { return flushStore(); }

/** Balanta calculata DIRECT in SQL (rulaj perioada + rulaj inainte, din entry_lines) + soldurile de
 *  preluare din RAM. Acelasi rezultat ca accounting.trialBalance, dar fara a itera graful. Async
 *  (pg e asincron; sqlite sincron -> await pe valoare). */
async function trialBalanceSql(fid, period) {
  await sqlReady();
  const acc = require('./accounting');
  const opening = (get().openingBalances || {})[fid] || {};
  const before = await store.linesTurnover(fid, period, { before: true });
  const rulaj = await store.linesTurnover(fid, period);
  return acc.buildBalanceRows(before, opening, rulaj, period);
}

// Comparatorul cronologic al liniilor din SQL: acelasi ca accounting.sortEntries (data, apoi id
// NATURAL — localeCompare numeric, nereproductibil in SQL), apoi seq (pozitia liniei in articol).
function lineChrono(a, b) {
  if (a.data !== b.data) return (a.data || '') < (b.data || '') ? -1 : 1;
  const c = naturalCompare(a.entry_id, b.entry_id);
  return c !== 0 ? c : (a.seq - b.seq);
}

/** Registrul-jurnal calculat DIRECT in SQL (liniile perioadei din entry_lines). Acelasi rezultat
 *  ca accounting.journal, fara a itera graful. */
async function journalSql(fid, period) {
  await sqlReady();
  const { round2 } = require('./util');
  const lines = (await store.linesForPeriod(fid, period)).sort(lineChrono);
  const rows = []; let total = 0; let nr = 0; let lastEntry = null;
  for (const l of lines) {
    const first = l.entry_id !== lastEntry;
    if (first) { nr += 1; lastEntry = l.entry_id; }
    rows.push({
      nr: first ? nr : '',
      data: first ? l.data : '',
      document: first ? (l.document || '') : '',
      explicatie: l.explicatie || l.tipNume,
      debit: String(l.debit), credit: String(l.credit), suma: round2(l.suma),
    });
    total = round2(total + l.suma);
  }
  return { rows, total, period };
}

/** Cartea mare calculata DIRECT in SQL (rulaj inainte + liniile perioadei din entry_lines) +
 *  soldurile de preluare din RAM. Acelasi rezultat ca accounting.ledger, fara a itera graful. */
async function ledgerSql(fid, period) {
  await sqlReady();
  const coa = require('./chartOfAccounts');
  const { round2 } = require('./util');
  const opening = (get().openingBalances || {})[fid] || {};
  const before = await store.linesTurnover(fid, period, { before: true });
  const periodLines = (await store.linesForPeriod(fid, period)).sort(lineChrono);
  const accounts = new Set([...Object.keys(opening), ...Object.keys(before)]);
  for (const ln of periodLines) { accounts.add(ln.debit); accounts.add(ln.credit); }
  const result = [];
  for (const cod of [...accounts].sort()) {
    const op = opening[cod] || { d: 0, c: 0 };
    const bf = before[cod] || { d: 0, c: 0 };
    const siNet = round2((op.d + bf.d) - (op.c + bf.c));
    const moves = periodLines
      .filter((l) => l.debit === cod || l.credit === cod)
      .map((l) => ({ data: l.data, explicatie: l.explicatie, document: l.document, debit: l.debit === cod ? l.suma : 0, credit: l.credit === cod ? l.suma : 0 }));
    const rd = round2(moves.reduce((s, m) => s + m.debit, 0));
    const rc = round2(moves.reduce((s, m) => s + m.credit, 0));
    const sfNet = round2(siNet + rd - rc);
    if (siNet === 0 && rd === 0 && rc === 0 && sfNet === 0) continue;
    result.push({
      cod, nume: coa.accountName(cod),
      siD: siNet > 0 ? siNet : 0, siC: siNet < 0 ? -siNet : 0,
      moves, rd, rc,
      sfD: sfNet > 0 ? sfNet : 0, sfC: sfNet < 0 ? -sfNet : 0,
    });
  }
  return result;
}

/** Fisa unui cont calculata DIRECT in SQL (miscarile contului + rulaj inainte, din entry_lines) +
 *  soldul de preluare din RAM. Acelasi rezultat ca accounting.fisaCont, dar fara a itera graful. */
async function trialFisaContSql(fid, cont, period) {
  await sqlReady();
  const coa = require('./chartOfAccounts');
  const { round2 } = require('./util');
  cont = String(cont || '').trim();
  const openingAll = (get().openingBalances || {})[fid] || {};
  const opening = openingAll[cont] || { d: 0, c: 0 };
  const before = (await store.linesTurnover(fid, period, { before: true }))[cont] || { d: 0, c: 0 };
  let sold = round2((opening.d + before.d) - (opening.c + before.c));
  const siInitial = sold;
  const moves = await store.linesForAccount(fid, cont, period);
  let rd = 0; let rc = 0;
  const rows = moves.map((l) => {
    const d = l.debit === cont ? l.suma : 0;
    const c = l.credit === cont ? l.suma : 0;
    rd = round2(rd + d); rc = round2(rc + c); sold = round2(sold + d - c);
    return { data: l.data, document: l.document, explicatie: l.explicatie, partener: l.partener, corespondent: l.debit === cont ? l.credit : l.debit, d, c, sold };
  });
  return { cont, nume: coa.accountName(cont), period, siInitial, rows, rd, rc, sfFinal: sold };
}

module.exports = {
  get, save, load, migrate, nextId, firmaActiva, getFirma, nextFirmaId, scoped, defaultFirma, pickFirmaFields, FIRMA_EDITABLE, assertPeriodOpen, dataRev,
  getUser, getUserByName, nextUserId, exportFirma, importFirma, restoreFromJson, flushMirror, flushStore,
  canSqlRead, largeFirma, sqlBalancePeriodOk, trialBalanceSql, trialFisaContSql, journalSql, ledgerSql, storeConflicted, persistStats, SQL_READ_THRESHOLD,
  DATA_DIR, UPLOAD_DIR, DB_FILE, DRIVER,
};
