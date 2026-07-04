'use strict';

// Rutele registrului depunerilor, portofoliului si notificarilor de termene.
// Modul de rute: `register(app, ctx)` primeste app-ul Express + helperii partajati
// din server.js (context injectat), ca sa nu duplice starea globala.

const decl = require('../declarations');

module.exports = function register(app, ctx) {
  const { db, S, activeId, allowedFirme, logAudit } = ctx;

  app.get('/api/declarations', (req, res) => {
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    res.json({ period, rows: decl.registerForFirma(db.get(), S(req), period) });
  });

  app.post('/api/declarations/set', (req, res) => {
    const b = req.body || {};
    if (!decl.TIPURI[b.tip]) return res.status(400).json({ error: 'Tip de declaratie necunoscut.' });
    if (!/^\d{4}-\d{2}$/.test(String(b.period || ''))) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    if (!decl.STATUSES.includes(b.status)) return res.status(400).json({ error: 'Stare invalida.' });
    const d = db.get();
    decl.record(d, activeId(req), b.tip, b.period, {
      status: b.status, recipisa: b.recipisa, note: b.note, updatedBy: req.user.username,
    }, db.nextId);
    logAudit('declaratie.status', b.tip.toUpperCase() + ' ' + b.period + ' → ' + b.status + (b.recipisa ? ' (recipisa ' + b.recipisa + ')' : ''), { req });
    // Declaratie DEPUSA => perioada se blocheaza automat (luna raportata nu se mai editeaza;
    // corectiile ulterioare se fac prin stornare in luna curenta). Deblocare: Setari -> Blocare perioada.
    let locked = null;
    if (b.status === 'depusa') {
      const firma = db.getFirma(activeId(req));
      if (firma && (!firma.lockedUntil || firma.lockedUntil < b.period)) {
        firma.lockedUntil = b.period;
        locked = b.period;
        logAudit('perioada.lock', 'blocata automat pana la ' + b.period + ' (' + b.tip.toUpperCase() + ' depusa)', { req });
      }
    }
    db.save();
    res.json({ ok: true, locked, rows: decl.registerForFirma(d, S(req), b.period) });
  });

  app.get('/api/portfolio', (req, res) => {
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Perioada invalida (YYYY-MM).' });
    const d = db.get();
    const fids = allowedFirme(req.user);
    const p = decl.portfolio(d, fids.map((id) => db.scoped(id)), period);
    // activitate recenta pe firmele accesibile (din jurnalul de audit)
    const recent = (d.audit || []).filter((a) => a.firmaId != null && fids.includes(a.firmaId)).slice(-12).reverse()
      .map((a) => ({ ts: a.ts, username: a.username, action: a.action, detail: a.detail, firma: (db.getFirma(a.firmaId) || {}).nume || '' }));
    res.json(Object.assign(p, { recent }));
  });

  app.get('/api/notifications', (req, res) => {
    const d = db.get();
    const fids = allowedFirme(req.user);
    res.json(decl.notifications(d, fids.map((id) => db.scoped(id))));
  });
};
