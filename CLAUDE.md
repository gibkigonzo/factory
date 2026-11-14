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

Jak taśma działa, opisuje README. Tu są decyzje i ich powody.

### Ryzyko (5 i 14 listopada 2026)

- Poziom zmiany to najwyższy wynik z pięciu reguł: strefy, zachowanie i odwracalność (LLM, tylko w górę), brak testów, rozmiar, dowody. Progi są w `base`.
- Poziomy są dwa: Low scala fabryka, High decyduje właściciel. Medium z oknem weta 24 h usunęliśmy 14 listopada, bo okno łatwo przegapić; w pilocie 2 z 10 werdyktów Medium wymagały `/change`. Wszystko, co dawało Medium (strefa `shared`, ścieżka spoza mapy stref, brak oceny oceniacza, rozmiar ponad próg Low, brak dowodu), daje High, a raport mówi dlaczego. 400 linii / 15 plików to tylko próg podziału (`risk.size.split`).
- `/veto` i `risk.medium_veto_hours` zniknęły. Dziennik liczy dawne werdykty Medium jako eskalacje („było Medium”).

### Dystrybucja (8 listopada 2026)

- Cel: jak najmniej obsługi. Projekt ma tylko `factory.yml`, regułę w `CLAUDE.md` i cienki workflow z jednym jobem `uses: gibkigonzo/factory/.github/workflows/pipeline.yml@<wersja>`. Etapy, skille, presety i skrypty przychodzą z fabryki w tej wersji, a uprawnienia projektu są sufitem taśmy. Każde ręczne kopiowanie to etap przejściowy.
- Etap 0 używa `@main`; po nim tag `v1` (zmiany zgodne same, niezgodne w `v2`).
- Repo jest też marketplace'em pluginu do pracy lokalnej; taśma go nie potrzebuje.
- Przejściowo ręcznie: kopia skilla `spec-writer` w projekcie, bo sesje w chmurze nie instalują pluginów. Do sprawdzenia: skill z fabryki przez regułę w `CLAUDE.md` albo automatyczny PR z aktualizacją.

### Godot w CI

- Workflow instaluje przypiętą wersję edytora i szablony eksportu na runnerze Ubuntu, zanim uruchomi `claude-code-action` z `--allowedTools "Bash(godot:*)"`.
- `--headless` nie renderuje obrazu; zrzuty wymagają `xvfb-run` z rendererem `opengl3`.

### Praca z telefonu

