#!/bin/bash
# Launcher unic pentru E2E live: foloseste browserul Playwright local daca exista, iar pe serverele
# fara bibliotecile/browserul Chromium cade automat pe containerul oficial. Pana acum instructiunea
# Docker exista doar intr-un comentariu, in timp ce `npm run e2e` esua direct cu „Executable doesn't
# exist” — exact comanda standard a proiectului era cea care nu functiona in mediul de productie.
set -euo pipefail

RADACINA=$(cd "$(dirname "$0")/.." && pwd)
URL=${BASE_URL:-https://contabo.space}
IMAGINE=${E2E_IMAGE:-mcr.microsoft.com/playwright:v1.58.2-noble}

if node -e "const fs=require('fs'); const {chromium}=require('playwright'); process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1)" 2>/dev/null; then
  BASE_URL="$URL" exec node "$RADACINA/scripts/e2e.mjs"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "E2E nu poate porni: browserul Playwright local lipsește și Docker nu este disponibil." >&2
  echo "Instalează browserul cu «npx playwright install chromium» sau pornește Docker." >&2
  exit 2
fi

echo "[e2e] browser local absent — folosesc containerul Playwright $IMAGINE"
exec docker run --rm \
  -v "$RADACINA/scripts/e2e.mjs:/w/e2e.mjs:ro" \
  -e BASE_URL="$URL" -w /w "$IMAGINE" \
  sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node e2e.mjs"
