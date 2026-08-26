#!/bin/sh
# Validare declaratii cu DUKIntegrator — validatorul OFICIAL ANAF — rulat prin Docker
# (serverul nu are Java; jar-ul ruleaza intr-un container efemer, nimic nu se scrie in repo).
#
#   scripts/valideaza-duk.sh <TIP> <fisier.xml>        ex: scripts/valideaza-duk.sh D300 decont.xml
#
# Ce face: pentru D406 citeste pagina SAF-T la fiecare sesiune de validare si foloseste impreuna
# distributia + XSD-ul publicate acolo; pentru restul declaratiilor foloseste manifestul oficial
# versiuni.xml. Cache-ul D406 este reverificat dupa 30 minute, iar cel generic dupa 7 zile.
# Iese cu 0 = valid,
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

# Director unic pentru toate fisierele pe care validatoarele le scriu sau le adapteaza. Originalul
# ramane read-only si nu primeste .log/.txt langa el.
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
cp "$XML" "$W/in.xml"

DIST="$DUK/dist"
XSD=""
SAFT_META="$DUK/.saft-oficial-curent"

if [ "$TIP" = "D406" ]; then
  # ANAF publica D406 separat de distributia generica DUKIntegrator. Prima legatura validator/XSD
  # din pagina SAF-T este distributia curenta; numele nu este ghicit si nu exista fallback vechi.
  # Un endpoint indisponibil inseamna NEVERIFICAT, nu reutilizarea tacuta a unei versiuni expirate.
  if [ ! -f "$SAFT_META" ] || [ -z "$(find "$SAFT_META" -mmin -30 -print 2>/dev/null)" ]; then
    PAGINA="https://static.anaf.ro/static/10/Anaf/Informatii_R/saf_t.htm"
    HTML=$(curl -fsSL --max-time 30 "$PAGINA") \
      || { echo "Nu pot citi pagina oficiala SAF-T: $PAGINA" >&2; exit 2; }
    URL=$(printf '%s' "$HTML" | grep -o 'https://static\.anaf\.ro[^" ]*duk_SAFT[^" ]*\.zip' | head -1)
    XURL=$(printf '%s' "$HTML" | grep -o 'https://static\.anaf\.ro[^" ]*Ro_SAFT_Schema[^" ]*\.xsd' | head -1)
    [ -n "$URL" ] && [ -n "$XURL" ] \
      || { echo "Pagina SAF-T nu mai expune validatorul si XSD-ul in forma asteptata." >&2; exit 2; }

    mkdir -p "$DUK/saft-pachete"
    ZIP="$DUK/saft-pachete/$(basename "$URL")"
    XSD_NOU="$DUK/saft-pachete/$(basename "$XURL")"
    echo "Reimprospatez distributia D406 oficiala: $URL" >&2
    curl -fsSL --max-time 300 -o "$ZIP.nou" "$URL" \
      || { echo "Nu s-a putut descarca distributia D406." >&2; exit 2; }
    mv "$ZIP.nou" "$ZIP"
    curl -fsSL --max-time 120 -o "$XSD_NOU.nou" "$XURL" \
      || { echo "Nu s-a putut descarca XSD-ul D406." >&2; exit 2; }
    mv "$XSD_NOU.nou" "$XSD_NOU"

    SHA=$(sha256sum "$ZIP" | cut -d' ' -f1)
    XSHA=$(sha256sum "$XSD_NOU" | cut -d' ' -f1)
    DEST="$DUK/saft-pachete/$SHA"
    if [ ! -f "$DEST/dist/DUKIntegrator_AnLunaUI.jar" ]; then
      EXTRAS=$(mktemp -d "$DUK/saft-extras.XXXXXX")
      unzip -qo "$ZIP" '*/dist/*' -x '*/dist/jre6/*' '*/dist/jre8/*' -d "$EXTRAS"
      SURSA=$(find "$EXTRAS" -type d -path '*/dist' | head -1)
      [ -n "$SURSA" ] && [ -f "$SURSA/DUKIntegrator_AnLunaUI.jar" ] \
        || { echo "Arhiva D406 nu contine distributia asteptata." >&2; exit 2; }
      mkdir -p "$DEST"
      mv "$SURSA" "$DEST/dist"
    fi
    printf 'DIST=%s\nXSD=%s\nURL=%s\nXURL=%s\nSHA256=%s\nXSD_SHA256=%s\n' \
      "$DEST/dist" "$XSD_NOU" "$URL" "$XURL" "$SHA" "$XSHA" > "$SAFT_META"
  fi
  DIST=$(sed -n 's/^DIST=//p' "$SAFT_META")
  XSD=$(sed -n 's/^XSD=//p' "$SAFT_META")
  URL=$(sed -n 's/^URL=//p' "$SAFT_META")
  SHA=$(sed -n 's/^SHA256=//p' "$SAFT_META")
  [ -f "$DIST/DUKIntegrator_AnLunaUI.jar" ] && [ -f "$DIST/lib/D406Validator.jar" ] && [ -f "$XSD" ] \
    || { echo "Cache-ul D406 oficial este incomplet." >&2; exit 2; }
  command -v xmllint >/dev/null 2>&1 \
    || { echo "D406 NEVERIFICAT: xmllint lipseste pentru XSD-ul oficial." >&2; exit 2; }
  # ANAF publica in aceeasi pagina doua contracte care se contrazic numai la namespace:
  # XSD-ul v2.4.9 are targetNamespace `...:d406t:...`, iar DUKIntegrator J2.2.18 cere explicit
  # `...:d406:...`. Nu schimbam XML-ul depus ca sa multumim XSD-ul si sa-l facem respins de DUK.
  # Pentru proba structurala XSD construim o COPIE temporara cu singura substitutie de namespace;
  # documentul original trece apoi, nemodificat, prin DUK. Orice alta divergenta ramane blocanta.
  XML_NS=$(grep -o 'xmlns="[^"]*"' "$W/in.xml" | head -1 | cut -d'"' -f2)
  XSD_NS=$(grep -o 'targetNamespace="[^"]*"' "$XSD" | head -1 | cut -d'"' -f2)
  XSD_INTRARE="$W/in.xml"
  if [ "$XML_NS" = "mfp:anaf:dgti:d406:declaratie:v1" ] \
      && [ "$XSD_NS" = "mfp:anaf:dgti:d406t:declaratie:v1" ]; then
    XSD_INTRARE="$W/xsd-namespace-bridge.xml"
    sed '0,/mfp:anaf:dgti:d406:declaratie:v1/s//mfp:anaf:dgti:d406t:declaratie:v1/' \
      "$W/in.xml" > "$XSD_INTRARE"
    echo "D406: adaptez numai namespace-ul pe copia XSD (d406 → d406t); DUK primeste originalul." >&2
  elif [ "$XML_NS" != "$XSD_NS" ]; then
    echo "D406: namespace XML ($XML_NS) diferit de XSD ($XSD_NS), in afara exceptiei oficiale cunoscute." >&2
    exit 1
  fi
  if ! xmllint --noout --schema "$XSD" "$XSD_INTRARE" 2>"$W/d406-xsd-eroare"; then
    cat "$W/d406-xsd-eroare" >&2
    echo "✗ D406: INVALID conform XSD-ului oficial ANAF." >&2
    exit 1
  fi
  echo "D406: XSD oficial valid; distributie $(basename "$URL"), sha256 $SHA." >&2
