'use strict';

// Nucleul de autentificare si cont, scos din server.js: login (parola + 2FA + dispozitive de
// incredere), contul demo public, inscrierea de firme, logout, resetarea parolei pe email,
// impersonarea (admin), /api/me si /api/meta, plus health/metrics/audit. Modul de rute in stilul
// src/routes/*: register(app, ctx) — modulele simple sunt require-uite direct, prin ctx vin doar
// helper-ele legate de starea aplicatiei (logAudit, wrap, requireAdmin, activeId, S).
// Intoarce map-urile de rate-limit, ca jobul rate-limit-hygiene din server.js sa le curete.

const crypto = require('crypto');
const db = require('./db');
const coa = require('./chartOfAccounts');
const { typesForClient } = require('./documentTypes');
const ai = require('./aiExtractor');
const fiscal = require('./fiscal');
const authlib = require('./auth');
const totp = require('./totp');
const messages = require('./messages');
const plans = require('./plans');
const billing = require('./billing');
const metrics = require('./metrics');
const { sendMail, sendNotifMail } = require('./notify');
const { sendList } = require('./paginate');
const { toCsv } = require('./csv');
const { currentUser, allowedFirme, publicUser, startSession, setTrustedDevice, deviceTrusted, isLocked, bumpFail, clearFails, attemptKey } = require('./session');
const { period: periodOf } = require('./util');

