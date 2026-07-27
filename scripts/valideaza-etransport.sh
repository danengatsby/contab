#!/bin/sh
# Validare RO e-Transport fata de XSD-ul OFICIAL ANAF/MF, cu xmllint (validare XSD = operatie
# LOCALA, offline — NU cere apeluri live la ANAF). Complementar pre-validarii rapide din
# src/etransport.js (`validate`), la fel cum valideaza-duk.sh completeaza src/validate.js.
#
#   scripts/valideaza-etransport.sh <fisier.xml>
#
# Schema OFICIALA e versionata si publicata pe pagina tehnica; ANAF o actualizeaza periodic, deci
# NU e livrata in repo (s-ar invechi). O indici o singura data prin CONTAB_ETRANSPORT_XSD:
#   - cale locala catre .xsd:   CONTAB_ETRANSPORT_XSD=/cale/eTransport.xsd scripts/valideaza-etransport.sh f.xml
#   - URL direct catre .xsd/.zip (se descarca+cache-uieste):  CONTAB_ETRANSPORT_XSD=https://.../schema.xsd ...
# Schema curenta se ia de pe: https://etransport.mfinante.gov.ro/informatii-tehnice
# (sectiunea „Schema XSD"). Descarc-o din browser daca reteaua serverului nu ajunge la acel host.
#
# Ordinea de cautare a schemei:
#   1. CONTAB_ETRANSPORT_XSD      cale locala SAU URL (.xsd/.zip) — pentru probe punctuale
#   2. schemas/eTransport/*.xsd   VERSIONATA IN REPO — merge peste tot (local, CI, orice clona)
#   3. CONTAB_ETRANSPORT_SCHEMA_DIR (implicit /var/lib/contab/schemas) — depozitul de pe server
#   ...altfel iesire 2 = NEVERIFICAT. /var/tmp NU e depozit: systemd-tmpfiles il curata la 30 zile.
#   CONTAB_ETRANSPORT_DIR   cache-ul schemei DESCARCATE de la un URL (implicit /var/tmp/contab-etransport)
#
# Iesire: 0 = valid, 1 = erori de validare (afisate), 2 = folosire/schema lipsa.
set -eu

XML=${1:?Folosire: valideaza-etransport.sh <fisier.xml>}
[ -f "$XML" ] || { echo "Fisier inexistent: $XML" >&2; exit 2; }

command -v xmllint >/dev/null 2>&1 || { echo "xmllint (libxml2-utils) nu e instalat. Ex: apt-get install libxml2-utils" >&2; exit 2; }

SRC=${CONTAB_ETRANSPORT_XSD:-}
# Fara indicatie explicita: schema VERSIONATA din repo, apoi depozitul de pe server. Asa poarta
# merge in orice clona, fara nicio variabila de mediu — dar ramane onesta: daca nu gaseste nicio
# schema, iese 2 („nu s-a putut verifica"), nu 0.
REPO_SCHEME=$(dirname "$0")/../schemas/eTransport
SCHEME=${CONTAB_ETRANSPORT_SCHEMA_DIR:-/var/lib/contab/schemas}
for dir in "$REPO_SCHEME" "$SCHEME"; do
  [ -n "$SRC" ] && break
  [ -d "$dir" ] || continue
  SRC=$(ls -1t "$dir"/*.xsd 2>/dev/null | head -1 || true)
  [ -n "$SRC" ] && echo "Schema: $SRC" >&2
done
if [ -z "$SRC" ]; then
  cat >&2 <<MSG
Lipseste schema oficiala e-Transport. Locuri cautate:
  - $REPO_SCHEME  (versionata in repo — locul normal; vezi README-ul de acolo)
  - $SCHEME  (depozitul de pe server)
Sau indica-o direct: CONTAB_ETRANSPORT_XSD=/cale/eTransport.xsd (accepta si un URL .xsd/.zip).
Schema se ia din sectiunea „Schema XSD" de pe https://etransport.mfinante.gov.ro/informatii-tehnice
MSG
  exit 2
fi

DIR=${CONTAB_ETRANSPORT_DIR:-/var/tmp/contab-etransport}
mkdir -p "$DIR"

resolve_xsd() {
  case "$1" in
    http://*|https://*)
      # URL: descarca (o singura data) si, daca e zip, dezarhiveaza
      base=$(basename "$1" | sed 's/[?#].*$//')
      dst="$DIR/$base"
      if [ ! -f "$dst" ]; then
        echo "Descarc schema: $1" >&2
        curl -fsSL --max-time 120 -A "Mozilla/5.0" -o "$dst" "$1" || { echo "Descarcare esuata: $1" >&2; exit 2; }
      fi
      case "$base" in
        *.zip)
          ex="$DIR/extras"; mkdir -p "$ex"; (cd "$ex" && unzip -qo "$dst")
          # alege XSD-ul radacina (cel care declara elementul eTransport), altfel primul .xsd
          root=$(grep -rlE 'name="eTransport"|:eTransport:' "$ex" 2>/dev/null | grep -i '\.xsd$' | head -1)
          [ -n "$root" ] || root=$(find "$ex" -iname '*.xsd' | head -1)
          [ -n "$root" ] || { echo "Arhiva nu contine .xsd" >&2; exit 2; }
          echo "$root" ;;
        *) echo "$dst" ;;
      esac ;;
    *)
      [ -f "$1" ] || { echo "Schema inexistenta: $1" >&2; exit 2; }
      echo "$1" ;;
  esac
}

XSD=$(resolve_xsd "$SRC")
echo "Validez $XML fata de $XSD" >&2
if xmllint --noout --schema "$XSD" "$XML"; then
  echo "✓ VALID fata de schema XSD ($XSD)."
  exit 0
else
  echo "✗ Erori de validare (vezi mai sus)." >&2
  exit 1
fi
