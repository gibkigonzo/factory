#!/usr/bin/env bash
# Kontrakt projektu z gałęzi bazowej, nie z PR: factory.yml i, gdy jest, katalog .factory/perspectives.
# Nie zależy od kodu wyjścia tar: tar na macOS przyjmuje puste wejście bez błędu, więc `git archive … | tar`
# z zapasowym `|| git show` zostawiał projekt bez factory.yml, gdy brakowało katalogu perspektyw.
# Użycie: base-config.sh <gałąź bazowa> <katalog wyjściowy>
set -euo pipefail
BASE=$1
OUT=$2
mkdir -p "$OUT"
git show "origin/$BASE:factory.yml" > "$OUT/factory.yml"
if git cat-file -e "origin/$BASE:.factory/perspectives" 2>/dev/null; then
  git archive "origin/$BASE" .factory/perspectives | tar -x -C "$OUT"
fi
