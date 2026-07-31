'use strict';

// Service layer pentru firme: creare, editare, activare, stergere, abonare (billing per-firma)
// si export/import complet (JSON + ZIP cu fisierele scanate) pentru migrare/arhivare.
// Rutele (src/routes/firme.js) raman puncte de intrare subtiri.
//
// Autorizare DUBLATA la nivel de serviciu: apartenenta utilizatorului la firma (allowedFirme),
// blocajul contului demo si garda de admin se verifica AICI, nu doar in ruta — un apelant
// viitor care ar ocoli middleware-ul primeste 403, nu acces. Erorile poarta `status` (HTTP).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const zipGuard = require('./zipGuard');
const db = require('./db');
const plans = require('./plans');
const billing = require('./billing');
const { capList } = require('./paginate');
const { naturalCompare } = require('./util');
const backup = require('./backup');
const identitate = require('./identitate');
const { cuiKey } = identitate;
const { allowedFirme, isDemoUser } = require('./session');

// `code` (optional) e un marcaj STABIL pentru client, cand raspunsul cere o actiune anume in
// interfata. Textul mesajului nu e contract: se rescrie oricand, si o potrivire pe el ar
// pica tacut la prima reformulare.
function fail(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; throw e; }

/** Conturile demo (public, partajate) nu adauga si nu gestioneaza firme. */
function reqNotDemo(user) {
  if (isDemoUser(user)) fail(403, 'Contul demo nu poate adăuga sau gestiona firme. Înscrie-ți firma ta (gratuit 30 de zile) dintr-un cont propriu.');
}

/** Apartenenta utilizatorului la firma (adminul le are pe toate). `msg` pastreaza textele istorice per ruta. */
function reqAccess(user, id, msg) {
  if (!user || !allowedFirme(user).includes(Number(id))) fail(403, msg || 'Fara acces la aceasta firma.');
  return Number(id);
}

/** Garda de admin (dublura requireAdmin din ruta). */
function reqAdmin(user) {
  if (!user || user.role !== 'admin') fail(403, 'Doar administratorul.');
}

// ───────────── O firma, o singura evidenta: poarta pe CUI ─────────────
// Doua inregistrari ale aceleiasi firme inseamna doua adevaruri contabile pentru acelasi CUI:
// balante care nu se potrivesc, declaratii depuse din locul gresit. Firma se inscrie O SINGURA
// data, de catre patronul ei; oricine altcineva CERE acces la cea existenta.
//
// Refuzul spune ca firma exista — deci ecranul poate fi folosit ca sa afli daca un CUI e in
// aplicatie. Am acceptat deliberat scurgerea: e singurul mod de a-l trimite pe om spre calea
// corecta („cere acces") in loc sa-l lasi sa-si construiasca o evidenta paralela. Ce NU se
// divulga: cine e proprietarul, ce denumire are, de cand exista. Iar caile care ajung aici sunt
// plafonate (inscriere: 5/ora/IP; API: CONTAB_RATE_API).
const CUI_DUPLICAT = 'Există deja o firmă cu acest CUI în aplicație. Nu o înregistra a doua oară — '
  + 'cere acces la ea după CUI, din „Firmele mele". Proprietarul aprobă, și lucrezi pe evidența reală.';

/** Firma existenta cu acelasi CUI (comparatie normalizata), sau null. `exceptId` sare peste ea insasi. */
function firmaDupaCui(cui, exceptId) {
  const key = cuiKey(cui);
  if (!key) return null;
  return db.get().firme.find((x) => x.id !== exceptId && cuiKey(x.cui) === key) || null;
}

/** Refuza CUI-ul deja folosit de alta firma. 409: conflict, nu „date gresite". */
function reqCuiLiber(cui, exceptId) {
  if (firmaDupaCui(cui, exceptId)) fail(409, CUI_DUPLICAT);
}

/** CNP-ul patronului, obligatoriu ca sa poti detine firme: proprietarul e o PERSOANA identificata,
 *  nu doar un nume de utilizator. Fara el nu s-ar sti pe cine intreaba aplicatia la cererile de acces. */
function reqCnp(user) {
  if (user.role === 'admin') return;
  const cnp = ((user.profil || {}).cnp) || '';
  if (!identitate.validCNP(cnp)) {
    fail(400, 'Ca să înscrii o firmă, completează-ți întâi CNP-ul — firmele se înregistrează pe o '
      + 'persoană identificată, iar ea aprobă cine primește acces la ele.', 'CNP_LIPSA');
  }
}

