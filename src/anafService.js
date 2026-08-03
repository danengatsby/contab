'use strict';

const secretbox = require('./secretbox');

// Service layer ANAF/SPV, independent de request-ul HTTP: configurarea conexiunii per-firma,
// OAuth, trimiterea/verificarea/recipisa facturilor, inbox-ul si documentele SPV (Fisa Rol),
// importul e-Factura. Rutele (src/routes/anaf.js) sunt puncte de intrare subtiri; jobul de
// auto-poll apeleaza pollSpv direct.
//
// Autorizare DUBLATA la nivel de serviciu: operatiunile pe inregistrari verifica AICI ca firma
// inregistrarii e printre firmele utilizatorului (reqEntry), cele pe firma valideaza firma
// (reqFirma), iar contul demo e blocat la configurare — nu doar in middleware-ul rutei.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zipGuard = require('./zipGuard');
const db = require('./db');
const anaf = require('./anaf');
const xml = require('./xml');
const coa = require('./chartOfAccounts');
const efacturaImport = require('./efacturaImport');
const bnr = require('./bnr');
const eirec = require('./einvoiceReconcile');
const { round2, period: periodOf } = require('./util');
const { allowedFirme } = require('./session');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Garda de firma: explicita si existenta (fara fallback pe firmaActiva). */
function reqFirma(fid) {
  const id = Number(fid);
  if (!Number.isInteger(id) || id <= 0 || !db.getFirma(id)) fail(403, 'Firma activa invalida sau inexistenta.');
  return id;
}

/** Contul demo (public, partajat) nu modifica setarile de cont / conexiunea SPV. */
function reqNotDemoCont(user) {
  if (user && user.username === 'demo') fail(403, 'Contul demo este public și partajat — setările contului nu se pot modifica. Înscrie-ți un cont propriu.');
}

/** Gaseste inregistrarea SI verifica apartenenta firmei ei la utilizator (izolare multi-firma).
 *  404 identic pentru „nu exista" si „nu e a ta" — nu confirmam existenta id-urilor straine. */
function reqEntry(user, d, id) {
  const e = d.entries.find((x) => x.id === id);
  const fid = e && (e.firmaId == null ? d.firmaActiva : e.firmaId);
  if (!e || !user || !allowedFirme(user).includes(Number(fid))) fail(404, 'Inregistrare inexistenta');
  return e;
}

// Conexiunea SPV e PER-FIRMA (firma.anaf). Config-ul e o referinta vie in obiectul firmei —
// reimprospatarea token-ului in timpul unui apel se persista cu simplul db.save().
const anafCfg = (fid) => (db.getFirma(fid) || {}).anaf || {};
const anafCfgW = (fid) => { const f = db.getFirma(fid); if (!f) return {}; return (f.anaf = f.anaf || {}); };

/** Conexiunea SPV a firmei careia ii apartine inregistrarea (SPV per-firma). */
function entryAnafCfg(d, e) {
  const fid = e.firmaId == null ? d.firmaActiva : e.firmaId;
  const f = db.getFirma(fid);
  if (!f) return {};
  return (f.anaf = f.anaf || {});
}

/** Descarca recipisa/ZIP pentru o factura trimisa si o ataseaza ca document. Muteaza `e.spv` si `d`. */
async function saveRecipisa(d, e) {
  const buf = await anaf.download(entryAnafCfg(d, e), e.spv.idDescarcare);
  const storedName = crypto.randomBytes(8).toString('hex') + '.zip';
  fs.writeFileSync(path.join(db.UPLOAD_DIR, storedName), buf);
  const docId = db.nextId('doc');
  d.documents.push({ id: docId, firmaId: e.firmaId == null ? d.firmaActiva : e.firmaId, fileName: 'recipisa-' + (e.document || e.id) + '.zip', storedName, uploadedAt: new Date().toISOString(), text: '' });
  e.spv.recipisaDocId = docId; e.spv.recipisaAt = new Date().toISOString();
  return docId;
}

