'use strict';

// Logger minimal, fara dependinte. O linie per eveniment: implicit lizibil (pentru `pm2 logs`),
// sau JSON (CONTAB_LOG_JSON=1) pentru agregare masinala. Nivelul minim: CONTAB_LOG_LEVEL
// (debug|info|warn|error; implicit info). Contextul {reqId,user,userId,firmaId,method,url,status,ms}
// se ataseaza fiecarei linii, ca sa poti corela o eroare 5xx cu utilizatorul / firma / cererea.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.CONTAB_LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const JSON_MODE = process.env.CONTAB_LOG_JSON === '1';
const ORDER = ['reqId', 'user', 'userId', 'firmaId', 'method', 'url', 'status', 'ms'];

function fmtCtx(c) {
  const parts = [];
  for (const k of ORDER) if (c[k] != null && c[k] !== '') parts.push(k + '=' + c[k]);
  for (const k of Object.keys(c)) { if (k !== 'err' && !ORDER.includes(k) && c[k] != null && c[k] !== '') parts.push(k + '=' + c[k]); }
  return parts.length ? ' [' + parts.join(' ') + ']' : '';
}

function emit(level, msg, ctx) {
  if (LEVELS[level] < MIN) return;
  const c = ctx || {};
  const err = c.err;
  const ts = new Date().toISOString();
  const toErr = level === 'error' || level === 'warn';
  if (JSON_MODE) {
    const rec = { ts, level, msg: String(msg) };
    for (const k of Object.keys(c)) if (k !== 'err') rec[k] = c[k];
    if (err) rec.err = (err && err.stack) || String((err && err.message) || err);
    (toErr ? process.stderr : process.stdout).write(JSON.stringify(rec) + '\n');
    return;
  }
  const line = ts + ' ' + level.toUpperCase() + fmtCtx(c) + ' ' + String(msg) + (err ? '\n' + ((err && err.stack) || err) : '');
  (toErr ? console.error : console.log)(line);
}

module.exports = {
  debug: (m, c) => emit('debug', m, c),
  info: (m, c) => emit('info', m, c),
  warn: (m, c) => emit('warn', m, c),
  error: (m, c) => emit('error', m, c),
  /** Construieste contextul standard dintr-o cerere Express (reqId, user, ruta). */
  ctx(req, extra) {
    const c = extra ? Object.assign({}, extra) : {};
    if (req) {
      if (req.reqId) c.reqId = req.reqId;
      if (req.method) c.method = req.method;
      if (req.originalUrl || req.url) c.url = req.originalUrl || req.url;
      const u = req.user || req.realUser;
      if (u) { c.userId = u.id; c.user = u.username; }
    }
    return c;
  },
};
