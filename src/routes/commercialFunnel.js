'use strict';

// Indicatori comerciali agregati (admin). Este un endpoint separat de /api/access-log:
// raportul de acces raspunde la o intrebare de securitate si contine IP-uri; funnelul nu le
// citeste si nu le expune.

const db = require('../db');
const funnel = require('../commercialFunnel');

module.exports = function register(app, ctx) {
  app.get('/api/commercial-funnel', ctx.requireAdmin, (req, res) => {
    const raw = String(req.query.days || '30').toLowerCase();
    const days = raw === 'all' ? null : ([30, 90].includes(Number(raw)) ? Number(raw) : 30);
    res.json(funnel.snapshot(db.get(), { days }));
  });
};
