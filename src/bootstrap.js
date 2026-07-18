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
      if (ext && !UPLOAD_EXT_OK.has(ext)) {
        const err = new Error('Tip de fisier neacceptat (' + ext + '). Acceptate: PDF, imagini, CSV/TXT, XLS(X), DBF, XML, ZIP, JSON.');
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
  const uploadGuard = require('./uploadGuard');
  const { currentUser } = require('./session');

  // ── CSRF (aparare in adancime peste SameSite=Lax): cererile MUTANTE catre API trebuie sa
  // vina din propria origine. Browserele trimit Origin pe POST; LIPSA antetului e permisa
  // (curl, teste, integrari server-to-server — CSRF cu cookie presupune un browser, iar acela
  // trimite antetul). Webhook-ul Stripe e exceptat: vine extern si e autentificat prin
  // semnatura, nu prin cookie. Rollback: CONTAB_CSRF=0.
  const CSRF_OFF = process.env.CONTAB_CSRF === '0';
  app.use((req, res, next) => {
    if (CSRF_OFF || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!/^\/(api|pdf|xml|csv|efactura)/.test(req.path) || req.path === '/api/stripe/webhook') return next();
    const src = req.headers.origin || req.headers.referer;
    if (!src) return next();
    let host = null; try { host = new URL(src).host; } catch (_) { host = null; }
    if (host && host === req.headers.host) return next();
    return res.status(403).json({ error: 'Cerere respinsă (origine străină).' });
  });

  // Orice ruta de API/livrabile (pdf/xml/csv/efactura) cere sesiune, cu exceptia celor publice.
  const PUBLIC_PATHS = new Set(['/api/health', '/api/login', '/api/logout', '/api/me', '/api/forgot-password', '/api/register', '/api/stripe/webhook', '/api/plans', '/api/demo-login', '/api/checkout-guest']);
  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/api/invite/') || req.path.startsWith('/api/reset/')) return next();
    if (/^\/(api|pdf|xml|csv|efactura)/.test(req.path)) {
      const u = currentUser(req);
      if (!u) return res.status(401).json({ error: 'Neautentificat' });
      req.user = u;
    }
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

  // ── Drepturi granulare per utilizator (Setari -> Utilizatori, setate de admin) ──
  //  - readonly:    doar vizualizare — blocheaza orice scriere pe date (raman permise rutele de cont)
  //  - faraSalarii: fara acces la modulul de salarizare (date sensibile), nici macar in citire
  const RO_EXEMPT = /^\/api\/(logout|me|meta|plans|profile|change-password|sessions|2fa|messages|subscription|checkout|stripe)/;
  const RO_ALLOW = /^\/api\/firme\/\d+\/activate$/; // schimbarea firmei active e tot o "citire"
  const SALARII_RX = /^\/(api\/(angajati|stat-plata|registru-salarii)|pdf\/(stat-plata|fluturas|adeverinta|registru-salarii)|xml\/d112)/;
  app.use((req, res, next) => {
    const dr = req.user && req.user.drepturi;
    if (!dr || req.user.role === 'admin') return next();
    if (dr.faraSalarii && SALARII_RX.test(req.path)) {
      return res.status(403).json({ error: 'Nu ai acces la modulul de salarizare (drept restrictionat de administrator).' });
    }
    if (dr.readonly && req.method !== 'GET' && !RO_EXEMPT.test(req.path) && !RO_ALLOW.test(req.path)) {
      return res.status(403).json({ error: 'Cont doar-citire: poti vizualiza datele, dar nu le poti modifica. Cere administratorului drept de operare.' });
    }
    next();
  });

  // ── Billing STRICT per-firma: fiecare firma are propriul abonament. Scrierile pe FIRMA ACTIVA
  // sunt permise doar daca firma are abonament activ sau proba nefinalizata; altfel read-only pana
  // la abonare (plata pe firma). Citirile si rutele de cont/gestionare firma raman libere.
  // `impersonate` e exceptat: altfel adminul care impersoneaza un user cu firma expirata ar fi
  // BLOCAT in impersonare (402 chiar pe /api/impersonate/stop). Paywall-ul ramane pe restul
  // rutelor si sub impersonare — adminul vede exact ce vede utilizatorul.
  const FIRMA_BILL_EXEMPT = /^\/api\/(logout|me|meta|plans|profile|change-password|sessions|2fa|messages|subscription|checkout|stripe|impersonate)|^\/api\/firme(\/\d+\/(keep|activate|subscribe))?$|^\/api\/firme\/\d+$/;
  app.use((req, res, next) => {
    if (!req.user || req.user.role === 'admin') return next();
    if (req.method === 'GET' && !/^\/(pdf|xml|csv|efactura)/.test(req.path)) return next(); // citirile libere
    if (FIRMA_BILL_EXEMPT.test(req.path)) return next(); // cont + gestionarea firmei (activate/subscribe/delete/create)
    const f = db.getFirma(activeId(req));
    if (f && plans.firmaLocked(f)) {
      const st = plans.firmaStatus(f).status;
      return res.status(402).json({
        error: (st === 'expired' ? 'Proba pentru firma „' + (f.nume || '') + '" a expirat.' : 'Firma „' + (f.nume || '') + '" nu are abonament activ.')
          + ' Continuarea lucrului se face cu abonament (plata pe firmă). Te abonezi acum?',
        firmaTrialExpired: true, firmaId: f.id, firmaNume: f.nume || '', firmaStatus: st,
      });
    }
    next();
  });

  // Plafon per utilizator pe exporturile costisitoare (CPU/IO la fiecare cerere): SAF-T,
  // crearea de backup si exportul de firma. Descarcarile mici (CSV/PDF punctuale) raman libere.
  const RATE_EXPORT = Number(process.env.CONTAB_RATE_EXPORT || 10); // exporturi mari/ora/utilizator
  const EXPORT_LIMITED = /^\/(xml\/saft|api\/backup|api\/firme\/\d+\/export-zip|api\/firme\/export-all)$/;
  const exportLimiter = uploadGuard.userLimit('export', RATE_EXPORT, 'Prea multe exporturi mari.');
  app.use((req, res, next) => (EXPORT_LIMITED.test(req.path) ? exportLimiter(req, res, next) : next()));

  // Urma de business pe exporturi: cine a descarcat ce. XML-urile fiscale (declaratii/SAF-T/
  // e-Factura) intra in AUDIT — sunt rare si relevante legal; PDF/CSV raman doar in logul
  // structurat (frecvente: in audit ar impinge afara actiunile reale, plafonul e 3000).
  app.use((req, res, next) => {
    if (req.method === 'GET' && /^\/(xml|pdf|csv)\//.test(req.path)) {
      res.on('finish', () => {
        if (res.statusCode !== 200) return;
        log.info('export servit', log.ctx(req, { status: 200 }));
        if (req.path.startsWith('/xml/')) logAudit('export.xml', String(req.originalUrl || req.path).slice(0, 120), { req });
      });
    }
    next();
  });
}

module.exports = { loadDotEnv, createApp, applySecurityGuards };
