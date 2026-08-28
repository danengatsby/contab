#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  E2E IZOLAT — scenarii care NU se pot rula pe demo live
#
#  E2E-ul existent (scripts/e2e.mjs) verifica instanta LIVE cu contul demo: e util, dar poate
#  atinge doar ce e sigur pe date reale. Nu poate reseta o parola, activa 2FA, importa fisiere,
#  restaura un backup sau strica ceva intentionat ca sa vada mesajul de eroare.
#
#  Aici pornim o instanta PROPRIE (baza temporara, director de date temporar, port liber), o
#  populam cu seed, rulam scenariile in browser real si o stergem la final. Nimic nu atinge
#  productia: CONTAB_DB_FILE si CONTAB_DATA_DIR sunt obligatorii si temporare (un CONTAB_DATA_DIR
#  uitat ar scrie backup-uri si audit in data/ al instalarii reale).
#
#  Rulare:  bash scripts/e2e-izolat.sh
#  Browserul ruleaza in Docker (serverul nu are bibliotecile de sistem pentru Chromium), cu
#  --network host ca sa ajunga la instanta de pe gazda.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RADACINA=$(cd "$(dirname "$0")/.." && pwd)
PORT=${E2E_PORT:-18777}
TMP=$(mktemp -d /tmp/contab-e2e-XXXXXX)
DBF="$TMP/db.json"
DATA="$TMP/data"
IMG=${E2E_IMAGE:-mcr.microsoft.com/playwright:v1.58.2-noble}
PAROLA='E2E-Izolat-2026!'

curata() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true
  fuser -k "$PORT"/tcp 2>/dev/null || true
  rm -rf "$TMP"
}
trap curata EXIT

echo "── instanta izolata pe portul $PORT (date in $TMP)"
export CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE="$DBF" CONTAB_DATA_DIR="$DATA"
export CONTAB_FISCAL_REVIEW_FILE="$TMP/fiscal-review.json"
export CONTAB_FISCAL_REVIEW_TRUST_FILE="$TMP/fiscal-review-trust.json"
export CONTAB_DEV=1                 # instanta de test: fara secretele de productie (vezi secretsGuard)
# Ieșirile fiscale sunt fail-closed. Instanța efemeră primește registrul criptografic sintetic
# folosit exclusiv de teste, în loc să depindă de aprobările profesionale ale instalării reale.
node -e 'require(process.argv[1]).writeApproved(process.env.CONTAB_FISCAL_REVIEW_FILE, process.env.CONTAB_FISCAL_REVIEW_TRUST_FILE)' \
  "$RADACINA/test/run/fiscalReviewFixture.js"
node "$RADACINA/scripts/seed.js" >"$TMP/seed.log" 2>&1

PORT=$PORT HOST=127.0.0.1 CONTAB_JSON_MIRROR=0 STRIPE_SECRET_KEY='' \
  CONTAB_RATE_API=100000 CONTAB_RATE_UPLOAD=1000 CONTAB_RATE_IMPORT=1000 CONTAB_HIBP=0 \
  node "$RADACINA/server.js" >"$TMP/server.log" 2>&1 &
SRV=$!
timeout 40 bash -c "until curl -sf http://127.0.0.1:$PORT/api/health >/dev/null; do sleep 1; done" \
  || { echo "serverul nu a pornit:"; tail -20 "$TMP/server.log"; exit 1; }

