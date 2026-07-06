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
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ignora */ }
})();

const db = require('./src/db');
const coa = require('./src/chartOfAccounts');
const { typesForClient, getType } = require('./src/documentTypes');
const { extractFromPdf } = require('./src/extractor');
const ai = require('./src/aiExtractor');
const acc = require('./src/accounting');
const stmt = require('./src/statements');
const rep = require('./src/reporting');
const { reconcile, compensablePartners } = require('./src/reconcile');
const { analyticBalance, aging } = require('./src/analytic');
const bank = require('./src/bank');
const fiscal = require('./src/fiscal');
const xml = require('./src/xml');
const saft = require('./src/saft');
const assets = require('./src/assets');
const stocks = require('./src/stocks');
const { statePlata } = require('./src/payroll'); // registruSalarii + rutele de salarizare: src/routes/payroll.js
const { leasingSchedule } = require('./src/leasing');
const { toCsv, parseCsv } = require('./src/csv');
const xlsx = require('./src/xlsx');
const xls = require('./src/xls');
const dbf = require('./src/dbf');
const anaf = require('./src/anaf');
const authlib = require('./src/auth');
const totp = require('./src/totp');
const backup = require('./src/backup');
const AdmZip = require('adm-zip');
const pdf = require('./src/pdf');
const { seed } = require('./src/seed');
const messages = require('./src/messages');
const presence = require('./src/presence');
const recurring = require('./src/recurring');
const validate = require('./src/validate');
const decl = require('./src/declarations');
const { sendMail, sendNotifMail, sendDeadlineDigests } = require('./src/notify');
const { pollSpv } = require('./src/anafService'); // auto-poll job; restul e in src/routes/anaf.js
const efacturaImport = require('./src/efacturaImport');
const fxreval = require('./src/fxreval');
const plans = require('./src/plans');
const billing = require('./src/billing');
const QRCode = require('qrcode-svg');
const { round2, period: periodOf } = require('./src/util');

db.load();
coa.addAccounts(db.get().customAccounts); // inregistreaza conturile personalizate importate
fiscal.applyConfig(db.get().settings.fiscal); // aplica cotele fiscale configurate (peste valorile implicite)

const app = express();
app.set('trust proxy', true); // citeste X-Forwarded-Proto de la reverse proxy (pentru cookie Secure pe HTTPS)

// Anteturi de securitate (fara dependinte). CSP calibrat pentru aceasta aplicatie:
//  - script-src 'self' (un singur /app.js, fara scripturi/handler-e inline)
//  - style-src 'unsafe-inline' (atribute style= folosite pe larg in HTML)
//  - img-src data:/blob: (favicon data-URI, canvas), connect-src include puntea de scanare locala
//  - frame-src 'self' (vizualizatorul PDF/e-Factura ruleaza intr-un <iframe> same-origin)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' http://127.0.0.1:8765 http://localhost:8765",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // 180 zile, doc HTTPS (fara subDomains, ca sa nu afecteze alte servicii)
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
  console.error(e);
  try { trackServerError(req, e); } catch (_) { /* inainte de definirea trackerului: ignora */ }
  res.status(500).json({ error: String(e.message || e) });
});

// ───────────────────────── AUTENTIFICARE ─────────────────────────
function currentUser(req) {
  const d = db.get();
  const token = authlib.parseCookies(req.headers.cookie).sid;
  const p = authlib.verify(token, d.settings.authSecret);
  if (!p) return null;
  const u = d.users.find((x) => x.id === p.uid);
  if (!u) return null;
  // sesiuni server-side: tokenul trebuie sa corespunda unei sesiuni active
  let sess = null;
  if (p.sessId) {
    sess = (u.sessions || []).find((x) => x.id === p.sessId);
    if (!sess) return null; // sesiune revocata -> delogat
    req._sessId = p.sessId;
    if (Date.now() - Date.parse(sess.lastSeen || 0) > 5 * 60 * 1000) { sess.lastSeen = new Date().toISOString(); pruneSessions(u); db.save(); }
  }
  req.realUser = u;
  req.impersonating = false;
  // Impersonare: doar un admin, prin marcaj pe propria sesiune, devine efectiv utilizatorul-tinta.
  // Toate rutele opereaza apoi ca acel utilizator; rutele requireAdmin raman blocate (sandbox).
  if (sess && sess.impersonating != null && u.role === 'admin') {
    const target = d.users.find((x) => x.id === sess.impersonating);
    if (target && target.role !== 'admin') { req.impersonating = true; return target; }
    delete sess.impersonating; // tinta a disparut/nevalida -> curata
  }
  return u;
}
function allowedFirme(u) {
  const d = db.get();
  return u.role === 'admin' ? d.firme.map((f) => f.id) : (u.firme || []);
}
function publicUser(u) {
  const p = u.profil || {};
  return {
    id: u.id, username: u.username, role: u.role, tip: plans.userKind(u), firme: allowedFirme(u),
    drepturi: u.drepturi || {},
    mustChange: !!u.mustChange, twofa: !!u.twofa,
    profilComplet: !!(p.numeComplet && p.telefon), // datele personale minime sunt completate?
    subExpirat: plans.expiredLock(u), // proba expirata -> cont read-only (banner in UI)
  };
}

// Igiena sesiunilor: elimina sesiunile vechi (peste TTL) si plafoneaza nr. de dispozitive active.
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 zile (cat traieste cookie-ul/tokenul)
const MAX_SESSIONS = 10;                   // dispozitive active maxime per utilizator
function pruneSessions(u) {
  if (!u || !u.sessions) return false;
  const before = u.sessions.length;
  const now = Date.now();
  u.sessions = u.sessions.filter((s) => now - Date.parse(s.lastSeen || s.createdAt || 0) < SESSION_TTL);
  if (u.sessions.length > MAX_SESSIONS) u.sessions = u.sessions.slice(-MAX_SESSIONS);
  return u.sessions.length !== before;
}
function cookieFlags(req) { return `HttpOnly; Path=/; SameSite=Lax;${req.secure ? ' Secure;' : ''}`; }
function setSession(req, res, uid, sessId) {
  const d = db.get();
  const token = authlib.sign({ uid, sessId, exp: Date.now() + 7 * 24 * 3600 * 1000 }, d.settings.authSecret);
  res.setHeader('Set-Cookie', `sid=${token}; Max-Age=${7 * 24 * 3600}; ${cookieFlags(req)}`);
}
// creeaza o sesiune noua (inregistrata pe utilizator) si seteaza cookie-ul
function startSession(req, res, u) {
  const sessId = crypto.randomBytes(12).toString('hex');
  u.sessions = u.sessions || [];
  u.sessions.push({
    id: sessId, ua: String(req.headers['user-agent'] || '').slice(0, 200),
    ip: attemptKey(req), createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(),
  });
  pruneSessions(u); // curata sesiunile vechi + plafoneaza la MAX_SESSIONS
  setSession(req, res, u.id, sessId);
}
function setTrustedDevice(req, res, u) {
  const d = db.get();
  const token = authlib.sign({ uid: u.id, ep: u.tfdEpoch || 0, kind: 'tfd', exp: Date.now() + 30 * 24 * 3600 * 1000 }, d.settings.authSecret);
  res.append('Set-Cookie', `tfd=${token}; Max-Age=${30 * 24 * 3600}; ${cookieFlags(req)}`);
}
function deviceTrusted(req, u) {
  const tok = authlib.parseCookies(req.headers.cookie).tfd;
  const p = authlib.verify(tok, db.get().settings.authSecret);
  return !!(p && p.kind === 'tfd' && p.uid === u.id && (p.ep || 0) === (u.tfdEpoch || 0));
}

// anti-brute-force: blocheaza dupa prea multe esecuri (per IP), pe o fereastra de timp
const loginAttempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;
function attemptKey(req) { return String(req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown'); }
function isLocked(req) {
  const r = loginAttempts.get(attemptKey(req));
  return r && r.count >= MAX_ATTEMPTS && r.until > Date.now() ? Math.ceil((r.until - Date.now()) / 60000) : 0;
}
function bumpFail(req) {
  const k = attemptKey(req);
  const r = loginAttempts.get(k) || { count: 0, until: 0 };
  r.count += 1; r.until = Date.now() + LOCK_MS;
  loginAttempts.set(k, r);
}
function clearFails(req) { loginAttempts.delete(attemptKey(req)); }

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
const FIRMA_BILL_EXEMPT = /^\/api\/(logout|me|meta|plans|profile|change-password|sessions|2fa|messages|subscription|checkout|stripe)|^\/api\/firme(\/\d+\/(keep|activate|subscribe))?$|^\/api\/firme\/\d+$/;
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
  if (password.length < 4) return res.status(400).json({ error: 'Parola prea scurta (minim 4 caractere).' });
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

// ───────────────────────────── 2FA (TOTP) ─────────────────────────────
app.post('/api/2fa/setup', (req, res) => {
  const u = req.user;
  if (u.twofa) return res.status(400).json({ error: '2FA este deja activat.' });
  u.pending2fa = totp.generateSecret();
  db.save();
  const otpauth = totp.otpauthURL(u.username, u.pending2fa, 'Contabo');
  let qrSvg = '';
  try { qrSvg = new QRCode({ content: otpauth, padding: 2, width: 180, height: 180, color: '#1a1f36', background: '#ffffff', ecl: 'M', join: true }).svg(); } catch (e) { /* QR optional */ }
  res.json({ secret: u.pending2fa, otpauth, qrSvg });
});
app.post('/api/2fa/enable', (req, res) => {
  const u = req.user;
  if (!u.pending2fa) return res.status(400).json({ error: 'Initiaza intai configurarea 2FA.' });
  if (!totp.verify(u.pending2fa, (req.body || {}).code)) return res.status(400).json({ error: 'Cod gresit. Verifica ora dispozitivului.' });
  u.totpSecret = u.pending2fa; u.twofa = true; delete u.pending2fa;
  u.tfdEpoch = (u.tfdEpoch || 0) + 1; // invalideaza eventualele dispozitive de incredere vechi
  logAudit('2fa.enable', u.username, { req, firmaId: null });
  db.save();
  res.json({ ok: true });
});
app.post('/api/2fa/disable', (req, res) => {
  const u = req.user;
  if (!u.twofa) return res.status(400).json({ error: '2FA nu este activat.' });
  if (!totp.verify(u.totpSecret, (req.body || {}).code)) return res.status(400).json({ error: 'Cod gresit.' });
  u.twofa = false; delete u.totpSecret; delete u.pending2fa;
  u.tfdEpoch = (u.tfdEpoch || 0) + 1;
  logAudit('2fa.disable', u.username, { req, firmaId: null });
  db.save();
  res.json({ ok: true });
});
app.post('/api/2fa/revoke-devices', (req, res) => {
  const u = req.user;
  u.tfdEpoch = (u.tfdEpoch || 0) + 1; // toate dispozitivele de incredere devin invalide
  logAudit('2fa.revoke_devices', u.username, { req, firmaId: null });
  db.save();
  res.json({ ok: true });
});

// ───────────────────────────── BACKUP (admin) ─────────────────────────────
function doBackup() {
  const d = db.get();
  db.flushMirror(); // oglinda JSON e scrisa cu intarziere — adu-o la zi inainte de copiere
  const r = backup.backupNow(db.DB_FILE, db.DATA_DIR, 30);
  d.settings.backup = d.settings.backup || {};
  d.settings.backup.lastAt = new Date().toISOString();
  db.save();
  return r;
}
app.post('/api/backup', requireAdmin, (req, res) => {
  const r = doBackup();
  logAudit('backup.create', r.name, { req, firmaId: null });
  res.json({ ok: true, file: r.name, count: r.count });
});
app.get('/api/backups', requireAdmin, (req, res) => {
  const s = db.get().settings.backup || {};
  res.json({ auto: s.auto !== false, lastAt: s.lastAt || null, list: backup.listBackups(db.DATA_DIR) });
});
app.post('/api/backups/auto', requireAdmin, (req, res) => {
  const d = db.get();
  d.settings.backup = d.settings.backup || {};
  d.settings.backup.auto = !!(req.body || {}).auto;
  db.save();
  res.json({ ok: true, auto: d.settings.backup.auto });
});
app.get('/api/backup/file/:name', requireAdmin, (req, res) => {
  const p = backup.backupPath(db.DATA_DIR, req.params.name);
  if (!p) return res.status(404).send('Backup inexistent');
  res.download(p);
});
// Restaurare: incarca un fisier db.json -> face backup curentului -> inlocuieste -> reincarca
app.post('/api/restore', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(req.file.path, 'utf8')); } catch (e) { return res.status(400).json({ error: 'Fisier JSON invalid.' }); }
  if (!Array.isArray(parsed.firme) || !parsed.firme.length || !Array.isArray(parsed.users)) {
    return res.status(400).json({ error: 'Nu pare o baza de date Contabo valida (lipsesc firme/users).' });
  }
  logAudit('backup.restore', req.file.originalname, { req, firmaId: null });
  doBackup(); // siguranta: salveaza starea curenta inainte de inlocuire
  db.restoreFromJson(req.file.path); // seteaza in memorie + persista (SQLite + oglinda JSON)
  res.json({ ok: true, message: 'Baza de date a fost restaurata. Va trebui sa te autentifici din nou.' });
});

