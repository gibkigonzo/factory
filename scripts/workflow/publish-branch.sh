#!/usr/bin/env bash
# Publikuje pliki z katalogu na gałęzi z jednym commitem bez historii, np. statystyki dziennika na factory-journal.
# Treść za każdym razem powstaje od nowa, więc stara wersja znika, a gałąź nie rośnie. Push z --force-with-lease:
# gdy w międzyczasie ktoś zmienił gałąź, skrypt próbuje jeszcze raz na świeżym stanie.
# Użycie: publish-branch.sh <remote> <katalog> <gałąź factory-…> <opis commita>
# Publikuje tylko pliki .csv, .json i .md z katalogu (bez podkatalogów). Poświadczenia podaje wywołujący.
set -euo pipefail
REMOTE=$1 BRANCH=$3 MESSAGE=$4
[[ "$BRANCH" =~ ^factory-[a-z-]+$ ]] || { echo "Gałąź spoza factory-*: $BRANCH" >&2; exit 2; }
# Ścieżka bezwzględna, bo skrypt pracuje w katalogu tymczasowym (workflow podaje np. „journal”).
SRC=$(cd "$2" && pwd)

REPO=$(mktemp -d)
cd "$REPO"
git init -q
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
find "$SRC" -maxdepth 1 -type f \( -name '*.csv' -o -name '*.json' -o -name '*.md' \) -exec cp {} . \;
git add -A
git commit -qm "$MESSAGE"

for attempt in 1 2 3; do
  OLD=$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | cut -f1)
  if git push -q --force-with-lease="refs/heads/$BRANCH:$OLD" "$REMOTE" "HEAD:refs/heads/$BRANCH"; then
    echo "Opublikowano na gałęzi $BRANCH"
    exit 0
  fi
  sleep $((attempt * 5))
done
echo "::error::Nie udało się opublikować na gałęzi $BRANCH." >&2
exit 1
