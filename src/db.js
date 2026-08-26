'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const migrations = require('./migrations');
// Cerut SUS, nu in `save()`: e calea fierbinte a scrierii. Nu inchide ciclu — `metrics` nu cere
// niciun modul al aplicatiei (doar `perf_hooks` si, in functie, `fs`/`path`).
const metrics = require('./metrics');
const duplicateGuard = require('./duplicateGuard');
const permissions = require('./permissions');
const fiscal = require('./fiscal');
const { stringifyDb, naturalCompare, validIsoDate, validPeriod } = require('./util');

// Capabilitate privata, imposibil de construit dintr-un body HTTP sau din alt modul. Doar
// importFirma(), dupa validarea integrala a pachetului, poate reconstitui o derogare istorica.
const RESTORE_DUPLICATE_OVERRIDE = Symbol('restore-validated-duplicate-override');

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
  'tvaPlatitor', 'tvaArt317', 'tvaLaIncasare', 'tvaCodAnulat', 'dataAnulareTva', 'motivAnulareTva', 'dataReinregistrareTva',
  'tipEntitate', 'proRataTva', 'caen', 'perioadaTva', 'capitalSocial', // profil fiscal
  'regimImpozit', 'd406Cadenta', 'intrastatObligat', 'scutiri',                     // motor profil fiscal (regim, cadenta D406, Intrastat, exceptii)
  // Sistemul de declarare a impozitului pe profit (art. 41): 'trimestrial' (implicit, alin. (1))
  // sau 'anual' cu plati anticipate (alin. (2)). `anticipatProfitContabil` = ramura alin. (7).
  // `ipcAnticipate` (indicele preturilor de consum, pe an) si `impozitProfitAn` (impozitul
  // datorat pe an) sunt INTRARI: primul se publica prin ordin al ministrului finantelor si nu se
  // poate deduce din datele firmei, al doilea acopera firmele migrate, fara istoric in aplicatie.
  'sistemProfit', 'anticipatProfitContabil', 'ipcAnticipate', 'impozitProfitAn',
  'autoPostDocumente',                                                              // pregatirea automata a unei ciorne (implicit oprita; nume legacy)
  'controlDublu',                                                                   // separare initiator–aprobator (automat si la echipe cu >=2 membri)
  'metodaEvaluareStoc',                                                             // evaluarea iesirilor din stoc: 'cmp' (implicit) sau 'fifo'
  'iban', 'bic', 'banca', 'cont', 'telefon', 'email', 'numeComplet', 'autorizatie',        // banca / contact / reprezentant
  'accentColor', 'pdfLayout', 'pdfFooter', 'asociatiText',                          // prezentare facturi/PDF
  // Antetul situatiilor financiare anuale (S1120/S1121). Valorile admise sunt cele din
  // validatorul oficial — vezi src/bilantNomenclator.js; codul de judet se DEDUCE din `judet`.
  'categorieRaportare', 'caenE', 'codTeritorial', 'formaProprietate', 'administrator', // identificare in bilant
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
    // Firmele noi pornesc exclusiv ca spatii de TEST. Trecerea la date reale nu este un camp
    // editabil generic: se face numai prin /api/legal/mode, cu DPA versionat si poarta GDPR.
    dataMode: 'test',
    // De cand exista firma IN APLICATIE. Calendarul fiscal se deriva din PROFIL, nu din date
    // (multe declaratii se depun „pe zero"), deci fara reperul asta o firma creata azi aparea
    // imediat cu restante pentru lunile dinaintea ei. Vezi declarations.primaLunaUrmarita.
    // Sta AICI, in sablonul comun, fiindca firmele se creeaza pe doua cai — inscrierea publica
    // (authRoutes) si adaugarea din aplicatie (firmeService) — si amandoua pleaca de la el.
    // Firmele dinaintea campului nu-l au: ele raman pe comportamentul vechi, ca sa nu ascundem
    // retroactiv restante adevarate.
    createdAt: new Date().toISOString(),
    bankReconciliationFrom: new Date().toISOString().slice(0, 7),
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
  inventarAnual: [],   // { id, firmaId, an, cont, valoareInventar, cauza } - valorile de inventar (registrul-inventar)
  partners: {},        // { [firmaId]: { [cui]: {...} } }
  openingBalances: {}, // { [firmaId]: { [cont]: { d, c } } }
  openingAnalytic: [], // { firmaId, cont, partener, cui, d, c }
  openItemAllocations: [], // alocari append-only plata -> document, cu suma si stare activa/revocata
  openItemReconciliations: [], // fotografii zilnice ale controlului registru documente deschise = carte mare
  bankStatements: [],  // identitatea extrasului: fisier/hash, IBAN, moneda, interval si solduri
  bankTransactions: [], // liniile extrasului cu stare propusa/punctata/postata/exclusa si articol legat
  audit: [],           // { id, ts, userId, username, firmaId, action, detail }
  messages: [],        // { id, userId, fromAdmin, text, author, createdAt, readByUser, readByAdmin } - suport user<->admin
  recurringInvoices: [], // { id, firmaId, tip, partener, cuiPartener, fields, frecventa, ziua, activ, startDate, lastGenerated } - facturi recurente
  cursuriBnr: [],      // { id: 'YYYY-MM-DD', cursuri: { EUR: 5.231, ... } } - curs oficial BNR, GLOBAL (nu per firma)
  fiscalRuleSets: [],  // FiscalRuleSet-uri publicate ulterior, append-only; hash-ul se verifica la load
  recipes: [],         // { id, firmaId, nume, productId, gestiuneId, cantitateBaza, costUnitar, materiale:[{productId, gestiuneId, cantitate}] } - retete/BOM productie
  budgets: [],         // { id, firmaId, an, cont, suma } - buget anual per cont (clasa 6/7)
  cashForecastSnapshots: [], // previziuni 13 săptămâni imuabile, baza backtestingului
  declarations: [],    // dosar unic: profil, artefacte, aprobari pe hash, stari append-only, depuneri si recipise
  annualArchives: [],  // ZIP-uri anuale sigilate, versionate, pastrate exact (base64 + manifest semnat)
  fiscal_profile_history: [], // tabel temporal: { id, firmaId, validFrom, validTo, recordedAt, values, ... }
  balance_category_history: [], // confirmari anuale versionate: indicatori, categorie, justificare, actor si hash
  balance_sheet_mappings: [], // metadate anuale append-only: scadenta, portiune curenta, afiliere si linii F10/F20
  balance_sheet_adjustments: [], // ajustari F10 separate de jurnal, aprobate si legate prin SHA-256 de sursa
  closings: [],        // { id, firmaId, period, steps, validari, aprobare, fortata, closedAt } - dosarul inchiderii lunare
  extractInterventions: [], // { id, firmaId, documentId, entryId, diff, controalePicate, partener, format } - corectiile operatorului peste extragere
  leasingContracts: [], // { id, firmaId, denumire, partener, cui, principal, months, dobandaAnuala, metoda, dataPrimeiRate, cotaTva } - contractele de leasing, sursa graficului de rate
  accessRequests: [],  // { id, firmaId, userId, ts, status } - contabil care CERE acces la o firma existenta (aproba proprietarul)
  serviceRequests: [], // { id, firmaId, ownerId, contabilId, mesaj, ts, status } - patron care ANGAJEAZA un contabil (accepta contabilul)
  visitors: [],        // { id=ip, ip, prima, ultima, cereri, pagini, ultimaCale, ua, bot, useri } - cine atinge site-ul, AGREGAT pe IP (src/visitors.js)
  customAccounts: [],  // { cod, nume, clasa, tip } - conturi personalizate (import)
  catalogDurate: [],   // { cod, denumire, aniMin, aniMax } - HG 2139/2004, GLOBAL (vezi src/catalogDurate.js)
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
  if (!Array.isArray(d.cashForecastSnapshots)) d.cashForecastSnapshots = [];
  if (!Array.isArray(d.recurringInvoices)) d.recurringInvoices = [];
  if (!Array.isArray(d.cursuriBnr)) d.cursuriBnr = [];
  if (!Array.isArray(d.declarations)) d.declarations = [];
  if (!Array.isArray(d.fiscal_profile_history)) d.fiscal_profile_history = [];
  if (!Array.isArray(d.balance_category_history)) d.balance_category_history = [];
  if (!Array.isArray(d.annualArchives)) d.annualArchives = [];
  if (!Array.isArray(d.bankStatements)) d.bankStatements = [];
  if (!Array.isArray(d.bankTransactions)) d.bankTransactions = [];
  if (!Array.isArray(d.closings)) d.closings = [];
  if (!Array.isArray(d.extractInterventions)) d.extractInterventions = [];
  if (!Array.isArray(d.leasingContracts)) d.leasingContracts = [];
  if (!Array.isArray(d.accessRequests)) d.accessRequests = [];
  if (!Array.isArray(d.serviceRequests)) d.serviceRequests = [];
  if (!Array.isArray(d.visitors)) d.visitors = [];
  if (!Array.isArray(d.customAccounts)) d.customAccounts = [];
  if (!Array.isArray(d.catalogDurate)) d.catalogDurate = [];
  if (!Array.isArray(d.assets)) d.assets = [];
  if (!Array.isArray(d.angajati)) d.angajati = [];
  if (!Array.isArray(d.payrollHistory)) d.payrollHistory = [];
  if (!Array.isArray(d.products)) d.products = [];
  if (!Array.isArray(d.gestiuni)) d.gestiuni = [];
  if (!Array.isArray(d.stockMovements)) d.stockMovements = [];
  if (!Array.isArray(d.inventories)) d.inventories = [];
  if (!Array.isArray(d.inventarAnual)) d.inventarAnual = [];
  if (!Array.isArray(d.users)) d.users = [];
  // Formalizează registrul existent ca dosare unice. Identitatea este derivată din
  // (firmă, declarație, perioadă), iar două rânduri pentru aceeași cheie opresc încărcarea în loc
  // să lase `find()` să aleagă arbitrar unul dintre istorice.
  const filingDossiers = require('./declarations');
  filingDossiers.assertUniqueDossiers(d);
  for (const rec of d.declarations) {
    if (!rec.id) rec.id = 'dcl-legacy-' + filingDossiers.dossierIdentity(rec.firmaId, rec.tip, rec.period).id.slice(3, 27);
    filingDossiers.ensureDossier(rec, rec.firmaId, rec.tip, rec.period);
    filingDossiers.ensureStateLedger(rec, rec.firmaId, rec.tip, rec.period);
  }
  // Migrare din prima implementare (istoric înglobat în `firma`) către tabelul temporal separat.
  // Idempotentă: un restart nu dublează reviziile, iar `validTo` este recalculat mecanic.
  const fp = require('./fiscalProfile');
  const fiscalProfileMigrationAt = new Date().toISOString();
  for (const f of d.firme || []) {
    // Perioadele istorice raman inchise dupa regulile sub care au fost lucrate. Din luna
    // instalarii acestei versiuni, inchiderea cere insa extras complet si diferenta zero.
    if (!/^\d{4}-\d{2}$/.test(String(f.bankReconciliationFrom || ''))) f.bankReconciliationFrom = new Date().toISOString().slice(0, 7);
    const legacy = Array.isArray(f.fiscalHistory) ? f.fiscalHistory : [];
    for (let i = 0; i < legacy.length; i += 1) {
      const row = Object.assign({}, legacy[i], { firmaId: f.id });
      if (!row.id) row.id = 'fpr-migrated-' + f.id + '-' + i;
      if (!d.fiscal_profile_history.some((x) => Number(x.firmaId) === Number(f.id) && String(x.id) === String(row.id))) {
        d.fiscal_profile_history.push(row);
      }
    }
    delete f.fiscalHistory;
  }
  for (const f of d.firme || []) {
    const other = d.fiscal_profile_history.filter((x) => Number(x.firmaId) !== Number(f.id));
    const ownRaw = d.fiscal_profile_history.filter((x) => Number(x.firmaId) === Number(f.id)).map((row) => {
      const explicit = fp.recordedAtOf({ recordedAt: row.recordedAt });
      const legacyCreated = fp.recordedAtOf({ createdAt: row.createdAt });
      const recordedAt = explicit || legacyCreated || fiscalProfileMigrationAt;
      return Object.assign({}, row, {
        recordedAt, createdAt: row.createdAt || recordedAt,
        recordedAtSource: row.recordedAtSource || (explicit ? 'explicit'
          : (legacyCreated ? 'legacy.createdAt' : 'database-migration')),
      });
    });
    const own = fp.withIntervals(ownRaw);
    d.fiscal_profile_history = other.concat(own);
  }
  if (!d.users.length) {
    const configured = process.env.CONTAB_INITIAL_ADMIN_PASSWORD;
    if (configured) {
      const invalid = auth.validatePassword(configured, { username: 'admin' });
      if (invalid) throw new Error('CONTAB_INITIAL_ADMIN_PASSWORD este invalidă: ' + invalid);
    }
    // Nu exista credential implicit predictibil. Instalatorul poate furniza parola o singura
    // data prin env; altfel se genereaza una aleatoare si se afiseaza numai la bootstrap.
    const initialPassword = configured || crypto.randomBytes(24).toString('base64url');
    const { salt, hash } = auth.hashPassword(initialPassword);
    d.users.push({ id: 1, username: 'admin', salt, hash, role: 'admin', firme: [], firmaActiva: d.firmaActiva, mustChange: true });
    if (configured) console.log('[contab] utilizator initial creat: admin (parola bootstrap din CONTAB_INITIAL_ADMIN_PASSWORD; schimbare obligatorie).');
    else console.log('[contab] utilizator initial creat: admin / ' + initialPassword + ' — parola bootstrap aleatoare, schimbare obligatorie.');
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
    // fisier nou: migrate() creeaza administratorul cu parolă bootstrap aleatoare/configurată + authSecret
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
    store.persist(db);
    await store.flush();
  } else {
    db = migrate(applyDefaults(await store.hydrate(DEFAULT_DB)));
    store.persist(db); // persista eventualele normalizari migrate() + initializeaza dirty-tracking
    await store.flush();
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
      // instalare noua / teste — migrate() creeaza administratorul cu parolă bootstrap sigură + authSecret
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

/**
 * `hint` (optional): colectiile pe care apelantul le-a atins — ex. `db.save(['visitors'])`.
 * Diff-ul sare atunci restul, ceea ce conteaza fiindca el costa O(baza), nu O(schimbarii).
 * A NU se folosi „din reflex": un indiciu gresit intarzie scrierea pana la primul diff complet
 * (plasa din store.js), iar intre timp schimbarea traieste doar in RAM. Se foloseste acolo unde
 * apelantul chiar stie ce a atins — joburile de fundal. Fara `hint`, comportamentul e neschimbat.
 */
function save(hint) {
  ensureDir();
  rev += 1; // inainte de orice iesire: si pe calea `json`, si daca driverul arunca (RAM e deja mutat)
  // Cat blocheaza bucla o scriere. `save()` e primitiva grea partajata de rute, joburi SI de
  // continuarile `.then` ale joburilor asincrone — deci masurarea aici acopera si blocajele pe care
  // atribuirea pe job nu le poate vedea. Se cronometreaza in `finally`: un persist care ARUNCA
  // (conflict de scriitor, disc plin) a consumat oricum bucla, iar acela e exact cazul de vazut.
  const t0 = process.hrtime.bigint();
  try {
    if (DRIVER === 'json') { writeJson(JSON_FILE, db); return; }
    store.persist(db, hint ? { only: hint } : undefined); // sqlite: sincron; pg: fotografiaza sincron + coada seriala
    if (JSON_MIRROR) scheduleMirror(); // oglinda pentru backup/rollback, scrisa cu intarziere
  } finally {
    metrics.persistRun(Number(process.hrtime.bigint() - t0) / 1e6);
  }
}

/** Asteapta scrierile in zbor ale driverului (pg are coada async; sqlite/json scriu sincron). */
function flushStore() {
  return DRIVER === 'pg' ? store.flush() : Promise.resolve();
}

// Restaurare dintr-un fisier JSON (folosita de ruta /api/restore): seteaza in memorie + persista in driver.
function validateRestoreGraph(parsed) {
  if (!parsed || !Array.isArray(parsed.firme) || !Array.isArray(parsed.users)) {
    const e = new Error('Nu pare o bază de date Contabo validă (lipsesc firme/users).'); e.status = 400; throw e;
  }
  require('./globalChain').assertGraph(parsed);
  return parsed;
}

function restoreFromJson(jsonPath) {
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  validateRestoreGraph(parsed); // fail-closed înainte de revizie, RAM, backup sau persistare
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

// ─────────────────────────────────────────────────────────────────────────────
//  PUNCTUL UNIC prin care intra articolele contabile in baza
//
//  `composeEntry` (server.js) refuza orice linie cu un cont din afara planului — o garda buna, si
//  motivul pentru care toate cele 127 de tipuri de document sunt curate. Dar ea pazeste o SINGURA
//  cale: 21 de locuri impingeau direct in `d.entries`, ocolind-o. Amortizarea lunara chiar a scris
//  ani la rand pe conturi inexistente (2812, 2814, 2805…), care apareau drept „(cont necunoscut)"
//  in balanta si plecau asa in <AccountDescription> din SAF-T, la ANAF.
//
//  Reparatia nu e inca o verificare copiata in 21 de locuri — ci un singur loc prin care trec
//  toate, plus o poarta in suita care refuza reaparitia lui `entries.push(` in afara acestui
//  fisier. O garda pe care o poti ocoli fara sa observe nimeni nu e o garda.
//
//  Conturile alese de UTILIZATOR (contul de stoc al unui produs, regulile de banca) nu erau
//  validate nicaieri: un „317" tastat in loc de „371" ajungea in articole fara o vorba. Acum se
//  opreste aici, cu numele contului in mesaj — o eroare zgomotoasa e mai ieftina decat un cont
//  orfan descoperit din raportarea SAF-T.
// ─────────────────────────────────────────────────────────────────────────────

/** Conturile din afara planului folosite de un articol (lista goala = articol curat). */
function conturiNecunoscute(entry) {
  const coa = require('./chartOfAccounts'); // cerut LA RULARE: planul primeste conturi si prin import
  const rele = new Set();
  for (const l of ((entry && entry.lines) || [])) {
    for (const c of [l.debit, l.credit]) {
      if (c && !coa.getAccount(String(c))) rele.add(String(c));
    }
  }
  return [...rele];
}

/**
 * Forma minimă obligatorie a ORICĂRUI articol care intră în jurnal. Punctul unic de scriere
 * trebuie să apere și cronologia, nu doar planul de conturi: `2026-02-30` era acceptat de
 * `<input type=date>` ocolit prin API, iar un `period` diferit de `data` despărțea același articol
 * între jurnal și declarații.
 * @returns {string|null} problema, fără a arunca
 */
function entryShapeProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'articolul nu este un obiect';
  const data = String(entry.data || '');
  if (!validIsoDate(data)) return 'data articolului nu este o dată calendaristică validă (YYYY-MM-DD)';
  const per = String(entry.period || '');
  if (!validPeriod(per)) return 'perioada articolului nu este o lună validă (YYYY-MM)';
  if (per !== data.slice(0, 7)) return 'perioada ' + per + ' nu corespunde datei ' + data;
  if (!Array.isArray(entry.lines) || !entry.lines.length) return 'articolul nu are linii contabile';
  for (let i = 0; i < entry.lines.length; i++) {
    const l = entry.lines[i] || {};
    if (!String(l.debit || '').trim() || !String(l.credit || '').trim()) return 'linia ' + (i + 1) + ' nu are ambele conturi';
    const suma = Number(l.suma);
    if (!Number.isFinite(suma) || suma === 0) return 'linia ' + (i + 1) + ' nu are o sumă finită, diferită de zero';
  }
  return null;
}

/**
 * Adauga un articol contabil, dupa ce ii verifica CONTURILE fata de planul de conturi.
 * Eroarea poarta `status` (contractul stratului de servicii), deci rutele o traduc in 400.
 * @param {object} entry articolul complet (cu `lines`)
 * @param {object} [o] `{ context, allowClosedPeriod, actor, duplicateOverride,
 * auditDuplicateOverride, restoreValidatedOverride }` — exceptiile de perioada/derogare
 * istorica sunt rezervate restaurarii validate a unei firme; o derogare NOUA cere rol, motiv,
 * conflictul exact si audit durabil
 */
function assertEntryBasics(entry, o) {
  const rele = conturiNecunoscute(entry);
  if (rele.length) {
    const unde = (o && o.context) ? ' (' + o.context + ')' : '';
    const err = new Error('Conturi inexistente în planul de conturi' + unde + ': ' + rele.join(', ')
      + '. Completează planul sau corectează contul înainte de a înregistra articolul.');
    err.status = 400;
    throw err;
  }
  const forma = entryShapeProblem(entry);
  if (forma) {
    const unde = (o && o.context) ? ' (' + o.context + ')' : '';
    const err = new Error('Articol contabil invalid' + unde + ': ' + forma + '.');
    err.status = 400;
    throw err;
  }
  // Ultima linie de aparare: orice flux prezent sau viitor care ajunge in jurnal respecta
  // blocarea perioadei chiar daca ruta/serviciul a uitat propria verificare. Validarea formei
  // ruleaza inainte, ca `data` transmisa lui assertPeriodOpen sa fie deja canonica.
  if (!(o && o.allowClosedPeriod)) {
    assertPeriodOpen(entry.firmaId, entry.data, (o && o.context) || 'Inregistrarea articolului contabil');
  }
  return true;
}

function pushEntry(entry, o) {
  assertEntryBasics(entry, o);
  // Poarta centrala garanteaza provenienta temporala inclusiv pentru articolele de sistem care
  // nu trec prin composeEntry. La storno, amprenta veche ramane ca sursa, iar articolul nou poarta
  // regulile propriei date. Un an neacoperit este marcat explicit, niciodata completat cu 2026.
  const temporalRef = fiscal.ruleReferenceAt(entry.data, { allowUncovered: true });
  if (entry.ruleSetId && entry.fiscalRulesHash
      && (entry.ruleSetId !== temporalRef.ruleSetId || entry.fiscalRulesHash !== temporalRef.fiscalRulesHash)) {
    entry.sourceRuleSetId = entry.ruleSetId; entry.sourceFiscalRulesHash = entry.fiscalRulesHash;
  }
  entry.ruleSetId = temporalRef.ruleSetId; entry.fiscalRulesHash = temporalRef.fiscalRulesHash;
  if (temporalRef.fiscalRulesCovered === false) entry.fiscalRulesCovered = false;
  else delete entry.fiscalRulesCovered;
  const found = duplicateGuard.conflict(get().entries, entry);
  const override = o && o.duplicateOverride;
  const restoredOverride = o && o.restoreValidatedOverride === RESTORE_DUPLICATE_OVERRIDE
    ? entry.duplicateOverride : null;
  if (found && !override && !restoredOverride) throw duplicateGuard.duplicateError(found, (o && o.context) || 'jurnal');
  if (found && restoredOverride) {
    // Nu este o derogare noua: reconstituim una deja persistata intr-un pachet verificat integral.
    // Totusi poarta centrala reconfirma legatura, ca un apel intern sa nu poata folosi steagul de
    // restaurare pentru un conflict arbitrar.
    const reason = String(restoredOverride.reason || '').trim();
    const keyOverlap = Array.isArray(restoredOverride.keys)
      && found.keys.some((key) => restoredOverride.keys.includes(key));
    if (reason.length < 10 || String(restoredOverride.duplicateId || '') !== String(found.duplicate.id)
        || !keyOverlap) {
      const err = new Error('Derogarea anti-duplicat istorica nu corespunde conflictului restaurat.');
      err.status = 400; err.code = 'DUPLICATE_RESTORE_OVERRIDE_INVALID';
      throw err;
    }
  }
  if (!found && override) {
    const err = new Error('Derogarea anti-duplicat nu mai corespunde unui conflict activ. Reia salvarea fara derogare.');
    err.status = 409; err.code = 'DUPLICATE_OVERRIDE_STALE';
    throw err;
  }
  if (found && override) {
    // Poarta centrala nu accepta un simplu steag venit din client. Confirma atat dreptul rar de
    // override, cat si ARTICOLUL vazut de aprobator; astfel un retry intarziat nu poate acoperi
    // tacit un alt conflict aparut intre timp.
    permissions.assert(o.actor, entry.firmaId, 'control.override', getFirma(entry.firmaId));
    const reason = String(override.reason || override.motiv || '').trim();
    if (reason.length < 10) {
      const err = new Error('Derogarea anti-duplicat cere un motiv concret de cel putin 10 caractere.');
      err.status = 400; err.code = 'DUPLICATE_OVERRIDE_REASON_REQUIRED';
      throw err;
    }
    if (!override.duplicateId || String(override.duplicateId) !== String(found.duplicate.id)) {
      const err = new Error('Conflictul anti-duplicat s-a schimbat. Reia verificarea articolului existent.');
      err.status = 409; err.code = 'DUPLICATE_OVERRIDE_MISMATCH'; err.duplicateId = found.duplicate.id;
      throw err;
    }
    if (typeof o.auditDuplicateOverride !== 'function') {
      const err = new Error('Derogarea anti-duplicat nu poate fi aplicata fara jurnal de audit durabil.');
      err.status = 500; err.code = 'DUPLICATE_OVERRIDE_AUDIT_REQUIRED';
      throw err;
    }
    const at = new Date().toISOString();
    const info = {
      firmaId: entry.firmaId, entryId: entry.id, duplicateId: found.duplicate.id,
      duplicateDocument: found.duplicate.document || '', keys: found.keys.slice(), reason: reason.slice(0, 500), at,
    };
    // Callback-ul este furnizat doar de ruta autorizata si scrie fail-closed in lantul NDJSON.
    // Daca auditul nu se poate scrie, articolul NU ajunge in jurnal.
    o.auditDuplicateOverride(info);
    entry.duplicateOverride = {
      duplicateId: info.duplicateId, keys: info.keys, reason: info.reason,
      by: Number(o.actor && o.actor.id) || null,
      username: String((o.actor && o.actor.username) || '').slice(0, 80) || null,
      at,
    };
  }
  get().entries.push(entry);
  return entry;
}

/** Preflight pe aceeasi poarta anti-duplicat folosita obligatoriu de `pushEntry`. */
function assertEntryUnique(entry, o) {
  return duplicateGuard.assertUnique(get().entries, entry, (o && o.context) || 'jurnal');
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
// prin /api/period-lock sau la finalul cockpitului lunar) nu se mai modifica: corectiile se fac EXCLUSIV
// prin storno intr-o perioada deschisa. `dataOriPerioada` accepta 'YYYY-MM-DD' sau 'YYYY-MM'.
function assertPeriodOpen(fid, dataOriPerioada, actiune) {
  const firma = getFirma(fid);
  const raw = String(dataOriPerioada || '');
  const per = validPeriod(raw) ? raw : validIsoDate(raw) ? raw.slice(0, 7) : '';
  if (!per) {
    const e = new Error((actiune || 'Operatiunea') + ': data/perioada nu este valida (foloseste YYYY-MM-DD sau YYYY-MM).');
    e.status = 400;
    throw e;
  }
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
  const entries = d.entries.filter((e) => (e.firmaId == null ? d.firmaActiva : e.firmaId) === id);
  // Miscarea automata legata de o factura urmeaza starea articolului: cat timp articolul este
  // ciorna/validat/aprobat, nu are voie sa reduca stocul real. La postare devine activa automat.
  // Miscarile manuale (fara entryId) raman active imediat, ca pana acum.
  const activeEntryIds = new Set(entries.filter((e) => !e.status || e.status === 'postat').map((e) => e.id));
  return {
    firmaId: id,
    company: getFirma(id) || {},
    entries,
    documents: d.documents.filter((x) => (x.firmaId == null ? d.firmaActiva : x.firmaId) === id),
    assets: (d.assets || []).filter((a) => (a.firmaId == null ? d.firmaActiva : a.firmaId) === id),
    angajati: (d.angajati || []).filter((a) => (a.firmaId == null ? d.firmaActiva : a.firmaId) === id),
    payrollHistory: (d.payrollHistory || []).filter((h) => (h.firmaId == null ? d.firmaActiva : h.firmaId) === id),
    fiscalProfileHistory: (d.fiscal_profile_history || []).filter((h) => Number(h.firmaId) === id),
    balanceCategoryHistory: (d.balance_category_history || []).filter((h) => Number(h.firmaId) === id),
    balanceSheetMappings: (d.balance_sheet_mappings || []).filter((h) => Number(h.firmaId) === id),
    balanceSheetAdjustments: (d.balance_sheet_adjustments || []).filter((h) => Number(h.firmaId) === id),
    products: (d.products || []).filter((p) => (p.firmaId == null ? d.firmaActiva : p.firmaId) === id),
    gestiuni: (d.gestiuni || []).filter((g) => (g.firmaId == null ? d.firmaActiva : g.firmaId) === id),
    stockMovements: (d.stockMovements || []).filter((m) => (m.firmaId == null ? d.firmaActiva : m.firmaId) === id
      && (!m.entryId || activeEntryIds.has(m.entryId))),
    inventories: (d.inventories || []).filter((iv) => (iv.firmaId == null ? d.firmaActiva : iv.firmaId) === id),
    inventarAnual: (d.inventarAnual || []).filter((x) => (x.firmaId == null ? d.firmaActiva : x.firmaId) === id),
    partners: d.partners[id] || {},
    openingBalances: d.openingBalances[id] || {},
    openingAnalytic: (d.openingAnalytic || []).filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === id),
    openItemAllocations: (d.openItemAllocations || []).filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === id),
    openItemReconciliations: (d.openItemReconciliations || []).filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === id),
    bankStatements: (d.bankStatements || []).filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === id),
    bankTransactions: (d.bankTransactions || []).filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === id),
    cashForecastSnapshots: (d.cashForecastSnapshots || []).filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === id),
    leasingContracts: (d.leasingContracts || []).filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === id),
    // Cursurile BNR sunt globale, dar rapoartele/statul primesc numai vederea scoped. Expunerea
    // read-only aici evita revenirea la un curs fiscal fix in calculele care pornesc din `S(req)`.
    cursuriBnr: d.cursuriBnr || [],
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
    openItemAllocations: byFid(d.openItemAllocations),
    openItemReconciliations: byFid(d.openItemReconciliations),
    bankStatements: byFid(d.bankStatements),
    bankTransactions: byFid(d.bankTransactions),
    assets: byFid(d.assets),
    products: byFid(d.products),
    gestiuni: byFid(d.gestiuni),
    stockMovements: byFid(d.stockMovements),
    inventories: byFid(d.inventories),
    inventarAnual: byFid(d.inventarAnual),
    angajati: byFid(d.angajati),
    payrollHistory: byFid(d.payrollHistory),
    fiscal_profile_history: byFid(d.fiscal_profile_history),
    balance_category_history: byFid(d.balance_category_history),
    balance_sheet_mappings: byFid(d.balance_sheet_mappings),
    balance_sheet_adjustments: byFid(d.balance_sheet_adjustments),
    recurringInvoices: byFid(d.recurringInvoices),
    recipes: byFid(d.recipes),
    budgets: byFid(d.budgets),
    cashForecastSnapshots: byFid(d.cashForecastSnapshots),
    declarations: byFid(d.declarations),
    annualArchives: byFid(d.annualArchives),
    closings: byFid(d.closings),
    extractInterventions: byFid(d.extractInterventions),
    leasingContracts: byFid(d.leasingContracts),
  };
}

