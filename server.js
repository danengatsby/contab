'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Incarca variabilele din .env (cheie AI etc.) inainte de orice require care le citeste
(() => {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      // nu suprascrie o variabila deja prezenta in mediu (chiar goala) — permite dezactivarea explicita (ex. STRIPE_SECRET_KEY='')
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ignora */ }
})();

const db = require('./src/db');
const coa = require('./src/chartOfAccounts');
const { typesForClient, getType } = require('./src/documentTypes');
const ai = require('./src/aiExtractor');
const stmt = require('./src/statements');
const fiscal = require('./src/fiscal');
const saft = require('./src/saft');
const { statePlata } = require('./src/payroll'); // registruSalarii + rutele de salarizare: src/routes/payroll.js
const anaf = require('./src/anaf');
const authlib = require('./src/auth');
const totp = require('./src/totp');
const pdf = require('./src/pdf');
const messages = require('./src/messages');
const presence = require('./src/presence');
const validate = require('./src/validate');
const { sendMail, sendNotifMail, sendDeadlineDigests } = require('./src/notify');
const { pollSpv } = require('./src/anafService'); // auto-poll job; restul e in src/routes/anaf.js
const { ensureDocSeries } = require('./src/stocksService'); // serii de documente (ctx pentru config.js/chitante)
const efacturaImport = require('./src/efacturaImport');
const plans = require('./src/plans');
const billing = require('./src/billing');
const log = require('./src/log');
const { round2, period: periodOf } = require('./src/util');

// Pe sqlite/json load() e sincron; pe PostgreSQL intoarce o promisiune. Serverul incepe
// sa asculte (app.listen, la finalul fisierului) abia dupa ce baza e hidratata.
const dbReady = Promise.resolve(db.load()).then(() => {
  coa.addAccounts(db.get().customAccounts); // inregistreaza conturile personalizate importate
  fiscal.applyConfig(db.get().settings.fiscal); // aplica cotele fiscale configurate (peste valorile implicite)
});

const app = express();
// Reverse proxy: avem incredere DOAR in proxy-ul local (nginx pe 127.0.0.1) ca sa citim
// X-Forwarded-For / X-Forwarded-Proto (pentru req.ip corect + cookie Secure pe HTTPS). NU
// folosi `true` (incredere in ORICE hop): un client care atinge direct portul aplicatiei ar
// putea falsifica X-Forwarded-For si ocoli blocarea anti-brute-force (rate-limit cheiat pe IP).
// Configurabil prin TRUST_PROXY pentru alte topologii: un numar de hop-uri ("2") sau o subretea.
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

// Anteturi de securitate via helmet, cu CSP calibrat pentru aceasta aplicatie:
//  - script-src 'self' (un singur /app.js, fara scripturi/handler-e inline)
//  - style-src 'unsafe-inline' (atribute style= folosite pe larg in HTML)
//  - img-src data:/blob: (favicon data-URI, canvas), connect-src include puntea de scanare locala
//  - frame-src 'self' blob: (vizualizatorul PDF/e-Factura ruleaza intr-un <iframe> same-origin)
// COEP/CORP sunt DEZACTIVATE intentionat: ar rupe vizualizatorul PDF (iframe blob:) si puntea
// locala. HSTS ramane manual (conditionat de req.secure) si Permissions-Policy manual (helmet
// nu-l seteaza) — mai jos.
const helmet = require('helmet');
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

// Webhook-ul Stripe are nevoie de body-ul BRUT (pentru verificarea semnaturii) — inainte de express.json.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, p) {
    // HTML/JS/CSS + uneltele puntii: revalidare mereu (actualizari fara cache)
    if (/\.(html|js|css|ps1|bat|txt)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
    // uneltele puntii: text UTF-8 (ca descarcarea sa decodeze corect, nu binar)
    if (/\.(ps1|bat|txt)$/.test(p)) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
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

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  log.error('eroare necuprinsa in ruta', log.ctx(req, { status: 500, err: e }));
  try { trackServerError(req, e); } catch (_) { /* inainte de definirea trackerului: ignora */ }
  res.status(500).json({ error: String(e.message || e), reqId: req.reqId });
});

// ───────────────────────── AUTENTIFICARE ─────────────────────────
// Primitive de sesiune/auth/anti-brute-force (partajate cu rutele de cont): src/session.js
const { currentUser, allowedFirme, publicUser, startSession, setTrustedDevice, deviceTrusted, isLocked, bumpFail, clearFails, attemptKey, pruneLoginAttempts } = require('./src/session');

// jurnal de audit (cine, ce actiune, pe ce firma)
function logAudit(action, detail, opts) {
  const d = db.get();
  const o = opts || {};
  d.audit = d.audit || [];
  // daca actiunea e facuta de un admin in modul impersonare, pastreaza si numele real
  const viaAdmin = o.req && o.req.impersonating && o.req.realUser ? o.req.realUser.username : null;
  d.audit.push({
    id: (d.audit[d.audit.length - 1] || {}).id + 1 || 1,
    ts: new Date().toISOString(),
    userId: o.userId != null ? o.userId : (o.req && o.req.user && o.req.user.id),
    username: o.username || (o.req && o.req.user && o.req.user.username) || '',
    firmaId: o.firmaId != null ? o.firmaId : (o.req && o.req.user ? activeId(o.req) : null),
    action, detail: detail || '',
    ...(viaAdmin ? { viaAdmin } : {}),
  });
  if (d.audit.length > 3000) d.audit = d.audit.slice(-3000);
}

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
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Necesita drepturi de administrator.' });
  next();
}

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

