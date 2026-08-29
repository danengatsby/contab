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
const { ARRAY_COLLS } = require('./store');
const { naturalCompare } = require('./util');
const backup = require('./backup');
const identitate = require('./identitate');
const legal = require('./legalCompliance');
const permissions = require('./permissions');
const { canonicalJson } = require('./globalChain');
const { cuiKey } = identitate;
const { allowedFirme, isDemoUser } = require('./session');

// `code` (optional) e un marcaj STABIL pentru client, cand raspunsul cere o actiune anume in
// interfata. Textul mesajului nu e contract: se rescrie oricand, si o potrivire pe el ar
// pica tacut la prima reformulare.
function fail(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; throw e; }

// Rolurile sunt explicite si in cererile care acorda acces, nu doar in ecranul de colaboratori.
// Pentru un contabil angajat sa poata incepe lucrul, rolul operational implicit este aprobator;
// „vizualizare” ramane disponibil numai cand patronul il alege intentionat.
const COLLAB_ROLES = new Set(['vizualizare', 'operator', 'verificator', 'aprobator']);
function collaboratorRole(role) { return COLLAB_ROLES.has(role) ? role : 'vizualizare'; }
function requestedRole(role) {
  const value = String(role || 'aprobator');
  if (!COLLAB_ROLES.has(value)) fail(400, 'Rol invalid (vizualizare/operator/verificator/aprobator).');
  return value;
}

function accountingOnlyRoles(role) {
  return { contabilitate: collaboratorRole(role), salarizare: permissions.NO_ACCESS, trezorerie: permissions.NO_ACCESS };
}

function accessSelection(b) {
  b = b || {};
  if (!Object.prototype.hasOwnProperty.call(b, 'roluri')) return { base: collaboratorRole(b.rol), domains: null };
  if (!b.roluri || typeof b.roluri !== 'object' || Array.isArray(b.roluri)) {
    fail(400, 'Trimite rolurile pentru Contabilitate, Salarizare și Trezorerie.');
  }
  const domains = permissions.normalizeDomainRoles(b.roluri, collaboratorRole(b.rol));
  const active = permissions.DOMAIN_KEYS.map((key) => domains[key]).filter((role) => role !== permissions.NO_ACCESS);
  if (!active.length) fail(400, 'Acordă acces la cel puțin una dintre arii.');
  return { base: domains.contabilitate !== permissions.NO_ACCESS ? domains.contabilitate : active[0], domains };
}

function setUserFirmAccess(u, fid, selection) {
  u.firmaRoluri = Object.assign({}, u.firmaRoluri || {}, { [fid]: selection.base });
  if (selection.domains) {
    u.firmaRoluriDomenii = Object.assign({}, u.firmaRoluriDomenii || {}, { [fid]: selection.domains });
  } else if (u.firmaRoluriDomenii) {
    delete u.firmaRoluriDomenii[String(fid)];
  }
}

function reqOperationalFirma(firma, action) {
  const state = legal.firmState(firma);
  if (!state.operational) {
    fail(428, (action || 'Operațiunea') + ' este blocată până când proprietarul declară regimul datelor firmei.', state.reason);
  }
  return state;
}

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
  // Firmele de EXERCITIU (clona [TEST], firma demo) poarta CUI-ul original, dar nu sunt evidenta
  // nimanui. Nefiltrate, ele umbresc firma reala: o clona de test declanseaza „CUI deja folosit"
  // la crearea firmei adevarate, iar o cerere de acces pe CUI poate nimeri copia in locul
  // originalului. Cautarea pe CUI raspunde despre firme REALE.
  return db.get().firme.find((x) => x.id !== exceptId && !x.test && !x.demo && cuiKey(x.cui) === key) || null;
}

/** Refuza CUI-ul deja folosit de alta firma. 409: conflict, nu „date gresite". */
function reqCuiLiber(cui, exceptId) {
  if (firmaDupaCui(cui, exceptId)) fail(409, CUI_DUPLICAT);
}

function createFirma(user, b) {
  reqNotDemo(user); b = b || {};
  // Formularul din aplicatie inscrie firme PROPRII: CUI obligatoriu, valid si liber. In etapa de
  // test NU cerem CNP-ul real al patronului — ar contrazice interdictia de a introduce date reale.
  // Proprietarul este contul autentificat. La inscrierea publica CUI-ul ramane optional.
  if (user.role !== 'admin') {
    if (!identitate.validCUI(b.cui)) fail(400, 'CUI invalid. Scrie codul fiscal al firmei (ex. RO14399840) — cifra de control nu se potrivește.');
    reqCuiLiber(b.cui);
  } else if (b.cui) { reqCuiLiber(b.cui); }
  if (b.confirmFictitious !== true) {
    fail(400, 'Confirmă că firma nouă va conține exclusiv date fictive în etapa de test.', 'TEST_DATA_DECLARATION_REQUIRED');
  }
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
  f.legalAcceptance = legal.acceptanceRecord('test-data', user, { declaration: 'fictitious-only' });
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
function cerereAcces(user, cui, rolSolicitat) {
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
    firmaId: f.id, userId: user.id, rolSolicitat: requestedRole(rolSolicitat),
    ts: new Date().toISOString(), status: 'in_asteptare',
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
      return { id: r.id, firmaId: r.firmaId, firma: f.nume || '', ts: r.ts, username: u.username || '', email: u.email || '', rolSolicitat: requestedRole(r.rolSolicitat) };
    });
  return capList(out, 0, 'cereri-acces').items;
}