// ───────────────────────────── SMTP (admin) ─────────────────────────────
app.get('/api/smtp', requireAdmin, (req, res) => {
  const s = db.get().settings.smtp || {};
  res.json({ host: s.host || '', port: s.port || 587, secure: !!s.secure, user: s.user || '', from: s.from || '', configured: !!s.host, notifyNewMessage: s.notifyNewMessage !== false });
});
app.post('/api/smtp', requireAdmin, (req, res) => {
  const d = db.get();
  const s = d.settings.smtp || {};
  const b = req.body || {};
  ['host', 'user', 'from'].forEach((k) => { if (b[k] != null) s[k] = b[k]; });
  if (b.port != null) s.port = Number(b.port) || 587;
  if (b.secure != null) s.secure = !!b.secure;
  if (b.pass) s.pass = b.pass;
  if (b.notifyNewMessage != null) s.notifyNewMessage = !!b.notifyNewMessage;
  d.settings.smtp = s;
  db.save();
  res.json({ ok: true, configured: !!s.host });
});
app.post('/api/logout', (req, res) => {
  const u = currentUser(req);
  if (u && req._sessId) { u.sessions = (u.sessions || []).filter((s) => s.id !== req._sessId); db.save(); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

// ───────────────────────────── SESIUNI ACTIVE ─────────────────────────────
app.get('/api/sessions', (req, res) => {
  res.json((req.user.sessions || []).map((s) => ({
    id: s.id, ua: s.ua, ip: s.ip, createdAt: s.createdAt, lastSeen: s.lastSeen, current: s.id === req._sessId,
  })).reverse());
});
app.post('/api/sessions/logout-others', (req, res) => {
  req.user.sessions = (req.user.sessions || []).filter((s) => s.id === req._sessId);
  logAudit('session.logout_others', req.user.username, { req, firmaId: null });
  db.save();
  res.json({ ok: true });
});
app.delete('/api/sessions/:id', (req, res) => {
  req.user.sessions = (req.user.sessions || []).filter((s) => s.id !== req.params.id);
  db.save();
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

app.post('/api/change-password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const u = req.user;
  if (!authlib.verifyPassword(oldPassword, u.salt, u.hash)) return res.status(400).json({ error: 'Parola veche gresita.' });
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'Parola noua prea scurta (min. 4).' });
  const h = authlib.hashPassword(newPassword);
  u.salt = h.salt; u.hash = h.hash; u.mustChange = false;
  db.save();
  res.json({ ok: true });
});
app.get('/api/profile', (req, res) => res.json({
  username: req.user.username, email: req.user.email || '', role: req.user.role,
  tip: plans.userKind(req.user), notifyDeadlines: req.user.notifyDeadlines !== false,
  profil: req.user.profil || {},
}));

// ── Abonamente (planuri + trial) ──
// Prețurile sunt publice (vizibile pe pagina de înscriere, fără autentificare).
// Abonament / plati Stripe (planuri, checkout, portal, webhook, proba/select, activare admin): src/routes/billing.js
require('./src/routes/billing')(app, { requireAdmin, logAudit });
app.post('/api/profile', (req, res) => {
  const b = req.body || {};
  if (b.email != null) req.user.email = String(b.email);
  if (b.notifyDeadlines != null) req.user.notifyDeadlines = !!b.notifyDeadlines;
  // date personale (necontabil / contabil): nume, telefon, adresa + autorizatia contabilului
  if (b.profil && typeof b.profil === 'object') {
    const p = req.user.profil || {};
    for (const k of ['numeComplet', 'telefon', 'adresa', 'oras', 'judet', 'autorizatie']) {
      if (b.profil[k] != null) p[k] = String(b.profil[k]).slice(0, 120).trim();
    }
    req.user.profil = p;
  }
  db.save();
  res.json({ ok: true, email: req.user.email, notifyDeadlines: req.user.notifyDeadlines !== false, profil: req.user.profil || {} });
});

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
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'Parola prea scurta (min. 4).' });
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
app.post('/api/accounts/import', (req, res) => {
  const rows = parseCsv((req.body || {}).csv || '');
  if (!rows.length) return res.status(400).json({ error: 'CSV gol sau invalid.' });
  let start = 0;
  if (/cont|cod|denumire/i.test((rows[0][0] || '') + (rows[0][1] || ''))) start = 1;
  const d = db.get();
  const list = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const cod = String(r[0] || '').trim();
    if (!cod || !r[1]) continue;
    list.push({ cod, nume: r[1], clasa: Number(r[2]) || Number(cod[0]) || 0, tip: (r[3] || 'B').toUpperCase() });
  }
  // upsert in customAccounts
  for (const a of list) {
    const ex = d.customAccounts.find((x) => x.cod === a.cod);
    if (ex) Object.assign(ex, a); else d.customAccounts.push(a);
  }
  coa.addAccounts(list);
  logAudit('accounts.import', list.length + ' conturi', { req });
  db.save();
  res.json({ ok: true, importati: list.length, totalConturi: coa.ACCOUNTS.length });
});
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

