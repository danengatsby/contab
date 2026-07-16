'use strict';

const bootstrap = require('./src/bootstrap');
bootstrap.loadDotEnv(__dirname);

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
const efacturaImport = require('./src/efacturaImport');
const plans = require('./src/plans');
const billing = require('./src/billing');
const log = require('./src/log');
const metrics = require('./src/metrics');
const uploadGuard = require('./src/uploadGuard');
const { round2, period: periodOf } = require('./src/util');

// Pe sqlite/json load() e sincron; pe PostgreSQL intoarce o promisiune. Serverul incepe
// sa asculte (app.listen, la finalul fisierului) abia dupa ce baza e hidratata.
const dbReady = Promise.resolve(db.load()).then(() => {
  coa.addAccounts(db.get().customAccounts); // inregistreaza conturile personalizate importate
  fiscal.applyConfig(db.get().settings.fiscal); // aplica cotele fiscale configurate (peste valorile implicite)
});

const app = bootstrap.createApp({ rootDir: __dirname, db, log, metrics, uploadGuard });
const upload = app.locals.bootstrap.upload;
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
const RATE_UPLOAD = Number(process.env.CONTAB_RATE_UPLOAD || 60);  // upload-uri/ora/utilizator
const RATE_EXPORT = Number(process.env.CONTAB_RATE_EXPORT || 10);  // exporturi mari/ora/utilizator
const uploadLimiter = uploadGuard.userLimit('upload', RATE_UPLOAD, 'Prea multe fisiere incarcate.');
const rawUploadSingle = upload.single.bind(upload);
upload.single = (field) => [uploadLimiter, rawUploadSingle(field), uploadGuard.verifyUploadContent];

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

bootstrap.applySecurityGuards(app, { db, log, logAudit, currentUser, allowedFirme, plans, activeId, uploadGuard });
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Necesita drepturi de administrator.' });
  next();
}

const authRoutes = require('./src/authRoutes');
authRoutes(app, {
  db, log, logAudit,
  authlib, totp, messages, plans, billing,
  wrap, upload,
  currentUser, allowedFirme, publicUser, startSession,
  setTrustedDevice, deviceTrusted, isLocked, bumpFail, clearFails, attemptKey,
  pruneLoginAttempts,
  periodOf: periodOf,
  coa, typesForClient, ai, fiscal, sendMail, sendNotifMail,
});

// Setari de cont si securitate (2FA, sesiuni, parola, profil): src/routes/account.js
require('./src/routes/account')(app, { logAudit });

// Backup/restaurare + SMTP (admin): src/routes/backup.js — intoarce doBackup (folosit si de jobul zilnic).
const { doBackup } = require('./src/routes/backup')(app, { requireAdmin, upload, logAudit });

// Mesaje (suport user <-> admin): src/routes/messages.js
require('./src/routes/messages')(app, { requireAdmin, upload, logAudit });

