#!/usr/bin/env bash
# Fabryka w sesji Claude Code: hook startu pobiera z repo fabryki skille i reguły dla sesji, w wersji, którą przypina
# workflow taśmy (factory_ref w .github/workflows/factory.yml). Projekt nie trzyma ich kopii, więc zmiana w fabryce
# dociera do wszystkich projektów przy następnej sesji. Z fabryki nie uruchamia żadnego kodu: kopiuje pliki Markdown.
# Ten plik jest taki sam w każdym projekcie (templates/claude/hooks/factory.sh w fabryce); nie zmieniaj go tutaj.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
REPO=https://github.com/gibkigonzo/factory
REF=$(sed -nE 's/^[[:space:]]*factory_ref:[[:space:]]*([^[:space:]#]+).*/\1/p' .github/workflows/factory.yml 2>/dev/null | head -n 1)
REF=${REF:-main}
SKILLS=.claude/skills
OWN=.claude/factory

# Wznowienie, /clear i kompaktowanie korzystają z kopii pobranej na starcie; pobieramy tylko na starcie albo bez kopii.
SOURCE=$(sed -nE 's/.*"source"[[:space:]]*:[[:space:]]*"([a-z]+)".*/\1/p' | head -n 1)
if [ "${SOURCE:-startup}" = startup ] || [ ! -f "$OWN/version" ]; then
  TMP=$(mktemp -d)
  if GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=20 \
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$TMP/factory" 2>/dev/null; then
    mkdir -p "$SKILLS" "$OWN"
    # Kopie nie trafiają do repo: git pomija je lokalnie (.git/info/exclude), bez zmian w .gitignore projektu.
    EXCLUDE=$(git rev-parse --git-path info/exclude 2>/dev/null || true)
    ignore() { [ -n "$EXCLUDE" ] && mkdir -p "$(dirname "$EXCLUDE")" && { grep -qxF "/$1/" "$EXCLUDE" 2>/dev/null || echo "/$1/" >> "$EXCLUDE"; }; }
    ignore "$OWN"
    while read -r skill; do
      [ -n "$skill" ] && [ -d "$TMP/factory/skills/$skill" ] || continue
      rm -rf "${SKILLS:?}/$skill" && cp -R "$TMP/factory/skills/$skill" "$SKILLS/$skill" && ignore "$SKILLS/$skill"
    done < <(sed 's/#.*//' "$TMP/factory/templates/claude/session-skills.txt" 2>/dev/null || echo spec-writer)
    cp "$TMP/factory/templates/claude/CLAUDE.md" "$OWN/rules.md"
    echo "$REF $(git -C "$TMP/factory" rev-parse --short HEAD)" > "$OWN/version"
    NOTE=""
  else
    NOTE="Uwaga: nie udało się pobrać fabryki ($REPO@$REF); sesja korzysta z kopii z poprzedniego startu, jeśli jest."
  fi
  rm -rf "$TMP"
fi

# Wyjście hooka startu trafia do kontekstu sesji: reguły fabryki zamiast kopii w CLAUDE.md projektu.
if [ -f "$OWN/rules.md" ]; then
  echo "Fabryka oprogramowania ($REPO, wersja $(cat "$OWN/version")): skille fabryki są w $SKILLS, a reguły poniżej."
  [ -n "${NOTE:-}" ] && echo "$NOTE"
  echo
  cat "$OWN/rules.md"
else
  echo "${NOTE:-Brak reguł fabryki.} Skille fabryki są niedostępne; nie zakładaj issue bez spec-writera, zapytaj właściciela."
fi
exit 0