/** Verifica facturile trimise (pe conexiunea SPV a fiecarei firme): actualizeaza starea
 *  si descarca recipisele. opts.auto: doar firmele cu autoPoll bifat (jobul periodic). */
async function pollSpv(opts) {
  const auto = !!(opts && opts.auto);
  const d = db.get();
  const pending = d.entries.filter((e) => e.spv && !e.spv.recipisaDocId);
  let connected = false; let checked = 0; let accepted = 0; let downloaded = 0;
  for (const e of pending) {
    const c = entryAnafCfg(d, e);
    if (!anaf.connected(c) || (auto && !c.autoPoll)) continue;
    connected = true; checked++;
    try {
      const st = await anaf.status(c, e.spv.index);
      e.spv.stare = st.stare;
      if (st.idDescarcare) e.spv.idDescarcare = st.idDescarcare;
      if (st.stare === 'ok') { e.spv.acceptat = true; accepted++; }
      if (st.stare === 'ok' && e.spv.idDescarcare) { await saveRecipisa(d, e); downloaded++; }
    } catch (err) { e.spv.error = String(err.message || err); }
  }
  if (checked) db.save();
  return { connected, checked, accepted, downloaded };
}

/** Extrage XML-ul facturii dintr-un ZIP SPV (sare peste fisierul de semnatura). */
function extractInvoiceXml(buf) {
  // ZIP venit din SPV — tot input extern: trece prin garda anti zip-bomb
  const { entries } = zipGuard.openGuarded(buf, { maxEntries: 100, maxTotalSize: 256 * 1024 * 1024 });
  let pick = entries.find((en) => /\.xml$/i.test(en.entryName) && !/semnatura/i.test(en.entryName));
  if (!pick) pick = entries.find((en) => /\.xml$/i.test(en.entryName));
  if (!pick) throw new Error('Arhiva nu contine XML.');
  return pick.getData().toString('utf8');
}

// ───────── Configurare conexiune SPV (per-firma) ─────────

function configSummary(fid) {
  fid = Number(fid); // citire: fara garda (un cont fara firme vede defaulturile, ca inainte)
  const c = anafCfg(fid);
  return {
    env: c.env || 'test', cif: c.cif || '', redirectUri: c.redirectUri || '',
    clientIdSet: !!c.clientId, configured: anaf.configured(c), connected: anaf.connected(c),
    autoPoll: !!c.autoPoll, tokenExpiry: c.tokenExpiry || 0,
    firma: (db.getFirma(fid) || {}).nume || '',
  };
}

function setConfig(user, fid, b) {
  reqNotDemoCont(user);
  fid = reqFirma(fid);
  const c = anafCfgW(fid);
  b = b || {};
  ['env', 'clientId', 'clientSecret', 'redirectUri', 'cif'].forEach((k) => { if (b[k] != null) c[k] = k === 'clientSecret' ? secretbox.seal(b[k]) : b[k]; });
  if (b.autoPoll != null) c.autoPoll = !!b.autoPoll;
  db.save();
  return { configured: anaf.configured(c) };
}

function authorizeUrl(fid) {
  fid = Number(fid); // neconfigurat -> 400 (ca inainte), nu 403
  const c = anafCfg(fid);
  if (!anaf.configured(c)) fail(400, 'Completeaza intai client_id, client_secret si redirect_uri.');
  // state = firmaId: la intoarcerea din ANAF, callback-ul stie pe ce firma leaga token-ul
  return { url: anaf.authorizeUrl(c, fid) };
}

/** Schimba codul OAuth pe token-uri pe firma din `state` — DOAR daca utilizatorul are acces la ea. */
async function oauthCallback(user, fid, code) {
  if (!user || !allowedFirme(user).includes(Number(fid))) fail(403, 'Fara acces la aceasta firma.');
  const c = anafCfgW(reqFirma(fid));
  await anaf.exchangeCode(c, code);
  db.save();
}