/** Aprobare/respingere — DOAR proprietarul firmei din cerere. */
function decideCerere(user, id, aprob, rolAcordat) {
  reqNotDemo(user);
  const d = db.get();
  const r = (d.accessRequests || []).find((x) => String(x.id) === String(id));
  if (!r || r.status !== 'in_asteptare') fail(404, 'Cererea nu mai există sau a fost deja rezolvată.');
  const f = db.getFirma(r.firmaId);
  if (!f) fail(404, 'Firma nu mai există.');
  // garda esentiala: proprietarul, nu „oricine are acces" — altfel un colaborator adaugat ieri
  // ar putea da mai departe acces la datele patronului
  if (f.ownerId !== user.id) fail(403, 'Doar proprietarul firmei poate decide cererile de acces.');
  if (aprob) reqOperationalFirma(f, 'Acordarea accesului');
  const role = aprob ? requestedRole(rolAcordat || r.rolSolicitat) : null;
  r.status = aprob ? 'aprobata' : 'respinsa';
  r.decidedBy = user.id; r.decidedAt = new Date().toISOString();
  if (role) r.rolAcordat = role;
  if (aprob) {
    const u = (d.users || []).find((x) => x.id === r.userId);
    if (!u) fail(404, 'Contul care a cerut accesul nu mai există.');
    u.firme = u.firme || [];
    if (!u.firme.includes(f.id)) u.firme.push(f.id);
    setUserFirmAccess(u, f.id, { base: role, domains: accountingOnlyRoles(role) });
  }
  db.save();
  return { ok: true, status: r.status, firma: f.nume || '', firmaId: f.id, rol: role };
}

// ═══════════ ANGAJAREA UNUI CONTABIL: patron -> contabil (sensul invers) ═══════════
// `accessRequests` merge dinspre contabil („preiau firma asta, ma lasi?"). Aici e drumul celalalt:
// patronul isi cauta un contabil in lista celor inscrisi si ii trimite o CERERE DE SERVICII.
// Simetria e importanta — accesul la datele unei firme se da si se primeste prin acord explicit,
// indiferent cine incepe discutia. Cine decide e mereu celalalt: contabilul ACCEPTA sau refuza.

/** Proiectia publica a unui contabil din lista — fara email, fara CNP, fara firmele lui. */
function contabilPublic(u) {
  const p = u.profil || {};
  const autorizatie = p.autorizatie || '';
  return {
    id: u.id,
    username: u.username,
    nume: p.numeComplet || u.username,
    oras: p.oras || '', judet: p.judet || '',
    telefon: p.telefon || '',
    // Compatibilitate pentru clientii vechi + contract explicit pentru cei noi. Contabo nu are
    // inca o integrare de verificare cu CECCAR, deci simpla completare a profilului nu devine
    // niciodata, prin prezentare, o acreditare validata de platforma.
    autorizatie,
    autorizatieDeclarata: autorizatie,
    autorizatieVerificata: false,
    autorizatieStatut: autorizatie ? 'declarata_neverificata' : 'nedeclarata',
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
    rolAcordat: requestedRole(b.rol),
    mesaj: String(b.mesaj || '').slice(0, 1000).trim(),
    ts: new Date().toISOString(), status: 'in_asteptare',
  };
  d.serviceRequests.push(r);
  db.save();
  // acelasi nume ca in lista din care a fost ales (profil, altfel contul) — mesajul de confirmare
  // trebuie sa spuna cui i-ai trimis, nu un identificator pe care patronul nu l-a vazut niciodata
  return { ok: true, id: r.id, contabil: (c.profil || {}).numeComplet || c.username, firma: f.nume || '', firmaId: f.id, rol: r.rolAcordat };
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
    .map((r) => ({ id: r.id, firmaId: r.firmaId, firma: numeFirma(r.firmaId), patron: numeUser(r.ownerId), mesaj: r.mesaj || '', rol: requestedRole(r.rolAcordat), ts: r.ts }));
  const trimise = all.filter((r) => r.ownerId === user.id)
    .map((r) => ({ id: r.id, firmaId: r.firmaId, firma: numeFirma(r.firmaId), contabil: numeUser(r.contabilId), rol: requestedRole(r.rolAcordat), status: r.status, ts: r.ts }));
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
  if (accept) reqOperationalFirma(f, 'Acordarea accesului');
  r.status = accept ? 'acceptata' : 'refuzata';
  r.decidedAt = new Date().toISOString();
  if (accept) {
    user.firme = user.firme || [];
    if (!user.firme.includes(f.id)) user.firme.push(f.id);
    const role = requestedRole(r.rolAcordat);
    setUserFirmAccess(user, f.id, { base: role, domains: accountingOnlyRoles(role) });
  }
  db.save();
  return { ok: true, status: r.status, firma: f.nume || '', firmaId: f.id, rol: accept ? requestedRole(r.rolAcordat) : null };
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
  // Aceeasi validare pentru JSON si ZIP, inainte de backup/staging/mutatii. db.importFirma o
  // repeta ca garda de domeniu pentru apelantii interni — aici obtinem insa raspunsul 4xx devreme.
  try { bundle = db.validateFirmaBundle(bundle); } catch (e) { fail(400, e.message); }
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
  try { newFid = db.importFirma(bundle, { storedNameMap: o.storedNameMap, targetFid, deferSave: true }); }
  catch (e) { fail(400, e.message); }
  if (!targetFid && user && user.role !== 'admin') { user.firme = user.firme || []; user.firme.push(newFid); }
  // Abonamentul dintr-un fisier controlat de utilizator NU este autoritate de billing. Firma noua
  // primeste exclusiv conditiile locale (proba / grandfathered admin); replace pastreaza starea
  // tintei, fiindca db.importFirma nu importa nici subscription, nici ownerId, nici lockedUntil.
  if (!targetFid && user) {
    const nf = db.getFirma(newFid);
    if (nf) {
      // Regimul juridic vine exclusiv din confirmarea cererii curente, niciodata din pachetul
      // controlat de utilizator. Pentru replace, campurile juridice ale tintei sunt pastrate.
      nf.dataMode = o.dataMode || 'unclassified';
      if (o.legalAcceptance) nf.legalAcceptance = o.legalAcceptance;
      else delete nf.legalAcceptance;
      nf.aiProcessing = { enabled: false };
      nf.subscription = user.role === 'admin'
        ? { status: 'active', plan: 'grandfathered', since: new Date().toISOString() }
        : plans.firmaTrialSub();
      if (user.role !== 'admin') nf.ownerId = user.id;
    }
  }
  if (user) user.firmaActiva = newFid;
  db.save();
  return { firmaId: newFid, replaced: !!targetFid };
}

