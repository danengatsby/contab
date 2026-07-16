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
    jobs: jobsSnapshot(),
    ai: aiSnapshot(),
  };
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

/** Doar pentru teste: goleste agregatele. */
function reset() {
  routes.clear(); recentErrors.length = 0; jobs.clear();
  ai.n = 0; ai.fail = 0; ai.totalMs = 0; ai.lastError = null; ai.lastErrorAt = null;
}

module.exports = {
  SLOW_MS, routePattern, record, snapshot, reset,
  recordError, recentErrors, jobTick, jobResult, jobError, jobsSnapshot,
  aiCall, aiSnapshot,
};