// ───────── Facturi trimise: upload / stare / recipisa ─────────

async function sendToSpv(user, entryId) {
  const d = db.get();
  const e = reqEntry(user, d, entryId);
  if (e.status && e.status !== 'postat') fail(400, 'Factura e ciorna — posteaz-o inainte de a o trimite in SPV.');
  if (!xml.isSendable(e)) fail(400, 'Doar facturile emise pot fi trimise in SPV.');
  const fid = e.firmaId || db.firmaActiva();
  const c = anafCfgW(fid); // conexiunea SPV a firmei careia ii apartine factura
  const company = db.getFirma(fid) || {};
  const cif = (c.cif || company.cui || '').replace(/^ro/i, '');
  const ubl = xml.eFacturaXml(company, e, db.get().partners[fid] || {});
  const r = await anaf.upload(c, ubl, cif);
  e.spv = { index: r.index, stare: 'in prelucrare', sentAt: new Date().toISOString() };
  db.save();
  return { spv: e.spv };
}

async function checkStatus(user, entryId) {
  const d = db.get();
  const e = reqEntry(user, d, entryId);
  if (!e.spv) fail(400, 'Factura nu a fost trimisa in SPV.');
  const c = entryAnafCfg(d, e);
  const st = await anaf.status(c, e.spv.index);
  e.spv.stare = st.stare; e.spv.idDescarcare = st.idDescarcare || e.spv.idDescarcare;
  if (st.stare === 'ok') e.spv.acceptat = true;
  db.save();
  return { spv: e.spv };
}

/** Descarca recipisa/ZIP pentru o factura trimisa si o salveaza ca document. */
async function downloadRecipisa(user, entryId) {
  const d = db.get();
  const e = reqEntry(user, d, entryId);
  if (!e.spv || !e.spv.idDescarcare) fail(400, 'Recipisa indisponibila (verifica statusul intai).');
  const docId = await saveRecipisa(d, e);
  db.save();
  return { documentId: docId, spv: e.spv };
}

/** Poll manual din contextul firmei active: fara facturi de verificat, `connected` reflecta
 *  conexiunea firmei (nu ramane fals doar pentru ca n-a rulat nimic). */
async function pollWithContext(fid) {
  const r = await pollSpv();
  r.connected = r.connected || anaf.connected(anafCfg(Number(fid)));
  return r;
}

// ───────── Facturi primite (inbox) + import ─────────

async function inbox(fid, zile) {
  fid = reqFirma(fid);
  const d = db.get();
  const c = anafCfgW(fid);
  const cif = (c.cif || (db.getFirma(fid) || {}).cui || '').replace(/^ro/i, '');
  const msgs = await anaf.listMessages(c, cif, zile || 60, 'P');
  db.save();
  return msgs.map((m) => ({
    id: m.id, data: m.data_creare || m.data, tip: m.tip, cif: m.cif_emitent || m.cif, detalii: m.detalii,
    importat: d.entries.some((e) => e.spvImport && e.spvImport.msgId === m.id),
  }));
}

/** Reconciliaza facturile PRIMITE din SPV (inbox live) cu jurnalul de cumparari: prinde facturile
 *  pe care ANAF le vede in SPV dar nu sunt in contabilitate (TVA deductibila pierduta). */
async function einvoiceReconciliation(fid, zile) {
  fid = reqFirma(fid);
  const box = await inbox(fid, zile || 60); // apel SPV live
  const v = db.scoped(fid);
  const purchases = eirec.journalPurchases(v);
  const nameByCif = {};
  for (const e of v.entries || []) {
    if (!e.partenerCui || !e.partener) continue;
    const k = String(e.partenerCui).replace(/^ro/i, '').replace(/\D/g, '');
    if (k && !nameByCif[k]) nameByCif[k] = e.partener;
  }
  return Object.assign({ zile: zile || 60 }, eirec.reconcileInbox(box, purchases, nameByCif));
}

