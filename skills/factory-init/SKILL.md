---
name: factory-init
description: Sesja startowa projektu fabryki. W rundach pytań z rekomendacjami ustala z właścicielem konwencje projektu i zapisuje je w CLAUDE.md i factory.yml, a przy pustym repo buduje szkielet z oficjalnych generatorów. Używaj, zanim taśma dostanie pierwsze zadanie w nowym projekcie.
---

# factory-init

Ustalasz z właścicielem, jak projekt ma wyglądać w kodzie, zanim taśma dostanie pierwsze zadanie. Bez spisanych konwencji agent sam wybiera styl, a recenzent nie ma czego pilnować (lekcja z pilota). Decyzje należą do właściciela: proponujesz, on wybiera.

## Wejście

- **repo projektu** w tej sesji, puste albo z kodem;
- **repo fabryki** (szablony, presety, walidator `scripts/config/cli.ts`); w sesji w chmurze dołączasz je do sesji;
- **opis projektu od właściciela** i jego dokument projektowy, jeśli go wskaże;
- **narzędzie do makiet**, jeśli projekt ma wygląd: w czym powstają makiety i co z niego da się wyeksportować.

Nie pytasz o nic, na co odpowiada repo albo dokument. Istniejący kod czytasz przed pierwszą rundą.

## Przebieg

1. **Rozpoznanie.** Typ projektu (strona, aplikacja, gra, inny), stan repo, platformy docelowe i narzędzie do makiet. Gdy czegoś brakuje, pytasz o to w pierwszej wiadomości.
2. **Pięć rund pytań.** W rundzie najwyżej 5 pytań, każde z rekomendacją i realnymi alternatywami z ich kosztem. Gdy masz narzędzie do pytań z opcjami (np. AskUserQuestion), używasz go: na telefonie wybór opcji jest wygodniejszy niż długi tekst. Właściciel nie zawsze wybiera rekomendację, więc alternatywy muszą być prawdziwe.
3. **Szkic po każdej rundzie.** Dopisujesz odpowiedzi do `CLAUDE.md` i `factory.yml` projektu. Sprawdzasz `factory.yml` walidatorem fabryki i mapą stref: główne katalogi projektu muszą trafić do stref z powodem, a nie wypaść poza mapę.
4. **Szkielet**, gdy repo jest puste i właściciel go wybrał (runda 5).
5. **Całość do akceptacji.** Pokazujesz pliki, a commit robisz dopiero po zgodzie właściciela. Gdy konfiguracja używa pola, którego `main` fabryki jeszcze nie zna, najpierw musi zostać scalony PR fabryki.
6. **Luki w fabryce** (np. brak obsługi menedżera pakietów projektu) zgłaszasz właścicielowi jako zmianę w fabryce, a nie obchodzisz w projekcie.

## Rundy

**1. Architektura i kod**
- Framework i biblioteka komponentów **razem z narzędziem do makiet**: najlepiej ta sama biblioteka w makietach i w kodzie, bo wtedy makieta przenosi się do kodu prawie 1:1. Lekcja z pierwszej sesji: framework zmieniony po rundach kosztował odbudowę szkieletu.
- Układ katalogów, stan i routing.
- Granice warstw, np. kod natywny i webowy, i gdzie leżą sekrety.
- Styl kodu jednym pytaniem: język nazw i tekstów, miejsce testów, linter, formatter, typy.

**2. Wygląd i wspólne elementy** (projekt z wyglądem)
- Źródło tokenów: motyw z makiet w jednym pliku, bez kolorów wpisanych w komponentach.
- Wspólne elementy: komponenty biblioteki zmieniane tylko przez warianty, własne wspólne elementy osobno, przykład każdego na stronie wzorców.
- Ikony i tryb ciemny; szerokości ekranu do sprawdzania; semantyka i dostępność.
- W grze zamiast tego: nazwy, struktura scen i zasoby.

**3. Testy i dowody**
- Testy jednostkowe i komponentów; e2e bez sieci i prawdziwych tokenów, z podmienionymi wywołaniami zewnętrznymi.
- Testy kodu natywnego w osobnych plikach (fabryka liczy test w pliku kodu jak kod).
- Zrzuty: komenda projektu renderuje ekrany i makiety w tej samej przeglądarce, w parach `<nazwa>@<szerokość>.png` i `.ref.png`.
- Pokazuj skutki dla ryzyka: strefa bez testów nie dostanie Low.

**4. Taśma (`factory.yml`)**
- Komendy z kontraktu (`setup`, `lint`, `typecheck`, `test`, `e2e`, `build` i komendy platform), runnery (`runs_on`, `agents_runs_on`) i menedżery pakietów (`dependencies`, `ecosystems`).
- Strefy: wspólne elementy, motyw i makiety w `shared`; sekrety i tokeny w `security`; ekrany funkcji w `code`.
- Dodatkowi recenzenci, wyjątki od wykrywania powtórzeń (`quality.ignore`), limity i modele (zwykle z `base`).

**5. Wydania i szkielet**
- Numeracja wersji, workflow wydania uruchamiany komendą `/release` i to, kiedy powstają paczki.
- Kto buduje szkielet pustego repo: ta sesja (z oficjalnych generatorów) albo taśma pierwszym zadaniem. Zależy to od tego, czy fabryka obsługuje menedżery pakietów projektu.

## Szkielet

- Tylko oficjalne generatory frameworka i biblioteki komponentów. Generujesz w katalogu roboczym obok repo i podmieniasz pliki dopiero, gdy nowy szkielet działa.
- Po każdym generatorze przypinasz dokładne wersje, a narzędzia potrzebne tylko przy budowaniu przenosisz do zależności deweloperskich.
- Czcionki i zasoby lokalnie, bez pobierania z sieci w czasie działania, żeby zrzuty były powtarzalne.
- Uruchamiasz lokalnie wszystkie komendy z kontraktu, które się da, i mówisz właścicielowi, czego nie sprawdziłeś (np. build na innej platformie sprawdzi dopiero CI).
- Gdy generator potrzebuje hosta spoza sieci sesji, prosisz o jego dodanie, zamiast pisać komponenty ręcznie.

## Wyjście

Pliki w repo projektu, pokazane właścicielowi przed pierwszym commitem:

- `CLAUDE.md`: opis projektu, zdanie, że reguły fabryki dostaje sesja z hooka startu, i konwencje z rund, w sekcjach: Architektura, Struktura katalogów, Konwencje kodu, Wygląd, Testy i dowody, Wydania;
- `factory.yml` przyjęty przez walidator fabryki;
- `.github/workflows/factory.yml` z `templates/workflows/factory.yml`, z runnerami z rundy 4, i `.factory/` w `.gitignore` (pliki robocze taśmy, których linter projektu nie może sprawdzać);
- hook startu sesji z `templates/claude/hooks/factory.sh` i `templates/claude/settings.json` w `.claude/`: pobiera skille i reguły fabryki w wersji z workflowu, więc projekt nie trzyma ich kopii;
- szkielet, gdy był w planie, i lista pierwszych zadań dla taśmy.
