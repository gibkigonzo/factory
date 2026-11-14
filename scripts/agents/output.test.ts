import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { extractJson, parseOutput } from './output.ts';

const CLI = new URL('./output.ts', import.meta.url).pathname;

const PLAN = {
  decision: 'planned',
  summary: 'nagłówek strony',
  size: { lines: 40, files: 2 },
  files: ['src/components/Hero.vue'],
  expected_level: 'Low',
  acceptance: [{ criterion: 'nagłówek ma 48 px', evidence: 'test: e2e/hero.spec.ts › rozmiar' }],
  assumptions: [],
};

const fenced = (value: unknown) => `Plan gotowy.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

function errors(kind: Parameters<typeof parseOutput>[0], value: unknown): string[] {
  const result = parseOutput(kind, fenced(value), 'odpowiedź.md');
  return result.ok ? [] : result.errors;
}

describe('wyciąganie JSON z odpowiedzi agenta', () => {
  it('bierze ostatni blok json', () => {
    const message = '```json\n{"a": 1}\n```\ntekst\n```json\n{"a": 2}\n```';
    assert.deepEqual(extractJson(message), { ok: true, value: { a: 2 } });
  });

  it('przyjmuje odpowiedź, która jest samym JSON-em', () => {
    assert.deepEqual(extractJson('  {"a": 1}\n'), { ok: true, value: { a: 1 } });
  });

  it('odrzuca odpowiedź bez JSON i zepsuty JSON', () => {
    assert.deepEqual(extractJson('Gotowe, wszystko działa.'), { ok: false, error: 'brak bloku ```json w odpowiedzi agenta' });
    const broken = extractJson('```json\n{"a": }\n```');
    assert.equal(broken.ok, false);
    assert.match(broken.ok ? '' : broken.error, /^nieprawidłowy JSON/);
  });
});

describe('sprawdzanie wyjścia', () => {
  it('poprawny plan przechodzi', () => {
    assert.deepEqual(errors('plan', PLAN), []);
  });

  it('błąd wskazuje pole', () => {
    assert.deepEqual(errors('plan', { ...PLAN, expected_level: 'low' }), [
      'odpowiedź.md: expected_level: oczekiwano jednej z wartości: Low, High; jest: "low"',
    ]);
  });

  it('decyzje planera muszą być spójne', () => {
    assert.deepEqual(errors('plan', { ...PLAN, decision: 'blocked' }), ['odpowiedź.md: questions: decyzja blocked wymaga pytań do właściciela']);
    assert.deepEqual(errors('plan', { ...PLAN, decision: 'split', sub_issues: [{ title: 'a', body: 'b' }] }), [
      'odpowiedź.md: sub_issues: decyzja split wymaga co najmniej dwóch mniejszych issue',
    ]);
    assert.deepEqual(errors('plan', { ...PLAN, questions: ['jaki kolor?'] }), [
      'odpowiedź.md: questions: plan z decyzją planned nie może mieć otwartych pytań',
    ]);
  });

  it('poprawka błędu wymaga testu regresji', () => {
    const implementation = { issue: 7, status: 'done', bugfix: true, acceptance: PLAN.acceptance, assumptions: [] };
    assert.deepEqual(errors('implementation', implementation), ['odpowiedź.md: regression_test: poprawka błędu wymaga testu regresji']);
    assert.deepEqual(errors('implementation', { ...implementation, regression_test: 'e2e/hero.spec.ts › rozmiar' }), []);
  });

  it('blokada implementera wymaga opisu, a stan jest obowiązkowy', () => {
    const implementation = { issue: 7, status: 'blocked', bugfix: false, acceptance: [], assumptions: [] };
    assert.deepEqual(errors('implementation', implementation), ['odpowiedź.md: blocker: status blocked wymaga opisu blokady']);
    assert.deepEqual(errors('implementation', { ...implementation, blocker: 'brak dostępu do sieci' }), []);
    const { status: _, ...missing } = implementation;
    assert.deepEqual(errors('implementation', { ...missing, blocker: 'x' }), ['odpowiedź.md: status: brak wymaganego pola']);
  });

  it('nowe zależności w planie: nazwa i wersja bez znaków powłoki', () => {
    assert.deepEqual(errors('plan', { ...PLAN, dependencies: [{ name: '@tailwindcss/vite', version: '4.1' }, { name: 'vitest', version: '3', dev: true }] }), []);
    const bad = errors('plan', { ...PLAN, dependencies: [{ name: 'x; curl evil', version: '1' }, { name: 'ok', version: 'latest' }] });
    assert.equal(bad.length, 2);
    assert.match(bad[0]!, /dependencies\[0\]\.name/);
    assert.match(bad[1]!, /dependencies\[1\]\.version/);
  });

  it('werdykt bez podsumowania jest odrzucany', () => {
    const verdict = { perspective: 'security', verdict: 'approve', confidence: 0.9, findings: [] };
    assert.deepEqual(errors('verdict', verdict), ['odpowiedź.md: summary: brak wymaganego pola']);
  });
});

describe('output.ts z linii poleceń', () => {
  it('wypisuje sprawdzony JSON albo kończy się błędem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-output-'));
    try {
      writeFileSync(join(dir, 'ok.md'), fenced({ level: 'Low', reason: 'tylko wygląd' }));
      writeFileSync(join(dir, 'bad.md'), fenced({ level: 'Wysoki', reason: 'x' }));
      const ok = spawnSync(process.execPath, [CLI, 'behavior', join(dir, 'ok.md')], { encoding: 'utf8' });
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(JSON.parse(ok.stdout), { level: 'Low', reason: 'tylko wygląd' });
      const bad = spawnSync(process.execPath, [CLI, 'behavior', join(dir, 'bad.md')], { encoding: 'utf8' });
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /level: oczekiwano jednej z wartości: Low, High; jest: "Wysoki"/);
      const usage = spawnSync(process.execPath, [CLI, 'raport'], { encoding: 'utf8' });
      assert.equal(usage.status, 1);
      assert.match(usage.stderr, /^Użycie:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
