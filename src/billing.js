'use strict';

// Integrare Stripe pentru abonamente: Checkout gazduit (mod subscription) + Billing Portal + webhook-uri.
// Configurare prin variabile de mediu (.env) — daca STRIPE_SECRET_KEY lipseste, integrarea e DEZACTIVATA
// si aplicatia cade gratios inapoi pe activarea manuala (admin). Nu stocheaza chei in cod.
//
//   STRIPE_SECRET_KEY       cheia secreta (sk_test_... in test, sk_live_... in productie)
//   STRIPE_WEBHOOK_SECRET   secretul de semnatura al webhook-ului (whsec_...)
//   STRIPE_PRICE_START      Price ID (price_...) pentru planul Start
//   STRIPE_PRICE_PRO        Price ID pentru planul Pro
//   STRIPE_PRICE_BUSINESS   Price ID pentru planul Business
//   APP_URL                 URL-ul aplicatiei pentru redirect (ex. https://contabo.space)

let _stripe = null;
function client() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const Stripe = require('stripe');
  _stripe = new Stripe(key);
  return _stripe;
}
function configured() { return !!process.env.STRIPE_SECRET_KEY; }

const PRICE_ENV = { start: 'STRIPE_PRICE_START', pro: 'STRIPE_PRICE_PRO' };
function priceId(plan) { return process.env[PRICE_ENV[plan]] || null; }
function planForPrice(pid) {
  if (!pid) return null;
  for (const p of Object.keys(PRICE_ENV)) if (process.env[PRICE_ENV[p]] && process.env[PRICE_ENV[p]] === pid) return p;
  return null;
}
function appUrl() { return String(process.env.APP_URL || 'https://contabo.space').replace(/\/+$/, ''); }

/** Creeaza o sesiune de Checkout (abonament recurent) si returneaza obiectul cu .url de redirect.
 *  `firmaId` (optional): billing per-firma — se propaga in metadata ca webhook-ul sa activeze
 *  abonamentul FIRMEI corecte dupa confirmarea platii. */
async function createCheckoutSession(user, plan, firmaId) {
  const s = client();
  if (!s) throw new Error('Plățile online nu sunt configurate (lipsește STRIPE_SECRET_KEY).');
  const price = priceId(plan);
  if (!price) throw new Error('Planul „' + plan + '" nu are un preț Stripe configurat.');
  const sub = user.subscription || {};
  const meta = { userId: String(user.id), plan };
  if (firmaId != null) meta.firmaId = String(firmaId);
  return s.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    customer: sub.stripeCustomerId || undefined,
    customer_email: sub.stripeCustomerId ? undefined : (user.email || undefined),
    client_reference_id: String(user.id),
    metadata: meta,
    subscription_data: { metadata: meta },
    allow_promotion_codes: true,
    // Facturare legala: Stripe emite factura fiecarei plati; colectam adresa de facturare
    // si CUI-ul (tax ID) ca factura sa fie completa. customer_update e cerut de Stripe
    // cand tax_id_collection e activ pe un customer existent.
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    customer_update: sub.stripeCustomerId ? { name: 'auto', address: 'auto' } : undefined,
    locale: 'ro',
    success_url: appUrl() + '/?checkout=success#abonament',
    cancel_url: appUrl() + '/?checkout=cancel#abonament',
  });
}

/** Checkout „guest" (fara cont existent): plata inainte de inscriere. Emailul se colecteaza pe Stripe. */
async function createGuestCheckoutSession(plan) {
  const s = client();
  if (!s) throw new Error('Plățile online nu sunt configurate (lipsește STRIPE_SECRET_KEY).');
  const price = priceId(plan);
  if (!price) throw new Error('Planul „' + plan + '" nu are un preț Stripe configurat.');
  return s.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    metadata: { plan, guest: '1' },
    subscription_data: { metadata: { plan, guest: '1' } },
    allow_promotion_codes: true,
    // Facturare legala: adresa de facturare + CUI pe factura emisa de Stripe
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    locale: 'ro',
    success_url: appUrl() + '/?checkout=success&register=1',
    cancel_url: appUrl() + '/?checkout=cancel',
  });
}

/** Sesiune de Billing Portal (client isi gestioneaza/anuleaza abonamentul). */
async function createPortalSession(customerId) {
  const s = client();
  if (!s) throw new Error('Plățile online nu sunt configurate.');
  return s.billingPortal.sessions.create({ customer: customerId, return_url: appUrl() + '/#abonament' });
}

/** Verifica semnatura webhook-ului si returneaza evenimentul Stripe. Arunca daca semnatura e invalida. */
function constructEvent(rawBody, signature) {
  const s = client();
  if (!s) throw new Error('Stripe neconfigurat.');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('Lipsește STRIPE_WEBHOOK_SECRET.');
  return s.webhooks.constructEvent(rawBody, signature, secret);
}

// Deduplicare webhook: Stripe retrimite acelasi eveniment (acelasi event.id) la orice raspuns
// non-2xx sau timeout, deci o livrare dubla NU trebuie sa re-proceseze abonamentul (audit dublat,
// re-activare dupa o anulare ulterioara). Id-urile procesate stau in settings.stripeEventIds
// (id -> data procesarii); istoricul se taie la cele mai vechi peste MAX_SEEN_EVENTS — cheile
// obiectului pastreaza ordinea inserarii, care e chiar ordinea cronologica a procesarii.
const MAX_SEEN_EVENTS = 500;

/** True daca evenimentul a fost deja procesat (livrare dubla). Functie pura. */
function seenEvent(settings, eventId) {
  return !!(eventId && settings && settings.stripeEventIds && settings.stripeEventIds[eventId]);
}

/** Marcheaza evenimentul ca procesat si taie istoricul la ultimele MAX_SEEN_EVENTS. */
function rememberEvent(settings, eventId) {
  if (!eventId) return;
  const seen = settings.stripeEventIds = settings.stripeEventIds || {};
  seen[eventId] = new Date().toISOString();
  const ids = Object.keys(seen);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SEEN_EVENTS))) delete seen[old];
}

/** Traduce un eveniment Stripe intr-o actiune de abonament aplicabila pe user. Functie pura. */
function interpretEvent(event) {
  const o = (event && event.data && event.data.object) || {};
  const meta = o.metadata || {};
  switch (event && event.type) {
    case 'checkout.session.completed':
      return {
        action: 'activate', userId: meta.userId || o.client_reference_id || null, plan: meta.plan || null, firmaId: meta.firmaId || null,
        customerId: o.customer || null, subscriptionId: o.subscription || null, status: 'active',
        guest: meta.guest === '1', email: (o.customer_details && o.customer_details.email) || o.customer_email || null,
      };
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const line = o.items && o.items.data && o.items.data[0];
      const plan = meta.plan || planForPrice(line && line.price && line.price.id);
      const active = o.status === 'active' || o.status === 'trialing';
      return { action: active ? 'activate' : 'update', userId: meta.userId || null, plan, firmaId: meta.firmaId || null, customerId: o.customer || null, subscriptionId: o.id || null, status: o.status || null };
    }
    case 'customer.subscription.deleted':
      return { action: 'cancel', userId: meta.userId || null, customerId: o.customer || null, subscriptionId: o.id || null, status: o.status || 'canceled' };
    default:
      return { action: 'ignore', type: event && event.type };
  }
}

module.exports = { configured, client, priceId, planForPrice, appUrl, createCheckoutSession, createGuestCheckoutSession, createPortalSession, constructEvent, interpretEvent, seenEvent, rememberEvent, MAX_SEEN_EVENTS };