/** Validarea pachetului firma.json INAINTE de orice scriere (delegata garzii de domeniu din db). */
function validateBundle(bundle) {
  try { return db.validateFirmaBundle(bundle); }
  catch (e) { fail(400, e.message); }
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
    const state = reqOperationalFirma(src, 'Clonarea');
    if (state.mode !== 'test') {
      fail(400, 'O firmă cu date reale nu poate fi etichetată drept copie fictivă fără anonimizare.', 'REAL_DATA_TEST_CLONE_FORBIDDEN');
    }
    const testBundle = db.exportFirma(id);
    // Dosarele anuale sunt semnate pentru identitatea firmei-sursă, iar fotografiile de
    // backtesting indică sursele istorice ale acelei identități. Copia [TEST] primește datele de
    // lucru, nu dovezile imuabile/auditul managerial al originalului.
    testBundle.annualArchives = [];
    testBundle.cashForecastSnapshots = [];
    const newFid = db.importFirma(testBundle, { deferSave: true });
    const nf = db.getFirma(newFid);
    if (nf) {
      nf.nume = '[TEST] ' + String(src.nume || 'Firma').replace(/^\[TEST\]\s*/, ''); nf.test = true;
      nf.dataMode = 'test';
      nf.legalAcceptance = legal.acceptanceRecord('test-data', user, { declaration: 'fictitious-only', source: 'test-clone' });
      nf.aiProcessing = { enabled: false };
      nf.subscription = Object.assign({}, src.subscription || (user.role === 'admin'
        ? { status: 'active', plan: 'grandfathered', since: new Date().toISOString() }
        : plans.firmaTrialSub()));
      if (user.role !== 'admin') nf.ownerId = user.id;
    }
    user.firmaActiva = newFid;
    if (user.role !== 'admin') { user.firme = user.firme || []; user.firme.push(newFid); }
    db.save();
    return { firmaId: newFid, nume: nf ? nf.nume : '' };
  } catch (e) { if (e.status) throw e; fail(400, e.message); }
}

/**
 * FIRMA DEMO pentru evaluare, cu date de exemplu.
 *
 * De ce exista: un CONTABIL se inscrie fara nicio firma — contul lui e gol prin constructie,
 * fiindca el vine sa tina contabilitatea altora. Pana preia primul client real n-are ce evalua:
 * deschide aplicatia si vede ecrane goale. Firma demo ii da un dosar complet (facturi, banca,
 * salarii, declaratii) pe care poate umbla fara sa strice nimic.
 *
 * E marcata `demo: true`: apare cu numele ei explicit, nu raspunde la cautarea pe CUI (vezi
 * firmaDupaCui) si se poate sterge oricand ca orice alta firma.
 */
function addDemoFirma(user) {
  reqNotDemo(user);
  // CINE are voie. Nu planul de abonament: `plans.userKind` deriva din plan (Pro = contabil), iar
  // un contabil proaspat inscris e inca pe PROBA — ar fi fost respins exact cand are cea mai mare
  // nevoie de firma demo. Prins la prima probă.
  //
  // Conditia e nevoia REALA, nu eticheta: are omul ceva la ce sa se uite? Un contabil (`tipCont`)
  // se inscrie fara nicio firma, deci da. Oricine ajunge cu portofoliul gol, la fel — n-are rost
  // sa-l refuzam pe motiv ca eticheta lui zice altceva. Un patron are firma lui de la inscriere,
  // deci nu: pentru un teren de joaca peste date proprii exista deja clona [TEST].
  // Firmele DEMO nu conteaza ca „firma de lucru": altfel garda s-ar auto-bloca imediat dupa ce
  // adauga prima (omul ar avea „o firma", deci ar fi refuzat inainte sa afle ca are deja una demo,
  // cu mesajul gresit). Prins la proba: „a doua cerere -> 409" raspundea 403.
  const areFirme = (user.firme || []).map((id) => db.getFirma(id)).filter((f) => f && !f.demo).length > 0;
  if (user.role !== 'admin' && user.tipCont !== 'contabil' && areFirme) {
    fail(403, 'Firma demo e pentru conturile de contabil sau pentru cele fără nicio firmă. '
      + 'Ai deja o firmă de lucru — pentru încercări pe datele ei folosește copia [TEST].');
  }
  const alBundleului = path.join(db.DATA_DIR, 'demo-firma.json');
  if (!fs.existsSync(alBundleului)) fail(503, 'Exemplul demonstrativ nu e disponibil momentan pe acest server.');

  // UNA singura: altfel un cont ar putea umple portofoliul cu dosare de exercitiu, care arata
  // ca firme reale in tabloul de conformitate.
  const aleMele = (user.firme || []).map((id) => db.getFirma(id)).filter(Boolean);
  const existenta = aleMele.find((f) => f.demo);
  if (existenta) fail(409, 'Ai deja o firmă demo („' + existenta.nume + '"). Șterge-o dacă vrei una nouă, cu datele resetate.');

  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(alBundleului, 'utf8')); }
  catch (e) { fail(503, 'Exemplul demonstrativ nu s-a putut citi.'); }

  let newFid;
  try { newFid = db.importFirma(bundle, { deferSave: true }); }
  catch (e) { fail(400, e.message); }
  const nf = db.getFirma(newFid);
  if (nf) {
    nf.demo = true;
    nf.dataMode = 'test';
    nf.aiProcessing = { enabled: false };
    nf.nume = 'FIRMA DEMO (exemplu de lucru)';
    // Abonamentul: aceleasi conditii ca la orice firma noua — altfel ar lovi paywall-ul imediat.
    if (!nf.subscription) {
      nf.subscription = user.role === 'admin'
        ? { status: 'active', plan: 'grandfathered', since: new Date().toISOString() }
        : plans.firmaTrialSub();
    }
  }
  if (user.role !== 'admin') {
    user.firme = user.firme || []; if (!user.firme.includes(newFid)) user.firme.push(newFid);
    user.firmaRoluri = Object.assign({}, user.firmaRoluri || {}, { [newFid]: 'aprobator' });
  }
  user.firmaActiva = newFid;
  db.save();
  return { firmaId: newFid, nume: nf ? nf.nume : '' };
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
  reqOperationalFirma(f, 'Modificarea firmei');
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
    // A TREIA cale prin care se pot lua bani (dupa /api/checkout-guest si
    // /api/subscription/checkout) — si singura pe care o foloseste efectiv interfata, prin butonul
    // de abonare al firmei. Cat timp furnizorul nu are identitate juridica publicata, se opreste si
    // ea: altfel „am scos datele fictive" ar fi fost adevarat despre pagini si fals despre casa.
    // Se opreste DOAR ramura cu plata; activarea directa de mai jos (fara Stripe: dezvoltare si
    // activare manuala de catre admin) nu incaseaza nimic si ramane la locul ei.
    if (plans.PLATI_SUSPENDATE) fail(503, plans.MOTIV_PLATI_SUSPENDATE);
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
function deleteFirma(user, id, impersonating, confirmName, deferFiles) {
  reqNotDemo(user);
  const d = db.get();
  id = Number(id);
  const isAdmin = user.role === 'admin' && !impersonating;
  const firma = d.firme.find((f) => f.id === id);
  if (!firma) fail(404, 'Firma inexistenta.');
  // Un membru nu poate distruge dosarul comun: doar proprietarul (sau adminul real) decide.
  if (!isAdmin && Number(firma.ownerId) !== Number(user.id)) fail(403, 'Doar proprietarul poate sterge firma si dosarul ei contabil.');
  if (String(confirmName || '').trim() !== String(firma.nume || '').trim()) {
    fail(400, 'Confirmarea nu corespunde denumirii firmei. Tasteaza exact „' + (firma.nume || '') + '”.');
  }
  const files = (d.documents || []).filter((x) => x.firmaId === id && x.storedName).map((x) => path.basename(x.storedName));
  if (firma.logoFile) files.push(path.basename(firma.logoFile));
  d.firme = d.firme.filter((f) => f.id !== id);
  // Sursa listei este aceeasi cu persistenta SQLite/PostgreSQL: o colectie noua per-firma nu
  // poate ramane accidental in urma stergerii.
  for (const c of ARRAY_COLLS.filter((x) => x.firma)) {
    if (Array.isArray(d[c.key])) d[c.key] = d[c.key].filter((x) => Number(x.firmaId) !== id);
  }
  d.accessRequests = (d.accessRequests || []).filter((x) => Number(x.firmaId) !== id);
  d.serviceRequests = (d.serviceRequests || []).filter((x) => Number(x.firmaId) !== id);
  delete d.partners[id]; delete d.openingBalances[id];
  if (d.settings && d.settings.docSeries) delete d.settings.docSeries[id];
  d.users.forEach((u) => {
    if (Array.isArray(u.firme)) u.firme = u.firme.filter((x) => x !== id);
    if (u.firmaRoluri) delete u.firmaRoluri[String(id)];
    if (u.firmaRoluriDomenii) delete u.firmaRoluriDomenii[String(id)];
    if (u.firmaActiva === id) u.firmaActiva = (u.firme || [])[0] || null;
  });
  // daca firma stearsa era cea activa a utilizatorului, muta-l pe prima ramasa a lui
  if (d.firmaActiva === id) d.firmaActiva = (d.firme[0] && d.firme[0].id) || null;
  db.save();
  // Fisierele se sterg numai DUPA ce baza a acceptat eliminarea. Un nume inca referit de alta
  // firma (date istorice/import legacy) ramane pe disc.
  const filesDeleted = deferFiles ? 0 : deleteFirmaFiles(files);
  return { firmaId: id, filesDeleted, pendingFiles: deferFiles ? [...new Set(files)] : [] };
}