function createFirma(user, b) {
  reqNotDemo(user); b = b || {};
  // Formularul din aplicatie inscrie firme PROPRII: CUI obligatoriu si valid (cifra de control),
  // liber, si patron identificat. La inscrierea publica (authRoutes) CUI-ul ramane optional —
  // acolo se creeaza contul si firma deodata, iar cerinta ar rupe intrarea in aplicatie.
  if (user.role !== 'admin') {
    reqCnp(user);
    if (!identitate.validCUI(b.cui)) fail(400, 'CUI invalid. Scrie codul fiscal al firmei (ex. RO14399840) — cifra de control nu se potrivește.');
    reqCuiLiber(b.cui);
  } else if (b.cui) { reqCuiLiber(b.cui); }
  const d = db.get();
  const id = db.nextFirmaId();
  const f = Object.assign(db.defaultFirma(id), {
    nume: b.nume || ('Firma ' + id), cui: b.cui || '', regCom: b.regCom || '',
    adresa: b.adresa || '', oras: b.oras || '', judet: b.judet || 'RO-B',
    tvaPlatitor: b.tvaPlatitor != null ? !!b.tvaPlatitor : true,
    tipEntitate: b.tipEntitate === 'pfa' ? 'pfa' : 'srl',
  }, { id });
  // PROPRIETARUL firmei: cine a creat-o. El — si numai el — aproba cererile de acces ale altor
  // conturi (contabili care preiau firma). Pana acum accesul era o simpla lista `user.firme`, in
  // care toti membrii erau egali si nu exista pe cine intreba.
  if (user.role !== 'admin') f.ownerId = user.id;
  // Billing per-firma: firma noua a unui utilizator porneste cu proba de 30 de zile (apoi abonament).
  // Firmele create de admin sunt active direct (adminul nu e taxat).
  f.subscription = user.role === 'admin'
    ? { status: 'active', plan: 'grandfathered', since: new Date().toISOString() }
    : plans.firmaTrialSub();
  d.firme.push(f);
  d.partners[id] = {}; d.openingBalances[id] = {};
  // utilizatorul care creeaza firma capata acces (adminul are oricum)
  if (user.role !== 'admin') { user.firme = user.firme || []; user.firme.push(id); }
  user.firmaActiva = id;
  db.save();
  return { firma: f, firmaActiva: id };
}

// ───────────────────── CERERI DE ACCES LA O FIRMA EXISTENTA ─────────────────────
// Un contabil care preia o firma nu si-o mai creeaza a doua oara (ar fi o firma goala, dublura),
// ci CERE acces la cea existenta. Cererea o aproba PROPRIETARUL (firma.ownerId) — accesul la
// datele contabile ale altcuiva nu se ia, se primeste.

/**
 * Cerere de acces la firma cu CUI-ul dat.
 * Raspunsul e VOIT identic fie ca firma exista sau nu: altfel ecranul devine un oracol prin care
 * oricine cu un cont poate afla ce firme sunt in sistem, incercand CUI-uri. Acelasi rationament
 * ca la resetarea parolei.
 */
function cerereAcces(user, cui) {
  reqNotDemo(user);
  const key = cuiKey(cui);
  if (!key) fail(400, 'Completează CUI-ul firmei.');
  const d = db.get();
  d.accessRequests = d.accessRequests || [];
  const generic = { ok: true, message: 'Dacă firma există în aplicație, proprietarul ei a primit cererea ta și îți va răspunde.' };
  const f = (d.firme || []).find((x) => cuiKey(x.cui) === key);
  // firma inexistenta, fara proprietar (creata de admin), sau esti deja membru -> acelasi raspuns
  if (!f || !f.ownerId) return generic;
  if ((user.firme || []).includes(f.id) || f.ownerId === user.id) return generic;
  // o cerere in asteptare e de ajuns; re-trimiterea nu creeaza duplicate si nu spune nimic in plus
  const existenta = d.accessRequests.find((r) => r.firmaId === f.id && r.userId === user.id && r.status === 'in_asteptare');
  if (existenta) return generic;
  d.accessRequests.push({
    id: db.nextId('acc'),
    firmaId: f.id, userId: user.id, ts: new Date().toISOString(), status: 'in_asteptare',
  });
  db.save();
  return generic;
}

/** Cererile in asteptare pentru firmele al caror PROPRIETAR e utilizatorul. */
function cereriPrimite(user) {
  const d = db.get();
  const aleMele = new Set((d.firme || []).filter((f) => f.ownerId === user.id).map((f) => f.id));
  const out = (d.accessRequests || [])
    .filter((r) => r.status === 'in_asteptare' && aleMele.has(r.firmaId))
    .map((r) => {
      const u = (d.users || []).find((x) => x.id === r.userId) || {};
      const f = db.getFirma(r.firmaId) || {};
      return { id: r.id, firmaId: r.firmaId, firma: f.nume || '', ts: r.ts, username: u.username || '', email: u.email || '' };
    });
  return capList(out, 0, 'cereri-acces').items;
}

