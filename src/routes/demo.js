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

/** Provisioning idempotent al perechii demo: patronul `demo` (deja creat pe productie) + contabilul
 *  `demo-contabil`. Ambele partajeaza firma demo (colaborare patron<->contabil, ambele opereaza).
 *  Ruleaza la boot si la fiecare reset — restaureaza legatura daca un vizitator a scos un cont in demo.
 *  Nu creeaza nimic daca nu exista `demo` (dev/test fara cont demo). */
function ensureDemoContabil() {
  const d = db.get();
  const demo = d.users.find((u) => u.username === 'demo');
  const fid = demo && (demo.firme || [])[0];
  if (!demo || !fid) return null;
  let contabil = d.users.find((u) => u.username === 'demo-contabil');
  if (!contabil) {
    contabil = { id: db.nextUserId(), username: 'demo-contabil', salt: '', hash: '', role: 'user', firme: [], firmaActiva: fid, subscription: { status: 'active', plan: 'pro' } };
    d.users.push(contabil);
  }
  // ambele conturi trebuie sa aiba acces la firma demo (opereaza amandoua)
  demo.firme = demo.firme || []; if (!demo.firme.includes(fid)) demo.firme.push(fid);
  contabil.firme = contabil.firme || []; if (!contabil.firme.includes(fid)) contabil.firme.push(fid);
  if (!contabil.firmaActiva || !contabil.firme.includes(contabil.firmaActiva)) contabil.firmaActiva = fid;
  contabil.subscription = { status: 'active', plan: 'pro' }; // tip „contabil" (Pro)
  return contabil;
}

// Reseteaza firma demo din snapshot + igiena pe utilizatorii demo (contor AI, date personale, mesaje).
function resetDemo() {
  const d = db.get();
  const demo = d.users.find((u) => u.username === 'demo');
  const fid = demo && (demo.firme || [])[0];
  if (!fid || !fs.existsSync(DEMO_SNAPSHOT)) return { ok: false, reason: 'fara demo sau snapshot' };
  const bundle = JSON.parse(fs.readFileSync(DEMO_SNAPSHOT, 'utf8'));
  const keepActive = d.firmaActiva; // importFirma muta firma activa — o pastram
  db.importFirma(bundle, { targetFid: fid });
  d.firmaActiva = keepActive;
  ensureDemoContabil(); // reface perechea demo<->demo-contabil (ambele pe firma demo)
  // igiena pe conturile demo: contorul AI, datele personale, conversatiile de suport
  for (const u of d.users.filter((x) => x.username === 'demo' || x.username === 'demo-contabil')) {
    delete u.aiUsage; delete u.profil; u.email = '';
    d.messages = (d.messages || []).filter((m) => m.userId !== u.id);
  }
  db.save();
  return { ok: true, firmaId: fid };
}

module.exports = function register(app, ctx) {
  const { requireAdmin, logAudit } = ctx;

  // La pornire: asigura contul demo-contabil + legatura cu firma demo (idempotent, no-op fara demo).
  try { if (ensureDemoContabil()) db.save(); } catch (e) { console.error('ensureDemoContabil:', e.message); }

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