const FIRMA_IMPORT_COLLS = [
  'entries', 'documents', 'assets', 'angajati', 'payrollHistory', 'products', 'gestiuni',
  'stockMovements', 'inventories', 'inventarAnual', 'openingAnalytic', 'recurringInvoices',
  'openItemAllocations', 'openItemReconciliations', 'bankStatements', 'bankTransactions', 'recipes', 'budgets', 'cashForecastSnapshots', 'declarations', 'annualArchives', 'fiscal_profile_history', 'balance_category_history', 'balance_sheet_mappings', 'balance_sheet_adjustments', 'closings', 'extractInterventions', 'leasingContracts',
];
const FIRMA_IMPORT_ID_COLLS = FIRMA_IMPORT_COLLS.filter((k) => k !== 'openingAnalytic');
const FIRMA_IMPORT_MAX_ITEMS = 500000;
const IMPORT_FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function firmaImportError(msg) {
  const e = new Error(msg); e.status = 400; throw e;
}

/** Copie JSON fara cheile care pot modifica prototipul cand obiectele sunt recompuse cu assign. */
function safeImportClone(value) {
  function copy(v) {
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) if (!IMPORT_FORBIDDEN_KEYS.has(k)) out[k] = copy(v[k]);
      return out;
    }
    return v;
  }
  return copy(value);
}