app.get('/api/firme', (req, res) => {
  const d = db.get();
  const allowed = allowedFirme(req.user);
  const firme = d.firme.filter((f) => allowed.includes(f.id)).map((f) => Object.assign({}, f, { _sub: plans.firmaStatus(f) }));
  res.json({ firme, firmaActiva: activeId(req) });
});
app.post('/api/firme', (req, res) => {
  const d = db.get();
  const id = db.nextFirmaId();
  const b = req.body || {};
  const f = Object.assign(db.defaultFirma(id), {
    nume: b.nume || ('Firma ' + id), cui: b.cui || '', regCom: b.regCom || '',
    adresa: b.adresa || '', oras: b.oras || '', judet: b.judet || 'RO-B',
    tvaPlatitor: b.tvaPlatitor != null ? !!b.tvaPlatitor : true,
    tipEntitate: b.tipEntitate === 'pfa' ? 'pfa' : 'srl',
  }, { id });
  // Billing per-firma: firma noua a unui utilizator porneste cu proba de 30 de zile (apoi abonament).
  // Firmele create de admin sunt active direct (adminul nu e taxat).
  f.subscription = req.user.role === 'admin'
    ? { status: 'active', plan: 'grandfathered', since: new Date().toISOString() }
    : plans.firmaTrialSub();
  d.firme.push(f);
  d.partners[id] = {}; d.openingBalances[id] = {};
  // utilizatorul care creeaza firma capata acces (adminul are oricum)
  if (req.user.role !== 'admin') { req.user.firme = req.user.firme || []; req.user.firme.push(id); }
  req.user.firmaActiva = id;
  logAudit('firma.create', f.nume, { req, firmaId: id });
  db.save();
  res.json({ ok: true, firma: f, firmaActiva: id });
});
// Export/import complet al unei firme (migrare/arhivare) — inainte de ruta /:id ca sa nu fie prinse de ea
// mode=replace: SUPRASCRIE firma activa cu datele din copie (cu plasa de siguranta salvata pe server).
// altfel: fisierul devine o firma NOUA (id-uri remapate), datele existente raman neatinse.
function restoreTarget(req, res) {
  if (req.query.mode !== 'replace') return { targetFid: null };
  const fid = activeId(req);
  if (!allowedFirme(req.user).includes(fid)) { res.status(403).json({ error: 'Fara acces la firma activa.' }); return null; }
  // plasa de siguranta: starea curenta a firmei, salvata pe server inainte de suprascriere
  try {
    const dir = path.join(db.DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pre-restore-firma' + fid + '-' + Date.now() + '.json'), JSON.stringify(db.exportFirma(fid)));
  } catch (e) { console.error('pre-restore backup:', e.message); }
  return { targetFid: fid };
}
app.post('/api/firme/import', (req, res) => {
  try {
    const bundle = (req.body && req.body.firma) ? req.body : (req.body && req.body.bundle);
    const t = restoreTarget(req, res); if (!t) return;
    const newFid = db.importFirma(bundle, { targetFid: t.targetFid });
    if (!t.targetFid && req.user && req.user.role !== 'admin') { req.user.firme = req.user.firme || []; req.user.firme.push(newFid); }
    if (req.user) req.user.firmaActiva = newFid;
    logAudit('firma.import', (t.targetFid ? 'firma ' + newFid + ' SUPRASCRISA din copie' : 'firma noua ' + newFid + ' (restaurare din fisier)'), { req, firmaId: newFid });
    db.save();
    res.json({ ok: true, firmaId: newFid, replaced: !!t.targetFid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Ramura de testare: cloneaza firma activa intr-o copie marcata [TEST] si comuta pe ea
app.post('/api/firme/:id/test-clone', (req, res) => {
  if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
  try {
    const src = db.getFirma(req.params.id) || {};
    const newFid = db.importFirma(db.exportFirma(req.params.id));
    const nf = db.getFirma(newFid);
    if (nf) { nf.nume = '[TEST] ' + String(src.nume || 'Firma').replace(/^\[TEST\]\s*/, ''); nf.test = true; }
    if (req.user) { req.user.firmaActiva = newFid; if (req.user.role !== 'admin') { req.user.firme = req.user.firme || []; req.user.firme.push(newFid); } }
    logAudit('firma.test-clone', 'firma de test ' + newFid + ' din ' + req.params.id, { req, firmaId: newFid });
    db.save();
    res.json({ ok: true, firmaId: newFid, nume: nf ? nf.nume : '' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
function firmaSlug(bundle) {
  return String((bundle.firma && bundle.firma.nume) || 'firma').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'firma';
}
app.get('/api/firme/:id/export', (req, res) => {
  const id = Number(req.params.id);
  if (!allowedFirme(req.user).includes(id)) return res.status(403).json({ error: 'Firma neautorizata.' });
  const bundle = db.exportFirma(id);
  const fname = 'contabo-' + firmaSlug(bundle) + '-' + new Date().toISOString().slice(0, 10) + '.json';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
  res.send(JSON.stringify(bundle, null, 2));
});
// Construieste ZIP-ul complet al unei firme: firma.json + fisierele scanate atasate (files/*).
function firmaZipBuffer(id) {
  const bundle = db.exportFirma(id);
  const zip = new AdmZip();
  zip.addFile('firma.json', Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'));
  let nFiles = 0;
  for (const doc of (bundle.documents || [])) {
    if (!doc.storedName) continue;
    const p = path.join(db.UPLOAD_DIR, path.basename(doc.storedName));
    if (fs.existsSync(p)) { zip.addLocalFile(p, 'files'); nFiles++; }
  }
  return { buffer: zip.toBuffer(), slug: firmaSlug(bundle), nFiles };
}
// Copie completa (ZIP) a unei firme.
app.get('/api/firme/:id/export-zip', (req, res) => {
  const id = Number(req.params.id);
  if (!allowedFirme(req.user).includes(id)) return res.status(403).json({ error: 'Firma neautorizata.' });
  const z = firmaZipBuffer(id);
  logAudit('firma.export', 'copie ZIP (' + z.nFiles + ' fisiere)', { req, firmaId: id });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="contabo-' + z.slug + '-' + new Date().toISOString().slice(0, 10) + '.zip"');
  res.send(z.buffer);
});
// Admin: TOATE firmele intr-o singura arhiva — cate un ZIP separat per firma (fiecare restaurabil individual).
app.get('/api/firme/export-all', requireAdmin, (req, res) => {
  const outer = new AdmZip();
  let n = 0;
  for (const f of db.get().firme) {
    const z = firmaZipBuffer(f.id);
    outer.addFile('firma-' + f.id + '-' + z.slug + '.zip', z.buffer);
    n++;
  }
  logAudit('firma.export', 'export toate firmele (' + n + ' ZIP-uri)', { req });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="contabo-toate-firmele-' + new Date().toISOString().slice(0, 10) + '.zip"');
  res.send(outer.toBuffer());
});
// Restaurare din ZIP: extrage firma.json + scrie fisierele sub nume NOI (anti-coliziune), apoi importa.
const uploadRestore = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
app.post('/api/firme/import-zip', uploadRestore.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
    const zip = new AdmZip(req.file.buffer);
    const je = zip.getEntry('firma.json');
    if (!je) return res.status(400).json({ error: 'Arhiva nu contine firma.json — nu pare o copie Contabo.' });
    const bundle = JSON.parse(zip.readAsText(je));
    const storedNameMap = {};
    for (const en of zip.getEntries()) {
      if (en.isDirectory || !en.entryName.startsWith('files/')) continue;
      const base = path.basename(en.entryName);
      if (!base) continue;
      const newName = crypto.randomBytes(8).toString('hex') + (path.extname(base) || '.bin');
      fs.writeFileSync(path.join(db.UPLOAD_DIR, newName), en.getData());
      storedNameMap[base] = newName;
    }
    const t = restoreTarget(req, res); if (!t) return;
    const newFid = db.importFirma(bundle, { storedNameMap, targetFid: t.targetFid });
    if (!t.targetFid && req.user && req.user.role !== 'admin') { req.user.firme = req.user.firme || []; req.user.firme.push(newFid); }
    if (req.user) req.user.firmaActiva = newFid;
    logAudit('firma.import', (t.targetFid ? 'firma ' + newFid + ' SUPRASCRISA din ZIP' : 'firma noua ' + newFid) + ' (' + Object.keys(storedNameMap).length + ' fisiere)', { req, firmaId: newFid });
    db.save();
    res.json({ ok: true, firmaId: newFid, files: Object.keys(storedNameMap).length, replaced: !!t.targetFid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/firme/:id', (req, res) => {
  if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
  const f = db.getFirma(req.params.id);
  if (!f) return res.status(404).json({ error: 'Firma inexistenta' });
  Object.assign(f, req.body || {}, { id: f.id });
  db.save();
  res.json({ ok: true, firma: f });
});
app.post('/api/firme/:id/activate', (req, res) => {
  if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
  req.user.firmaActiva = Number(req.params.id);
  db.save();
  res.json({ ok: true, firmaActiva: req.user.firmaActiva });
});
// Abonare pe FIRMA (billing strict per-firma): deschide plata Stripe pentru planul potrivit
// (Start pentru necontabili / Pro pentru contabili) si activeaza abonamentul FIRMEI pe luna curenta,
// deblocand scrierile. Fiecare firma se plateste separat.
app.post('/api/firme/:id/subscribe', wrap(async (req, res) => {
  if (!canAccess(req, req.params.id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
  const f = db.getFirma(req.params.id);
  if (!f) return res.status(404).json({ error: 'Firma inexistenta.' });
  // planul: din cerere, altfel dupa tipul utilizatorului (contabil -> Pro, necontabil/tester -> Start)
  const b = req.body || {};
  const plan = b.plan === 'pro' ? 'pro' : b.plan === 'start' ? 'start' : (plans.userKind(req.user) === 'contabil' ? 'pro' : 'start');
  const luna = new Date().toISOString().slice(0, 7);
  // activeaza abonamentul FIRMEI (per-firma) + noteaza luna
  const prev = f.subscription || {};
  f.subscription = {
    status: 'active', plan, since: prev.since || new Date().toISOString(),
    trialEndsAt: prev.trialEndsAt || null,
    abonamente: Object.assign({}, prev.abonamente || {}, { [luna]: plan }),
  };
  logAudit('firma.subscribe', 'firma ' + f.id + ' abonata (' + plan + ') pe ' + luna, { req, firmaId: f.id });
  // plata: Stripe pentru firma (checkout), daca e configurat
  let url = null;
  if (billing.configured()) {
    const u = db.get().users.find((x) => x.id === req.user.id);
    try { const s = await billing.createCheckoutSession(u, plan); url = s.url; f.subscription.stripeCustomerId = u.subscription && u.subscription.stripeCustomerId || null; } catch (e) { console.error('checkout firma-subscribe:', e.message); }
  }
  db.save();
  res.json({ ok: true, plan, luna, url, stripe: billing.configured() });
}));
app.delete('/api/firme/:id', (req, res) => {
  const d = db.get();
  const id = Number(req.params.id);
  const isAdmin = req.user.role === 'admin' && !req.impersonating;
  // Un utilizator obisnuit isi poate sterge doar propriile firme; adminul, orice firma.
  if (!isAdmin && !(req.user.firme || []).includes(id)) return res.status(403).json({ error: 'Fara acces la aceasta firma.' });
  // Garda „cel putin o firma ramane": global pentru admin, respectiv in contul utilizatorului.
  const remaining = isAdmin ? d.firme.length : (req.user.firme || []).length;
  if (remaining <= 1) return res.status(400).json({ error: 'Trebuie sa ramana cel putin o firma.' });
  d.firme = d.firme.filter((f) => f.id !== id);
  d.entries = d.entries.filter((e) => e.firmaId !== id);
  d.documents = d.documents.filter((x) => x.firmaId !== id);
  d.openingAnalytic = d.openingAnalytic.filter((o) => o.firmaId !== id);
  delete d.partners[id]; delete d.openingBalances[id];
  d.users.forEach((u) => { if (Array.isArray(u.firme)) u.firme = u.firme.filter((x) => x !== id); });
  // daca firma stearsa era cea activa a utilizatorului, muta-l pe prima ramasa a lui
  if (req.user.firmaActiva === id) req.user.firmaActiva = (req.user.firme || [])[0] || (d.firme[0] && d.firme[0].id) || null;
  logAudit('firma.delete', 'firma ' + id, { req, firmaId: null });
  db.save();
  res.json({ ok: true });
});

// ───────────────────────────── UTILIZATORI (admin) ─────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const base = (req.protocol || 'http') + '://' + req.get('host');
  res.json(db.get().users.map((u) => ({
    id: u.id, username: u.username, role: u.role, tip: plans.userKind(u), plan: plans.status(u.subscription).plan, firme: u.firme || [],
    drepturi: u.drepturi || {},
    pending: !!u.pending, inviteLink: u.pending && u.inviteToken ? base + '/?invite=' + u.inviteToken : null,
  })));
});
app.post('/api/users', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password) return res.status(400).json({ error: 'Utilizator si parola obligatorii.' });
  const d = db.get();
  if (d.users.some((u) => u.username === b.username)) return res.status(400).json({ error: 'Utilizator deja existent.' });
  const { salt, hash } = authlib.hashPassword(b.password);
  const u = { id: db.nextUserId(), username: b.username, email: b.email || '', salt, hash, role: b.role === 'admin' ? 'admin' : 'user', firme: Array.isArray(b.firme) ? b.firme.map(Number) : [], firmaActiva: (b.firme && b.firme[0]) || null };
  d.users.push(u);
  logAudit('user.create', b.username + ' (' + u.role + ')', { req, firmaId: null });
  db.save();
  res.json({ ok: true, user: { id: u.id, username: u.username, role: u.role, firme: u.firme } });
});
app.post('/api/users/:id', requireAdmin, (req, res) => {
  const u = db.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilizator inexistent' });
  const b = req.body || {};
  if (b.role) u.role = b.role === 'admin' ? 'admin' : 'user';
  if (Array.isArray(b.firme)) u.firme = b.firme.map(Number);
  if (b.drepturi && typeof b.drepturi === 'object') u.drepturi = { readonly: !!b.drepturi.readonly, faraSalarii: !!b.drepturi.faraSalarii };
  if (b.password) { const h = authlib.hashPassword(b.password); u.salt = h.salt; u.hash = h.hash; u.mustChange = false; }
  logAudit('user.update', u.username, { req, firmaId: null });
  db.save();
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const d = db.get();
  const id = Number(req.params.id);
  if (req.user.id === id) return res.status(400).json({ error: 'Nu te poti sterge pe tine.' });
  if (d.users.filter((u) => u.role === 'admin').length <= 1 && db.getUser(id) && db.getUser(id).role === 'admin') {
    return res.status(400).json({ error: 'Trebuie sa ramana cel putin un administrator.' });
  }
  const target = db.getUser(id);
  d.users = d.users.filter((u) => u.id !== id);
  logAudit('user.delete', target ? target.username : ('id ' + id), { req, firmaId: null });
  db.save();
  res.json({ ok: true });
});

// ───────────────────────────── INVITATII ─────────────────────────────
// Adminul creeaza o invitatie; rezulta un link pe care il poate trimite (manual sau prin email).
app.post('/api/invites', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.username) return res.status(400).json({ error: 'Utilizator obligatoriu.' });
  const d = db.get();
  if (d.users.some((u) => u.username === b.username)) return res.status(400).json({ error: 'Utilizator deja existent.' });
  const token = crypto.randomBytes(24).toString('hex');
  const u = {
    id: db.nextUserId(), username: b.username, email: b.email || '', salt: '', hash: '', pending: true, inviteToken: token,
    inviteExp: Date.now() + 7 * 24 * 3600 * 1000, // expira in 7 zile
    role: b.role === 'admin' ? 'admin' : 'user', firme: Array.isArray(b.firme) ? b.firme.map(Number) : [], firmaActiva: (b.firme && b.firme[0]) || null,
  };
  d.users.push(u);
  logAudit('invite.create', b.username, { req, firmaId: null });
  db.save();
  const base = (req.protocol || 'http') + '://' + req.get('host');
  const link = base + '/?invite=' + token;
  // email optional (daca SMTP e configurat) — altfel adminul copiaza linkul
  let emailed = false;
  if (b.email && d.settings.smtp && d.settings.smtp.host) {
    try { await sendInviteEmail(d.settings.smtp, b.email, link); emailed = true; } catch (e) { console.error('SMTP:', e.message); }
  }
  res.json({ ok: true, link, emailed });
});
function findInvite(token) {
  const u = db.get().users.find((x) => x.pending && x.inviteToken === token);
  if (!u) return { error: 'Invitatie invalida.' };
  if (u.inviteExp && u.inviteExp < Date.now()) return { error: 'Invitatie expirata. Cere alta administratorului.' };
  return { user: u };
}
// Public: detalii invitatie (numele de utilizator) pentru formularul de setare parola
app.get('/api/invite/:token', (req, res) => {
  const r = findInvite(req.params.token);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json({ username: r.user.username, role: r.user.role });
});
// Public: acceptarea invitatiei (setarea parolei) + autentificare
app.post('/api/invite/accept', (req, res) => {
  const { token, password } = req.body || {};
  const d = db.get();
  const r = findInvite(token);
  if (r.error) return res.status(404).json({ error: r.error });
  const u = r.user;
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'Parola prea scurta (min. 4).' });
  const h = authlib.hashPassword(password);
  u.salt = h.salt; u.hash = h.hash; u.pending = false; delete u.inviteToken; delete u.inviteExp;
  startSession(req, res, u);
  logAudit('invite.accept', u.username, { userId: u.id, username: u.username, firmaId: null });
  db.save();
  res.json({ ok: true, user: publicUser(u) });
});

function sendInviteEmail(smtp, to, link) {
  // hook simplu SMTP prin nodemailer daca e instalat; altfel arunca (adminul foloseste linkul).
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) { throw new Error('nodemailer neinstalat'); }
  const t = nodemailer.createTransport({ host: smtp.host, port: smtp.port || 587, secure: !!smtp.secure, auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined });
  return t.sendMail({ from: smtp.from || smtp.user, to, subject: 'Invitatie Contabo', text: 'Ai fost invitat in Contabo. Seteaza-ti parola aici:\n' + link });
}

app.post('/api/company', (req, res) => {
  const f = db.getFirma(activeId(req));
  const b = Object.assign({}, req.body || {});
  delete b.logoFile; // logo-ul se administreaza doar prin rutele dedicate (fisier validat)
  if (f) Object.assign(f, b, { id: f.id });
  db.save();
  res.json({ ok: true, company: f });
});

// ── Logo firma (layout documente): apare in antetul tuturor PDF-urilor emise ──
app.post('/api/company/logo', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
  const p = req.file.path;
  let head;
  try { head = fs.readFileSync(p).slice(0, 4); } catch (e) { return res.status(400).json({ error: 'Fisier ilizibil.' }); }
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
  const isJpg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
  if (!isPng && !isJpg) {
    try { fs.unlinkSync(p); } catch (_) { /* */ }
    return res.status(400).json({ error: 'Logo-ul trebuie sa fie PNG sau JPEG (PDF-urile nu accepta alte formate).' });
  }
  const f = db.getFirma(activeId(req));
  if (!f) return res.status(400).json({ error: 'Firma inexistenta.' });
  if (f.logoFile) { try { fs.unlinkSync(path.join(db.UPLOAD_DIR, f.logoFile)); } catch (_) { /* logo vechi deja sters */ } }
  f.logoFile = path.basename(p);
  logAudit('company.logo', 'logo incarcat (' + (isPng ? 'PNG' : 'JPEG') + ')', { req });
  db.save();
  res.json({ ok: true, logoFile: f.logoFile });
});
app.get('/api/company/logo', (req, res) => {
  const f = db.getFirma(activeId(req));
  if (!f || !f.logoFile) return res.status(404).send('Fara logo');
  const p = path.join(db.UPLOAD_DIR, String(f.logoFile).replace(/[^a-zA-Z0-9._-]/g, ''));
  if (!fs.existsSync(p)) return res.status(404).send('Fara logo');
  res.setHeader('Content-Type', /\.png$/i.test(p) ? 'image/png' : 'image/jpeg');
  res.sendFile(p);
});
app.delete('/api/company/logo', (req, res) => {
  const f = db.getFirma(activeId(req));
  if (f && f.logoFile) {
    try { fs.unlinkSync(path.join(db.UPLOAD_DIR, f.logoFile)); } catch (_) { /* deja sters */ }
    delete f.logoFile;
    db.save();
  }
  res.json({ ok: true });
});

// Chitanta tiparibila pentru o incasare in numerar (531x): numarul se atribuie din seria CH la prima tiparire
app.get('/pdf/chitanta/:id', (req, res) => {
  const d = db.get();
  const e = d.entries.find((x) => x.id === req.params.id && (x.firmaId == null ? d.firmaActiva : x.firmaId) === activeId(req));
  if (!e) return res.status(404).send('Inregistrare inexistenta');
  const suma = e.lines.reduce((s, l) => s + (/^531/.test(String(l.debit)) ? l.suma : 0), 0);
  if (suma <= 0) return res.status(400).send('Inregistrarea nu este o incasare in numerar (531x) — chitanta se emite doar pentru incasari in casa.');
  if (!e.chitantaNr) {
    const s = ensureDocSeries(d, activeId(req)).CH;
    e.chitantaNr = s.serie + '-' + String(s.next).padStart(5, '0');
    s.next += 1;
    logAudit('chitanta', e.chitantaNr + ' pentru ' + (e.partener || e.id), { req });
    db.save();
  }
  pdf.chitantaPdf(res, S(req).company, e, Math.round(suma * 100) / 100, e.chitantaNr);
});

app.post('/api/settings', (req, res) => {
  const d = db.get();
  d.settings = Object.assign({}, d.settings, req.body || {});
  db.save();
  res.json({ ok: true, settings: d.settings });
});

// Cote fiscale configurabile (admin): CAS/CASS/impozit/TVA/profit/salariu minim etc.
app.get('/api/fiscal-config', requireAdmin, (req, res) => res.json({ current: fiscal.FISCAL, defaults: fiscal.DEFAULTS, custom: db.get().settings.fiscal || {} }));
app.post('/api/fiscal-config', requireAdmin, (req, res) => {
  const d = db.get();
  const b = req.body || {};
  if (b.reset) { delete d.settings.fiscal; fiscal.applyConfig({}); logAudit('fiscal.config', 'reset la valori standard', { req, firmaId: null }); }
  else {
    const cfg = Object.assign({}, d.settings.fiscal || {});
    for (const k of Object.keys(fiscal.DEFAULTS)) { if (b[k] != null && b[k] !== '' && Number.isFinite(Number(b[k]))) cfg[k] = Number(b[k]); }
    d.settings.fiscal = cfg;
    fiscal.applyConfig(cfg);
    logAudit('fiscal.config', 'cote fiscale actualizate', { req, firmaId: null });
  }
  db.save();
  res.json({ ok: true, current: fiscal.FISCAL });
});

app.get('/api/partners', (req, res) => res.json(S(req).partners));
app.post('/api/partners', (req, res) => {
  const p = req.body || {};
  const key = String(p.cui || '').replace(/^ro/i, '').replace(/\s/g, '');
  if (!key) return res.status(400).json({ error: 'CUI lipsa.' });
  const d = db.get();
  const fid = activeId(req);
  d.partners[fid] = d.partners[fid] || {};
  const prev = d.partners[fid][key] || {};
  d.partners[fid][key] = {
    cui: key, den: p.den || '', adresa: p.adresa || '', oras: p.oras || '',
    judet: p.judet || '', tara: p.tara || 'RO', tip: p.tip != null ? p.tip : (prev.tip || ''),
  };
  db.save();
  res.json({ ok: true, partner: d.partners[fid][key] });
});
// Import parteneri din CSV: coloane CUI;Denumire;Adresa;Oras;Judet;Tara (header optional)
// Conversie XLSX (Excel modern) / DBF (dBASE-FoxPro) -> CSV, pentru fluxurile de import (parteneri, conturi, produse).
app.post('/api/xlsx-to-csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
  let rows;
  try {
    const data = fs.readFileSync(req.file.path);
    const name = req.file.originalname || '';
    const isXlsx = (data.length > 1 && data[0] === 0x50 && data[1] === 0x4B) || /\.xlsx$/i.test(name); // "PK" -> zip
    const isXls = (data.length > 1 && data[0] === 0xD0 && data[1] === 0xCF) || /\.xls$/i.test(name);   // OLE compound -> Excel vechi
    const isDbf = /\.dbf$/i.test(name) || [0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x83, 0x8b, 0xf5, 0xfb].includes(data[0]);
    rows = isXlsx ? xlsx.parseXlsx(data) : isXls ? xls.parseXls(data) : isDbf ? dbf.parseDbf(data) : xlsx.parseXlsx(data);
  } catch (e) { try { fs.unlinkSync(req.file.path); } catch (_) { /* */ } return res.status(400).json({ error: e.message }); }
  try { fs.unlinkSync(req.file.path); } catch (_) { /* */ }
  if (!rows.length) return res.status(400).json({ error: 'Fisierul este gol sau nerecunoscut.' });
  res.json({ ok: true, rows: rows.length, csv: toCsv(rows[0], rows.slice(1)) });
});
app.post('/api/partners/import', (req, res) => {
  const rows = parseCsv((req.body || {}).csv || '');
  if (!rows.length) return res.status(400).json({ error: 'CSV gol sau invalid.' });
  // sare peste randul de antet daca prima celula nu pare un CUI
  let start = 0;
  if (/cui|cod|denumire/i.test((rows[0][0] || '') + (rows[0][1] || ''))) start = 1;
  const d = db.get();
  const fid = activeId(req);
  d.partners[fid] = d.partners[fid] || {};
  let importati = 0; const erori = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const key = String(r[0] || '').replace(/^ro/i, '').replace(/\s/g, '');
    if (!key) { erori.push('rand ' + (i + 1) + ': CUI lipsa'); continue; }
    d.partners[fid][key] = { cui: key, den: r[1] || '', adresa: r[2] || '', oras: r[3] || '', judet: r[4] || '', tara: r[5] || 'RO', tip: (r[6] || '').toLowerCase().trim() };
    importati += 1;
  }
  logAudit('partners.import', importati + ' parteneri', { req });
  db.save();
  res.json({ ok: true, importati, erori });
});

app.get('/api/opening-analytic', (req, res) => res.json(S(req).openingAnalytic));
app.post('/api/opening-analytic', (req, res) => {
  const b = req.body || {};
  if (!b.cont) return res.status(400).json({ error: 'Lipseste contul.' });
  const d = db.get();
  const fid = activeId(req);
  d.openingAnalytic = d.openingAnalytic || [];
  const key = (p) => p.firmaId + '|' + p.cont + '|' + String(p.cui || p.partener || '').toUpperCase().replace(/^RO/i, '').replace(/\s/g, '');
  const rec = { firmaId: fid, cont: String(b.cont), partener: b.partener || '', cui: b.cui || '', d: round2(parseFloat(b.d) || 0), c: round2(parseFloat(b.c) || 0) };
  const i = d.openingAnalytic.findIndex((x) => key(x) === key(rec));
  if (i >= 0) d.openingAnalytic[i] = rec; else d.openingAnalytic.push(rec);
  db.save();
  res.json({ ok: true, openingAnalytic: d.openingAnalytic.filter((o) => o.firmaId === fid) });
});
app.delete('/api/opening-analytic/:idx', (req, res) => {
  const d = db.get();
  const fid = activeId(req);
  const list = d.openingAnalytic.filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === fid);
  const rec = list[Number(req.params.idx)];
  if (rec) { const gi = d.openingAnalytic.indexOf(rec); if (gi >= 0) d.openingAnalytic.splice(gi, 1); }
  db.save();
  res.json({ ok: true });
});

app.get('/api/opening', (req, res) => res.json(S(req).openingBalances));
app.post('/api/opening', (req, res) => {
  const d = db.get();
  const ob = (req.body && req.body.openingBalances) ? req.body.openingBalances : {};
  // Soldurile initiale trebuie sa fie echilibrate (total debit = total credit), altfel balanta
  // nu se va inchide niciodata. Verificam inainte de salvare si respingem cu diferenta exacta.
  let totD = 0; let totC = 0;
  for (const cod of Object.keys(ob)) { totD = round2(totD + (Number(ob[cod] && ob[cod].d) || 0)); totC = round2(totC + (Number(ob[cod] && ob[cod].c) || 0)); }
  const dif = round2(totD - totC);
  if (Math.abs(dif) >= 0.005) {
    return res.status(400).json({ error: 'Soldurile inițiale sunt dezechilibrate: total debit ' + totD + ' ≠ total credit ' + totC + ' (diferență ' + dif + '). Corectează-le înainte de salvare.', totalDebit: totD, totalCredit: totC, diferenta: dif });
  }
  d.openingBalances[activeId(req)] = ob;
  logAudit('opening.set', 'solduri initiale (' + Object.keys(ob).length + ' conturi, echilibrat)', { req });
  db.save();
  res.json({ ok: true, totalDebit: totD, totalCredit: totC });
});

// ───────────────────────────── UPLOAD ─────────────────────────────
// Plafon zilnic de extrageri AI per utilizator — fiecare apel costa bani; contul demo e public,
// deci are o limita stricta. Peste plafon se revine automat la regulile locale (fara eroare).
const AI_DAILY_LIMIT = Number(process.env.CONTAB_AI_DAILY_LIMIT) || 200;
const AI_DAILY_LIMIT_DEMO = Number(process.env.CONTAB_AI_DAILY_LIMIT_DEMO) || 10;
function aiQuotaLeft(u) {
  const today = new Date().toISOString().slice(0, 10);
  const used = u.aiUsage && u.aiUsage.date === today ? u.aiUsage.count : 0;
  return (u.username === 'demo' ? AI_DAILY_LIMIT_DEMO : AI_DAILY_LIMIT) - used;
}
function bumpAiUsage(u) {
  const today = new Date().toISOString().slice(0, 10);
  u.aiUsage = u.aiUsage && u.aiUsage.date === today
    ? { date: today, count: u.aiUsage.count + 1 }
    : { date: today, count: 1 };
}

app.post('/api/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
  const d = db.get();
  const ownCui = (db.getFirma(activeId(req)) || {}).cui;
  const buf = fs.readFileSync(req.file.path);

  let extracted;
  let source = 'heuristic';
  let warning = null;
  let extra = {};
  const aiWanted = ai.aiAvailable() && d.settings.useAI !== false;
  const useAI = aiWanted && aiQuotaLeft(req.user) > 0;
  if (aiWanted && !useAI) warning = 'Limita zilnica de extrageri AI a fost atinsa — s-au folosit regulile locale.';
  if (useAI) {
    bumpAiUsage(req.user); // numara si incercarile esuate (apelul se factureaza oricum)
    try {
      const r = await ai.extractWithAI(buf, ownCui);
      extracted = { suggestedType: r.suggestedType, fields: r.fields, cuis: r.cuis, text: '' };
      source = 'ai';
      extra = { incredere: r.incredere, motiv: r.motiv };
    } catch (e) {
      warning = 'Extragerea cu AI a esuat (' + (e.message || e) + '). S-au folosit reguli locale.';
      console.error('AI extract failed:', e.message || e);
    }
  }
  const mediaType = ai.detectMediaType(buf);
  const isImage = mediaType && mediaType.startsWith('image/');
  if (!extracted) {
    if (isImage) {
      // imaginile nu pot fi citite cu reguli locale (text) — necesita extragerea cu AI
      extracted = { suggestedType: 'nota_contabila', fields: {}, cuis: [], text: '' };
      if (!warning) warning = useAI ? warning : 'Pentru imagini (JPG/PNG) e nevoie de extragerea cu AI (configureaz-o in Setari). Completeaza manual campurile.';
    } else {
      extracted = await extractFromPdf(buf, ownCui);
    }
  }

  const docId = db.nextId('doc');
  d.documents.push({
    id: docId,
    firmaId: activeId(req),
    fileName: req.file.originalname,
    storedName: req.file.filename,
    uploadedAt: new Date().toISOString(),
    text: (extracted.text || '').slice(0, 20000),
  });
  db.save();
  res.json(Object.assign({
    documentId: docId,
    fileName: req.file.originalname,
    suggestedType: extracted.suggestedType,
    fields: extracted.fields,
    cuis: extracted.cuis,
    source,
    warning,
  }, extra));
}));

