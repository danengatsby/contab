#!/bin/sh
# Poarta locala unica de release. Fiecare proba este incadrata de aceeasi verificare de SHA si
# worktree; o comanda care genereaza sau modifica ceva invalideaza imediat certificarea.
set -eu

RADACINA=$(cd "$(dirname "$0")/.." && pwd)
cd "$RADACINA"
SHA=$(git rev-parse HEAD 2>/dev/null) \
  || { echo "BLOCAT: release-ul cere un commit Git identificabil." >&2; exit 2; }

curat() { sh "$RADACINA/scripts/verifica-worktree.sh" "$SHA"; }
pas() {
  echo ""
  echo "── $1 — $SHA"
  shift
  "$@"
  curat
}

curat
pas "suita functionala" npm test
pas "suita marketing" npm run test:marketing
pas "analiza statica" npm run lint
pas "audit dependente" npm audit --audit-level=high
pas "driver productie PostgreSQL" npm run test-pg
pas "DUKIntegrator + XSD oficiale" sh scripts/poarta-fiscala.sh --intotdeauna

echo ""
echo "✓ RELEASE VERIFICAT: toate portile au trecut pe exact SHA $SHA, cu worktree curat."