/** Aprobare/respingere — DOAR proprietarul firmei din cerere. */
function decideCerere(user, id, aprob) {
  reqNotDemo(user);
  const d = db.get();
  const r = (d.accessRequests || []).find((x) => String(x.id) === String(id));
  if (!r || r.status !== 'in_asteptare') fail(404, 'Cererea nu mai există sau a fost deja rezolvată.');
  const f = db.getFirma(r.firmaId);
  if (!f) fail(404, 'Firma nu mai există.');
  // garda esentiala: proprietarul, nu „oricine are acces" — altfel un colaborator adaugat ieri
  // ar putea da mai departe acces la datele patronului
  if (f.ownerId !== user.id) fail(403, 'Doar proprietarul firmei poate decide cererile de acces.');
  r.status = aprob ? 'aprobata' : 'respinsa';
  r.decidedBy = user.id; r.decidedAt = new Date().toISOString();
  if (aprob) {
    const u = (d.users || []).find((x) => x.id === r.userId);
    if (!u) fail(404, 'Contul care a cerut accesul nu mai există.');
    u.firme = u.firme || [];
    if (!u.firme.includes(f.id)) u.firme.push(f.id);
  }
  db.save();
  return { ok: true, status: r.status, firma: f.nume || '', firmaId: f.id };
}

// ═══════════ ANGAJAREA UNUI CONTABIL: patron -> contabil (sensul invers) ═══════════
// `accessRequests` merge dinspre contabil („preiau firma asta, ma lasi?"). Aici e drumul celalalt:
// patronul isi cauta un contabil in lista celor inscrisi si ii trimite o CERERE DE SERVICII.
// Simetria e importanta — accesul la datele unei firme se da si se primeste prin acord explicit,
// indiferent cine incepe discutia. Cine decide e mereu celalalt: contabilul ACCEPTA sau refuza.

/** Proiectia publica a unui contabil din lista — fara email, fara CNP, fara firmele lui. */
function contabilPublic(u) {
  const p = u.profil || {};
  return {
    id: u.id,
    username: u.username,
    nume: p.numeComplet || u.username,
    oras: p.oras || '', judet: p.judet || '',
    telefon: p.telefon || '',
    autorizatie: p.autorizatie || '',
    descriere: p.descriere || '',
    tip: plans.userKind(u),
  };
}

/**
 * Contabilii inscrisi in aplicatie care s-au declarat DISPONIBILI (profil.disponibilContabil).
 * Optiunea e explicita, nu dedusa din abonament: lista conturilor aplicatiei nu se publica singura,
 * iar cine nu vrea clienti noi nu apare. Cine se inscrie in lista accepta sa i se vada datele de
 * contact — de asta campurile intoarse sunt exact cele completate pentru asta.
 */
function listaContabili(user) {
  reqNotDemo(user);
  const out = db.get().users
    .filter((u) => u.role !== 'admin' && !u.pending && u.id !== user.id && (u.profil || {}).disponibilContabil)
    .map(contabilPublic)
    .sort((a, b) => naturalCompare(a.nume, b.nume)); // colator refolosit (vezi util.js), nu localeCompare per comparatie
  return capList(out, 0, 'contabili').items;
}

/** Firma din cerere trebuie sa fie a TA: angajarea unui contabil e decizia proprietarului. */
function reqProprietar(user, fid) {
  const f = db.getFirma(Number(fid));
  if (!f) fail(404, 'Firma nu exista.');
  if (f.ownerId !== user.id) fail(403, 'Doar proprietarul firmei poate angaja un contabil pentru ea.');
  return f;
}

/** Patronul trimite unui contabil cererea de a-i tine contabilitatea firmei `fid`. */
function cerereServicii(user, fid, b) {
  reqNotDemo(user); b = b || {};
  const f = reqProprietar(user, fid);
  const d = db.get();
  const c = d.users.find((x) => x.id === Number(b.contabilId));
  // aceeasi conditie ca la listare: nu se poate trimite cerere unui cont care nu s-a oferit
  if (!c || c.role === 'admin' || c.pending || !(c.profil || {}).disponibilContabil) fail(404, 'Contabilul nu mai este în lista celor disponibili.');
  if (c.id === user.id) fail(400, 'Nu îți poți trimite ție cererea.');
  if ((c.firme || []).includes(f.id)) fail(400, c.username + ' are deja acces la această firmă.');
  d.serviceRequests = d.serviceRequests || [];
  const dubla = d.serviceRequests.find((r) => r.firmaId === f.id && r.contabilId === c.id && r.status === 'in_asteptare');
  if (dubla) fail(400, 'Ai deja o cerere în așteptare la acest contabil pentru firma respectivă.');
  const r = {
    id: db.nextId('srv'),
    firmaId: f.id, ownerId: user.id, contabilId: c.id,
    mesaj: String(b.mesaj || '').slice(0, 1000).trim(),
    ts: new Date().toISOString(), status: 'in_asteptare',
  };
  d.serviceRequests.push(r);
  db.save();
  // acelasi nume ca in lista din care a fost ales (profil, altfel contul) — mesajul de confirmare
  // trebuie sa spuna cui i-ai trimis, nu un identificator pe care patronul nu l-a vazut niciodata
  return { ok: true, id: r.id, contabil: (c.profil || {}).numeComplet || c.username, firma: f.nume || '', firmaId: f.id };
}