# ── pregatire out-of-band: lucruri pe care browserul nu le poate face singur ──
# 1. Prima instalare nu mai are parola comuna admin/admin. Citim tokenul EFEMER din logul
# instantei izolate, initializam local contul si activam 2FA: administratorul nu poate pregati
# fixture-urile privilegiate pana la inrolare. Scenariul browser primeste secretul acestei instante;
# fluxul complet activare -> login -> oprire este verificat separat pe un cont neprivilegiat.
API="http://127.0.0.1:$PORT"
BOOT=$(sed -n 's/.*INITIALIZARE ADMIN.*local: //p' "$TMP/seed.log" "$TMP/server.log" | tail -1)
[ -n "$BOOT" ] || { echo "tokenul de initializare nu a aparut in log"; tail -20 "$TMP/seed.log"; tail -20 "$TMP/server.log"; exit 1; }
C=$(curl -s -D - -o /dev/null -X POST "$API/api/bootstrap/initialize" -H 'Content-Type: application/json' \
     -d "{\"token\":\"$BOOT\",\"password\":\"$PAROLA\"}" | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
[ -n "$C" ] || { echo "initializarea administratorului nu a emis sesiune"; exit 1; }
TOK=$(curl -s -H "Cookie: $C" "$API/api/me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).csrf||"")}catch(e){console.log("")}})')
SETUP_2FA=$(curl -s -X POST "$API/api/2fa/setup" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' -d '{}')
SECRET_2FA=$(printf '%s' "$SETUP_2FA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).secret||"")}catch(e){}})')
[ -n "$SECRET_2FA" ] || { echo "configurarea temporara 2FA a esuat: $SETUP_2FA"; exit 1; }
CODE_2FA=$(node -e 'process.stdout.write(require(process.argv[1]).codeForCounter(process.argv[2],Math.floor(Date.now()/1000/30)))' "$RADACINA/src/totp.js" "$SECRET_2FA")
ENABLE_2FA=$(curl -s -X POST "$API/api/2fa/enable" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" \
  -H 'Content-Type: application/json' -d "{\"code\":\"$CODE_2FA\"}")
printf '%s' "$ENABLE_2FA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{if(!JSON.parse(s).ok)process.exit(1)}catch(e){process.exit(1)}})' \
  || { echo "activarea temporara 2FA a esuat: $ENABLE_2FA"; exit 1; }
LEGAL_MODE=$(curl -s -X POST "$API/api/legal/mode" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" \
  -H 'Content-Type: application/json' -d '{"mode":"test","confirmFictitious":true}')
printf '%s' "$LEGAL_MODE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{if(!JSON.parse(s).operational)process.exit(1)}catch(e){process.exit(1)}})' \
  || { echo "declararea regimului de date al fixture-ului a esuat: $LEGAL_MODE"; exit 1; }

# 2. SMTP „configurat" (altfel /api/forgot-password nu genereaza token, prin proiectare) + email pe cont
curl -s -X POST "$API/api/smtp" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' \
  -d '{"host":"localhost","port":1025,"from":"e2e@local"}' >/dev/null || true
curl -s -X POST "$API/api/profile" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' \
  -d '{"email":"admin@e2e.local"}' >/dev/null || true

# 3. utilizator cu drepturi RESTRANSE. ATENTIE: POST /api/users NU accepta `drepturi` la creare
#    (le ignora tacut) — se pun DUPA, pe /api/users/<id>. Prima varianta a acestui script le
#    trimitea la creare si scenariul de roluri trecea degeaba: utilizatorul avea drepturi depline.
UTILIZ=$(curl -s -X POST "$API/api/users" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' \
  -d "{\"username\":\"limitat\",\"password\":\"$PAROLA\",\"role\":\"user\",\"firme\":[1]}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).user.id))}catch(e){process.stdout.write("")}})')
[ -n "$UTILIZ" ] && curl -s -X POST "$API/api/users/$UTILIZ" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" \
  -H 'Content-Type: application/json' -d '{"drepturi":{"faraSalarii":true}}' >/dev/null || true

# cont neprivilegiat dedicat fluxului 2FA; politica fail-closed interzice dezactivarea factorului
# administratorului, ceea ce este corect si nu trebuie ocolit doar pentru test.
curl -s -X POST "$API/api/users" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' \
  -d "{\"username\":\"doifa-e2e\",\"password\":\"$PAROLA\",\"role\":\"user\",\"firme\":[1]}" >/dev/null

# 3b. cont demo local pentru scenariul UX general. Instanța este izolată, deci nu depindem de
# contul demo live și testăm exact codul backend încărcat în procesul de mai sus.
curl -s -X POST "$API/api/users" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' \
  -d "{\"username\":\"demo\",\"password\":\"$PAROLA\",\"role\":\"user\",\"firme\":[1],\"firmaRoluri\":{\"1\":\"operator\"}}" >/dev/null
# A doua identitate publică permite aceluiași scenariu UX să verifice cockpitul multi-firmă fără
# să schimbe cookie-ul operatorului. Rolul aprobator este suficient pentru experiența Contabil;
# permisiunile reale rămân matricea serverului.
curl -s -X POST "$API/api/users" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' \
  -d "{\"username\":\"demo-contabil\",\"password\":\"$PAROLA\",\"role\":\"user\",\"firme\":[1],\"firmaRoluri\":{\"1\":\"aprobator\"}}" >/dev/null

# 4. token de resetare: se cere prin API, apoi se citeste din baza (browserul n-are cum — pleaca pe email)
curl -s -X POST "$API/api/forgot-password" -H 'Content-Type: application/json' \
  -d '{"login":"admin@e2e.local"}' >/dev/null || true
# Tokenul sta pe utilizator, in baza. Driverul e sqlite si oglinda JSON e oprita, deci se
# citeste din tabelul `users` (fiecare rand = blob JSON in coloana `data`), read-only.
RESET=$(node -e '
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  for (const r of db.prepare("SELECT data FROM users").all()) {
    const u = JSON.parse(r.data);
    if (u && u.resetToken) { process.stdout.write(u.resetToken); break; }
  }
  db.close();
} catch (e) { process.stdout.write(""); }' "$TMP/db.sqlite")
if [ -n "$RESET" ]; then RESET_STARE=prezent; else RESET_STARE=ABSENT; fi
echo "── pregatire: admin initializat + 2FA activ | utilizator limitat id=${UTILIZ:-?} | token resetare: $RESET_STARE"

echo "── scenarii in browser (Docker)"
set +e
docker run --rm --network host \
  -v "$RADACINA/scripts/e2e-izolat.mjs:/w/e2e.mjs:ro" \
  -v "$RADACINA/scripts/e2e.mjs:/w/e2e-ux.mjs:ro" \
  -e BASE_URL="http://127.0.0.1:$PORT" -e E2E_PAROLA="$PAROLA" -e E2E_RESET="$RESET" \
  -e E2E_ADMIN_TOTP_SECRET="$SECRET_2FA" -e E2E_UX_ONLY="${E2E_UX_ONLY:-0}" -e E2E_SKIP_UX="${E2E_SKIP_UX:-0}" \
  -w /w "$IMG" \
  sh -c 'npm i --no-save playwright@1.58.2 >/dev/null 2>&1 || exit $?;
    ux=0; [ "$E2E_SKIP_UX" = 1 ] || { node e2e-ux.mjs; ux=$?; }; [ "$E2E_UX_ONLY" = 1 ] && exit "$ux";
    node e2e.mjs; izolat=$?;
    [ "$ux" -eq 0 ] && [ "$izolat" -eq 0 ]'
COD=$?
set -e
exit $COD
