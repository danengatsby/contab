'use strict';

// Service layer RO e-Transport, independent de request-ul HTTP: generarea XML-ului, depunerea
// la ANAF (obtinerea codului UIT) si verificarea starii. Rutele (src/routes/etransport.js) sunt
// puncte de intrare subtiri. Modelul de domeniu (asamblare + XML + validare) e pur, in
// src/etransport.js; apelurile de retea in src/anaf.js (uploadEtransport/etransportStatus).
//
// Autorizare DUBLATA ca la src/anafService.js: reqEntry verifica apartenenta articolului la o
// firma a utilizatorului (404 identic pentru inexistent si strain), reqFirma valideaza firma.

const db = require('./db');
const anaf = require('./anaf');
const et = require('./etransport');
const { allowedFirme } = require('./session');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Gaseste articolul SI verifica izolarea multi-firma. */
function reqEntry(user, d, id) {
  const e = d.entries.find((x) => x.id === id);
  const fid = e && (e.firmaId == null ? d.firmaActiva : e.firmaId);
  if (!e || !user || !allowedFirme(user).includes(Number(fid))) fail(404, 'Inregistrare inexistenta');
  return e;
}

function reqFirma(fid) {
  const id = Number(fid);
  if (!Number.isInteger(id) || id <= 0 || !db.getFirma(id)) fail(403, 'Firma activa invalida sau inexistenta.');
  return id;
}

/** Conexiunea SPV a firmei careia ii apartine articolul (OAuth partajat cu e-Factura). */
function entryAnafCfg(d, e) {
  const fid = e.firmaId == null ? d.firmaActiva : e.firmaId;
  const f = db.getFirma(fid);
  if (!f) return {};
  return (f.anaf = f.anaf || {});
}

function firmaOf(e, d) {
  const fid = e.firmaId == null ? d.firmaActiva : e.firmaId;
  return db.getFirma(fid) || {};
}

/** Genereaza XML-ul e-Transport pentru un articol (fara depunere). Intoarce { xml, validation }. */
function generateXml(user, entryId, td) {
  const d = db.get();
  const e = reqEntry(user, d, entryId);
  if (!et.isEtransportEligible(e)) fail(400, 'Articolul nu este o miscare de bunuri eligibila pentru e-Transport (aviz, livrare/achizitie intracomunitara, import, vanzare de marfuri/produse).');
  const company = firmaOf(e, d);
  const decl = et.buildDeclaration(company, e, td || {});
  const validation = et.validate(decl);
  const xmlStr = et.eTransportXml(company, e, td || {});
  return { xml: xmlStr, validation, refDeclarant: decl.refDeclarant };
}

/** Doar validarea (pre-depunere, pentru UI) — nu genereaza fisier. */
function validateFor(user, entryId, td) {
  const d = db.get();
  const e = reqEntry(user, d, entryId);
  if (!et.isEtransportEligible(e)) fail(400, 'Articol neeligibil pentru e-Transport.');
  return et.validate(et.buildDeclaration(firmaOf(e, d), e, td || {}));
}

/** Depune declaratia si stocheaza UIT-ul pe articol. Refuza depunerea daca validarea da erori. */
async function sendToEtransport(user, entryId, td) {
  const d = db.get();
  const e = reqEntry(user, d, entryId);
  if (!et.isEtransportEligible(e)) fail(400, 'Articol neeligibil pentru e-Transport.');
  const c = entryAnafCfg(d, e);
  if (!anaf.connected(c)) fail(400, 'Neconectat la SPV. Conectează-te din Setări → Trimitere în SPV (aceeași conexiune ca e-Factura).');
  const company = firmaOf(e, d);
  const decl = et.buildDeclaration(company, e, td || {});
  const v = et.validate(decl);
  if (!v.ok) fail(400, 'Declaratie incompleta: ' + v.errors.join(' '));
  const xmlStr = et.eTransportXml(company, e, td || {});
  const cif = (c.cif || company.cui || '').replace(/^ro/i, '');
  const r = await anaf.uploadEtransport(c, xmlStr, cif);
  e.etransport = {
    uit: r.uit || '', index: r.index || '', stare: r.uit ? 'ok' : 'in prelucrare',
    sentAt: new Date().toISOString(), refDeclarant: decl.refDeclarant,
    nrVehicul: decl.transport.nrVehicul, transport: td || {},
  };
  db.save();
  return { etransport: e.etransport };
}

/** Reimprospateaza starea (si eventual UIT-ul) unei declaratii depuse. */
async function checkStatus(user, entryId) {
  const d = db.get();
  const e = reqEntry(user, d, entryId);
  if (!e.etransport || !e.etransport.index) fail(400, 'Nicio declaratie e-Transport depusa pentru acest articol.');
  const c = entryAnafCfg(d, e);
  const st = await anaf.etransportStatus(c, e.etransport.index);
  e.etransport.stare = st.stare;
  if (st.uit) e.etransport.uit = st.uit;
  db.save();
  return { etransport: e.etransport };
}

/** Articolele eligibile pentru e-Transport din firma, cu starea UIT (pentru UI). */
function eligibleList(fid) {
  fid = reqFirma(fid);
  const v = db.scoped(fid);
  return (v.entries || [])
    .filter((e) => et.isEtransportEligible(e) && (!e.status || e.status === 'postat'))
    .map((e) => ({
      id: e.id, tip: e.tip, tipNume: e.tipNume, data: e.data, document: e.document || '',
      partener: e.partener || '', valoare: et.valoareFaraTva(e),
      uit: (e.etransport && e.etransport.uit) || '', stare: (e.etransport && e.etransport.stare) || '',
    }));
}

module.exports = { generateXml, validateFor, sendToEtransport, checkStatus, eligibleList };
