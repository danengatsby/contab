'use strict';

// Rutele RO e-Transport (cod UIT) — strat SUBTIRE peste src/etransportService.js: parseaza
// cererea, apeleaza serviciul si traduce erorile lui (`err.status`) in raspunsuri HTTP.
// Autorizarea (apartenenta articolului la o firma a utilizatorului) e impusa in serviciu.
// Modul de rute: register(app, ctx).

const svc = require('../etransportService');
const et = require('../etransport');

module.exports = function register(app, ctx) {
  const { activeId, logAudit, wrap } = ctx;

  const send = (res, e) => res.status(e.status).json({ error: e.message });
  const run = (res, fn) => { try { const out = fn(); if (out !== undefined) res.json(out); } catch (e) { if (!e.status) throw e; send(res, e); } };
  const runA = async (res, p) => { try { res.json(await p); } catch (e) { if (!e.status) throw e; send(res, e); } };

  // Datele de transport din corpul cererii (JSON) sau din query (pentru descarcarea XML prin GET).
  function tdFrom(src) {
    src = src || {};
    const loc = (pfx) => ({
      judet: src[pfx + 'Judet'], localitate: src[pfx + 'Localitate'], strada: src[pfx + 'Strada'],
      numar: src[pfx + 'Numar'], codPostal: src[pfx + 'CodPostal'], codPtf: src[pfx + 'Ptf'],
      codBirouVamal: src[pfx + 'Vama'], alteInfo: src[pfx + 'AlteInfo'],
    });
    const td = {
      codTipOperatiune: src.codTipOperatiune, codScopOperatiune: src.codScopOperatiune,
      nrVehicul: src.nrVehicul, nrRemorca1: src.nrRemorca1, nrRemorca2: src.nrRemorca2,
      dataTransport: src.dataTransport, partenerTara: src.partenerTara,
      codTarifar: src.codTarifar, greutateNeta: src.greutateNeta, greutateBruta: src.greutateBruta,
      denumireMarfa: src.denumireMarfa, refDeclarant: src.refDeclarant,
      start: loc('start'), final: loc('final'),
    };
    if (src.organizatorCui || src.organizatorNume) td.organizator = { cui: src.organizatorCui, nume: src.organizatorNume, tara: src.organizatorTara };
    if (Array.isArray(src.bunuri)) td.bunuri = src.bunuri; // doar din body JSON
    if (src.document || src.docNumar || src.docTip) td.document = src.document || { tip: src.docTip, numar: src.docNumar, data: src.docData, observatii: src.docObs };
    return td;
  }

  // Nomenclatoarele (pentru dropdown-urile din formularul de transport)
  app.get('/api/etransport/nomenclatoare', (req, res) => res.json({
    tipOperatiune: et.TIP_OPERATIUNE, scopOperatiune: et.SCOP_OPERATIUNE,
    tipDocument: et.TIP_DOCUMENT, judete: et.JUDETE,
  }));

  // Articolele eligibile din firma activa, cu starea UIT
  app.get('/api/etransport/eligible', (req, res) => run(res, () => svc.eligibleList(activeId(req))));

  // Validare pre-depunere (fara trimitere) — pentru feedback in formular
  app.post('/api/etransport/validate/:id', (req, res) => run(res, () => svc.validateFor(req.user, req.params.id, tdFrom(req.body))));

  // Descarcarea XML-ului (inspectie / incarcare manuala). Datele de transport vin din query.
  app.get('/xml/etransport/:id', (req, res) => {
    let r;
    try { r = svc.generateXml(req.user, req.params.id, tdFrom(req.query)); }
    catch (e) { if (e.status) return res.status(e.status).send(e.message); throw e; }
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="etransport-' + String(req.params.id).replace(/[^\w-]/g, '') + '.xml"');
    res.send(r.xml);
  });

  // Depunere: obtine UIT-ul si il stocheaza pe articol
  app.post('/api/etransport/send/:id', wrap((req, res) => runA(res, (async () => {
    const r = await svc.sendToEtransport(req.user, req.params.id, tdFrom(req.body));
    logAudit('etransport.send', 'UIT ' + (r.etransport.uit || '(in prelucrare)') + ' vehicul ' + (r.etransport.nrVehicul || ''), { req });
    return { ok: true, etransport: r.etransport };
  })())));

  // Verificarea starii unei declaratii depuse
  app.post('/api/etransport/status/:id', wrap((req, res) => runA(res, (async () => {
    const r = await svc.checkStatus(req.user, req.params.id);
    return { ok: true, etransport: r.etransport };
  })())));
};