/** Cererile de servicii care ma privesc: primite (sunt contabilul) si trimise (sunt patronul). */
function cereriServicii(user) {
  const d = db.get();
  const all = d.serviceRequests || [];
  const numeFirma = (id) => (db.getFirma(id) || {}).nume || '';
  // numele afisat: cel din profil daca exista, altfel contul — in tabel „Maria Contabil" spune
  // mai mult decat „contabil", iar patronul tocmai dupa nume l-a ales din lista
  const numeUser = (id) => {
    const u = (d.users || []).find((x) => x.id === id);
    return u ? ((u.profil || {}).numeComplet || u.username) : '';
  };
  const primite = all.filter((r) => r.contabilId === user.id && r.status === 'in_asteptare')
    .map((r) => ({ id: r.id, firmaId: r.firmaId, firma: numeFirma(r.firmaId), patron: numeUser(r.ownerId), mesaj: r.mesaj || '', ts: r.ts }));
  const trimise = all.filter((r) => r.ownerId === user.id)
    .map((r) => ({ id: r.id, firmaId: r.firmaId, firma: numeFirma(r.firmaId), contabil: numeUser(r.contabilId), status: r.status, ts: r.ts }));
  return {
    primite: capList(primite, 0, 'servicii-primite').items,
    trimise: capList(trimise, 0, 'servicii-trimise').items,
  };
}

/** Contabilul accepta sau refuza. Acceptarea ii da acces la firma — echivalentul aprobarii de acces. */
function decideServicii(user, id, accept) {
  reqNotDemo(user);
  const d = db.get();
  const r = (d.serviceRequests || []).find((x) => String(x.id) === String(id));
  if (!r || r.status !== 'in_asteptare') fail(404, 'Cererea nu mai există sau a fost deja rezolvată.');
  // garda esentiala: DESTINATARUL decide, nu proprietarul cererii — altfel patronul si-ar putea
  // baga singur contabilul in firma, adica i-ar impune munca fara acord
  if (r.contabilId !== user.id) fail(403, 'Doar contabilul căruia i-ai trimis cererea poate răspunde.');
  const f = db.getFirma(r.firmaId);
  if (!f) fail(404, 'Firma nu mai există.');
  r.status = accept ? 'acceptata' : 'refuzata';
  r.decidedAt = new Date().toISOString();
  if (accept) {
    user.firme = user.firme || [];
    if (!user.firme.includes(f.id)) user.firme.push(f.id);
  }
  db.save();
  return { ok: true, status: r.status, firma: f.nume || '', firmaId: f.id };
}

/** Patronul isi retrage o cerere netrimisa inca la capat (sau pe cea la care nu mai vrea raspuns). */
function retrageServicii(user, id) {
  reqNotDemo(user);
  const d = db.get();
  const r = (d.serviceRequests || []).find((x) => String(x.id) === String(id));
  if (!r || r.status !== 'in_asteptare') fail(404, 'Cererea nu mai există sau a fost deja rezolvată.');
  if (r.ownerId !== user.id) fail(403, 'Doar cel care a trimis cererea o poate retrage.');
  r.status = 'retrasa';
  r.decidedAt = new Date().toISOString();
  db.save();
  return { ok: true, status: r.status };
}

/** Import (JSON sau din ZIP, prin importZip): mode replace SUPRASCRIE firma activa — cu plasa
 *  de siguranta salvata pe server inainte; altfel fisierul devine o firma NOUA (id-uri remapate). */
