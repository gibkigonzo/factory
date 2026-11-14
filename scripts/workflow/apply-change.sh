#!/usr/bin/env bash
# Job zapisu: odtwarza scalenie gałęzi głównej z rundy poprawek (ten sam SHA, ten sam wynik, także ze znacznikami
# konfliktu) i nakłada patch implementera, liczony od tego wyniku. Commit robi workflow: przy scaleniu powstaje
# commit scalenia z dwoma rodzicami, bez pośredniego commita ze znacznikami konfliktu.
#
# Argumenty: ścieżka patcha (pusta: implementer nic nie zmienił), SHA scalonej gałęzi głównej (pusty: bez scalenia).
set -euo pipefail

PATCH=${1:-}
SHA=${2:-}
if [ -n "$SHA" ]; then
  # Konflikt jest tu oczekiwany: rozwiązanie jest w patchu.
  git merge --no-commit --no-ff "$SHA" >/dev/null 2>&1 || true
  if ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    echo "::error::Nie udało się odtworzyć scalenia gałęzi głównej ($SHA)." >&2
    exit 1
  fi
  git add -A
fi
if [ -n "$PATCH" ]; then
  git apply --index "$PATCH"
fi
