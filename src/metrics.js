'use strict';

// Metrici in-memory pentru durata cererilor HTTP (fara dependinte; se reseteaza la restart).
// Middleware-ul din server.js inregistreaza fiecare raspuns, /api/metrics (admin) arata
// agregatele pe ruta — optimizarile de performanta pornesc de la masuratori, nu din instinct.
// Cererile peste CONTAB_SLOW_MS (implicit 500) se logheaza si ca avertisment, cu reqId,
// ca sa poata fi corelate cu utilizatorul/firma din logul structurat.

const SLOW_MS = Number(process.env.CONTAB_SLOW_MS) || 500;
const MAX_ROUTES = 500; // plafon de siguranta: tiparele nu cresc nemarginit

const routes = new Map(); // tipar ruta -> { n, totalMs, maxMs, slow, err5xx }
const startedAt = Date.now();

/** Tiparul rutei: calea Express daca cererea a atins un handler, altfel calea cu
 *  segmentele-identificator (numere, hex, token-uri lungi) inlocuite cu :id. */
function routePattern(req) {
  if (req.route && req.route.path) return (req.baseUrl || '') + req.route.path;
  const p = String(req.originalUrl || req.url || '').split('?')[0];
  return p.split('/').map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || seg.length > 24 ? ':id' : seg)).join('/');
}

// ── CERERILE LENTE RECENTE, cu ora lor ──────────────────────────────────────────────────────
// `routes` tine agregate CUMULATE de la pornire, deci raspunde la „ce e scump in general", nu la
// „ce rula acum doua minute, cand s-a blocat bucla". Alerta de lag spunea CAT a stat blocata si
// niciodata UNDE — iar fara asta diagnosticul e o ghicitoare (masurat: patru alerte intr-o
// saptamana, cu varfuri de 1.616 ms, si nicio pista in log).
//
// Inelul de mai jos e minimul care raspunde la a doua intrebare: ultimele cereri care au depasit
// pragul, cu momentul lor. Se pastreaza doar tiparul rutei (deja normalizat de `routePattern`,
// deci fara identificatori), durata si ora — nimic din corpul cererii.
//
// ATENTIE la interpretare, si de aceea o scriem in raport: cand bucla se blocheaza, TOATE cererile
// din fereastra ies lente, fiindca asteapta la coada. Vinovata e de regula cea mai LUNGA, nu toate.
const SLOW_RING = 60;
const slowRing = [];
function recordSlow(pattern, ms, ts) {
  slowRing.push({ route: pattern, ms: Math.round(ms), ts: ts || Date.now() });
  if (slowRing.length > SLOW_RING) slowRing.shift();
}
/** Cererile lente din ultimele `ferestraMs` milisecunde, cele mai lungi primele. */
function slowRecent(ferestraMs, limita) {
  const de = Date.now() - (Number(ferestraMs) || 60000);
  return slowRing.filter((x) => x.ts >= de).sort((a, b) => b.ms - a.ms).slice(0, Number(limita) || 3);
}

function record(pattern, ms, status) {
  let r = routes.get(pattern);
  if (!r) {
    if (routes.size >= MAX_ROUTES) return; // plin: nu mai deschidem tipare noi (cele fierbinti exista deja)
    r = { n: 0, totalMs: 0, maxMs: 0, slow: 0, err5xx: 0 };
    routes.set(pattern, r);
  }
  r.n += 1; r.totalMs += ms; if (ms > r.maxMs) r.maxMs = ms;
  if (ms >= SLOW_MS) { r.slow += 1; recordSlow(pattern, ms); }
  if (status >= 500) r.err5xx += 1;
}