/** Elimina fisierele ramase fara referinta DUPA confirmarea tranzactiei bazei. */
function deleteFirmaFiles(files) {
  const d = db.get();
  const stillUsed = new Set((d.documents || []).map((x) => path.basename(x.storedName || '')).filter(Boolean));
  for (const f of d.firme || []) if (f.logoFile) stillUsed.add(path.basename(f.logoFile));
  let filesDeleted = 0;
  for (const name of new Set(files)) {
    if (!name || stillUsed.has(name)) continue;
    try { fs.unlinkSync(path.join(db.UPLOAD_DIR, name)); filesDeleted += 1; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return filesDeleted;
}

// ───────────────────────── Colaboratori pe firma ─────────────────────────
// Gestionarea echipei este o decizie a PROPRIETARULUI, nu a oricarui membru. Rolul per firma
// separa vizualizarea/operarea/verificarea/aprobarea fara sa schimbe rolul global al contului.
function canManageCollaborators(user, fid, allowDemo) {
  const f = db.getFirma(Number(fid));
  return !!(f && user && ((user.role === 'admin') || Number(f.ownerId) === Number(user.id) || allowDemo));
}
function reqManageCollaborators(user, fid, allowDemo) {
  if (!canManageCollaborators(user, fid, allowDemo)) fail(403, 'Doar proprietarul firmei poate gestiona colaboratorii și rolurile lor.');
}

/** Utilizatorii (non-admin) cu acces la firma `fid`, plus invitatiile in asteptare pentru ea. */
function listCollaborators(fid) {
  fid = Number(fid);
  const f = db.getFirma(fid);
  // proiectie marginita (vezi capList): lista alimenteaza ecranul de colaboratori
  return capList(db.get().users
    .filter((u) => u.role !== 'admin' && Array.isArray(u.firme) && u.firme.includes(fid))
    .map((u) => {
      const owner = f && Number(f.ownerId) === Number(u.id);
      return { id: u.id, username: u.username, email: u.email || '', tip: plans.userKind(u), pending: !!u.pending,
        rol: owner ? 'proprietar' : ((u.firmaRoluri || {})[String(fid)] || 'vizualizare'),
        roluri: permissions.domainRolesFor(u, fid, f) };
    }),
  0, 'colaboratori').items;
}

const HANDOFF_ACTIVE = new Set(['solicitata', 'pregatita']);
const TRANSFER_ACTIVE = new Set(['in_asteptare']);

function actorName(user) { return String((user && (user.username || user.email)) || 'utilizator'); }
function historyEvent(action, user, extra) {
  return Object.assign({ action, at: new Date().toISOString(), by: Number(user && user.id), byName: actorName(user) }, extra || {});
}
function reqExactFirmName(firma, confirmName) {
  if (String(confirmName || '').trim() !== String(firma.nume || '').trim()) {
    fail(400, 'Confirmarea nu corespunde denumirii firmei. Tastează exact „' + (firma.nume || '') + '”.');
  }
}
function firmMember(d, fid, uid) {
  return d.users.find((u) => Number(u.id) === Number(uid) && u.role !== 'admin'
    && Array.isArray(u.firme) && u.firme.includes(Number(fid)));
}
function detachCollaborator(d, firma, u, allowOwner) {
  if (!firma) fail(404, 'Firma nu există.');
  if (!allowOwner && Number(firma.ownerId) === Number(u.id)) fail(409, 'Proprietarul nu poate fi retras. Transferă mai întâi proprietatea firmei.', 'OWNERSHIP_TRANSFER_REQUIRED');
  const membri = d.users.filter((x) => x.role !== 'admin' && Array.isArray(x.firme) && x.firme.includes(Number(firma.id)));
  if (membri.length <= 1) fail(400, 'Nu poți scoate ultimul utilizator al firmei — firma ar rămâne fără acces.');
  u.firme = u.firme.filter((x) => Number(x) !== Number(firma.id));
  if (u.firmaRoluri) delete u.firmaRoluri[String(firma.id)];
  if (u.firmaRoluriDomenii) delete u.firmaRoluriDomenii[String(firma.id)];
  if (Number(u.firmaActiva) === Number(firma.id)) u.firmaActiva = u.firme[0] || null;
}

/** Proiectia scurta folosita in ecran. Manifestul complet se obtine numai din ruta de dosar. */
function handoffPublic(row) {
  return {
    id: row.id, firmaId: row.firmaId, collaboratorId: row.collaboratorId,
    collaboratorName: row.collaboratorName, initiatedBy: row.initiatedBy,
    initiatedByName: row.initiatedByName, reason: row.reason, status: row.status,
    createdAt: row.createdAt, preparedAt: row.preparedAt || null,
    completedAt: row.completedAt || null, cancelledAt: row.cancelledAt || null,
    rootHash: row.manifest && row.manifest.rootHash || null,
    history: row.history || [],
  };
}
function transferPublic(row) {
  return {
    id: row.id, firmaId: row.firmaId, fromUserId: row.fromUserId, fromUserName: row.fromUserName,
    toUserId: row.toUserId, toUserName: row.toUserName, status: row.status,
    createdAt: row.createdAt, completedAt: row.completedAt || null, cancelledAt: row.cancelledAt || null,
    history: row.history || [],
  };
}

/** Fluxurile vizibile utilizatorului pe firma activa. Membrii obisnuiti nu vad incetarile altora. */
function collaborationLifecycle(user, fid) {
  fid = Number(fid);
  const d = db.get(); const firma = db.getFirma(fid);
  if (!firma) fail(404, 'Firma nu există.');
  if (!user || (user.role !== 'admin' && !firmMember(d, fid, user.id))) fail(403, 'Fără acces la această firmă.');
  const owner = user.role === 'admin' || Number(firma.ownerId) === Number(user.id);
  const relevantHandoff = (r) => Number(r.firmaId) === fid && (owner
    || Number(r.collaboratorId) === Number(user.id) || Number(r.initiatedBy) === Number(user.id));
  const relevantTransfer = (r) => Number(r.firmaId) === fid && (owner
    || Number(r.fromUserId) === Number(user.id) || Number(r.toUserId) === Number(user.id));
  const handoffs = capList((d.collaborationHandoffs || []).filter(relevantHandoff).map(handoffPublic), 0, 'predari-colaborare').items;
  const ownershipTransfers = capList((d.ownershipTransfers || []).filter(relevantTransfer).map(transferPublic), 0, 'transferuri-proprietate').items;
  return {
    firmaName: firma.nume || '', ownerId: Number(firma.ownerId),
    handoffs, ownershipTransfers,
  };
}

function rowHash(row) {
  return crypto.createHash('sha256').update(canonicalJson(row), 'utf8').digest('hex');
}

/** Fotografie imuabila a dosarului la momentul in care contabilul declara predarea. Nu expune
 * continut contabil in procesul-verbal: pentru fiecare colectie pastreaza doar numarul de randuri
 * si amprenta lor, iar pentru fisiere numele, dimensiunea si SHA-256 calculat efectiv. */
function buildHandoffManifest(firma, owner, collaborator, preparedBy) {
  const d = db.get();
  const excluded = new Set(['collaborationHandoffs', 'ownershipTransfers', 'auditOutbox']);
  const collections = ARRAY_COLLS.filter((c) => c.firma && !excluded.has(c.key)).map((c) => {
    const rows = (Array.isArray(d[c.key]) ? d[c.key] : []).filter((r) => Number(r.firmaId) === Number(firma.id));
    const hashes = rows.map((row) => rowHash(row)).sort();
    return { name: c.key, count: rows.length, sha256: rowHash(hashes) };
  });
  const documents = (d.documents || []).filter((doc) => Number(doc.firmaId) === Number(firma.id)).map((doc) => {
    let bytes = Number(doc.bytes) || 0; let sha256 = String(doc.sha256 || '');
    const stored = doc.storedName && path.join(db.UPLOAD_DIR, path.basename(doc.storedName));
    if (stored) {
      try {
        const content = fs.readFileSync(stored);
        bytes = content.length; sha256 = crypto.createHash('sha256').update(content).digest('hex');
      } catch (_) { /* fisierul absent ramane vizibil prin amprenta goala/stocata */ }
    }
    return { id: doc.id, name: String(doc.fileName || doc.originalName || ''), bytes, sha256 };
  }).sort((a, b) => naturalCompare(String(a.id), String(b.id)));
  const partners = (d.partners && d.partners[firma.id]) || {};
  const openingBalances = (d.openingBalances && d.openingBalances[firma.id]) || {};
  const documentSeries = (d.settings && d.settings.docSeries && d.settings.docSeries[firma.id]) || {};
  const maps = [
    { name: 'partners', count: Object.keys(partners).length, sha256: rowHash(partners) },
    { name: 'openingBalances', count: Object.keys(openingBalances).length, sha256: rowHash(openingBalances) },
    { name: 'documentSeries', count: Object.keys(documentSeries).length, sha256: rowHash(documentSeries) },
  ];
  const relationshipRows = ['accessRequests', 'serviceRequests'].map((name) => {
    const rows = (Array.isArray(d[name]) ? d[name] : []).filter((r) => Number(r.firmaId) === Number(firma.id));
    return { name, count: rows.length, sha256: rowHash(rows.map(rowHash).sort()) };
  });
  const generatedAt = new Date().toISOString();
  const snapshot = {
    version: 1, generatedAt,
    firma: { id: firma.id, nume: firma.nume || '', cui: firma.cui || '', regCom: firma.regCom || '', lockedUntil: firma.lockedUntil || null },
    parties: { owner: { id: owner.id, username: owner.username }, collaborator: { id: collaborator.id, username: collaborator.username } },
    preparedBy: { id: preparedBy.id, username: actorName(preparedBy) },
    collections, maps, relationshipRows, documents,
  };
  return Object.assign(snapshot, { rootHash: rowHash(snapshot) });
}

/** Porneste incetarea. Poate cere proprietarul sau chiar colaboratorul vizat. */
function initiateCollaborationHandoff(user, fid, collaboratorId, reason) {
  reqNotDemo(user); fid = Number(fid); collaboratorId = Number(collaboratorId);
  const d = db.get(); const firma = db.getFirma(fid); const collaborator = firmMember(d, fid, collaboratorId);
  if (!firma) fail(404, 'Firma nu există.');
  if (!collaborator || collaborator.pending) fail(404, 'Colaboratorul activ nu există pe această firmă.');
  if (Number(firma.ownerId) === collaboratorId) fail(409, 'Pentru proprietar folosește transferul de proprietate.', 'OWNERSHIP_TRANSFER_REQUIRED');
  const allowed = user.role === 'admin' || Number(firma.ownerId) === Number(user.id) || Number(user.id) === collaboratorId;
  if (!allowed) fail(403, 'Doar proprietarul sau colaboratorul vizat poate începe încetarea.');
  if ((d.collaborationHandoffs || []).some((r) => Number(r.firmaId) === fid && Number(r.collaboratorId) === collaboratorId && HANDOFF_ACTIVE.has(r.status))) {
    fail(409, 'Există deja o predare în curs pentru acest colaborator.');
  }
  if ((d.ownershipTransfers || []).some((r) => Number(r.firmaId) === fid && Number(r.toUserId) === collaboratorId && TRANSFER_ACTIVE.has(r.status))) {
    fail(409, 'Colaboratorul este deja destinatarul unui transfer de proprietate. Finalizează sau anulează transferul mai întâi.');
  }
  reason = String(reason || '').trim().slice(0, 1000);
  if (!reason) fail(400, 'Consemnează motivul încetării colaborării.');
  const createdAt = new Date().toISOString();
  const row = {
    id: db.nextId('predare_'), firmaId: fid, collaboratorId, collaboratorName: collaborator.username,
    initiatedBy: Number(user.id), initiatedByName: actorName(user), reason,
    status: 'solicitata', createdAt, history: [historyEvent('incetare_solicitata', user, { reason })],
  };
  d.collaborationHandoffs.push(row); db.save(); return handoffPublic(row);
}

/** Colaboratorul confirma predarea; abia aici se sigileaza fotografia dosarului. */
function prepareCollaborationHandoff(user, handoffId) {
  reqNotDemo(user);
  const d = db.get(); const row = (d.collaborationHandoffs || []).find((r) => String(r.id) === String(handoffId));
  if (!row) fail(404, 'Procesul de predare nu există.');
  if (row.status !== 'solicitata') fail(409, 'Predarea nu mai este în starea „solicitată”.');
  if (Number(row.collaboratorId) !== Number(user.id)) fail(403, 'Doar colaboratorul vizat poate confirma că dosarul a fost predat.');
  const firma = db.getFirma(Number(row.firmaId)); const collaborator = firmMember(d, row.firmaId, row.collaboratorId);
  const owner = firma && d.users.find((u) => Number(u.id) === Number(firma.ownerId));
  if (!firma || !collaborator || !owner) fail(409, 'Părțile colaborării nu mai sunt active pe firmă.');
  row.manifest = buildHandoffManifest(firma, owner, collaborator, user);
  row.status = 'pregatita'; row.preparedAt = row.manifest.generatedAt; row.preparedBy = Number(user.id);
  row.history.push(historyEvent('dosar_predat', user, { rootHash: row.manifest.rootHash }));
  db.save(); return handoffPublic(row);
}

/** Proprietarul confirma primirea; numai acum dispare accesul colaboratorului. */
function completeCollaborationHandoff(user, handoffId) {
  reqNotDemo(user);
  const d = db.get(); const row = (d.collaborationHandoffs || []).find((r) => String(r.id) === String(handoffId));
  if (!row) fail(404, 'Procesul de predare nu există.');
  if (row.status !== 'pregatita' || !row.manifest) fail(409, 'Colaboratorul trebuie să confirme mai întâi predarea dosarului.');
  const firma = db.getFirma(Number(row.firmaId));
  if (!firma) fail(404, 'Firma nu mai există.');
  if (user.role !== 'admin' && Number(firma.ownerId) !== Number(user.id)) fail(403, 'Doar proprietarul poate confirma primirea și retrage accesul.');
  const collaborator = firmMember(d, row.firmaId, row.collaboratorId);
  if (!collaborator) fail(409, 'Colaboratorul nu mai are acces; procesul nu poate fi finalizat a doua oară.');
  detachCollaborator(d, firma, collaborator);
  row.status = 'finalizata'; row.completedAt = new Date().toISOString(); row.completedBy = Number(user.id);
  row.history.push(historyEvent('predare_acceptata_acces_retras', user, { rootHash: row.manifest.rootHash }));
  db.save(); return handoffPublic(row);
}

function cancelCollaborationHandoff(user, handoffId) {
  reqNotDemo(user);
  const d = db.get(); const row = (d.collaborationHandoffs || []).find((r) => String(r.id) === String(handoffId));
  if (!row) fail(404, 'Procesul de predare nu există.');
  if (!HANDOFF_ACTIVE.has(row.status)) fail(409, 'Procesul de predare este deja închis.');
  const firma = db.getFirma(Number(row.firmaId));
  const allowed = user.role === 'admin' || (firma && Number(firma.ownerId) === Number(user.id)) || Number(row.initiatedBy) === Number(user.id);
  if (!allowed) fail(403, 'Doar proprietarul sau inițiatorul poate anula predarea.');
  row.status = 'anulata'; row.cancelledAt = new Date().toISOString(); row.cancelledBy = Number(user.id);
  row.history.push(historyEvent('predare_anulata', user)); db.save(); return handoffPublic(row);
}

function handoffDossier(user, handoffId) {
  const d = db.get(); const row = (d.collaborationHandoffs || []).find((r) => String(r.id) === String(handoffId));
  if (!row) fail(404, 'Procesul de predare nu există.');
  const firma = db.getFirma(Number(row.firmaId));
  const allowed = user && (user.role === 'admin' || Number(user.id) === Number(row.collaboratorId)
    || Number(user.id) === Number(row.initiatedBy) || (firma && Number(user.id) === Number(firma.ownerId)));
  if (!allowed) fail(403, 'Nu ai acces la acest proces-verbal de predare.');
  if (!row.manifest) fail(409, 'Dosarul nu a fost încă declarat predat.');
  return {
    tip: 'proces-verbal-predare-dosar-contabil', version: 1, handoffId: row.id,
    status: row.status, reason: row.reason, manifest: row.manifest, history: row.history || [],
  };
}

/** Transferul proprietatii cere confirmarea denumirii la initiere si acceptarea destinatarului. */
function initiateOwnershipTransfer(user, fid, targetId, confirmName) {
  reqNotDemo(user); fid = Number(fid); targetId = Number(targetId);
  const d = db.get(); const firma = db.getFirma(fid);
  if (!firma) fail(404, 'Firma nu există.');
  if (Number(firma.ownerId) !== Number(user.id)) fail(403, 'Doar proprietarul curent poate iniția transferul.');
  reqExactFirmName(firma, confirmName);
  const target = firmMember(d, fid, targetId);
  if (!target || target.pending || Number(target.id) === Number(user.id)) fail(404, 'Alege un colaborator activ al firmei.');
  if ((d.ownershipTransfers || []).some((r) => Number(r.firmaId) === fid && TRANSFER_ACTIVE.has(r.status))) {
    fail(409, 'Există deja un transfer de proprietate în așteptare pentru această firmă.');
  }
  if ((d.collaborationHandoffs || []).some((r) => Number(r.firmaId) === fid && Number(r.collaboratorId) === targetId && HANDOFF_ACTIVE.has(r.status))) {
    fail(409, 'Există o încetare în curs pentru acest colaborator. Anuleaz-o sau finalizeaz-o înainte de transfer.');
  }
  const row = {
    id: db.nextId('proprietar_'), firmaId: fid, fromUserId: Number(user.id), fromUserName: actorName(user),
    toUserId: targetId, toUserName: target.username, status: 'in_asteptare', createdAt: new Date().toISOString(),
    history: [historyEvent('transfer_initiat', user, { toUserId: targetId, toUserName: target.username })],
  };
  d.ownershipTransfers.push(row); db.save(); return transferPublic(row);
}

function acceptOwnershipTransfer(user, transferId, confirmName) {
  reqNotDemo(user);
  const d = db.get(); const row = (d.ownershipTransfers || []).find((r) => String(r.id) === String(transferId));
  if (!row) fail(404, 'Transferul de proprietate nu există.');
  if (row.status !== 'in_asteptare') fail(409, 'Transferul nu mai este în așteptare.');
  if (Number(row.toUserId) !== Number(user.id)) fail(403, 'Doar destinatarul poate accepta proprietatea firmei.');
  const firma = db.getFirma(Number(row.firmaId));
  if (!firma || Number(firma.ownerId) !== Number(row.fromUserId)) fail(409, 'Proprietarul firmei s-a schimbat între timp.');
  reqExactFirmName(firma, confirmName);
  const target = firmMember(d, row.firmaId, row.toUserId);
  const previousOwner = firmMember(d, row.firmaId, row.fromUserId);
  if (!target || !previousOwner) fail(409, 'Ambele părți trebuie să aibă acces activ la firmă.');
  firma.ownerId = Number(target.id);
  setUserFirmAccess(previousOwner, firma.id, { base: 'vizualizare', domains: accountingOnlyRoles('vizualizare') });
  row.status = 'finalizat'; row.completedAt = new Date().toISOString(); row.completedBy = Number(user.id);
  row.history.push(historyEvent('transfer_acceptat', user, { previousOwnerRole: 'vizualizare', newOwnerId: target.id }));
  db.save(); return transferPublic(row);
}

function cancelOwnershipTransfer(user, transferId) {
  reqNotDemo(user);
  const d = db.get(); const row = (d.ownershipTransfers || []).find((r) => String(r.id) === String(transferId));
  if (!row) fail(404, 'Transferul de proprietate nu există.');
  if (row.status !== 'in_asteptare') fail(409, 'Transferul nu mai este în așteptare.');
  if (Number(user.id) !== Number(row.fromUserId) && Number(user.id) !== Number(row.toUserId)) {
    fail(403, 'Doar proprietarul sau destinatarul poate închide transferul.');
  }
  const rejected = Number(user.id) === Number(row.toUserId);
  row.status = rejected ? 'refuzat' : 'anulat'; row.cancelledAt = new Date().toISOString(); row.cancelledBy = Number(user.id);
  row.history.push(historyEvent(rejected ? 'transfer_refuzat' : 'transfer_anulat', user));
  db.save(); return transferPublic(row);
}

/** Adauga un cont EXISTENT (dupa username sau email exact) ca membru al firmei `fid`. Idempotent. */
function addExistingCollaborator(user, fid, b, allowDemo) {
  fid = Number(fid); b = b || {};
  reqManageCollaborators(user, fid, allowDemo);
  reqOperationalFirma(db.getFirma(fid), 'Acordarea accesului');
  const key = String(b.username || b.email || '').trim().toLowerCase();
  if (!key) fail(400, 'Completează utilizatorul sau emailul colaboratorului.');
  const d = db.get();
  const u = d.users.find((x) => (x.username || '').toLowerCase() === key || (x.email || '').toLowerCase() === key);
  if (!u) fail(404, 'Nu există un cont cu „' + (b.username || b.email) + '". Folosește „Invită prin link" pentru o persoană nouă.');
  if (u.role === 'admin') fail(400, 'Administratorul are deja acces la toate firmele.');
  u.firme = u.firme || [];
  if (u.firme.includes(fid)) fail(400, u.username + ' e deja colaborator pe această firmă.');
  u.firme.push(fid);
  const selection = accessSelection(b);
  setUserFirmAccess(u, fid, selection);
  db.save();
  return { id: u.id, username: u.username, email: u.email || '', tip: plans.userKind(u), pending: !!u.pending,
    rol: selection.base, roluri: selection.domains || permissions.domainRolesFor(u, fid, db.getFirma(fid)) };
}

/** Creeaza o INVITATIE (pending user) cu acces la firma `fid` — aceeasi forma ca /api/invites.
 *  Intoarce token-ul; ruta construieste linkul (si trimite email daca SMTP e configurat).
 *  Acceptarea foloseste fluxul public existent (GET /api/invite/:token + POST /api/invite/accept). */
function inviteCollaborator(user, fid, b, allowDemo) {
  fid = Number(fid); b = b || {};
  reqManageCollaborators(user, fid, allowDemo);
  reqOperationalFirma(db.getFirma(fid), 'Invitarea unui colaborator');
  const username = String(b.username || '').trim();
  if (!username) fail(400, 'Alege un nume de utilizator pentru invitație.');
  const d = db.get();
  if (d.users.some((u) => (u.username || '').toLowerCase() === username.toLowerCase())) fail(400, 'Există deja un cont „' + username + '". Adaugă-l ca „cont existent".');
  const token = crypto.randomBytes(24).toString('hex');
  const selection = accessSelection(b);
  const u = {
    id: db.nextUserId(), username, email: String(b.email || '').trim(), salt: '', hash: '',
    pending: true, inviteToken: token, inviteExp: Date.now() + 7 * 24 * 3600 * 1000,
    role: 'user', firme: [fid], firmaActiva: fid, firmaRoluri: { [fid]: selection.base },
  };
  if (selection.domains) u.firmaRoluriDomenii = { [fid]: selection.domains };
  d.users.push(u);
  db.save();
  return { token, user: { id: u.id, username: u.username, email: u.email || '', tip: plans.userKind(u), pending: true } };
}

/** Stergerea directa ramane numai pentru invitatii neacceptate si pentru demonstratia publica.
 * Un colaborator real pleaca prin procesul formal de predare, ca motivul, fotografia dosarului si
 * acceptarea proprietarului sa nu dispara intr-un simplu DELETE. */
function removeCollaborator(user, fid, uid, allowDemo) {
  fid = Number(fid); uid = Number(uid);
  reqManageCollaborators(user, fid, allowDemo);
  const d = db.get(); const firma = db.getFirma(fid);
  const u = d.users.find((x) => x.id === uid);
  if (!u || u.role === 'admin' || !Array.isArray(u.firme) || !u.firme.includes(fid)) fail(404, 'Utilizatorul nu e colaborator pe această firmă.');
  if (!allowDemo && Number(firma && firma.ownerId) === uid) {
    fail(409, 'Proprietarul nu poate fi retras. Inițiază transferul de proprietate către un colaborator activ.', 'OWNERSHIP_TRANSFER_REQUIRED');
  }
  if (!allowDemo && !u.pending) {
    fail(409, 'Accesul unui colaborator activ se retrage numai după procesul formal de predare a dosarului.', 'HANDOFF_REQUIRED');
  }
  detachCollaborator(d, firma, u, !!allowDemo);
  db.save();
  return { id: u.id, username: u.username };
}

/** Schimba doar rolul colaboratorului; proprietarul ramane proprietar si nu poate fi degradat. */
function setCollaboratorRole(user, fid, uid, role, allowDemo) {
  fid = Number(fid); uid = Number(uid);
  reqManageCollaborators(user, fid, allowDemo);
  const d = db.get(); const f = db.getFirma(fid);
  const u = d.users.find((x) => x.id === uid && x.role !== 'admin' && Array.isArray(x.firme) && x.firme.includes(fid));
  if (!u) fail(404, 'Utilizatorul nu e colaborator pe această firmă.');
  if (f && Number(f.ownerId) === uid) fail(400, 'Rolul proprietarului nu poate fi schimbat din lista colaboratorilor.');
  if (!COLLAB_ROLES.has(role)) fail(400, 'Rol invalid (vizualizare/operator/verificator/aprobator).');
  u.firmaRoluri = Object.assign({}, u.firmaRoluri || {}, { [fid]: role });
  if (u.firmaRoluriDomenii) delete u.firmaRoluriDomenii[String(fid)];
  db.save();
  return { id: u.id, username: u.username, rol: role };
}

/** Acorda independent rolul pe contabilitate, salarizare si trezorerie. Rolul vechi ramane o
 * proiectie de compatibilitate (prima arie activa); verdictul foloseste intotdeauna aria actiunii. */
function setCollaboratorAccess(user, fid, uid, roles, allowDemo) {
  fid = Number(fid); uid = Number(uid);
  reqManageCollaborators(user, fid, allowDemo);
  const d = db.get(); const f = db.getFirma(fid);
  const u = d.users.find((x) => x.id === uid && x.role !== 'admin' && Array.isArray(x.firme) && x.firme.includes(fid));
  if (!u) fail(404, 'Utilizatorul nu e colaborator pe această firmă.');
  if (f && Number(f.ownerId) === uid) fail(400, 'Accesul proprietarului nu poate fi restrâns din lista colaboratorilor.');
  const selection = accessSelection({ roluri: roles, rol: (u.firmaRoluri || {})[String(fid)] });
  setUserFirmAccess(u, fid, selection);
  db.save();
  return { id: u.id, username: u.username, rol: selection.base, roluri: selection.domains };
}

module.exports = {
  trialDinNou, cerereAcces, cereriPrimite, decideCerere,
  firmaDupaCui, reqCuiLiber, CUI_DUPLICAT,
  listaContabili, contabilPublic, cerereServicii, cereriServicii, decideServicii, retrageServicii,
  reqNotDemo, reqAccess, reqAdmin,
  createFirma, importBundle, importZip, testClone, addDemoFirma,
  exportBundle, exportZip, exportAllZip, firmaSlug,
  updateFirma, activateFirma, setFirmaSubscription, subscribeFirma, deleteFirma, deleteFirmaFiles,
  listCollaborators, addExistingCollaborator, inviteCollaborator, removeCollaborator, setCollaboratorRole, setCollaboratorAccess,
  canManageCollaborators, collaborationLifecycle,
  initiateCollaborationHandoff, prepareCollaborationHandoff, completeCollaborationHandoff,
  cancelCollaborationHandoff, handoffDossier,
  initiateOwnershipTransfer, acceptOwnershipTransfer, cancelOwnershipTransfer,
};
