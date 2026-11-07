import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadConfig, presetDir } from './load.ts';
import type { PresetSource } from './load.ts';

const TEMPLATE = readFileSync(new URL('../../templates/factory.yml', import.meta.url), 'utf8');

const MINIMAL = `
project: przyklad
extends: [base]
commands:
  test: npm test
  build: npm run build
`;

function errorsOf(text: string, presets?: PresetSource): string[] {
  const result = loadConfig(text, 'factory.yml', presets);
  assert.equal(result.ok, false, 'konfiguracja powinna zostać odrzucona');
  return result.ok ? [] : result.errors;
}

function assertError(text: string, expected: string): void {
  const errors = errorsOf(text);
  assert.ok(
    errors.some((e) => e.includes(expected)),
    `brak błędu zawierającego:\n  ${expected}\nzgłoszone błędy:\n  ${errors.join('\n  ')}`,
  );
}

describe('poprawny kontrakt', () => {
  it('przykładowy templates/factory.yml przechodzi walidację', () => {
    const result = loadConfig(TEMPLATE, 'templates/factory.yml');
    assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
    assert.deepEqual(result.config.extends, ['base', 'typescript', 'web']);
    assert.equal(result.config.wip_limit, 4);
    assert.equal(result.config.evidence.preview_deploy, true);
  });

  it('minimalny kontrakt dostaje progi z base i puste listy zamiast braków', () => {
    const result = loadConfig(MINIMAL, 'factory.yml');
    assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
    const { config } = result;
    assert.equal(config.risk.unassigned, 'Medium');
    assert.deepEqual(config.files.tests, []);
    assert.deepEqual(config.exceptions, []);
    assert.deepEqual(config.reviewers.extra, []);
    assert.equal(config.evidence.preview_deploy, false);
  });

  it('dopuszcza własne komendy, ludzkie bramki i harmonogramy', () => {
    const text = `${MINIMAL}  scene_check: ./tools/check.sh
human_gates:
  playtest: [feel]
schedules: { po: weekly, qa: nightly }
risk:
  medium_veto_hours: 0
`;
    const result = loadConfig(text, 'factory.yml');
    assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
    assert.equal(result.config.commands.scene_check, './tools/check.sh');
    assert.deepEqual(result.config.human_gates, { playtest: ['feel'] });
    assert.equal(result.config.risk.medium_veto_hours, 0);
  });

  it('każdy preset z presets/ daje się dołączyć', () => {
    const others = presetDir().list().filter((name) => name !== 'base');
    const text = MINIMAL.replace('extends: [base]', `extends: [base, ${others.join(', ')}]`);
    const result = loadConfig(text, 'factory.yml');
    assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
  });
});

describe('błędny kontrakt: komunikat wskazuje pole', () => {
  it('zły typ wartości', () => {
    assertError(`${MINIMAL}wip_limit: dużo\n`, 'factory.yml: wip_limit: oczekiwano liczby całkowitej ≥ 1, jest: "dużo"');
  });

  it('literówka w nazwie pola podpowiada poprawną', () => {
    assertError(`${MINIMAL}wip_limt: 3\n`, 'factory.yml: wip_limt: nieznane pole (czy chodziło o „wip_limit”?)');
  });

  it('element listy ma indeks w ścieżce', () => {
    assertError(`${MINIMAL}zones:\n  data: ["db/**", "/abs/**"]\n`, 'factory.yml: zones.data[1]: nieprawidłowy wzorzec "/abs/**"');
  });

  it('nieznana strefa wymienia dostępne', () => {
    assertError(`${MINIMAL}zones:\n  ui: ["src/ui/**"]\n`, 'factory.yml: zones.ui: nieznana strefa „ui”; dostępne: data, security');
  });

  it('wartość spoza listy dozwolonych', () => {
    const text = `${MINIMAL}exceptions:\n  - { path: a.ts, gate: size, max: 900, reason: stary plik }\n`;
    assertError(text, 'factory.yml: exceptions[0].gate: oczekiwano jednej z wartości: file_lines, function_lines');
  });

  it('wyjątek bez powodu', () => {
    const text = `${MINIMAL}exceptions:\n  - { path: a.ts, gate: file_lines, max: 900 }\n`;
    assertError(text, 'factory.yml: exceptions[0].reason: brak wymaganego pola');
  });

  it('brak wymaganej komendy', () => {
    assertError(MINIMAL.replace('  build: npm run build\n', ''), 'factory.yml: commands.build: brak wymaganego pola');
  });

  it('extends musi zaczynać się od base', () => {
    assertError(MINIMAL.replace('[base]', '[typescript]'), 'factory.yml: extends: pierwszym presetem musi być base');
  });

  it('nieznany preset wymienia dostępne', () => {
    assertError(MINIMAL.replace('[base]', '[base, rails]'), 'factory.yml: extends[1]: nieznany preset „rails”; dostępne: base, nuxt, typescript, web');
  });

  it('projekt nie zmienia progów z base', () => {
    assertError(`${MINIMAL}gates:\n  complexity: 30\n`, 'factory.yml: gates: progi bramek jakości ustala warstwa base');
    assertError(`${MINIMAL}risk:\n  size: { low: { lines: 1000, files: 50 }, medium: { lines: 2000, files: 90 } }\n`, 'factory.yml: risk.size: progi rozmiaru ustala warstwa base');
  });

  it('niezacytowany wzorzec z „*” na początku', () => {
    assertError(`${MINIMAL}protected_files: [**/secret]\n`, 'factory.yml: linia 7: wartość zaczynająca się od „*” ujmij w cudzysłów');
  });

  it('błąd składni YAML podaje linię', () => {
    assertError('project: a\nproject: b\n', 'factory.yml: linia 2: błąd składni YAML: Map keys must be unique');
  });

  it('pusty plik i plik, który nie jest mapą', () => {
    assertError('', 'factory.yml: plik jest pusty');
    assertError('- a\n- b\n', 'factory.yml: oczekiwano mapy „pole: wartość”, jest: lista');
  });

  it('zgłasza wszystkie błędy naraz', () => {
    const errors = errorsOf(`${MINIMAL}wip_limit: 0\ndaily_runs: -1\nfoo: 1\n`);
    assert.equal(errors.length, 3, errors.join('\n'));
  });
});