// ── Proba expirata => cont READ-ONLY: vede datele, dar nu mai inregistreaza si nu mai
// genereaza livrabile (PDF/XML/CSV), pana la alegerea unui plan. Raman permise: citirile
// din API, gestionarea contului/abonamentului, plata si mesajele catre suport.
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

// Health-check public (pentru monitorizare uptime): confirma ca procesul si baza raspund.
app.get('/api/health', (req, res) => {
  try {
    const d = db.get();
    res.json({ ok: true, ts: new Date().toISOString(), uptimeSec: Math.round(process.uptime()), firme: (d.firme || []).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'db' });
  }
});

app.post('/api/login', (req, res) => {
  const mins = isLocked(req);
  if (mins) return res.status(429).json({ error: 'Prea multe incercari esuate. Reincearca peste ~' + mins + ' min.' });
  const { username, password, code, remember } = req.body || {};
  const d = db.get();
  const u = d.users.find((x) => x.username === username);
  if (!u || u.pending || !authlib.verifyPassword(password, u.salt, u.hash)) { bumpFail(req); return res.status(401).json({ error: 'Utilizator sau parola gresita.' }); }
  let rememberDevice = false;
  if (u.twofa && !deviceTrusted(req, u)) {
    if (!code) return res.json({ twofa: true }); // parola corecta, mai trebuie codul
    if (!totp.verify(u.totpSecret, code)) { bumpFail(req); return res.status(401).json({ error: 'Cod 2FA gresit.', twofa: true }); }
    rememberDevice = !!remember;
  }
  clearFails(req);
  startSession(req, res, u); // creeaza sesiune + cookie sid
  if (rememberDevice) setTrustedDevice(req, res, u); // append (tfd) DUPA setSession
  logAudit('login', 'autentificare', { userId: u.id, username: u.username, firmaId: u.firmaActiva || null });
  db.save();
  req.user = u; // pentru withSessionState (starea abonamentului firmei active)
  res.json({ ok: true, user: withSessionState(req, u) });
});

// Intrare in contul demo cu un click (public) — doar contul „demo", fara parola in client.
app.post('/api/demo-login', (req, res) => {
  const d = db.get();
  const u = d.users.find((x) => x.username === 'demo');
  if (!u) return res.status(404).json({ error: 'Contul demo nu este disponibil momentan.' });
  startSession(req, res, u);
  logAudit('login', 'cont demo (public)', { userId: u.id, username: u.username, firmaId: u.firmaActiva || null });
  db.save();
  res.json({ ok: true, user: publicUser(u) });
});

// ───────────────────────── INSCRIERE FIRMA (public) ─────────────────────────
// Creeaza o firma NOUA GOALA (fara date contabile) + un utilizator care o administreaza.
// Planul de conturi (si restul datelor globale) e partajat de toate firmele, deci e disponibil automat.
const registerAttempts = new Map();
function regCount(req) { const r = registerAttempts.get(attemptKey(req)); return (r && Date.now() <= r.reset) ? r.count : 0; }
function regBump(req) {
  const k = attemptKey(req); const now = Date.now();
  let r = registerAttempts.get(k);
  if (!r || now > r.reset) r = { count: 0, reset: now + 3600 * 1000 };
  r.count += 1; registerAttempts.set(k, r);
}
app.get('/api/register', (req, res) => res.json({ enabled: db.get().settings.selfRegister !== false }));
app.post('/api/register', (req, res) => {
  const d = db.get();
  if (d.settings.selfRegister === false) return res.status(403).json({ error: 'Inscrierea de firme noi este momentan dezactivata.' });
  if (regCount(req) >= 5) return res.status(429).json({ error: 'Prea multe inscrieri de pe aceasta retea. Reincearca peste o ora.' });
  const b = req.body || {};
  const nume = String(b.nume || '').trim();
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!nume) return res.status(400).json({ error: 'Completeaza denumirea firmei.' });
  if (username.length < 3) return res.status(400).json({ error: 'Utilizator prea scurt (minim 3 caractere).' });
  const pwErr = authlib.validatePassword(password, { username });
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (d.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return res.status(400).json({ error: 'Acest utilizator exista deja. Alege altul.' });
  // firma noua GOALA — fara date contabile (entries/parteneri/solduri/stocuri etc.)
  const fid = db.nextFirmaId();
  const firma = Object.assign(db.defaultFirma(fid), {
    nume, cui: String(b.cui || '').trim(), regCom: String(b.regCom || '').trim(),
    adresa: String(b.adresa || '').trim(), oras: String(b.oras || '').trim(), judet: b.judet || 'RO-B',
    tvaPlatitor: b.tvaPlatitor != null ? !!b.tvaPlatitor : true,
    tipEntitate: b.tipEntitate === 'pfa' ? 'pfa' : 'srl',
  }, { id: fid });
  // Billing per-firma: prima firma primeste o proba de 30 de zile.
  firma.subscription = plans.firmaTrialSub();
  d.firme.push(firma);
  d.partners[fid] = {}; d.openingBalances[fid] = {};
  const { salt, hash } = authlib.hashPassword(password);
  const user = { id: db.nextUserId(), username, email: String(b.email || '').trim(), salt, hash, role: 'user', firme: [fid], firmaActiva: fid };
  d.users.push(user);
  // Daca a platit ca „guest" inainte de inscriere, leaga abonamentul dupa email (Stripe) — firma devine activa.
  const pIdx = plans.findPending(d.settings.pendingSubs, user.email);
  if (pIdx >= 0) {
    const rec = d.settings.pendingSubs[pIdx];
    user.subscription = plans.pendingToSubscription(rec);
    firma.subscription = { status: 'active', plan: rec.plan, since: new Date().toISOString(), stripeCustomerId: rec.customerId || null, stripeSubscriptionId: rec.subscriptionId || null };
    d.settings.pendingSubs.splice(pIdx, 1);
    logAudit('subscription.linked', 'abonament ' + rec.plan + ' legat la inscriere', { userId: user.id, username, firmaId: fid });
  }
  regBump(req);
  logAudit('firma.register', nume + ' (utilizator ' + username + ')', { userId: user.id, username, firmaId: fid });
  db.save();
  startSession(req, res, user); // autentificare automata dupa inscriere
  res.json({ ok: true, firma: { id: fid, nume: firma.nume }, user: publicUser(user) });
  // email de bun venit (best-effort, nu blocheaza raspunsul)
  if (user.email) {
    sendNotifMail(user.email, 'Bun venit în Contabo!',
      'Salut,\n\nContul tău („' + username + '") și firma „' + firma.nume + '" sunt gata.\n\n'
      + 'Primii pași:\n'
      + '  1. Încarcă prima factură primită (PDF sau poză) — articolul contabil se generează singur.\n'
      + '  2. Emite o factură către un client — primești automat e-Factura XML + PDF.\n'
      + '  3. La final de lună, descarcă declarațiile din „Declarații ANAF".\n\n'
      + 'Ghidul pas cu pas e în aplicație (tab-ul Ghid), iar la orice întrebare ne scrii direct din Mesaje.\n\n'
      + 'Intră în aplicație: ' + billing.appUrl() + '\n\nSpor la treabă!\nEchipa Contabo'
    ).catch((e) => console.error('email bun venit:', e.message));
  }
});