/** Importa o factura primita: descarca ZIP-ul, il salveaza ca document, extrage UBL-ul. */
async function importFromSpv(fid, msgId) {
  fid = reqFirma(fid);
  const d = db.get();
  const buf = await anaf.download(anafCfgW(fid), msgId);
  const storedName = crypto.randomBytes(8).toString('hex') + '.zip';
  fs.writeFileSync(path.join(db.UPLOAD_DIR, storedName), buf);
  const docId = db.nextId('doc');
  let parsed;
  try { parsed = xml.parseUblInvoice(extractInvoiceXml(buf)); } catch (e) { parsed = { suggestedType: 'factura_cumparare_marfuri', fields: {}, cuis: [] }; }
  d.documents.push({ id: docId, firmaId: fid, fileName: 'spv-' + msgId + '.zip', storedName, uploadedAt: new Date().toISOString(), text: '', spvMsgId: msgId });
  db.save();
  return Object.assign({ documentId: docId, fileName: 'SPV ' + msgId, source: 'spv', msgId }, parsed);
}

/** Import e-Factura (XML UBL lipit/incarcat): valideaza si creeaza inregistrarea de cumparare.
 *  `upsertPartner(fid, entry)` vine din apelant (helper partajat intre modulele de rute). */
function importEfactura(fid, b, upsertPartner) {
  fid = reqFirma(fid); b = b || {};
  const d = db.get();
  let inv;
  try { inv = efacturaImport.parseUBL(b.xml || ''); } catch (e) { fail(400, e.message); }
  if (!inv.furnizor.cui && !inv.furnizor.nume) fail(400, 'Nu am putut identifica furnizorul din e-Factura.');
  // Valuta: baza si TVA-ul se convertesc in lei la cursul BNR al DATEI FACTURII (nu al zilei de
  // azi). Cursul poate veni si explicit (`b.curs`) — feed-ul cazut nu blocheaza importul.
  let cursAplicat = 1;
  if (inv.moneda && inv.moneda !== 'RON') {
    const dataFact = b.data || inv.data || new Date().toISOString().slice(0, 10);
    const manual = Number(b.curs);
    if (Number.isFinite(manual) && manual > 0) cursAplicat = manual;
    else {
      const r = bnr.rateAt(d.cursuriBnr || [], inv.moneda, dataFact);
      if (!r) {
        fail(400, 'e-Factura este in ' + inv.moneda + ', iar cursul BNR pentru ' + dataFact
          + ' nu e disponibil local. Reimprospateaza cursul (Setari) sau trimite cursul explicit.');
      }
      cursAplicat = r.curs;
    }
  }
  const cont = b.cont || '371'; // contul de cheltuiala/stoc (371 marfuri implicit)
  if (!coa.getAccount(cont)) fail(400, 'Cont inexistent in plan: ' + cont);
  const data = b.data || inv.data || new Date().toISOString().slice(0, 10);
  const firma = db.getFirma(fid) || {};
  if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) fail(400, 'Perioada ' + periodOf(data) + ' este inchisa.');
  const sign = inv.tip === 'creditnote' ? -1 : 1;
  const baza = round2(sign * inv.baza * cursAplicat); const tva = round2(sign * inv.tva * cursAplicat);
  const notaCurs = cursAplicat !== 1 ? ' (' + inv.moneda + ' la cursul ' + cursAplicat + ')' : '';
  const lines = [{ debit: cont, credit: '401', suma: baza, explicatie: 'Factura cumpărare (import e-Factura)' + notaCurs }];
  if (Math.abs(tva) >= 0.005) lines.push({ debit: '4426', credit: '401', suma: tva, explicatie: 'TVA deductibilă' });
  const entry = {
    id: db.nextId('e'), firmaId: fid, data, period: periodOf(data),
    tip: inv.tip === 'creditnote' ? 'factura_cumparare_storno' : 'factura_cumparare_marfuri',
    tipNume: (inv.tip === 'creditnote' ? 'Storno factura cumparare' : 'Factura cumparare') + ' (import e-Factura)',
    partener: inv.furnizor.nume, partenerCui: inv.furnizor.cui, document: inv.numar || '',
    explicatie: 'Import e-Factura primită' + notaCurs, fileId: null, system: false, lines,
    // Soldul in valuta ramane vizibil pentru reevaluarea de la sfarsit de perioada: fara
    // `valutaInfo`, articolul ar arata ca unul in lei si contul n-ar mai fi reevaluat.
    ...(cursAplicat !== 1 ? { valutaInfo: { valuta: inv.moneda, sumaValuta: round2(sign * (inv.baza + inv.tva)), curs: cursAplicat } } : {}),
    items: inv.linii.map((l) => ({ nume: l.nume, cantitate: round2(sign * l.cantitate), pret: l.pret, cota: l.cota })),
  };
  d.entries.push(entry);
  if (upsertPartner) upsertPartner(fid, entry);
  db.save();
  return { entry, invoice: inv };
}

