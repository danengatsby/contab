'use strict';

// server.js = doar ASAMBLAREA: .env + instanta Express (src/bootstrap.js), nucleul de
// autentificare (src/authRoutes.js), inregistrarea modulelor de rute cu ctx, buildEntry/
// upsertPartner (folosite de mai multe rute), apoi joburile periodice (src/jobs.js),
// handlerul global de erori (src/serverErrors.js) si ciclul de viata (src/lifecycle.js).
const bootstrap = require('./src/bootstrap');
bootstrap.loadDotEnv(__dirname); // inainte de orice require care citeste variabile (cheie AI etc.)
// Secretele obligatorii, IMEDIAT dupa .env si INAINTE de a atinge baza: altfel o pornire fara
// ele apuca sa creeze fisierul bazei (cu un authSecret generat) inainte sa refuze.
require('./src/secretsGuard').assertSecrets();
// Orice fisier nou (upload, backup, jurnal) porneste privat; modulele de date aplica si chmod
// pentru instalari/fisiere vechi. Nu afecteaza activele publice, servite din public/.
process.umask(0o077);

const db = require('./src/db');
const coa = require('./src/chartOfAccounts');
const { getType } = require('./src/documentTypes');
const fiscal = require('./src/fiscal');
const { sendDeadlineDigests } = require('./src/notify'); // ruta de digest manual; jobul zilnic e in src/jobs.js
const log = require('./src/log');
const serverErrors = require('./src/serverErrors');
const { round2, period: periodOf } = require('./src/util');
const { D394_COD_331 } = require('./src/xml');

// Pe sqlite/json load() e sincron; pe PostgreSQL intoarce o promisiune. Serverul incepe
// sa asculte (app.listen, la finalul fisierului) abia dupa ce baza e hidratata.
const dbReady = Promise.resolve(db.load()).then(() => {
  coa.addAccounts(db.get().customAccounts); // inregistreaza conturile personalizate importate
  fiscal.applyConfig(db.get().settings.fiscal); // aplica cotele fiscale configurate (peste valorile implicite)
  // Vizitatorii site-ului traiesc intr-un Map in memorie (calea cererii nu scrie in baza); la
  // pornire se reincarca din colectia persistata, altfel fiecare restart ar reseta contoarele.
  require('./src/visitors').hydrate(db.get().visitors);
});

// Instanta Express cu tot middleware-ul de infrastructura (trust proxy, helmet/CSP, reqId,
// metrici, parsare body, static, sanitizare, multer + garda de upload): src/bootstrap.js.
const { app, upload } = bootstrap.createApp();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  log.error('eroare necuprinsa in ruta', log.ctx(req, { status: 500, err: e }));
  serverErrors.trackServerError(req, e);
  res.status(500).json({ error: String(e.message || e), reqId: req.reqId });
});

// ───────────────────────── AUTENTIFICARE ─────────────────────────
// Primitive de sesiune/auth/anti-brute-force: src/session.js. Rutele de login/cont/impersonare/
// resetare (nucleul de securitate) stau in src/authRoutes.js si isi fac singure require-urile.
const { allowedFirme, publicUser, startSession } = require('./src/session');