// Document fara extragere (introducere manuala / atasament)
app.post('/api/upload-only', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
  const d = db.get();
  const docId = db.nextId('doc');
  d.documents.push({
    id: docId, firmaId: activeId(req), fileName: req.file.originalname, storedName: req.file.filename,
    uploadedAt: new Date().toISOString(), text: '',
  });
  db.save();
  res.json({ documentId: docId, fileName: req.file.originalname });
});

// Inline doar tipurile inerte (viewer PDF/galerie); restul se descarca fortat, ca octeti,
// ca sa nu se randeze niciodata continut incarcat de utilizatori in origin-ul aplicatiei.
const DOC_INLINE_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
app.get('/api/document/:id/file', (req, res) => {
  const d = db.get();
  const doc = d.documents.find((x) => x.id === req.params.id);
  if (!doc) return res.status(404).send('Document inexistent');
  const fid = doc.firmaId == null ? d.firmaActiva : doc.firmaId;
  if (!allowedFirme(req.user).includes(fid)) return res.status(403).json({ error: 'Nu ai acces la acest document.' });
  const p = path.join(db.UPLOAD_DIR, path.basename(doc.storedName || ''));
  if (!fs.existsSync(p)) return res.status(404).send('Fisier negasit pe server');
  const ext = path.extname(p).toLowerCase();
  if (DOC_INLINE_EXT.has(ext)) return res.sendFile(p);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(doc.fileName || doc.storedName) + '"');
  fs.createReadStream(p).pipe(res);
});

