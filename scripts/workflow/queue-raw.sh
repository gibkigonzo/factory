#!/usr/bin/env bash
# Dane kolejki zadań dla `cli.ts queue-admit` i `queue-release`: otwarte issue z etykietą planned,
# PR-y (wszystkie stany i otwarte z plikami) oraz komentarze z planem. Wymaga GH_TOKEN i GH_REPO.
# Użycie: queue-raw.sh <katalog>
set -euo pipefail
RAW=$1
mkdir -p "$RAW/comments"
gh issue list --label planned --state open --limit 200 --json number,labels > "$RAW/issues.json"
gh pr list --state all --limit 500 --json number,state,headRefName,isCrossRepository > "$RAW/prs.json"
gh pr list --state open --limit 100 --json number,state,headRefName,isCrossRepository,files > "$RAW/open.json"
for ISSUE in $(jq -r '.[].number' "$RAW/issues.json"); do
  gh api --paginate "repos/$GH_REPO/issues/$ISSUE/comments" \
    --jq '[.[] | select(.user.login == "github-actions[bot]" and (.body | contains("<!-- factory:plan -->")))
           | {body, user: {login: .user.login}}]' \
    | jq -s add > "$RAW/comments/$ISSUE.json"
done