else
  # Distributia generica si validatorul declaratiei din versiuni.xml.
  if [ ! -f "$DIST/DUKIntegrator.jar" ]; then
    URL=$(curl -s --max-time 30 https://static.anaf.ro/static/DUKIntegrator/DUKIntegrator.htm \
          | grep -o 'href="[^"]*\.zip"' | head -1 | cut -d'"' -f2)
    [ -n "$URL" ] || URL="https://static.anaf.ro/static/DUKIntegrator/dist_javaInclus20200203.zip"
    echo "Descarc DUKIntegrator: $URL" >&2
    curl -s --max-time 300 -o "$DUK/dist.zip" "$URL"
    (cd "$DUK" && unzip -qo dist.zip)
  fi
  MARKER="$DUK/.jars-de-baza"
  if [ ! -f "$MARKER" ] || [ -n "$(find "$MARKER" -mtime +7 2>/dev/null)" ]; then
    curl -s --max-time 30 "$MANIFEST" | grep -o 'http://[^<]*update5/[a-z0-9]*/[A-Za-z.]*jar' | sort -u | while read -r U; do
      F=$(basename "$U")
      DEST=$([ "$F" = "DUKIntegrator.jar" ] && echo "$DIST/$F" || echo "$DIST/lib/$F")
      curl -s --max-time 120 -o "$DEST" "$U" || true
    done
    touch "$MARKER"
  fi
  JAR="$DIST/lib/${TIP}Validator.jar"
  if [ ! -f "$JAR" ] || [ -n "$(find "$JAR" -mtime +7 2>/dev/null)" ]; then
    JURL=$(curl -s --max-time 30 "$MANIFEST" | tr -d '\r' \
           | sed -n "/<$TIP>/,/<\/$TIP>/p" | grep -o '<JURL>[^<]*' | head -1 | cut -d'>' -f2)
    [ -n "$JURL" ] || { echo "Tip '$TIP' inexistent in manifestul ANAF (versiuni.xml)." >&2; exit 2; }
    echo "Descarc validatorul $TIP: $JURL" >&2
    curl -s --max-time 120 -o "$JAR" "$JURL"
  fi
