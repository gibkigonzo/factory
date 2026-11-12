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

### Dystrybucja (8 listopada 2026)

- Cel: jak najmniej obsługi. Projekt ma tylko `factory.yml`, regułę w `CLAUDE.md` i cienki workflow; reszta przychodzi z fabryki sama. Każde ręczne kopiowanie i synchronizacja to etap przejściowy do usunięcia.
- Cienki workflow projektu ma jeden job: `uses: gibkigonzo/factory/.github/workflows/pipeline.yml@<wersja>`. Dyrygent wywołuje etapy składnią `$/` z tej samej wersji, a uprawnienia projektu są sufitem dla całej taśmy.
- Taśma czyta skille agentów, presety i skrypty z fabryki w przypiętej wersji. W Etapie 0 projekty używają `@main`; po nim powstanie tag `v1` (zmiany zgodne same, niezgodne w `v2`).
- Repo jest też marketplace'em pluginu (`.claude-plugin/marketplace.json`) do pracy lokalnej w Claude Code; taśma pluginu nie potrzebuje.
- Na razie ręcznie: kopia skilla `spec-writer` w `.claude/skills/` projektu, bo sesje w chmurze nie instalują pluginów. Do sprawdzenia: wczytanie skilla z fabryki przez regułę w `CLAUDE.md` albo automatyczny PR z aktualizacją.

### Godot w CI

- Godot działa na runnerze GitHub z Ubuntu. Workflow instaluje przypiętą wersję edytora i szablony eksportu, zanim uruchomi `claude-code-action` z `--allowedTools "Bash(godot:*)"`.
- `--headless` nie renderuje obrazu. Zrzuty ekranu wymagają `xvfb-run` z rendererem `opengl3`.

### Praca z telefonu