app.get('/api/documents', (req, res) => {
  res.json(S(req).documents.map((x) => ({ id: x.id, fileName: x.fileName, uploadedAt: x.uploadedAt })));
});

// Galerie documente primite: fiecare fisier incarcat, cu tipul (imagine/pdf) si articolul asociat.
app.get('/api/documents/gallery', (req, res) => {
  const v = S(req);
  const byFile = {};
  for (const e of v.entries) if (e.fileId) byFile[e.fileId] = e;
  const typeOf = (name) => {
    const x = (String(name || '').match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'tif', 'tiff'].includes(x)) return 'image';
    if (x === 'pdf') return 'pdf';
    return 'other';
  };
  const docs = v.documents.map((d) => {
    const e = byFile[d.id];
    return {
      id: d.id, fileName: d.fileName, uploadedAt: d.uploadedAt, type: typeOf(d.storedName || d.fileName),
      entry: e ? { id: e.id, tip: e.tip, tipNume: e.tipNume, data: e.data, partener: e.partener || '', document: e.document || '' } : null,
    };
  }).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  res.json(docs);
});

// Galerie documente emise: facturile catre clienti (grup Vanzari), fiecare cu PDF vizual + e-Factura.
app.get('/api/documents/emitted', (req, res) => {
  const v = S(req);
  const EFACT = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare']);
  const rows = v.entries.filter((e) => { const t = getType(e.tip); return t && t.grup === 'Vanzari'; }).map((e) => {
    let baza = 0; let tva = 0;
    for (const l of e.lines) {
      if (Number(String(l.credit)[0]) === 7) baza = round2(baza + l.suma);
      if (Number(String(l.debit)[0]) === 7) baza = round2(baza - l.suma);
      if (l.credit === '4427' || l.credit === '4428') tva = round2(tva + l.suma);
      if (l.debit === '4427' || l.debit === '4428') tva = round2(tva - l.suma);
    }
    return { id: e.id, tip: e.tip, tipNume: e.tipNume, data: e.data, period: e.period || periodOf(e.data), partener: e.partener || '', document: e.document || '', baza, tva, total: round2(baza + tva), eFactura: EFACT.has(e.tip) };
  }).sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  res.json(rows);
});

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

