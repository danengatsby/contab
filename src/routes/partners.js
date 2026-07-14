'use strict';

// Nomenclatoare si solduri initiale: partenerii (nomenclator per firma, adaugare + import CSV),
// planul de conturi personalizat (import CSV), conversia XLSX/XLS/DBF -> CSV pentru fluxurile de
// import, soldurile initiale sintetice (cu verificarea echilibrului debit=credit) si analitice
// (pe partener). Modul de rute: register(app, ctx).

const fs = require('fs');
const db = require('../db');
const coa = require('../chartOfAccounts');
const xlsx = require('../xlsx');
const xls = require('../xls');
const dbf = require('../dbf');
const { toCsv, parseCsv } = require('../csv');
const { round2 } = require('../util');

module.exports = function register(app, ctx) {
  const { upload, S, activeId, logAudit } = ctx;

  // Import plan de conturi personalizat din CSV: Cod;Denumire;Clasa;Tip (upsert in customAccounts)
  app.post('/api/accounts/import', (req, res) => {
    const rows = parseCsv((req.body || {}).csv || '');
    if (!rows.length) return res.status(400).json({ error: 'CSV gol sau invalid.' });
    let start = 0;
    if (/cont|cod|denumire/i.test((rows[0][0] || '') + (rows[0][1] || ''))) start = 1;
    const d = db.get();
    const list = [];
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      const cod = String(r[0] || '').trim();
      if (!cod || !r[1]) continue;
      list.push({ cod, nume: r[1], clasa: Number(r[2]) || Number(cod[0]) || 0, tip: (r[3] || 'B').toUpperCase() });
    }
    // upsert in customAccounts
    for (const a of list) {
      const ex = d.customAccounts.find((x) => x.cod === a.cod);
      if (ex) Object.assign(ex, a); else d.customAccounts.push(a);
    }
    coa.addAccounts(list);
    logAudit('accounts.import', list.length + ' conturi', { req });
    db.save();
    res.json({ ok: true, importati: list.length, totalConturi: coa.ACCOUNTS.length });
  });

  app.get('/api/partners', (req, res) => res.json(S(req).partners));
  app.post('/api/partners', (req, res) => {
    const p = req.body || {};
    const key = String(p.cui || '').replace(/^ro/i, '').replace(/\s/g, '');
    if (!key) return res.status(400).json({ error: 'CUI lipsa.' });
    const d = db.get();
    const fid = activeId(req);
    d.partners[fid] = d.partners[fid] || {};
    const prev = d.partners[fid][key] || {};
    d.partners[fid][key] = {
      cui: key, den: p.den || '', adresa: p.adresa || '', oras: p.oras || '',
      judet: p.judet || '', tara: p.tara || 'RO', tip: p.tip != null ? p.tip : (prev.tip || ''),
    };
    db.save();
    res.json({ ok: true, partner: d.partners[fid][key] });
  });
  // Import parteneri din CSV: coloane CUI;Denumire;Adresa;Oras;Judet;Tara (header optional)
  // Conversie XLSX (Excel modern) / DBF (dBASE-FoxPro) -> CSV, pentru fluxurile de import (parteneri, conturi, produse).
  app.post('/api/xlsx-to-csv', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
    let rows;
    try {
      const data = fs.readFileSync(req.file.path);
      const name = req.file.originalname || '';
      const isXlsx = (data.length > 1 && data[0] === 0x50 && data[1] === 0x4B) || /\.xlsx$/i.test(name); // "PK" -> zip
      const isXls = (data.length > 1 && data[0] === 0xD0 && data[1] === 0xCF) || /\.xls$/i.test(name);   // OLE compound -> Excel vechi
      const isDbf = /\.dbf$/i.test(name) || [0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x83, 0x8b, 0xf5, 0xfb].includes(data[0]);
      rows = isXlsx ? xlsx.parseXlsx(data) : isXls ? xls.parseXls(data) : isDbf ? dbf.parseDbf(data) : xlsx.parseXlsx(data);
    } catch (e) { try { fs.unlinkSync(req.file.path); } catch (_) { /* */ } return res.status(400).json({ error: e.message }); }
    try { fs.unlinkSync(req.file.path); } catch (_) { /* */ }
    if (!rows.length) return res.status(400).json({ error: 'Fisierul este gol sau nerecunoscut.' });
    res.json({ ok: true, rows: rows.length, csv: toCsv(rows[0], rows.slice(1)) });
  });
  app.post('/api/partners/import', (req, res) => {
    const rows = parseCsv((req.body || {}).csv || '');
    if (!rows.length) return res.status(400).json({ error: 'CSV gol sau invalid.' });
    // sare peste randul de antet daca prima celula nu pare un CUI
    let start = 0;
    if (/cui|cod|denumire/i.test((rows[0][0] || '') + (rows[0][1] || ''))) start = 1;
    const d = db.get();
    const fid = activeId(req);
    d.partners[fid] = d.partners[fid] || {};
    let importati = 0; const erori = [];
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      const key = String(r[0] || '').replace(/^ro/i, '').replace(/\s/g, '');
      if (!key) { erori.push('rand ' + (i + 1) + ': CUI lipsa'); continue; }
      d.partners[fid][key] = { cui: key, den: r[1] || '', adresa: r[2] || '', oras: r[3] || '', judet: r[4] || '', tara: r[5] || 'RO', tip: (r[6] || '').toLowerCase().trim() };
      importati += 1;
    }
    logAudit('partners.import', importati + ' parteneri', { req });
    db.save();
    res.json({ ok: true, importati, erori });
  });

  app.get('/api/opening-analytic', (req, res) => res.json(S(req).openingAnalytic));
  app.post('/api/opening-analytic', (req, res) => {
    const b = req.body || {};
    if (!b.cont) return res.status(400).json({ error: 'Lipseste contul.' });
    const d = db.get();
    const fid = activeId(req);
    d.openingAnalytic = d.openingAnalytic || [];
    const key = (p) => p.firmaId + '|' + p.cont + '|' + String(p.cui || p.partener || '').toUpperCase().replace(/^RO/i, '').replace(/\s/g, '');
    const rec = { firmaId: fid, cont: String(b.cont), partener: b.partener || '', cui: b.cui || '', d: round2(parseFloat(b.d) || 0), c: round2(parseFloat(b.c) || 0) };
    const i = d.openingAnalytic.findIndex((x) => key(x) === key(rec));
    if (i >= 0) d.openingAnalytic[i] = rec; else d.openingAnalytic.push(rec);
    db.save();
    res.json({ ok: true, openingAnalytic: d.openingAnalytic.filter((o) => o.firmaId === fid) });
  });
  app.delete('/api/opening-analytic/:idx', (req, res) => {
    const d = db.get();
    const fid = activeId(req);
    const list = d.openingAnalytic.filter((o) => (o.firmaId == null ? d.firmaActiva : o.firmaId) === fid);
    const rec = list[Number(req.params.idx)];
    if (rec) { const gi = d.openingAnalytic.indexOf(rec); if (gi >= 0) d.openingAnalytic.splice(gi, 1); }
    db.save();
    res.json({ ok: true });
  });

  app.get('/api/opening', (req, res) => res.json(S(req).openingBalances));
  app.post('/api/opening', (req, res) => {
    const d = db.get();
    const ob = (req.body && req.body.openingBalances) ? req.body.openingBalances : {};
    // Soldurile initiale trebuie sa fie echilibrate (total debit = total credit), altfel balanta
    // nu se va inchide niciodata. Verificam inainte de salvare si respingem cu diferenta exacta.
    let totD = 0; let totC = 0;
    for (const cod of Object.keys(ob)) { totD = round2(totD + (Number(ob[cod] && ob[cod].d) || 0)); totC = round2(totC + (Number(ob[cod] && ob[cod].c) || 0)); }
    const dif = round2(totD - totC);
    if (Math.abs(dif) >= 0.005) {
      return res.status(400).json({ error: 'Soldurile inițiale sunt dezechilibrate: total debit ' + totD + ' ≠ total credit ' + totC + ' (diferență ' + dif + '). Corectează-le înainte de salvare.', totalDebit: totD, totalCredit: totC, diferenta: dif });
    }
    d.openingBalances[activeId(req)] = ob;
    logAudit('opening.set', 'solduri initiale (' + Object.keys(ob).length + ' conturi, echilibrat)', { req });
    db.save();
    res.json({ ok: true, totalDebit: totD, totalCredit: totC });
  });
};