// ───────── Fisa Rol / documente SPV (servicii web SPVWS2, github.com/MfpAnaf/ClientSPV) ─────────

/** Solicita fisa pe platitor; ANAF o proceseaza asincron, PDF-ul apare in mesajele SPV. */
async function fisaRol(fid) {
  fid = reqFirma(fid);
  const c = anafCfgW(fid);
  if (!anaf.connected(c)) fail(400, 'Neconectat la SPV. Conectează-te din Setări → Trimitere în SPV.');
  const cui = ((db.getFirma(fid) || {}).cui || c.cif || '').replace(/^ro/i, '');
  if (!cui) fail(400, 'Firma activă nu are CUI completat.');
  const r = await anaf.spvRequest(c, 'Fisa Rol', { cui });
  db.save();
  return { id: r.id_solicitare || null, titlu: r.titlu || '', cui, mesaj: 'Solicitare depusă. Documentul apare în mesajele SPV după procesare (de regulă în câteva minute).' };
}

async function spvMesaje(fid, zile) {
  fid = reqFirma(fid);
  const c = anafCfgW(fid);
  if (!anaf.connected(c)) fail(400, 'Neconectat la SPV.');
  const msgs = await anaf.spvMessages(c, Math.min(Number(zile) || 30, 500));
  db.save();
  return msgs.map((m) => ({ id: m.id, data: m.data_creare || m.data, tip: m.tip, detalii: m.detalii, cui: m.cui }));
}

/** Descarca un document SPV (PDF) si il ataseaza ca document al firmei. */
async function spvDescarca(fid, msgId, detalii) {
  fid = reqFirma(fid);
  const d = db.get();
  const c = anafCfgW(fid);
  if (!anaf.connected(c)) fail(400, 'Neconectat la SPV.');
  const buf = await anaf.spvDownload(c, msgId);
  const storedName = crypto.randomBytes(8).toString('hex') + '.pdf';
  fs.writeFileSync(path.join(db.UPLOAD_DIR, storedName), buf);
  const docId = db.nextId('doc');
  const nume = String(detalii || 'Document SPV').slice(0, 120);
  d.documents.push({
    id: docId, firmaId: fid, fileName: nume.replace(/[^\w .-]+/g, ' ').trim() + '.pdf', storedName,
    uploadedAt: new Date().toISOString(), text: '', spvMsgId: msgId,
  });
  db.save();
  return { documentId: docId, nume };
}

module.exports = {
  saveRecipisa, pollSpv, extractInvoiceXml,
  configSummary, setConfig, authorizeUrl, oauthCallback,
  sendToSpv, checkStatus, downloadRecipisa, pollWithContext,
  inbox, einvoiceReconciliation, importFromSpv, importEfactura,
  fisaRol, spvMesaje, spvDescarca,
};