function importBundle(user, bundle, opts) {
  reqNotDemo(user);
  const o = opts || {};
  let targetFid = null;
  if (o.replace) {
    targetFid = Number(o.activeFid);
    if (!allowedFirme(user).includes(targetFid)) fail(403, 'Fara acces la firma activa.');
    // plasa de siguranta: starea curenta a firmei, salvata pe server inainte de suprascriere
    try {
      const dir = path.join(db.DATA_DIR, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      try { fs.chmodSync(dir, 0o700); } catch (_) { /* best-effort */ }
      const preRestore = path.join(dir, 'pre-restore-firma' + targetFid + '-' + Date.now() + '.json');
      fs.writeFileSync(preRestore, JSON.stringify(db.exportFirma(targetFid)), { mode: 0o600 });
      try { fs.chmodSync(preRestore, 0o600); } catch (_) { /* best-effort */ }
      backup.prunePreRestoreBackups(db.DATA_DIR, Number(process.env.CONTAB_BACKUP_KEEP_PRE_RESTORE) || 10);
    } catch (e) { console.error('pre-restore backup:', e.message); }
  }
  let newFid;
  try { newFid = db.importFirma(bundle, { storedNameMap: o.storedNameMap, targetFid }); }
  catch (e) { fail(400, e.message); }
  if (!targetFid && user && user.role !== 'admin') { user.firme = user.firme || []; user.firme.push(newFid); }
  // firma importata ca FIRMA NOUA fara abonament in pachet ar lovi paywall-ul imediat;
  // primeste aceleasi conditii ca la creare (proba 30 zile; adminul — activa direct).
  // La replace sau cand pachetul aduce abonamentul propriu (migrare), nu se atinge nimic.
  if (!targetFid && user) {
    const nf = db.getFirma(newFid);
    if (nf && !nf.subscription) {
      nf.subscription = user.role === 'admin'
        ? { status: 'active', plan: 'grandfathered', since: new Date().toISOString() }
        : plans.firmaTrialSub();
    }
  }
  if (user) user.firmaActiva = newFid;
  db.save();
  return { firmaId: newFid, replaced: !!targetFid };
}

/** Validarea pachetului firma.json INAINTE de orice scriere: structura minima + limite
 *  (colectiile trebuie sa fie array-uri, plafonate — un JSON malitios nu ajunge in graf). */
const BUNDLE_COLLS = ['entries', 'documents', 'assets', 'angajati', 'payrollHistory', 'products',
  'gestiuni', 'stockMovements', 'inventories', 'openingAnalytic', 'declarations'];
const BUNDLE_MAX_ITEMS = 500000; // total elemente in toate colectiile
function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) fail(400, 'Pachet de firma invalid.');
  if (!bundle.firma || typeof bundle.firma !== 'object' || Array.isArray(bundle.firma)) fail(400, 'Pachetul nu contine obiectul firma.');
  let total = 0;
  for (const k of BUNDLE_COLLS) {
    if (bundle[k] == null) continue;
    if (!Array.isArray(bundle[k])) fail(400, `Colectia "${k}" din pachet nu este o lista.`);
    total += bundle[k].length;
  }
  if (total > BUNDLE_MAX_ITEMS) fail(400, 'Pachetul depaseste limita de elemente importabile.');
}

/** Restaurare din ZIP — TRANZACTIONAL: (1) garda anti zip-bomb, (2) validarea pachetului
 *  inainte de orice scriere, (3) fisierele intra intr-un director de STAGING din uploads
 *  si sunt mutate la loc doar dupa ce importul in baza a reusit; la orice esec staging-ul
 *  dispare integral (fara atasamente orfane). */
function importZip(user, fileBuffer, opts) {
  reqNotDemo(user);
  if (!fileBuffer) fail(400, 'Niciun fisier primit.');
  let staging = null;
  try {
    // (1) limitele arhivei se verifica INAINTE de a citi vreun octet dezarhivat
    const { zip, entries } = zipGuard.openGuarded(fileBuffer);
    const je = zip.getEntry('firma.json');
    if (!je) fail(400, 'Arhiva nu contine firma.json — nu pare o copie Contabo.');
    let bundle;
    try { bundle = JSON.parse(zip.readAsText(je)); } catch (e) { fail(400, 'firma.json din arhiva nu este JSON valid.'); }
    validateBundle(bundle); // (2) nimic pe disc pana nu stim ca pachetul e sanatos
    // colecteaza fisierele; numele duplicate ar produce atasamente orfane -> respinse
    const fileEntries = []; const seen = new Set();
    for (const en of entries) {
      if (en.isDirectory || !en.entryName.startsWith('files/')) continue;
      const base = path.basename(en.entryName);
      if (!base) continue;
      if (seen.has(base)) fail(400, `Arhiva contine fisierul "${base}" de mai multe ori.`);
      seen.add(base);
      fileEntries.push({ en, base });
    }
    // (3) staging in acelasi filesystem cu uploads => mutarea finala e rename, nu copiere
    staging = fs.mkdtempSync(path.join(db.UPLOAD_DIR, '.import-'));
    const storedNameMap = {}; const mutari = [];
    for (const { en, base } of fileEntries) {
      const newName = crypto.randomBytes(8).toString('hex') + (path.extname(base) || '.bin');
      fs.writeFileSync(path.join(staging, newName), en.getData());
      mutari.push(newName);
      storedNameMap[base] = newName;
    }
    const r = importBundle(user, bundle, Object.assign({}, opts, { storedNameMap }));
    // commit: abia acum fisierele devin vizibile in uploads (rename pe acelasi fs)
    for (const n of mutari) fs.renameSync(path.join(staging, n), path.join(db.UPLOAD_DIR, n));
    fs.rmSync(staging, { recursive: true, force: true });
    staging = null;
    return Object.assign(r, { files: mutari.length });
  } catch (e) {
    if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
    if (e.status) throw e;
    fail(400, e.message);
  }
}