app.post('/api/entries', (req, res) => {
  const { tip, fields, fileId, spvMsgId } = req.body || {};
  const f = Object.assign({}, fields || {});
  const stocLines = Array.isArray(f.stoc) ? f.stoc.filter((s) => s && s.productId && Number(s.cantitate) > 0) : [];
  if (stocLines.length) f.cost = 0; // descarcarea vine din stoc (la CMP), nu din campul manual — evita dubla inregistrare
  let entry;
  try { entry = buildEntry(tip, f, fileId, activeId(req)); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (spvMsgId) entry.spvImport = { msgId: spvMsgId, at: new Date().toISOString() };
  const d = db.get();
  const fid = activeId(req);
  // Descarcare automata de gestiune din liniile de stoc (cost marfa vanduta la CMP)
  let stocInfo = null;
  if (stocLines.length) {
    const v = S(req);
    let r;
    try { r = stocks.saleCogs(v.products, v.stockMovements, stocLines, { fid, data: entry.data, document: entry.document, entryId: entry.id, nextId: () => db.nextId('sm') }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    for (const ln of r.cogsLines) {
      if (!coa.getAccount(ln.debit) || !coa.getAccount(ln.credit)) return res.status(400).json({ error: 'Cont de descarcare inexistent in plan: ' + ln.debit + '/' + ln.credit });
    }
    for (const mv of r.newMovements) d.stockMovements.push(mv);
    for (const ln of r.cogsLines) entry.lines.push(ln);
    entry.stocMovementIds = r.newMovements.map((m) => m.id);
    stocInfo = { cogsTotal: r.total, warns: r.warns, movements: r.newMovements.length };
  }
  d.entries.push(entry);
  upsertPartner(fid, entry);
  logAudit('entry.create', entry.tipNume + ' ' + (entry.document || ''), { req, firmaId: entry.firmaId });
  db.save();
  res.json({ ok: true, entry, stoc: stocInfo });
});

app.get('/api/entries', (req, res) => {
  const { period } = req.query;
  let list = S(req).entries;
  if (period) list = list.filter((e) => (e.period || periodOf(e.data)) === period);
  res.json(acc.sortEntries(list));
});

// ───────────────────────── FACTURI RECURENTE ─────────────────────────
app.get('/api/recurring', (req, res) => {
  const fid = activeId(req);
  res.json((db.get().recurringInvoices || []).filter((t) => t.firmaId === fid));
});
app.post('/api/recurring', (req, res) => {
  const b = req.body || {};
  if (!b.tip) return res.status(400).json({ error: 'Alege tipul de document.' });
  const d = db.get(); const fid = activeId(req);
  const t = b.id && (d.recurringInvoices || []).find((x) => x.id === b.id && x.firmaId === fid);
  const rec = t || { id: db.nextId('rec'), firmaId: fid, createdAt: new Date().toISOString() };
  Object.assign(rec, {
    tip: String(b.tip), partener: b.partener || '', cuiPartener: b.cuiPartener || '', document: b.document || '',
    fields: (b.fields && typeof b.fields === 'object') ? b.fields : {},
    frecventa: ['lunar', 'trimestrial', 'anual'].includes(b.frecventa) ? b.frecventa : 'lunar',
    ziua: Math.min(28, Math.max(1, Number(b.ziua) || 1)),
    startDate: /^\d{4}-\d{2}$/.test(b.startDate || '') ? b.startDate : new Date().toISOString().slice(0, 7),
    activ: b.activ != null ? !!b.activ : true,
  });
  if (!t) d.recurringInvoices.push(rec);
  logAudit('recurring.save', rec.tip + ' (' + rec.frecventa + ')', { req });
  db.save();
  res.json({ ok: true, template: rec });
});
app.delete('/api/recurring/:id', (req, res) => {
  const d = db.get(); const fid = activeId(req);
  d.recurringInvoices = (d.recurringInvoices || []).filter((t) => !(t.id === req.params.id && t.firmaId === fid));
  logAudit('recurring.delete', req.params.id, { req });
  db.save();
  res.json({ ok: true });
});
app.get('/api/recurring/due', (req, res) => {
  const fid = activeId(req);
  const period = req.query.period || new Date().toISOString().slice(0, 7);
  res.json({ period, due: recurring.dueForPeriod((db.get().recurringInvoices || []).filter((t) => t.firmaId === fid), period) });
});
app.post('/api/recurring/generate', (req, res) => {
  const d = db.get(); const fid = activeId(req);
  const period = req.query.period || new Date().toISOString().slice(0, 7);
  const due = recurring.dueForPeriod((d.recurringInvoices || []).filter((t) => t.firmaId === fid), period);
  const created = []; const errors = [];
  for (const t of due) {
    const fields = Object.assign({}, t.fields, {
      data: period + '-' + String(t.ziua || 1).padStart(2, '0'),
      partener: t.partener, cuiPartener: t.cuiPartener, document: t.document,
    });
    try {
      const entry = buildEntry(t.tip, fields, null, fid);
      entry.recurringId = t.id;
      d.entries.push(entry);
      upsertPartner(fid, entry);
      t.lastGenerated = period;
      created.push({ id: entry.id, tip: entry.tipNume, partener: t.partener });
    } catch (e) { errors.push((t.partener || t.tip) + ': ' + e.message); }
  }
  if (created.length) logAudit('recurring.generate', period + ': ' + created.length + ' generate', { req });
  db.save();
  res.json({ ok: true, period, created: created.length, errors, items: created });
});

// ───────────────────────── PRODUCTIE ─────────────────────────
// Helper comun: dintr-o comanda de productie creeaza articolul contabil + miscarile de stoc.
// Productie + retete (BOM): src/routes/production.js
require('./src/routes/production')(app, { S, activeId, logAudit });

app.delete('/api/entries/:id', (req, res) => {
  const d = db.get();
  const e = d.entries.find((x) => x.id === req.params.id);
  // izolare multi-firma: nu stergi inregistrari ale firmelor la care nu ai acces
  if (e && !canAccess(req, e.firmaId == null ? d.firmaActiva : e.firmaId)) return res.status(404).json({ error: 'Inregistrare inexistenta.' });
  if (e) {
    const firma = db.getFirma(e.firmaId == null ? activeId(req) : e.firmaId);
    const per = e.period || periodOf(e.data);
    if (firma && firma.lockedUntil && per <= firma.lockedUntil) {
      return res.status(400).json({ error: 'Inregistrarea e in perioada inchisa ' + per + ' (blocata pana la ' + firma.lockedUntil + '). Deblocheaza perioada (admin) inainte de stergere.' });
    }
  }
  const n = d.entries.length;
  d.entries = d.entries.filter((x) => x.id !== req.params.id);
  if (e) logAudit('entry.delete', e.tipNume + ' ' + (e.document || ''), { req, firmaId: e.firmaId });
  db.save();
  res.json({ ok: true, removed: n - d.entries.length });
});

// Blocare/deblocare perioada (admin): seteaza luna pana la care e read-only (sau goleste pentru deblocare).
app.post('/api/period-lock', requireAdmin, (req, res) => {
  const firma = db.getFirma(activeId(req));
  if (!firma) return res.status(404).json({ error: 'Firma inexistenta.' });
  const v = (req.body || {}).lockedUntil;
  if (v == null || v === '') firma.lockedUntil = null;
  else if (/^\d{4}-\d{2}$/.test(v) && Number(v.slice(5)) >= 1 && Number(v.slice(5)) <= 12) firma.lockedUntil = v;
  else return res.status(400).json({ error: 'Format invalid. Foloseste YYYY-MM (ex. 2026-05) sau gol pentru deblocare.' });
  logAudit('perioada.lock', firma.lockedUntil ? 'blocat pana la ' + firma.lockedUntil : 'deblocat complet', { req });
  db.save();
  res.json({ ok: true, lockedUntil: firma.lockedUntil });
});

// TVA la incasare: din suma bruta incasata/platita, calculeaza TVA exigibila si posteaza nota
app.post('/api/tva-incasare/exigibilitate', (req, res) => {
  const b = req.body || {};
  const brut = round2(Number(b.brut) || 0);
  const cota = Number(b.cota) || 0;
  if (brut <= 0 || cota <= 0) return res.status(400).json({ error: 'Completeaza suma bruta si cota TVA.' });
  const tva = round2((brut * cota) / (100 + cota));
  const tip = b.tip === 'deductibila' ? 'exigibilitate_tva_deductibila' : 'exigibilitate_tva_colectata';
  const data = b.data && String(b.data).length === 10 ? b.data : new Date().toISOString().slice(0, 10);
  const entry = buildEntry(tip, { data, partener: b.partener || '', document: b.document || '', tva }, null, activeId(req));
  entry.system = true;
  // baza aferenta TVA-ului devenit exigibil (pentru D300 in perioada exigibilitatii — TVA la incasare)
  entry.tvaExig = { baza: round2(brut - tva), cota, side: b.tip === 'deductibila' ? 'deductibila' : 'colectata' };
  const d = db.get();
  d.entries.push(entry);
  logAudit('tva.exigibilitate', tip + ' ' + tva, { req });
  db.save();
  res.json({ ok: true, tva, brut, cota, entry });
});

// ───────────────────────────── INCHIDERI ─────────────────────────────
app.post('/api/close-vat', (req, res) => {
  const period = req.query.period;
  // Inchiderea TVA e strict LUNARA/trimestriala: cere o luna (YYYY-MM), nu un an — altfel data
  // notei ar fi malformata (YYYY-28) si blocarea perioadei ineficienta.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) return res.status(400).json({ error: 'Perioada trebuie sa fie o luna (YYYY-MM).' });
  const d = db.get();
  const firma = db.getFirma(activeId(req));
  const v = acc.vatClosing(S(req), period);
  if (v.lines.length) {
    d.entries.push({
      id: db.nextId('e'), firmaId: activeId(req), data: period + '-28', period, tip: 'inchidere_tva', tipNume: 'Inchidere TVA',
      partener: '', document: 'Nota TVA ' + period, explicatie: 'Regularizare TVA',
      fileId: null, system: true, lines: v.lines,
    });
  }
  // Inchiderea lunii BLOCHEAZA perioada (read-only) — nu se mai poate inregistra/sterge in ea fara deblocare (admin).
  if (firma && (!firma.lockedUntil || period > firma.lockedUntil)) firma.lockedUntil = period;
  logAudit('inchidere.tva', period + ' (perioada blocata)', { req });
  db.save();
  res.json({ ok: true, result: v, lockedUntil: firma ? firma.lockedUntil : null, message: v.lines.length ? undefined : 'Fara TVA de regularizat; perioada a fost blocata.' });
});

app.post('/api/close-year', (req, res) => {
  const year = req.query.year;
  if (!year) return res.status(400).json({ error: 'Lipseste anul (YYYY).' });
  const d = db.get();
  const c = acc.annualClosing(S(req), year);
  if (!c.lines.length) return res.json({ ok: true, message: 'Nimic de inchis.', result: c });
  const data = year + '-12-31';
  d.entries.push({
    id: db.nextId('e'), firmaId: activeId(req), data, period: year + '-12', tip: 'inchidere_an', tipNume: 'Inchidere conturi venituri/cheltuieli',
    partener: '', document: 'Inchidere ' + year, explicatie: 'Inchidere clasa 6 si 7 in contul 121',
    fileId: null, system: true, lines: c.lines,
  });
  logAudit('inchidere.an', year, { req });
  db.save();
  res.json({ ok: true, result: c });
});

// Impozit pe profit — calcul cu ajustari fiscale (nedeductibile, deduceri, pierdere reportata) + 691 = 4411.
function profitTaxOpts(req, year) {
  const firma = db.getFirma(activeId(req)) || {};
  const losses = firma.pierdereFiscala || {};
  const src = Object.assign({}, req.query, req.body || {});
  const pr = (src.pierdereReportata != null && src.pierdereReportata !== '') ? Number(src.pierdereReportata) : (Number(losses[Number(year) - 1]) || 0);
  return {
    cota: fiscal.FISCAL.impozitProfit,
    cheltNedeductibile: Number(src.cheltNedeductibile) || 0,
    deduceri: Number(src.deduceri) || 0,
    pierdereReportata: pr || 0,
  };
}
app.get('/api/profit-tax-preview', (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  res.json(acc.profitTax(S(req), year, profitTaxOpts(req, year)));
});
app.post('/api/close-profit-tax', (req, res) => {
  const year = req.query.year || (req.body || {}).year;
  if (!year) return res.status(400).json({ error: 'Lipseste anul (YYYY).' });
  const d = db.get(); const fid = activeId(req);
  const exists = d.entries.find((e) => e.firmaId === fid && e.tip === 'impozit_profit' && e.period === year + '-12');
  if (exists) return res.status(400).json({ error: 'Impozitul pe profit pe ' + year + ' este deja inregistrat.' });
  const pt = acc.profitTax(S(req), year, profitTaxOpts(req, year));
  // memoreaza pierderea fiscala de reportat (chiar daca impozitul e 0), pentru anii urmatori
  const firma = db.getFirma(fid);
  if (firma) { firma.pierdereFiscala = firma.pierdereFiscala || {}; firma.pierdereFiscala[year] = pt.pierdereDeReportat; }
  if (!pt.lines.length) { db.save(); return res.json({ ok: true, message: 'Profit impozabil 0 sau pierdere — niciun impozit. Pierdere fiscala de reportat: ' + pt.pierdereDeReportat + ' lei.', result: pt }); }
  const lines = pt.lines.slice();
  // Ordinea inchiderilor devine IRELEVANTA: daca inchiderea anuala s-a facut deja, 691 (postat acum)
  // ar ramane necuplat in 121 -> il inchidem aici (121 = 691), asa incat 121 arata rezultatul NET.
  // Daca inchiderea anuala nu s-a facut inca, ea va inchide 691 cand se ruleaza (comportament normal).
  const yearClosed = d.entries.some((e) => e.firmaId === fid && e.tip === 'inchidere_an' && e.period === year + '-12');
  let alsoClosed691 = false;
  if (yearClosed && pt.impozit > 0) { lines.push({ debit: '121', credit: '691', suma: pt.impozit, explicatie: 'Inchidere impozit pe profit in rezultat (dupa inchiderea anuala)' }); alsoClosed691 = true; }
  d.entries.push({
    id: db.nextId('e'), firmaId: fid, data: year + '-12-31', period: year + '-12', tip: 'impozit_profit', tipNume: 'Impozit pe profit',
    partener: '', document: 'Impozit profit ' + year, explicatie: 'Inregistrare impozit pe profit (' + pt.cota + '%)' + (alsoClosed691 ? ' + inchidere 691 in 121' : ''),
    fileId: null, system: true, lines,
  });
  logAudit('impozit.profit', year + ': ' + pt.impozit, { req });
  db.save();
  res.json({ ok: true, result: pt });
});

// Repartizarea rezultatului: 121 -> 117 (profit) sau 117 -> 121 (pierdere)
app.get('/api/distribute-preview', (req, res) => {
  res.json(acc.resultDistribution(S(req), req.query.year || String(new Date().getFullYear())));
});
app.post('/api/distribute-result', (req, res) => {
  const year = req.query.year;
  if (!year) return res.status(400).json({ error: 'Lipseste anul (YYYY).' });
  const d = db.get();
  const r = acc.resultDistribution(S(req), year);
  if (!r.lines.length) return res.json({ ok: true, message: 'Soldul contului 121 este zero — nimic de repartizat.', result: r });
  for (const l of r.lines) {
    if (!coa.getAccount(l.debit) || !coa.getAccount(l.credit)) return res.status(400).json({ error: 'Cont inexistent in plan: ' + l.debit + '/' + l.credit });
  }
  d.entries.push({
    id: db.nextId('e'), firmaId: activeId(req), data: year + '-12-31', period: year + '-12', tip: 'repartizare_rezultat', tipNume: 'Repartizarea rezultatului',
    partener: '', document: 'Repartizare ' + year, explicatie: r.profit ? 'Repartizarea profitului (121=117)' : 'Reportarea pierderii (117=121)',
    fileId: null, system: true, lines: r.lines,
  });
  logAudit('repartizare.rezultat', year + ' ' + (r.profit ? 'profit ' + r.profit : 'pierdere ' + r.pierdere), { req });
  db.save();
  res.json({ ok: true, result: r });
});

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

// ───────────────────────────── RAPOARTE (JSON) ─────────────────────────────
app.get('/api/journal', (req, res) => res.json(acc.journal(S(req), req.query.period || null)));
app.get('/api/ledger', (req, res) => res.json(acc.ledger(S(req), req.query.period || null)));
// Fisa de cont: miscarile unui cont cu contul corespondent si sold curent (orice cont din plan)
app.get('/api/fisa-cont', (req, res) => {
  if (!req.query.cont) return res.status(400).json({ error: 'Alege contul (ex. ?cont=4111).' });
  res.json(acc.fisaCont(S(req), req.query.cont, req.query.period || null));
});
app.get('/pdf/fisa-cont', (req, res) => {
  if (!req.query.cont) return res.status(400).send('Alege contul (ex. ?cont=4111).');
  pdf.fisaContPdf(res, S(req).company, acc.fisaCont(S(req), req.query.cont, req.query.period || null));
});
app.get('/api/balance', (req, res) => res.json(acc.trialBalance(S(req), req.query.period || null)));
app.get('/api/vat-preview', (req, res) => res.json(acc.vatClosing(S(req), req.query.period || null)));
app.get('/api/vat-journals', (req, res) => res.json(acc.vatJournals(S(req), req.query.period || null)));
app.get('/api/tva-neexigibila', (req, res) => res.json(acc.tvaNeexigibila(S(req), req.query.period || null)));
app.get('/api/livrabile', (req, res) => res.json(rep.livrabile(S(req), req.query.period || new Date().toISOString().slice(0, 7))));
app.get('/api/reconcile', (req, res) => res.json(reconcile(S(req))));

// ── Compensare creante / datorii (partener client + furnizor) ──
app.get('/api/compensations', (req, res) => res.json(compensablePartners(S(req))));
app.post('/api/compensations', (req, res) => {
  const b = req.body || {}; const fid = activeId(req); const d = db.get();
  const cui = String(b.cui || '').replace(/^ro/i, '').replace(/\s/g, '');
  if (!cui) return res.status(400).json({ error: 'Lipseste CUI-ul partenerului.' });
  const cand = compensablePartners(S(req)).find((p) => String(p.cui).replace(/^ro/i, '') === cui);
  if (!cand) return res.status(400).json({ error: 'Partenerul nu are simultan creanta si datorie de compensat.' });
  const suma = round2(Math.min(Number(b.suma) > 0 ? Number(b.suma) : cand.compensabil, cand.compensabil));
  if (!(suma > 0)) return res.status(400).json({ error: 'Suma de compensat trebuie sa fie > 0.' });
  const data = b.data || new Date().toISOString().slice(0, 10);
  const firma = db.getFirma(fid) || {};
  if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) return res.status(400).json({ error: 'Perioada ' + periodOf(data) + ' este inchisa.' });
  const entry = {
    id: db.nextId('e'), firmaId: fid, data, period: periodOf(data),
    tip: 'compensare', tipNume: 'Compensare creanta/datorie (401 = 4111)',
    partener: cand.den, partenerCui: cand.cui, document: b.document || 'Compensare ' + (cand.den || cand.cui),
    explicatie: 'Compensare creanta clienti cu datorie furnizori', fileId: null, system: false,
    lines: [{ debit: '401', credit: '4111', suma, explicatie: 'Compensare ' + (cand.den || cand.cui) }],
  };
  d.entries.push(entry);
  logAudit('compensare', (cand.den || cand.cui) + ': ' + suma, { req });
  db.save();
  res.json({ ok: true, entry, compensat: suma });
});
app.get('/api/dashboard', (req, res) => {
  const v = S(req);
  // e-Factura B2B: facturile emise netrimise in SPV (termen legal 5 zile lucratoare) — alerta pe dashboard
  res.json(Object.assign(rep.dashboard(v), { efactura: decl.eFacturaNetrimise(v) }));
});
app.get('/api/cash-forecast', (req, res) => {
  const fid = activeId(req);
  const templates = (db.get().recurringInvoices || []).filter((t) => t.firmaId === fid && t.activ !== false);
  res.json(rep.cashForecast(S(req), templates, { months: Number(req.query.months) || 6, startPeriod: req.query.start || null }));
});

// ── Buget vs realizat ──
app.get('/api/budgets', (req, res) => {
  const fid = activeId(req); const year = req.query.year;
  res.json((db.get().budgets || []).filter((t) => t.firmaId === fid && (!year || String(t.an) === String(year))));
});
app.post('/api/budgets', (req, res) => {
  const b = req.body || {}; const cont = String(b.cont || '').trim();
  if (!coa.getAccount(cont)) return res.status(400).json({ error: 'Cont inexistent in plan: ' + cont });
  const an = String(b.an || new Date().getFullYear());
  const d = db.get(); const fid = activeId(req);
  const t = (d.budgets || []).find((x) => x.firmaId === fid && String(x.an) === an && x.cont === cont);
  const rec = t || { id: db.nextId('bud'), firmaId: fid, an, cont };
  rec.an = an; rec.cont = cont; rec.suma = round2(Number(b.suma) || 0);
  if (!t) d.budgets.push(rec);
  logAudit('buget.save', an + ' ' + cont + ': ' + rec.suma, { req });
  db.save();
  res.json({ ok: true, budget: rec });
});
app.delete('/api/budgets/:id', (req, res) => {
  const d = db.get(); const fid = activeId(req);
  d.budgets = (d.budgets || []).filter((t) => !(t.id === req.params.id && t.firmaId === fid));
  logAudit('buget.delete', req.params.id, { req });
  db.save();
  res.json({ ok: true });
});
app.get('/api/budget-report', (req, res) => {
  const fid = activeId(req); const year = req.query.year || String(new Date().getFullYear());
  const budgets = (db.get().budgets || []).filter((t) => t.firmaId === fid && String(t.an) === String(year));
  res.json(rep.budgetReport(S(req), budgets, year));
});

// ── Reevaluare valutara la sfarsit de perioada ──
app.get('/api/fx-reval/candidates', (req, res) => res.json(fxreval.candidates(S(req), req.query.asOf || null)));
app.post('/api/fx-reval/preview', (req, res) => {
  const b = req.body || {};
  res.json(fxreval.buildRevaluation(S(req), b.asOf || null, Array.isArray(b.items) ? b.items : []));
});
app.post('/api/fx-reval/post', (req, res) => {
  const b = req.body || {}; const fid = activeId(req); const d = db.get();
  const asOf = b.asOf || new Date().toISOString().slice(0, 10);
  const r = fxreval.buildRevaluation(S(req), asOf, Array.isArray(b.items) ? b.items : []);
  if (!r.lines.length) return res.status(400).json({ error: 'Nicio diferenta de reevaluare de inregistrat.' });
  for (const ln of r.lines) if (!coa.getAccount(ln.debit) || !coa.getAccount(ln.credit)) return res.status(400).json({ error: 'Cont inexistent: ' + ln.debit + '/' + ln.credit });
  const data = String(asOf).length === 7 ? asOf + '-28' : asOf;
  const firma = db.getFirma(fid) || {};
  if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) return res.status(400).json({ error: 'Perioada ' + periodOf(data) + ' este inchisa.' });
  const entry = {
    id: db.nextId('e'), firmaId: fid, data, period: periodOf(data),
    tip: 'reevaluare_valutara', tipNume: 'Reevaluare valutara la sfarsit de perioada',
    partener: '', document: 'Reevaluare ' + periodOf(data), explicatie: 'Diferente de curs din reevaluarea soldurilor in valuta',
    fileId: null, system: false, lines: r.lines,
  };
  d.entries.push(entry);
  logAudit('reevaluare.valutara', periodOf(data) + ': fav ' + r.totalFavorabil + ' / nefav ' + r.totalNefavorabil, { req });
  db.save();
  res.json({ ok: true, entry, totalFavorabil: r.totalFavorabil, totalNefavorabil: r.totalNefavorabil });
});
// Documente lipsa: furnizori care apareau lunar dar nu au document in luna selectata
function shiftYM(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
app.get('/api/missing-docs', (req, res) => {
  const s = S(req);
  const ym = /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : new Date().toISOString().slice(0, 7);
  const per = (e) => e.period || periodOf(e.data);
  const purchases = (s.entries || []).filter((e) => /cumparare/.test(e.tip) && e.partener);
  const prev = [1, 2, 3].map((k) => shiftYM(ym, -k));
  const seen = {}; const lastSeen = {};
  purchases.forEach((e) => {
    const m = per(e);
    if (!lastSeen[e.partener] || m > lastSeen[e.partener]) lastSeen[e.partener] = m;
    if (prev.includes(m)) { (seen[e.partener] = seen[e.partener] || new Set()).add(m); }
  });
  const thisSet = new Set(purchases.filter((e) => per(e) === ym).map((e) => e.partener));
  const missing = Object.keys(seen).filter((p) => seen[p].size >= 2 && !thisSet.has(p))
    .map((p) => ({ partener: p, luniPrezent: seen[p].size, ultimaLuna: lastSeen[p] }))
    .sort((a, b) => b.luniPrezent - a.luniPrezent);
  const countThis = thisSet.size ? purchases.filter((e) => per(e) === ym).length : 0;
  const avgPrev = Math.round((prev.reduce((acc, m) => acc + purchases.filter((e) => per(e) === m).length, 0) / 3) * 10) / 10;
  res.json({ period: ym, countThis, avgPrev, missing });
});
app.get('/api/dashboard-charts', (req, res) => {
  const v = S(req);
  const year = req.query.year || rep.dashboard(v).year;
  const ag = aging(v, null);
  res.json({ year, monthly: rep.monthlySeries(v, year), agingClienti: ag.totalClienti, agingFurnizori: ag.totalFurnizori });
});
app.get('/api/analytic', (req, res) => res.json(analyticBalance(S(req))));
app.get('/api/aging', (req, res) => res.json(aging(S(req), req.query.asOf || null)));
app.get('/pdf/aging', (req, res) => pdf.agingPdf(res, S(req).company, aging(S(req), req.query.asOf || null)));
// Provizion (ajustare) pentru deprecierea creantelor vechi (>90 zile), 6814 = 491
function computeProvizion(v, asOf, pct) {
  const ag = aging(v, asOf);
  const p = pct == null ? 100 : pct;
  const detalii = ag.clienti.filter((c) => c.b90plus > 0).map((c) => ({ partener: c.partener, cui: c.cui, vechi: c.b90plus, provizion: round2((c.b90plus * p) / 100) }));
  const base = round2(detalii.reduce((s, c) => s + c.vechi, 0));
  const necesar = round2((base * p) / 100);
  const m = acc.accumulate(acc.allLines(v.entries));
  const c491 = m['491'] || { d: 0, c: 0 };
  const existent = round2(c491.c - c491.d);
  return { asOf: ag.asOf, pct: p, base, necesar, existent, deAjustat: round2(necesar - existent), detalii };
}
app.get('/api/provizion', (req, res) => res.json(computeProvizion(S(req), req.query.asOf || null, req.query.pct ? Number(req.query.pct) : 100)));
// Scoaterea din evidenta a unei creante neincasabile: 654 = 4111 (pierdere) + reluare 491 = 7814
app.post('/api/writeoff', (req, res) => {
  const d = db.get();
  const v = S(req);
  const b = req.body || {};
  const suma = round2(Number(b.suma) || 0);
  if (!b.partener || suma <= 0) return res.status(400).json({ error: 'Completeaza partenerul si suma.' });
  const data = b.data && String(b.data).length === 10 ? b.data : new Date().toISOString().slice(0, 10);
  const period = String(data).slice(0, 7);
  const lines = [{ debit: '654', credit: '4111', suma, explicatie: 'Creanta neincasabila ' + b.partener }];
  const m = acc.accumulate(acc.allLines(v.entries));
  const c491 = m['491'] || { d: 0, c: 0 };
  const existing491 = round2(c491.c - c491.d);
  const revers = round2(Math.min(suma, existing491));
  if (revers > 0) lines.push({ debit: '491', credit: '7814', suma: revers, explicatie: 'Reluare ajustare ' + b.partener });
  d.entries.push({
    id: db.nextId('e'), firmaId: activeId(req), data, period, tip: 'scoatere_creanta', tipNume: 'Scoatere din evidenta creanta neincasabila',
    partener: b.partener, partenerCui: b.cui || '', document: 'Nota scoatere ' + period, analitic: '', explicatie: 'Creanta neincasabila ' + b.partener, fileId: null, system: true, lines,
  });
  logAudit('writeoff', b.partener + ' ' + suma, { req });
  db.save();
  res.json({ ok: true, suma, reversProvizion: revers });
});
app.post('/api/provizion', (req, res) => {
  const d = db.get();
  const b = req.body || {};
  const pct = b.pct != null ? Number(b.pct) : 100;
  const p = computeProvizion(S(req), b.asOf || null, pct);
  if (Math.abs(p.deAjustat) < 0.005) return res.json({ ok: true, message: 'Ajustarea este deja la nivelul necesar (' + p.necesar + ').', result: p });
  const data = b.asOf && String(b.asOf).length === 10 ? b.asOf : (p.asOf || new Date().toISOString().slice(0, 10));
  const period = String(data).slice(0, 7);
  const up = p.deAjustat > 0;
  const line = up
    ? { debit: '6814', credit: '491', suma: p.deAjustat, explicatie: 'Ajustare depreciere creante' }
    : { debit: '491', credit: '7814', suma: -p.deAjustat, explicatie: 'Reluare ajustare creante' };
  d.entries.push({
    id: db.nextId('e'), firmaId: activeId(req), data, period,
    tip: up ? 'provizion_creante' : 'reluare_provizion', tipNume: up ? 'Ajustare depreciere creante (6814=491)' : 'Reluare ajustare creante (491=7814)',
    partener: '', partenerCui: '', document: 'Nota ajustare ' + period, analitic: '', explicatie: line.explicatie, fileId: null, system: true, lines: [line],
  });
  logAudit('provizion', period + ' ' + p.deAjustat, { req });
  db.save();
  res.json({ ok: true, result: p });
});
app.get('/api/registru-fiscal', (req, res) => res.json(rep.registruFiscal(S(req), req.query.year || String(new Date().getFullYear()))));
app.get('/api/cashbook', (req, res) => res.json(acc.cashBankJournal(S(req), req.query.cont || '5121', req.query.period || null)));
app.get('/api/cash-valuta', (req, res) => res.json(acc.cashRegisterValuta(S(req), req.query.period || null, req.query.moneda || 'EUR')));
app.get('/api/cash-control', (req, res) => res.json(acc.cashControl(S(req), req.query.cont || '5311', req.query.period || null)));
app.get('/api/notes', (req, res) => res.json(rep.notes(S(req), req.query.year || String(new Date().getFullYear()))));

// ─────────────── Import extras bancar (CSV / MT940) ───────────────
app.post('/api/bank/parse', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
  const d = db.get();
  const text = fs.readFileSync(req.file.path, 'utf8');
  const transactions = bank.parseAndSuggest(S(req), text);
  const docId = db.nextId('doc');
  d.documents.push({ id: docId, firmaId: activeId(req), fileName: req.file.originalname, storedName: req.file.filename, uploadedAt: new Date().toISOString(), text: '' });
  db.save();
  res.json({ documentId: docId, count: transactions.length, transactions });
});
app.post('/api/bank/import', (req, res) => {
  const { transactions, fileId } = req.body || {};
  if (!Array.isArray(transactions)) return res.status(400).json({ error: 'Lipsesc tranzactiile.' });
  const d = db.get();
  const fid = activeId(req);
  let created = 0; const errors = [];
  for (const t of transactions) {
    try { const e = buildEntry(t.tip, t.fields || {}, fileId || null, fid); d.entries.push(e); upsertPartner(fid, e); created++; }
    catch (e) { errors.push(String(e.message || e)); }
  }
  db.save();
  res.json({ ok: true, created, errors });
});
app.get('/api/efactura-list', (req, res) => {
  const { period } = req.query;
  let list = S(req).entries.filter((e) => xml.isEFacturaEligible(e));
  if (period) list = list.filter((e) => (e.period || periodOf(e.data)) === period);
  res.json(acc.sortEntries(list).map((e) => ({ id: e.id, data: e.data, document: e.document, partener: e.partener, partenerCui: e.partenerCui || '' })));
});

// ───────────────────────────── ANAF SPV ─────────────────────────────
// ── Import e-Factura primita (UBL) ──
require('./src/routes/anaf')(app, { activeId, wrap, logAudit, upsertPartner, canAccess });


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

// ───────────────────────────── RAPOARTE (PDF) ─────────────────────────────
app.get('/pdf/journal', (req, res) => pdf.journalPdf(res, S(req).company, acc.journal(S(req), req.query.period || null)));
app.get('/pdf/ledger', (req, res) => pdf.ledgerPdf(res, S(req).company, acc.ledger(S(req), req.query.period || null), req.query.period || null));
app.get('/pdf/balance', (req, res) => pdf.trialBalancePdf(res, S(req).company, acc.trialBalance(S(req), req.query.period || null)));
// Situatii financiare + recapitulatii declaratii + registre (PDF/JSON): src/routes/reports.js
require('./src/routes/reports')(app, { S });
app.get('/pdf/assets', (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
  pdf.assetsRegisterPdf(res, S(req).company, assets.register(S(req), asOf), asOf);
});
app.get('/api/leasing-schedule', (req, res) => res.json(leasingSchedule(req.query.principal, req.query.months, req.query.rate, req.query.method)));
app.get('/pdf/leasing-schedule', (req, res) => pdf.leasingSchedulePdf(res, S(req).company, leasingSchedule(req.query.principal, req.query.months, req.query.rate, req.query.method)));
app.get('/pdf/asset/:id', (req, res) => {
  const a = (S(req).assets || []).find((x) => x.id === req.params.id);
  if (!a) return res.status(404).send('Mijloc fix inexistent');
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
  const asset = Object.assign({}, a, { contNume: coa.accountName(a.cont) });
  pdf.assetFisaPdf(res, S(req).company, { asset, calc: assets.compute(a, asOf), schedule: assets.schedule(a) });
});
app.get('/pdf/stocks', (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
  pdf.stocksPdf(res, S(req).company, stocks.currentStock(S(req), asOf), asOf);
});
// Situatia aprovizionarilor (receptii pe furnizori) si a consumurilor (iesiri la CMP pe cont)
app.get('/api/aprovizionari', (req, res) => res.json(stocks.situatieAprovizionari(S(req), req.query.period || null)));
app.get('/pdf/aprovizionari', (req, res) => pdf.aprovizionariPdf(res, S(req).company, stocks.situatieAprovizionari(S(req), req.query.period || null)));
app.get('/api/consumuri', (req, res) => res.json(stocks.situatieConsumuri(S(req), req.query.period || null)));
app.get('/pdf/consumuri', (req, res) => pdf.consumuriPdf(res, S(req).company, stocks.situatieConsumuri(S(req), req.query.period || null)));
app.get('/pdf/inventory', (req, res) => {
  const v = S(req);
  const g = v.gestiuni.find((x) => x.id === req.query.gestiune);
  if (!g) return res.status(400).send('Alege o gestiune');
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 7);
  pdf.inventoryListPdf(res, v.company, { gestiune: g.cod + ' — ' + g.denumire, asOf, lines: stocks.inventoryList(v, g.id, asOf) });
});
app.get('/pdf/inventory-pv/:id', (req, res) => {
  const iv = (S(req).inventories || []).find((x) => x.id === req.params.id);
  if (!iv) return res.status(404).send('Proces-verbal inexistent');
  pdf.inventoryPvPdf(res, S(req).company, iv);
});
// numerotare secventiala a documentelor de stoc (serie + numar), per firma si tip
function ensureDocSeries(d, fid) {
  d.settings.docSeries = d.settings.docSeries || {};
  if (!d.settings.docSeries[fid]) d.settings.docSeries[fid] = { NIR: { serie: 'NIR', next: 1 }, BC: { serie: 'BC', next: 1 }, AVIZ: { serie: 'AVZ', next: 1 } };
  const s = d.settings.docSeries[fid];
  if (!s.CH) s.CH = { serie: 'CH', next: 1 }; // chitante (serie adaugata ulterior — migrare in-loc)
  return s;
}
// Atribuie (sau reutilizeaza) numarul de document pentru un grup de miscari
function docNumberFor(req, type, movs) {
  const d = db.get();
  const fid = activeId(req);
  const existing = movs.map((m) => m.docNr && m.docNr[type]).find(Boolean);
  if (existing) return existing;
  const s = ensureDocSeries(d, fid)[type];
  const nr = s.serie + '-' + String(s.next).padStart(5, '0');
  s.next += 1;
  for (const m of movs) { m.docNr = m.docNr || {}; m.docNr[type] = nr; }
  db.save();
  return nr;
}

