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
#   CONTAB_ETRANSPORT_XSD   cale locala SAU URL catre schema (.xsd sau .zip). OBLIGATORIU.
#   CONTAB_ETRANSPORT_DIR   cache-ul schemei descarcate (implicit /var/tmp/contab-etransport)
#
# Iesire: 0 = valid, 1 = erori de validare (afisate), 2 = folosire/schema lipsa.
set -eu

XML=${1:?Folosire: valideaza-etransport.sh <fisier.xml>}
[ -f "$XML" ] || { echo "Fisier inexistent: $XML" >&2; exit 2; }

command -v xmllint >/dev/null 2>&1 || { echo "xmllint (libxml2-utils) nu e instalat. Ex: apt-get install libxml2-utils" >&2; exit 2; }

SRC=${CONTAB_ETRANSPORT_XSD:-}
if [ -z "$SRC" ]; then
  cat >&2 <<'MSG'
Lipseste schema oficiala. Seteaza CONTAB_ETRANSPORT_XSD la calea sau URL-ul schemei XSD:
  - descarca „Schema XSD" de pe https://etransport.mfinante.gov.ro/informatii-tehnice
  - apoi:  CONTAB_ETRANSPORT_XSD=/cale/eTransport.xsd scripts/valideaza-etransport.sh fisier.xml
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
