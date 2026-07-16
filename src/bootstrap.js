'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function loadDotEnv(rootDir) {
  const p = path.join(rootDir || __dirname + '/..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function createApp(options = {}) {
  const app = express();
  const rootDir = options.rootDir || path.join(__dirname, '..');
  const db = options.db || require('./db');
  const log = options.log || require('./log');
  const metrics = options.metrics || require('./metrics');
  const helmet = require('helmet');
  const uploadGuard = options.uploadGuard || require('./uploadGuard');

  app.set('trust proxy', options.trustProxy || process.env.TRUST_PROXY || 'loopback');
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
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
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    hsts: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  app.use((req, res, next) => {
    req.reqId = crypto.randomBytes(4).toString('hex');
    res.setHeader('X-Request-Id', req.reqId);
    next();
  });
  app.use((req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      metrics.record(metrics.routePattern(req), ms, res.statusCode);
      if (ms >= metrics.SLOW_MS) log.warn('cerere lenta', log.ctx(req, { status: res.statusCode, ms: Math.round(ms) }));
    });
    next();
  });
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(rootDir, 'public'), {
    setHeaders(res, p) {
      if (/\.(html|js|css|ps1|bat|txt)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
      if (/\.(ps1|bat|txt)$/.test(p)) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    },
  }));
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
  const RATE_UPLOAD = Number(process.env.CONTAB_RATE_UPLOAD || 60);
  const RATE_EXPORT = Number(process.env.CONTAB_RATE_EXPORT || 10);
  const uploadLimiter = uploadGuard.userLimit('upload', RATE_UPLOAD, 'Prea multe fisiere incarcate.');
  const rawUploadSingle = upload.single.bind(upload);
  upload.single = (field) => [uploadLimiter, rawUploadSingle(field), uploadGuard.verifyUploadContent];

  app.locals.bootstrap = { upload, uploadGuard, db, log, metrics };
  return app;
}

function applySecurityGuards(app, ctx = {}) {
  const { db, log, logAudit, currentUser, allowedFirme, plans, activeId, uploadGuard } = ctx;
  const RATE_EXPORT = Number(process.env.CONTAB_RATE_EXPORT || 10);
  const PUBLIC_PATHS = new Set(['/api/health', '/api/login', '/api/logout', '/api/me', '/api/forgot-password', '/api/register', '/api/stripe/webhook', '/api/plans', '/api/demo-login', '/api/checkout-guest']);
  const MUSTCHANGE_ALLOW = new Set(['/api/me', '/api/logout', '/api/change-password']);
  const RO_EXEMPT = /^\/api\/(logout|me|meta|plans|profile|change-password|sessions|2fa|messages|subscription|checkout|stripe)/;
  const RO_ALLOW = /^\/api\/firme\/\d+\/activate$/;
  const SALARII_RX = /^\/(api\/(angajati|stat-plata|registru-salarii)|pdf\/(stat-plata|fluturas|adeverinta|registru-salarii)|xml\/d112)/;
  const FIRMA_BILL_EXEMPT = /^\/api\/(logout|me|meta|plans|profile|change-password|sessions|2fa|messages|subscription|checkout|stripe|impersonate)|^\/api\/firme(\/\d+\/(keep|activate|subscribe))?$|^\/api\/firme\/\d+$/;
  const EXPORT_LIMITED = /^\/(xml\/saft|api\/backup|api\/firme\/\d+\/export-zip|api\/firme\/export-all)$/;
  const exportLimiter = uploadGuard && uploadGuard.userLimit ? uploadGuard.userLimit('export', RATE_EXPORT, 'Prea multe exporturi mari.') : null;

  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/api/invite/') || req.path.startsWith('/api/reset/')) return next();
    if (/^\/(api|pdf|xml|csv|efactura)/.test(req.path)) {
      const u = currentUser(req);
      if (!u) return res.status(401).json({ error: 'Neautentificat' });
      req.user = u;
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.user && req.user.mustChange && !MUSTCHANGE_ALLOW.has(req.path)) {
      return res.status(403).json({ error: 'Trebuie să îți schimbi parola implicită înainte de a continua.', mustChange: true });
    }
    next();
  });

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

  app.use((req, res, next) => {
    if (!req.user || req.user.role === 'admin') return next();
    if (req.method === 'GET' && !/^(\/pdf|\/xml|\/csv|\/efactura)/.test(req.path)) return next();
    if (FIRMA_BILL_EXEMPT.test(req.path)) return next();
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

  app.use((req, res, next) => (EXPORT_LIMITED.test(req.path) && exportLimiter ? exportLimiter(req, res, next) : next()));

  app.use((req, res, next) => {
    if (req.method === 'GET' && /^(\/xml|\/pdf|\/csv)\//.test(req.path)) {
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