module.exports = function registerAuthRoutes(app, ctx) {
  const { logAudit, wrap, requireAdmin, activeId, S } = ctx;

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

  // Health-check public (pentru monitorizare uptime): confirma ca procesul si baza raspund.
  // PUBLIC si minimal INTENTIONAT: diagnosticele de proces (memorie, versiune Node, driver, PID)
  // sunt in /api/metrics, DOAR pentru admin — pe un endpoint neautentificat ar insemna
  // fingerprinting gratuit al serverului.
  app.get('/api/health', (req, res) => {
    try {
      const d = db.get();
      res.json({ ok: true, ts: new Date().toISOString(), uptimeSec: Math.round(process.uptime()), firme: (d.firme || []).length });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'db', ts: new Date().toISOString(), uptimeSec: Math.round(process.uptime()) });
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
  app.post('/api/register', async (req, res) => {
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
    const breachErr = await authlib.breachCheck(password); // HIBP (fail-open), inainte de a crea firma+user
    if (breachErr) return res.status(400).json({ error: breachErr });
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

  app.post('/api/logout', (req, res) => {
    const u = currentUser(req);
    if (u && req._sessId) { u.sessions = (u.sessions || []).filter((s) => s.id !== req._sessId); db.save(); }
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    res.json({ ok: true });
  });

  // Implicit: ultimele 300 (deja marginit — fara risc OOM). Cu ?limit/?offset se pagineaza in
  // istoric (peste cele 300), pe lista in ordine descrescatoare (cele mai recente primele).
  const auditList = (req, fid) => (db.get().audit || []).filter((a) => (fid === null ? a.firmaId == null : a.firmaId === fid)).reverse();
  app.get('/api/audit', (req, res) => {
    const list = auditList(req, activeId(req)); // activeId e mereu o firma la care userul are acces
    if (req.query.limit != null && req.query.limit !== '') return sendList(req, res, list, { label: '/api/audit' });
    res.json(list.slice(0, 300));
  });
  // Jurnal de sistem (global): actiuni fara firma — utilizatori, firme, impersonare, mesaje, backup, 2FA, sesiuni.
  app.get('/api/audit/system', requireAdmin, (req, res) => {
    const list = auditList(req, null);
    if (req.query.limit != null && req.query.limit !== '') return sendList(req, res, list, { label: '/api/audit/system' });
    res.json(list.slice(0, 300));
  });
  // Export CSV al jurnalului de audit (arhiva / control intern / GDPR): TOT ce e retinut (plafon
  // 3000 in memorie), nu doar cele 300 afisate. Firma curenta pt oricine; sistemul doar admin.
  function auditCsv(res, list, filename) {
    const rows = list.map((a) => [a.ts, a.username || '', a.action, a.detail || '', a.viaAdmin || '']);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(toCsv(['Data (UTC)', 'Utilizator', 'Actiune', 'Detaliu', 'Prin admin'], rows));
  }
  app.get('/csv/audit', (req, res) => auditCsv(res, auditList(req, activeId(req)), 'audit-firma.csv'));
  app.get('/csv/audit/system', requireAdmin, (req, res) => auditCsv(res, auditList(req, null), 'audit-sistem.csv'));

  // Metrici de performanta pe ruta (in-memory, de la ultimul restart): candidatii la optimizare
  // primii. Include si diagnosticele de proces (memorie, Node, driver) — DOAR pentru admin.
  app.get('/api/metrics', requireAdmin, (req, res) => {
    const d = db.get();
    const mem = process.memoryUsage();
    const mb = (b) => Math.round((b / (1024 * 1024)) * 100) / 100;
    // starea job-urilor: tick/rezultat/eroare din memorie + ultima rulare REUSITA din settings
    // (aceea supravietuieste restartului — backup/digest/demo-reset si-o noteaza in db)
    const jobs = metrics.jobsSnapshot();
    const put = (label, k, v) => { if (v) (jobs[label] = jobs[label] || {})[k] = v; };
    put('backup', 'lastDoneAt', (d.settings.backup || {}).lastAt);
    put('digest-termene', 'lastDoneDate', (d.settings.deadlineDigest || {}).lastDate);
    put('demo-reset', 'lastDoneDate', (d.settings.demoReset || {}).lastDate);
    // Distributia incarcarii PE FIRMA (o singura trecere): axa reala de crestere a acestei aplicatii
    // e volumul per firma (firmele sunt deja izolate prin firmaId/scoped). `maxEntries` e semnalul
    // care ar declansa partitionarea pe instante — vezi docs/scalare-crestere.md pentru praguri.
    const perFirma = new Map();
    for (const e of (d.entries || [])) perFirma.set(e.firmaId, (perFirma.get(e.firmaId) || { entries: 0, documents: 0 }));
    for (const e of (d.entries || [])) perFirma.get(e.firmaId).entries += 1;
    for (const x of (d.documents || [])) { const f = perFirma.get(x.firmaId) || { entries: 0, documents: 0 }; f.documents += 1; perFirma.set(x.firmaId, f); }
    const nume = new Map((d.firme || []).map((f) => [f.id, f.nume]));
    const topFirme = [...perFirma.entries()]
      .map(([id, s]) => ({ id, nume: nume.get(id) || String(id), entries: s.entries, documents: s.documents }))
      .sort((a, b) => b.entries - a.entries).slice(0, 10);
    res.json(Object.assign(metrics.snapshot(), {
      jobs,
      process: {
        nodeVersion: process.version, pid: process.pid, driver: db.DRIVER,
        uptimeSec: Math.round(process.uptime()), firme: (d.firme || []).length, users: (d.users || []).length,
        memoryRssMb: mb(mem.rss), memoryHeapUsedMb: mb(mem.heapUsed), memoryHeapTotalMb: mb(mem.heapTotal),
      },
      firmeLoad: { maxEntries: topFirme.length ? topFirme[0].entries : 0, top: topFirme },
    }));
  });

  app.get('/api/me', (req, res) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'Neautentificat' });
    res.json(withSessionState(req, u));
  });

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

  // ───────────────────────── RESETARE PAROLA (email) ─────────────────────────
  // Rate limit pe IP (5/ora): ruta e publica si trimite email — fara plafon ar fi un vector de
  // spam catre utilizator si de consum al cotei de email. Peste plafon raspundem tot generic
  // (fara enumerare de conturi), doar nu mai trimitem.
  const forgotAttempts = new Map();
  app.post('/api/forgot-password', wrap(async (req, res) => {
    const login = String((req.body || {}).login || '').trim().toLowerCase();
    const d = db.get();
    const u = d.users.find((x) => !x.pending && (x.username.toLowerCase() === login || (x.email && x.email.toLowerCase() === login)));
    // raspuns identic indiferent daca exista (sa nu dezvaluim conturile)
    const generic = { ok: true, message: 'Daca exista un cont cu adresa de email setata, vei primi un link de resetare.' };
    const k = attemptKey(req); const now = Date.now();
    let fa = forgotAttempts.get(k);
    if (!fa || now > fa.reset) fa = { count: 0, reset: now + 3600 * 1000 };
    fa.count += 1; forgotAttempts.set(k, fa);
    if (fa.count > 5) return res.json(generic);
    if (!u || !u.email || !(d.settings.smtp && d.settings.smtp.host)) return res.json(generic);
    u.resetToken = crypto.randomBytes(24).toString('hex');
    u.resetExp = Date.now() + 3600 * 1000; // 1 ora
    db.save();
    const link = (req.protocol || 'http') + '://' + req.get('host') + '/?reset=' + u.resetToken;
    try { await sendMail(d.settings.smtp, u.email, 'Resetare parola Contabo', 'Reseteaza-ti parola (valabil 1 ora):\n' + link); } catch (e) { console.error('SMTP reset:', e.message); }
    res.json(generic);
  }));
  function findReset(token) {
    // comparatie in timp constant: tokenul vine din URL, egalitatea `===` s-ar scurta la primul
    // octet diferit (teoretic masurabil). Lungimea se verifica intai (timingSafeEqual o cere egala).
    const t = Buffer.from(String(token || ''));
    const u = db.get().users.find((x) => {
      if (!x.resetToken) return false;
      const a = Buffer.from(String(x.resetToken));
      return a.length === t.length && crypto.timingSafeEqual(a, t);
    });
    if (!u || (u.resetExp && u.resetExp < Date.now())) return null;
    return u;
  }
  app.get('/api/reset/:token', (req, res) => {
    const u = findReset(req.params.token);
    if (!u) return res.status(404).json({ error: 'Link de resetare invalid sau expirat.' });
    res.json({ username: u.username });
  });
  app.post('/api/reset/accept', async (req, res) => {
    const { token, password } = req.body || {};
    const u = findReset(token);
    if (!u) return res.status(404).json({ error: 'Link de resetare invalid sau expirat.' });
    const pwErr = authlib.validatePassword(password, { username: u.username });
    if (pwErr) return res.status(400).json({ error: pwErr });
    const breachErr = await authlib.breachCheck(password);
    if (breachErr) return res.status(400).json({ error: breachErr });
    const h = authlib.hashPassword(password);
    u.salt = h.salt; u.hash = h.hash; u.mustChange = false; delete u.resetToken; delete u.resetExp;
    u.sessions = []; // resetarea parolei deconecteaza celelalte sesiuni
    startSession(req, res, u);
    logAudit('password.reset', u.username, { userId: u.id, username: u.username, firmaId: null });
    db.save();
    res.json({ ok: true, user: publicUser(u) });
  });

  // ───────────────────────────── META ─────────────────────────────
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

  return { registerAttempts, forgotAttempts };
};
