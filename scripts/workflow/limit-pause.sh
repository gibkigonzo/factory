#!/usr/bin/env bash
# Etap z Claude trafił na limit subskrypcji: zamiast blokady zapisuje wstrzymany etap w issue albo PR
# (etykieta factory:paused i znacznik, jak przy /stop) i otwiera issue „Taśma czeka na limit subskrypcji”
# (factory:stopped) z godziną resetu. Kolejny etap z limitem przesuwa tę godzinę, gdy reset jest później.
#
# Wejście w zmiennych: STAGE (plan|implement|review), ISSUE, PR, NOTE, UNTIL (ISO), RUN (adres przebiegu, opcjonalny).
# gh korzysta z GH_TOKEN i GH_REPO. Treści buduje limit-cli.ts (bez zależności z npm).
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
limit() { node "$DIR/limit-cli.ts" "$@"; }

ISSUE=${ISSUE:-} PR=${PR:-} NOTE=${NOTE:-} RUN=${RUN:-}
if ! [[ "${STAGE:-}" =~ ^(plan|implement|review)$ && "$ISSUE" =~ ^[0-9]*$ && "$PR" =~ ^[0-9]*$ &&
        "$NOTE" =~ ^[A-Za-z0-9_-]*$ && "${UNTIL:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$ ]]; then
  echo "::error::Nieoczekiwane wejście zapisu limitu; nic nie zapisuję."
  exit 1
fi
TARGET=${PR:-$ISSUE}
if [ -z "$TARGET" ]; then
  echo "::warning::Limit subskrypcji, ale etap nie ma issue ani PR; nie ma gdzie go zapisać."
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gh label create factory:stopped --force --description 'Taśma fabryki zatrzymana' >/dev/null
gh label create factory:paused --force --description 'Etap czeka na wznowienie taśmy' >/dev/null

# Otwarte issue limitu (z godziną w znaczniku); zatrzymanie przez /stop tu się nie liczy.
gh issue list --label factory:stopped --state open --limit 20 --json number,body > "$TMP/stops.json"
STOP="" CURRENT=""
for N in $(jq -r '.[].number' "$TMP/stops.json"); do
  jq -r --argjson n "$N" '.[] | select(.number == $n) | .body' "$TMP/stops.json" > "$TMP/body.md"
  U=$(limit stop-until --body "$TMP/body.md")
  if [ -n "$U" ]; then STOP=$N CURRENT=$U; break; fi
done
NEW=$(limit later --until "$UNTIL" --current "$CURRENT")

if [ -z "$STOP" ]; then
  limit stop-body --until "$NEW" --stage "$STAGE" --target "$TARGET" > "$TMP/stop.md"
  URL=$(gh issue create --title 'Taśma czeka na limit subskrypcji' --label factory:stopped --body-file "$TMP/stop.md")
  STOP=${URL##*/}
elif [ "$NEW" != "$CURRENT" ]; then
  limit stop-body --until "$NEW" --stage "$STAGE" --target "$TARGET" > "$TMP/stop.md"
  gh issue edit "$STOP" --body-file "$TMP/stop.md" >/dev/null
fi

ARGS=(--until "$NEW" --stage "$STAGE" --issue "$ISSUE" --pr "$PR" --note "$NOTE" --stop "$STOP")
if [ -n "$RUN" ]; then ARGS+=(--run "$RUN"); fi
limit paused-comment "${ARGS[@]}" > "$TMP/paused.md"
gh issue edit "$TARGET" --add-label factory:paused >/dev/null
gh issue comment "$TARGET" --body-file "$TMP/paused.md" >/dev/null
echo "::notice::Limit subskrypcji do $NEW: etap $STAGE (#$TARGET) czeka, taśma wstrzymana (#$STOP)."
