'use strict';

// Planuri de abonament pentru aplicatie + logica de trial. Functii pure pe obiectul `subscription`
// stocat pe user: { plan, status, trialStartedAt, trialEndsAt, since, requestedPlan, requestedAt }.

const TRIAL_DAYS = 30;
// Cate perioade de proba poate primi o FIRMA, in total. Prima vine automat la inscriere; a doua
// se cere explicit, de pe ecranul de preturi, dupa ce prima a expirat. Dupa a doua, cardul de
// proba ramane vizibil dar inactiv — utilizatorul vede ca optiunea exista si ca s-a consumat,
// in loc sa dispara fara explicatie.
const TRIAL_MAX = 2;

// ─────────────────────────────────────────────────────────────────────────────
//  ABONAMENTELE PLATITE — SUSPENDATE cat timp furnizorul nu are identitate juridica.
//
//  Termenii si DPA-ul afisau pana acum date de identificare FICTIVE („EXEMPLU SOFT S.R.L.")
//  in timp ce cheia Stripe era `sk_live`, adica se puteau incasa bani reali sub un contract
//  semnat de o societate inexistenta: contractul nu obliga pe nimeni, iar DPA-ul (art. 28 GDPR)
//  nu acopera pe nimeni. Datele fictive au fost scoase; ca sa nu ramana o poarta de plata fara
//  parte contractanta, incasarea se opreste ODATA CU ele, in acelasi commit.
//
//  Suspendarea sta in COD, nu intr-o variabila de mediu, si e deliberat asa: un `.env` uitat
//  sau o instalare noua ar reactiva incasarea tacut, exact riscul de evitat. Se ridica manual,
//  intr-un commit care completeaza si blocul de identitate din public/termeni.html + public/dpa.html
//  — cele doua sunt aceeasi decizie, nu doua.
//
//  Ce NU opreste: proba gratuita, portalul Stripe (un client existent trebuie sa poata mereu
//  anula), webhook-ul (un abonament deja platit trebuie onorat) si activarea manuala de catre
//  admin (acolo exista un om care raspunde de identitate).
const PLATI_SUSPENDATE = true;
const MOTIV_PLATI_SUSPENDATE = 'Abonamentele plătite sunt momentan indisponibile: '
  + 'furnizorul este în curs de înființare, iar până la publicarea datelor lui de identificare '
  + 'nu încasăm nicio sumă. Proba gratuită rămâne complet funcțională.';

// Toate planurile includ aceleasi functii (se diferentiaza doar prin pret).
const FEATURES = [
  'Facturi + e-Factura',
  'TVA + declarații de bază',
  'Toate declarațiile + SAF-T',
  'Stocuri + producție',
  'Situații financiare anuale complete (bilanț, P&L, fluxuri, capitaluri, note)',
  'Suport prioritar',
];

const PLANS = [
  {
    id: 'trial', nume: 'Probă gratuită', pret: 0, moneda: 'lei', perioada: TRIAL_DAYS + ' zile', trial: true,
    tip: 'tester', descriere: 'Tester — testează tot, fără card bancar.',
    // proba are toate functiile, dar fara suport prioritar (doar planurile platite)
    features: FEATURES.filter((f) => f !== 'Suport prioritar'),
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

/** Abonament de PROBA per firma (30 zile). */
function firmaTrialSub(now, trialCount) {
  now = now || Date.now();
  return {
    plan: 'trial',
    trialStartedAt: new Date(now).toISOString(),
    trialEndsAt: new Date(now + TRIAL_DAYS * 86400000).toISOString(),
    // a cata proba e aceasta. Firmele dinaintea campului nu-l au: `trialCount || 1` le socoteste
    // la prima, deci pot cere inca una — nu le penalizam pentru ca abonamentul lor e mai vechi.
    trialCount: trialCount || 1,
  };
}
/** Cate probe a consumat firma (firmele vechi, fara contor, au avut una). */
function firmaTrialCount(firma) {
  const s = (firma && firma.subscription) || {};
  if (s.trialCount) return Number(s.trialCount) || 0;
  return s.trialEndsAt ? 1 : 0;
}
/** Mai poate firma sa ceara o proba? Doar cand cea curenta s-a terminat si n-a atins plafonul. */
function firmaPoateProba(firma, now) {
  const st = firmaStatus(firma, now);
  if (st.status === 'active' || st.status === 'trial') return false; // are deja acces
  return firmaTrialCount(firma) < TRIAL_MAX;
}

/**
 * Starea abonamentului unei FIRME (billing strict per-firma): fiecare firma are propriul
 * abonament (`firma.subscription`). { status, plan, zileRamase, trialEndsAt }.
 *   active     — abonament platit activ (sau firma veche „grandfathered");
 *   trial      — in proba de 30 de zile;
 *   expired    — proba a expirat, fara abonament -> read-only pana la abonare;
 *   none       — fara abonament si fara proba -> read-only.
 */
function firmaStatus(firma, now) {
  now = now || Date.now();
  const s = (firma && firma.subscription) || {};
  const pending = !!s.pendingPlan && s.status !== 'active'; // checkout initiat, in asteptarea platii
  if (s.status === 'active') return { status: 'active', plan: s.plan || 'activ', since: s.since || null, zileRamase: null, pending: false };
  const nrProbe = s.trialCount ? (Number(s.trialCount) || 0) : (s.trialEndsAt ? 1 : 0);
  if (s.trialEndsAt) {
    const left = daysLeft(s.trialEndsAt, now);
    return { status: left > 0 ? 'trial' : 'expired', plan: 'trial', trialEndsAt: s.trialEndsAt, zileRamase: left,
      trialCount: nrProbe, maiPoateProba: left <= 0 && nrProbe < TRIAL_MAX, trialMax: TRIAL_MAX,
      pending, pendingPlan: pending ? s.pendingPlan : null };
  }
  return { status: 'none', plan: null, zileRamase: null, trialCount: nrProbe, maiPoateProba: nrProbe < TRIAL_MAX, trialMax: TRIAL_MAX,
    pending, pendingPlan: pending ? s.pendingPlan : null };
}

/** Firma blocata (read-only): proba expirata sau fara abonament. */
function firmaLocked(firma, now) {
  const st = firmaStatus(firma, now).status;
  return st === 'expired' || st === 'none';
}

/** Compat: „proba activa/expirata" a firmei, derivata din firmaStatus. */
function firmaTrial(firma, now) {
  const st = firmaStatus(firma, now);
  return { trial: st.status === 'trial' || st.status === 'expired', expired: st.status === 'expired', zileRamase: st.zileRamase };
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

module.exports = { PLANS, TRIAL_DAYS, TRIAL_MAX, PLATI_SUSPENDATE, MOTIV_PLATI_SUSPENDATE, status, startTrial, selectPlan, activatePlan, daysLeft, findPending, pendingToSubscription, userKind, expiredLock, firmaTrial, firmaTrialSub, firmaTrialCount, firmaPoateProba, firmaStatus, firmaLocked };
