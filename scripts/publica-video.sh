#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  PUBLICA VIDEOUL DE PREZENTARE — il muta din marketing/video/ in public/descarcari/,
#  de unde aplicatia il serveste STATIC, si scrie manifestul citit de interfata.
#
#  ATENTIE, e o PUBLICARE: tot ce ajunge in public/ e servit imediat pe internet, fara
#  autentificare. Se ruleaza doar cand videoul e gata de aratat oricui.
#
#  Rulare:  npm run publica-video [cale-mp4] [durata]
#    implicit: marketing/video/contabo-prezentare-720p.mp4, durata "3:12"
#  Videoul se produce cu scripts/video-prezentare.mjs (reteta e in antetul lui).
#
#  Manifestul (public/descarcari/video.json) e semnalul de existenta, ca la pachetul Windows:
#  fara el, pagina din Setari NU arata un player mort, ci spune de ce lipseste.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RADACINA=$(cd "$(dirname "$0")/.." && pwd)
SURSA=${1:-"$RADACINA/marketing/video/contabo-prezentare-720p.mp4"}
DURATA=${2:-"3:12"}
POSTER_SURSA="$(dirname "$SURSA")/poster.jpg"
IESIRE="$RADACINA/public/descarcari"

[ -f "$SURSA" ] || { echo "Nu gasesc videoul: $SURSA"; echo "Il produci cu scripts/video-prezentare.mjs (vezi antetul)."; exit 1; }

mkdir -p "$IESIRE"
cp "$SURSA" "$IESIRE/contabo-prezentare.mp4"
chmod 644 "$IESIRE/contabo-prezentare.mp4"
if [ -f "$POSTER_SURSA" ]; then cp "$POSTER_SURSA" "$IESIRE/contabo-prezentare.jpg"; chmod 644 "$IESIRE/contabo-prezentare.jpg"; fi

OCTETI=$(stat -c%s "$IESIRE/contabo-prezentare.mp4")
AMPRENTA=$(sha256sum "$IESIRE/contabo-prezentare.mp4" | cut -d' ' -f1)
DATA=$(date +%Y-%m-%d)
cat > "$IESIRE/video.json" <<JSON
{
  "fisier": "/descarcari/contabo-prezentare.mp4",
  "poster": "/descarcari/contabo-prezentare.jpg",
  "durata": "$DURATA",
  "rezolutie": "1280x720",
  "octeti": $OCTETI,
  "sha256": "$AMPRENTA",
  "data": "$DATA"
}
JSON
chmod 644 "$IESIRE/video.json"

echo "── Publicat: $(du -h "$IESIRE/contabo-prezentare.mp4" | cut -f1), durata $DURATA"
echo "   https://contabo.space/descarcari/contabo-prezentare.mp4"
