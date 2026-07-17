'use strict';

// Urmarirea erorilor de server (fereastra 5xx + alerta pe email), handlerul global de erori
// Express si plasele de siguranta pe proces — scoase din server.js. Starea ferestrei traieste
// la nivel de modul: un singur proces, un singur contor.

const log = require('./log');
const metrics = require('./metrics');
const { sendNotifMail } = require('./notify');

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

// Handler global de erori — se instaleaza DUPA toate rutele. Raspuns curat (JSON), fara
// scurgere de stack catre client; 4xx isi pastreaza mesajul, 5xx devin generice si se
// logheaza pe server.
function installErrorHandler(app) {
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) { log.error('eroare de server', log.ctx(req, { status, err })); trackServerError(req, err); }
    const msg = status < 500 && err && err.message ? err.message : 'A aparut o eroare interna. Incearca din nou.';
    res.status(status).json(status >= 500 ? { error: msg, reqId: req.reqId } : { error: msg });
  });
}

// Plasa de siguranta: o eroare intr-un timer/callback async (ex. un job periodic) NU trebuie sa
// doboare tot procesul. Logam si continuam — pm2 nu mai e nevoit sa reporneasca, iar cererile in
// zbor nu se pierd. (Erorile din rute sunt tratate de wrap() si de handlerul Express de mai sus.)
function installProcessGuards() {
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { err });
    try { trackServerError({ method: 'PROC', originalUrl: 'uncaughtException' }, err); } catch (_) { /* ignora */ }
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', { err: reason });
  });
}

module.exports = { trackServerError, installErrorHandler, installProcessGuards };
