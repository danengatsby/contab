'use strict';

// Bootstrap-ul aplicatiei, scos din server.js ca sa poata fi construit si in teste:
//  - loadDotEnv:          incarca .env inainte de require-urile care citesc variabile
//  - createApp:           intoarce { app, upload } — instanta Express cu middleware-ul de
//                         infrastructura (helmet/CSP, reqId, metrici, parsare body, static,
//                         sanitizare, multer + garda upload)
//  - applySecurityGuards: gardurile transversale de acces (autentificare, mustChange,
//                         drepturi granulare, paywall per-firma, plafon exporturi, urma exporturi)
// Modulele aplicatiei (db/log/metrics/...) se require-uiesc IN functii, nu aici: bootstrap e
// incarcat inainte de loadDotEnv, iar acele module isi citesc configuratia din env la incarcare.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Incarca variabilele din .env (cheie AI etc.). Nu suprascrie o variabila deja prezenta in
// mediu (chiar goala) — permite dezactivarea explicita (ex. STRIPE_SECRET_KEY='').
function loadDotEnv(rootDir) {
  try {
    const p = path.join(rootDir || path.join(__dirname, '..'), '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ignora */ }
}

function createApp() {
  const app = express();
  const rootDir = path.join(__dirname, '..');
  const db = require('./db');
  const log = require('./log');
  const metrics = require('./metrics');
  const uploadGuard = require('./uploadGuard');
  const visitors = require('./visitors');
  const commercialFunnel = require('./commercialFunnel');
  const helmet = require('helmet');

  // Reverse proxy: avem incredere DOAR in proxy-ul local (nginx pe 127.0.0.1) ca sa citim
  // X-Forwarded-For / X-Forwarded-Proto (pentru req.ip corect + cookie Secure pe HTTPS). NU
  // folosi `true` (incredere in ORICE hop): un client care atinge direct portul aplicatiei ar
  // putea falsifica X-Forwarded-For si ocoli blocarea anti-brute-force (rate-limit cheiat pe IP).
  // Configurabil prin TRUST_PROXY pentru alte topologii: un numar de hop-uri ("2") sau o subretea.
  const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

  // CONTAB_FORCE_HTTPS=1 (recomandat in productie): traficul HTTP din exterior este
  // redirectionat la HTTPS (GET/HEAD) sau refuzat (restul metodelor — un POST redirectionat
  // si-ar pierde corpul). Loopback-ul ramane permis pe HTTP: nginx-ul local si health check-ul
  // din deploy vorbesc cu aplicatia direct pe 127.0.0.1.
  if (process.env.CONTAB_FORCE_HTTPS === '1') {
    app.use((req, res, next) => {
      if (req.secure || req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1') return next();
      if (req.method === 'GET' || req.method === 'HEAD') {
        return res.redirect(308, 'https://' + (req.headers.host || '').replace(/:\d+$/, '') + req.originalUrl);
      }
      return res.status(403).json({ error: 'HTTPS obligatoriu.' });
    });
  }

  // Anteturi de securitate via helmet, cu CSP calibrat pentru aceasta aplicatie:
  //  - script-src 'self' (un singur /app.js, fara scripturi/handler-e inline)
  //  - style-src 'self' FARA unsafe-inline: zero elemente <style> si zero atribute style= in
  //    markup (poarta din test/run.js le tine la zero). Stilurile statice = utilitare generate
  //    in u.css (data-u); cele dinamice = data-style transferat pe el.style.cssText in core.js
  //    (CSSOM — nepenalizat de CSP). Un XSS de injectie HTML nu mai poate injecta nici stiluri.
  //  - img-src data:/blob: (favicon data-URI, canvas), connect-src include puntea de scanare locala
  //  - frame-src 'self' blob: (vizualizatorul PDF/e-Factura ruleaza intr-un <iframe> same-origin)
  // COEP/CORP sunt DEZACTIVATE intentionat: ar rupe vizualizatorul PDF (iframe blob:) si puntea
  // locala. HSTS ramane manual (conditionat de req.secure) si Permissions-Policy manual (helmet
  // nu-l seteaza) — mai jos.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        workerSrc: ["'self'"],   // service worker-ul PWA (public/sw.js) — same-origin
        manifestSrc: ["'self'"], // manifest.webmanifest
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", 'http://127.0.0.1:8765', 'http://localhost:8765'],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // ar rupe iframe-ul PDF (blob:) si puntea locala
    crossOriginResourcePolicy: false, // pastreaza comportamentul actual (fara restrictie noua)
    hsts: false,                      // HSTS ramane manual, conditionat de req.secure
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // 180 zile, fara subDomains (sa nu afecteze alte servicii)
    next();
  });

  // Identificator scurt per cerere: leaga logurile de eroare de cererea concreta si ajunge in
  // raspunsul 5xx (utilizatorul il poate raporta suportului pentru corelare rapida).
  app.use((req, res, next) => {
    req.reqId = crypto.randomBytes(4).toString('hex');
    res.setHeader('X-Request-Id', req.reqId);
    next();
  });

  // Cine atinge site-ul, AGREGAT PE IP (src/visitors.js). Sta INAINTEA fisierelor statice, ca sa
  // vada si vizitatorii care nu ajung niciodata la o ruta de API (pagina de prezentare, ecranul de
  // login, roboti). O(1) si fara I/O — persistenta e treaba unui job periodic, nu a cererii.
  // `req.user` nu e inca setat aici (autentificarea vine mai jos), deci legatura IP -> cont se
  // face la finalul raspunsului, cand utilizatorul e cunoscut.
  app.use((req, res, next) => {
    res.on('finish', () => {
      try { visitors.noteRequest(req); } catch (_) { /* nu rupe cererea */ }
      // Funnelul nu consuma randul pe IP de mai sus. Vede doar faptul ca una dintre cele doua
      // pagini publice de intrare a raspuns cu HTML si incrementeaza un contor agregat.
      try { commercialFunnel.noteLanding(db.get(), req, res.statusCode); } catch (_) { /* nu rupe cererea */ }
    });
    next();
  });

  // Durata fiecarui raspuns: agregata pe ruta (GET /api/metrics, admin) + avertisment in log
  // pentru cererile lente (CONTAB_SLOW_MS) — baza de decizie a optimizarilor de performanta.
  app.use((req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      metrics.record(metrics.routePattern(req), ms, res.statusCode);
      if (ms >= metrics.SLOW_MS) log.warn('cerere lenta', log.ctx(req, { status: res.statusCode, ms: Math.round(ms) }));
    });
    next();
  });

  // Webhook-ul Stripe are nevoie de body-ul BRUT (pentru verificarea semnaturii) — inainte de express.json.
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(rootDir, 'public'), {
    setHeaders(res, p) {
      // HTML/JS/CSS + uneltele puntii: revalidare mereu (actualizari fara cache). sw.js intra
      // aici (.js) — corect: service worker-ul trebuie revalidat, nu servit dintr-un cache vechi.
      if (/\.(html|js|css|ps1|bat|txt)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
      // uneltele puntii: text UTF-8 (ca descarcarea sa decodeze corect, nu binar)
      if (/\.(ps1|bat|txt)$/.test(p)) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      // manifestul PWA: content-type standard + revalidare (poate schimba icoane/culori la deploy)
      if (/\.webmanifest$/.test(p)) { res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); }
    },
  }));

  // Pe PostgreSQL, db.save() fotografiaza sincron dar COMMIT-ul este asincron. O ruta nu are voie
  // sa confirme succesul cat timp scrierea traieste doar in RAM. Bariera amana `res.end` pana la
  // golirea cozii; la ROLLBACK/esec inlocuieste raspunsul aparent reusit cu 503. Este DUPA static,
  // ca activele publice sa nu depinda de baza, si INAINTE de toate rutele API inregistrate ulterior.
  app.use(require('./durabilityBarrier').createDurabilityBarrier(db, log));

  // Sanitizare parametri de perioada — accepta doar YYYY / YYYY-MM (luna 01-12); valorile invalide devin goale
  app.use((req, res, next) => {
    const q = req.query || {};
    if (q.period != null && !/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(q.period)) q.period = '';
    if (q.asOf != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(q.asOf)) q.asOf = '';
    for (const k of ['year', 'an']) { if (q[k] != null && !/^\d{4}$/.test(q[k])) q[k] = ''; }
    next();
  });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, db.UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.pdf';
      cb(null, crypto.randomBytes(8).toString('hex') + ext);
    },
  });
  // Extensii acceptate la upload — blocheaza HTML/JS/SVG etc. (XSS stocat: un fisier activ
  // servit din origin-ul aplicatiei ar rula cu sesiunea utilizatorului care il deschide).
  const UPLOAD_EXT_OK = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.csv', '.txt',
    '.xls', '.xlsx', '.dbf', '.xml', '.zip', '.json', '.sta', '.940', '.mt940']);
  const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      // `ext &&` lasa sa treaca fisierele FARA extensie: conditia scurtcircuita si allowlist-ul nu
      // se mai aplica. Iar `storage` le salveaza ca `.pdf` (extname(...) || '.pdf'), deci ajungeau
      // la extractorul PDF fara nicio validare. Lipsa extensiei e „necunoscut", nu „permis".
      if (!UPLOAD_EXT_OK.has(ext)) {
        const err = new Error(ext
          ? 'Tip de fisier neacceptat (' + ext + '). Acceptate: PDF, imagini, CSV/TXT, XLS(X), DBF, XML, ZIP, JSON.'
          : 'Fisierul nu are extensie, deci tipul lui nu poate fi verificat. Redenumeste-l cu extensia potrivita (ex. .pdf).');
        err.status = 400;
        return cb(err);
      }
      cb(null, true);
    },
  });
  // Extensia nu garanteaza continutul: dupa salvarea multer se verifica magic bytes
  // (src/uploadGuard.js) si se plafoneaza upload-urile per UTILIZATOR (rutele sunt
  // autentificate — abuzul vine de la conturi, nu de la IP-uri). upload.single ramane
  // interfata rutelor: intoarce lantul [plafon, multer, verificare continut].
  const RATE_UPLOAD = Number(process.env.CONTAB_RATE_UPLOAD || 60); // upload-uri/ora/utilizator
  const uploadLimiter = uploadGuard.userLimit('upload', RATE_UPLOAD, 'Prea multe fisiere incarcate.');
  const rawUploadSingle = upload.single.bind(upload);
  upload.single = (field) => [uploadLimiter, rawUploadSingle(field), uploadGuard.verifyUploadContent];

  return { app, upload };
}