app.get('/api/doc-series', (req, res) => res.json(ensureDocSeries(db.get(), activeId(req))));
app.post('/api/doc-series', (req, res) => {
  const d = db.get();
  const s = ensureDocSeries(d, activeId(req));
  const b = req.body || {};
  for (const t of ['NIR', 'BC', 'AVIZ', 'CH']) {
    if (b[t]) {
      if (b[t].serie != null) s[t].serie = String(b[t].serie).slice(0, 10);
      if (b[t].next != null && Number(b[t].next) > 0) s[t].next = Math.floor(Number(b[t].next));
    }
  }
  db.save();
  res.json({ ok: true, series: s });
});

// Registrul documentelor de stoc emise (numerotate): NIR / bon de consum / aviz
function buildDocRegister(v) {
  const byProd = new Map(v.products.map((p) => [p.id, p]));
  const gById = new Map(v.gestiuni.map((g) => [g.id, g]));
  const TYPE_LABEL = { NIR: 'NIR (receptie)', BC: 'Bon de consum', AVIZ: 'Aviz insotire' };
  const groups = new Map();
  for (const m of v.stockMovements) {
    if (!m.docNr) continue;
    const p = byProd.get(m.productId) || {};
    const val = m.tip === 'receptie' ? Math.round(m.cantitate * m.pretUnitar * 100) / 100 : Math.round(stocks.movementValue(p, v.stockMovements, m.id) * 100) / 100;
    for (const [type, nr] of Object.entries(m.docNr)) {
      const key = type + '|' + nr;
      if (!groups.has(key)) {
        const g = gById.get(m.gestiuneId);
        groups.set(key, { type, tip: TYPE_LABEL[type] || type, serieNr: nr, data: m.data, gestiune: g ? g.cod : '', document: m.document || '', operator: m.operator || '', valoare: 0, nrLinii: 0 });
      }
      const grp = groups.get(key);
      grp.valoare = Math.round((grp.valoare + val) * 100) / 100;
      grp.nrLinii += 1;
      if (m.data < grp.data) grp.data = m.data;
    }
  }
  return [...groups.values()].sort((a, b) => (a.type === b.type ? (a.serieNr < b.serieNr ? -1 : 1) : a.type < b.type ? -1 : 1));
}
app.get('/api/doc-register', (req, res) => res.json(buildDocRegister(S(req))));
app.get('/pdf/doc-register', (req, res) => pdf.docRegisterPdf(res, S(req).company, buildDocRegister(S(req))));

