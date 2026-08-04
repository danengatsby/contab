'use strict';

// Panoul „Cine acceseaza aplicatia" (doar admin): sesiuni active + istoricul autentificarilor,
// cu IP, dispozitiv, data/ora si localizarea aproximativa a IP-ului.
// Strat SUBTIRE peste src/accessService.js — parseaza cererea, apeleaza serviciul, atat.

const db = require('./../db');
const svc = require('../accessService');

module.exports = function register(app, ctx) {
  const { requireAdmin } = ctx;

  // SINCRONA: raportul foloseste doar localizarile deja cunoscute si pune restul la interogat in
  // fundal (vezi geoip.prefetch). Inainte astepta furnizorul extern, iar dupa fiecare repornire —
  // cand cache-ul geo porneste gol — panoul se deschidea in ~8 secunde.
  app.get('/api/access-log', requireAdmin, ctx.wrap((req, res) => {
    const r = svc.raport(db.get(), {
      doarEsuate: String(req.query.esuate || '') === '1',
    });
    res.json(r);
  }));
};
