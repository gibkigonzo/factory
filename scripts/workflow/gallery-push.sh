#!/usr/bin/env bash
# Publikuje zrzuty PR na gałęzi z obrazami (domyślnie factory-screenshots), z której czyta je komentarz w PR.
# Gałąź ma zawsze jeden commit bez historii z katalogami pr-<numer>/<sha>/ otwartych PR, więc nie rośnie:
# stare zrzuty tego PR i zrzuty zamkniętych PR znikają przy każdej publikacji. Równoległe publikacje się nie
# nadpisują: push z --force-with-lease, a po odrzuceniu ponowna próba na świeżym stanie gałęzi.
# Użycie: gallery-push.sh <remote> <katalog ze zrzutami> <numer PR> <sha> "<numery otwartych PR po spacji>"
# Poświadczenia dla remote podaje wywołujący (np. GIT_CONFIG_* z nagłówkiem autoryzacji).
set -euo pipefail
REMOTE=$1 SHOTS=$2 PR=$3 SHA=$4 OPEN=" $5 "
BRANCH=${GALLERY_BRANCH:-factory-screenshots}
[[ "$PR" =~ ^[0-9]+$ && "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Zły numer PR albo sha: $PR $SHA" >&2; exit 2; }

REPO=$(mktemp -d)
cd "$REPO"
git init -q
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

for attempt in 1 2 3; do
  git checkout -q --orphan "publish-$attempt"
  git rm -rqf --cached --ignore-unmatch .
  git clean -fdxq
  OLD=
  if git fetch -q --depth 1 "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null; then
    OLD=$(git rev-parse FETCH_HEAD)
    git checkout -q FETCH_HEAD -- .
  fi
  for dir in pr-*; do
    [ -d "$dir" ] || continue
    number=${dir#pr-}
    if [ "$number" = "$PR" ] || [[ "$OPEN" != *" $number "* ]]; then git rm -rqf "$dir" && rm -rf "$dir"; fi
  done
  # Tylko zwykłe pliki PNG z katalogu sprawdzonego wcześniej przez cli.ts gallery.
  mkdir -p "pr-$PR/$SHA"
  find "$SHOTS" -maxdepth 1 -type f -name '*.png' -exec cp {} "pr-$PR/$SHA/" \;
  git add -A
  git commit -qm "Zrzuty ekranu PR #$PR ($SHA)" --allow-empty
  if git push -q --force-with-lease="refs/heads/$BRANCH:$OLD" "$REMOTE" "HEAD:refs/heads/$BRANCH"; then
    echo "Zrzuty PR #$PR na gałęzi $BRANCH"
    exit 0
  fi
  sleep $((attempt * 5))
done
echo "::error::Nie udało się opublikować zrzutów na gałęzi $BRANCH." >&2
exit 1
