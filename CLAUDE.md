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
- Prywatne projekty właściciela wymienione w `CLAUDE.local.md` służą tylko jako materiał do analizy. Niczego w nich nie zmieniaj. Zakaz nie dotyczy repo testowego fabryki (piaskownicy) ani projektów, które właściciel podłączył do taśmy, np. pilota: w nich fabryka i Claude zakładają i zmieniają issue oraz PR-y.
- `factory-init`: kierunek jest w Ustaleniach niżej. Szczegóły przebiegu sesji ustalamy razem z użytkownikiem. Nie projektuj ich sam.

## Ustalenia

### Reguły ryzyka v1 (5 listopada 2026)

Poziom zmiany to najwyższy wynik z pięciu reguł: strefy, zachowanie i odwracalność (LLM, tylko w górę), brak testów (+1 poziom), rozmiar, dowody. Progi są w README. Ścieżka spoza mapy stref dostaje Medium.

### Dystrybucja

- Repo jest marketplace'em pluginu (`.claude-plugin/marketplace.json`, plugin `factory` ze źródłem `./`). Projekty instalują go przez wejścia `plugin_marketplaces` i `plugins` w `claude-code-action`.
- Wspólne workflowy to `workflow_call`, wywoływane jako `gibkigonzo/factory/.github/workflows/<name>.yml@v1`. W Etapie 0 projekty używają `@main`; tag `v1` powstanie po Etapie 0.
- Presety projekt dołącza przez `extends`, a wersje przypina tagami.

### Godot w CI

- Godot działa na runnerze GitHub z Ubuntu. Workflow instaluje przypiętą wersję edytora i szablony eksportu, zanim uruchomi `claude-code-action` z `--allowedTools "Bash(godot:*)"`.
- `--headless` nie renderuje obrazu. Zrzuty ekranu wymagają `xvfb-run` z rendererem `opengl3`.

### Praca z telefonu