/** Ramura de testare: cloneaza firma intr-o copie marcata [TEST] si comuta utilizatorul pe ea. */
function testClone(user, id) {
  reqNotDemo(user);
  reqAccess(user, id);
  try {
    const src = db.getFirma(id) || {};
    const newFid = db.importFirma(db.exportFirma(id));
    const nf = db.getFirma(newFid);
    if (nf) { nf.nume = '[TEST] ' + String(src.nume || 'Firma').replace(/^\[TEST\]\s*/, ''); nf.test = true; }
    user.firmaActiva = newFid;
    if (user.role !== 'admin') { user.firme = user.firme || []; user.firme.push(newFid); }
    db.save();
    return { firmaId: newFid, nume: nf ? nf.nume : '' };
  } catch (e) { if (e.status) throw e; fail(400, e.message); }
}

function firmaSlug(bundle) {
  return String((bundle.firma && bundle.firma.nume) || 'firma').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'firma';
}

/** Pachetul JSON portabil al unei firme (cu verificarea apartenentei). */
function exportBundle(user, id) {
  reqAccess(user, id, 'Firma neautorizata.');
  const bundle = db.exportFirma(Number(id));
  return { bundle, slug: firmaSlug(bundle) };
}

// ZIP-ul complet al unei firme: firma.json + fisierele scanate atasate (files/*). Intern, fara autorizare.
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

/** Copie completa (ZIP) a unei firme (cu verificarea apartenentei). */
function exportZip(user, id) {
  reqAccess(user, id, 'Firma neautorizata.');
  return firmaZipBuffer(Number(id));
}

/** Admin: TOATE firmele intr-o singura arhiva — cate un ZIP separat per firma (restaurabil individual). */
function exportAllZip(user) {
  reqAdmin(user);
  const outer = new AdmZip();
  let n = 0;
  for (const f of db.get().firme) {
    const z = firmaZipBuffer(f.id);
    outer.addFile('firma-' + f.id + '-' + z.slug + '.zip', z.buffer);
    n++;
  }
  return { buffer: outer.toBuffer(), n };
}

function updateFirma(user, id, body) {
  reqAccess(user, id);
  const f = db.getFirma(id);
  if (!f) fail(404, 'Firma inexistenta');
  // fara asta poarta se ocolea in doi pasi: creezi firma fara CUI, apoi ii pui CUI-ul altei firme
  if (body && body.cui != null && cuiKey(body.cui) !== cuiKey(f.cui)) reqCuiLiber(body.cui, f.id);
  // allowlist de profil — la fel ca updateCompany; campurile sensibile au rute dedicate
  Object.assign(f, db.pickFirmaFields(body), { id: f.id });
  db.save();
  return { firma: f };
}

function activateFirma(user, id) {
  reqAccess(user, id);
  user.firmaActiva = Number(id);
  db.save();
  return { firmaActiva: user.firmaActiva };
}

/** ADMIN: seteaza/suprascrie abonamentul unei firme (suport, migrare, corectii) — pe ruta
 *  proprie, cu garda de admin si audit. Restul cailor (updateFirma/updateCompany) NU ating
 *  abonamentul: e camp sensibil, in afara allowlist-ului de profil. */
function setFirmaSubscription(user, id, sub) {
  reqAdmin(user);
  const f = db.getFirma(Number(id));
  if (!f) fail(404, 'Firma inexistenta');
  if (!sub || typeof sub !== 'object') fail(400, 'Abonament invalid.');
  f.subscription = Object.assign({}, sub);
  db.save();
  return { firmaId: f.id, subscription: f.subscription };
}

/** Abonare pe FIRMA (billing strict per-firma): cu Stripe configurat deschide plata (PLATA-GATED —
 *  firma se activeaza abia la webhook); fara Stripe (dev/manual), activare directa pe luna curenta. */