function applySecurityGuards(app, ctx) {
  const { logAudit, activeId } = ctx;
  const db = require('./db');
  const log = require('./log');
  const plans = require('./plans');
  const permissions = require('./permissions');
  const uploadGuard = require('./uploadGuard');
  const { currentUser } = require('./session');
  // Unele calcule read-only folosesc POST fiindcă primesc un formular mare în corp. Metoda HTTP
  // nu le transformă în mutații: `/api/preview` compune articolul fără save/nextId/audit. Lista
  // semantică este folosită de TOATE porțile care separă citirea de scriere, ca una să nu-l lase
  // iar următoarea să-l blocheze drept „scriere”. CSRF rămâne obligatoriu pentru orice POST.
  const isReadOnlyRequest = (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    || (req.method === 'POST' && req.path === '/api/preview');

  // ── CSRF: token sincronizator + allowlist de origine (aparare in adancime peste SameSite=Lax).
  // Garda veche accepta cererea cand `Origin`/`Referer` LIPSEA, „pentru compatibilitate" — o
  // conditie care se deschide la absenta unui antet, adica exact ce cauta un atacator. Acum:
  // origine straina -> respins; sesiune prezenta -> token OBLIGATORIU (si cand antetul lipseste);
  // fara sesiune -> trece (nu exista credentiale ambientale de calarit: login, inregistrare,
  // webhook Stripe, plata de vizitator). Detalii si rationament: src/csrf.js.
  //
  // Trepte de rollback, in ordinea slabirii:
  //   CONTAB_CSRF=origin  -> doar allowlist de origine (comportamentul vechi, fara token)
  //   CONTAB_CSRF=0       -> garda oprita complet
  const csrf = require('./csrf');
  const sessionLib = require('./session');
  const CSRF_MODE = process.env.CONTAB_CSRF === '0' ? 'off'
    : (process.env.CONTAB_CSRF === 'origin' ? 'origin' : 'token');
  const CSRF_ORIGINS = process.env.CONTAB_CSRF_ORIGINS || process.env.APP_URL || '';
  app.use((req, res, next) => {
    if (CSRF_MODE === 'off' || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!/^\/(api|pdf|xml|csv|efactura)/.test(req.path) || req.path === '/api/stripe/webhook') return next();
    const v = csrf.check({
      headers: req.headers,
      // in modul `origin` ignoram sesiunea, deci token-ul nu se mai cere (rollback)
      sessId: CSRF_MODE === 'token' ? sessionLib.sessionIdOf(req) : null,
      secret: sessionLib.csrfSecret(),
      extraOrigins: CSRF_ORIGINS,
    });
    if (v.ok) return next();
    return res.status(403).json({ error: v.motiv, csrf: v.reason });
  });

  // Orice ruta de API/livrabile (pdf/xml/csv/efactura) cere sesiune, cu exceptia celor publice.
  const PUBLIC_PATHS = new Set(['/api/health', '/api/login', '/api/logout', '/api/me', '/api/bootstrap/initialize', '/api/forgot-password', '/api/register', '/api/legal-status', '/api/stripe/webhook', '/api/plans', '/api/demo-login', '/api/checkout-guest', '/api/client-error', '/api/registru-anaf']);
  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/api/invite/') || req.path.startsWith('/api/reset/')) return next();
    if (/^\/(api|pdf|xml|csv|efactura)/.test(req.path)) {
      const u = currentUser(req);
      if (!u) return res.status(401).json({ error: 'Neautentificat' });
      req.user = u;
    }
    next();
  });

  // Impersonarea este o sesiune de diagnostic READ-ONLY. Nicio ruta noua nu poate deveni
  // accidental mutanta sub impersonare: exceptiile sunt numai iesirile sigure din sesiune.
  app.use((req, res, next) => {
    if (!req.impersonating || isReadOnlyRequest(req)
        || req.path === '/api/impersonate/stop' || req.path === '/api/logout') return next();
    return res.status(403).json({
      error: 'Impersonarea este read-only. Ieși din impersonare pentru orice modificare.',
      impersonationReadOnly: true,
    });
  });

  // Fail-closed pentru operatiunile mutante: verificam atat dreptul de scriere, cat si lantul
  // existent INAINTE ca ruta sa schimbe date. Logout si raportarea unei erori de client raman
  // disponibile ca iesiri sigure; webhook-ul va primi 503 si va fi reincercat de furnizor.
  const auditLog = require('./auditLog');
  app.use((req, res, next) => {
    const xmlCuEfect = req.method === 'GET' && req.path.startsWith('/xml/');
    if ((isReadOnlyRequest(req) && !xmlCuEfect) || req.path === '/api/logout' || req.path === '/api/client-error') return next();
    if (!/^\/(api|pdf|xml|csv|efactura)/.test(req.path)) return next();
    const p = auditLog.probeWritable();
    if (!p.ok) return res.status(503).json({ error: 'Jurnalul de audit nu este disponibil; operatiunea a fost oprita inainte de scriere.', auditUnavailable: true });
    next();
  });

  // ── Plafon GENERAL pe API: per utilizator (per IP inainte de autentificare), fereastra de
  // un minut. Plasa contra buclelor de client si scanarilor — generos fata de utilizarea
  // normala (un dashboard incarca zeci de cereri, nu sute pe minut). CONTAB_RATE_API=0 il
  // dezactiveaza; plafoanele SPECIFICE (login, register, upload, export) raman separate.
  const RATE_API = Number(process.env.CONTAB_RATE_API || 600); // cereri/minut
  const apiLimiter = uploadGuard.generalLimit(RATE_API, 60 * 1000);
  app.use((req, res, next) => (/^\/(api|pdf|xml|csv|efactura)/.test(req.path) ? apiLimiter(req, res, next) : next()));

  // Schimbare de parola OBLIGATORIE (cont cu parola implicita): pana cand utilizatorul isi
  // pune o parola noua, orice actiune e blocata — raman permise doar identitatea, delogarea
  // si chiar schimbarea parolei. UI-ul afiseaza un ecran care nu se poate inchide.
  const MUSTCHANGE_ALLOW = new Set(['/api/me', '/api/logout', '/api/change-password']);
  app.use((req, res, next) => {
    if (req.user && req.user.mustChange && !MUSTCHANGE_ALLOW.has(req.path)) {
      return res.status(403).json({ error: 'Trebuie să îți schimbi parola implicită înainte de a continua.', mustChange: true });
    }
    next();
  });

  // Conturile administrator au acces transversal la toate firmele, configuratia fiscala,
  // backup si impersonare. Pana la inrolarea 2FA, sesiunea poate face exclusiv operatiunile
  // necesare configurarii factorului (plus identificare, schimbare parola si logout).
  const ADMIN_2FA_ALLOW = /^\/api\/(?:me|meta|logout|change-password|2fa(?:\/|$))/;
  app.use((req, res, next) => {
    const principal = req.realUser || req.user;
    if (principal && permissions.requiresTwoFactor(principal, db.get()) && !principal.twofa && !ADMIN_2FA_ALLOW.test(req.path)) {
      return res.status(428).json({
        error: 'Activează autentificarea în doi pași înainte de a folosi acest cont privilegiat.',
        twofaRequired: true,
      });
    }
    next();
  });

  // Datele unei firme vechi/importate nu sunt declarate automat „de test” si nici „reale”.
  // Pana cand proprietarul alege explicit, scrierile de lucru sunt oprite. Firmele de test merg,
  // iar firmele reale cer atat readiness global, cat si acceptarea versiunii DPA curente.
  const legal = require('./legalCompliance');
  const LEGAL_WRITE_EXEMPT = /^\/api\/(logout|me|meta|legal(?:\/|$)|profile|account|change-password|sessions|2fa|step-up|messages|plans|subscription|checkout|stripe|impersonate|firme(?:\/|$))/;
  app.use((req, res, next) => {
    if (!req.user || isReadOnlyRequest(req) || LEGAL_WRITE_EXEMPT.test(req.path)) return next();
    if (!/^\/(api|pdf|xml|csv|efactura)/.test(req.path)) return next();
    const firma = db.getFirma(activeId(req));
    if (!firma) return next();
    const state = legal.firmState(firma);
    if (state.operational) return next();
    return res.status(428).json({
      error: state.reason === 'DATA_MODE_UNCLASSIFIED'
        ? 'Declară în Setări dacă firma folosește date fictive sau date reale înainte de prima scriere.'
        : 'Prelucrarea datelor reale este oprită până la completarea cadrului juridic și acceptarea DPA-ului curent.',
      code: state.reason,
      legalMode: state.mode,
    });
  });

  // ── Matrice centrala pe ACTIUNI ───────────────────────────────────────────────────────────
  // Permisiunea generica `write` ramane gardul minim al mutatiilor, dar NU mai autorizeaza
  // implicit salarii, trezorerie, depuneri, profil fiscal, inchideri ori exporturi. Catalogul
  // de rute sensibile este unic in permissions.requiredActions si se aplica inclusiv pe GET-urile
  // cu efect (XML fiscal) sau cu risc de exfiltrare (PDF/CSV).
  const RO_EXEMPT = /^\/api\/(logout|me|meta|plans|profile|account|change-password|sessions|2fa|step-up|messages|subscription|checkout|stripe)/;
  const RO_ALLOW = /^\/api\/firme(?:\/demo)?$|^\/api\/firme\/\d+\/activate$/;
  // Crearea primei firme / a firmei demo nu are inca un context de firma pe care sa existe
  // dreptul `write`; serviciul valideaza separat contul si operatia. Activarea ramane o citire.
  app.use((req, res, next) => {
    if (!req.user) return next();
    const fid = activeId(req);
    const firma = db.getFirma(fid);
    for (const action of permissions.requiredActions(req.method, req.path, req.body)) {
      const v = permissions.verdict(req.user, fid, action, firma);
      if (!v.ok) return res.status(403).json({ error: v.reason, permission: action, firmaRole: v.role });
    }
    if (!isReadOnlyRequest(req) && !RO_EXEMPT.test(req.path) && !RO_ALLOW.test(req.path)) {
      const v = permissions.verdict(req.user, fid, 'write', firma);
      if (!v.ok) return res.status(403).json({ error: v.reason, permission: 'write', firmaRole: v.role });
    }
    next();
  });

  // Step-up pe operatiile cu raza mare. Se aplica DUPA drepturi: un utilizator neautorizat
  // primeste 403, nu un indiciu ca ar putea debloca actiunea doar prin reautentificare.
  const stepUp = require('./stepUp');
  app.use((req, res, next) => {
    if (!req.user || req.path === '/api/step-up') return next();
    const activeFirma = db.getFirma(activeId(req));
    if (req.user.role !== 'admin' && activeFirma && plans.firmaLocked(activeFirma)) return next();
    const actions = permissions.requiredActions(req.method, req.path, req.body);
    let scope = actions.includes('declaration.submit') ? 'filing' : null;
    if (req.path === '/api/restore'
        || ((req.path === '/api/firme/import' || req.path === '/api/firme/import-zip') && req.query.mode === 'replace')) scope = 'restore';
    const bulkExport = req.path === '/api/firme/export-all'
      || /^\/api\/firme\/\d+\/export(?:-zip)?$/.test(req.path)
      || req.path === '/api/backup' || req.path.startsWith('/api/backup/file/')
      || req.path === '/api/dosar-anual' || req.path === '/xml/saft';
    if (bulkExport) scope = 'bulk-export';
    if (scope && !stepUp.valid(req, scope)) return stepUp.requiredResponse(res, scope);
    next();
  });

  // ── Billing STRICT per-firma: fiecare firma are propriul abonament. Scrierile pe FIRMA ACTIVA
  // sunt permise doar daca firma are abonament activ sau proba nefinalizata; altfel read-only pana
  // la abonare (plata pe firma). Citirile si rutele de cont/gestionare firma raman libere.
  // `impersonate` e exceptat: altfel adminul care impersoneaza un user cu firma expirata ar fi
  // BLOCAT in impersonare (402 chiar pe /api/impersonate/stop). Paywall-ul ramane pe restul
  // rutelor si sub impersonare — adminul vede exact ce vede utilizatorul.
  const FIRMA_BILL_EXEMPT = /^\/api\/(logout|me|meta|plans|profile|account|change-password|sessions|2fa|step-up|messages|subscription|checkout|stripe|impersonate)|^\/api\/firme(\/\d+\/(keep|activate|subscribe|trial))?$|^\/api\/firme\/\d+$|^\/api\/firme\/(cerere-acces|cereri\/[\w-]+|contabili|servicii|servicii\/[\w-]+(\/retrage)?)$/;
  app.use((req, res, next) => {
    if (!req.user || req.user.role === 'admin') return next();
    if (isReadOnlyRequest(req) && !/^\/(pdf|xml|csv|efactura)/.test(req.path)) return next(); // citirile libere
    // `trial` e exceptat DELIBERAT: e iesirea din blocaj, la fel ca `subscribe`. Fara exceptie,
    // paywall-ul ar raspunde 402 tocmai la cererea prin care utilizatorul iese din 402.
    // Cererile de acces sunt tot gestiune de CONT, nu munca contabila: un contabil caruia i-a
    // expirat proba pe o firma trebuie sa poata cere acces la alta, iar un patron trebuie sa
    // poata aproba chiar daca propria firma e in pauza de plata. Acelasi rationament pentru
    // angajarea unui contabil (`servicii`): un patron blocat de paywall are cu atat mai multa
    // nevoie de un contabil — nu i se inchide usa exact cand o cauta.
    if (FIRMA_BILL_EXEMPT.test(req.path)) return next(); // cont + gestionarea firmei (activate/subscribe/trial/cereri/delete/create)
    const f = db.getFirma(activeId(req));
    if (f && plans.firmaLocked(f)) {
      const st = plans.firmaStatus(f).status;
      return res.status(402).json({
        error: (st === 'expired' ? 'Proba pentru firma „' + (f.nume || '') + '” a expirat.' : 'Firma „' + (f.nume || '') + '” nu are abonament activ.')
          + ' Continuarea lucrului costă 99 lei/lună/firmă. Te abonezi acum?',
        firmaTrialExpired: true, firmaId: f.id, firmaNume: f.nume || '', firmaStatus: st,
      });
    }
    next();
  });

  // Plafon per utilizator pe exporturile costisitoare (CPU/IO la fiecare cerere): SAF-T,
  // crearea de backup si exportul de firma. Descarcarile mici (CSV/PDF punctuale) raman libere.
  const RATE_EXPORT = Number(process.env.CONTAB_RATE_EXPORT || 10); // exporturi mari/ora/utilizator
  const EXPORT_LIMITED = /^\/(xml\/saft|xml\/pain001|api\/backup|api\/firme\/\d+\/export-zip|api\/firme\/export-all|api\/dosar-anual)$/;
  const exportLimiter = uploadGuard.userLimit('export', RATE_EXPORT, 'Prea multe exporturi mari.');
  app.use((req, res, next) => (EXPORT_LIMITED.test(req.path) ? exportLimiter(req, res, next) : next()));

  // Urma de business pe exporturi: cine a descarcat ce. XML-urile fiscale (declaratii/SAF-T/
  // e-Factura) intra in AUDIT — sunt rare si relevante legal; PDF/CSV raman doar in logul
  // structurat (frecvente: in audit ar impinge afara actiunile reale, plafonul viu e configurabil).
  app.use((req, res, next) => {
    if (req.method === 'GET' && /^\/(xml|pdf|csv)\//.test(req.path)) {
      res.on('finish', () => {
        if (res.statusCode !== 200) return;
        log.info('export servit', log.ctx(req, { status: 200 }));
        if (req.path.startsWith('/xml/')) {
          try { logAudit('export.xml', String(req.originalUrl || req.path).slice(0, 120)
            + String(req.filingAuditDetail || ''), { req }); }
          catch (e) { log.error('audit export esuat dupa trimiterea raspunsului', log.ctx(req, { status: 500, err: e })); }
        }
      });
    }
    next();
  });
}

module.exports = { loadDotEnv, createApp, applySecurityGuards };