- Wymaganie: każdy krok użytkownika (akceptacja propozycji, rozmowa o specu, decyzja przy High, playtest) musi dać się zrobić z telefonu, bez komputera.
- Taśma działa na GitHub Actions, więc komputer nie jest potrzebny. Komendy `/approve`, `/veto` i inne działają z aplikacji GitHub Mobile.
- Do zakładania issue z aplikacji Claude służy oficjalny serwer MCP GitHuba podłączony jako konektor claude.ai. Zwykły czat w aplikacji mobilnej zakłada issue (sprawdzone w #3), więc `spec-writer` może działać w zwykłym czacie.
- Konektor łączy się przez inną aplikację GitHub niż Claude Code. Ta aplikacja musi mieć repo w swojej instalacji, inaczej zapis kończy się 403 `Resource not accessible by integration`.

### Kontrakt projektu (6 listopada 2026)

- Warstwy składają się w kolejności `base` → presety z `extends` → `factory.yml`. Listy się sumują, pojedyncze wartości nadpisuje późniejsza warstwa.
- Projekt nie zmienia progów z `base` (rozmiar, poziomy stref, pewność recenzentów, bramki jakości). Może dodać wyjątek od bramki jakości dla ścieżki, zawsze z powodem.
- „Koszt” to dzienny limit uruchomień taśmy (`daily_runs`).
- Schemat jest w `scripts/config/spec.ts`, opis pól w README.

### Perspektywy i modele (7 listopada 2026)

- Pięć perspektyw z `base` ocenia każdy PR. Dodatkowe projekt włącza w `reviewers.extra`, gdy ich potrzebuje: z katalogu fabryki albo własne w `.factory/perspectives/<nazwa>.md`.
- Dodatkowa perspektywa z `paths` albo `zones` ocenia tylko zmiany, których dotyczy. Skład panelu i reguły ryzyka liczą to tym samym kodem.
- Najpierw tanie strażniki deterministyczne w CI (rozmiar paczki, Lighthouse, axe), a recenzent LLM dopiero wtedy, gdy projekt go potrzebuje.
- Sekcja `models` w `factory.yml` ustawia model na każdym etapie; wartości startowe są w `base`.

### Taśma w GitHub Actions (7 listopada 2026)

- Claude działa w jobach tylko z prawem odczytu i zwraca JSON albo patch. Zapisy (komentarze, etykiety, gałąź, PR, check) robią osobne joby bez Claude.
- Etapy łączy `workflow_dispatch`; w Etapie 0 zmiany podpisuje `github-actions[bot]`, własna aplikacja GitHub fabryki przychodzi w Etapie 1.
- Taśma zostaje na GitHubie. `runs-on` jest ustawieniem: VPS właściciela podłączymy później jako self-hosted runner, tylko dla repo prywatnych.
- Repo testowe jest prywatne. Ruleset na `main` w repo prywatnym wymaga GitHub Pro; decyzja przed Etapem 1.

### Tryb cienia (7 listopada 2026)

- Po każdej ocenie ryzyka `merge.yml` dodaje w PR nowy komentarz z werdyktem mergera, a właściciel ocenia go 👍 albo 👎. Decyzję liczy `scripts/shadow/decision.ts`; ten sam kod zdecyduje o merge'u w Etapie 1.
- Dziennik to przypięte issue „Tryb cienia”. Odświeża się po werdykcie, po zamknięciu PR fabryki i raz dziennie, bo reakcje nie uruchamiają workflowów.
- Kalibracja progu pewności porównuje odsetek przyjętych PR w grupach pewności, a nie zgodność z werdyktem, bo werdykt sam zależy od pewności.
- Progi Bramki 1 są w sekcji `shadow` w `base`.

### Spec z telefonu (7 listopada 2026)

- Spec powstaje w sesji Claude Code na repo projektu (z telefonu: zakładka Code). Sesje w chmurze nie instalują pluginów z `.claude/settings.json`, więc projekt trzyma kopię skilla w `.claude/skills/spec-writer/` i regułę z `templates/claude/CLAUDE.md` w swoim `CLAUDE.md`. Bez reguły sesja od razu implementuje.
- Wgranie ZIP-a (`npm run skill:zip`) do zwykłego czatu aplikacji Claude to opcja; tam skille są przypisane do konta i fabryka ich nie wgra.
- Sekcje specu są w `SPEC_SECTIONS`; test pilnuje szablonu, przykładu i planera.
- Issue zakłada konto właściciela (konektor i sesja Claude Code), więc strażnik taśmy je przepuszcza.

### Koszt (7 listopada 2026)

- Każdy etap z Claude zapisuje zużycie (równowartość cen API, tury, tokeny) z pliku przebiegu `claude-code-action`; dziennik pokazuje koszt na PR i na etap.
- Agenci piszą zwięźle: podsumowanie werdyktu najwyżej 2 zdania, najwyżej 5 uwag po jednym zdaniu, plan i opis PR bez powtarzania specu. Teksty dla właściciela zostają po polsku.
- O angielskich instrukcjach (skille, perspektywy, protokół) decydujemy po 5–10 PR pilota, na podstawie pomiaru.

### Logowanie i pilot (6 listopada 2026)

- `claude-code-action` loguje się przez subskrypcję: sekret `CLAUDE_CODE_OAUTH_TOKEN`, który dodaje właściciel.
- Pilot to strona WWW: fabryka odtwarza w Nuxt istniejącą stronę osoby trzeciej. Odtwarza układ i wygląd; teksty to lorem ipsum, zdjęcia to placeholdery.
- Pilot rusza dopiero po pierwszej wersji taśmy. Godot włączamy jako drugi projekt.

### factory-init (8 listopada 2026)

- Sesja z AI ustala reguły projektu, zanim taśma dostanie pierwsze zadanie. Wynik to konwencje w `CLAUDE.md` projektu i `factory.yml`.
- Fabryka jest generyczna, więc nie ma stałej listy pytań. Agent dobiera je do typu projektu, np. dla frontendu podejście do stylów i tokeny wyglądu, dla gry nazwy i strukturę scen.
- Lekcja z pilota: bez spisanych konwencji agent sam wybrał styl kodu, a recenzent nie miał czego pilnować.

### Kolejka zadań (8 listopada 2026)

- Zadania ze wspólnymi plikami (z planu i z otwartego PR) nie idą równolegle. Drugie czeka z etykietą `queued`, tak samo jak zadanie ponad `wip_limit`, i rusza samo po zamknięciu PR fabryki.
- Testy spoza ścieżek strefy liczą się dla niej przez `zone_tests` w `factory.yml`, np. e2e dla układu strony.

### Pętla poprawek i zależności (8 listopada 2026)

- Czerwone CI albo `request_changes` odsyła PR do implementera automatycznie, do `risk.max_review_rounds` rund. Werdykt powstaje po pętli. Przy czerwonym CI recenzenci nie ruszają, chyba że to ostatnia runda.
- Implementer, który nie może dokończyć zadania, zgłasza `status: blocked`; wtedy nie ma PR ani recenzji, tylko etykieta `blocked` i komentarz.
- Nowe zależności planer wpisuje do planu, właściciel zatwierdza je `/approve` w issue, a instaluje je workflow komendą z `dependencies` w `factory.yml`. Implementer nie dostaje komendy instalacji, bo w jego jobie działa token subskrypcji.

## Otwarte pytania

- Czy routines Claude Code reagują na zdarzenia issues i jakie mają limity?
- Gdzie trafia digest: zbiorcze issue, e-mail czy powiadomienie push?
- Licencja publicznego repo.