// Setari de cont si securitate (2FA, sesiuni, parola, profil): src/routes/account.js
require('./src/routes/account')(app, { demoContLock, logAudit });

// Backup/restaurare + SMTP (admin): src/routes/backup.js — intoarce doBackup (folosit si de jobul zilnic).
const { doBackup } = require('./src/routes/backup')(app, { requireAdmin, upload, logAudit });
app.post('/api/logout', (req, res) => {
  const u = currentUser(req);
  if (u && req._sessId) { u.sessions = (u.sessions || []).filter((s) => s.id !== req._sessId); db.save(); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});


app.get('/api/audit', (req, res) => {
  const d = db.get();
  const fid = activeId(req); // doar firma curenta (activeId e mereu o firma la care userul are acces)
  const list = (d.audit || []).filter((a) => a.firmaId === fid);
  res.json(list.slice(-300).reverse());
});
// Jurnal de sistem (global): actiuni fara firma — utilizatori, firme, impersonare, mesaje, backup, 2FA, sesiuni.
app.get('/api/audit/system', requireAdmin, (req, res) => {
  const list = (db.get().audit || []).filter((a) => a.firmaId == null);
  res.json(list.slice(-300).reverse());
});
app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Neautentificat' });
  res.json(withSessionState(req, u));
});
// Imbogateste obiectul public al utilizatorului cu starea de impersonare si mesajele necitite.
function withSessionState(req, u) {
  const out = publicUser(u);
  if (req.impersonating && req.realUser) out.impersonating = { adminId: req.realUser.id, adminName: req.realUser.username };
  const d = db.get();
  out.unreadMessages = (u.role === 'admin' && !req.impersonating)
    ? messages.unreadForAdmin(d.messages || [])
    : messages.unreadForUser(d.messages || [], u.id);
  // Billing per-firma: starea abonamentului FIRMEI active + semnalul de read-only pentru banner.
  if (u.role !== 'admin') {
    const f = db.getFirma(activeId(req));
    out.firmaSub = plans.firmaStatus(f);
    out.subExpirat = plans.firmaLocked(f);
  }
  return out;
}

// ───────────────────────── IMPERSONARE (admin intra pe cont de user) ─────────────────────────
// Adminul real (chiar daca impersoneaza deja pe cineva) e principalul care detine sesiunea.
function adminPrincipal(req) {
  if (req.realUser && req.realUser.role === 'admin') return req.realUser;
  return req.user && req.user.role === 'admin' ? req.user : null;
}
app.post('/api/impersonate', (req, res) => {
  const admin = adminPrincipal(req);
  if (!admin) return res.status(403).json({ error: 'Doar administratorul poate intra pe conturi.' });
  const d = db.get();
  const target = d.users.find((x) => x.id === Number((req.body || {}).userId));
  if (!target) return res.status(404).json({ error: 'Utilizator inexistent.' });
  if (target.id === admin.id) return res.status(400).json({ error: 'Esti deja autentificat ca tine.' });
  if (target.role === 'admin') return res.status(400).json({ error: 'Nu poti intra pe contul altui administrator.' });
  if (target.pending) return res.status(400).json({ error: 'Contul nu e finalizat (invitatie in asteptare).' });
  const sess = (admin.sessions || []).find((s) => s.id === req._sessId);
  if (!sess) return res.status(400).json({ error: 'Sesiune invalida.' });
  sess.impersonating = target.id;
  logAudit('impersonate.start', admin.username + ' a intrat pe contul ' + target.username, { userId: admin.id, username: admin.username, firmaId: null });
  db.save();
  res.json({ ok: true, user: publicUser(target) });
});
app.post('/api/impersonate/stop', (req, res) => {
  if (!req.impersonating || !req.realUser) return res.status(400).json({ error: 'Nu esti in modul impersonare.' });
  const admin = req.realUser;
  const sess = (admin.sessions || []).find((s) => s.id === req._sessId);
  if (sess) delete sess.impersonating;
  logAudit('impersonate.stop', 'revenire la ' + admin.username, { userId: admin.id, username: admin.username, firmaId: null });
  db.save();
  res.json({ ok: true, user: publicUser(admin) });
});

// Mesaje (suport user <-> admin): src/routes/messages.js
require('./src/routes/messages')(app, { requireAdmin, upload, logAudit });