app.get('/pdf/nir', (req, res) => {
  const v = S(req);
  const byId = new Map(v.products.map((p) => [p.id, p]));
  const gById = new Map(v.gestiuni.map((g) => [g.id, g]));
  const recs = stocks.sortMov(v.stockMovements.filter((m) => m.tip === 'receptie'
    && (req.query.document ? m.document === req.query.document : m.id === req.query.id)
    && (!req.query.gestiune || m.gestiuneId === req.query.gestiune)));
  if (!recs.length) return res.status(404).send('Receptie inexistenta');
  const g = gById.get(recs[0].gestiuneId);
  const lines = recs.map((m) => {
    const p = byId.get(m.productId) || {};
    return { cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc', cantitate: m.cantitate, pret: m.pretUnitar, valoare: Math.round(m.cantitate * m.pretUnitar * 100) / 100 };
  });
  pdf.nirPdf(res, v.company, {
    serieNr: docNumberFor(req, 'NIR', recs),
    document: recs[0].document, furnizor: recs[0].furnizor || '', gestiune: g ? g.cod + ' — ' + g.denumire : '',
    data: recs[0].data, operator: recs[0].operator || '', lines, total: lines.reduce((s, l) => s + l.valoare, 0),
  });
});
app.get('/pdf/bon-consum', (req, res) => {
  const v = S(req);
  const byId = new Map(v.products.map((p) => [p.id, p]));
  const gById = new Map(v.gestiuni.map((g) => [g.id, g]));
  const isd = stocks.sortMov(v.stockMovements.filter((m) => m.tip === 'iesire'
    && (req.query.document ? m.document === req.query.document : m.id === req.query.id)
    && (!req.query.gestiune || m.gestiuneId === req.query.gestiune)));
  if (!isd.length) return res.status(404).send('Iesire inexistenta');
  const g = gById.get(isd[0].gestiuneId);
  const lines = isd.map((m) => {
    const p = byId.get(m.productId) || {};
    const valoare = round2(stocks.movementValue(p, v.stockMovements, m.id)); // valoare la CMP
    const cmp = m.cantitate > 0 ? round2(valoare / m.cantitate) : 0;
    return { cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc', cantitate: m.cantitate, cmp, valoare };
  });
  pdf.bonConsumPdf(res, v.company, {
    serieNr: docNumberFor(req, 'BC', isd),
    document: isd[0].document, gestiune: g ? g.cod + ' — ' + g.denumire : '',
    data: isd[0].data, operator: isd[0].operator || '', lines, total: lines.reduce((s, l) => s + l.valoare, 0),
  });
});
app.get('/pdf/aviz', (req, res) => {
  const v = S(req);
  const byId = new Map(v.products.map((p) => [p.id, p]));
  const gById = new Map(v.gestiuni.map((g) => [g.id, g]));
  const trs = stocks.sortMov(v.stockMovements.filter((m) => m.tip === 'transfer'
    && (req.query.document ? m.document === req.query.document : m.id === req.query.id)));
  if (!trs.length) return res.status(404).send('Transfer inexistent');
  const src = gById.get(trs[0].gestiuneId); const dst = gById.get(trs[0].gestiuneDestId);
  const nm = (g) => g ? (v.company.nume || '') + ' — gestiune ' + g.cod + ' ' + g.denumire : '';
  const lines = trs.map((m) => {
    const p = byId.get(m.productId) || {};
    const valoare = round2(stocks.movementValue(p, v.stockMovements, m.id)); // valoare la CMP-ul sursei
    const cmp = m.cantitate > 0 ? round2(valoare / m.cantitate) : 0;
    return { cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc', cantitate: m.cantitate, cmp, valoare };
  });
  pdf.avizPdf(res, v.company, {
    serieNr: docNumberFor(req, 'AVIZ', trs),
    document: trs[0].document, expeditor: nm(src), destinatar: nm(dst),
    data: trs[0].data, operator: trs[0].operator || '', lines, total: lines.reduce((s, l) => s + l.valoare, 0),
  });
});
app.get('/pdf/stock-ledger/:id', (req, res) => {
  const v = S(req);
  const p = v.products.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).send('Produs inexistent');
  pdf.stockLedgerPdf(res, v.company, stocks.productLedger(p, v.stockMovements, req.query.asOf || null, req.query.gestiune || null));
});
app.get('/pdf/note/:id', (req, res) => {
  const e = db.get().entries.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).send('Nota inexistenta');
  const fid = e.firmaId || db.firmaActiva();
  if (!canAccess(req, fid)) return res.status(404).send('Nota inexistenta'); // izolare multi-firma
  const nr = acc.journalNr(db.scoped(fid), e.id);
  pdf.notePdf(res, db.getFirma(fid) || {}, Object.assign({ nrJurnal: nr }, e));
});

// ───────── Reset zilnic al contului demo (din snapshot-ul data/demo-firma.json) ─────────
const DEMO_SNAPSHOT = path.join(db.DATA_DIR, 'demo-firma.json');
function resetDemo() {
  const d = db.get();
  const demo = d.users.find((u) => u.username === 'demo');
  const fid = demo && (demo.firme || [])[0];
  if (!fid || !fs.existsSync(DEMO_SNAPSHOT)) return { ok: false, reason: 'fara demo sau snapshot' };
  const bundle = JSON.parse(fs.readFileSync(DEMO_SNAPSHOT, 'utf8'));
  const keepActive = d.firmaActiva; // importFirma muta firma activa — o pastram
  db.importFirma(bundle, { targetFid: fid });
  d.firmaActiva = keepActive;
  // igiena pe utilizatorul demo: contorul AI, datele personale, conversatiile de suport
  delete demo.aiUsage; delete demo.profil; demo.email = '';
  d.messages = (d.messages || []).filter((m) => m.userId !== demo.id);
  db.save();
  return { ok: true, firmaId: fid };
}
app.post('/api/demo/reset', requireAdmin, (req, res) => {
  const r = resetDemo();
  logAudit('demo.reset', r.ok ? 'resetat manual' : r.reason, { req, firmaId: null });
  res.json(r);
});
// Regenereaza snapshot-ul din starea CURENTA a firmei demo (dupa o curatare manuala).
app.post('/api/demo/snapshot', requireAdmin, (req, res) => {
  const demo = db.get().users.find((u) => u.username === 'demo');
  const fid = demo && (demo.firme || [])[0];
  if (!fid) return res.status(400).json({ error: 'Nu exista firma demo.' });
  fs.writeFileSync(DEMO_SNAPSHOT, JSON.stringify(db.exportFirma(fid)));
  logAudit('demo.snapshot', 'snapshot demo regenerat', { req, firmaId: null });
  res.json({ ok: true });
});

app.post('/api/seed', requireAdmin, (req, res) => {
  const r = seed();
  res.json({ ok: true, message: 'Exemplu incarcat: ' + r.entries + ' inregistrari pentru ' + r.period + '.' });
});

const os = require('os');
// Backup automat zilnic (daca e activat)
setInterval(() => {
  const s = db.get().settings.backup || {};
  if (s.auto === false) return;
  const last = s.lastAt ? Date.parse(s.lastAt) : 0;
  if (Date.now() - last >= 24 * 3600 * 1000) {
    try { const r = doBackup(); console.log('Backup automat:', r.name); } catch (e) { console.error('Backup:', e.message); }
  }
}, 3600 * 1000); // verifica din ora in ora

// Digest zilnic cu termenele fiscale: o singura data pe zi, dupa ora 07:00 (ora serverului)
setInterval(() => {
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
setInterval(() => {
  const d = db.get();
  const today = new Date().toISOString().slice(0, 10);
  const s = d.settings.demoReset || (d.settings.demoReset = {});
  if (s.lastDate === today || new Date().getHours() < 4) return;
  s.lastDate = today;
  try { const r = resetDemo(); if (r.ok) console.log('Demo resetat din snapshot.'); db.save(); }
  catch (e) { console.error('Demo reset:', e.message); }
}, 15 * 60 * 1000);

// Igiena rate-limit: fara curatare, map-urile ar creste nelimitat (cate o intrare per IP esuat)
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of loginAttempts) { if (r.until < now) loginAttempts.delete(k); }
  for (const [k, r] of registerAttempts) { if (r.reset < now) registerAttempts.delete(k); }
}, 3600 * 1000);

// Job periodic: descarca automat recipisele (doar daca e activat si conectat)
setInterval(() => {
  const c = db.get().settings.anaf || {};
  if (c.autoPoll && anaf.connected(c)) {
    pollSpv().then((r) => { if (r.downloaded) console.log('Auto-poll SPV: ' + r.downloaded + ' recipise descarcate'); })
      .catch((e) => console.error('Auto-poll SPV:', e.message || e));
  }
}, 15 * 60 * 1000);

// Alerta pe email cand se aduna erori de server: >=5 erori 5xx in 15 minute -> un email pe ora.
const err5xx = [];
let lastErrAlert = 0;
function trackServerError(req, err) {
  const now = Date.now();
  err5xx.push({ t: now, m: req.method + ' ' + req.originalUrl + ': ' + String((err && err.message) || err).slice(0, 160) });
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
  if (status >= 500) { console.error('[eroare]', req.method, req.originalUrl, '-', (err && err.stack) || err); trackServerError(req, err); }
  const msg = status < 500 && err && err.message ? err.message : 'A aparut o eroare interna. Incearca din nou.';
  res.status(status).json({ error: msg });
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
const server = app.listen(PORT, HOST, () => {
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

// Oprire curata (pm2 restart/stop trimite SIGINT): scrie oglinda JSON in asteptare,
// inchide SQLite si opreste ascultarea; plasa de siguranta de 3s daca ceva atarna.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { db.flushMirror(); } catch (_) { /* ignora */ }
  if (db.DRIVER === 'sqlite') { try { require('./src/store').close(); } catch (_) { /* ignora */ } }
  releaseDbLock();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, buildEntry, upsertPartner };
