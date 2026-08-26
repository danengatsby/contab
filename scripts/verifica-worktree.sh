#!/bin/sh
# Dovedeste ca operatia ruleaza pe exact commitul cerut si ca niciun pas n-a modificat sursa.
# Folosire: scripts/verifica-worktree.sh [sha-asteptat]
set -eu

RADACINA=$(cd "$(dirname "$0")/.." && pwd)
cd "$RADACINA"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "BLOCAT: directorul nu este un depozit Git verificabil." >&2; exit 2; }

ACTUAL=$(git rev-parse HEAD)
ASTEPTAT=${1:-${GITHUB_SHA:-$ACTUAL}}
ASTEPTAT_COMPLET=$(git rev-parse "$ASTEPTAT" 2>/dev/null) \
  || { echo "BLOCAT: SHA asteptat inexistent: $ASTEPTAT" >&2; exit 2; }
[ "$ACTUAL" = "$ASTEPTAT_COMPLET" ] \
  || { echo "BLOCAT: ruleaza $ACTUAL, dar poarta cere $ASTEPTAT_COMPLET." >&2; exit 1; }

MURDAR=$(git status --porcelain=v1 --untracked-files=all)
if [ -n "$MURDAR" ]; then
  NUMAR=$(printf '%s\n' "$MURDAR" | wc -l | tr -d ' ')
  echo "BLOCAT: worktree murdar la $ACTUAL ($NUMAR intrari):" >&2
  printf '%s\n' "$MURDAR" | sed -n '1,30p' >&2
  [ "$NUMAR" -gt 30 ] && echo "  ... si inca $((NUMAR - 30))" >&2
  exit 1
fi

echo "✓ SHA $ACTUAL, worktree curat."
