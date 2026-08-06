#!/usr/bin/env bash
# Rotatie sigura a cheii ANTHROPIC_API_KEY pentru Contab.
# Cheia se introduce la un prompt ASCUNS (nu se afiseaza, nu intra in istoricul shell-ului).
# Testeaza cheia (autentificare + credit) inainte de a scrie .env; pastreaza backup.
set -euo pipefail

ENV="/var/www/contab/.env"
[ -f "$ENV" ] || { echo "Nu gasesc $ENV"; exit 1; }

# 1) citeste cheia in mod silentios
read -rsp "Lipeste NOUA cheie ANTHROPIC (nu se afiseaza), apoi Enter: " NEWKEY; echo
[ -n "${NEWKEY:-}" ] || { echo "Cheie goala — anulat."; exit 1; }
case "$NEWKEY" in
  sk-ant-*) ;;
  *) echo "✗ Cheia nu incepe cu 'sk-ant-' — anulat (nimic modificat)."; exit 1;;
esac

# 2) testeaza cheia la Anthropic (autentificare SI credit in organizatie)
MODEL="$(grep -E '^CONTAB_AI_MODEL=' "$ENV" | cut -d= -f2- || true)"
# Acelasi implicit ca src/aiExtractor.js: proba trebuie sa atinga modelul pe care il va folosi
# aplicatia. Un ping pe alt model (mai ieftin) ar trece si cu o cheie care n-are acces la cel real.
[ -n "$MODEL" ] || MODEL="claude-opus-5"
echo "Testez cheia cu modelul $MODEL ..."
OUT="$(mktemp)"
CODE="$(curl -s -o "$OUT" -w '%{http_code}' https://api.anthropic.com/v1/messages \
  -H "x-api-key: $NEWKEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" || true)"
case "$CODE" in
  200) echo "✓ Cheia autentifica si are credit (HTTP 200)." ;;
  401|403) echo "✗ HTTP $CODE — cheie invalida/neautorizata. NU am modificat .env."; rm -f "$OUT"; exit 1 ;;
  *) echo "⚠ HTTP $CODE de la Anthropic:"; cat "$OUT"; echo
     read -rp "Scriu totusi cheia in .env? [y/N] " YN; [ "${YN:-N}" = "y" ] || { rm -f "$OUT"; echo "Anulat."; exit 1; } ;;
esac
rm -f "$OUT"

# 3) backup + inlocuire linie (format KEY=value, fara ghilimele — ca loaderul din server.js)
cp -a "$ENV" "$ENV.bak.$(date +%Y%m%d%H%M%S)"
TMP="$(mktemp)"
grep -v '^ANTHROPIC_API_KEY=' "$ENV" > "$TMP" || true
printf 'ANTHROPIC_API_KEY=%s\n' "$NEWKEY" >> "$TMP"
mv "$TMP" "$ENV"
chmod 600 "$ENV"
NEWKEY=""  # sterge din mediul scriptului

echo "✓ .env actualizat (backup pastrat in .env.bak.*)."
echo "  Acum, in sesiunea Claude Code, spune-mi 'done' ca sa fac: pm2 restart contab + verificare."
echo "  Apoi REVOCA cheia veche in Anthropic Console."