// jurnal de audit (cine, ce actiune, pe ce firma)
const auditLog = require('./src/auditLog');
function logAudit(action, detail, opts) {
  const d = db.get();
  const o = opts || {};
  d.audit = d.audit || [];
  // daca actiunea e facuta de un admin in modul impersonare, pastreaza si numele real
  const viaAdmin = o.req && o.req.impersonating && o.req.realUser ? o.req.realUser.username : null;
  // Adresa IP se retine pe evenimentele de AUTENTIFICARE (reusite si esuate), nu pe toate:
  // acolo raspunde la intrebarea „cine a intrat si de unde", care e si intrebarea panoului de
  // administrare. Pe restul actiunilor ar fi doar zgomot repetat de mii de ori pe zi.
  // NU ajunge in proiectia SQL `audit_log` (coloane fixe, iar arhitectura nu evolueaza schema
  // relationala — vezi CLAUDE.md): traieste in colectia vie si, DURABIL, in data/audit/*.ndjson,
  // unde `auditLog.append` scrie inregistrarea intreaga.
  const ip = o.ip || (o.req ? String(o.req.ip || '') : '');
  const record = {
    id: (d.audit[d.audit.length - 1] || {}).id + 1 || 1,
    ts: new Date().toISOString(),
    userId: o.userId != null ? o.userId : (o.req && o.req.user && o.req.user.id),
    username: o.username || (o.req && o.req.user && o.req.user.username) || '',
    firmaId: o.firmaId != null ? o.firmaId : (o.req && o.req.user ? activeId(o.req) : null),
    action, detail: detail || '',
    ...(ip ? { ip } : {}),
    ...(viaAdmin ? { viaAdmin } : {}),
  };
  d.audit.push(record);
  auditLog.append(record); // proba DURABILA append-only pe disc (supravietuieste rolarii + pierderii bazei)
  // Plafon in baza VIE (rulaj) — doar pentru RAM/UI. Proba DURABILA nu depinde de el:
  // fiecare eveniment e deja scris append-only in data/audit/*.ndjson (auditLog.append),
  // fisiere lunare incluse in backupul zilnic offsite si descarcabile prin /api/audit/durable.
  // Rolarea de aici NU pierde proba.
  const AUDIT_MAX = Number(process.env.CONTAB_AUDIT_MAX) || 20000;
  if (d.audit.length > AUDIT_MAX) d.audit = d.audit.slice(-AUDIT_MAX);
}

// Gardurile transversale de acces, in ordinea: autentificare (rute publice exceptate),
// mustChange, drepturi granulare (readonly/faraSalarii), paywall per-firma, plafon pe
// exporturile mari, urma de business pe exporturi: src/bootstrap.js (applySecurityGuards).
bootstrap.applySecurityGuards(app, { logAudit, activeId });
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Necesita drepturi de administrator.' });
  next();
}

// Setari de cont si securitate (2FA, sesiuni, parola, profil): src/routes/account.js
require('./src/routes/account')(app, { logAudit });

// Backup/restaurare + SMTP (admin): src/routes/backup.js — intoarce doBackup (folosit si de jobul zilnic).
const { doBackup } = require('./src/routes/backup')(app, { requireAdmin, upload, logAudit, wrap });
// Mesaje (suport user <-> admin): src/routes/messages.js
require('./src/routes/messages')(app, { requireAdmin, upload, logAudit });


// ── Abonamente (planuri + trial) ──
// Prețurile sunt publice (vizibile pe pagina de înscriere, fără autentificare).
// Abonament / plati Stripe (planuri, checkout, portal, webhook, proba/select, activare admin): src/routes/billing.js
require('./src/routes/billing')(app, { requireAdmin, logAudit, activeId });

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

// ─────────────────── AUTENTIFICARE SI CONT: src/authRoutes.js ───────────────────
// login/2FA, demo, inscriere firma, logout, resetare parola, impersonare, /api/me,
// /api/meta, health, metrics, audit. Intoarce map-urile de rate-limit (inscriere +
// resetare parola), curatate periodic de jobul rate-limit-hygiene (mai jos).
const { registerAttempts, forgotAttempts, clientErrAttempts } = require('./src/authRoutes')(app, { logAudit, wrap, requireAdmin, activeId, S });

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

// Cine acceseaza aplicatia (admin): sesiuni active + istoricul autentificarilor, cu IP si locatie
require('./src/routes/access')(app, { requireAdmin, wrap });

// Configurare (companie, logo, chitanta, setari, cote fiscale): src/routes/config.js
require('./src/routes/config')(app, { S, activeId, logAudit, requireAdmin, upload });

// Nomenclatoare (parteneri, import CSV, conversie XLSX/XLS/DBF) + solduri initiale: src/routes/partners.js
require('./src/routes/partners')(app, { upload, S, activeId, logAudit, requireAdmin });

// Documente primare: upload (extragere AI/reguli locale), servire fisier, galerii primite/emise: src/routes/documents.js
require('./src/routes/documents')(app, { upload, wrap, S, activeId, allowedFirme, logAudit, buildEntry, upsertPartner });

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

