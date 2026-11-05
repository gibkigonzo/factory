# Factory

Generyczna fabryka oprogramowania oparta na Claude Code. Zamienia rozmowę o pomyśle w scalony, zweryfikowany kod. Działa dla stron WWW i dla gier w Godot.

> **Status:** Etap 0 (tryb cienia) w przygotowaniu. Na razie jest tu tylko szkielet.

## Jak działa

1. Spec powstaje w rozmowie w aplikacji Claude. Skill `spec-writer` zakłada issue z etykietą `ready`.
2. Planer rozpisuje zadanie, a implementerzy pracują równolegle na gałęziach `factory/*`.
3. Panel recenzentów ocenia każdy PR z 5–8 perspektyw. Każdy recenzent pracuje w świeżym kontekście.
4. Oceniacz ryzyka nadaje poziom zmiany:
   - **Low** scala się automatycznie;
   - **Medium** scala się po 24 h, jeśli nikt nie da `/veto`;
   - **High** czeka na decyzję właściciela, który nie czyta kodu, tylko decyduje.

Scala deterministyczny skrypt, a nie model. Fabryka nie może zmieniać własnych zabezpieczeń.

## Reguły ryzyka v1

Poziom zmiany to najwyższy wynik z pięciu reguł. Reguły i oceniacz mogą go tylko podnieść.

| Reguła | Co sprawdza |
| --- | --- |
| 1. Strefy | ścieżki plików według mapy stref projektu; ścieżka spoza mapy dostaje Medium |
| 2. Zachowanie i odwracalność | ocena LLM, która może poziom tylko podnieść; zmiana sposobu liczenia kwot to Medium |
| 3. Brak testów | strefa bez testów jest o poziom wyżej |
| 4. Rozmiar | Low: maks. 100 linii i 5 plików; Medium: maks. 400 linii i 15 plików; większe zmiany planer dzieli |
| 5. Dowody | zielone CI, dowód dla każdego kryterium akceptacji, test regresyjny przy poprawce błędu, approve recenzentów z pewnością ≥ 0,8 |

Bramki jakości nie są ryzykiem: blokują merge, ale fabryka poprawia je sama.

| Bramka | Próg |
| --- | --- |
| Długość pliku | ostrzeżenie przy 300 liniach, blokada przy 500; pliki już większe nie mogą rosnąć |
| Długość funkcji | maks. 50 linii |
| Złożoność | maks. 15 |
| Zagnieżdżenie | maks. 4 |

## Jak projekt używa Factory

Reguły mają trzy warstwy: wspólne `base`, presety języka i frameworka oraz `factory.yml` projektu z mapą stref, komendami i wyjątkami.

- **Plugin.** To repo jest marketplace'em pluginu Claude Code. W `claude-code-action`:

  ```yaml
  plugin_marketplaces: https://github.com/gibkigonzo/factory.git
  plugins: factory@factory
  ```

  Lokalnie: `/plugin marketplace add gibkigonzo/factory`, potem `/plugin install factory@factory`.
- **Workflowy.** Wspólne workflowy działają przez `workflow_call`:
  `uses: gibkigonzo/factory/.github/workflows/<name>.yml@v1`. Mogą je wywoływać także repozytoria prywatne.
- **Kontrakt.** Projekt dodaje `factory.yml` z `extends: [base, <język>, <framework>]`. Wersje presetów przypina tagami.

## Struktura repo

```
.claude-plugin/       plugin.json i marketplace.json (plugin = całe repo)
skills/               skille: spec-writer, planner, review-<perspektywa>, risk-assessor, po-scout, factory-init
agents/               subagenci recenzentów, tylko do odczytu
hooks/                hooks.json: blokada chronionych plików, Stop dopiero po zielonych testach
scripts/              deterministyczne skrypty: reguły ryzyka, merger
presets/              warstwy reguł: base, typescript, web, gdscript, godot
templates/            szablony dla projektów: wywołujące workflowy, przykładowy factory.yml
.github/workflows/    wspólne workflowy typu workflow_call
```