// ── Abonamente (planuri + trial) ──
// Prețurile sunt publice (vizibile pe pagina de înscriere, fără autentificare).
// Abonament / plati Stripe (planuri, checkout, portal, webhook, proba/select, activare admin): src/routes/billing.js
require('./src/routes/billing')(app, { requireAdmin, logAudit });

// ───────────────────────── RESETARE PAROLA (email) ─────────────────────────
app.post('/api/forgot-password', wrap(async (req, res) => {
  const login = String((req.body || {}).login || '').trim().toLowerCase();
  const d = db.get();
  const u = d.users.find((x) => !x.pending && (x.username.toLowerCase() === login || (x.email && x.email.toLowerCase() === login)));
  // raspuns identic indiferent daca exista (sa nu dezvaluim conturile)
  const generic = { ok: true, message: 'Daca exista un cont cu adresa de email setata, vei primi un link de resetare.' };
  if (!u || !u.email || !(d.settings.smtp && d.settings.smtp.host)) return res.json(generic);
  u.resetToken = crypto.randomBytes(24).toString('hex');
  u.resetExp = Date.now() + 3600 * 1000; // 1 ora
  db.save();
  const link = (req.protocol || 'http') + '://' + req.get('host') + '/?reset=' + u.resetToken;
  try { await sendMail(d.settings.smtp, u.email, 'Resetare parola Contabo', 'Reseteaza-ti parola (valabil 1 ora):\n' + link); } catch (e) { console.error('SMTP reset:', e.message); }
  res.json(generic);
}));
function findReset(token) {
  const u = db.get().users.find((x) => x.resetToken === token);
  if (!u || (u.resetExp && u.resetExp < Date.now())) return null;
  return u;
}
app.get('/api/reset/:token', (req, res) => {
  const u = findReset(req.params.token);
  if (!u) return res.status(404).json({ error: 'Link de resetare invalid sau expirat.' });
  res.json({ username: u.username });
});
app.post('/api/reset/accept', (req, res) => {
  const { token, password } = req.body || {};
  const u = findReset(token);
  if (!u) return res.status(404).json({ error: 'Link de resetare invalid sau expirat.' });
  const pwErr = authlib.validatePassword(password, { username: u.username });
  if (pwErr) return res.status(400).json({ error: pwErr });
  const h = authlib.hashPassword(password);
  u.salt = h.salt; u.hash = h.hash; u.mustChange = false; delete u.resetToken; delete u.resetExp;
  u.sessions = []; // resetarea parolei deconecteaza celelalte sesiuni
  startSession(req, res, u);
  logAudit('password.reset', u.username, { userId: u.id, username: u.username, firmaId: null });
  db.save();
  res.json({ ok: true, user: publicUser(u) });
});

// firma activa (constransa la firmele utilizatorului) + vederea filtrata
// Firma activa pentru cerere. STRICT pentru utilizatorii non-admin (necontabili/contabili):
// doar firmele proprii (cele inscrise/create de ei sau alocate lor). Un ?firma= din afara listei
// e ignorat; daca nu au nicio firma, se intoarce o santinela care produce o vedere GOALA (nu se
// cade niciodata pe firma globala implicita — altfel s-ar scurge datele altcuiva).
const NO_FIRMA = -1;
function activeId(req) {
  const u = req.user;
  if (u && u.role !== 'admin') {
    const allowed = allowedFirme(u);
    if (!allowed.length) return NO_FIRMA; // niciun acces -> vedere goala
    let id = Number(req.query.firma) || u.firmaActiva || allowed[0];
    if (!allowed.includes(id)) id = allowed[0]; // firma straina in query/firmaActiva -> constrans la a lui
    return id;
  }
  // admin (sau contexte interne fara user): acces la toate firmele
  const allowed = u ? allowedFirme(u) : db.get().firme.map((f) => f.id);
  let id = Number(req.query.firma) || (u && u.firmaActiva) || allowed[0];
  if (!allowed.includes(id)) id = allowed[0];
  return id || db.firmaActiva();
}
const S = (req) => {
  const v = db.scoped(activeId(req));
  // Datele personale ale utilizatorului (necontabil/contabil) ajung in subsolul PDF-urilor
  // („Intocmit: ..."). Copie a firmei per cerere — obiectul din DB nu se atinge.
  const p = (req.user && req.user.profil) || {};
  if (p.numeComplet) {
    v.company = Object.assign({}, v.company, {
      _intocmit: p.numeComplet + (p.autorizatie ? ' (aut. CECCAR ' + p.autorizatie + ')' : ''),
    });
  }
  return v;
};

// ───────────────────────────── META ─────────────────────────────
// Import plan de conturi personalizat din CSV: Cont;Denumire;Clasa;Tip (A/P/B/C/V) - header optional
app.get('/api/meta', (req, res) => {
  const d = db.get();
  const v = S(req);
  const periods = [...new Set(v.entries.map((e) => e.period || periodOf(e.data)))].filter(Boolean).sort();
  const allowed = allowedFirme(req.user);
  res.json({
    user: withSessionState(req, req.user),
    firme: d.firme.filter((f) => allowed.includes(f.id)).map((f) => Object.assign({}, f, { _sub: plans.firmaStatus(f) })),
    firmaActiva: activeId(req),
    company: v.company,
    // tipurile de documente marcate cu `entitate` apar doar la forma juridica potrivita (srl/pfa)
    types: typesForClient().filter((t) => !t.entitate || t.entitate === (v.company.tipEntitate || 'srl')),
    accounts: coa.ACCOUNTS,
    classNames: coa.CLASS_NAMES,
    periods,
    counts: { documents: v.documents.length, entries: v.entries.length },
    ai: { available: ai.aiAvailable(), enabled: d.settings.useAI !== false, model: ai.MODEL },
    fiscal: fiscal.FISCAL,
    selfRegister: d.settings.selfRegister !== false,
  });
});

