#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
#  DRIFT DE CONFIGURARE NGINX — copia din depozit fata de fisierul VIU
#
#  Infrastructura de productie a trait in afara depozitului: doua blocuri `location` adaugate
#  direct pe server (exceptia ACME `/.well-known/` si blocarea cailor cu punct -> 444) nu erau
#  in `nginx-contab.conf`. Antetul acelui fisier AVERTIZA ca cele doua pot drifta — si driftul
#  s-a produs exact acolo unde avertismentul spunea. Un avertisment scris nu e un mecanism.
#
#  Miza nu e cosmetica: unul dintre blocurile lipsa e plasa de reinnoire a certificatului. O
#  greseala acolo nu se vede azi, se vede peste ~2 luni, cand expira TLS-ul si site-ul cade.
#  Iar la o reinstalare pe o masina noua, din depozit ar fi iesit un nginx FARA ele.
#
#  Compara DIRECTIVELE, nu octetii: certbot rescrie comentarii si linii goale in fisierul viu,
#  iar copia din depozit poarta in plus un antet de activare. O comparatie verbatim ar raporta
#  drift permanent, deci ar fi ignorata dupa o saptamana — adica mai rau decat lipsa ei.
#
#  Coduri de iesire (acelasi contract ca `scripts/poarta-fiscala.sh` si `npm run test-pg`):
#     0 = identice pe directive
#     1 = DRIFT (se afiseaza diferenta)
#     2 = NEVERIFICAT — fisierul viu lipseste sau nu poate fi citit
#  `2` e distinct DELIBERAT: „n-am putut verifica" nu e „e bine". Pe o masina de dezvoltare sau
#  in CI nu exista /etc/nginx, si atunci raspunsul corect e „nu se aplica", nu un verde fals.
#
#  Folosire:  npm run nginx-drift          (citeste fisierul viu implicit)
#             CONTAB_NGINX_LIVE=/cale/alt  npm run nginx-drift
# ─────────────────────────────────────────────────────────────────────────────
set -eu

AICI=$(cd "$(dirname "$0")/.." && pwd)
COPIE="$AICI/nginx-contab.conf"
VIU="${CONTAB_NGINX_LIVE:-/etc/nginx/sites-available/contab}"

if [ ! -f "$COPIE" ]; then
  echo "[nginx-drift] NEVERIFICAT: lipseste copia din depozit ($COPIE)."
  exit 2
fi
if [ ! -f "$VIU" ]; then
  echo "[nginx-drift] NEVERIFICAT: fisierul viu nu exista ($VIU)."
  echo "               Normal pe o masina de dezvoltare sau in CI — nu e o eroare, dar nici o dovada."
  exit 2
fi
if [ ! -r "$VIU" ]; then
  echo "[nginx-drift] NEVERIFICAT: fisierul viu exista dar nu poate fi citit ($VIU)."
  echo "               Ruleaza cu drepturi de citire (ex. sudo -E npm run nginx-drift)."
  exit 2
fi

# Doar directivele: fara comentarii, fara linii goale, fara indentare la capete.
norm() { sed 's/[[:space:]]*$//' "$1" | grep -vE '^[[:space:]]*(#|$)' | sed 's/^[[:space:]]*//'; }

TMPA=$(mktemp); TMPB=$(mktemp)
trap 'rm -f "$TMPA" "$TMPB"' EXIT
norm "$COPIE" > "$TMPA"
norm "$VIU"   > "$TMPB"

if diff -u "$TMPA" "$TMPB" > /dev/null 2>&1; then
  echo "[nginx-drift] VERDE — copia din depozit e identica pe directive cu $VIU ($(grep -c '' "$TMPA") directive)."
  exit 0
fi

echo "[nginx-drift] DRIFT — configul viu difera de copia din depozit."
echo "               '-' = doar in depozit   |   '+' = doar pe server (viu)"
echo
diff -u --label "depozit: nginx-contab.conf" --label "viu: $VIU" "$TMPA" "$TMPB" || true
echo
echo "Ce faci mai departe:"
echo "  • daca serverul e sursa de adevar (cazul obisnuit — certbot sau o corectie urgenta):"
echo "      sudo cat $VIU  si adu schimbarea in nginx-contab.conf, apoi comite."
echo "  • daca depozitul e sursa de adevar (ai pregatit o schimbare aici):"
echo "      sudo cp nginx-contab.conf $VIU && sudo nginx -t && sudo systemctl reload nginx"
echo "  Antetul comentat din nginx-contab.conf NU conteaza: se compara doar directivele."
exit 1
