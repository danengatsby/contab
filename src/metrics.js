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
  return { sinceTs: new Date(startedAt).toISOString(), slowThresholdMs: SLOW_MS, routes: list.slice(0, 100) };
}

/** Doar pentru teste: goleste agregatele. */
function reset() { routes.clear(); }

module.exports = { SLOW_MS, routePattern, record, snapshot, reset };
