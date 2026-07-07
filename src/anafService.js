'use strict';

// Logica ANAF/SPV independenta de request-ul HTTP: descarcarea recipiselor, verificarea
// periodica a facturilor trimise (poll) si extragerea XML-ului dintr-un ZIP. Rutele
// (server.js) sunt subtiri deasupra acestor functii; jobul de auto-poll le apeleaza direct.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const db = require('./db');
const anaf = require('./anaf');

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
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  let pick = entries.find((en) => /\.xml$/i.test(en.entryName) && !/semnatura/i.test(en.entryName));
  if (!pick) pick = entries.find((en) => /\.xml$/i.test(en.entryName));
  if (!pick) throw new Error('Arhiva nu contine XML.');
  return pick.getData().toString('utf8');
}

module.exports = { saveRecipisa, pollSpv, extractInvoiceXml };
