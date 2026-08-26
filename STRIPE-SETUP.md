# Integrare Stripe — abonamente & plăți online

Aplicația folosește **Stripe Checkout** (pagină de plată găzduită) + **Billing Portal** (client își gestionează/anulează abonamentul) + **webhook-uri** (activare automată după plată). Fără configurare, plățile online sunt dezactivate și planurile se activează manual din admin.

## 1. Cont & chei
1. Creează cont pe https://stripe.com (folosește **modul Test** la început — comutatorul din stânga sus).
2. **Developers → API keys** → copiază **Secret key** (`sk_test_...`).

## 2. Produse & prețuri
Pentru fiecare plan creează un **Product** cu un **Price recurent lunar per firmă** (RON):
- **Product → Add product**: „Start", preț `99 RON/lună/firmă` (recurring) → copiază **Price ID** (`price_...`).
- La fel pentru „Pro" (`99 RON/lună/firmă`). Fiecare firmă primește un abonament separat.

> Prețurile afișate în aplicație vin din `src/plans.js`; ține-le sincronizate cu cele din Stripe.

## 3. Webhook
1. **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://contabo.space/api/stripe/webhook`
3. Selectează evenimentele:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. După creare, copiază **Signing secret** (`whsec_...`).

## 4. Configurare `.env`
Adaugă în `/var/www/contab/.env` (fișierul e `chmod 600`, negitignored — nu comite secrete):

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_START=price_...
STRIPE_PRICE_PRO=price_...
APP_URL=https://contabo.space
```

Apoi repornește: `pm2 restart contab --update-env`

## 5. Test
- Din aplicație → **💳 Abonament** → butonul devine „Abonează-te" → redirect la Stripe Checkout.
- Card de test: `4242 4242 4242 4242`, orice dată viitoare, orice CVC/cod poștal.
- După plată, Stripe redirecționează la `…/?checkout=success` și trimite webhook-ul care **activează abonamentul** automat.
- „Gestionează / anulează abonamentul" → deschide Billing Portal.

Testarea locală a webhook-ului (opțional):
```
stripe login
stripe listen --forward-to https://contabo.space/api/stripe/webhook
```

## 6. Trecerea în producție (live)
1. Comută Stripe pe **Live mode**, ia cheile `sk_live_...`.
2. Recreează Produsele/Prețurile în live → noi `price_...`.
3. Creează webhook-ul live → nou `whsec_...`.
4. Actualizează `.env` cu valorile live + `pm2 restart contab --update-env`.
5. Activează **Billing Portal** în Dashboard: Settings → Billing → Customer portal.

## Cum funcționează în cod
- `src/billing.js` — wrapper Stripe (lazy-require; dezactivat fără cheie).
- `src/plans.js` — definiția planurilor + logica de trial.
- Rute: `POST /api/subscription/checkout` (creează sesiunea), `POST /api/subscription/portal`, `POST /api/stripe/webhook` (public, body brut, semnătură verificată).
- Starea abonamentului se salvează pe `user.subscription` `{ plan, status, stripeCustomerId, stripeSubscriptionId, since, ... }`.
