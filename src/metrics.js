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

function record(pattern, ms, status) {
  let r = routes.get(pattern);
  if (!r) {
    if (routes.size >= MAX_ROUTES) return; // plin: nu mai deschidem tipare noi (cele fierbinti exista deja)
    r = { n: 0, totalMs: 0, maxMs: 0, slow: 0, err5xx: 0 };
    routes.set(pattern, r);
  }
  r.n += 1; r.totalMs += ms; if (ms > r.maxMs) r.maxMs = ms;
  if (ms >= SLOW_MS) r.slow += 1;
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
    jobs: jobsSnapshot(),
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

// ── Starea job-urilor de background (tick = a rulat verificarea; result/error = ce a facut) ──
const jobs = new Map(); // label -> { lastTickAt, lastResult, lastResultAt, lastError, lastErrorAt, errors }
function job(label) {
  let j = jobs.get(label);
  if (!j) { j = { lastTickAt: null, lastResult: null, lastResultAt: null, lastError: null, lastErrorAt: null, errors: 0 }; jobs.set(label, j); }
  return j;
}
function jobTick(label) { job(label).lastTickAt = new Date().toISOString(); }
function jobResult(label, info) { const j = job(label); j.lastResult = String(info).slice(0, 200); j.lastResultAt = new Date().toISOString(); }
function jobError(label, msg) { const j = job(label); j.lastError = String(msg).slice(0, 200); j.lastErrorAt = new Date().toISOString(); j.errors += 1; }
function jobsSnapshot() {
  const out = {};
  for (const [label, j] of jobs) out[label] = Object.assign({}, j);
  return out;
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

/** Doar pentru teste: goleste agregatele. */
function reset() {
  routes.clear(); recentErrors.length = 0; jobs.clear();
  ai.n = 0; ai.fail = 0; ai.totalMs = 0; ai.lastError = null; ai.lastErrorAt = null;
  lagH.reset(); lagMaxTotal = 0; lagWindowFrom = Date.now();
}

module.exports = {
  MEM_LIMIT_MB, MEM_WARN_MB, LAG_WARN_MS,
  SLOW_MS, routePattern, record, snapshot, reset,
  recordError, recentErrors, jobTick, jobResult, jobError, jobsSnapshot,
  aiCall, aiSnapshot, lagSnapshot, lagRoll, lagValues,
};
