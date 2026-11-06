---
name: review
description: Panel recenzji fabryki. Uruchamia recenzentów PR (subagenci review-<perspektywa>, tylko do odczytu, każdy w świeżym kontekście), zbiera ich werdykty JSON i sprawdza je skryptem. Używaj, gdy PR z gałęzi factory/* ma zielone CI i trzeba go ocenić.
---

# Panel recenzji

Organizujesz recenzję PR. Sam niczego nie oceniasz: przygotowujesz materiał, uruchamiasz recenzentów i zbierasz ich werdykty.

## Wejście

- numer PR i jego gałąź `factory/*` z zielonym CI;
- issue ze specem, które PR realizuje;
- `factory.yml` projektu złożony z warstw: `node <katalog pluginu>/scripts/config/cli.ts factory.yml --json`. Katalog pluginu to dwa poziomy nad katalogiem tego skilla;
- artefakty weryfikacji z CI, jeśli są: wyniki testów, zrzuty, raporty.

## Kroki

1. Przygotuj katalog `.factory/review/` poza śledzonymi plikami:
   - `diff.patch`: `git diff --no-color -M $(git merge-base origin/main HEAD) HEAD`;
   - `spec.md`: treść issue bez zmian;
   - `pr.md`: opis PR bez zmian;
   - `artifacts/`: artefakty z CI.
2. Ustal perspektywy: `reviewers.perspectives` i `reviewers.extra` z `factory.yml`. Dla każdej perspektywy jest subagent `review-<perspektywa>`. Perspektywy bez subagenta zgłoś w podsumowaniu jako brakujące; reguły ryzyka policzą brak werdyktu.
3. Uruchom wszystkich recenzentów równolegle. Każdy dostaje to samo krótkie polecenie z listą ścieżek z kroku 1 i nic więcej: bez Twojej opinii, bez rozumowania implementera, bez werdyktów innych recenzentów.
4. Zapisz ostatnią wiadomość każdego recenzenta do `.factory/review/raw/<perspektywa>.md`. Wyciągnij i sprawdź werdykt:
   `node <katalog pluginu>/scripts/agents/output.ts verdict .factory/review/raw/<perspektywa>.md > .factory/review/verdicts/<perspektywa>.json`.
   Gdy skrypt odrzuci werdykt, poproś tego samego recenzenta raz o poprawny format. Gdy znowu się nie uda, zostaw brak werdyktu.

## Pętla poprawek

`request_changes` wraca do implementera razem z uwagami. Po poprawkach ponownie oceniają tylko perspektywy, które zgłosiły uwagi; pozostałe werdykty zostają. Licz rundy: po 3 rundach z nierozstrzygniętymi uwagami reguły ryzyka dają High i zmiana trafia do właściciela.

## Wyjście

- `.factory/review/verdicts/<perspektywa>.json`: sprawdzony werdykt każdego recenzenta;
- krótkie podsumowanie: perspektywy z `approve`, perspektywy z uwagami, brakujące werdykty i numer rundy.

## Czego nie robisz

- Nie oceniasz kodu i nie zmieniasz werdyktów.
- Nie streszczasz recenzentom PR ani innych werdyktów.
- Nie ustawiasz etykiet i nie zatwierdzasz PR. Robią to workflowy na podstawie wyniku reguł ryzyka.
