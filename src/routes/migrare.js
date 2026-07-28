'use strict';

// Preluarea unei firme din alt program: incarca balanta -> previzualizare -> import.
// Cele doua trepte sunt DELIBERAT separate: nimic nu se scrie la incarcare, iar importul
// primeste exact randurile confirmate de om, nu fisierul reinterpretat a doua oara.

const fs = require('fs');
const db = require('../db');
const migrare = require('../migrare');
const xlsx = require('../xlsx');
const xls = require('../xls');
const dbf = require('../dbf');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Randuri dintr-un fisier tabelar, dupa CONTINUT (magic bytes), cu extensia ca rezerva. */
function citesteRanduri(filePath, originalName) {
  const data = fs.readFileSync(filePath);
  const name = originalName || '';
  const isXlsx = (data.length > 1 && data[0] === 0x50 && data[1] === 0x4B) || /\.xlsx$/i.test(name);
  const isXls = (data.length > 1 && data[0] === 0xD0 && data[1] === 0xCF) || /\.xls$/i.test(name);
  const isDbf = /\.dbf$/i.test(name) || [0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x83, 0x8b, 0xf5, 0xfb].includes(data[0]);
  if (isXlsx) return xlsx.parseXlsx(data);
  if (isXls) return xls.parseXls(data);
  if (isDbf) return dbf.parseDbf(data);
  // CSV/TXT: separatorul se deduce din antet (`;` in exporturile romanesti, `,` in cele engleze)
  const text = data.toString('utf8').replace(/^﻿/, '');
  const linii = text.split(/\r?\n/).filter((l) => l.trim());
  if (!linii.length) return [];
  const delim = (linii[0].match(/;/g) || []).length >= (linii[0].match(/,/g) || []).length ? ';' : ',';
  return linii.map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '').trim()));
}

module.exports = function register(app, ctx) {
  const { activeId, logAudit, upload } = ctx;

  const run = (res, fn) => {
    try { res.json(fn()); } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message });
    }
  };

  // Treapta 1: incarca fisierul si intoarce PREVIZUALIZAREA. Nu scrie nimic in baza.
  app.post('/api/migrare/preview', upload.single('file'), (req, res) => run(res, () => {
    if (!req.file) fail(400, 'Niciun fisier primit.');
    let randuri;
    try { randuri = citesteRanduri(req.file.path, req.file.originalname); }
    catch (e) { fail(400, e.message || 'Fisier nerecunoscut.'); }
    finally { try { fs.unlinkSync(req.file.path); } catch (_) { /* fisierul temporar se sterge intotdeauna */ } }
    if (!randuri.length) fail(400, 'Fisierul este gol sau nerecunoscut.');

    // Antetul e primul rand care contine un tipar de coloana cunoscut — exporturile au adesea
    // 2-5 randuri de titlu (denumirea firmei, perioada) inaintea tabelului propriu-zis.
    let idxAntet = 0; let det = migrare.detectMapping(randuri[0]);
    for (let i = 0; i < Math.min(randuri.length, 15); i++) {
      const d = migrare.detectMapping(randuri[i]);
      if (d.map.cont != null && (d.map.sfd != null || d.map.sid != null)) { idxAntet = i; det = d; break; }
    }
    const corp = randuri.slice(idxAntet + 1);
    const sursa = req.query.sursa === 'initial' ? 'initial' : 'final';
    const roles = (req.query.zecimal === '.' || req.query.zecimal === ',')
      ? { [req.query.zecimal]: 'zecimale', [req.query.zecimal === '.' ? ',' : '.']: 'mii' } : null;
    const pv = migrare.buildPreview(corp, det.map, { sursa, roles });
    return {
      antet: det.antet, idxAntet, mapare: det.map, nefolosite: det.nefolosite, sursa,
      randuriFisier: randuri.length, preview: pv,
    };
  }));

  // Treapta 2: importul propriu-zis. TRANZACTIONAL: ori tot, ori nimic.
  app.post('/api/migrare/import', (req, res) => run(res, () => {
    const b = req.body || {};
    const fid = Number(b.firmaId != null ? b.firmaId : activeId(req));
    // Firma EXPLICITA si existenta — fara fallback pe `firmaActiva`: un import scris din greseala
    // in alta firma nu se poate distinge ulterior de date reale.
    if (!Number.isInteger(fid) || fid <= 0 || !db.getFirma(fid)) fail(403, 'Firma invalida sau inexistenta.');
    const conturi = Array.isArray(b.conturi) ? b.conturi : [];
    if (!conturi.length) fail(400, 'Niciun cont de importat.');

    // REGULA DE AUR, verificata din nou AICI, pe ce se scrie efectiv — nu pe ce s-a previzualizat.
    // Intre previzualizare si import, corpul cererii poate fi orice: garda trebuie sa fie pe scriere.
    const totalD = Math.round(conturi.reduce((s, x) => s + (Number(x.d) || 0), 0) * 100) / 100;
    const totalC = Math.round(conturi.reduce((s, x) => s + (Number(x.c) || 0), 0) * 100) / 100;
    if (Math.abs(totalD - totalC) >= 0.005) {
      fail(400, 'Balanta nu e echilibrata (debit ' + totalD + ' vs credit ' + totalC + '). Importul a fost refuzat integral.');
    }

    const d = db.get();
    const existent = d.openingBalances[fid] || {};
    if (Object.keys(existent).length && !b.suprascrie) {
      fail(409, 'Firma are deja solduri de preluare (' + Object.keys(existent).length + ' conturi). '
        + 'Trimite `suprascrie: true` daca vrei sa le inlocuiesti.');
    }

    // Se construieste harta COMPLETA inainte de a atinge baza: daca un rand e invalid, nu s-a
    // scris inca nimic si refuzul e curat.
    const noi = {};
    for (const x of conturi) {
      const cont = String(x.cont || '').trim().replace(/\s/g, '');
      if (!cont || !/^\d/.test(cont)) fail(400, 'Cont invalid in lista: „' + (x.cont || '') + '".');
      const dd = Math.round((Number(x.d) || 0) * 100) / 100;
      const cc = Math.round((Number(x.c) || 0) * 100) / 100;
      if (dd < 0 || cc < 0) fail(400, 'Sold negativ la contul ' + cont + ': foloseste coloana corecta (debit/credit).');
      noi[cont] = { d: dd, c: cc };
    }

    d.openingBalances[fid] = noi;
    db.save();
    logAudit('migrare.import', 'preluare balanta: ' + Object.keys(noi).length + ' conturi, total ' + totalD
      + ' lei, in firma ' + fid, { req, firmaId: fid });
    return { ok: true, conturi: Object.keys(noi).length, totalD, totalC };
  }));
};
