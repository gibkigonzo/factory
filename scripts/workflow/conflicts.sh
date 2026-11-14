#!/usr/bin/env bash
# Konflikty otwartych PR fabryki z gałęzią główną. Woła go job kolejki: po zamknięciu PR fabryki i raz dziennie.
# PR z konfliktem dostaje komentarz taśmy („Konflikt z gałęzią główną”) i rundę implementera, która scala gałąź
# główną i rozwiązuje konflikty (sync-base.sh). Najwyżej MAX takich rund na PR; potem jeden komentarz dla
# właściciela. Na wyjściu: liczba uruchomionych rund (logi idą do stderr).
#
# Zmienne: GH_TOKEN, GH_REPO, WORKFLOW (plik workflowu projektu), MAX (domyślnie 2),
# TRIES i WAIT (odczyty stanu PR, gdy GitHub jeszcze go liczy; domyślnie 6 co 10 s).
set -euo pipefail

MAX=${MAX:-2} TRIES=${TRIES:-6} WAIT=${WAIT:-10}
DEFAULT=$(gh api "repos/$GH_REPO" --jq .default_branch)
STARTED=0
for PR in $(gh pr list --state open --base "$DEFAULT" --limit 100 --json number,headRefName \
              --jq '.[] | select(.headRefName | startswith("factory/")) | .number'); do
  # GitHub liczy możliwość scalenia w tle: tuż po zmianie gałęzi głównej stan bywa „unknown”.
  STATE=unknown
  for _ in $(seq "$TRIES"); do
    STATE=$(gh api "repos/$GH_REPO/pulls/$PR" --jq .mergeable_state)
    [ "$STATE" != unknown ] && break
    sleep "$WAIT"
  done
  [ "$STATE" = dirty ] || continue
  HEAD=$(gh pr view "$PR" --json headRefName --jq .headRefName)
  ISSUE=$(sed -nE 's#^factory/([0-9]+)-.*#\1#p' <<<"$HEAD")
  [ -n "$ISSUE" ] || continue
  # Etap tego PR w toku (runda poprawek albo recenzja): konflikt sprawdzi następny przegląd.
  if gh run list --workflow "$WORKFLOW" --limit 50 --json status,displayTitle \
       --jq '.[] | select(.status != "completed") | .displayTitle' | grep -qE "PR #$PR\$"; then
    echo "::notice::PR #$PR ma konflikt, ale jego etap jest w toku; sprawdzi go następny przegląd." >&2
    continue
  fi
  COMMENTS=$(gh api --paginate "repos/$GH_REPO/issues/$PR/comments" \
    --jq '.[] | select(.user.login == "github-actions[bot]") | .body | split("\n")[0]')
  DONE=$(grep -cxF '<!-- factory:conflict -->' <<<"$COMMENTS" || true)
  if [ "$DONE" -ge "$MAX" ]; then
    if ! grep -qxF '<!-- factory:conflict-stop -->' <<<"$COMMENTS"; then
      printf '%s\n' '<!-- factory:conflict-stop -->' \
        "PR dalej ma konflikt z gałęzią główną po $DONE rundach taśmy. Rozwiąż go albo napisz \`/change\` z poleceniem, jak go rozwiązać." \
        | gh pr comment "$PR" --body-file - >/dev/null
    fi
    continue
  fi
  URL=$(printf '%s\n' '<!-- factory:conflict -->' '## Konflikt z gałęzią główną' '' \
    "Gałąź główna zmieniła się i ten PR ma z nią konflikt. Taśma scala gałąź główną, a implementer rozwiązuje konflikty (runda $((DONE + 1)) z $MAX). Potem CI i recenzja ruszają od nowa." \
    | gh pr comment "$PR" --body-file -)
  NOTE=${URL##*issuecomment-}
  if ! [[ "$NOTE" =~ ^[0-9]+$ ]]; then
    echo "::warning::PR #$PR: nie znam numeru komentarza o konflikcie; runda nie rusza." >&2
    continue
  fi
  gh workflow run "$WORKFLOW" --ref "$DEFAULT" -f stage=implement -f issue="$ISSUE" -f pr="$PR" -f note="$NOTE" >&2
  STARTED=$((STARTED + 1))
done
echo "$STARTED"
