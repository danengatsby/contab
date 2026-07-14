'use strict';

// Utilitare de administrare a datelor demonstrative (admin): resetarea contului demo public din
// snapshot (data/demo-firma.json), regenerarea snapshot-ului din starea curenta si incarcarea
// exemplului din ghid. Modul de rute: register(app, ctx) -> { resetDemo } (helperul e folosit si
// de jobul zilnic de reset din server.js).

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { seed } = require('../seed');

const DEMO_SNAPSHOT = path.join(db.DATA_DIR, 'demo-firma.json');

// Reseteaza firma demo din snapshot + igiena pe utilizatorul demo (contor AI, date personale, mesaje).
function resetDemo() {
  const d = db.get();
  const demo = d.users.find((u) => u.username === 'demo');
  const fid = demo && (demo.firme || [])[0];
  if (!fid || !fs.existsSync(DEMO_SNAPSHOT)) return { ok: false, reason: 'fara demo sau snapshot' };
  const bundle = JSON.parse(fs.readFileSync(DEMO_SNAPSHOT, 'utf8'));
  const keepActive = d.firmaActiva; // importFirma muta firma activa — o pastram
  db.importFirma(bundle, { targetFid: fid });
  d.firmaActiva = keepActive;
  // igiena pe utilizatorul demo: contorul AI, datele personale, conversatiile de suport
  delete demo.aiUsage; delete demo.profil; demo.email = '';
  d.messages = (d.messages || []).filter((m) => m.userId !== demo.id);
  db.save();
  return { ok: true, firmaId: fid };
}

module.exports = function register(app, ctx) {
  const { requireAdmin, logAudit } = ctx;

  app.post('/api/demo/reset', requireAdmin, (req, res) => {
    const r = resetDemo();
    logAudit('demo.reset', r.ok ? 'resetat manual' : r.reason, { req, firmaId: null });
    res.json(r);
  });
  // Regenereaza snapshot-ul din starea CURENTA a firmei demo (dupa o curatare manuala).
  app.post('/api/demo/snapshot', requireAdmin, (req, res) => {
    const demo = db.get().users.find((u) => u.username === 'demo');
    const fid = demo && (demo.firme || [])[0];
    if (!fid) return res.status(400).json({ error: 'Nu exista firma demo.' });
    fs.writeFileSync(DEMO_SNAPSHOT, JSON.stringify(db.exportFirma(fid)));
    logAudit('demo.snapshot', 'snapshot demo regenerat', { req, firmaId: null });
    res.json({ ok: true });
  });

  app.post('/api/seed', requireAdmin, (req, res) => {
    const r = seed();
    res.json({ ok: true, message: 'Exemplu incarcat: ' + r.entries + ' inregistrari pentru ' + r.period + '.' });
  });

  return { resetDemo };
};
