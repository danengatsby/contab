'use strict';

// Rutele ANAF/SPV si import e-Factura — strat SUBTIRE peste src/anafService.js: parseaza
// cererea, apeleaza serviciul si traduce erorile lui (`err.status`) in raspunsuri HTTP.
// Autorizarea (apartenenta inregistrarii/firmei la utilizator, blocajul demo la configurare)
// e impusa in serviciu, nu doar aici. Modul de rute: register(app, ctx).

const efacturaImport = require('../efacturaImport');
const svc = require('../anafService');

module.exports = function register(app, ctx) {
  const { activeId, wrap, logAudit, upsertPartner, demoContLock } = ctx;

  // Erorile de business poarta `status`; restul urca la wrap/handlerul global (500 + log).
  const send = (res, e) => res.status(e.status).json({ error: e.message });
  // fn poate raspunde singur (ex. demoContLock) si intoarce undefined — atunci nu mai trimitem nimic
  const run = (res, fn) => { try { const out = fn(); if (out !== undefined) res.json(out); } catch (e) { if (!e.status) throw e; send(res, e); } };
  const runA = async (res, p) => { try { res.json(await p); } catch (e) { if (!e.status) throw e; send(res, e); } };

  app.post('/api/efactura/parse', (req, res) => {
    try { res.json({ ok: true, invoice: efacturaImport.parseUBL((req.body || {}).xml || '') }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/efactura/import', (req, res) => run(res, () => {
    const r = svc.importEfactura(activeId(req), req.body, upsertPartner);
    logAudit('efactura.import', (r.invoice.numar || '') + ' / ' + (r.invoice.furnizor.nume || r.invoice.furnizor.cui), { req });
    return { ok: true, entry: r.entry, invoice: r.invoice };
  }));

  // ── configurarea conexiunii SPV (per-firma) ──
  app.get('/api/anaf/config', (req, res) => res.json(svc.configSummary(activeId(req))));
  app.post('/api/anaf/config', (req, res) => run(res, () => {
    // contul demo (public, partajat) nu configureaza conexiunea SPV nici pe firma demo
    if (demoContLock(req, res)) return undefined;
    const r = svc.setConfig(req.user, activeId(req), req.body);
    return { ok: true, configured: r.configured };
  }));
  app.get('/api/anaf/authorize', (req, res) => run(res, () => svc.authorizeUrl(activeId(req))));
  app.get('/api/anaf/callback', wrap(async (req, res) => {
    if (req.query.error) return res.redirect('/?anaf=error');
    if (!req.query.code) return res.status(400).send('Lipseste codul de autorizare.');
    // state = firmaId: callback-ul stie pe ce firma leaga token-ul
    const fid = req.query.state ? Number(req.query.state) : activeId(req);
    try { await svc.oauthCallback(req.user, fid, req.query.code); }
    catch (e) { if (e.status === 403) return res.status(403).send(e.message); throw e; }
    res.redirect('/?anaf=ok');
  }));

  // ── facturi trimise: upload / stare / recipisa / poll ──
  app.post('/api/anaf/send/:id', wrap((req, res) => runA(res, (async () => {
    const r = await svc.sendToSpv(req.user, req.params.id);
    return { ok: true, spv: r.spv };
  })())));
  app.post('/api/anaf/status/:id', wrap((req, res) => runA(res, (async () => {
    const r = await svc.checkStatus(req.user, req.params.id);
    return { ok: true, spv: r.spv };
  })())));
  app.post('/api/anaf/download/:id', wrap((req, res) => runA(res, (async () => {
    const r = await svc.downloadRecipisa(req.user, req.params.id);
    return { ok: true, documentId: r.documentId, spv: r.spv };
  })())));
  app.post('/api/anaf/poll', wrap((req, res) => runA(res, svc.pollWithContext(activeId(req)))));

  // ── facturi primite (inbox) + import ──
  app.get('/api/anaf/inbox', wrap((req, res) => runA(res, svc.inbox(activeId(req), req.query.zile))));
  app.post('/api/anaf/import/:msgId', wrap((req, res) => runA(res, svc.importFromSpv(activeId(req), req.params.msgId))));

  // ── Fisa Rol / documente SPV (SPVWS2) ──
  app.post('/api/anaf/fisa-rol', wrap((req, res) => runA(res, (async () => {
    const r = await svc.fisaRol(activeId(req));
    logAudit('anaf.fisarol', 'solicitare Fisa Rol CUI ' + r.cui + (r.id ? ' (#' + r.id + ')' : ''), { req });
    return { ok: true, id: r.id, titlu: r.titlu, mesaj: r.mesaj };
  })())));
  app.get('/api/anaf/spv-mesaje', wrap((req, res) => runA(res, svc.spvMesaje(activeId(req), req.query.zile))));
  app.post('/api/anaf/spv-descarca/:id', wrap((req, res) => runA(res, (async () => {
    const r = await svc.spvDescarca(activeId(req), req.params.id, (req.body || {}).detalii);
    logAudit('anaf.spvdoc', 'descarcat din SPV: ' + r.nume, { req });
    return { ok: true, documentId: r.documentId };
  })())));
};