// ───────────────────────────── FIRME ─────────────────────────────
function canAccess(req, id) { return allowedFirme(req.user).includes(Number(id)); }

// Demo e un cont public PARTAJAT intre vizitatori: datele de cont (parola, 2FA, email/profil)
// si setarile globale (conexiunea SPV) nu se modifica din el.
function demoContLock(req, res) {
  if (req.user && req.user.username === 'demo') {
    res.status(403).json({ error: 'Contul demo este public și partajat — setările contului nu se pot modifica. Înscrie-ți un cont propriu.' });
    return true;
  }
  return false;
}
// Firme: listare/creare/editare/activare/stergere, abonare, export/import JSON+ZIP: src/routes/firme.js
require('./src/routes/firme')(app, { activeId, allowedFirme, canAccess, requireAdmin, wrap, logAudit });

// Utilizatori (admin) + invitatii (link setare parola, email optional): src/routes/users.js
require('./src/routes/users')(app, { requireAdmin, logAudit, startSession, publicUser });

// Configurare (companie, logo, chitanta, setari, cote fiscale): src/routes/config.js
require('./src/routes/config')(app, { S, activeId, logAudit, requireAdmin, upload, ensureDocSeries });

// Nomenclatoare (parteneri, import CSV, conversie XLSX/XLS/DBF) + solduri initiale: src/routes/partners.js
require('./src/routes/partners')(app, { upload, S, activeId, logAudit });

// Documente primare: upload (extragere AI/reguli locale), servire fisier, galerii primite/emise: src/routes/documents.js
require('./src/routes/documents')(app, { upload, wrap, S, activeId, allowedFirme, logAudit });

// ───────────────────────────── ENTRIES ─────────────────────────────
/**
 * Actualizeaza nomenclatorul de parteneri din datele unui articol DEJA validat si adaugat.
 * Apelat de rute DUPA push (nu din buildEntry) ca o inregistrare esuata sa nu lase partenerul orfan.
 */
function upsertPartner(firmaId, entry) {
  if (!entry || !entry.partenerCui) return;
  const key = String(entry.partenerCui).replace(/^ro/i, '').replace(/\s/g, '');
  if (!key) return;
  const dd = db.get();
  dd.partners[firmaId] = dd.partners[firmaId] || {};
  const ex = dd.partners[firmaId][key] || { cui: key, den: '', adresa: '', oras: '', judet: '', tara: 'RO', tip: '' };
  if (entry.partener) ex.den = entry.partener;
  ex.cui = key;
  // marcheaza automat rolul dupa tipul documentului (vanzare -> client, cumparare -> furnizor)
  const role = /vanzare|^livrare_intra|^bon_fiscal/.test(entry.tip) ? 'client' : (/cumparare/.test(entry.tip) ? 'furnizor' : '');
  if (role) { if (!ex.tip) ex.tip = role; else if (ex.tip !== role && ex.tip !== 'ambele') ex.tip = 'ambele'; }
  dd.partners[firmaId][key] = ex;
}

