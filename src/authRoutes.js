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
const legal = require('./legalCompliance');
const fiscal = require('./fiscal');
const authlib = require('./auth');
const accountSvc = require('./accountService');
const messages = require('./messages');
const collaboration = require('./collaborationService');
const plans = require('./plans');
const identitate = require('./identitate');
const registruAnaf = require('./anafRegistru');
const firmeSvc = require('./firmeService');
const billing = require('./billing');
const metrics = require('./metrics');
const log = require('./log');
const cache = require('./cache');
const { sendMail, sendNotifMail } = require('./notify');
const { sendList } = require('./paginate');
const { toCsv } = require('./csv');
const { currentUser, allowedFirme, publicUser, startSession, setTrustedDevice, deviceTrusted, isLocked, bumpFail, clearFails, attemptKey } = require('./session');
const { period: periodOf } = require('./util');
const csrfLib = require('./csrf');
const sessionLib = require('./session');
const auditLog = require('./auditLog');
const globalChain = require('./globalChain');
const adminBootstrap = require('./adminBootstrap');
const stepUp = require('./stepUp');
const commercialFunnel = require('./commercialFunnel');

module.exports = function registerAuthRoutes(app, ctx) {
  const { logAudit, wrap, requireAdmin, activeId, S } = ctx;

  // Prima instalare: endpoint intentionat public, dar acceptat numai DIRECT pe loopback.
  // Un reverse proxy local are tot o conexiune loopback spre Node, de aceea verificam cumulativ
  // socketul, Host-ul si absenta antetelor Forwarded; domeniul public nu poate folosi tokenul.
  app.post('/api/bootstrap/initialize', wrap(async (req, res) => {
    if (!adminBootstrap.localDirectRequest(req)) {
      return res.status(403).json({ error: 'Inițializarea administratorului este disponibilă numai prin conexiune locală directă.' });
    }
    const d = db.get(); const body = req.body || {};
    const admin = adminBootstrap.pendingAdmin(d);
    if (!admin || !adminBootstrap.matches(d, body.token)) {
      return res.status(401).json({ error: 'Tokenul de inițializare este invalid sau a expirat.' });
    }
    const password = String(body.password || '');
    const pwErr = authlib.validatePassword(password, { username: admin.username });
    if (pwErr) return res.status(400).json({ error: pwErr });
    const breachErr = await authlib.breachCheck(password);
    if (breachErr) return res.status(400).json({ error: breachErr });
    const h = await authlib.hashPasswordAsync(password);
    // Tokenul se consuma numai dupa toate verificarile si calculul hash-ului; un esec temporar
    // de retea la HIBP nu poate lasa instalarea fara calea de initializare.
    admin.salt = h.salt; admin.hash = h.hash; admin.bootstrapPending = false; admin.mustChange = false;
    adminBootstrap.consume(d);
    startSession(req, res, admin); req.user = admin; req.realUser = admin;
    logAudit('admin.bootstrap', 'contul administrator a fost inițializat local; urmează înrolarea 2FA', {
      req, userId: admin.id, username: admin.username, firmaId: null,
    });
    db.save();
    return res.json({ ok: true, user: withSessionState(req, admin) });
  }));

  // Imbogateste obiectul public al utilizatorului cu starea de impersonare si mesajele necitite.
  function withSessionState(req, u) {
    const out = publicUser(u);
    // Token-ul CSRF calatoreste in raspunsul de identitate: clientul il citeste o data, la pornire,
    // si il trimite inapoi in antetul X-CSRF-Token la fiecare cerere mutanta. Un site strain nu-l
    // poate citi (same-origin), deci nu poate compune cererea.
    out.csrf = csrfLib.tokenFor(req._sessId, sessionLib.csrfSecret());
    if (req.impersonating && req.realUser) {
      const c = req.impersonationContext || {};
      out.impersonating = { adminId: req.realUser.id, adminName: req.realUser.username,
        reason: c.reason || '', ticket: c.ticket || '', expiresAt: c.expiresAt || null };
    }
    const d = db.get();
    out.unreadMessages = (u.role === 'admin' && !req.impersonating)
      ? messages.unreadForAdmin(d.messages || [])
      : messages.unreadForUser(d.messages || [], u.id);
    out.unreadCollaboration = (u.role === 'admin' && !req.impersonating) ? 0 : collaboration.unreadForUser(u);
    // Billing per-firma: starea abonamentului FIRMEI active + semnalul de read-only pentru banner.
    if (u.role !== 'admin') {
      // `activeId(req)` citeste req.user — dar /api/me e in PUBLIC_PATHS, deci middleware-ul de
      // autentificare NU l-a pus, iar activeId cadea pe ramura de admin: prima firma din TOATA
      // baza. Adica /api/me raporta abonamentul firmei ALTCUIVA (pe aceasta instalare, firma #1).
      // Se calculeaza pe utilizatorul primit ca argument, singurul de incredere aici.
      const f = db.getFirma(activeId({ user: u, query: req.query || {} }));
      out.firmaSub = plans.firmaStatus(f);
      // „N-am nicio firma" NU e „mi-a expirat proba". `firmaLocked(null)` e true — corect pentru
      // paywall (fara firma nu ai unde scrie), dar ca mesaj era fals si descurajant: un contabil
      // proaspat inscris ateriza pe bannerul rosu „perioada de proba a expirat" si pe ecranul de
      // preturi, desi n-avea nicio proba si n-avea ce sa aboneze. Cele doua stari se despart aici.
      out.faraFirma = !f;
      out.subExpirat = !!f && plans.firmaLocked(f);
    }
    return out;
  }

  // Health-check public (pentru monitorizare uptime): confirma ca procesul si baza raspund.
  // PUBLIC si minimal INTENTIONAT: diagnosticele de proces (memorie, versiune Node, driver, PID)
  // sunt in /api/metrics, DOAR pentru admin — pe un endpoint neautentificat ar insemna
  // fingerprinting gratuit al serverului.
  app.get('/api/health', (req, res) => {
    try {
      db.get(); // sonda confirma si accesul la starea persistenta, fara a divulga cardinalitati
      res.json({ ok: true, ts: new Date().toISOString(), uptimeSec: Math.round(process.uptime()) });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'db', ts: new Date().toISOString(), uptimeSec: Math.round(process.uptime()) });
    }
  });

  // Handler ASINCRON deliberat: scrypt costa ~30 ms si in forma sincrona acelea sunt 30 ms in care
  // nu se serveste NICIO alta cerere (un singur proces). Vezi authlib.verifyUserPasswordAsync.
  app.post('/api/login', async (req, res) => {
    const mins = isLocked(req);
    if (mins) return res.status(429).json({ error: 'Prea multe incercari esuate. Reincearca peste ~' + mins + ' min.' });
    const { username, password, code, remember } = req.body || {};
    const d = db.get();
    const u = d.users.find((x) => x.username === username);
    // Costul verificarii NU are voie sa depinde de existenta contului — vezi verifyUserPassword.
    // Contul in ASTEPTARE (invitat, neacceptat inca) merge pe aceeasi ramura de momeala: lasat ca
    // `u.pending || …` ar fi scurtcircuitat inaintea lui scrypt si ar fi reintrodus diferenta,
    // deosebind un invitat de un nume liber. Dincolo de linia asta `u` e sigur activ.
    // Incercarile ESUATE se consemneaza, cu IP-ul: ele sunt semnalul de securitate propriu-zis
    // (panoul de administrare le arata separat). Se retine numele INCERCAT — util cand cineva bate
    // la usa cu „admin" — dar NICIODATA parola, nici macar trunchiata. `userId` ramane gol cand
    // contul nu exista, ca sa nu para ca a existat.
    const esec = (motiv) => logAudit('login.failed', motiv, {
      req, userId: (u && u.id) || null, username: String(username || '').slice(0, 60), firmaId: null,
    });
    if (!await authlib.verifyUserPasswordAsync(u && !u.pending && !u.bootstrapPending ? u : null, password)) {
      bumpFail(req); esec('utilizator sau parola gresita'); db.save();
      return res.status(401).json({ error: 'Utilizator sau parola gresita.' });
    }
    let rememberDevice = false;
    if (u.twofa && !deviceTrusted(req, u)) {
      if (!code) return res.json({ twofa: true }); // parola corecta, mai trebuie codul
      const factor = accountSvc.verifySecondFactor(u, code);
      if (!factor.ok) {
        bumpFail(req); esec('cod 2FA gresit'); db.save();
        return res.status(401).json({ error: 'Cod TOTP sau cod de rezerva gresit.', twofa: true });
      }
      // Un cod de rezerva este pentru recuperare punctuala, nu pentru a transforma automat
      // dispozitivul pe care a fost introdus intr-unul de incredere timp de 30 de zile.
      rememberDevice = !!remember && !factor.recovery;
      if (factor.recovery) logAudit('2fa.recovery_used', 'cod de rezerva consumat la autentificare', {
        req, userId: u.id, username: u.username, firmaId: null,
      });
    }
    clearFails(req);
    startSession(req, res, u); // creeaza sesiune + cookie sid
    if (rememberDevice) setTrustedDevice(req, res, u); // append (tfd) DUPA setSession
    logAudit('login', 'autentificare', { req, userId: u.id, username: u.username, firmaId: u.firmaActiva || null });
    db.save();
    req.user = u; // pentru withSessionState (starea abonamentului firmei active)
    res.json({ ok: true, user: withSessionState(req, u) });
  });

  // Intrare in contul demo cu un click (public) — doar contul „demo", fara parola in client.
  app.post('/api/demo-login', (req, res) => {
    const d = db.get();
    // as='contabil' -> contul demo-contabil (contabilul); implicit -> demo (patronul)
    const uname = (req.body || {}).as === 'contabil' ? 'demo-contabil' : 'demo';
    const u = d.users.find((x) => x.username === uname);
    if (!u) return res.status(404).json({ error: 'Contul ' + (uname === 'demo-contabil' ? 'demo-contabil' : 'demo') + ' nu este disponibil momentan.' });
    startSession(req, res, u);
    // O pornire reusita, nu un click in interfata: un client care esueaza nu umfla etapa demo.
    commercialFunnel.record(d, 'demo');
    logAudit('login', 'cont ' + uname + ' (public)', { req, userId: u.id, username: u.username, firmaId: u.firmaActiva || null });
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
    // DOUA feluri de cont, fiindca oamenii intra in aplicatie din doua directii:
    //   patron   — vine cu firma lui, deci contul si firma se creeaza deodata (ca pana acum);
    //   contabil — vine sa tina contabilitatea ALTORA, deci nu are ce firma sa inscrie. Contul se
    //              creeaza gol, iar firmele vin dupa: fie cere el acces dupa CUI, fie il cheama un
    //              patron din lista de contabili. A-l obliga sa inventeze o firma la inscriere ar
    //              fi produs exact dublurile impotriva carora e construita poarta pe CUI.
    const contabilFaraFirma = String(b.tipCont || '') === 'contabil';
    const nume = String(b.nume || '').trim();
    const username = authlib.normalizeUsername(b.username);
    const password = String(b.password || '');
    const email = String(b.email || '').trim().toLowerCase();
    if (!contabilFaraFirma && !nume) return res.status(400).json({ error: 'Completeaza denumirea firmei.' });
    const userErr = authlib.validateUsername(username);
    if (userErr) return res.status(400).json({ error: userErr });
    const pwErr = authlib.validatePassword(password, { username });
    if (pwErr) return res.status(400).json({ error: pwErr });
    if (!email) return res.status(400).json({ error: 'Completeaza emailul — este necesar pentru recuperarea contului.' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresa de email nu este valida.' });
    const breachErr = await authlib.breachCheck(password); // HIBP (fail-open), inainte de a crea firma+user
    if (breachErr) return res.status(400).json({ error: breachErr });
    if (authlib.usernameTaken(d.users, username)) return res.status(400).json({ error: 'Acest utilizator exista deja. Alege altul.' });
    if (d.users.some((u) => String(u.email || '').trim().toLowerCase() === email)) return res.status(400).json({ error: 'Exista deja un cont cu acest email.' });
    // TVA este o decizie fiscala, nu o valoare implicita potrivita pentru orice firma. Formularul
    // cere Da/Nu explicit (si poate propune raspunsul din ANAF dupa CUI); API-ul pastreaza aceeasi
    // garantie, ca un client vechi sau un POST direct sa nu creeze tacut o firma platitoare.
    if (!contabilFaraFirma && typeof b.tvaPlatitor !== 'boolean') return res.status(400).json({ error: 'Alege explicit daca firma este platitoare de TVA.' });
    // CUI-ul ramane OPTIONAL la inscriere (nu rupem intrarea in aplicatie), dar daca e dat trebuie
    // sa fie valid si liber: altfel inscrierea ar fi portita prin care se creeaza a doua evidenta
    // pentru o firma existenta, ocolind poarta din createFirma.
    const cuiNou = contabilFaraFirma ? '' : String(b.cui || '').trim();
    if (cuiNou) {
      if (!identitate.validCUI(cuiNou)) return res.status(400).json({ error: 'CUI invalid — cifra de control nu se potriveste. Lasa campul gol daca nu il stii acum.' });
      if (firmeSvc.firmaDupaCui(cuiNou)) return res.status(409).json({ error: firmeSvc.CUI_DUPLICAT });
    }
    // Acceptarea este un ACT, nu o fraza dedusa din „ai folosit site-ul”. Serverul inregistreaza
    // versiunile si amprentele exacte; un client vechi sau un POST direct nu poate sari peste ea.
    if (b.acceptLegal !== true) {
      return res.status(400).json({ error: 'Acceptă explicit Termenii, Politica de confidențialitate și DPA-ul pentru etapa de test.', code: 'LEGAL_ACCEPTANCE_REQUIRED' });
    }
    // firma noua GOALA — fara date contabile (entries/parteneri/solduri/stocuri etc.)
    // La contul de contabil nu se creeaza nicio firma: `firma` ramane null si tot ce urmeaza
    // (proba, proprietar, legarea platii) se sare. Firmele lui vin prin acord, mai tarziu.
    let firma = null; let fid = null;
    if (!contabilFaraFirma) {
      fid = db.nextFirmaId();
      firma = Object.assign(db.defaultFirma(fid), {
        nume, cui: cuiNou, regCom: String(b.regCom || '').trim(),
        adresa: String(b.adresa || '').trim(), oras: String(b.oras || '').trim(), judet: String(b.judet || '').trim(),
        tvaPlatitor: b.tvaPlatitor,
        tipEntitate: b.tipEntitate === 'pfa' ? 'pfa' : 'srl',
      }, { id: fid });
      // Billing per-firma: prima firma primeste o proba de 30 de zile.
      firma.subscription = plans.firmaTrialSub();
      d.firme.push(firma);
      d.partners[fid] = {}; d.openingBalances[fid] = {};
    }
    const { salt, hash } = await authlib.hashPasswordAsync(password);
    // felul contului, ales explicit la inscriere: decide ce i se ofera in aplicatie (patronul
    // isi inscrie firme proprii; contabilul primeste firmele altora, prin acord)
    const user = { id: db.nextUserId(), username, email, salt, hash, role: 'user', createdAt: new Date().toISOString(),
      tipCont: contabilFaraFirma ? 'contabil' : 'patron', firme: fid ? [fid] : [], firmaActiva: fid,
      legalAcceptance: legal.acceptanceRecord('account-onboarding', null, { declaration: 'test-stage-documents' }) };
    user.legalAcceptance.acceptedBy = user.id;
    user.legalAcceptance.acceptedUsername = user.username;
    if (firma) {
      firma.ownerId = user.id; // proprietarul firmei: cel care a inscris-o (aproba cererile de acces)
      firma.legalAcceptance = legal.acceptanceRecord('test-data', user, { declaration: 'fictitious-only' });
    }
    // Profilul public este opt-in: un contabil nou nu apare intr-un catalog pana nu cere asta.
    if (contabilFaraFirma && b.disponibilContabil === true) user.profil = { disponibilContabil: true };
    d.users.push(user);
    commercialFunnel.markEntity(d, user, 'signup', { at: user.createdAt });
    // Daca a platit ca „guest" inainte de inscriere, leaga abonamentul dupa email (Stripe) — firma devine activa.
    const pIdx = plans.findPending(d.settings.pendingSubs, user.email);
    if (pIdx >= 0) {
      const rec = d.settings.pendingSubs[pIdx];
      user.subscription = plans.pendingToSubscription(rec);
      // fara firma nu exista pe ce sa se aplice abonamentul de firma; contul pastreaza plata
      // legata (user.subscription) si o va folosi la prima firma pe care o primeste
      if (firma) firma.subscription = { status: 'active', plan: rec.plan, since: new Date().toISOString(), stripeCustomerId: rec.customerId || null, stripeSubscriptionId: rec.subscriptionId || null };
      // Plata guest a fost numarata cand a confirmat-o Stripe. Aici atasam doar marcajul la
      // entitatea noua, fara al doilea eveniment comercial.
      const paidAt = rec.commercialPaymentAt || rec.at || new Date().toISOString();
      commercialFunnel.markEntity(d, firma || user, 'payment', { at: paidAt, count: false });
      d.settings.pendingSubs.splice(pIdx, 1);
      logAudit('subscription.linked', 'abonament ' + rec.plan + ' legat la inscriere', { userId: user.id, username, firmaId: fid });
    }
    regBump(req);
    logAudit(contabilFaraFirma ? 'contabil.register' : 'firma.register',
      contabilFaraFirma ? ('cont de contabil, fara firma (utilizator ' + username + ')') : (nume + ' (utilizator ' + username + ')'),
      { userId: user.id, username, firmaId: fid });
    db.save();
    startSession(req, res, user); // autentificare automata dupa inscriere
    res.json({ ok: true, firma: firma ? { id: fid, nume: firma.nume } : null, faraFirma: contabilFaraFirma, user: publicUser(user) });
    // email de bun venit (best-effort, nu blocheaza raspunsul)
    if (user.email) {
      sendNotifMail(user.email, 'Bun venit în Contabo!',
        contabilFaraFirma
          ? ('Salut,\n\nContul tău de contabil („' + username + '") e gata. Nu ai nicio firmă încă — și e normal:\n'
            + 'firmele vin de la clienți, prin acordul lor.\n\n'
            + 'Primii pași:\n'
            + '  1. Completează-ți datele în Setări → Contul meu (nume, oraș, ce servicii oferi) — așa te găsesc patronii.\n'
            + '  2. Preiei un client care e deja în Contabo? Cere acces după CUI, din Setări → Firmele mele. Proprietarul aprobă.\n'
            + '  3. Sau așteaptă: un patron îți poate trimite direct o cerere de servicii, iar tu accepți sau refuzi.\n\n'
            + 'Ghidul pas cu pas e în aplicație (tab-ul Ghid), iar la orice întrebare ne scrii direct din Mesaje.\n\n'
            + 'Intră în aplicație: ' + billing.appUrl() + '\n\nSpor la treabă!\nEchipa Contabo')
          : ('Salut,\n\nContul tău („' + username + '") și firma „' + firma.nume + '" sunt gata.\n\n'
            + 'Primii pași:\n'
            + '  1. Încarcă prima factură primită (PDF sau poză) — articolul contabil se generează singur.\n'
            + '  2. Emite o factură către un client — primești automat e-Factura XML + PDF.\n'
            + '  3. La final de lună, descarcă declarațiile din „Declarații ANAF".\n\n'
            + 'Ghidul pas cu pas e în aplicație (tab-ul Ghid), iar la orice întrebare ne scrii direct din Mesaje.\n\n'
            + 'Intră în aplicație: ' + billing.appUrl() + '\n\nSpor la treabă!\nEchipa Contabo')
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
  // Export CSV al jurnalului de audit (control intern / GDPR): TOT ce e retinut in baza vie
  // (plafon CONTAB_AUDIT_MAX), nu doar cele 300 afisate. Proba DURABILA (append-only, in afara
  // rolarii si a bazei) e in fisierele lunare data/audit/*.ndjson — /api/audit/durable (admin).
  // Firma curenta pt oricine; sistemul + jurnalul durabil doar admin.
  function auditCsv(res, list, filename) {
    const rows = list.map((a) => [a.ts, a.username || '', a.action, a.detail || '', a.viaAdmin || '']);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(toCsv(['Data (UTC)', 'Utilizator', 'Actiune', 'Detaliu', 'Prin admin'], rows));
  }
  function verifiedGlobal(res, exposeIssues) {
    let report;
    try { report = globalChain.verifyGraph(db.get(), { auditResult: auditLog.verify(), requireAudit: true }); }
    catch (_) {
      res.status(409).json({ error: 'Lanțul global nu a putut fi verificat.', code: 'GLOBAL_CHAIN_UNAVAILABLE' }); return null;
    }
    if (!report.ok) {
      res.status(409).json({ error: 'Operația a fost oprită: verificarea globală a lanțului a eșuat.',
        code: 'GLOBAL_CHAIN_INVALID', issues: exposeIssues ? report.issues : undefined }); return null;
    }
    res.setHeader('X-Contab-Integrity-Root', report.rootHash);
    return report;
  }
  app.get('/csv/audit', (req, res) => {
    if (!verifiedGlobal(res, false)) return;
    auditCsv(res, auditList(req, activeId(req)), 'audit-firma.csv');
  });
  app.get('/csv/audit/system', requireAdmin, (req, res) => {
    if (!verifiedGlobal(res, true)) return;
    auditCsv(res, auditList(req, null), 'audit-sistem.csv');
  });
  // Jurnalul DURABIL (append-only, pe disc): listeaza fisierele lunare sau descarca unul.
  const path = require('path'); const fs = require('fs');
  app.get('/api/audit/durable', requireAdmin, (req, res) => {
    const files = auditLog.listFiles();
    if (!req.query.file) return res.json({ files });
    const name = String(req.query.file);
    if (!/^audit-\d{4}-\d{2}\.ndjson$/.test(name)) return res.status(400).json({ error: 'Nume de fisier invalid.' });
    const p = path.join(auditLog.auditDir(), name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Fisier inexistent.' });
    if (!verifiedGlobal(res, true)) return;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.send(fs.readFileSync(p));
  });
  app.get('/api/audit/durable/verify', requireAdmin, (req, res) => {
    const result = auditLog.verify();
    const global = globalChain.verifyGraph(db.get(), { auditResult: result, requireAudit: true });
    res.status(global.ok ? 200 : 409).json(Object.assign({}, result, {
      ok: global.ok, globalRootHash: global.rootHash, complete: global.complete, global,
    }));
  });
  app.get('/api/integrity/global', requireAdmin, (req, res) => {
    const audit = auditLog.verify();
    const report = globalChain.verifyGraph(db.get(), { auditResult: audit, requireAudit: true });
    res.status(report.ok ? 200 : 409).json(report);
  });

  // Metrici de performanta pe ruta (in-memory, de la ultimul restart): candidatii la optimizare
  // primii. Include si diagnosticele de proces (memorie, Node, driver) — DOAR pentru admin.
  // ───────── ERORI DIN CLIENT (public) ─────────
  // Ruta e PUBLICA deliberat. Cea mai costisitoare eroare de client e cea de pe ECRANUL DE LOGIN:
  // nimeni nu mai intra, iar utilizatorii pleaca fara sa reclame. Daca ar cere sesiune, exact acel
  // caz ar ramane invizibil — adica tocmai gaura pe care ruta o astupa.
  //
  // Suprafata de abuz e marginita din patru directii: plafon pe IP (mai jos), taiere agresiva a
  // campurilor (metrics.clientErrorRecord), AGREGARE pe semnatura (o rafala repetata nu evacueaza
  // nimic) si inelul de 25 de intrari. Nu se persista si nu se trimite niciun email.
  const clientErrAttempts = new Map();
  const CLIENT_ERR_MAX = Number(process.env.CONTAB_RATE_CLIENT_ERR) || 30; // raportari/ora/IP
  app.post('/api/client-error', (req, res) => {
    const k = attemptKey(req); const now = Date.now();
    let r = clientErrAttempts.get(k);
    if (!r || now > r.reset) r = { count: 0, reset: now + 3600 * 1000 };
    r.count += 1; clientErrAttempts.set(k, r);
    // Peste plafon raspundem tot 204: clientul n-are ce face cu informatia, iar un 429 l-ar
    // impinge sa reincerce. Raportarea e best-effort prin natura ei.
    if (r.count > CLIENT_ERR_MAX) return res.status(204).end();
    const rec = metrics.clientErrorRecord(req.body, {
      username: (currentUser(req) || {}).username || null,
      ua: req.get('user-agent'),
    });
    metrics.clientError(rec);
    // In logul structurat ca AVERTISMENT, nu ca eroare de server: nu e o cadere a noastra si n-are
    // voie sa intre in fereastra de alerta 5xx (ar trimite emailuri pentru un browser strain).
    log.warn('eroare in client', { msg: rec.msg, sursa: rec.sursa, cale: rec.cale, user: rec.username });
    res.status(204).end();
  });

  // ───────── CAUTARE CUI IN REGISTRUL PUBLIC ANAF (public) ─────────
  // De ce PUBLICA: cel mai scump loc in care se tasteaza de mana datele unei firme e formularul
  // de INSCRIERE — denumire, CUI, Reg. Com., adresa, oras, judet, toate scrise de un om care abia
  // a ajuns in aplicatie si inca n-are cont. Daca ruta ar cere sesiune, exact acolo n-ar putea
  // ajuta, iar CUI-ul ar continua sa fie tastat de trei ori (inscriere, „Firma mea", partener).
  // Datele intoarse sunt PUBLICE prin natura lor: registrul contribuabililor e un serviciu ANAF
  // fara autentificare, care raspunde oricui.
  //
  // Suprafata de abuz e marginita din trei directii, ca la /api/client-error:
  //   1. plafon pe IP (mai jos) — un om care completeaza un formular are nevoie de 1-3 cautari;
  //   2. memo in `anafRegistru` — acelasi CUI nu pleaca de doua ori catre ANAF in aceeasi zi;
  //   3. raspuns SUBTIRE: doar campurile care se pun intr-un formular, plus semnalele de stare.
  // A treia conteaza: registrul intoarce ~60 de campuri, iar ruta n-are motiv sa le difuzeze.
  const cuiAttempts = new Map();
  const CUI_MAX = Number(process.env.CONTAB_RATE_CUI) || 30; // cautari/ora/IP
  app.get('/api/registru-anaf', wrap(async (req, res) => {
    const k = attemptKey(req); const now = Date.now();
    let r = cuiAttempts.get(k);
    if (!r || now > r.reset) r = { count: 0, reset: now + 3600 * 1000 };
    r.count += 1; cuiAttempts.set(k, r);
    // Aici 429 e raspunsul corect (spre deosebire de raportarea de erori, unde clientul n-avea
    // ce face cu informatia): omul ASTEPTA completarea si trebuie sa afle ca poate scrie manual.
    if (r.count > CUI_MAX) {
      return res.status(429).json({ error: 'Prea multe cautari de CUI de la aceeasi adresa. Completează câmpurile manual sau încearcă mai târziu.' });
    }
    if (!identitate.validCUI(req.query.cui)) {
      return res.status(400).json({ error: 'CUI invalid — cifra de control nu se potriveste.' });
    }
    let out;
    try {
      out = await registruAnaf.cautaPentruCompletare(req.query.cui);
    } catch (e) {
      // Serviciul ANAF picat NU e o eroare a aplicatiei si nu are voie sa intre in fereastra de
      // alerta 5xx: formularul ramane perfect utilizabil scris de mana. 503 + motiv, ca interfata
      // sa poata spune „completeaza manual", nu „a crapat ceva".
      log.warn('cautare CUI: registrul ANAF nu a raspuns', { cui: String(req.query.cui).slice(0, 12), err: e.message });
      return res.status(503).json({ error: 'Registrul ANAF nu răspunde acum. Completează câmpurile manual.' });
    }
    if (!out.gasit) return res.json({ gasit: false, cui: out.cui });
    const g = out.registru;
    res.json({
      gasit: true,
      cui: g.cui,
      denumire: g.denumire,
      adresa: g.adresa,
      nrRegCom: g.nrRegCom,
      caen: g.caen,
      // Registrul da codul auto al judetului („B", „CJ"), aplicatia foloseste peste tot forma
      // ISO 3166-2 („RO-B", „RO-CJ") — asa cere CIUS-RO in e-Factura si asa scriu toate cele trei
      // formulare. Conversia se face AICI, o data, nu in fiecare consumator: altfel primul care ar
      // uita-o ar produce un judet invalid intr-o declaratie, adica tocmai la capatul unde nu se
      // mai vede. `judet` gol ramane gol — nu inventam „RO-".
      judet: g.judet ? 'RO-' + String(g.judet).toUpperCase() : '',
      localitate: g.localitate,
      tvaPlatitor: g.tvaPlatitor,
      tvaLaIncasare: g.tvaLaIncasare,
      // Semnalele care schimba o decizie contabila, nu doar completeaza un camp: cu un partener
      // INACTIV cheltuiala e nedeductibila si TVA-ul nu se deduce (art. 11 Cod fiscal). E mai
      // ieftin sa afli acum, cand tastezi CUI-ul, decat dupa ce ai inregistrat factura.
      inactiv: g.inactiv,
      radiat: g.radiat,
    });
  }));

  // ASINCRON pentru un singur camp: `deploy` (ce cod ruleaza de fapt). Citirea lanseaza git, deci
  // nu are ce cauta pe o cale sincrona; memo-ul cu TTL din deployState face ca rafalele de
  // reimprospatare sa nu lanseze subprocese in serie.
  app.get('/api/metrics', requireAdmin, async (req, res) => {
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
    // Distributia incarcarii PE FIRMA: axa reala de crestere a acestei aplicatii (firmele sunt deja
    // izolate prin firmaId/scoped). Calculul sta in `metrics.firmeLoad` — o singura sursa, folosita
    // si de jobul `scale-watch`, care duce acelasi semnal la ALERTA. Praguri: docs/scalare-crestere.md.
    const incarcare = metrics.firmeLoad(d);
    // Nu blocheaza raspunsul daca git nu merge: deployState.read() nu arunca niciodata, iar
    // verdictul „nu se poate citi" e o stare de sine statatoare, distincta de „curat".
    const deploy = await require('./deployState').read();
    res.json(Object.assign(metrics.snapshot(), {
      deploy,
      jobs,
      process: {
        nodeVersion: process.version, pid: process.pid, driver: db.DRIVER,
        uptimeSec: Math.round(process.uptime()), firme: (d.firme || []).length, users: (d.users || []).length,
        memoryRssMb: mb(mem.rss), memoryHeapUsedMb: mb(mem.heapUsed), memoryHeapTotalMb: mb(mem.heapTotal),
        // fencing multi-scriitor: true = alt proces a scris in baza, persistenta e INGHETATA (restart necesar)
        storeConflict: db.storeConflicted(),
        // cat de aproape e RSS-ul de plafonul pm2 (max_memory_restart): sub 100% procesul traieste
        memoryLimitMb: metrics.MEM_LIMIT_MB,
        memoryWarnMb: metrics.MEM_WARN_MB,
        memoryPctDinPlafon: Math.round((mem.rss / (metrics.MEM_LIMIT_MB * 1048576)) * 100),
      },
      // Coada de persistenta: `pendingAgeMs` > 0 = scrieri care traiesc doar in RAM (nedurabile).
      persist: db.persistStats(),
      firmeLoad: incarcare,
      // memo-ul per firma al rutelor scumpe (dashboard): rata de hit spune daca invalidarea
      // globala la fiecare scriere lasa cache-ul sa ajute in practica.
      cache: cache.stats(),
      // Trunchierile garzii OOM (src/paginate.js), pe eticheta. Jurnalul le avertizeaza RAR (o
      // stare permanenta nu are voie sa scrie o linie per cerere), deci imaginea completa —
      // de cate ori, cat de mare era lista, cand — se citeste de AICI.
      trunchieri: metrics.truncationsSnapshot(),
    }));
  });

  app.get('/api/me', (req, res) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'Neautentificat' });
    res.json(withSessionState(req, u));
  });

  // Reautentificare recenta, legata de sesiune si de SCOP. Codurile de rezerva sunt excluse:
  // step-up-ul protejeaza operatii cu raza mare, nu fluxul de recuperare a accesului.
  app.post('/api/step-up', wrap(async (req, res) => {
    if (req.impersonating) return res.status(403).json({ error: 'Ieși din impersonare înainte de reautentificarea privilegiată.' });
    const principal = req.realUser || req.user; const body = req.body || {};
    const scope = String(body.scope || '');
    if (!stepUp.SCOPES.has(scope)) return res.status(400).json({ error: 'Scop step-up invalid.' });
    if (!principal || !principal.twofa) {
      return res.status(428).json({ error: 'Activează 2FA înainte de această operațiune.', twofaRequired: true });
    }
    const passwordOk = await authlib.verifyUserPasswordAsync(principal, body.password);
    const factor = accountSvc.verifySecondFactor(principal, body.code, { allowRecovery: false });
    if (!passwordOk || !factor.ok) {
      bumpFail(req);
      logAudit('auth.step-up.denied', 'reautentificare eșuată · scop ' + scope, {
        req, userId: principal.id, username: principal.username, firmaId: null,
      });
      db.save();
      return res.status(401).json({ error: 'Reautentificare eșuată. Verifică parola și codul TOTP.' });
    }
    clearFails(req);
    const grant = stepUp.grant(req, scope);
    logAudit('auth.step-up', 'scop ' + scope + ' · valabil până la ' + grant.expiresAt, {
      req, userId: principal.id, username: principal.username, firmaId: null,
    });
    db.save();
    return res.json({ ok: true, scope, expiresAt: grant.expiresAt });
  }));

  // ───────────────────────── IMPERSONARE (admin intra pe cont de user) ─────────────────────────
  // Adminul real (chiar daca impersoneaza deja pe cineva) e principalul care detine sesiunea.
  function adminPrincipal(req) {
    if (req.realUser && req.realUser.role === 'admin') return req.realUser;
    return req.user && req.user.role === 'admin' ? req.user : null;
  }
  app.post('/api/impersonate', wrap(async (req, res) => {
    const admin = adminPrincipal(req);
    if (!admin) return res.status(403).json({ error: 'Doar administratorul poate intra pe conturi.' });
    if (!admin.twofa) return res.status(428).json({ error: 'Activează 2FA înainte de impersonare.', twofaRequired: true });
    const body = req.body || {};
    const reason = String(body.reason || '').trim().slice(0, 500);
    const ticket = String(body.ticket || '').trim().slice(0, 120);
    if (reason.length < 10) return res.status(400).json({ error: 'Motivul impersonării trebuie să aibă cel puțin 10 caractere.' });
    if (ticket.length < 3) return res.status(400).json({ error: 'Indică tichetul sau referința solicitării.' });
    if (!stepUp.valid(req, 'impersonation')) return stepUp.requiredResponse(res, 'impersonation');
    const d = db.get();
    const target = d.users.find((x) => x.id === Number(body.userId));
    if (!target) return res.status(404).json({ error: 'Utilizator inexistent.' });
    if (target.id === admin.id) return res.status(400).json({ error: 'Esti deja autentificat ca tine.' });
    if (target.role === 'admin') return res.status(400).json({ error: 'Nu poti intra pe contul altui administrator.' });
    if (target.pending) return res.status(400).json({ error: 'Contul nu e finalizat (invitatie in asteptare).' });
    const sess = (admin.sessions || []).find((s) => s.id === req._sessId);
    if (!sess) return res.status(400).json({ error: 'Sesiune invalida.' });
    const startedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    sess.impersonating = { userId: target.id, reason, ticket, startedAt, expiresAt };
    logAudit('impersonate.start', admin.username + ' a intrat pe contul ' + target.username
      + ' · tichet ' + ticket + ' · motiv: ' + reason + ' · expiră ' + expiresAt,
    { req, userId: admin.id, username: admin.username, firmaId: null });

    // Notificarea ajunge atat la tinta, cat si la proprietarii firmelor pe care aceasta le poate
    // vedea. Mesajul in-app este durabil; emailul este best-effort si nu poate anula accesul deja
    // consemnat daca furnizorul extern este indisponibil.
    const targetFids = new Set([...(target.firme || []),
      ...(d.firme || []).filter((f) => Number(f.ownerId) === Number(target.id)).map((f) => f.id)]
      .map(Number));
    const recipients = new Map([[target.id, target]]);
    for (const f of d.firme || []) if (targetFids.has(Number(f.id)) && f.ownerId != null) {
      const owner = d.users.find((u) => Number(u.id) === Number(f.ownerId));
      if (owner) recipients.set(owner.id, owner);
    }
    const notice = 'Notificare de securitate: administratorul ' + admin.username
      + ' a deschis acces read-only pe contul ' + target.username + ' până la ' + expiresAt
      + '. Tichet: ' + ticket + '. Motiv: ' + reason;
    for (const recipient of recipients.values()) {
      d.messages = d.messages || [];
      d.messages.push(messages.newMessage(db.nextId('m'), recipient.id, true, notice, 'Sistem Contabo'));
      if (recipient.email) sendNotifMail(recipient.email, '[Contab] Acces administrativ temporar pe cont', notice)
        .catch((e) => log.warn('notificare email impersonare eșuată', { userId: recipient.id, err: e }));
    }
    db.save();
    res.json({ ok: true, user: publicUser(target), expiresAt });
  }));
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
    // Raspunsul catre client ramane IDENTIC in toate cazurile (anti-enumerare de conturi), dar
    // motivul se scrie in log: altfel „nu primesc mailul de resetare" e imposibil de diagnosticat
    // din afara, iar cauza cea mai frecventa — SMTP neconfigurat — nu lasa nicio urma.
    if (!u || !u.email || !(d.settings.smtp && d.settings.smtp.host)) {
      const motiv = !u ? 'cont inexistent' : !u.email ? 'contul nu are adresa de email' : 'SMTP neconfigurat (Setări → Server email)';
      console.warn('[contab] link de resetare NETRIMIS:', motiv);
      return res.json(generic);
    }
    u.resetToken = crypto.randomBytes(24).toString('hex');
    u.resetExp = Date.now() + 3600 * 1000; // 1 ora
    db.save();
    const link = (req.protocol || 'http') + '://' + req.get('host') + '/?reset=' + u.resetToken;
    // Raspunde INAINTE de a trimite mailul. Asteptarea rundei SMTP se vedea in timpul de raspuns
    // doar pe ramura cu cont existent (secunde, nu milisecunde), deci enumera conturile exact ce
    // textul generic de mai sus ascunde. Trimiterea continua in fundal; esecul ei se logheaza si
    // asa nu schimba raspunsul catre client (utilizatorul reincearca, tokenul e deja salvat).
    res.json(generic);
    // sendMail poate arunca SINCRON (nodemailer lipsa, transport invalid), nu doar respinge — dupa
    // res.json() aceea ar urca la handlerul global cu antetele trimise. Ambele forme se opresc aici.
    try {
      sendMail(d.settings.smtp, u.email, 'Resetare parola Contabo', 'Reseteaza-ti parola (valabil 1 ora):\n' + link)
        .catch((e) => console.error('SMTP reset:', e.message));
    } catch (e) { console.error('SMTP reset:', e.message); }
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
    const h = await authlib.hashPasswordAsync(password);
    u.salt = h.salt; u.hash = h.hash; u.mustChange = false; delete u.resetToken; delete u.resetExp;
    u.sessions = []; // resetarea parolei deconecteaza celelalte sesiuni
    // Un dispozitiv marcat anterior „de incredere" nu mai poate sari peste 2FA dupa un flux de
    // recuperare. Resetarea parolei este o rotire completa a credentialelor contului.
    u.tfdEpoch = (u.tfdEpoch || 0) + 1;
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
      ai: {
        available: ai.aiAvailable(),
        platformEnabled: d.settings.useAI !== false,
        enabled: d.settings.useAI !== false && legal.aiAllowed(v.company),
        consent: !!(v.company.aiProcessing && v.company.aiProcessing.enabled),
        model: ai.resolveProvider().model,
        provider: ai.resolveProvider().provider,
      },
      legal: Object.assign({}, legal.publicStatus(), {
        firm: Object.assign({}, legal.firmState(v.company), {
          canManage: !!(v.company && (req.user.role === 'admin' || Number(v.company.ownerId) === Number(req.user.id))),
          acceptedAt: v.company && v.company.legalAcceptance && v.company.legalAcceptance.acceptedAt || null,
        }),
      }),
      fiscal: fiscal.FISCAL,
      selfRegister: d.settings.selfRegister !== false,
      // Incasarea e oprita cat timp furnizorul nu are identitate juridica publicata (src/plans.js).
      // Ajunge in META fiindca interfata trebuie sa stie INAINTE de a promite o plata: ecranul de
      // abonare a firmei spunea „se deschide plata online" si abia apoi ar fi primit 503.
      platiSuspendate: plans.PLATI_SUSPENDATE,
      motivPlatiSuspendate: plans.MOTIV_PLATI_SUSPENDATE,
    });
  });

  return { registerAttempts, forgotAttempts, clientErrAttempts, cuiAttempts };
};