/** Agregatele pe ruta, ordonate dupa timpul total consumat (candidatii la optimizare primii). */
function snapshot() {
  const list = [...routes.entries()].map(([route, r]) => ({
    route, n: r.n, totalMs: Math.round(r.totalMs), avgMs: Math.round(r.totalMs / r.n),
    maxMs: Math.round(r.maxMs), slow: r.slow, err5xx: r.err5xx,
  })).sort((a, b) => b.totalMs - a.totalMs);
  return {
    sinceTs: new Date(startedAt).toISOString(), slowThresholdMs: SLOW_MS, routes: list.slice(0, 100),
    recentErrors: recentErrors.slice().reverse(), // cele mai noi primele
    lag: lagSnapshot(), // cat a stat bucla blocata — cauza pe care durata pe ruta n-o poate arata
    audit: auditSnapshot(), // scrierile in jurnalul DURABIL: tacerea lor invalida retentia
    clientErrors: clientErrorsSnapshot(), // ce s-a rupt in BROWSER — server-side nu se vede deloc
    jobs: jobsSnapshot(),
    // DURATA scrierilor (cat blocheaza bucla), NU starea cozii. Numele e `persistDurate`, nu
    // `persist`, fiindca ruta /api/metrics pune deja `persist: db.persistStats()` peste rezultatul
    // acestei functii printr-un `Object.assign` — un camp cu acelasi nume ar fi fost suprascris
    // TACUT si n-ar fi ajuns niciodata la admin. Doua marimi diferite, doua nume diferite.
    persistDurate: persistSnapshot(),
    ai: aiSnapshot(),
    ops: opsSnapshot(),
  };
}

// ── Operational: spatiul liber pe discul de date + starea ultimului backup VERIFICAT
// ca restaurabil (scrisa de scripts/backup.js in data/backups/last-backup.json) ──
// ── Plafoanele de memorie: UN SINGUR loc, ca alerta si metrica sa spuna acelasi lucru ──
// `max_memory_restart` din ecosystem.config.js NU e citit din fisier intentionat: `pm2 restart` nu
// reaplica fisierul, deci valoarea de acolo e o DECLARATIE DE INTENTIE, nu plafonul procesului viu
// (vezi CLAUDE.md). Il declaram explicit prin mediu si il verificam cu `pm2 jlist` cand se schimba.
const MEM_LIMIT_MB = Number(process.env.CONTAB_PM2_MAX_MB) || 1024; // = max_memory_restart
// Pragul de avertizare: implicit 70% din plafon — destul cat sa mai poti privi procesul inainte
// ca pm2 sa-l ucida in mijlocul unei cereri.
const MEM_WARN_MB = Number(process.env.CONTAB_MEM_WARN_MB) || Math.round(MEM_LIMIT_MB * 0.7);