function buildEntry(tipId, fields, fileId, firmaId) {
  firmaId = firmaId || db.firmaActiva();
  const type = getType(tipId);
  if (!type) throw new Error('Tip de document necunoscut: ' + tipId);
  const f = Object.assign({}, fields);
  // coercitie numerica pentru campurile numerice
  for (const fld of type.fields) {
    if (fld.type === 'number') f[fld.name] = round2(parseFloat(f[fld.name]) || 0);
  }
  // linii detaliate (optional): daca exista, baza si TVA se calculeaza din ele
  let items = [];
  if (f.items) {
    try { items = typeof f.items === 'string' ? JSON.parse(f.items) : f.items; } catch (_) { items = []; }
    items = (Array.isArray(items) ? items : []).map((it) => ({
      nume: String(it.nume || '').trim(),
      cantitate: round2(parseFloat(it.cantitate) || 0),
      um: String(it.um || 'buc').trim(),
      pret: round2(parseFloat(it.pret) || 0),
      cota: Number(it.cota) || 0,
    })).filter((it) => it.nume && it.cantitate > 0);
    if (items.length) {
      let baza = 0; let tva = 0;
      for (const it of items) { const b = round2(it.cantitate * it.pret); baza = round2(baza + b); tva = round2(tva + (b * it.cota) / 100); }
      f.baza = baza; f.tva = round2(tva);
    }
  }
  const lines = type.build(f).filter((l) => l.suma !== 0); // storno foloseste sume negative (in rosu)
  if (!lines.length) throw new Error('Completeaza cel putin o suma (baza, TVA sau total) inainte de salvare.');
  // Deductibilitate partiala auto 50% (art. 298 Cod fiscal): jumatate din TVA devine NEDEDUCTIBILA
  // si se include in cost (vehicule fara utilizare exclusiv pentru afacere).
  if (f.auto50) {
    const vatL = lines.find((l) => l.debit === '4426');
    if (vatL && vatL.suma > 0) {
      const costL = lines.find((l) => l !== vatL && l.credit === vatL.credit); // linia de cost catre acelasi furnizor
      const ded = round2(vatL.suma / 2);
      const nedeq = round2(vatL.suma - ded);
      vatL.suma = ded;
      vatL.explicatie = (vatL.explicatie || 'TVA') + ' deductibila 50% (auto)';
      if (costL) { costL.suma = round2(costL.suma + nedeq); costL.explicatie = (costL.explicatie || '') + ' (+50% TVA nedeductibil auto)'; }
    }
  }
  const firma = db.getFirma(firmaId) || {};
  // Pro-rata (art. 300 Cod fiscal): la achizitiile cu destinatie mixta ale platitorilor cu regim
  // mixt, TVA e deductibila doar in procentul pro-rata provizoriu al firmei; restul intra in cost.
  // Se aplica DUPA auto50 (compunere corecta) si INAINTE de TVA la incasare (care redenumeste 4426).
  const prTva = Number(firma.proRataTva);
  if (f.proRataMixt && Number.isFinite(prTva) && prTva > 0 && prTva < 100) {
    const vatL = lines.find((l) => l.debit === '4426');
    if (vatL && vatL.suma > 0) {
      const costL = lines.find((l) => l !== vatL && l.credit === vatL.credit);
      const ded = round2((vatL.suma * prTva) / 100);
      const neded = round2(vatL.suma - ded);
      vatL.suma = ded;
      vatL.explicatie = (vatL.explicatie || 'TVA') + ' deductibila pro-rata ' + prTva + '%';
      if (costL) { costL.suma = round2(costL.suma + neded); costL.explicatie = (costL.explicatie || '') + ' (+TVA nedeductibila pro-rata)'; }
    }
  }
  // Regim „TVA la incasare": pe facturi, TVA devine NEEXIGIBILA (4428) pana la incasare/plata.
  if (firma.tvaLaIncasare && /^factura_(vanzare|cumparare|utilitati|servicii|combustibil|imobilizare)/.test(tipId)) {
    for (const l of lines) {
      if (l.credit === '4427') { l.credit = '4428'; l.explicatie = (l.explicatie || 'TVA') + ' (neexigibila - la incasare)'; }
      if (l.debit === '4426') { l.debit = '4428'; l.explicatie = (l.explicatie || 'TVA') + ' (neexigibila - la plata)'; }
    }
  }
  for (const l of lines) {
    if (!coa.getAccount(l.debit)) throw new Error('Cont debitor inexistent in plan: ' + l.debit);
    if (!coa.getAccount(l.credit)) throw new Error('Cont creditor inexistent in plan: ' + l.credit);
  }
  const data = f.data || new Date().toISOString().slice(0, 10);
  // Blocarea perioadei: nu se inregistreaza in luni inchise (protejeaza fata de declaratiile depuse).
  if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) {
    throw new Error('Perioada ' + periodOf(data) + ' este inchisa (blocata pana la ' + firma.lockedUntil + '). Un administrator o poate debloca din Setari → Blocare perioada.');
  }
  // nomenclatorul de parteneri se actualizeaza din ruta (upsertPartner), DUPA ce articolul e validat si adaugat
  return {
    id: db.nextId('e'),
    firmaId,
    data,
    period: periodOf(data),
    tip: tipId,
    tipNume: type.nume,
    partener: f.partener || '',
    partenerCui: f.cuiPartener || '',
    document: f.document || '',
    refFactura: f.refFactura || '',
    analitic: f.analitic || '',
    explicatie: f.explicatie || '',
    items,
    ...((f.codNC || (f.masaNeta && Number(f.masaNeta) > 0) || f.conditieLivrare) ? {
      intrastat: { codNC: String(f.codNC || '').trim(), masaNeta: round2(parseFloat(f.masaNeta) || 0), natura: String(f.naturaTranz || '11').trim(), conditie: String(f.conditieLivrare || '').trim() },
    } : {}),
    ...((f.moneda && Number(f.sumaValuta) > 0 && Number(f.curs) > 0) ? {
      valutaInfo: { valuta: String(f.moneda).toUpperCase().trim(), sumaValuta: round2(parseFloat(f.sumaValuta) || 0), curs: round2(parseFloat(f.curs) || 0) },
    } : {}),
    ...(f.proRataMixt ? { proRataMixt: true } : {}), // marcaj pentru regularizarea anuala a pro-ratei
    fileId: fileId || null,
    system: false,
    lines,
  };
}

// Articole contabile + recurente + blocare perioada + TVA la incasare: src/routes/entries.js
require('./src/routes/entries')(app, { S, activeId, canAccess, requireAdmin, logAudit, buildEntry, upsertPartner });
// Productie + retete (BOM): src/routes/production.js
require('./src/routes/production')(app, { S, activeId, logAudit });

// Inchideri fiscale (TVA, an, impozit pe profit, repartizare rezultat): src/routes/closings.js
require('./src/routes/closings')(app, { S, activeId, logAudit });

// ───────────────────────────── MIJLOACE FIXE ─────────────────────────────
// Mijloace fixe (registru + amortizare): src/routes/assets.js
require('./src/routes/assets')(app, { S, activeId, logAudit });

// ───────────────────────────── SALARIZARE ─────────────────────────────
// Salarizare (angajati, stat de plata, registru, PDF-uri): src/routes/payroll.js
require('./src/routes/payroll')(app, { S, activeId, logAudit, buildEntry });

// ───────────────────────────── STOCURI ─────────────────────────────
// Stocuri (produse, gestiuni, miscari, inventar, stoc curent): src/routes/stocks.js
require('./src/routes/stocks')(app, { S, activeId, logAudit });

// ───────────────────────────── EXPORT CSV ─────────────────────────────
// Export CSV (sendCsv + toate csv/*): src/routes/csv.js
require('./src/routes/csv')(app, { S });

// Registre, jurnale si rapoarte financiare (JSON+PDF): src/routes/reports.js (mai jos)
// Tablouri de bord + analize (dashboard, cash-forecast, aging, analitic, reconciliere, compensare): src/routes/dashboard.js
require('./src/routes/dashboard')(app, { S, activeId, logAudit });
// Evaluari si ajustari (buget, reevaluare valutara, provizion creante, scoatere din evidenta): src/routes/adjustments.js
require('./src/routes/adjustments')(app, { S, activeId, logAudit });

