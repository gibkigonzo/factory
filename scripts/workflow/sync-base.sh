#!/usr/bin/env bash
# Runda poprawek zaczyna od scalenia gałęzi głównej z gałęzią PR (job implementera, bez zapisu do repo).
# Bez konfliktu scala skrypt; pliki z konfliktem (lista w <katalog>/conflicts.txt) rozwiązuje implementer.
# Wynik scalenia, także ze znacznikami konfliktu, trafia do indeksu, a jego drzewo (baseline) jest punktem,
# od którego liczy się patch implementera. Zmiany z gałęzi głównej nie trafiają więc do sprawdzenia ścieżek.
# Job zapisu odtwarza to samo scalenie tym samym SHA (apply-change.sh), więc patch pasuje.
#
# Argumenty: ref gałęzi głównej (np. origin/main), katalog roboczy taśmy. Wyjście (do $GITHUB_OUTPUT):
# merged=none|clean|conflict, baseline=<drzewo>, sha=<scalony commit, pusty przy none>.
set -euo pipefail

REF=$1
OUT=$2
SHA=$(git rev-parse --verify "$REF^{commit}")
: > "$OUT/conflicts.txt"
if git merge-base --is-ancestor "$SHA" HEAD; then
  echo "merged=none"
  echo "baseline=$(git rev-parse 'HEAD^{tree}')"
  echo "sha="
  exit 0
fi
STATE=clean
if ! git -c user.name=factory -c user.email=factory@invalid merge --no-commit --no-ff "$SHA" >/dev/null 2>&1; then
  git diff --name-only --diff-filter=U > "$OUT/conflicts.txt"
  if [ ! -s "$OUT/conflicts.txt" ]; then
    echo "::error::Scalenie gałęzi głównej nie powiodło się, choć nie ma konfliktów w plikach." >&2
    exit 1
  fi
  STATE=conflict
fi
git add -A
echo "merged=$STATE"
echo "baseline=$(git write-tree)"
echo "sha=$SHA"
