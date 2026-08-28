'use strict';

// Rutele de abonament / plati (Stripe): planuri, checkout (guest si autentificat), portal de
// gestionare, webhook Stripe, proba si selectia de plan, plus activarea manuala (admin).
// Extras din server.js fara schimbare de comportament. Modul de rute: register(app, ctx),
// ctx = { requireAdmin, logAudit }. Nota: middleware-ul express.raw pentru webhook si intrarile
// PUBLIC_PATHS raman in server.js (se aplica dupa cale, independent de locul inregistrarii).

const db = require('../db');
const plans = require('../plans');
const billing = require('../billing');
const commercialFunnel = require('../commercialFunnel');

module.exports = function register(app, ctx) {
  const { requireAdmin, logAudit, activeId } = ctx;

  // Incasarea e oprita cat timp furnizorul nu are identitate juridica publicata (vezi
  // PLATI_SUSPENDATE din src/plans.js). Garda sta pe SERVER, nu doar in interfata: butoanele
  // ascunse nu opresc un POST direct, iar aici se iau bani.
  const platiOprite = (res) => {
    if (!plans.PLATI_SUSPENDATE) return false;
    res.status(503).json({ error: plans.MOTIV_PLATI_SUSPENDATE, platiSuspendate: true });
    return true;
  };

  app.get('/api/plans', (req, res) => res.json({
    plans: plans.PLANS, trialDays: plans.TRIAL_DAYS, platiSuspendate: plans.PLATI_SUSPENDATE,
    motivPlatiSuspendate: plans.MOTIV_PLATI_SUSPENDATE,
  }));
  // Checkout „guest" (plata înainte de înscriere). Fără Stripe configurat → semnalează degradarea.
  app.post('/api/checkout-guest', async (req, res) => {
    const plan = (req.body || {}).plan;
    // Validarea intrarii RAMANE inaintea suspendarii: un plan inexistent e o cerere gresita (400),
    // indiferent daca incasarea e pornita sau oprita.
    if (!plans.PLANS.some((p) => p.id === plan && !p.trial)) return res.status(400).json({ error: 'Plan invalid.' });
    if (platiOprite(res)) return;
    if (!billing.configured()) return res.json({ notConfigured: true });
    try {
      const session = await billing.createGuestCheckoutSession(plan);
      res.json({ url: session.url });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/subscription', (req, res) => {
    const sub = req.user.subscription || {};
    // Accesul e guvernat de abonamentul FIRMEI active (billing strict per-firma), nu de cel al
    // utilizatorului: el expira si blocheaza aplicatia. Grila de planuri trebuie sa arate starea
    // reala a probei — inclusiv cate au ramas — altfel cardul „Probă gratuită" ar parea disponibil
    // dupa ce firma si-a consumat ambele perioade.
    const firmaActiva = db.getFirma(activeId(req));
    res.json({
      plans: plans.PLANS, trialDays: plans.TRIAL_DAYS, current: plans.status(sub),
      firma: firmaActiva ? Object.assign({ firmaId: firmaActiva.id }, plans.firmaStatus(firmaActiva)) : null,
      firmaNume: firmaActiva ? firmaActiva.nume : '',
      stripeEnabled: billing.configured(), manageable: !!sub.stripeCustomerId,
      platiSuspendate: plans.PLATI_SUSPENDATE, motivPlatiSuspendate: plans.MOTIV_PLATI_SUSPENDATE,
    });
  });
  // Plata online: creeaza o sesiune Stripe Checkout si returneaza URL-ul de redirect.
  app.post('/api/subscription/checkout', async (req, res) => {
    if (platiOprite(res)) return;
    if (!billing.configured()) return res.status(400).json({ error: 'Plățile online nu sunt configurate momentan. Contactează-ne pentru activare manuală.' });
    const u = db.get().users.find((x) => x.id === req.user.id);
    if (!u) return res.status(404).json({ error: 'Utilizator inexistent.' });
    try {
      const session = await billing.createCheckoutSession(u, (req.body || {}).plan);
      logAudit('subscription.checkout', 'a initiat plata pentru ' + (req.body || {}).plan, { req });
      res.json({ url: session.url });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Billing Portal: clientul isi gestioneaza/anuleaza abonamentul pe Stripe.
  app.post('/api/subscription/portal', async (req, res) => {
    const u = db.get().users.find((x) => x.id === req.user.id);
    const cid = u && u.subscription && u.subscription.stripeCustomerId;
    if (!cid) return res.status(400).json({ error: 'Nu există un abonament Stripe de gestionat.' });
    try {
      const session = await billing.createPortalSession(cid);
      res.json({ url: session.url });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Webhook Stripe (public, body brut): activeaza/actualizeaza/anuleaza abonamentul dupa plata.
  app.post('/api/stripe/webhook', (req, res) => {
    let event;
    try { event = billing.constructEvent(req.body, req.headers['stripe-signature']); }
    catch (e) { return res.status(400).send('Webhook error: ' + e.message); }
    const info = billing.interpretEvent(event);
    if (info.action === 'ignore') return res.json({ received: true });
    const d = db.get();
    // Livrare dubla (retry Stripe): confirmam fara re-procesare.
    if (billing.seenEvent(d.settings, event.id)) return res.json({ received: true, duplicate: true });
    let u = info.userId ? d.users.find((x) => String(x.id) === String(info.userId)) : null;
    if (!u && info.customerId) u = d.users.find((x) => x.subscription && x.subscription.stripeCustomerId === info.customerId);
    // Plata „guest" (fara cont inca): pastreaza abonamentul in asteptare, legat de email, pana la inscriere.
    if (!u && info.guest && info.email && info.action === 'activate') {
      d.settings.pendingSubs = d.settings.pendingSubs || [];
      d.settings.pendingSubs = d.settings.pendingSubs.filter((x) => x.email !== String(info.email).toLowerCase());
      const paidAt = new Date().toISOString();
      d.settings.pendingSubs.push({ email: String(info.email).toLowerCase(), plan: info.plan, customerId: info.customerId, subscriptionId: info.subscriptionId, at: paidAt, commercialPaymentAt: paidAt });
      commercialFunnel.record(d, 'payment', { at: paidAt });
      billing.rememberEvent(d.settings, event.id);
      db.save();
      return res.json({ received: true, pending: true });
    }
    if (!u) return res.json({ received: true, note: 'utilizator negasit' });
    const sub = Object.assign({}, u.subscription || {});
    const userEraPlatitor = sub.status === 'active' && !!sub.stripeSubscriptionId;
    if (info.customerId) sub.stripeCustomerId = info.customerId;
    if (info.subscriptionId) sub.stripeSubscriptionId = info.subscriptionId;
    if (info.action === 'activate') {
      sub.plan = info.plan || sub.requestedPlan || sub.plan; sub.status = 'active';
      sub.since = sub.since || new Date().toISOString(); sub.requestedPlan = null; sub.requestedAt = null;
    } else if (info.action === 'cancel') {
      sub.status = 'canceled';
    }
    u.subscription = sub;
    // Billing per-firma: activeaza/dezactiveaza abonamentul FIRMEI din metadata (plata confirmata).
    const firma = info.firmaId ? d.firme.find((f) => String(f.id) === String(info.firmaId)) : null;
    if (firma) {
      const fp = firma.subscription || {};
      const firmaEraPlatitoare = fp.status === 'active' && !!fp.stripeSubscriptionId;
      if (info.action === 'activate') {
        const luna = new Date().toISOString().slice(0, 7);
        const plan = info.plan || fp.pendingPlan || fp.plan || 'start';
        firma.subscription = {
          status: 'active', plan, since: fp.since || new Date().toISOString(),
          stripeCustomerId: info.customerId || fp.stripeCustomerId || null, stripeSubscriptionId: info.subscriptionId || fp.stripeSubscriptionId || null,
          abonamente: Object.assign({}, fp.abonamente || {}, { [luna]: plan }),
        };
        commercialFunnel.markEntity(d, firma, 'payment', { count: !firmaEraPlatitoare });
      } else if (info.action === 'cancel') {
        firma.subscription = Object.assign({}, fp, { status: 'canceled' });
      }
    }
    if (!firma && info.action === 'activate') {
      commercialFunnel.markEntity(d, u, 'payment', { count: !userEraPlatitor });
    }
    logAudit('subscription.stripe', event.type + ' -> ' + u.username + ' (' + (sub.plan || '-') + '/' + sub.status + ')' + (firma ? ' [firma ' + firma.id + ']' : ''), { firmaId: firma ? firma.id : null, username: 'stripe-webhook' });
    billing.rememberEvent(d.settings, event.id);
    db.save();
    res.json({ received: true });
  });
  app.post('/api/subscription/trial', (req, res) => {
    const u = db.get().users.find((x) => x.id === req.user.id);
    if (!u) return res.status(404).json({ error: 'Utilizator inexistent.' });
    try { u.subscription = plans.startTrial(u.subscription); } catch (e) { return res.status(400).json({ error: e.message }); }
    logAudit('subscription.trial', 'a pornit perioada de proba', { req });
    db.save();
    res.json({ ok: true, current: plans.status(u.subscription) });
  });
  app.post('/api/subscription/select', (req, res) => {
    const u = db.get().users.find((x) => x.id === req.user.id);
    if (!u) return res.status(404).json({ error: 'Utilizator inexistent.' });
    try { u.subscription = plans.selectPlan(u.subscription, (req.body || {}).plan); } catch (e) { return res.status(400).json({ error: e.message }); }
    logAudit('subscription.select', 'a ales planul ' + (req.body || {}).plan, { req });
    db.save();
    res.json({ ok: true, current: plans.status(u.subscription) });
  });
  // Admin: activeaza planul unui utilizator dupa confirmarea platii.
  app.post('/api/subscription/activate', requireAdmin, (req, res) => {
    const b = req.body || {};
    const u = db.get().users.find((x) => x.id === b.userId);
    if (!u) return res.status(404).json({ error: 'Utilizator inexistent.' });
    const eraActiv = (u.subscription || {}).status === 'active';
    try { u.subscription = plans.activatePlan(u.subscription, b.plan); } catch (e) { return res.status(400).json({ error: e.message }); }
    commercialFunnel.markEntity(db.get(), u, 'payment', { count: !eraActiv });
    logAudit('subscription.activate', u.username + ' -> ' + b.plan, { req });
    db.save();
    res.json({ ok: true, current: plans.status(u.subscription) });
  });
};