fi

# 3) rulare in container efemer. DUKIntegrator scrie numai in directorul temporar de mai sus.
if [ "$TIP" = "D406" ]; then
  AN=$(grep -o '<PeriodEndYear>[^<]*' "$W/in.xml" | head -1 | cut -d'>' -f2)
  LUNA=$(grep -o '<PeriodEnd>[^<]*' "$W/in.xml" | head -1 | cut -d'>' -f2)
  [ -n "$AN" ] && [ -n "$LUNA" ] || { echo "D406 fara perioada raportata in SelectionCriteria." >&2; exit 1; }
  docker run --rm -v "$DIST":/duk -v "$W":/w -w /duk "$IMG" \
    java -jar /duk/DUKIntegrator_AnLunaUI.jar -v D406 /w/in.xml /w/erori.txt '$' '$' \
    "an=$AN" "luna=$LUNA" >"$W/out.txt" 2>&1 || true
else
  docker run --rm -v "$DIST":/duk -v "$W":/w -w /duk "$IMG" \
    java -jar /duk/DUKIntegrator.jar -v "$TIP" /w/in.xml /w/erori.txt >"$W/out.txt" 2>&1 || true
fi

# la succes DUKIntegrator scrie "Validare fara erori" in stdout si "ok" in fisierul de erori
if grep -q "Validare fara erori" "$W/out.txt"; then
  echo "✓ $TIP: valid conform validatorului oficial ANAF."
  exit 0
fi
# ATENTIONARI, fara nicio eroare: declaratia E acceptata. DUKIntegrator scrie si atentionarile in
# acelasi fisier, iar stdout nu mai spune „Validare fara erori" — asa incat o declaratie CORECTA
# ajungea raportata „INVALID (0 erori)", adica un fals alarm care ar bloca un release. Unele
# combinatii fiscale legitime pot produce atentionari, fara ca XML-ul sa fie respins.
# Fail-closed: se cere ATAT confirmarea din stdout, CAT SI absenta oricarui bloc de eroare (E:/F:).
# Orice alta forma cade mai jos, la INVALID.
if grep -q "Atentionari la validare" "$W/out.txt" && ! grep -q '^[EF]:' "$W/erori.txt"; then
  echo "✓ $TIP: valid conform validatorului oficial ANAF, cu $(grep -c 'atentionare regula' "$W/erori.txt") atentionare/atentionari:"
  sed 's/^/    /' "$W/erori.txt"
  exit 0
fi
if [ -s "$W/erori.txt" ] && ! grep -qx "ok" "$W/erori.txt"; then
  cat "$W/erori.txt"
  echo ""
  echo "✗ $TIP: INVALID conform validatorului oficial ANAF ($(grep -c '^[EF]:' "$W/erori.txt") erori)." >&2
  exit 1
fi
# nici succes explicit, nici erori de validare (ex. validator lipsa, jar corupt) = esec tehnic
cat "$W/out.txt" >&2
exit 2
