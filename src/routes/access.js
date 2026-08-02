'use strict';

// Panoul „Cine acceseaza aplicatia" (doar admin): sesiuni active + istoricul autentificarilor,
// cu IP, dispozitiv, data/ora si localizarea aproximativa a IP-ului.
// Strat SUBTIRE peste src/accessService.js — parseaza cererea, apeleaza serviciul, atat.

const db = require('./../db');
const svc = require('../accessService');

module.exports = function register(app, ctx) {
  const { requireAdmin } = ctx;

  // ASINCRONA: localizarea IP-urilor necunoscute cere o cerere externa (cu cache si timeout).
  // `wrap` din server.js prinde orice respingere si o transforma in 500 + log, deci o cadere a
  // furnizorului nu poate lasa cererea atarnata — dar `raport()` oricum nu arunca pe geo.
  app.get('/api/access-log', requireAdmin, ctx.wrap(async (req, res) => {
    const r = await svc.raport(db.get(), {
      doarEsuate: String(req.query.esuate || '') === '1',
    });
    res.json(r);
  }));
};
