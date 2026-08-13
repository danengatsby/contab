'use strict';

// Preluarea unei firme din alt program: incarca balanta -> previzualizare -> import.
// Cele doua trepte sunt DELIBERAT separate: nimic nu se scrie la incarcare, iar importul
// primeste exact randurile confirmate de om, nu fisierul reinterpretat a doua oara.

const fs = require('fs');
const db = require('../db');
const migrare = require('../migrare');
const migrationAux = require('../migrationAux');
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

  const presets = (u) => (Array.isArray(u && u.migrationPresets) ? u.migrationPresets : []);
  const publicPreset = (p) => ({ id: p.id, nume: p.nume, campuri: p.campuri, sursa: p.sursa,
    zecimal: p.zecimal || null, createdAt: p.createdAt, updatedAt: p.updatedAt });
  const reqNotDemo = (u) => {
    if (!u || u.username === 'demo' || u.username === 'demo-contabil') {
      fail(403, 'Contul demo este partajat — presetul nu poate fi modificat.');
    }
  };
  const targetFirma = (req, value) => {
    const fid = Number(value != null ? value : activeId(req));
    // Importul complet scrie colectii intregi. Tinta este intentionat firma ACTIVA, nu doar o
    // firma care exista: altfel un utilizator care ghiceste un id ar putea suprascrie alta firma.
    if (!Number.isInteger(fid) || fid <= 0 || !db.getFirma(fid) || fid !== Number(activeId(req))) {
      fail(403, 'Firma tinta nu este firma activa sau nu este accesibila.');
    }
    return fid;
  };

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

    const b = req.body || {};
    let preset = null;
    if (b.presetId) {
      preset = presets(req.user).find((p) => p.id === String(b.presetId));
      if (!preset) fail(404, 'Presetul de migrare nu exista sau apartine altui utilizator.');
    }
    const sursa = (b.sursa || req.query.sursa || (preset && preset.sursa)) === 'initial' ? 'initial' : 'final';

    // Antetul e primul rand care contine un tipar cunoscut. O mapare explicita (corectata in UI)
    // are prioritate, apoi presetul, apoi detectia automata.
    let idxAntet = 0; let det;
    if (b.mapare) {
      try { idxAntet = Number(b.idxAntet); det = { antet: randuri[idxAntet], map: JSON.parse(b.mapare) }; }
      catch (_) { fail(400, 'Maparea trimisa nu este JSON valid.'); }
      if (!Number.isInteger(idxAntet) || idxAntet < 0 || idxAntet >= randuri.length || !Array.isArray(det.antet)) {
        fail(400, 'Randul de antet ales nu exista in fisier.');
      }
      det.antet = det.antet.map((x) => String(x == null ? '' : x).trim());
    } else if (preset) {
      const gasit = migrare.detectPresetMapping(randuri, preset);
      if (!gasit) fail(400, 'Presetul „' + preset.nume + '” nu se potriveste cu antetul acestui fisier. Alege detectarea automata si remapeaza coloanele.');
      idxAntet = gasit.idxAntet; det = { antet: gasit.antet, map: gasit.map };
    } else {
      det = migrare.detectMapping(randuri[0]);
      for (let i = 0; i < Math.min(randuri.length, 15); i++) {
        const d = migrare.detectMapping(randuri[i]);
        if (d.map.cont != null && (d.map.sfd != null || d.map.sid != null)) { idxAntet = i; det = d; break; }
      }
    }
    const valid = migrare.validateMapping(det.map, det.antet.length, sursa);
    // La detectia automata intoarcem problema in preview, ca omul sa poata corecta selectiile.
    // O mapare explicita/preset invalida se refuza: nu are voie sa para ca a fost aplicata.
    if ((b.mapare || preset) && valid.probleme.length) fail(400, valid.probleme.join(' '));
    det.map = valid.map;
    const luate = new Set(Object.values(det.map));
    det.nefolosite = det.antet.map((h, i) => (luate.has(i) ? null : { i, h })).filter(Boolean);
    const corp = randuri.slice(idxAntet + 1);
    const zecimal = (b.zecimal === '.' || b.zecimal === ',') ? b.zecimal
      : ((req.query.zecimal === '.' || req.query.zecimal === ',') ? req.query.zecimal : (preset && preset.zecimal));
    const roles = (zecimal === '.' || zecimal === ',')
      ? { [zecimal]: 'zecimale', [zecimal === '.' ? ',' : '.']: 'mii' } : null;
    const pv = migrare.buildPreview(corp, det.map, { sursa, roles });
    return {
      antet: det.antet, idxAntet, mapare: det.map, nefolosite: det.nefolosite, sursa,
      zecimal: zecimal || null, presetAplicat: preset ? preset.id : null,
      randuriFisier: randuri.length, preview: pv,
    };
  }));

  // Preseturile apartin UTILIZATORULUI, nu firmei active: un contabil le refoloseste pentru
  // urmatorul client exportat din acelasi program, fara sa le expuna colaboratorilor firmei.
  app.get('/api/migrare/presets', (req, res) => res.json(presets(req.user).map(publicPreset)));
  app.post('/api/migrare/presets', (req, res) => run(res, () => {
    reqNotDemo(req.user);
    const b = req.body || {}; const nume = String(b.nume || '').trim().slice(0, 60);
    const antet = Array.isArray(b.antet) ? b.antet.map((x) => String(x == null ? '' : x).trim().slice(0, 120)) : [];
    const sursa = b.sursa === 'initial' ? 'initial' : 'final';
    if (nume.length < 2) fail(400, 'Denumirea presetului trebuie sa aiba cel putin 2 caractere.');
    if (!antet.length || antet.length > 100) fail(400, 'Antetul presetului este invalid.');
    const valid = migrare.validateMapping(b.mapare, antet.length, sursa);
    if (valid.probleme.length) fail(400, valid.probleme.join(' '));
    const campuri = migrare.presetFields(antet, valid.map);
    const acum = new Date().toISOString();
    req.user.migrationPresets = presets(req.user);
    let p = req.user.migrationPresets.find((x) => String(x.nume || '').toLowerCase() === nume.toLowerCase());
    const creat = !p;
    if (!p && req.user.migrationPresets.length >= 20) fail(400, 'Ai atins limita de 20 de preseturi de migrare. Sterge unul vechi.');
    if (!p) { p = { id: db.nextId('mp'), createdAt: acum }; req.user.migrationPresets.push(p); }
    Object.assign(p, { nume, campuri, sursa, zecimal: b.zecimal === '.' || b.zecimal === ',' ? b.zecimal : null, updatedAt: acum });
    db.save();
    logAudit(creat ? 'migrare.preset.create' : 'migrare.preset.update', nume, { req, firmaId: null });
    return { ok: true, creat, preset: publicPreset(p) };
  }));
  app.delete('/api/migrare/presets/:id', (req, res) => run(res, () => {
    reqNotDemo(req.user);
    const list = presets(req.user); const idx = list.findIndex((p) => p.id === req.params.id);
    if (idx < 0) fail(404, 'Presetul de migrare nu exista sau apartine altui utilizator.');
    const [p] = list.splice(idx, 1); req.user.migrationPresets = list;
    db.save(); logAudit('migrare.preset.delete', p.nume, { req, firmaId: null });
    return { ok: true };
  }));

  // Previzualizarea consolidata nu scrie nimic. Intoarce numai esantioane limitate; fisierele
  // sunt retrimise la import si REVALIDATE acolo, fiindca un corp HTTP poate fi modificat intre
  // cele doua trepte.
  app.post('/api/migrare/complet/preview', (req, res) => run(res, () => {
    const fid = targetFirma(req, (req.body || {}).firmaId);
    const p = migrationAux.prepare(req.body, { existingOpening: (db.get().openingBalances || {})[fid] || {} });
    return {
      ok: p.ok, problems: p.problems, summary: p.summary,
      sample: { parteneri: p.partners.items.slice(0, 5), active: p.fixedAssets.items.slice(0, 5), stoc: p.stock.items.slice(0, 5) },
    };
  }));

  app.post('/api/migrare/complet/import', (req, res) => run(res, () => {
    reqNotDemo(req.user);
    const b = req.body || {}; const fid = targetFirma(req, b.firmaId); const d = db.get();
    const p = migrationAux.prepare(b, { existingOpening: (d.openingBalances || {})[fid] || {} });
    if (!p.ok) fail(400, 'Importul complet a fost refuzat integral: ' + p.problems.slice(0, 8).join('; '));
    if (p.stock.present) db.assertPeriodOpen(fid, p.data, 'Preluarea completa a stocului initial');
    const existente = [];
    if (p.hasOpening && Object.keys((d.openingBalances || {})[fid] || {}).length) existente.push('solduri initiale');
    if (p.partners.present && Object.keys((d.partners || {})[fid] || {}).length) existente.push('parteneri');
    if (p.fixedAssets.present && (d.assets || []).some((x) => x.firmaId === fid)) existente.push('mijloace fixe');
    if (p.stock.present && ((d.products || []).some((x) => x.firmaId === fid)
      || (d.gestiuni || []).some((x) => x.firmaId === fid) || (d.stockMovements || []).some((x) => x.firmaId === fid))) existente.push('stocuri');
    if (existente.length && !b.suprascrie) fail(409, 'Firma are deja: ' + existente.join(', ')
      + '. Confirmarea de suprascriere este obligatorie; celelalte componente raman neschimbate.');
    const summary = migrationAux.apply(d, fid, p, (req.user && req.user.username) || '');
    logAudit('migrare.completa', 'balanta ' + summary.conturi + ', parteneri ' + summary.parteneri
      + ', active ' + summary.active + ', stoc ' + summary.pozitiiStoc + ' pozitii', { req, firmaId: fid });
    // Business-ul si urma lui de audit intra in ACEEASI fotografie persistata.
    db.save();
    return { ok: true, summary };
  }));

  // Treapta 2: importul propriu-zis. TRANZACTIONAL: ori tot, ori nimic.
  app.post('/api/migrare/import', (req, res) => run(res, () => {
    const b = req.body || {};
    const fid = targetFirma(req, b.firmaId);
    // Firma EXPLICITA si existenta — fara fallback pe `firmaActiva`: un import scris din greseala
    // in alta firma nu se poate distinge ulterior de date reale.
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