- Każdy krok właściciela (spec, akceptacja, decyzja przy High, playtest, zatrzymanie i wznowienie taśmy) musi dać się zrobić z telefonu, bez komputera. Taśma działa na GitHub Actions, a komendy idą z GitHub Mobile; wielkość liter nie ma znaczenia, a na nieznaną komendę taśma odpowiada.
- Issue z aplikacji Claude zakłada oficjalny serwer MCP GitHuba jako konektor claude.ai, także w zwykłym czacie (sprawdzone w #3). Konektor łączy się przez własną aplikację GitHub, która musi mieć repo w instalacji, inaczej zapis kończy się 403.

### Kontrakt projektu (6 listopada 2026)

- Warstwy: `base` → presety z `extends` → `factory.yml`. Listy się sumują, pojedyncze wartości nadpisuje późniejsza warstwa. Schemat jest w `scripts/config/spec.ts`.
- Projekt nie zmienia progów z `base`; może dodać wyjątek od bramki jakości dla ścieżki, zawsze z powodem.
- Koszt pilnuje `daily_runs`, dzienny limit przebiegów z Claude (plan, implementacja, recenzja). Nowe zadanie ponad limit czeka do jutra; rundy poprawek otwartego PR limitu nie sprawdzają.

### Perspektywy i modele (7 listopada 2026)

- Pięć perspektyw z `base` ocenia każdy PR. Dodatkowe (z katalogu fabryki albo `.factory/perspectives/`) projekt włącza w `reviewers.extra`; perspektywa z `paths` albo `zones` ocenia tylko zmiany, których dotyczy.
- Najpierw tanie strażniki deterministyczne w CI (rozmiar paczki, Lighthouse, axe), recenzent LLM dopiero wtedy, gdy projekt go potrzebuje.
- Sekcja `models` ustawia model na każdym etapie; wartości startowe są w `base`.

### Taśma w GitHub Actions (7 listopada 2026)

- Claude działa w jobach tylko z prawem odczytu i zwraca JSON albo patch. Zapisy robią osobne joby bez Claude.
- Etapy łączy `workflow_dispatch`. W Etapie 0 zmiany podpisuje `github-actions[bot]`, a własna aplikacja GitHub fabryki przychodzi w Etapie 1.
- `runs-on` jest ustawieniem: VPS właściciela podłączymy później jako self-hosted runner, tylko dla repo prywatnych.
- Ruleset na `main` w repo prywatnym wymaga GitHub Pro; decyzja przed Etapem 1.

### Tryb cienia (7 listopada 2026)

- Po każdej ocenie ryzyka taśma dodaje w PR nowy komentarz z werdyktem, a właściciel ocenia go 👍 albo 👎. Decyzję liczy `scripts/shadow/decision.ts`; ten sam kod zdecyduje o merge'u po trybie cienia.
- Dziennik to przypięte issue „Tryb cienia”, odświeżane po werdykcie, po zamknięciu PR fabryki i raz dziennie, bo reakcje nie uruchamiają workflowów. Statystyki wszystkich zadań, także bez PR, trafiają do `journal.csv` i `journal.json` na gałęzi `factory-journal`.
- „Scal” z późniejszym `/change` to 👎 (fałszywe Low), bo po trybie cienia PR scaliłby się bez poprawki. Reakcja na werdykt ma pierwszeństwo, a `/change` po eskalacji to zgoda (12 listopada).
- Bramka 1 (progi w `shadow` w `base`) liczy okno ostatnich `gate_prs` ocenionych PR, a nie całą historię: po naprawie błędu fabryka musi pokazać tyle dobrych werdyktów pod rząd (12 listopada).
- Kalibracja progu pewności porównuje odsetek przyjętych PR w grupach pewności, a nie zgodność, bo werdykt sam zależy od pewności.

### Spec (7, 11 i 12 listopada 2026)

- Spec powstaje w sesji Claude Code na repo projektu (z telefonu: zakładka Code). Projekt trzyma kopię skilla i regułę z `templates/claude/CLAUDE.md`; bez reguły sesja od razu implementuje. ZIP do zwykłego czatu (`npm run skill:zip`) to opcja.
- Spec-writer najpierw pyta „notatka czy spec?”. Notatka to issue z etykietą `idea`. Spec trafia do issue bez `ready`, a `ready` spec-writer dodaje dopiero na zgodę właściciela. Każde issue ma blok „Wiadomość właściciela” z oryginałem; spec ma pierwszeństwo.
- Pytania w rundach: najwyżej 5 w wiadomości, kolejna runda tylko o to, co otworzyły odpowiedzi. Po 3 rundach z otwartymi decyzjami spec-writer proponuje podział.
- Taśma planuje tylko issue ze specem (sekcje w `SPEC_SECTIONS`). `/split` na notatce działa, a na zadaniu w toku odpowiada „za późno”. Issue zakłada konto właściciela, więc strażnik taśmy je przepuszcza.

### Koszt (7 listopada 2026)

- Każdy etap z Claude zapisuje zużycie; dziennik pokazuje koszt na PR, etap i recenzenta, także zablokowanych zadań i rund bez werdyktu.
- Agenci piszą zwięźle: werdykt najwyżej 2 zdania i 5 uwag, plan i opis PR bez powtarzania specu. Teksty dla właściciela są po polsku.
- O angielskich instrukcjach (skille, perspektywy, protokół) decydujemy po 5–10 PR pilota, na podstawie pomiaru.

### Pilot (6 listopada 2026)

- `claude-code-action` loguje się subskrypcją: sekret `CLAUDE_CODE_OAUTH_TOKEN` dodaje właściciel.
- Pilot to strona WWW: fabryka odtwarza w Nuxt układ i wygląd istniejącej strony osoby trzeciej, z lorem ipsum i placeholderami. Godot jest drugim projektem.

### factory-init (8 listopada 2026)

- Sesja z AI ustala konwencje projektu (w `CLAUDE.md` i `factory.yml`), zanim taśma dostanie pierwsze zadanie. Pytania agent dobiera do typu projektu: dla frontendu style, tokeny wyglądu, wspólne elementy i semantykę HTML (13 listopada), dla gry nazwy i strukturę scen.
- Lekcja z pilota: bez spisanych konwencji agent sam wybrał styl kodu, a recenzent nie miał czego pilnować.

### Kolejka i pętla poprawek (8–14 listopada 2026)

- Zadania ze wspólnymi plikami (z planu i z otwartego PR) nie idą równolegle: drugie czeka z `queued`, tak jak zadanie ponad `wip_limit`. Testy spoza ścieżek strefy liczą się dla niej przez `zone_tests`.
- Czerwone CI albo `request_changes` odsyła PR do implementera, do `risk.max_review_rounds` rund; werdykt powstaje po pętli. Po każdej poprawce cały panel ocenia PR od nowa, a nie tylko perspektywy z uwagami: dokładniej, choć drożej (14 listopada 2026). Rundy po `/change` (`factory:change-N`) i rundy konfliktu (`factory:conflict-N`, najwyżej 2 na PR) nie liczą się do limitu.
- Implementer, który nie może dokończyć, zgłasza `blocked`: wtedy nie ma PR ani recenzji. Pliki tymczasowe i pozostałości po debugowaniu usuwa przed oddaniem zmiany (lekcja z pilota: `tmp-dump.spec.ts` został w PR, 14 listopada). Runda bez zmian w plikach jest dopuszczalna z wyjaśnieniem. Zadaniem rundy są uwagi, nie issue od nowa; lekcja z pilota: implementer pominął uwagę właściciela jako „już w main”.
- Cytat w uwadze recenzenta liczy się także ze znakiem diffu (`+`, `-`) na początku linii; lekcja z pilota: pięć prawdziwych cytatów ze znakiem `+` skrypt uznał za zmyślone (14 listopada).
- Każdy recenzent dostaje polecenia `/change` właściciela jako decyzje ważniejsze od specu, `ci.json` z końcówką wyjścia komend i wynik porównania zrzutów (`visual.md`). Lekcje z pilota: recenzent specu zgłosił prośbę właściciela jako „spoza specu”, a inny prosił o log, którego implementer nie mógł pokazać. Ręczną zmianę gałęzi PR właściciel też zapisuje jako `/change`.
- Każda runda zaczyna od scalenia gałęzi głównej; konflikty rozwiązuje implementer, a commit scalenia robi job zapisu tym samym SHA. Lekcja z pilota: dwa równoległe PR zmieniły plik dodany w rundzie poprawek, którego strażnik kolizji nie widział.
- Nowe zależności planer wpisuje do planu, właściciel zatwierdza `/approve`, a instaluje je workflow. Implementer nie dostaje komendy instalacji, bo w jego jobie działa token subskrypcji.

### Zatrzymanie taśmy (11 i 13 listopada 2026)

- `/stop <powód>` zatrzymuje taśmę jak linka bezpieczeństwa: plan, implementacja, recenzja i kolejka czekają (`factory:paused`), a `/start` je wznawia. Dziennik i komendy działają zawsze.
- Limit subskrypcji zatrzymuje taśmę sam: etap czeka zamiast kończyć się blokadą, issue podaje godzinę resetu, a pierwsze zdarzenie po niej wznawia etapy. Lekcja z pilota: runda poprawek trafiła na limit 5 h i skończyła się blokadą.
- Agenci zgłaszają problemy taśmy (narzędzia i komendy, nie zadanie) w `line_problem`. Dziennik je zbiera, a decyzja o `/stop` należy do właściciela. Lekcja z pilota: szum ostrzeżenia `vue-tsc` przy kodzie 0 implementer czterokrotnie opisał w założeniach jako błąd.

### Zrzuty ekranu (10 i 12 listopada 2026)

- Projekt podaje w `evidence.screenshots` komendę, która zapisuje `<nazwa>@<szerokość>.png` (wykonanie) i `.ref.png` (wzorzec). Zrzuty robi kod projektu; czerwona komenda nie zatrzymuje recenzji.
- Taśma porównuje piksele z punktem rozgałęzienia. `ux-visual` dostaje tylko zmienione sekcje, a gdy nic się nie zmieniło, werdykt wystawia skrypt. Inni recenzenci dostają tylko wynik porównania, bez obrazów (koszt).
- Galeria w PR to linki, bo GitHub nie pokazuje w komentarzach obrazów z repo prywatnego. Obrazy leżą na gałęzi `factory-screenshots`, a job galerii działa bez Claude i bez kodu PR.
- Wzorzec jest celem także przy kryteriach tylko z wymiarami: widoczna różnica to `high` u `ux-visual`, a „Agent może zmienić” dotyczy tylko tego, czego wzorzec nie pokazuje. Recenzent kolejnej rundy nie żąda odwrotności poprzednich uwag; sąsiednie grubości czcionki to najwyżej `medium`.
- Brak zmian wyglądu dowodzi porównanie taśmy, a nie stały test pikselowy w repo. Lekcja z pilota: wzorce zrzutów całej strony psuły e2e każdego PR ze zmianą wyglądu.
- Później, gdy projekt tego potrzebuje: zrzuty pojedynczych komponentów.

### Wspólne elementy (13 listopada 2026)

- O wspólnych elementach decyduje właściciel w konwencjach projektu; nowy wspólny komponent albo wariant widzi w planie jako „Wspólny element: …”.
- Gdy element nie pasuje, wspólny komponent dostaje wariant zamiast nadpisania w miejscu użycia (`maintainability` zgłasza nadpisanie jako `medium`). Przycisk to `button`, link to `a`, także gdy na razie nic nie robi; pilnuje tego `accessibility-web`. Lekcja z pilota: `span` udający przycisk, ze wspólną klasą nadpisaną przez `!important`, przeszedł recenzję bez uwag.

## Otwarte pytania

- Czy routines Claude Code reagują na zdarzenia issues i jakie mają limity?
- Gdzie trafia digest: zbiorcze issue, e-mail czy powiadomienie push?
- Licencja publicznego repo.
