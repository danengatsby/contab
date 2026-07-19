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
const { allowedFirme } = require('./session');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Contul demo (public, partajat) nu adauga si nu gestioneaza firme. */
function reqNotDemo(user) {
  if (user && user.username === 'demo') fail(403, 'Contul demo nu poate adăuga sau gestiona firme. Înscrie-ți firma ta (gratuit 30 de zile) dintr-un cont propriu.');
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

function createFirma(user, b) {
  reqNotDemo(user); b = b || {};
  const d = db.get();
  const id = db.nextFirmaId();
  const f = Object.assign(db.defaultFirma(id), {
    nume: b.nume || ('Firma ' + id), cui: b.cui || '', regCom: b.regCom || '',
    adresa: b.adresa || '', oras: b.oras || '', judet: b.judet || 'RO-B',
    tvaPlatitor: b.tvaPlatitor != null ? !!b.tvaPlatitor : true,
    tipEntitate: b.tipEntitate === 'pfa' ? 'pfa' : 'srl',
  }, { id });
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
      fs.writeFileSync(path.join(dir, 'pre-restore-firma' + targetFid + '-' + Date.now() + '.json'), JSON.stringify(db.exportFirma(targetFid)));
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

module.exports = {
  reqNotDemo, reqAccess, reqAdmin,
  createFirma, importBundle, importZip, testClone,
  exportBundle, exportZip, exportAllZip, firmaSlug,
  updateFirma, activateFirma, setFirmaSubscription, subscribeFirma, deleteFirma,
};
