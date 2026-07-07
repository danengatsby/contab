'use strict';

// Rutele ANAF/SPV si import e-Factura. Modul de rute: register(app, ctx).
// Logica independenta de request e in src/anafService.js; aici raman doar handler-ele HTTP.

const anaf = require('../anaf');
const xml = require('../xml');
const coa = require('../chartOfAccounts');
const efacturaImport = require('../efacturaImport');
const db = require('../db');
const { round2, period: periodOf } = require('../util');
const { saveRecipisa, pollSpv, extractInvoiceXml } = require('../anafService');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function register(app, ctx) {
  const { activeId, wrap, logAudit, upsertPartner, canAccess, demoContLock } = ctx;
  // izolare multi-firma: operatiunile SPV pe o inregistrare cer acces la firma acesteia
  const entryAccess = (req, e, d) => canAccess(req, e.firmaId == null ? d.firmaActiva : e.firmaId);
  // Conexiunea SPV e PER-FIRMA (firma.anaf): fiecare firma isi are propriile credentiale
  // OAuth si token-uri. Config-ul e o referinta vie in obiectul firmei — reimprospatarea
  // token-ului in timpul unui apel se persista cu simplul db.save().
  const anafCfg = (fid) => (db.getFirma(fid) || {}).anaf || {};
  const anafCfgW = (fid) => { const f = db.getFirma(fid); if (!f) return {}; return (f.anaf = f.anaf || {}); };
  const entryCfg = (e, d) => anafCfgW(e.firmaId == null ? d.firmaActiva : e.firmaId);

  app.post('/api/efactura/parse', (req, res) => {
    try { res.json({ ok: true, invoice: efacturaImport.parseUBL((req.body || {}).xml || '') }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/efactura/import', (req, res) => {
    const b = req.body || {}; const fid = activeId(req); const d = db.get();
    let inv;
    try { inv = efacturaImport.parseUBL(b.xml || ''); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (!inv.furnizor.cui && !inv.furnizor.nume) return res.status(400).json({ error: 'Nu am putut identifica furnizorul din e-Factura.' });
    if (inv.moneda && inv.moneda !== 'RON') return res.status(400).json({ error: 'e-Factura este in ' + inv.moneda + '. Importul automat suporta deocamdata doar RON.' });
    const cont = b.cont || '371'; // contul de cheltuiala/stoc (371 marfuri implicit)
    if (!coa.getAccount(cont)) return res.status(400).json({ error: 'Cont inexistent in plan: ' + cont });
    const data = b.data || inv.data || new Date().toISOString().slice(0, 10);
    const firma = db.getFirma(fid) || {};
    if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) return res.status(400).json({ error: 'Perioada ' + periodOf(data) + ' este inchisa.' });
    const sign = inv.tip === 'creditnote' ? -1 : 1;
    const baza = round2(sign * inv.baza); const tva = round2(sign * inv.tva);
    const lines = [{ debit: cont, credit: '401', suma: baza, explicatie: 'Factura cumparare (import e-Factura)' }];
    if (Math.abs(tva) >= 0.005) lines.push({ debit: '4426', credit: '401', suma: tva, explicatie: 'TVA deductibila' });
    const entry = {
      id: db.nextId('e'), firmaId: fid, data, period: periodOf(data),
      tip: inv.tip === 'creditnote' ? 'factura_cumparare_storno' : 'factura_cumparare_marfuri',
      tipNume: (inv.tip === 'creditnote' ? 'Storno factura cumparare' : 'Factura cumparare') + ' (import e-Factura)',
      partener: inv.furnizor.nume, partenerCui: inv.furnizor.cui, document: inv.numar || '',
      explicatie: 'Import e-Factura primita', fileId: null, system: false, lines,
      items: inv.linii.map((l) => ({ nume: l.nume, cantitate: round2(sign * l.cantitate), pret: l.pret, cota: l.cota })),
    };
    d.entries.push(entry);
    upsertPartner(fid, entry);
    logAudit('efactura.import', (inv.numar || '') + ' / ' + (inv.furnizor.nume || inv.furnizor.cui), { req });
    db.save();
    res.json({ ok: true, entry, invoice: inv });
  });

  app.get('/api/anaf/config', (req, res) => {
    const fid = activeId(req);
    const c = anafCfg(fid);
    res.json({
      env: c.env || 'test', cif: c.cif || '', redirectUri: c.redirectUri || '',
      clientIdSet: !!c.clientId, configured: anaf.configured(c), connected: anaf.connected(c),
      autoPoll: !!c.autoPoll, tokenExpiry: c.tokenExpiry || 0,
      firma: (db.getFirma(fid) || {}).nume || '',
    });
  });
  app.post('/api/anaf/config', (req, res) => {
    // contul demo (public, partajat) nu configureaza conexiunea SPV nici pe firma demo
    if (demoContLock(req, res)) return;
    const c = anafCfgW(activeId(req));
    const b = req.body || {};
    ['env', 'clientId', 'clientSecret', 'redirectUri', 'cif'].forEach((k) => { if (b[k] != null) c[k] = b[k]; });
    if (b.autoPoll != null) c.autoPoll = !!b.autoPoll;
    db.save();
    res.json({ ok: true, configured: anaf.configured(c) });
  });
  app.get('/api/anaf/authorize', (req, res) => {
    const fid = activeId(req);
    const c = anafCfg(fid);
    if (!anaf.configured(c)) return res.status(400).json({ error: 'Completeaza intai client_id, client_secret si redirect_uri.' });
    // state = firmaId: la intoarcerea din ANAF, callback-ul stie pe ce firma leaga token-ul
    res.json({ url: anaf.authorizeUrl(c, fid) });
  });
  app.get('/api/anaf/callback', wrap(async (req, res) => {
    if (req.query.error) return res.redirect('/?anaf=error');
    if (!req.query.code) return res.status(400).send('Lipseste codul de autorizare.');
    const fid = req.query.state ? Number(req.query.state) : activeId(req);
    if (!canAccess(req, fid)) return res.status(403).send('Fara acces la aceasta firma.');
    const c = anafCfgW(fid);
    await anaf.exchangeCode(c, req.query.code);
    db.save();
    res.redirect('/?anaf=ok');
  }));
  app.post('/api/anaf/send/:id', wrap(async (req, res) => {
    const d = db.get();
    const e = d.entries.find((x) => x.id === req.params.id);
    if (!e || !entryAccess(req, e, d)) return res.status(404).json({ error: 'Inregistrare inexistenta' });
    if (!xml.isSendable(e)) return res.status(400).json({ error: 'Doar facturile emise pot fi trimise in SPV.' });
    const fid = e.firmaId || db.firmaActiva();
    const c = anafCfgW(fid); // conexiunea SPV a firmei careia ii apartine factura
    const company = db.getFirma(fid) || {};
    const cif = (c.cif || company.cui || '').replace(/^ro/i, '');
    const ubl = xml.eFacturaXml(company, e, d.partners[fid] || {});
    const r = await anaf.upload(c, ubl, cif);
    e.spv = { index: r.index, stare: 'in prelucrare', sentAt: new Date().toISOString() };
    db.save();
    res.json({ ok: true, spv: e.spv });
  }));
  app.post('/api/anaf/status/:id', wrap(async (req, res) => {
    const d = db.get();
    const e = d.entries.find((x) => x.id === req.params.id);
    if (!e || !entryAccess(req, e, d)) return res.status(404).json({ error: 'Inregistrare inexistenta' });
    if (!e.spv) return res.status(400).json({ error: 'Factura nu a fost trimisa in SPV.' });
    const c = entryCfg(e, d);
    const st = await anaf.status(c, e.spv.index);
    e.spv.stare = st.stare; e.spv.idDescarcare = st.idDescarcare || e.spv.idDescarcare;
    if (st.stare === 'ok') e.spv.acceptat = true;
    db.save();
    res.json({ ok: true, spv: e.spv });
  }));

  // Descarca recipisa/ZIP pentru o factura trimisa si o salveaza ca document
  app.post('/api/anaf/download/:id', wrap(async (req, res) => {
    const d = db.get();
    const e = d.entries.find((x) => x.id === req.params.id);
    if (!e || !entryAccess(req, e, d)) return res.status(404).json({ error: 'Inregistrare inexistenta' });
    if (!e.spv || !e.spv.idDescarcare) return res.status(400).json({ error: 'Recipisa indisponibila (verifica statusul intai).' });
    const docId = await saveRecipisa(d, e);
    db.save();
    res.json({ ok: true, documentId: docId, spv: e.spv });
  }));

  app.post('/api/anaf/poll', wrap(async (req, res) => {
    const r = await pollSpv();
    // butonul e apasat in contextul firmei active: fara facturi de verificat,
    // "connected" reflecta conexiunea ei (nu ramane fals doar pentru ca n-a rulat nimic)
    r.connected = r.connected || anaf.connected(anafCfg(activeId(req)));
    res.json(r);
  }));

  // Lista facturilor primite in SPV
  app.get('/api/anaf/inbox', wrap(async (req, res) => {
    const d = db.get();
    const fid = activeId(req);
    const c = anafCfgW(fid);
    const cif = (c.cif || (db.getFirma(fid) || {}).cui || '').replace(/^ro/i, '');
    const msgs = await anaf.listMessages(c, cif, req.query.zile || 60, 'P');
    db.save();
    res.json(msgs.map((m) => ({
      id: m.id, data: m.data_creare || m.data, tip: m.tip, cif: m.cif_emitent || m.cif, detalii: m.detalii,
      importat: d.entries.some((e) => e.spvImport && e.spvImport.msgId === m.id),
    })));
  }));

  // ───────── Fisa Rol / documente SPV (servicii web SPVWS2, github.com/MfpAnaf/ClientSPV) ─────────
  // Solicita fisa pe platitor pentru firma activa; ANAF o proceseaza asincron, iar PDF-ul apare
  // in mesajele SPV, de unde se descarca si se ataseaza ca document al firmei.
  app.post('/api/anaf/fisa-rol', wrap(async (req, res) => {
    const fid = activeId(req);
    const c = anafCfgW(fid);
    if (!anaf.connected(c)) return res.status(400).json({ error: 'Neconectat la SPV. Conectează-te din Setări → Trimitere în SPV.' });
    const cui = ((db.getFirma(fid) || {}).cui || c.cif || '').replace(/^ro/i, '');
    if (!cui) return res.status(400).json({ error: 'Firma activă nu are CUI completat.' });
    const r = await anaf.spvRequest(c, 'Fisa Rol', { cui });
    logAudit('anaf.fisarol', 'solicitare Fisa Rol CUI ' + cui + (r.id_solicitare ? ' (#' + r.id_solicitare + ')' : ''), { req });
    db.save();
    res.json({ ok: true, id: r.id_solicitare || null, titlu: r.titlu || '', mesaj: 'Solicitare depusă. Documentul apare în mesajele SPV după procesare (de regulă în câteva minute).' });
  }));
  app.get('/api/anaf/spv-mesaje', wrap(async (req, res) => {
    const c = anafCfgW(activeId(req));
    if (!anaf.connected(c)) return res.status(400).json({ error: 'Neconectat la SPV.' });
    const msgs = await anaf.spvMessages(c, Math.min(Number(req.query.zile) || 30, 500));
    db.save();
    res.json(msgs.map((m) => ({ id: m.id, data: m.data_creare || m.data, tip: m.tip, detalii: m.detalii, cui: m.cui })));
  }));
  app.post('/api/anaf/spv-descarca/:id', wrap(async (req, res) => {
    const d = db.get();
    const c = anafCfgW(activeId(req));
    if (!anaf.connected(c)) return res.status(400).json({ error: 'Neconectat la SPV.' });
    const buf = await anaf.spvDownload(c, req.params.id);
    const storedName = crypto.randomBytes(8).toString('hex') + '.pdf';
    fs.writeFileSync(path.join(db.UPLOAD_DIR, storedName), buf);
    const docId = db.nextId('doc');
    const nume = String((req.body || {}).detalii || 'Document SPV').slice(0, 120);
    d.documents.push({
      id: docId, firmaId: activeId(req), fileName: nume.replace(/[^\w .-]+/g, ' ').trim() + '.pdf', storedName,
      uploadedAt: new Date().toISOString(), text: '', spvMsgId: req.params.id,
    });
    logAudit('anaf.spvdoc', 'descarcat din SPV: ' + nume, { req });
    db.save();
    res.json({ ok: true, documentId: docId });
  }));

  // Importa o factura primita: descarca, extrage UBL, pre-completeaza formularul
  app.post('/api/anaf/import/:msgId', wrap(async (req, res) => {
    const d = db.get();
    const buf = await anaf.download(anafCfgW(activeId(req)), req.params.msgId);
    const storedName = crypto.randomBytes(8).toString('hex') + '.zip';
    fs.writeFileSync(path.join(db.UPLOAD_DIR, storedName), buf);
    const docId = db.nextId('doc');
    let parsed;
    try { parsed = xml.parseUblInvoice(extractInvoiceXml(buf)); } catch (e) { parsed = { suggestedType: 'factura_cumparare_marfuri', fields: {}, cuis: [] }; }
    d.documents.push({ id: docId, firmaId: activeId(req), fileName: 'spv-' + req.params.msgId + '.zip', storedName, uploadedAt: new Date().toISOString(), text: '', spvMsgId: req.params.msgId });
    db.save();
    res.json(Object.assign({ documentId: docId, fileName: 'SPV ' + req.params.msgId, source: 'spv', msgId: req.params.msgId }, parsed));
  }));
};