describe('modele na etapach', () => {
  it('base ustawia modele startowe, a projekt może je nadpisać', () => {
    const base = loadConfig(MINIMAL, 'factory.yml');
    assert.ok(base.ok);
    assert.deepEqual(base.config.models, {
      planner: 'opus',
      implementer: 'sonnet',
      risk_assessor: 'sonnet',
      reviewers: { default: 'sonnet', security: 'opus' },
    });
    const custom = loadConfig(`${MINIMAL}models:\n  implementer: opus\n  reviewers:\n    tests: haiku\n`, 'factory.yml');
    assert.ok(custom.ok, custom.ok ? '' : custom.errors.join('\n'));
    assert.equal(custom.config.models.implementer, 'opus');
    assert.deepEqual(custom.config.models.reviewers, { default: 'sonnet', security: 'opus', tests: 'haiku' });
  });

  it('przyjmuje pełny identyfikator modelu', () => {
    assert.ok(loadConfig(`${MINIMAL}models:\n  planner: claude-example-1-0\n`, 'factory.yml').ok);
  });

  it('błędny model jest odrzucany z komunikatem, który wskazuje pole', () => {
    assertError(`${MINIMAL}models:\n  planner: gpt-5\n`, 'factory.yml: models.planner: niedozwolona wartość "gpt-5"; dozwolone: opus, sonnet, haiku albo pełny identyfikator modelu claude-…');
  });

  it('model tylko dla włączonej perspektywy', () => {
    assertError(`${MINIMAL}models:\n  reviewers:\n    securty: opus\n`, 'factory.yml: models.reviewers.securty: perspektywa „securty” nie jest włączona');
  });

  it('preset języka nie ustawia modeli', () => {
    const base = readFileSync(new URL('../../presets/base.yml', import.meta.url), 'utf8');
    const presets: PresetSource = { list: () => ['base', 'x'], read: (name) => ({ base, x: 'models:\n  planner: haiku\n' })[name] };
    const errors = errorsOf(MINIMAL.replace('[base]', '[base, x]'), presets);
    assert.ok(errors.some((e) => e.startsWith('presets/x.yml: models: preset języka lub frameworka ustawia tylko')), errors.join('\n'));
  });
});

describe('warstwy', () => {
  const base = readFileSync(new URL('../../presets/base.yml', import.meta.url), 'utf8');
  const source = (presets: Record<string, string>): PresetSource => ({
    list: () => Object.keys(presets).sort(),
    read: (name) => presets[name],
  });

  it('preset języka ustawia tylko strefy, klasy plików, znaczniki i pliki chronione', () => {
    const errors = errorsOf(MINIMAL.replace('[base]', '[base, x]'), source({ base, x: 'wip_limit: 9\n' }));
    assert.ok(errors.some((e) => e.startsWith('presets/x.yml: wip_limit: preset języka lub frameworka ustawia tylko')), errors.join('\n'));
  });

  it('progi base muszą być spójne', () => {
    const broken = base.replace('low: { lines: 100', 'low: { lines: 1000');
    const errors = errorsOf(MINIMAL, source({ base: broken }));
    assert.ok(errors.includes('presets/base.yml: risk.size.low.lines: próg Low (1000) jest wyższy niż Medium (400)'), errors.join('\n'));
  });

  it('listy się sumują, więc projekt nie usunie ochrony z base', () => {
    const result = loadConfig(`${MINIMAL}protected_files: ["backup/**", "**/.env"]\n`, 'factory.yml');
    assert.ok(result.ok);
    const files = result.config.protected_files;
    assert.ok(files.includes('**/.env') && files.includes('backup/**'));
    assert.equal(files.filter((f) => f === '**/.env').length, 1);
  });

  it('strefy z presetów i projektu łączą się w kolejności warstw', () => {
    const result = loadConfig(TEMPLATE, 'templates/factory.yml');
    assert.ok(result.ok);
    const shared = result.config.zones.shared ?? [];
    assert.ok(shared.indexOf('**/package-lock.json') < shared.indexOf('src/store/**'));
  });

  it('ten sam plik zawsze daje ten sam wynik', () => {
    const first = loadConfig(TEMPLATE, 'templates/factory.yml');
    const second = loadConfig(TEMPLATE, 'templates/factory.yml');
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});

describe('presets/base.yml', () => {
  it('ma progi startowe z README', () => {
    const result = loadConfig(MINIMAL, 'factory.yml');
    assert.ok(result.ok);
    const { risk, gates, reviewers } = result.config;
    assert.deepEqual(risk.size, { low: { lines: 100, files: 5 }, medium: { lines: 400, files: 15 } });
    assert.equal(risk.min_confidence, 0.8);
    assert.equal(risk.medium_veto_hours, 24);
    assert.deepEqual(gates, { file_lines: { warn: 300, block: 500 }, function_lines: 50, complexity: 15, nesting: 4 });
    assert.equal(reviewers.perspectives.length, 5);
    assert.equal(result.config.zones.factory?.includes('factory.yml'), true);
  });
});
