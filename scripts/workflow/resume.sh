#!/usr/bin/env bash
# Wznowienie taśmy: zamyka podane issue zatrzymania (factory:stopped), uruchamia wstrzymane etapy
# (ostatni znacznik factory:paused od konta workflowów w issue albo PR) i kolejkę. Wołają go /start
# i dyrygent, gdy minął czas limitu subskrypcji. Na wyjściu: liczba wznowionych etapów (logi idą do stderr).
#
# Argumenty: numery issue zatrzymania. Zmienne: MESSAGE (komentarz przy zamknięciu), WORKFLOW (plik workflowu
# projektu), QUEUE (false: bez uruchamiania kolejki, bo zdarzenie i tak ją uruchomi), GH_TOKEN, GH_REPO.
set -euo pipefail

DEFAULT=$(gh api "repos/$GH_REPO" --jq .default_branch)
CLOSED=0
for STOP in "$@"; do
  [[ "$STOP" =~ ^[0-9]+$ ]] || continue
  # Inny przebieg mógł już wznowić taśmę; zamknięte issue znaczy, że etapy ruszyły.
  if [ "$(gh issue view "$STOP" --json state --jq .state)" = OPEN ]; then
    gh issue close "$STOP" --comment "$MESSAGE" >/dev/null
    CLOSED=$((CLOSED + 1))
  fi
done
if [ "$#" -gt 0 ] && [ "$CLOSED" -eq 0 ]; then
  echo "::notice::Taśmę wznowił już inny przebieg." >&2
  echo 0
  exit 0
fi

RESUMED=0
for T in $( { gh issue list --label factory:paused --state open --limit 100 --json number --jq '.[].number'
              gh pr list --label factory:paused --state open --limit 100 --json number --jq '.[].number'; } | sort -un); do
  DATA=$(gh api --paginate "repos/$GH_REPO/issues/$T/comments" --jq '.[] | select(.user.login == "github-actions[bot]") | .body' \
    | sed -nE 's#.*<!-- factory:paused (\{[^<>]*\}) -->.*#\1#p' | tail -n 1)
  [ -n "$DATA" ] || DATA='{}'
  S=$(jq -r '.stage // ""' <<<"$DATA"); I=$(jq -r '.issue // ""' <<<"$DATA")
  P=$(jq -r '.pr // ""' <<<"$DATA"); N=$(jq -r '.note // ""' <<<"$DATA")
  gh issue edit "$T" --remove-label factory:paused >/dev/null 2>&1 || true
  if ! [[ "$S" =~ ^(plan|implement|review)$ && "$I" =~ ^[0-9]*$ && "$P" =~ ^[0-9]*$ && "$N" =~ ^[A-Za-z0-9_-]*$ ]]; then
    echo "::warning::#$T: brak poprawnego zapisu wstrzymanego etapu; pomijam." >&2
    continue
  fi
  ARGS=(-f stage="$S")
  if [ -n "$I" ]; then ARGS+=(-f issue="$I"); fi
  if [ -n "$P" ]; then ARGS+=(-f pr="$P"); fi
  if [ -n "$N" ]; then ARGS+=(-f note="$N"); fi
  gh workflow run "$WORKFLOW" --ref "$DEFAULT" "${ARGS[@]}" >&2
  RESUMED=$((RESUMED + 1))
done

if [ "${QUEUE:-true}" != false ]; then
  gh workflow run "$WORKFLOW" --ref "$DEFAULT" -f stage=queue >&2 \
    || echo "::warning::Nie udało się uruchomić kolejki; ruszy przy dziennym przeglądzie." >&2
fi
echo "$RESUMED"