// Import extras bancar (CSV/MT940) + lista e-Factura eligibila: src/routes/bank.js
require('./src/routes/bank')(app, { upload, S, activeId, buildEntry, upsertPartner });

// ───────────────────────────── ANAF SPV ─────────────────────────────
// ── Import e-Factura primita (UBL) ──
require('./src/routes/anaf')(app, { activeId, wrap, logAudit, upsertPartner, canAccess, demoContLock });


// Generarea XML declaratii (e-Factura, D300/D394/D390/D205/D112, SAF-T) + validare: src/routes/declarationsXml.js
require('./src/routes/declarationsXml')(app, { S, activeId, canAccess });

// ───────────────── REGISTRUL DEPUNERILOR + PORTOFOLIU + NOTIFICARI ─────────────────
// Registrul depunerilor, portofoliul si notificarile: src/routes/declarations.js
require('./src/routes/declarations')(app, { db, S, activeId, allowedFirme, logAudit });

// Digestul cu termene + trimiterea de emailuri: src/notify.js
app.post('/api/notifications/digest', requireAdmin, wrap(async (req, res) => {
  const r = await sendDeadlineDigests();
  logAudit('notificari.digest', 'trimis manual: ' + r.sent.length + ' emailuri', { req, firmaId: null });
  res.json(r);
}));
// Validare pre-depunere + api/saft: src/routes/declarationsXml.js

// Situatii financiare + recapitulatii declaratii + registre (PDF/JSON): src/routes/reports.js
require('./src/routes/reports')(app, { S });
// numerotare secventiala a documentelor de stoc (serie + numar), per firma si tip
// Documente de gestiune (situatii stoc, serii NIR/BC/AVIZ, NIR/bon/aviz, fisa magazie, nota PDF): src/routes/stockdocs.js
// Seriile de documente stau in service layer (src/stocksService.js); config.js le primeste prin ctx (chitanta CH).
require('./src/routes/stockdocs')(app, { S, activeId, canAccess });

// Utilitare demo (reset/snapshot) + incarcarea exemplului din ghid (admin): src/routes/demo.js
// Intoarce resetDemo, folosit si de jobul zilnic de reset al contului demo (mai jos).
const { resetDemo } = require('./src/routes/demo')(app, { requireAdmin, logAudit });

const os = require('os');
// Ruleaza un job periodic cu plasa de siguranta: o eroare SINCRONA in callback (ex. un db.save()
// care arunca) e prinsa si logata — nu doboara procesul si nu impiedica rulele urmatoare. Erorile
// ASINCRONE raman tratate pe .catch-ul promisiunilor din interior (retea/ANAF/SMTP).
function safeInterval(label, fn, ms) {
  return setInterval(() => {
    try { fn(); }
    catch (e) {
      log.error('eroare in job periodic', { job: label, err: e });
      try { trackServerError({ method: 'JOB', originalUrl: label }, e); } catch (_) { /* ignora */ }
    }
  }, ms);
}

// Backup automat zilnic (daca e activat)
safeInterval('backup', () => {
  const s = db.get().settings.backup || {};
  if (s.auto === false) return;
  const last = s.lastAt ? Date.parse(s.lastAt) : 0;
  if (Date.now() - last >= 24 * 3600 * 1000) {
    try { const r = doBackup(); console.log('Backup automat:', r.name); } catch (e) { console.error('Backup:', e.message); }
  }
}, 3600 * 1000); // verifica din ora in ora

// Digest zilnic cu termenele fiscale: o singura data pe zi, dupa ora 07:00 (ora serverului)
safeInterval('digest-termene', () => {
  const d = db.get();
  const today = new Date().toISOString().slice(0, 10);
  const s = d.settings.deadlineDigest || (d.settings.deadlineDigest = {});
  if (s.lastDate === today || new Date().getHours() < 7) return;
  s.lastDate = today;
  db.save();
  sendDeadlineDigests()
    .then((r) => { if (r.sent.length || r.errors.length) console.log('Digest termene:', r.sent.length, 'trimise', r.errors.length ? ('; erori: ' + r.errors.join(' | ')) : ''); })
    .catch((e) => console.error('Digest termene:', e.message));
}, 15 * 60 * 1000);

// Reset zilnic al contului demo (dupa ora 04:00): junk-ul vizitatorilor dispare peste noapte
safeInterval('demo-reset', () => {
  const d = db.get();
  const today = new Date().toISOString().slice(0, 10);
  const s = d.settings.demoReset || (d.settings.demoReset = {});
  if (s.lastDate === today || new Date().getHours() < 4) return;
  s.lastDate = today;
  try { const r = resetDemo(); if (r.ok) console.log('Demo resetat din snapshot.'); db.save(); }
  catch (e) { console.error('Demo reset:', e.message); }
}, 15 * 60 * 1000);

// Igiena rate-limit: fara curatare, map-urile ar creste nelimitat (cate o intrare per IP esuat)
safeInterval('rate-limit-hygiene', () => {
  const now = Date.now();
  pruneLoginAttempts(now); // loginAttempts traieste in src/session.js (incapsulat)
  for (const [k, r] of registerAttempts) { if (r.reset < now) registerAttempts.delete(k); }
}, 3600 * 1000);

// Job periodic: descarca automat recipisele — SPV per-firma, doar firmele cu autoPoll bifat
safeInterval('spv-poll', () => {
  const vreoFirma = db.get().firme.some((f) => f.anaf && f.anaf.autoPoll && anaf.connected(f.anaf));
  if (vreoFirma) {
    pollSpv({ auto: true }).then((r) => { if (r.downloaded) console.log('Auto-poll SPV: ' + r.downloaded + ' recipise descarcate'); })
      .catch((e) => console.error('Auto-poll SPV:', e.message || e));
  }
}, 15 * 60 * 1000);