/**
 * Compune articolul contabil COMPLET, dar FARA identitate. Separarea exista pentru ca
 * previzualizarea din formular (POST /api/preview) sa treaca prin exact aceleasi reguli ca
 * salvarea — auto50, pro-rata, TVA la incasare, existenta conturilor, blocarea perioadei —
 * fara sa consume un id din secventa (`db.nextId` incrementeaza `seq`, deci ar lasa goluri).
 * Sursa UNICA a regulilor contabile: frontend-ul nu le mai reimplementeaza.
 * Nu scrie nimic; doar citeste firma si planul de conturi.
 */
function composeEntry(tipId, fields, fileId, firmaId) {
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
  // mesaj catre UTILIZATOR (deci cu diacritice): il vede la fiecare formular inca necompletat,
  // fiindca previzualizarea trece prin aceeasi compunere.
  if (!lines.length) throw new Error('Completează cel puțin o sumă (bază, TVA sau total) înainte de salvare.');
  // TVA partial deductibila (auto 50% mai jos, pro-rata dupa el): partea nededusa se muta in
  // linia de COST, deci baza si cota facturii nu se mai pot reconstitui din liniile articolului
  // (raportul TVA-dedus/baza-din-linii da o cota fantoma: 105/1105 = 10%). Le memoram pe articol,
  // ca la TVA la incasare (`tvaExig`), fiindca jurnalul de cumparari, D300 si D394 au nevoie de
  // factura asa cum a fost emisa, nu de urma ei contabila.
  const vatL0 = lines.find((l) => l.debit === '4426');
  const tvaFactura = vatL0 ? round2(vatL0.suma) : 0;
  const bazaFactura = vatL0 ? round2(lines
    .filter((l) => l !== vatL0 && !['4426', '4427', '4428'].includes(l.debit))
    .reduce((s, l) => s + l.suma, 0)) : 0;
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
  // Amandoua regulile muteaza `vatL0.suma` pe loc, deci aici e TVA-ul ramas deductibil. Marcajul
  // se pune doar cand chiar s-a nededus ceva (facturile normale raman fara camp suplimentar).
  const tvaPartial = (vatL0 && tvaFactura > 0 && vatL0.suma !== tvaFactura) ? {
    baza: bazaFactura,
    cota: bazaFactura > 0 ? Math.round((tvaFactura / bazaFactura) * 100) : (Number(f.cota) || 0),
    tvaFactura,
    tvaDedusa: round2(vatL0.suma),
  } : null;
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
  // Codul de bun art. 331 (op11 din D394): validat la introducere, nu la depunere — o valoare
  // gresita ar trece pana la validatorul ANAF si ar respinge toata declaratia. Lipsa nu blocheaza
  // salvarea (articolul poate fi completat mai tarziu); o semnaleaza validarea pre-depunere.
  let codCategorie331 = 0;
  if (f.codCategorie331 != null && f.codCategorie331 !== '' && Number(f.codCategorie331) !== 0) {
    codCategorie331 = Number(f.codCategorie331);
    if (!D394_COD_331.has(codCategorie331)) {
      throw new Error('Cod categorie bun invalid: ' + f.codCategorie331
        + '. Nomenclatorul D394 acceptă pentru persoane juridice doar codurile '
        + [...D394_COD_331].join(', ') + '.');
    }
  }
  const data = f.data || new Date().toISOString().slice(0, 10);
  // Blocarea perioadei: nu se inregistreaza in luni inchise (protejeaza fata de declaratiile depuse).
  if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) {
    throw new Error('Perioada ' + periodOf(data) + ' este inchisa (blocata pana la ' + firma.lockedUntil + '). Un administrator o poate debloca din Setari → Blocare perioada.');
  }
  // nomenclatorul de parteneri se actualizeaza din ruta (upsertPartner), DUPA ce articolul e validat si adaugat
  return {
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
    // Marcajul auto50 se PASTREAZA pe articol, nu doar se consuma la compunere: efectul lui pe TVA
    // (art. 298) intra in linii si se pierde, dar art. 25(3)(l) face nedeductibila si jumatate din
    // CHELTUIALA, iar asta se calculeaza abia la finalul anului — atunci steagul nu mai exista.
    ...(f.auto50 ? { auto50: true } : {}),
    ...(tvaPartial ? { tvaPartial } : {}), // factura reala, cand TVA-ul e doar partial deductibil
    ...(codCategorie331 ? { codCategorie331 } : {}), // categoria de bun art. 331, pentru op11 din D394
    fileId: fileId || null,
    system: false,
    lines,
  };
}

