# Factory — instrukcje dla Claude

Factory to generyczna fabryka oprogramowania oparta na Claude Code, dla stron WWW i gier w Godot. Opis dla ludzi jest w [README.md](README.md).

## Źródło prawdy

- Źródłem prawdy jest prywatny dokument projektowy właściciela w Claude Docs. Link jest w `CLAUDE.local.md`, który nie trafia do repo. Czytaj dokument narzędziami docs, nie przez WebFetch.
- Gdy repo i dokument się rozjeżdżają, zapytaj użytkownika, które jest aktualne. Dokumentu nie zmieniaj bez jego zgody.

## Prywatność (repo jest publiczne)

- Nie umieszczaj w repo linków do prywatnych dokumentów, rozmów ani artefaktów Claude.
- Nie podawaj nazw, ścieżek ani szczegółów prywatnych projektów właściciela. Pisz generycznie, jakiego typu jest projekt, np. „aplikacja webowa z danymi użytkownika” albo „gra w Godot”.
- Dotyczy to też commitów, issue, PR i komentarzy.

## Zasady pracy

- Z użytkownikiem rozmawiaj po polsku.
- Commit, push i wszystko, co publiczne (repo, issue, PR), rób dopiero po zgodzie użytkownika.
- Prawie każda zmiana w tym repo należy do strefy bramek fabryki, czyli jest High. W repo Factory nic nie scala się samo.
- Fabryka nie zmienia własnych zabezpieczeń: workflowów, uprawnień, hooków ani konfiguracji. Każdą taką zmianę zatwierdza człowiek.
- O merge'u decyduje deterministyczny skrypt (check `factory/risk`), nigdy model. Zasady nie pilnuje posłuszeństwo modelu, tylko GitHub: ruleset na `main` bez wyjątków wymaga zielonego `factory/risk` od GitHub App fabryki. Bez niego nikt nie scali PR, także konto właściciela i model z jego tokenem.
- Nie scalaj PR-ów, także przez `merge_pull_request` z konektora GitHub, nawet jeśli masz do tego uprawnienia.
- Wszystkie progi to wartości startowe do kalibracji w trybie cienia.
- Prywatne projekty właściciela służą tylko jako materiał do analizy. Niczego w nich nie zmieniaj; szczegóły są w `CLAUDE.local.md`.
- `factory-init`: w dokumencie jest tylko idea. Przebieg sesji ustalamy razem z użytkownikiem. Nie projektuj go sam.

## Ustalenia

### Reguły ryzyka v1 (5 listopada 2026)

Poziom zmiany to najwyższy wynik z pięciu reguł: strefy, zachowanie i odwracalność (LLM, tylko w górę), brak testów (+1 poziom), rozmiar, dowody. Progi są w README. Ścieżka spoza mapy stref dostaje Medium.

### Dystrybucja

- Repo jest marketplace'em pluginu (`.claude-plugin/marketplace.json`, plugin `factory` ze źródłem `./`). Projekty instalują go przez wejścia `plugin_marketplaces` i `plugins` w `claude-code-action`.
- Wspólne workflowy to `workflow_call`, wywoływane jako `gibkigonzo/factory/.github/workflows/<name>.yml@v1`.
- Presety projekt dołącza przez `extends`, a wersje przypina tagami.

### Godot w CI

- Godot działa na runnerze GitHub z Ubuntu. Workflow instaluje przypiętą wersję edytora i szablony eksportu, zanim uruchomi `claude-code-action` z `--allowedTools "Bash(godot:*)"`.
- `--headless` nie renderuje obrazu. Zrzuty ekranu wymagają `xvfb-run` z rendererem `opengl3`.

### Praca z telefonu

- Wymaganie: każdy krok użytkownika (akceptacja propozycji, rozmowa o specu, decyzja przy High, playtest) musi dać się zrobić z telefonu, bez komputera.
- Taśma działa na GitHub Actions, więc komputer nie jest potrzebny. Komendy `/approve`, `/veto` i inne działają z aplikacji GitHub Mobile.
- Do zakładania issue z aplikacji Claude służy oficjalny serwer MCP GitHuba podłączony jako konektor claude.ai. Konektory claude.ai działają też w aplikacji mobilnej. Założenie issue z telefonu trzeba jeszcze sprawdzić.

## Otwarte pytania

- Czy konektor GitHub w aplikacji Claude na telefonie zakłada issue? Plan B: sesja Claude Code w chmurze z aplikacji mobilnej.
- Czy routines Claude Code reagują na zdarzenia issues i jakie mają limity?
- Na którym projekcie pilotujemy pierwszą wersję: stronie WWW czy aplikacji webowej z danymi użytkownika? Godot włączamy jako drugi projekt.
- Gdzie trafia digest: zbiorcze issue, e-mail czy powiadomienie push?
- Licencja publicznego repo.