/**
 * A DOUA perioada de proba a unei firme, ceruta explicit de utilizator dupa ce prima a expirat.
 * Nu se acorda automat: prima vine la inscriere, a doua e o alegere constienta de pe ecranul de
 * preturi. Plafonul (plans.TRIAL_MAX) opreste reinnoirea la nesfarsit — dupa el, cardul de proba
 * ramane vizibil, dar inactiv.
 * Garzile sunt DUBLATE aici, nu doar in ruta: apartenenta la firma, blocajul contului demo si
 * plafonul de probe.
 */
function trialDinNou(user, id) {
  reqNotDemo(user);
  reqAccess(user, id);
  const f = db.getFirma(id);
  if (!f) fail(404, 'Firma inexistenta.');
  const st = plans.firmaStatus(f);
  if (st.status === 'active') fail(400, 'Firma are deja abonament activ.');
  if (st.status === 'trial') fail(400, 'Perioada de probă e încă activă — mai ai ' + st.zileRamase + ' zile.');
  if (!plans.firmaPoateProba(f)) fail(400, 'Firma a folosit deja cele ' + plans.TRIAL_MAX + ' perioade de probă. Alege un plan ca să continui.');
  const nr = plans.firmaTrialCount(f) + 1;
  f.subscription = plans.firmaTrialSub(Date.now(), nr);
  db.save();
  return { firmaId: Number(id), nume: f.nume, trialCount: nr, sub: plans.firmaStatus(f) };
}

async function subscribeFirma(user, id, planCerut) {
  reqNotDemo(user);
  reqAccess(user, id);
  const f = db.getFirma(id);
  if (!f) fail(404, 'Firma inexistenta.');
  // planul: din cerere, altfel dupa tipul utilizatorului (contabil -> Pro, necontabil/tester -> Start)
  const plan = planCerut === 'pro' ? 'pro' : planCerut === 'start' ? 'start' : (plans.userKind(user) === 'contabil' ? 'pro' : 'start');
  const luna = new Date().toISOString().slice(0, 7);
  const prev = f.subscription || {};
  if (billing.configured()) {
    // NU deblocam optimist: marcam doar intentia (pendingPlan); starea ramane pana la plata.
    const u = db.get().users.find((x) => x.id === user.id) || user;
    let url;
    try { const s = await billing.createCheckoutSession(u, plan, f.id); url = s.url; }
    catch (e) { fail(400, e.message); }
    f.subscription = Object.assign({}, prev, { pendingPlan: plan, pendingSince: new Date().toISOString() });
    db.save();
    return { plan, url, stripe: true, pending: true };
  }
  f.subscription = {
    status: 'active', plan, since: prev.since || new Date().toISOString(),
    trialEndsAt: prev.trialEndsAt || null,
    abonamente: Object.assign({}, prev.abonamente || {}, { [luna]: plan }),
  };
  db.save();
  return { plan, luna, url: null, stripe: false };
}

/** Stergerea unei firme cu tot cu datele ei. `impersonating`: adminul aflat pe contul altcuiva
 *  NU are drepturile lui de admin aici. */
function deleteFirma(user, id, impersonating) {
  reqNotDemo(user);
  const d = db.get();
  id = Number(id);
  const isAdmin = user.role === 'admin' && !impersonating;
  // Un utilizator obisnuit isi poate sterge doar propriile firme; adminul, orice firma.
  if (!isAdmin && !(user.firme || []).includes(id)) fail(403, 'Fara acces la aceasta firma.');
  // Garda „cel putin o firma ramane": global pentru admin, respectiv in contul utilizatorului.
  const remaining = isAdmin ? d.firme.length : (user.firme || []).length;
  if (remaining <= 1) fail(400, 'Trebuie sa ramana cel putin o firma.');
  d.firme = d.firme.filter((f) => f.id !== id);
  d.entries = d.entries.filter((e) => e.firmaId !== id);
  d.documents = d.documents.filter((x) => x.firmaId !== id);
  d.openingAnalytic = d.openingAnalytic.filter((o) => o.firmaId !== id);
  delete d.partners[id]; delete d.openingBalances[id];
  d.users.forEach((u) => { if (Array.isArray(u.firme)) u.firme = u.firme.filter((x) => x !== id); });
  // daca firma stearsa era cea activa a utilizatorului, muta-l pe prima ramasa a lui
  if (user.firmaActiva === id) user.firmaActiva = (user.firme || [])[0] || (d.firme[0] && d.firme[0].id) || null;
  db.save();
}

// ───────────────────────── Colaboratori pe firma ─────────────────────────
// Orice utilizator cu acces la o firma poate adauga/scoate alt utilizator PE ACEA firma
// (contabil <-> necontabil). Accesul = firmaId in `user.firme`; colaboratorul primeste acces
// COMPLET (fara drepturi restranse la adaugare). Autorizarea „esti membru al firmei" se impune
// de apelant (ruta lucreaza pe firma ACTIVA, care e mereu in allowedFirme).

