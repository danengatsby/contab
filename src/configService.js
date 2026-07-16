'use strict';

// Service layer pentru configurarea firmei si a aplicatiei: datele firmei, logo-ul (validat
// PNG/JPEG pe magic bytes — apare in antetul PDF-urilor), numerotarea chitantei din seria CH,
// setarile aplicatiei si cotele fiscale configurabile. Rutele (src/routes/config.js) raman
// puncte de intrare subtiri; servirea logo-ului (citire pura) si redarea PDF raman in ruta.
//
// Autorizarea pe firma e dublata prin reqFirma; seriile de documente vin direct din
// stocksService (ensureDocSeries), nu prin ctx.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const fiscal = require('./fiscal');
const { reqFirma, ensureDocSeries } = require('./stocksService');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Actualizeaza datele firmei; logo-ul se administreaza doar prin functiile dedicate
 *  (fisier validat), deci campul e ignorat aici. */
function updateCompany(fid, b) {
  fid = reqFirma(fid);
  const f = db.getFirma(fid);
  b = Object.assign({}, b || {});
  delete b.logoFile;
  Object.assign(f, b, { id: f.id });
  db.save();
  return { company: f };
}

/** Seteaza logo-ul firmei din fisierul deja salvat de multer: doar PNG/JPEG (validate pe
 *  magic bytes, nu pe extensie — PDF-urile nu accepta alte formate); logo-ul vechi se sterge. */
function setLogo(fid, filePath) {
  fid = reqFirma(fid);
  let head;
  try { head = fs.readFileSync(filePath).slice(0, 4); } catch (e) { fail(400, 'Fisier ilizibil.'); }
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
  const isJpg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
  if (!isPng && !isJpg) {
    try { fs.unlinkSync(filePath); } catch (_) { /* */ }
    fail(400, 'Logo-ul trebuie sa fie PNG sau JPEG (PDF-urile nu accepta alte formate).');
  }
  const f = db.getFirma(fid);
  if (f.logoFile) { try { fs.unlinkSync(path.join(db.UPLOAD_DIR, f.logoFile)); } catch (_) { /* logo vechi deja sters */ } }
  f.logoFile = path.basename(filePath);
  db.save();
  return { logoFile: f.logoFile, format: isPng ? 'PNG' : 'JPEG' };
}

/** Sterge logo-ul (fisier + camp); lipsa logo-ului NU e eroare (contract istoric). */
function deleteLogo(fid) {
  fid = reqFirma(fid);
  const f = db.getFirma(fid);
  if (f && f.logoFile) {
    try { fs.unlinkSync(path.join(db.UPLOAD_DIR, f.logoFile)); } catch (_) { /* deja sters */ }
    delete f.logoFile;
    db.save();
  }
}

/** Chitanta pentru o incasare in numerar (531x): numarul se atribuie din seria CH la prima
 *  tiparire si se REFOLOSESTE la retiparire (nu consuma serie). Erorile ajung text in ruta. */
function assignChitanta(fid, entryId) {
  fid = reqFirma(fid);
  const d = db.get();
  const e = d.entries.find((x) => x.id === entryId && (x.firmaId == null ? d.firmaActiva : x.firmaId) === fid);
  if (!e) fail(404, 'Inregistrare inexistenta');
  const suma = e.lines.reduce((s, l) => s + (/^531/.test(String(l.debit)) ? l.suma : 0), 0);
  if (suma <= 0) fail(400, 'Inregistrarea nu este o incasare in numerar (531x) — chitanta se emite doar pentru incasari in casa.');
  let justAssigned = false;
  if (!e.chitantaNr) {
    const s = ensureDocSeries(d, fid).CH;
    e.chitantaNr = s.serie + '-' + String(s.next).padStart(5, '0');
    s.next += 1;
    justAssigned = true;
    db.save();
  }
  return { entry: e, suma: Math.round(suma * 100) / 100, nr: e.chitantaNr, justAssigned };
}

/** Setarile aplicatiei (globale): merge peste cele existente. */
function updateSettings(b) {
  const d = db.get();
  d.settings = Object.assign({}, d.settings, b || {});
  db.save();
  return { settings: d.settings };
}

/** Cotele fiscale configurabile (admin): doar cheile din DEFAULTS, numerice; `reset` revine
 *  la valorile standard. Configul se aplica imediat (fiscal.applyConfig). */
function setFiscalConfig(b) {
  const d = db.get();
  b = b || {};
  let reset = false;
  if (b.reset) { delete d.settings.fiscal; fiscal.applyConfig({}); reset = true; }
  else {
    const cfg = Object.assign({}, d.settings.fiscal || {});
    for (const k of Object.keys(fiscal.DEFAULTS)) { if (b[k] != null && b[k] !== '' && Number.isFinite(Number(b[k]))) cfg[k] = Number(b[k]); }
    d.settings.fiscal = cfg;
    fiscal.applyConfig(cfg);
  }
  db.save();
  return { current: fiscal.FISCAL, reset };
}

module.exports = { updateCompany, setLogo, deleteLogo, assignChitanta, updateSettings, setFiscalConfig };
