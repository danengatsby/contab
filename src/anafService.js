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

/** Descarca recipisa/ZIP pentru o factura trimisa si o ataseaza ca document. Muteaza `e.spv` si `d`. */
async function saveRecipisa(d, e) {
  const buf = await anaf.download(d.settings.anaf || {}, e.spv.idDescarcare);
  const storedName = crypto.randomBytes(8).toString('hex') + '.zip';
  fs.writeFileSync(path.join(db.UPLOAD_DIR, storedName), buf);
  const docId = db.nextId('doc');
  d.documents.push({ id: docId, fileName: 'recipisa-' + (e.document || e.id) + '.zip', storedName, uploadedAt: new Date().toISOString(), text: '' });
  e.spv.recipisaDocId = docId; e.spv.recipisaAt = new Date().toISOString();
  return docId;
}

/** Verifica toate facturile trimise: actualizeaza starea si descarca recipisele disponibile. */
async function pollSpv() {
  const d = db.get();
  const c = d.settings.anaf || {};
  if (!anaf.connected(c)) return { connected: false, checked: 0, accepted: 0, downloaded: 0 };
  const pending = d.entries.filter((e) => e.spv && !e.spv.recipisaDocId);
  let accepted = 0; let downloaded = 0;
  for (const e of pending) {
    try {
      const st = await anaf.status(c, e.spv.index);
      e.spv.stare = st.stare;
      if (st.idDescarcare) e.spv.idDescarcare = st.idDescarcare;
      if (st.stare === 'ok') { e.spv.acceptat = true; accepted++; }
      if (st.stare === 'ok' && e.spv.idDescarcare) { await saveRecipisa(d, e); downloaded++; }
    } catch (err) { e.spv.error = String(err.message || err); }
  }
  d.settings.anaf = c;
  db.save();
  return { connected: true, checked: pending.length, accepted, downloaded };
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