/** Utilizatorii (non-admin) cu acces la firma `fid`, plus invitatiile in asteptare pentru ea. */
function listCollaborators(fid) {
  fid = Number(fid);
  // proiectie marginita (vezi capList): lista alimenteaza ecranul de colaboratori
  return capList(db.get().users
    .filter((u) => u.role !== 'admin' && Array.isArray(u.firme) && u.firme.includes(fid))
    .map((u) => ({ id: u.id, username: u.username, email: u.email || '', tip: plans.userKind(u), pending: !!u.pending })),
  0, 'colaboratori').items;
}

/** Adauga un cont EXISTENT (dupa username sau email exact) ca membru al firmei `fid`. Idempotent. */
function addExistingCollaborator(fid, b) {
  fid = Number(fid); b = b || {};
  const key = String(b.username || b.email || '').trim().toLowerCase();
  if (!key) fail(400, 'Completează utilizatorul sau emailul colaboratorului.');
  const d = db.get();
  const u = d.users.find((x) => (x.username || '').toLowerCase() === key || (x.email || '').toLowerCase() === key);
  if (!u) fail(404, 'Nu există un cont cu „' + (b.username || b.email) + '". Folosește „Invită prin link" pentru o persoană nouă.');
  if (u.role === 'admin') fail(400, 'Administratorul are deja acces la toate firmele.');
  u.firme = u.firme || [];
  if (u.firme.includes(fid)) fail(400, u.username + ' e deja colaborator pe această firmă.');
  u.firme.push(fid);
  db.save();
  return { id: u.id, username: u.username, email: u.email || '', tip: plans.userKind(u), pending: !!u.pending };
}

/** Creeaza o INVITATIE (pending user) cu acces la firma `fid` — aceeasi forma ca /api/invites.
 *  Intoarce token-ul; ruta construieste linkul (si trimite email daca SMTP e configurat).
 *  Acceptarea foloseste fluxul public existent (GET /api/invite/:token + POST /api/invite/accept). */
function inviteCollaborator(fid, b) {
  fid = Number(fid); b = b || {};
  const username = String(b.username || '').trim();
  if (!username) fail(400, 'Alege un nume de utilizator pentru invitație.');
  const d = db.get();
  if (d.users.some((u) => (u.username || '').toLowerCase() === username.toLowerCase())) fail(400, 'Există deja un cont „' + username + '". Adaugă-l ca „cont existent".');
  const token = crypto.randomBytes(24).toString('hex');
  const u = {
    id: db.nextUserId(), username, email: String(b.email || '').trim(), salt: '', hash: '',
    pending: true, inviteToken: token, inviteExp: Date.now() + 7 * 24 * 3600 * 1000,
    role: 'user', firme: [fid], firmaActiva: fid,
  };
  d.users.push(u);
  db.save();
  return { token, user: { id: u.id, username: u.username, email: u.email || '', tip: plans.userKind(u), pending: true } };
}

/** Scoate colaboratorul `uid` de pe firma `fid`. Refuza adminul, non-colaboratorul si scoaterea
 *  ultimului utilizator (firma nu ramane orfana). */
function removeCollaborator(fid, uid) {
  fid = Number(fid); uid = Number(uid);
  const d = db.get();
  const u = d.users.find((x) => x.id === uid);
  if (!u || u.role === 'admin' || !Array.isArray(u.firme) || !u.firme.includes(fid)) fail(404, 'Utilizatorul nu e colaborator pe această firmă.');
  const membri = d.users.filter((x) => x.role !== 'admin' && Array.isArray(x.firme) && x.firme.includes(fid));
  if (membri.length <= 1) fail(400, 'Nu poți scoate ultimul utilizator al firmei — firma ar rămâne fără acces.');
  u.firme = u.firme.filter((x) => x !== fid);
  if (u.firmaActiva === fid) u.firmaActiva = u.firme[0] || null;
  db.save();
  return { id: u.id, username: u.username };
}

module.exports = {
  trialDinNou, cerereAcces, cereriPrimite, decideCerere,
  firmaDupaCui, reqCuiLiber, reqCnp, CUI_DUPLICAT,
  listaContabili, contabilPublic, cerereServicii, cereriServicii, decideServicii, retrageServicii,
  reqNotDemo, reqAccess, reqAdmin,
  createFirma, importBundle, importZip, testClone,
  exportBundle, exportZip, exportAllZip, firmaSlug,
  updateFirma, activateFirma, setFirmaSubscription, subscribeFirma, deleteFirma,
  listCollaborators, addExistingCollaborator, inviteCollaborator, removeCollaborator,
};
