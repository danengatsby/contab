'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');

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
  recipes: [],         // { id, firmaId, nume, productId, gestiuneId, cantitateBaza, costUnitar, materiale:[{productId, gestiuneId, cantitate}] } - retete/BOM productie
  budgets: [],         // { id, firmaId, an, cont, suma } - buget anual per cont (clasa 6/7)
  declarations: [],    // { id, firmaId, tip, period, status, generatedAt, submittedAt, recipisa, note } - registrul depunerilor
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

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const up = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(up)) fs.mkdirSync(up, { recursive: true });
}

/** Migreaza o baza veche (o singura firma, fara firmaId) la structura multi-firma. */
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
  if (!Array.isArray(d.declarations)) d.declarations = [];
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
  return d;
}

function applyDefaults(d) {
  d = Object.assign({}, DEFAULT_DB, d || {});
  d.settings = Object.assign({}, DEFAULT_DB.settings, d.settings || {});
  return d;
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
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

module.exports = {
  get, save, load, nextId, firmaActiva, getFirma, nextFirmaId, scoped, defaultFirma,
  getUser, getUserByName, nextUserId, exportFirma, importFirma, restoreFromJson, flushMirror, flushStore,
  DATA_DIR, UPLOAD_DIR, DB_FILE, DRIVER,
};