function opsSnapshot() {
  const fs = require('fs');
  const path = require('path');
  const out = {};
  try {
    const dataDir = process.env.CONTAB_DATA_DIR || path.join(__dirname, '..', 'data');
    const st = fs.statfsSync(dataDir);
    out.discLiberMB = Math.round((st.bavail * st.bsize) / 1048576);
    try { out.ultimulBackup = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', 'last-backup.json'), 'utf8')); }
    catch (_) { out.ultimulBackup = null; }
  } catch (e) { out.eroare = e.message; }
  return out;
}

// ── Extragerile AI (cost extern per apel — contorizate separat de rutele HTTP, ca sa se
// vada dintr-o privire cate au fost, cate au esuat si cat dureaza in medie) ──
const ai = { n: 0, fail: 0, totalMs: 0, lastError: null, lastErrorAt: null };
function aiCall(ms, okCall, errMsg) {
  ai.n += 1; ai.totalMs += ms;
  if (!okCall) { ai.fail += 1; ai.lastError = String(errMsg || '').slice(0, 200); ai.lastErrorAt = new Date().toISOString(); }
}
function aiSnapshot() {
  return { n: ai.n, fail: ai.fail, avgMs: ai.n ? Math.round(ai.totalMs / ai.n) : 0, lastError: ai.lastError, lastErrorAt: ai.lastErrorAt };
}

// ── Erorile recente (inel, ultimele MAX_ERRORS indiferent de vechime) ──
// Complementar alertei pe email din server.js (aceea vede doar fereastra de 15 minute):
// aici raman vizibile in /api/metrics si erorile rare, pana le impinge altele afara.
const MAX_ERRORS = 20;
const recentErrors = [];
function recordError(msg) {
  recentErrors.push({ ts: new Date().toISOString(), msg: String(msg).slice(0, 200) });
  if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
}

// ── ERORI DIN CLIENT (JavaScript, in browserul utilizatorului) ──
// Pe server observabilitatea e buna (reqId, durate, fereastra 5xx, metrici). In client era NULA:
// o exceptie netratata lasa contabilul cu ecranul blocat, iar tu nu aflai niciodata — el pleaca
// si atat. Aici ajunge semnalul minim: ce s-a rupt, unde, de cate ori si la cine.
//
// Se AGREGA pe semnatura, nu se stivuieste: aceeasi eroare de la 50 de utilizatori trebuie sa
// arate „x50", nu sa evacueze restul inelului. Asta rezolva si utilitatea, si abuzul — ruta e
// publica (o eroare pe ECRANUL DE LOGIN e exact cea care nu se afla altfel), deci o stiva simpla
// ar fi fost usor de umplut cu gunoi.
const MAX_CLIENT_ERRORS = 25;
const clientErrors = new Map(); // semnatura -> inregistrare agregata

/**
 * Curata si normalizeaza o raportare venita din browser. PURA si testata separat: e singurul loc
 * unde intra text controlat de client, deci taierile si stergerea interogarilor sunt reguli de
 * securitate, nu cosmetica.
 *
 * ATENTIE la interogari: pagina de resetare are tokenul in URL (`/?reset=<token>`). Un `location.href`
 * raportat naiv ar fi scris tokenul de resetare in /api/metrics. Se taie si aici, chiar daca
 * clientul trimite deja doar `pathname` — clientul NU e de incredere.
 */
function clientErrorRecord(body, ctx) {
  const b = body || {}; const c = ctx || {};
  const t = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const faraInterogare = (s) => String(s || '').split('?')[0].split('#')[0];
  return {
    msg: t(b.msg, 200) || '(fara mesaj)',
    sursa: t(faraInterogare(b.sursa), 120),
    // doar primele randuri din stiva: destul cat sa localizezi, nu cat sa devina un jurnal
    stack: String(b.stack == null ? '' : b.stack).split('\n').slice(0, 5)
      .map((l) => faraInterogare(l.trim())).filter(Boolean).join(' | ')
      .slice(0, 500),
    cale: t(faraInterogare(b.cale), 100),
    tip: b.tip === 'promisiune' ? 'promisiune' : 'eroare',
    // Identitatea si user-agentul vin de pe SERVER (sesiune + antet), nu din corpul cererii:
    // altfel oricine si-ar putea atribui erorile altui utilizator.
    username: c.username || null,
    ua: t(c.ua, 120),
  };
}

/** Inregistreaza (agregat) o eroare de client deja normalizata. */
function clientError(rec) {
  const semn = (rec.msg + '|' + rec.sursa).slice(0, 320);
  const acum = new Date().toISOString();
  let e = clientErrors.get(semn);
  if (!e) {
    // Plin: se evacueaza cea mai veche VAZUTA (nu cea mai veche aparuta) — o eroare care inca se
    // repeta e mai relevanta decat una stinsa de mult.
    if (clientErrors.size >= MAX_CLIENT_ERRORS) {
      let vechea = null;
      for (const [k, v] of clientErrors) if (!vechea || v.ultimaLa < vechea[1].ultimaLa) vechea = [k, v];
      if (vechea) clientErrors.delete(vechea[0]);
    }
    e = { msg: rec.msg, sursa: rec.sursa, tip: rec.tip, stack: rec.stack, cale: rec.cale,
      ua: rec.ua, utilizatori: [], n: 0, primaLa: acum, ultimaLa: acum };
    clientErrors.set(semn, e);
  }
  e.n += 1; e.ultimaLa = acum;
  if (rec.stack && !e.stack) e.stack = rec.stack; // primul exemplar cu stiva o pastreaza
  if (rec.username && !e.utilizatori.includes(rec.username) && e.utilizatori.length < 10) e.utilizatori.push(rec.username);
  return e;
}

/** Cele mai recent vazute primele — ordinea in care le-ai vrea la diagnostic. */
function clientErrorsSnapshot() {
  return [...clientErrors.values()].sort((a, b) => (a.ultimaLa < b.ultimaLa ? 1 : -1)).map((e) => Object.assign({}, e));
}

// ── Starea job-urilor de background (tick = a rulat verificarea; result/error = ce a facut) ──
const jobs = new Map(); // label -> { lastTickAt, lastResult, lastResultAt, lastError, lastErrorAt, errors }
function job(label) {
  let j = jobs.get(label);
  if (!j) {
    j = { lastTickAt: null, lastResult: null, lastResultAt: null, lastError: null, lastErrorAt: null, errors: 0,
      n: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    jobs.set(label, j);
  }
  return j;
}
function jobTick(label) { job(label).lastTickAt = new Date().toISOString(); }
function jobResult(label, info) { const j = job(label); j.lastResult = String(info).slice(0, 200); j.lastResultAt = new Date().toISOString(); }
function jobError(label, msg) { const j = job(label); j.lastError = String(msg).slice(0, 200); j.lastErrorAt = new Date().toISOString(); j.errors += 1; }

// ── CAT A BLOCAT BUCLA FIECARE JOB ──────────────────────────────────────────────────────────
// Alerta de lag stia CAT a stat blocata bucla, dar nu si CINE — si spunea singura, in clar,
// „cauta in joburi, nu in rute" (masurat: 4 alerte intr-o saptamana, varf 1.616 ms, nicio pista).
// Cererile erau deja masurate; joburile, deloc. Aici se inchide jumatatea care lipsea.
//
// SE MASOARA PARTEA SINCRONA, si asta e o alegere, nu o scapare: doar munca sincrona blocheaza
// bucla. Un `spv-poll` care asteapta 3 s raspunsul ANAF nu opreste nicio cerere, deci a-l raporta
// ca „3.000 ms" ar acuza nevinovatul si ar ascunde vinovatul. Partea asincrona a unui job NU e
// atribuita aici — de aceea se masoara si `db.save()` separat (vezi persistRun): el e primitiva
// grea care apare si in continuari `.then`, unde masuratoarea pe job n-ar vedea-o.
const JOB_RING = 120; // ~o ora de rulari la cadenta de un minut
const jobRing = [];
function jobRun(label, ms, ts) {
  const j = job(label);
  const v = Math.round(ms * 10) / 10;
  j.n += 1; j.totalMs += v; j.lastMs = v; if (v > j.maxMs) j.maxMs = v;
  jobRing.push({ job: label, ms: v, ts: ts || Date.now() });
  if (jobRing.length > JOB_RING) jobRing.shift();
}
/** Rularile de job din ultimele `ferestraMs` milisecunde, cele mai lungi primele. */
function jobsRecent(ferestraMs, limita) {
  const de = Date.now() - (Number(ferestraMs) || 60000);
  return jobRing.filter((x) => x.ts >= de).sort((a, b) => b.ms - a.ms).slice(0, Number(limita) || 3);
}

function jobsSnapshot() {
  const out = {};
  for (const [label, j] of jobs) {
    out[label] = Object.assign({}, j, { avgMs: j.n ? Math.round((j.totalMs / j.n) * 10) / 10 : 0 });
  }
  return out;
}

// ── CAT A BLOCAT BUCLA PERSISTENTA (db.save) ────────────────────────────────────────────────
// `save()` e suspectul numit chiar in emailul de alerta („serializarea bazei la save() pe o firma
// voluminoasa"), si era singurul din lista pe care nu-l masura nimeni. E si primitiva partajata:
// apare in rute, in joburi si in continuari asincrone, deci o masuratoare aici acopera si blocajele
// pe care atribuirea pe job nu le poate vedea. Pe pg, partea sincrona e fotografierea colectiilor
// (comiterea e in coada async, urmarita separat de persist-watch).
const persist = { n: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastAt: null };
const PERSIST_RING = 60;
const persistRing = [];
function persistRun(ms, ts) {
  const v = Math.round(ms * 10) / 10;
  persist.n += 1; persist.totalMs += v; persist.lastMs = v; persist.lastAt = new Date().toISOString();
  if (v > persist.maxMs) persist.maxMs = v;
  persistRing.push({ ms: v, ts: ts || Date.now() });
  if (persistRing.length > PERSIST_RING) persistRing.shift();
}
/** Cel mai lung `save()` din ultimele `ferestraMs` milisecunde (0 daca n-a fost niciunul). */
function persistPeak(ferestraMs) {
  const de = Date.now() - (Number(ferestraMs) || 60000);
  let max = 0;
  for (const x of persistRing) if (x.ts >= de && x.ms > max) max = x.ms;
  return max;
}
function persistSnapshot() {
  return Object.assign({}, persist, { avgMs: persist.n ? Math.round((persist.totalMs / persist.n) * 10) / 10 : 0 });
}

// ── INTARZIEREA BUCLEI DE EVENIMENTE (event loop lag) ──
// Aplicatia ruleaza intr-UN SINGUR proces (lock single-instance, baza in RAM), deci orice munca
// sincrona — scrypt la login, pg_dump + zip la backup, un raport mare — opreste TOATE cererile,
// nu doar pe a ei. Durata pe ruta nu poate spune care e care: o cerere lenta in sine si una
// blocata in spatele altcuiva apar amandoua ca „3 s", fara cauza. Lag-ul e marimea care le desparte.
//
// ATENTIE la doua capcane ale histogramei, ambele verificate:
//   1. REZOLUTIA E SI PODEAUA: pe o bucla libera se citeste ~rezolutia (10 ms), nu 0. Se scade din
//      fiecare valoare raportata, altfel un server sanatos ar parea permanent intarziat.
//   2. FARA MOSTRE intoarce valori-gunoi (percentile()=511, min=2^63, mean=NaN) — nu zerouri.
//      De aceea `count === 0` se trateaza explicit; altfel /api/metrics ar arata 9.2e18 ms.
// Nu masoara blocajele dinaintea primei ture de bucla (pornirea): acolo nu exista cereri de oprit.
const { monitorEventLoopDelay } = require('perf_hooks');
const LAG_RES_MS = 10;
// Pragul de la care un blocaj devine alerta. 250 ms = peste orice cerere normala, dar sub un
// pg_dump sau o serializare mare — adica prinde exact ce n-ar trebui sa se intample.
const LAG_WARN_MS = Number(process.env.CONTAB_LAG_WARN_MS) || 250;
const lagH = monitorEventLoopDelay({ resolution: LAG_RES_MS });
lagH.enable(); // timerul intern e unref-uit: NU tine procesul in viata (verificat, altfel testele ar atarna)
let lagMaxTotal = 0;             // varful de la pornire, peste toate ferestrele
let lagWindowFrom = Date.now();

const lagMs = (ns) => Math.max(0, Math.round((ns / 1e6 - LAG_RES_MS) * 10) / 10);

/**
 * Traducerea PURA a histogramei in cifrele raportate — scoasa separat ca sa poata fi verificata
 * sincron, cu o histograma inventata (tiparul lui persistVerdict din jobs.js). Altfel proba ar
 * cere ture reale de bucla, deci un test asincron, iar test/run.js e sincron prin constructie.
 * `h` are nevoie doar de { count, max, percentile(p) }.
 */
function lagValues(h, fereastraSec, maxTotal) {
  const gol = !h || h.count === 0;
  return {
    fereastraSec,
    p50Ms: gol ? 0 : lagMs(h.percentile(50)),
    p99Ms: gol ? 0 : lagMs(h.percentile(99)),
    maxMs: gol ? 0 : lagMs(h.max),
    maxTotalMs: maxTotal,
    pragMs: LAG_WARN_MS,
    rezolutieMs: LAG_RES_MS,
  };
}

/** Citirea ferestrei curente, FARA reset — o privire in /api/metrics nu are voie sa strice
 *  fereastra pe care se uita jobul lag-watch. */
function lagSnapshot() {
  return lagValues(lagH, Math.round((Date.now() - lagWindowFrom) / 1000), lagMaxTotal);
}

/** Inchide fereastra: intoarce ce s-a masurat, retine varful de la pornire si porneste alta.
 *  O foloseste jobul lag-watch — o alerta trebuie sa spuna „acum", nu „candva de la pornire",
 *  iar `maxMs` al unei histograme necurate n-ar mai scadea niciodata. */
function lagRoll() {
  const s = lagSnapshot();
  if (s.maxMs > lagMaxTotal) lagMaxTotal = s.maxMs;
  s.maxTotalMs = lagMaxTotal;
  lagH.reset(); lagWindowFrom = Date.now();
  return s;
}

// ── JURNALUL DE AUDIT DURABIL: cate scrieri au reusit si cate au esuat ──
// src/auditLog.js e best-effort DELIBERAT (un esec de scriere nu rupe cererea) si avertizeaza in
// consola o SINGURA data pana la urmatorul succes, ca sa nu inunde logul. Cele doua impreuna
// faceau tacere: o permisiune stricata dadea o linie in log, apoi nimic — la nesfarsit. Si nu e
// o tacere oarecare: plafonul din baza vie (CONTAB_AUDIT_MAX) e justificat TOCMAI de faptul ca
// proba durabila exista pe disc. Daca ea nu se mai scrie, rolarea chiar pierde proba.
// Aici se numara FIECARE esec, nu doar primul — throttle-ul ramane doar pe consola.
const audit = { scrise: 0, esecuri: 0, esecConsecutive: 0, lastError: null, lastErrorAt: null, lastOkAt: null };
function auditOk() { audit.scrise += 1; audit.esecConsecutive = 0; audit.lastOkAt = new Date().toISOString(); }
function auditFail(msg) {
  audit.esecuri += 1; audit.esecConsecutive += 1;
  audit.lastError = String(msg || '').slice(0, 200); audit.lastErrorAt = new Date().toISOString();
}
function auditSnapshot() { return Object.assign({}, audit); }

// ── TRUNCHIERI (garda OOM din src/paginate.js) ──
// Acelasi tipar ca la audit, din acelasi motiv: o lista peste plafon e o stare PERMANENTA, nu un
// eveniment. `access:vizitatori` sta peste plafon de luni de zile, deci fiecare deschidere a
// paginii de administrare scria o linie in jurnalul de erori — iar erorile REALE se pierdeau
// intre ele. Consola se throttle-uieste (vezi paginate.js), dar AICI se numara FIECARE trunchiere:
// altfel remediul zgomotului ar deveni tacere, adica exact defectul pe care il repara.
const MAX_ETICHETE_TRUNC = 50; // etichetele vin din cod (set mic si fix); plafonul e doar plasa
const trunchieri = new Map();
function truncation(label, total, cap) {
  const k = String(label || '(fara eticheta)').slice(0, 80);
  let t = trunchieri.get(k);
  if (!t) {
    if (trunchieri.size >= MAX_ETICHETE_TRUNC) return;
    t = { n: 0, ultimTotal: 0, cap: 0, primaLa: new Date().toISOString(), ultimaLa: null };
    trunchieri.set(k, t);
  }
  t.n += 1; t.ultimTotal = total; t.cap = cap; t.ultimaLa = new Date().toISOString();
}
function truncationsSnapshot() {
  const out = {};
  for (const [k, v] of trunchieri) out[k] = Object.assign({}, v);
  return out;
}

/** Doar pentru teste: goleste agregatele. */
function reset() {
  routes.clear(); recentErrors.length = 0; jobs.clear(); slowRing.length = 0;
  jobRing.length = 0; persistRing.length = 0;
  persist.n = 0; persist.totalMs = 0; persist.maxMs = 0; persist.lastMs = 0; persist.lastAt = null;
  ai.n = 0; ai.fail = 0; ai.totalMs = 0; ai.lastError = null; ai.lastErrorAt = null;
  lagH.reset(); lagMaxTotal = 0; lagWindowFrom = Date.now();
  audit.scrise = 0; audit.esecuri = 0; audit.esecConsecutive = 0;
  audit.lastError = null; audit.lastErrorAt = null; audit.lastOkAt = null;
  clientErrors.clear();
  trunchieri.clear();
}

module.exports = {
  MEM_LIMIT_MB, MEM_WARN_MB, LAG_WARN_MS,
  SLOW_MS, routePattern, record, snapshot, reset,
  recordError, recentErrors, jobTick, jobResult, jobError, jobsSnapshot,
  jobRun, jobsRecent, persistRun, persistPeak, persistSnapshot,
  aiCall, aiSnapshot, lagSnapshot, lagRoll, lagValues, slowRecent, recordSlow,
  auditOk, auditFail, auditSnapshot,
  truncation, truncationsSnapshot,
  clientErrorRecord, clientError, clientErrorsSnapshot, MAX_CLIENT_ERRORS,
};
