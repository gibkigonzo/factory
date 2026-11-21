#!/usr/bin/env bash
# Dane kolejki zadań dla `cli.ts queue-gate`, `queue-admit` i `queue-release`: otwarte issue z etykietami i treścią
# (sekcja „Zależy od” specu), PR-y (wszystkie stany i otwarte z plikami), zamknięte issue, od których zależą otwarte,
# oraz komentarze z planem. Wymaga GH_TOKEN i GH_REPO.
# Użycie: queue-raw.sh <katalog>
set -euo pipefail
RAW=$1
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$RAW/comments"
gh issue list --state open --limit 300 --json number,labels,body > "$RAW/issues.json"
gh pr list --state all --limit 500 --json number,state,headRefName,isCrossRepository > "$RAW/prs.json"
gh pr list --state open --limit 100 --json number,state,headRefName,isCrossRepository,files > "$RAW/open.json"
# Zależność spoza otwartych: zamknięta (jako zrobiona albo nie) albo nieistniejąca; tej ostatniej nie zapisujemy.
for DEP in $(node "$HERE/cli.ts" queue-deps --raw "$RAW"); do
  gh api "repos/$GH_REPO/issues/$DEP" --jq '{number, state, state_reason}' 2>/dev/null || true
done | jq -s . > "$RAW/closed.json"
for ISSUE in $(jq -r '.[] | select(any(.labels[]; .name == "planned")) | .number' "$RAW/issues.json"); do
  gh api --paginate "repos/$GH_REPO/issues/$ISSUE/comments" \
    --jq '[.[] | select(.user.login == "github-actions[bot]" and (.body | contains("<!-- factory:plan -->")))
           | {body, user: {login: .user.login}}]' \
    | jq -s add > "$RAW/comments/$ISSUE.json"
done
