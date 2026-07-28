'use strict';

// Protectia upload-urilor, in doua straturi peste filtrul de extensii al multer:
//
// 1) Verificarea CONTINUTULUI pe magic bytes, dupa salvarea multer (fileFilter nu vede
//    continutul). Semnaturi stricte doar pentru tipurile procesate sau servibile inline
//    (PDF + imagini — exact cele cu risc de continut activ) si verificare "fara octeti NUL"
//    pentru formatele text (CSV/TXT/XML/JSON/extrase bancare). Formatele container
//    (.zip/.xlsx/.xls/.dbf) raman pe validarea parserului lor: au variante istorice multe
//    (exporturi "xls" care sunt de fapt text) si nu sunt servite niciodata inline, deci
//    respingerea pe semnatura ar rupe importuri reale fara castig de securitate.
//    Fisierul respins se sterge de pe disc — nu ramane nimic neprocesabil in uploads/.
//
// 2) Plafon de cereri per UTILIZATOR (nu per IP: rutele de upload/export sunt autentificate,
//    abuzul vine de la conturi). Bucket-uri pe ora intr-un Map, curatate de jobul
//    rate-limit-hygiene din server.js (pruneRateBuckets).

const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.csv', '.txt', '.xml', '.json', '.sta', '.940', '.mt940']);

/** Continutul corespunde extensiei? Verifica doar primii octeti (bufferul primit e capul fisierului). */
function contentMatches(ext, b) {
  switch (ext) {
    case '.pdf': return b.includes('%PDF'); // antetul PDF poate fi precedat de junk (spec permite pana la 1KB)
    case '.png': return b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
    case '.jpg':
    case '.jpeg': return b.length > 2 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    case '.webp': return b.length > 11 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
    case '.gif': return b.length > 3 && b.toString('ascii', 0, 4) === 'GIF8';
    default:
      if (TEXT_EXT.has(ext)) return !b.includes(0); // text: fara octeti NUL
      // FARA EXTENSIE = necunoscut, nu „container". Ramura `default` a fost scrisa pentru
      // .zip/.xlsx/.xls/.dbf, care isi au parserul lor — dar prindea si extensia GOALA, si atunci
      // orice continut trecea nevalidat. Multer stocheaza un fisier fara extensie ca `.pdf`
      // (`path.extname(...) || '.pdf'`), deci acei octeti ajungeau la extractorul PDF si la API-ul
      // AI ca si cum ar fi fost un PDF. Fail-closed: necunoscutul se respinge.
      if (!ext) return false;
      return true; // containere (.zip/.xlsx/.xls/.dbf) — valideaza parserul lor
  }
}

function readHead(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(8192);
    const n = fs.readSync(fd, b, 0, 8192, 0);
    return b.slice(0, n);
  } finally { fs.closeSync(fd); }
}

/** Middleware DUPA multer: valideaza continutul fisierului salvat; nepotrivirea sterge fisierul. */
function verifyUploadContent(req, res, next) {
  if (!req.file || !req.file.path) return next();
  const ext = path.extname(req.file.filename || req.file.originalname || '').toLowerCase();
  let head;
  try { head = readHead(req.file.path); } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) { /* best-effort */ }
    return res.status(400).json({ error: 'Fisier ilizibil.' });
  }
  if (!contentMatches(ext, head)) {
    try { fs.unlinkSync(req.file.path); } catch (_) { /* best-effort */ }
    return res.status(400).json({ error: 'Continutul fisierului nu corespunde extensiei ' + ext + ' — fisier respins.' });
  }
  next();
}

// ── Plafon per utilizator (bucket-uri pe ora) ──

const WINDOW_MS = 3600 * 1000;
const buckets = new Map(); // "nume|userId" -> { count, reset }

/** Fabrica de middleware: plafoneaza `max` cereri/ora per utilizator pentru actiunea `name`.
 *  Cererile respinse conteaza si ele (nu se poate "pipai" plafonul gratuit). */
function userLimit(name, max, msg) {
  return (req, res, next) => {
    const uid = req.user && req.user.id;
    if (uid == null || !(max > 0)) return next(); // fara utilizator sau plafon dezactivat (max=0)
    const k = name + '|' + uid;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || now > b.reset) b = { count: 0, reset: now + WINDOW_MS };
    b.count += 1;
    buckets.set(k, b);
    if (b.count > max) {
      return res.status(429).json({ error: msg + ' Reincearca peste ~' + Math.max(1, Math.ceil((b.reset - now) / 60000)) + ' min.' });
    }
    next();
  };
}

/** Plafon GENERAL pe rutele de API: `max` cereri pe fereastra `windowMs`, per utilizator
 *  (sau per IP inainte de autentificare). Plasa contra buclelor de client si scanarilor —
 *  generos fata de utilizarea normala; max=0 (CONTAB_RATE_API=0) il dezactiveaza. */
function generalLimit(max, windowMs) {
  return (req, res, next) => {
    if (!(max > 0)) return next();
    const key = 'api|' + (req.user && req.user.id != null ? 'u' + req.user.id : 'ip' + String(req.ip || 'necunoscut'));
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) b = { count: 0, reset: now + windowMs };
    b.count += 1;
    buckets.set(key, b);
    if (b.count > max) {
      return res.status(429).json({ error: 'Prea multe cereri într-un timp scurt. Reîncearcă în câteva secunde.' });
    }
    next();
  };
}

/** Curatare pentru jobul rate-limit-hygiene: bucket-urile expirate se arunca. */
function pruneRateBuckets(now) {
  for (const [k, b] of buckets) { if (b.reset < now) buckets.delete(k); }
}

module.exports = { contentMatches, verifyUploadContent, userLimit, generalLimit, pruneRateBuckets };