// Alerta pe email cand se aduna erori de server: >=5 erori 5xx in 15 minute -> un email pe ora.
const err5xx = [];
let lastErrAlert = 0;
function trackServerError(req, err) {
  const now = Date.now();
  const rid = req.reqId ? '[' + req.reqId + '] ' : '';
  err5xx.push({ t: now, m: rid + req.method + ' ' + req.originalUrl + ': ' + String((err && err.message) || err).slice(0, 160) });
  while (err5xx.length && err5xx[0].t < now - 15 * 60 * 1000) err5xx.shift();
  if (err5xx.length >= 5 && now - lastErrAlert > 3600 * 1000) {
    lastErrAlert = now;
    sendNotifMail(process.env.CONTAB_BACKUP_EMAIL_TO || '', '[Contab] ALERTA: erori de server repetate',
      err5xx.length + ' erori 5xx in ultimele 15 minute:\n\n' + err5xx.map((x) => '  • ' + x.m).join('\n')
      + '\n\nVerifica: pm2 logs contab').catch(() => {});
  }
}

// Handler global de erori — DUPA toate rutele. Raspuns curat (JSON), fara scurgere de stack
// catre client; 4xx isi pastreaza mesajul, 5xx devin generice si se logheaza pe server.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) { log.error('eroare de server', log.ctx(req, { status, err })); trackServerError(req, err); }
  const msg = status < 500 && err && err.message ? err.message : 'A aparut o eroare interna. Incearca din nou.';
  res.status(status).json(status >= 500 ? { error: msg, reqId: req.reqId } : { error: msg });
});

// ── Guard single-instance: DOUA procese pe aceeasi baza = pierdere de date (starea traieste
// in RAM, ultima scriere invinge). Lock-ul e cheiat pe FISIERUL de baza (nu pe director), deci
// serverul de test cu baza temporara nu se ciocneste cu instanta live. Toleranta la restartul
// pm2 (suprapunere scurta a proceselor): retry ~2s inainte de a refuza; lock invechit (proces
// mort) -> preluat automat. Rollback: CONTAB_SKIP_LOCK=1.
const LOCK_FILE = db.DB_FILE + '.lock';
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* fara SAB */ } }
function acquireDbLock() {
  if (process.env.CONTAB_SKIP_LOCK === '1') return;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx'); // O_CREAT|O_EXCL — atomic
      fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      return; // lock obtinut
    } catch (e) {
      if (e.code !== 'EEXIST') { console.error('Nu pot scrie lockfile-ul bazei (' + LOCK_FILE + '): ' + e.message); return; }
      let pid = 0; try { pid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim()) || 0; } catch (_) { /* gol */ }
      if (pid && pid !== process.pid && pidAlive(pid)) {
        if (attempt < 19) { sleepMs(100); continue; } // suprapunere de restart — mai asteapta
        console.error('\n⛔ O alta instanta Contabo (PID ' + pid + ') foloseste deja aceeasi baza (' + db.DB_FILE + ').');
        console.error('   Doua procese pe aceeasi baza corup datele. Opreste cealalta instanta sau ruleaza pe alt CONTAB_DB_FILE.');
        console.error('   (bypass, pe propriul risc: CONTAB_SKIP_LOCK=1)\n');
        process.exit(1);
      }
      try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* preluat de altcineva intre timp */ }
    }
  }
}
function releaseDbLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim()) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) { /* ignora */ }
}
acquireDbLock();
process.on('exit', releaseDbLock);

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0'; // asculta pe toate interfetele (acces din retea)
let server = null; // atribuit dupa hidratarea bazei (dbReady)
dbReady.then(() => {
  server = app.listen(PORT, HOST, () => {
    console.log('Contabo ruleaza (asculta pe ' + HOST + ':' + PORT + ')');
    console.log('  Local:  http://localhost:' + PORT);
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const i of ifaces[name]) {
        if (i.family === 'IPv4' && !i.internal) {
          console.log('  Retea:  http://' + i.address + ':' + PORT);
        }
      }
    }
  });
}).catch((e) => {
  log.error('pornire esuata — baza de date nu s-a putut incarca', { err: e });
  releaseDbLock();
  process.exit(1);
});

// Oprire curata (pm2 restart/stop trimite SIGINT): scrie oglinda JSON in asteptare,
// asteapta coada de scrieri (pg), inchide driverul si opreste ascultarea;
// plasa de siguranta de 3s daca ceva atarna.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { db.flushMirror(); } catch (_) { /* ignora */ }
  Promise.resolve(db.flushStore()).catch(() => { /* ignora */ }).then(() => {
    if (db.DRIVER === 'sqlite') { try { require('./src/store').close(); } catch (_) { /* ignora */ } }
    if (db.DRIVER === 'pg') { try { require('./src/storePg').close(); } catch (_) { /* ignora */ } }
    releaseDbLock();
    if (server) server.close(() => process.exit(0)); else process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Plasa de siguranta: o eroare intr-un timer/callback async (ex. un job periodic) NU trebuie sa
// doboare tot procesul. Logam si continuam — pm2 nu mai e nevoit sa reporneasca, iar cererile in
// zbor nu se pierd. (Erorile din rute sunt deja tratate de wrap()/handlerul Express de mai sus.)
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { err });
  try { trackServerError({ method: 'PROC', originalUrl: 'uncaughtException' }, err); } catch (_) { /* ignora */ }
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { err: reason });
});

module.exports = { app, buildEntry, upsertPartner };