// Articolul gata de salvare = compunerea + identitatea. `id` ramane primul camp (ordinea din
// serializari si din testele care compara forma articolului).
function buildEntry(tipId, fields, fileId, firmaId) {
  return Object.assign({ id: db.nextId('e') }, composeEntry(tipId, fields, fileId, firmaId));
}

// Contracte de leasing (nomenclator + grafic de rate pe luni): src/routes/leasing.js
require('./src/routes/leasing')(app, { activeId, logAudit });

// Articole contabile + recurente + blocare perioada + TVA la incasare: src/routes/entries.js
require('./src/routes/entries')(app, { S, activeId, canAccess, requireAdmin, logAudit, buildEntry, composeEntry, upsertPartner });
// Productie + retete (BOM): src/routes/production.js
require('./src/routes/production')(app, { S, activeId, logAudit });

// Inchideri fiscale (TVA, an, impozit pe profit, repartizare rezultat): src/routes/closings.js
require('./src/routes/closings')(app, { S, activeId, logAudit });
require('./src/routes/monthlyClose')(app, { activeId, logAudit });

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

// ── RO e-Transport (cod UIT pentru transportul de bunuri; acelasi OAuth SPV ca e-Factura) ──
require('./src/routes/etransport')(app, { activeId, wrap, logAudit });


// Generarea XML declaratii (e-Factura, D300/D394/D390/D205/D112, SAF-T) + validare: src/routes/declarationsXml.js
require('./src/routes/declarationsXml')(app, { S, activeId, canAccess, wrap });

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
require('./src/routes/reports')(app, { S, wrap, activeId });
// Fisierul de plati (pain.001) — dupa `S`, ca orice ruta care lucreaza pe vederea scoped.
require('./src/routes/plati')(app, { S, activeId, logAudit });
// Preluarea unei firme din alt program (balanta -> solduri de preluare).
require('./src/routes/migrare')(app, { activeId, logAudit, upload });
// numerotare secventiala a documentelor de stoc (serie + numar), per firma si tip
// Documente de gestiune (situatii stoc, serii NIR/BC/AVIZ, NIR/bon/aviz, fisa magazie, nota PDF): src/routes/stockdocs.js
// Seriile de documente stau in service layer (src/stocksService.js); config.js le primeste prin ctx (chitanta CH).
require('./src/routes/stockdocs')(app, { S, activeId, canAccess });

// Utilitare demo (reset/snapshot) + incarcarea exemplului din ghid (admin): src/routes/demo.js
// Intoarce resetDemo, folosit si de jobul zilnic de reset al contului demo (mai jos).
const { resetDemo, ensureDemoContabil } = require('./src/routes/demo')(app, { requireAdmin, logAudit });
// Provisioning idempotent al perechii demo (patron + demo-contabil) DUPA hidratarea bazei — pe pg
// hidratarea e async, deci nu se poate face la register (baza inca goala). No-op fara cont demo.
dbReady.then(() => { try { if (ensureDemoContabil()) db.save(); } catch (e) { console.error('ensureDemoContabil:', e.message); } });

// Joburile periodice (backup zilnic, digest termene, demo-reset, igiena rate-limit,
// auto-poll SPV): src/jobs.js — primeste doar dependintele de stare ale aplicatiei.
require('./src/jobs').start({ doBackup, resetDemo, registerAttempts, forgotAttempts, clientErrAttempts });

// Handler global de erori — DUPA toate rutele — si plasele de siguranta pe proces
// (uncaughtException/unhandledRejection): src/serverErrors.js.
serverErrors.installErrorHandler(app);
serverErrors.installProcessGuards();

// Guard single-instance pe fisierul bazei + listen dupa hidratare + oprire curata: src/lifecycle.js
require('./src/lifecycle').start({ app, dbReady });

module.exports = { app, buildEntry, upsertPartner };