/**
 * Valideaza COMPLET pachetul inainte de prima mutatie a grafului: forma, volum, id-uri,
 * referinte interne si conturi. Intoarce o copie curatata, ca importul sa nu pastreze referinte
 * catre obiectele controlate de apelant.
 */
function validateFirmaBundle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) firmaImportError('Pachet de firma invalid.');
  const b = safeImportClone(input);
  if (!b.firma || typeof b.firma !== 'object' || Array.isArray(b.firma)) firmaImportError('Pachetul nu contine obiectul firma.');
  if (b._format && b._format !== 'contab-firma-v1') firmaImportError('Format de pachet necunoscut: ' + String(b._format).slice(0, 80));
  if (b.partners != null && (typeof b.partners !== 'object' || Array.isArray(b.partners))) firmaImportError('Partenerii din pachet nu sunt un obiect.');
  if (b.openingBalances != null && (typeof b.openingBalances !== 'object' || Array.isArray(b.openingBalances))) firmaImportError('Soldurile initiale din pachet nu sunt un obiect.');

  let total = 0;
  for (const k of FIRMA_IMPORT_COLLS) {
    if (b[k] == null) b[k] = [];
    if (!Array.isArray(b[k])) firmaImportError('Colectia "' + k + '" din pachet nu este o lista.');
    total += b[k].length;
    for (const x of b[k]) if (!x || typeof x !== 'object' || Array.isArray(x)) firmaImportError('Colectia "' + k + '" contine un element invalid.');
  }
  if (total > FIRMA_IMPORT_MAX_ITEMS) firmaImportError('Pachetul depaseste limita de elemente importabile.');

  const ids = {};
  for (const k of FIRMA_IMPORT_ID_COLLS) {
    ids[k] = new Set();
    for (const x of b[k]) {
      const id = x.id == null ? '' : String(x.id);
      if (!id) firmaImportError('Colectia "' + k + '" contine un element fara id.');
      if (ids[k].has(id)) firmaImportError('Colectia "' + k + '" contine id duplicat: ' + id.slice(0, 100));
      ids[k].add(id);
    }
  }

  const needList = (v, label) => {
    if (v == null) return [];
    if (!Array.isArray(v)) firmaImportError(label + ' nu este o lista.');
    return v;
  };
  const needObject = (v, label) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) firmaImportError(label + ' nu este un obiect.');
    return v;
  };
  const ref = (value, coll, label, required) => {
    if (value == null || value === '') { if (required) firmaImportError(label + ' lipseste.'); return; }
    if (!ids[coll].has(String(value))) firmaImportError(label + ' indica un id inexistent: ' + String(value).slice(0, 100));
  };

  for (const e of b.entries) {
    const forma = entryShapeProblem(e);
    if (forma) firmaImportError('Articolul ' + e.id + ' este invalid: ' + forma + '.');
    if (!Array.isArray(e.lines)) firmaImportError('Articolul ' + e.id + ' nu are lista de linii contabile.');
    for (const l of e.lines) needObject(l, 'Linia articolului ' + e.id);
    ref(e.fileId, 'documents', 'Atasamentul articolului ' + e.id, false);
    ref(e.movementId, 'stockMovements', 'Miscarea articolului ' + e.id, false);
    ref(e.stocMovementId, 'stockMovements', 'Miscarea de stoc canonica a articolului ' + e.id, false);
    ref(e.stornoOf, 'entries', 'Referinta storno a articolului ' + e.id, false);
    ref(e.stornoBy, 'entries', 'Nota storno a articolului ' + e.id, false);
    ref(e.bankStatementId, 'bankStatements', 'Extrasul bancar al articolului ' + e.id, false);
    ref(e.bankTransactionId, 'bankTransactions', 'Tranzactia bancara a articolului ' + e.id, false);
    if (e.duplicateOverride != null) {
      const ov = needObject(e.duplicateOverride, 'Derogarea anti-duplicat a articolului ' + e.id);
      ref(ov.duplicateId, 'entries', 'Articolul original al derogarii ' + e.id, true);
      if (String(ov.duplicateId) === String(e.id)) firmaImportError('Derogarea articolului ' + e.id + ' se refera la el insusi.');
      if (String(ov.reason || '').trim().length < 10) firmaImportError('Derogarea articolului ' + e.id + ' nu are un motiv complet.');
      if (!Array.isArray(ov.keys) || !ov.keys.length) firmaImportError('Derogarea articolului ' + e.id + ' nu pastreaza cheia conflictului.');
    }
    for (const mid of needList(e.stocMovementIds, 'Miscarile de stoc ale articolului ' + e.id)) ref(mid, 'stockMovements', 'Miscarea de stoc a articolului ' + e.id, true);
    if (e.leasingRef != null) {
      const lr = needObject(e.leasingRef, 'Referinta de leasing a articolului ' + e.id);
      if (e.tip !== 'factura_leasing') firmaImportError('Referinta de leasing apare pe un articol care nu este factura de rata: ' + e.id + '.');
      ref(lr.contractId, 'leasingContracts', 'Contractul de leasing al articolului ' + e.id, true);
      if (!validPeriod(lr.period)) firmaImportError('Luna ratei de leasing din articolul ' + e.id + ' este invalida.');
    }
  }
  for (const a of b.openItemAllocations) {
    ref(a.documentId, 'entries', 'Documentul alocarii ' + a.id, true);
    ref(a.paymentId, 'entries', 'Plata alocarii ' + a.id, true);
    if (!Number.isFinite(Number(a.amount)) || Number(a.amount) <= 0) firmaImportError('Alocarea ' + a.id + ' nu are o suma pozitiva.');
  }
  for (const s of b.bankStatements) ref(s.documentId, 'documents', 'Fisierul extrasului ' + s.id, false);
  for (const t of b.bankTransactions) {
    ref(t.statementId, 'bankStatements', 'Extrasul tranzactiei bancare ' + t.id, true);
    ref(t.entryId, 'entries', 'Articolul tranzactiei bancare ' + t.id, false);
    ref(t.linkedEntryId, 'entries', 'Articolul legat la tranzactia exclusa ' + t.id, false);
    ref(t.duplicateOf, 'bankTransactions', 'Dublura tranzactiei bancare ' + t.id, false);
    if (t.proposal && Array.isArray(t.proposal.stinge)) for (const id of t.proposal.stinge) ref(id, 'entries', 'Documentul punctat de tranzactia ' + t.id, true);
  }
  const annualIntegrity = require('./annualArchiveIntegrity');
  for (const archive of b.annualArchives) {
    const check = annualIntegrity.verifyStored(archive);
    if (!check.ok) firmaImportError('Dosarul anual ' + String(archive.year || '?') + ' v'
      + String(archive.version || '?') + ' este invalid: ' + check.reason + '.');
    if (Number(archive.firmaId) !== Number(b.firma.id)) firmaImportError('Dosarul anual '
      + String(archive.year || '?') + ' nu aparține identității firmei din pachet.');
  }
  const cash13 = require('./cashForecast13Weeks');
  for (const snapshot of b.cashForecastSnapshots) if (!cash13.verifySnapshot(snapshot)) {
    firmaImportError('Fotografia cash-flow ' + String(snapshot.id || '?') + ' este coruptă sau incompletă.');
  }
  const fiscalHistory = require('./fiscalProfile');
  for (const revision of b.fiscal_profile_history) {
    if (!validIsoDate(String(revision.validFrom || '')) || !revision.values
        || typeof revision.values !== 'object' || Array.isArray(revision.values)) {
      firmaImportError('Revizia profilului fiscal ' + String(revision.id || '?')
        + ' nu are validFrom și fotografia completă valide.');
    }
    if (revision.recordedAt && !fiscalHistory.recordedAtOf({ recordedAt: revision.recordedAt })) {
      firmaImportError('Revizia profilului fiscal ' + String(revision.id || '?')
        + ' are un moment recordedAt invalid.');
    }
  }
  const filingDossiers = require('./declarations');
  try { filingDossiers.assertUniqueDossiers({ declarations: b.declarations }); } catch (e) {
    firmaImportError('Dosarele de depunere sunt ambigue: ' + e.message);
  }
  for (const dossier of b.declarations) {
    const check = filingDossiers.verifyDossier(dossier, dossier.firmaId, dossier.tip, dossier.period);
    if (!check.valid) firmaImportError('Dosarul de depunere ' + String(dossier.tip || '?') + ' '
      + String(dossier.period || '?') + ' este invalid: ' + check.issues.join('; ') + '.');
  }
  for (const mv of b.stockMovements) {
    ref(mv.productId, 'products', 'Produsul miscarii ' + mv.id, true);
    ref(mv.gestiuneId, 'gestiuni', 'Gestiunea miscarii ' + mv.id, false);
    ref(mv.gestiuneDestId, 'gestiuni', 'Gestiunea destinatie a miscarii ' + mv.id, false);
    ref(mv.inventoryId, 'inventories', 'Inventarul miscarii ' + mv.id, false);
    ref(mv.stornoOfMovementId, 'stockMovements', 'Miscarea originala a stornarii ' + mv.id, false);
    ref(mv.stornoMovementId, 'stockMovements', 'Miscarea de corectie a miscarii ' + mv.id, false);
    ref(mv.stornoEntryId, 'entries', 'Nota de corectie a miscarii ' + mv.id, false);
    // entryId este o legatura auxiliara: o copie partiala poate pastra miscarea de stoc dupa ce
    // articolul a fost pierdut. La constructie devine null, niciodata id-ul vechi/strain.
  }
  for (const iv of b.inventories) {
    ref(iv.gestiuneId, 'gestiuni', 'Gestiunea inventarului ' + iv.id, false);
    needList(iv.entryIds, 'Articolele inventarului ' + iv.id);
    needList(iv.stornoEntryIds, 'Stornarile inventarului ' + iv.id);
    for (const x of needList(iv.movementIds, 'Miscarile inventarului ' + iv.id)) ref(x, 'stockMovements', 'Miscarea inventarului ' + iv.id, true);
    for (const x of needList(iv.stornoMovementIds, 'Miscarile storno ale inventarului ' + iv.id)) ref(x, 'stockMovements', 'Miscarea storno a inventarului ' + iv.id, true);
    for (const l of needList(iv.lines, 'Liniile inventarului ' + iv.id)) { needObject(l, 'Linia inventarului ' + iv.id); ref(l.productId, 'products', 'Produsul din inventarul ' + iv.id, true); }
  }
  // Istoricul salarial poate pastra randuri pentru angajati stersi ulterior. Lista se valideaza,
  // iar id-urile care nu mai exista devin null la remapare (numele/CNP-ul istoric raman in rand).
  for (const h of b.payrollHistory) needList(h.rows, 'Randurile statului ' + h.id);
  for (const t of b.recurringInvoices) {
    const stoc = t.fields && t.fields.stoc;
    for (const l of needList(stoc, 'Stocul sablonului recurent ' + t.id)) {
      needObject(l, 'Linia de stoc a sablonului recurent ' + t.id);
      ref(l.productId, 'products', 'Produsul sablonului recurent ' + t.id, true);
      ref(l.gestiuneId, 'gestiuni', 'Gestiunea sablonului recurent ' + t.id, false);
    }
  }
  for (const r of b.recipes) {
    ref(r.productId, 'products', 'Produsul finit al retetei ' + r.id, true);
    ref(r.gestiuneId, 'gestiuni', 'Gestiunea retetei ' + r.id, false);
    for (const m of needList(r.materiale, 'Materialele retetei ' + r.id)) {
      needObject(m, 'Materialul retetei ' + r.id);
      ref(m.productId, 'products', 'Materialul retetei ' + r.id, true);
      ref(m.gestiuneId, 'gestiuni', 'Gestiunea materialului din reteta ' + r.id, false);
    }
  }

  // Niciun articol/sold/nomenclator nu intra cu un cont pe care instanta tinta nu-l cunoaste.
  const coa = require('./chartOfAccounts');
  const unknown = new Set();
  const account = (v) => { if (v != null && v !== '' && !coa.getAccount(String(v))) unknown.add(String(v)); };
  for (const e of b.entries) for (const l of e.lines) { account(l.debit); account(l.credit); }
  for (const c of Object.keys(b.openingBalances || {})) account(c);
  for (const x of b.openingAnalytic) account(x.cont);
  for (const x of b.products) account(x.cont);
  for (const x of b.gestiuni) account(x.cont);
  for (const x of b.assets) account(x.cont);
  for (const x of b.inventarAnual) account(x.cont);
  for (const x of b.budgets) account(x.cont);
  if (unknown.size) firmaImportError('Conturi inexistente in planul de conturi al instantei tinta: ' + [...unknown].slice(0, 30).join(', ') + '. Importa/adauga intai conturile personalizate.');

  b.partners = b.partners || {};
  b.openingBalances = b.openingBalances || {};
  return b;
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
  const b = validateFirmaBundle(bundle);
  let newFid;
  if (o.targetFid) {
    newFid = Number(o.targetFid);
    const f = d.firme.find((x) => x.id === newFid);
    if (!f) throw new Error('Firma tinta inexistenta.');
  } else {
    newFid = nextFirmaId();
  }
  if (b.annualArchives.length && Number(newFid) !== Number(b.firma.id)) {
    firmaImportError('Dosarele anuale sunt imuabile și semnate pentru firma ' + b.firma.id
      + '; pot fi restaurate numai peste aceeași identitate de firmă, nu clonate pe id-ul ' + newFid + '.');
  }

  // Alocare LOCALA: seq si graful nu se ating pana cand TOATE obiectele sunt construite.
  let seqImport = Number(d.seq) || 1;
  const alloc = (prefix) => String(prefix || '') + seqImport++;
  const maps = {};
  const prefixes = { products: 'prod', gestiuni: 'gest', assets: 'mf', angajati: 'ang', entries: 'e', stockMovements: 'sm', documents: 'doc', inventories: 'inv', inventarAnual: 'iva', payrollHistory: 'ph', recurringInvoices: 'rec', openItemAllocations: 'oia', openItemReconciliations: 'oir', bankStatements: 'bst', bankTransactions: 'btx', recipes: 'bom', budgets: 'bud', cashForecastSnapshots: 'cfs', declarations: 'dcl', annualArchives: 'aar', fiscal_profile_history: 'fpr', balance_category_history: 'bch', balance_sheet_mappings: 'bsm', balance_sheet_adjustments: 'bsa', closings: 'cls', extractInterventions: 'ext', leasingContracts: 'lsg' };
  for (const k of FIRMA_IMPORT_ID_COLLS) {
    maps[k] = new Map();
    // Un pachet mic poate veni cu e1/e2 exact când secvența locală ar genera tot e1/e2.
    // Sărim peste TOATE id-urile sursă din colecție: importul produce o identitate nouă
    // demonstrabilă, iar nicio referință externă rămasă din greșeală nu poate părea validă.
    const sourceIds = new Set(b[k].map((x) => String(x.id)));
    for (const x of b[k]) {
      let fresh;
      do { fresh = alloc(prefixes[k]); } while (sourceIds.has(fresh));
      maps[k].set(String(x.id), fresh);
    }
  }
  const mid = (coll, id) => (id == null || id === '') ? null : (maps[coll].get(String(id)) || null);
  const simple = (coll) => b[coll].map((x) => Object.assign({}, x, { id: mid(coll, x.id), firmaId: newFid }));
  const filingImportAt = new Date().toISOString();
  const importedDeclarations = simple('declarations').map((rec) => {
    const sourceDossierId = rec.dossier && rec.dossier.id;
    const sourceChainHash = rec.stateChainHash || '';
    const sourceEvidence = sourceDossierId ? {
      schemaVersion: 1,
      dossier: JSON.parse(JSON.stringify(rec.dossier || null)),
      status: rec.status || 'nedepusa',
      statusHistory: JSON.parse(JSON.stringify(rec.statusHistory || [])),
      stateEvents: JSON.parse(JSON.stringify(rec.stateEvents || [])),
      stateChainHash: rec.stateChainHash || '',
      documentApproval: JSON.parse(JSON.stringify(rec.documentApproval || null)),
      documentApprovals: JSON.parse(JSON.stringify(rec.documentApprovals || [])),
      transmittedArtifactHash: rec.transmittedArtifactHash || '',
      transmittedApprovalHash: rec.transmittedApprovalHash || '',
      transmittedAt: rec.transmittedAt || null,
      submittedAt: rec.submittedAt || null,
      recipisa: rec.recipisa || '',
      submissions: JSON.parse(JSON.stringify(rec.depuneri || [])),
      artifactHash: rec.artifactHash || '',
      artifacts: (rec.artifacts || []).map((row) => ({ sha256: row.sha256, bytes: row.bytes,
        filename: row.filename, mime: row.mime })),
      profileHash: rec.profileHash || '', profileProvenanceHash: rec.profileProvenanceHash || '',
    } : null;
    delete rec.dossier; // firma/id-ul local se schimbă controlat; cheia dosarului trebuie relegată
    // Evenimentele sunt semnate inclusiv cu identitatea dosarului. La import pe altă firmă nu le
    // rescriem (ar falsifica lanțul): păstrăm hash-ul sursă ca dovadă într-un snapshot de import.
    delete rec.stateEvents; delete rec.stateChainHash;
    const filings = require('./declarations');
    filings.ensureDossier(rec, newFid, rec.tip, rec.period, filingImportAt);
    if (sourceDossierId && sourceDossierId !== rec.dossier.id) {
      // O aprobare numește și semnează dosarul sursă. La clonare nu o „adaptăm” prin recalcularea
      // hash-ului: ar părea o aprobare nouă. O păstrăm ca dovadă de import, dar nu ca aprobare activă.
      sourceEvidence.evidenceHash = crypto.createHash('sha256')
        .update(require('./globalChain').canonicalJson(sourceEvidence), 'utf8').digest('hex');
      rec.importedSourceFilingEvidence = sourceEvidence;
      rec.documentApprovals = []; delete rec.documentApproval;
      rec.approvedAt = null; rec.approvedBy = '';
      rec.depuneri = []; rec.statusHistory = [];
      delete rec.transmittedArtifactHash; delete rec.transmittedApprovalHash;
      delete rec.transmittedAt; delete rec.submittedAt; rec.recipisa = '';
      rec.status = filings.exactArtifact(rec, rec.artifactHash) ? 'generata' : 'nedepusa';
      if (rec.status === 'generata') rec.generatedAt = filingImportAt;
      rec.dossier.createdAt = filingImportAt;
    }
    filings.ensureStateLedger(rec, newFid, rec.tip, rec.period);
    if (sourceChainHash && rec.stateEvents[0]) {
      rec.stateEvents[0].evidence.importedSourceChainHash = sourceChainHash;
      rec.stateEvents[0].hash = filings.stateEventHash(rec.stateEvents[0]);
      rec.stateChainHash = rec.stateEvents[0].hash;
    }
    return rec;
  });
  const fiscalImportAt = filingImportAt;
  const fiscalProfiles = require('./fiscalProfile');
  const importedFiscalProfileHistory = fiscalProfiles.withIntervals(simple('fiscal_profile_history').map((row) => {
    const explicit = fiscalProfiles.recordedAtOf({ recordedAt: row.recordedAt });
    const legacyCreated = fiscalProfiles.recordedAtOf({ createdAt: row.createdAt });
    const recordedAt = explicit || legacyCreated || fiscalImportAt;
    return Object.assign({}, row, {
      recordedAt, createdAt: row.createdAt || recordedAt,
      recordedAtSource: row.recordedAtSource || (explicit ? 'explicit'
        : (legacyCreated ? 'legacy.createdAt' : 'firm-import')),
    });
  }));
  const stockLines = (lines) => (lines || []).map((l) => Object.assign({}, l, { productId: mid('products', l.productId), gestiuneId: mid('gestiuni', l.gestiuneId) }));

  const built = {
    products: simple('products'), gestiuni: simple('gestiuni'), assets: simple('assets'), angajati: simple('angajati'),
    inventarAnual: simple('inventarAnual'), budgets: simple('budgets'),
    cashForecastSnapshots: simple('cashForecastSnapshots'), declarations: importedDeclarations,
    annualArchives: simple('annualArchives'),
    fiscal_profile_history: importedFiscalProfileHistory,
    balance_category_history: simple('balance_category_history'),
    balance_sheet_mappings: simple('balance_sheet_mappings'),
    balance_sheet_adjustments: simple('balance_sheet_adjustments'),
    closings: simple('closings'), leasingContracts: simple('leasingContracts'),
    openItemReconciliations: simple('openItemReconciliations'),
    openingAnalytic: b.openingAnalytic.map((x) => Object.assign({}, x, { firmaId: newFid })),
  };
  built.documents = b.documents.map((doc) => {
    // Un import JSON nu aduce octetii atasamentului. Nu pastram un storedName controlat de client:
    // ar putea indica fisierul altei firme de pe aceeasi instanta. Doar ZIP-ul il remapeaza la un
    // nume NOU, generat in staging si prezent explicit in storedNameMap.
    const oldBase = path.basename(String(doc.storedName || ''));
    const stored = o.storedNameMap && oldBase ? o.storedNameMap[oldBase] : null;
    return Object.assign({}, doc, { id: mid('documents', doc.id), firmaId: newFid, storedName: stored || null, interventieId: mid('extractInterventions', doc.interventieId) });
  });
  built.entries = b.entries.map((e) => Object.assign({}, e, {
    id: mid('entries', e.id), firmaId: newFid,
    fileId: mid('documents', e.fileId), movementId: mid('stockMovements', e.movementId),
    stocMovementId: mid('stockMovements', e.stocMovementId),
    stornoOf: mid('entries', e.stornoOf), stornoBy: mid('entries', e.stornoBy),
    bankStatementId: mid('bankStatements', e.bankStatementId), bankTransactionId: mid('bankTransactions', e.bankTransactionId),
    stocMovementIds: (e.stocMovementIds || []).map((x) => mid('stockMovements', x)),
    ...(e.duplicateOverride ? { duplicateOverride: Object.assign({}, e.duplicateOverride,
      { duplicateId: mid('entries', e.duplicateOverride.duplicateId) }) } : {}),
    ...(e.leasingRef ? { leasingRef: Object.assign({}, e.leasingRef,
      { contractId: mid('leasingContracts', e.leasingRef.contractId) }) } : {}),
  }));
  built.openItemAllocations = b.openItemAllocations.map((a) => Object.assign({}, a, {
    id: mid('openItemAllocations', a.id), firmaId: newFid,
    documentId: mid('entries', a.documentId), paymentId: mid('entries', a.paymentId),
  }));
  built.bankStatements = b.bankStatements.map((s) => Object.assign({}, s, {
    id: mid('bankStatements', s.id), firmaId: newFid, documentId: mid('documents', s.documentId),
  }));
  built.bankTransactions = b.bankTransactions.map((t) => Object.assign({}, t, {
    id: mid('bankTransactions', t.id), firmaId: newFid,
    statementId: mid('bankStatements', t.statementId), entryId: mid('entries', t.entryId),
    linkedEntryId: mid('entries', t.linkedEntryId), duplicateOf: mid('bankTransactions', t.duplicateOf),
    ...(t.proposal ? { proposal: Object.assign({}, t.proposal,
      { stinge: (t.proposal.stinge || []).map((id) => mid('entries', id)).filter(Boolean) }) } : {}),
  }));
  built.stockMovements = b.stockMovements.map((mv) => Object.assign({}, mv, {
    id: mid('stockMovements', mv.id), firmaId: newFid,
    productId: mid('products', mv.productId), gestiuneId: mid('gestiuni', mv.gestiuneId),
    gestiuneDestId: mid('gestiuni', mv.gestiuneDestId), entryId: mid('entries', mv.entryId),
    inventoryId: mid('inventories', mv.inventoryId),
    stornoOfMovementId: mid('stockMovements', mv.stornoOfMovementId),
    stornoMovementId: mid('stockMovements', mv.stornoMovementId),
    stornoEntryId: mid('entries', mv.stornoEntryId),
  }));
  built.inventories = b.inventories.map((iv) => Object.assign({}, iv, {
    id: mid('inventories', iv.id), firmaId: newFid, gestiuneId: mid('gestiuni', iv.gestiuneId),
    entryIds: (iv.entryIds || []).map((x) => mid('entries', x)),
    stornoEntryIds: (iv.stornoEntryIds || []).map((x) => mid('entries', x)),
    movementIds: (iv.movementIds || []).map((x) => mid('stockMovements', x)),
    stornoMovementIds: (iv.stornoMovementIds || []).map((x) => mid('stockMovements', x)),
    lines: (iv.lines || []).map((l) => Object.assign({}, l, { productId: mid('products', l.productId) })),
  }));
  built.payrollHistory = b.payrollHistory.map((h) => Object.assign({}, h, {
    id: mid('payrollHistory', h.id), firmaId: newFid,
    rows: (h.rows || []).map((r) => Object.assign({}, r, { angajatId: mid('angajati', r.angajatId) })),
  }));
  built.recurringInvoices = b.recurringInvoices.map((t) => Object.assign({}, t, {
    id: mid('recurringInvoices', t.id), firmaId: newFid,
    fields: Object.assign({}, t.fields || {}, { stoc: stockLines(t.fields && t.fields.stoc) }),
  }));
  built.recipes = b.recipes.map((r) => Object.assign({}, r, {
    id: mid('recipes', r.id), firmaId: newFid, productId: mid('products', r.productId), gestiuneId: mid('gestiuni', r.gestiuneId),
    materiale: (r.materiale || []).map((m) => Object.assign({}, m, { productId: mid('products', m.productId), gestiuneId: mid('gestiuni', m.gestiuneId) })),
  }));
  built.extractInterventions = b.extractInterventions.map((x) => Object.assign({}, x, {
    id: mid('extractInterventions', x.id), firmaId: newFid,
    documentId: mid('documents', x.documentId), entryId: mid('entries', x.entryId),
  }));

  // Preflight anti-duplicat INAINTE de prima mutatie. Restaurarea poate contine derogari istorice
  // legitime, dar fiecare trebuie sa indice exact articolul si cheia cu care a intrat initial.
  // Fara aceasta simulare, primul duplicat nejustificat ar fi aruncat abia in bucla de commit si
  // ar fi lasat o firma importata partial in memorie.
  const importedEntries = [];
  for (const e of built.entries) {
    const found = duplicateGuard.conflict(importedEntries, e);
    if (found) {
      const ov = e.duplicateOverride;
      const valid = ov && String(ov.reason || '').trim().length >= 10
        && String(ov.duplicateId || '') === String(found.duplicate.id)
        && Array.isArray(ov.keys) && found.keys.some((key) => ov.keys.includes(key));
      if (!valid) firmaImportError('Postare duplicata in pachet: articolul ' + e.id
        + ' coincide cu ' + found.duplicate.id + ' fara o derogare istorica valida.');
    }
    importedEntries.push(e);
  }

  // COMMIT in RAM: de aici inainte nu mai exista validari care pot arunca. La replace, campurile
  // privilegiate ale tintei (ownerId/subscription/lockedUntil/anaf/test/demo) raman NEATINSE.
  if (o.targetFid) {
    const f = d.firme.find((x) => x.id === newFid);
    Object.assign(f, pickFirmaFields(b.firma), { id: newFid });
    for (const k of FIRMA_IMPORT_COLLS) d[k] = d[k].filter((x) => (x.firmaId == null ? d.firmaActiva : x.firmaId) !== newFid);
  } else {
    const f = Object.assign(defaultFirma(newFid), pickFirmaFields(b.firma), { id: newFid });
    f.nume = (f.nume || 'Firma') + ' (import)';
    // Un pachet extern poate contine date reale. Nu mostenim si nu presupunem un consimtamant;
    // proprietarul trebuie sa clasifice explicit firma dupa import.
    f.dataMode = 'unclassified';
    d.firme.push(f);
  }
  d.partners[newFid] = b.partners;
  d.openingBalances[newFid] = b.openingBalances;
  for (const k of FIRMA_IMPORT_COLLS) {
    const rows = built[k] || [];
    // Restaurarea este singura exceptie intentionata: pachetul a fost validat integral mai sus,
    // iar istoricul sau trebuie reconstituit chiar daca firma-tinta are perioade blocate.
    if (k === 'entries') for (const e of rows) pushEntry(e, {
      context: 'import firma', allowClosedPeriod: true,
      restoreValidatedOverride: e.duplicateOverride ? RESTORE_DUPLICATE_OVERRIDE : null,
    });
    else d[k].push(...rows);
  }
  d.seq = seqImport;
  d.firmaActiva = newFid;
  if (!o.deferSave) save();
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
  get, save, load, migrate, nextId, pushEntry, assertEntryBasics, assertEntryUnique, conturiNecunoscute, entryShapeProblem, firmaActiva, getFirma, nextFirmaId, scoped, defaultFirma, pickFirmaFields, FIRMA_EDITABLE, assertPeriodOpen, dataRev,
  getUser, getUserByName, nextUserId, exportFirma, importFirma, validateFirmaBundle, validateRestoreGraph, restoreFromJson, flushMirror, flushStore,
  canSqlRead, largeFirma, sqlBalancePeriodOk, trialBalanceSql, trialFisaContSql, journalSql, ledgerSql, storeConflicted, persistStats, SQL_READ_THRESHOLD,
  DATA_DIR, UPLOAD_DIR, DB_FILE, DRIVER,
};
