#!/bin/sh
# Validare declaratii cu DUKIntegrator — validatorul OFICIAL ANAF — rulat prin Docker
# (serverul nu are Java; jar-ul ruleaza intr-un container efemer, nimic nu se scrie in repo).
#
#   scripts/valideaza-duk.sh <TIP> <fisier.xml>        ex: scripts/valideaza-duk.sh D300 decont.xml
#
# Ce face: descarca o singura data distributia DUKIntegrator (static.anaf.ro), apoi validatorul
# declaratiei cerute din manifestul oficial versiuni.xml (reimprospatat automat dupa 7 zile —
# ANAF actualizeaza validatoarele frecvent), si ruleaza validarea. Iese cu 0 = valid,
# 1 = erori de validare (afisate), 2 = tip de declaratie inexistent in manifest.
#
# Opt-in prin design: validarea oficiala NU e in fluxul de generare (ar lega serverul de un
# runtime Java si de ciclul de update-uri ANAF); pre-validarea rapida ramane src/validate.js.
#   CONTAB_DUK_DIR    cache-ul distributiei (implicit /var/tmp/contab-duk — in afara repo-ului)
#   CONTAB_DUK_IMAGE  imaginea Java (implicit eclipse-temurin:8-jre; jar-urile ANAF sunt pe 8)
set -eu

TIP=${1:?Folosire: valideaza-duk.sh <TIP> <fisier.xml>  (ex: D300 decont.xml)}
XML=${2:?Lipseste fisierul XML de validat}
[ -f "$XML" ] || { echo "Fisier inexistent: $XML" >&2; exit 2; }
DUK=${CONTAB_DUK_DIR:-/var/tmp/contab-duk}
IMG=${CONTAB_DUK_IMAGE:-eclipse-temurin:8-jre}
MANIFEST="http://static.anaf.ro/static/10/Anaf/update5/versiuni.xml"
mkdir -p "$DUK"

# 1) distributia de baza (o singura data; linkul curent e citit din pagina oficiala)
if [ ! -f "$DUK/dist/DUKIntegrator.jar" ]; then
  URL=$(curl -s --max-time 30 https://static.anaf.ro/static/DUKIntegrator/DUKIntegrator.htm \
        | grep -o 'href="[^"]*\.zip"' | head -1 | cut -d'"' -f2)
  [ -n "$URL" ] || URL="https://static.anaf.ro/static/DUKIntegrator/dist_javaInclus20200203.zip"
  echo "Descarc DUKIntegrator: $URL" >&2
  curl -s --max-time 300 -o "$DUK/dist.zip" "$URL"
  (cd "$DUK" && unzip -qo dist.zip)
fi

# 2) validatorul declaratiei, din manifestul oficial (reimprospatat dupa 7 zile)
JAR="$DUK/dist/lib/${TIP}Validator.jar"
if [ ! -f "$JAR" ] || [ -n "$(find "$JAR" -mtime +7 2>/dev/null)" ]; then
  JURL=$(curl -s --max-time 30 "$MANIFEST" | tr -d '\r' \
         | sed -n "/<$TIP>/,/<\/$TIP>/p" | grep -o '<JURL>[^<]*' | head -1 | cut -d'>' -f2)
  [ -n "$JURL" ] || { echo "Tip '$TIP' inexistent in manifestul ANAF (versiuni.xml)." >&2; exit 2; }
  echo "Descarc validatorul $TIP: $JURL" >&2
  curl -s --max-time 120 -o "$JAR" "$JURL"
fi

# 3) rulare in container efemer. XML-ul e COPIAT intr-un director de lucru propriu:
#    DUKIntegrator scrie fisiere (.log, erori) linga intrare — nu-l lasam sa scrie linga original.
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
cp "$XML" "$W/in.xml"
docker run --rm -v "$DUK/dist":/duk -v "$W":/w -w /duk "$IMG" \
  java -jar /duk/DUKIntegrator.jar -v "$TIP" /w/in.xml /w/erori.txt >"$W/out.txt" 2>&1 || true

if [ -s "$W/erori.txt" ]; then
  cat "$W/erori.txt"
  echo ""
  echo "✗ $TIP: INVALID conform validatorului oficial ANAF ($(grep -c '^[EF]:' "$W/erori.txt") erori)." >&2
  exit 1
fi
# fara fisier de erori, dar cu mesaj de esec in stdout (ex. validator lipsa) = tot esec
if grep -qi "eroare\|nu gasesc" "$W/out.txt"; then cat "$W/out.txt" >&2; exit 2; fi
echo "✓ $TIP: valid conform validatorului oficial ANAF."