// ── Abonamente (planuri + trial) ──
// Prețurile sunt publice (vizibile pe pagina de înscriere, fără autentificare).
// Abonament / plati Stripe (planuri, checkout, portal, webhook, proba/select, activare admin): src/routes/billing.js
require('./src/routes/billing')(app, { requireAdmin, logAudit });

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
  // („Intocmit: ...”). Copie a firmei per cerere — obiectul din DB nu se atinge.
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
require('./src/routes/config')(app, { S, activeId, logAudit, requireAdmin, upload });

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
  // Regim „TVA la incasare”: pe facturi, TVA devine NEEXIGIBILA (4428) pana la incasare/plata.
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
", fara parola in client.
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
require('./src/routes/account')(app, { logAudit });

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
  res.json(Object.assign(metrics.snapshot(), {
    jobs,
    process: {
      nodeVersion: process.version, pid: process.pid, driver: db.DRIVER,
      uptimeSec: Math.round(process.uptime()), firme: (d.firme || []).length, users: (d.users || []).length,
      memoryRssMb: mb(mem.rss), memoryHeapUsedMb: mb(mem.heapUsed), memoryHeapTotalMb: mb(mem.heapTotal),
    },
  }));
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
require('./src/routes/config')(app, { S, activeId, logAudit, requireAdmin, upload });

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
require('./src/routes/bank')(app, { upload, S, activeId, buildEntry, upsertPartner, logAudit });

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
    metrics.jobTick(label); // starea job-urilor apare in /api/metrics (admin)
    try { fn(); }
    catch (e) {
      metrics.jobError(label, e.message || e);
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
    try { const r = doBackup(); metrics.jobResult('backup', r.name); console.log('Backup automat:', r.name); }
    catch (e) { metrics.jobError('backup', e.message); console.error('Backup:', e.message); }
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
    .then((r) => {
      metrics.jobResult('digest-termene', r.sent.length + ' trimise' + (r.errors.length ? ', ' + r.errors.length + ' erori' : ''));
      if (r.sent.length || r.errors.length) console.log('Digest termene:', r.sent.length, 'trimise', r.errors.length ? ('; erori: ' + r.errors.join(' | ')) : '');
    })
    .catch((e) => { metrics.jobError('digest-termene', e.message); console.error('Digest termene:', e.message); });
}, 15 * 60 * 1000);

// Reset zilnic al contului demo (dupa ora 04:00): junk-ul vizitatorilor dispare peste noapte
safeInterval('demo-reset', () => {
  const d = db.get();
  const today = new Date().toISOString().slice(0, 10);
  const s = d.settings.demoReset || (d.settings.demoReset = {});
  if (s.lastDate === today || new Date().getHours() < 4) return;
  s.lastDate = today;
  try { const r = resetDemo(); if (r.ok) { metrics.jobResult('demo-reset', 'resetat din snapshot'); console.log('Demo resetat din snapshot.'); } db.save(); }
  catch (e) { metrics.jobError('demo-reset', e.message); console.error('Demo reset:', e.message); }
}, 15 * 60 * 1000);

// Igiena rate-limit: fara curatare, map-urile ar creste nelimitat (cate o intrare per IP esuat)
safeInterval('rate-limit-hygiene', () => {
  const now = Date.now();
  pruneLoginAttempts(now); // loginAttempts traieste in src/session.js (incapsulat)
  for (const [k, r] of registerAttempts) { if (r.reset < now) registerAttempts.delete(k); }
  for (const [k, r] of forgotAttempts) { if (r.reset < now) forgotAttempts.delete(k); }
  uploadGuard.pruneRateBuckets(now); // bucket-urile de upload/export per utilizator
}, 3600 * 1000);

// Job periodic: descarca automat recipisele — SPV per-firma, doar firmele cu autoPoll bifat
safeInterval('spv-poll', () => {
  const vreoFirma = db.get().firme.some((f) => f.anaf && f.anaf.autoPoll && anaf.connected(f.anaf));
  if (vreoFirma) {
    pollSpv({ auto: true })
      .then((r) => {
        metrics.jobResult('spv-poll', 'verificate ' + r.checked + ', descarcate ' + r.downloaded);
        if (r.downloaded) console.log('Auto-poll SPV: ' + r.downloaded + ' recipise descarcate');
      })
      .catch((e) => { metrics.jobError('spv-poll', e.message || e); console.error('Auto-poll SPV:', e.message || e); });
  }
}, 15 * 60 * 1000);

// Alerta pe email cand se aduna erori de server: >=5 erori 5xx in 15 minute -> un email pe ora.
const err5xx = [];
let lastErrAlert = 0;
function trackServerError(req, err) {
  const now = Date.now();
  const rid = req.reqId ? '[' + req.reqId + '] ' : '';
  err5xx.push({ t: now, m: rid + req.method + ' ' + req.originalUrl + ': ' + String((err && err.message) || err).slice(0, 160) });
  metrics.recordError(err5xx[err5xx.length - 1].m); // vizibila in /api/metrics, nu doar in fereastra de alerta
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
