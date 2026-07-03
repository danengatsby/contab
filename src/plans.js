'use strict';

// Planuri de abonament pentru aplicatie + logica de trial. Functii pure pe obiectul `subscription`
// stocat pe user: { plan, status, trialStartedAt, trialEndsAt, since, requestedPlan, requestedAt }.

const TRIAL_DAYS = 30;

// Toate planurile includ aceleasi functii (se diferentiaza doar prin pret).
const FEATURES = [
  'Facturi + e-Factura',
  'TVA + declarații de bază',
  'Toate declarațiile + SAF-T',
  'Stocuri + producție',
  'Situații financiare complete (F10–F40)',
  'Suport prioritar',
];

const PLANS = [
  {
    id: 'trial', nume: 'Probă gratuită', pret: 0, moneda: 'lei', perioada: TRIAL_DAYS + ' zile', trial: true,
    tip: 'tester', descriere: 'Tester — testează tot, fără card bancar.',
    features: FEATURES.slice(),
  },
  {
    id: 'start', nume: 'Start', pret: 99, moneda: 'lei', perioada: 'lună',
    tip: 'necontabil', descriere: 'Necontabil — antreprenori care își țin singuri evidența.',
    features: FEATURES.slice(),
  },
  {
    id: 'pro', nume: 'Pro', pret: 199, moneda: 'lei', perioada: 'lună', recomandat: true,
    tip: 'contabil', descriere: 'Contabil — profesioniști și portofolii de firme.',
    features: FEATURES.slice(),
  },
];

/**
 * Proba expirata si fara plan activ -> contul devine read-only (vede datele, nu mai
 * inregistreaza si nu mai genereaza livrabile). NU se aplica adminilor si nici
 * utilizatorilor fara abonament (personal invitat de admin, contul demo) — doar
 * celor care AU folosit proba si nu au trecut pe un plan platit.
 */
function expiredLock(user) {
  if (!user || user.role === 'admin') return false;
  return status(user.subscription).status === 'expired';
}

/**
 * Tipul de utilizator, derivat din rol si abonament:
 *   admin — administratorul aplicatiei;
 *   tester — proba gratuita (sau inca fara plan);
 *   necontabil — abonament Start activ;
 *   contabil — abonament Pro activ.
 * Se actualizeaza automat cand se schimba abonamentul (nu se stocheaza separat).
 */
function userKind(user) {
  if (!user) return 'tester';
  if (user.role === 'admin') return 'admin';
  const st = status(user.subscription);
  if (st.status === 'active' && st.plan === 'start') return 'necontabil';
  if (st.status === 'active' && st.plan === 'pro') return 'contabil';
  return 'tester';
}

function daysLeft(endIso, now) {
  return Math.max(0, Math.ceil((new Date(endIso).getTime() - (now || Date.now())) / 86400000));
}

/** Starea calculata a abonamentului (nu modifica nimic). */
function status(sub, now) {
  now = now || Date.now();
  sub = sub || {};
  const base = { requestedPlan: sub.requestedPlan || null, trialUsed: !!sub.trialStartedAt };
  if (sub.plan && sub.plan !== 'trial' && sub.status === 'active') {
    return Object.assign({ plan: sub.plan, status: 'active', since: sub.since || null, zileRamase: null }, base);
  }
  if (sub.trialEndsAt) {
    const left = daysLeft(sub.trialEndsAt, now);
    return Object.assign({ plan: 'trial', status: left > 0 ? 'trial' : 'expired', trialEndsAt: sub.trialEndsAt, zileRamase: left }, base);
  }
  return Object.assign({ plan: null, status: 'none', zileRamase: null }, base);
}

/** Porneste perioada de proba (o singura data). */
function startTrial(sub, now) {
  now = now || Date.now();
  sub = Object.assign({}, sub || {});
  if (sub.trialStartedAt) throw new Error('Perioada de probă a fost deja folosită.');
  if (sub.plan && sub.plan !== 'trial' && sub.status === 'active') throw new Error('Ai deja un abonament activ.');
  sub.plan = 'trial'; sub.status = 'trial';
  sub.trialStartedAt = new Date(now).toISOString();
  sub.trialEndsAt = new Date(now + TRIAL_DAYS * 86400000).toISOString();
  return sub;
}

/** Alege un plan platit — se marcheaza „in asteptare activare" (fara integrare de plata). */
function selectPlan(sub, planId) {
  const p = PLANS.find((x) => x.id === planId && !x.trial);
  if (!p) throw new Error('Plan necunoscut.');
  sub = Object.assign({}, sub || {});
  sub.requestedPlan = planId;
  sub.requestedAt = new Date().toISOString();
  return sub;
}

/** Activare de catre admin dupa confirmarea platii. */
function activatePlan(sub, planId, now) {
  const p = PLANS.find((x) => x.id === planId && !x.trial);
  if (!p) throw new Error('Plan necunoscut.');
  sub = Object.assign({}, sub || {});
  sub.plan = planId; sub.status = 'active';
  sub.since = new Date(now || Date.now()).toISOString();
  sub.requestedPlan = null; sub.requestedAt = null;
  return sub;
}

/** Indexul unui abonament „in asteptare" (platit ca guest) dupa email; -1 daca nu exista. */
function findPending(pendingSubs, email) {
  const e = String(email || '').toLowerCase();
  if (!e || !Array.isArray(pendingSubs)) return -1;
  return pendingSubs.findIndex((x) => String(x.email || '').toLowerCase() === e);
}

/** Transforma un record „in asteptare" intr-un abonament activ pe user. */
function pendingToSubscription(rec, now) {
  return { plan: rec.plan, status: 'active', stripeCustomerId: rec.customerId || null, stripeSubscriptionId: rec.subscriptionId || null, since: new Date(now || Date.now()).toISOString() };
}

module.exports = { PLANS, TRIAL_DAYS, status, startTrial, selectPlan, activatePlan, daysLeft, findPending, pendingToSubscription, userKind, expiredLock };
