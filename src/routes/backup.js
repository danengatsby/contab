'use strict';

const secretbox = require('../secretbox');

// Administrare (admin): backup (creare/listare/descarcare + comutator auto), restaurare dintr-un
// fisier db.json (cu backup de siguranta al starii curente inainte de inlocuire) si configurarea
// SMTP (trimiterea de emailuri). Modul de rute: register(app, ctx) -> { doBackup }; helperul
// doBackup e folosit si de jobul zilnic de backup din server.js.

const fs = require('fs');
const db = require('../db');
const backupLib = require('../backup');

module.exports = function register(app, ctx) {
  const { requireAdmin, upload, logAudit } = ctx;

  function doBackup() {
    const d = db.get();
    db.flushMirror(true); // adu db.json la zi inainte de copiere (chiar si cu oglinda dezactivata)
    const r = backupLib.backupNow(db.DB_FILE, db.DATA_DIR, 30);
    d.settings.backup = d.settings.backup || {};
    d.settings.backup.lastAt = new Date().toISOString();
    db.save();
    return r;
  }

  app.post('/api/backup', requireAdmin, (req, res) => {
    const r = doBackup();
    logAudit('backup.create', r.name, { req, firmaId: null });
    res.json({ ok: true, file: r.name, count: r.count });
  });
  app.get('/api/backups', requireAdmin, (req, res) => {
    const s = db.get().settings.backup || {};
    res.json({ auto: s.auto !== false, lastAt: s.lastAt || null, list: backupLib.listBackups(db.DATA_DIR) });
  });
  app.post('/api/backups/auto', requireAdmin, (req, res) => {
    const d = db.get();
    d.settings.backup = d.settings.backup || {};
    d.settings.backup.auto = !!(req.body || {}).auto;
    db.save();
    res.json({ ok: true, auto: d.settings.backup.auto });
  });
  app.get('/api/backup/file/:name', requireAdmin, (req, res) => {
    const p = backupLib.backupPath(db.DATA_DIR, req.params.name);
    if (!p) return res.status(404).send('Backup inexistent');
    res.download(p);
  });
  // Restaurare: incarca un fisier db.json -> face backup curentului -> inlocuieste -> reincarca
  app.post('/api/restore', requireAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Niciun fisier primit.' });
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(req.file.path, 'utf8')); } catch (e) { return res.status(400).json({ error: 'Fisier JSON invalid.' }); }
    if (!Array.isArray(parsed.firme) || !parsed.firme.length || !Array.isArray(parsed.users)) {
      return res.status(400).json({ error: 'Nu pare o baza de date Contabo valida (lipsesc firme/users).' });
    }
    logAudit('backup.restore', req.file.originalname, { req, firmaId: null });
    doBackup(); // siguranta: salveaza starea curenta inainte de inlocuire
    db.restoreFromJson(req.file.path); // seteaza in memorie + persista (driver + oglinda JSON)
    res.json({ ok: true, message: 'Baza de date a fost restaurata. Va trebui sa te autentifici din nou.' });
  });

  // Drill de restaurare NATIVA PostgreSQL, la cerere (admin): restaureaza `contab.sql` din ultima
  // arhiva intr-o baza TEMPORARA si verifica rezultatul. Ruleaza si periodic din scripts/backup.js;
  // butonul manual exista ca sa poti verifica IMEDIAT dupa o schimbare de infrastructura (versiune
  // PostgreSQL, migrare de server) fara sa astepti urmatoarea rulare programata.
  app.post('/api/pg-restore-drill', requireAdmin, async (req, res) => {
    const list = backupLib.listFullArchives(db.DATA_DIR);
    if (!list.length) return res.status(400).json({ error: 'Nicio arhiva completa (full-*.zip) de verificat.' });
    const r = await require('../pgRestoreDrill').runPgDrill({ zipPath: list[0].path });
    logAudit('backup.pg-drill', (r.sarit ? 'SARIT: ' : r.neverificabil ? 'NEVERIFICABIL: ' : r.ok ? 'OK: ' : 'ESUAT: ') + (r.motiv || (r.firme + ' firme, ' + r.totalEntries + ' articole')), { req, firmaId: null });
    res.json(Object.assign({ arhiva: list[0].name }, r));
  });

  // ── SMTP (admin) ──
  app.get('/api/smtp', requireAdmin, (req, res) => {
    const s = db.get().settings.smtp || {};
    res.json({ host: s.host || '', port: s.port || 587, secure: !!s.secure, user: s.user || '', from: s.from || '', configured: !!s.host, notifyNewMessage: s.notifyNewMessage !== false });
  });
  app.post('/api/smtp', requireAdmin, (req, res) => {
    const d = db.get();
    const s = d.settings.smtp || {};
    const b = req.body || {};
    ['host', 'user', 'from'].forEach((k) => { if (b[k] != null) s[k] = b[k]; });
    if (b.port != null) s.port = Number(b.port) || 587;
    if (b.secure != null) s.secure = !!b.secure;
    if (b.pass) s.pass = secretbox.seal(b.pass);
    if (b.notifyNewMessage != null) s.notifyNewMessage = !!b.notifyNewMessage;
    d.settings.smtp = s;
    db.save();
    res.json({ ok: true, configured: !!s.host });
  });

  return { doBackup };
};