- Wymaganie: każdy krok użytkownika (akceptacja propozycji, rozmowa o specu, decyzja przy High, playtest, zatrzymanie i wznowienie taśmy) musi dać się zrobić z telefonu, bez komputera.
- Taśma działa na GitHub Actions, więc komputer nie jest potrzebny. Komendy `/approve`, `/veto` i inne działają z aplikacji GitHub Mobile. Wielkość liter nie ma znaczenia (autokorekta pisze „/Change”), a na nieznaną komendę taśma odpowiada.
- Do zakładania issue z aplikacji Claude służy oficjalny serwer MCP GitHuba podłączony jako konektor claude.ai. Zwykły czat w aplikacji mobilnej zakłada issue (sprawdzone w #3), więc `spec-writer` może działać w zwykłym czacie.
- Konektor łączy się przez inną aplikację GitHub niż Claude Code. Ta aplikacja musi mieć repo w swojej instalacji, inaczej zapis kończy się 403 `Resource not accessible by integration`.

### Kontrakt projektu (6 listopada 2026)

- Warstwy składają się w kolejności `base` → presety z `extends` → `factory.yml`. Listy się sumują, pojedyncze wartości nadpisuje późniejsza warstwa.
- Projekt nie zmienia progów z `base` (rozmiar, poziomy stref, pewność recenzentów, bramki jakości). Może dodać wyjątek od bramki jakości dla ścieżki, zawsze z powodem.
- „Koszt” to dzienny limit przebiegów z Claude (`daily_runs`): plan, implementacja i recenzja, liczone po nazwie przebiegu. Nowe zadanie ponad limit czeka w kolejce do jutra; rundy poprawek otwartego PR limitu nie sprawdzają.
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
- Werdykt „scal” albo „okno weta”, po którym właściciel napisał `/change`, liczy się jako 👎 (przy Low jako fałszywe Low), bo w Etapie 1 PR scaliłby się bez poprawki. Reakcja na ten werdykt ma pierwszeństwo; `/change` po eskalacji to zgoda (12 listopada 2026).
- Progi Bramki 1 są w sekcji `shadow` w `base`. Bramka liczy okno ostatnich `gate_prs` PR z oceną, a nie całą historię: po naprawie błędu fabryka musi pokazać tyle dobrych werdyktów pod rząd (12 listopada 2026).
- Statystyki wszystkich zadań, także bez PR, dziennik zapisuje w `journal.csv` i `journal.json` na gałęzi `factory-journal`: koszt na etap i recenzenta oraz ocenę właściciela. Koszt zablokowanej implementacji trafia do komentarza z blokadą, a koszt recenzji rundy odesłanej do implementera do komentarza rundy (11 listopada 2026).

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
- Runda poprawek bez zmian w plikach (`done` z wyjaśnieniem w założeniach) aktualizuje opis PR, cytuje wyjaśnienie w komentarzu PR i uruchamia recenzję jeszcze raz, w limicie rund. `/change` właściciela implementer wykonuje albo kończy blokadą z powodem; zadaniem rundy są uwagi, a nie issue od nowa. Lekcja z pilota: implementer uznał pracę z issue za „już w main” i pominął uwagę właściciela (12 listopada 2026). Rundy po `/change` właściciela (`factory:change-N`) nie liczą się do limitu automatycznych rund. `ci.json` ma końcówkę wyjścia każdej komendy, więc dowód z CI (np. czysty typecheck) recenzent bierze stamtąd. Lekcja z pilota: recenzent prosił o log, którego implementer nie mógł pokazać, a runda bez zmian kończyła się blokadą (11 listopada 2026).
- Nowe zależności planer wpisuje do planu, właściciel zatwierdza je `/approve` w issue, a instaluje je workflow komendą z `dependencies` w `factory.yml`. Implementer nie dostaje komendy instalacji, bo w jego jobie działa token subskrypcji.

### Zatrzymanie taśmy i problemy taśmy (11 listopada 2026)

- `/stop <powód>` zatrzymuje taśmę jak linkę bezpieczeństwa w fabryce: otwiera issue „Taśma zatrzymana” (`factory:stopped`). Dyrygent nie uruchamia wtedy planu, implementacji, recenzji ani kolejki, tylko zapisuje wstrzymany etap (`factory:paused`). `/start` wznawia taśmę i zapisane etapy. Dziennik i komendy działają zawsze.
- Agenci (planer, implementer) zgłaszają problem taśmy w polu `line_problem`: kłopot z narzędziami albo komendami projektu, a nie z zadaniem. Zgłoszenie nie zatrzymuje taśmy; dziennik zbiera je w sekcji „Problemy taśmy” i w `problemy.csv`, a decyzja o `/stop` należy do właściciela.
- Lekcja z pilota: implementer cztery razy wpisał w założeniach PR, że typecheck „pada” (szum ostrzeżenia `vue-tsc` przy kodzie 0), i nikt tego nie zauważył.

### Spec w rundach pytań (11 listopada 2026)

- Spec-writer pyta w rundach: najwyżej 5 pytań w wiadomości, kolejna runda tylko o to, co otworzyły odpowiedzi. Po 3 rundach z otwartymi decyzjami proponuje podział na kilka speców.

### Zrzuty ekranu (10 listopada 2026)

- Projekt podaje w `evidence.screenshots` komendę, która po CI zapisuje PNG w `$FACTORY_SCREENSHOTS`: `<nazwa>@<szerokość>.png` to wykonanie, `.ref.png` to wzorzec. Zrzuty robi deterministyczny kod projektu; czerwona komenda nie zatrzymuje recenzji.
- Taśma robi te same zrzuty na punkcie rozgałęzienia i porównuje piksele. `ux-visual` (perspektywa z `screenshots: true`) dostaje tylko sekcje zmienione przez PR; gdy wygląd się nie zmienił, werdykt wystawia skrypt bez modelu. Inni recenzenci zrzutów nie dostają (10 listopada 2026, koszt).
- Komentarz w PR ma linki do obrazów wzorzec|wykonanie, a nie obrazy w treści: GitHub nie pokazuje w komentarzach obrazów z repo prywatnego. W każdej rundzie powstaje nowy komentarz, a poprzedni znika. Obrazy leżą na gałęzi `factory-screenshots` (jeden commit, tylko otwarte PR); job galerii działa bez Claude i bez kodu PR.
- Wzorzec jest celem także wtedy, gdy kryteria sprawdzają tylko wymiary i liczbę elementów. Różnica widoczna od razu to `high` u `ux-visual`, a implementer poprawia ją przed oddaniem zmiany. „Agent może zmienić” w specu dotyczy tylko tego, czego wzorzec nie pokazuje. Lekcja z pilota: recenzent opisał różnice trafnie, ale nazwał je „stylistycznymi” i zatwierdził.
- Recenzent wyglądu dostaje uwagi, na które odpowiadała runda, i nie żąda ich odwrotności. Sąsiednie grubości czcionki i podobny krój to najwyżej `medium`. Lekcja z pilota: recenzent kolejnej rundy uznał za „za gruby” nagłówek pogrubiony na prośbę poprzedniej i zablokował PR na High (12 listopada 2026).
- Później, gdy projekt tego potrzebuje: zrzuty pojedynczych komponentów.

## Otwarte pytania

- Czy routines Claude Code reagują na zdarzenia issues i jakie mają limity?
- Gdzie trafia digest: zbiorcze issue, e-mail czy powiadomienie push?
- Licencja publicznego repo.
