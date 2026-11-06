import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changed, configWith } from './fixtures.ts';
import { checkGates, fromEslint } from './gates.ts';
import type { FileSize, LintFinding } from './types.ts';

const config = configWith();
const PATH = 'src/lib/a.ts';

function fileGate(size: FileSize, cfg = config, path = PATH) {
  return checkGates([changed(path)], { [path]: size }, [], cfg);
}

describe('bramka długości pliku', () => {
  it('ostrzeżenie powyżej 300 linii, blokada powyżej 500', () => {
    assert.equal(fileGate({ after: 300 }).status, 'pass');
    assert.equal(fileGate({ after: 301 }).status, 'warn');
    assert.equal(fileGate({ after: 500 }).status, 'warn');
    assert.equal(fileGate({ after: 501 }).status, 'block');
  });

  it('plik, który już ma ponad 500 linii, nie może urosnąć', () => {
    assert.equal(fileGate({ before: 600, after: 601 }).status, 'block');
    assert.equal(fileGate({ before: 600, after: 600 }).status, 'warn');
    assert.equal(fileGate({ before: 600, after: 550 }).status, 'warn');
  });

  it('wyjątek z factory.yml podnosi limit dla ścieżki', () => {
    const withException = configWith(`exceptions:\n  - { path: "${PATH}", gate: file_lines, max: 800, reason: stary moduł }\n`);
    assert.equal(fileGate({ after: 700 }, withException).status, 'warn');
    assert.equal(fileGate({ after: 801 }, withException).status, 'block');
    assert.equal(fileGate({ after: 700 }, withException, 'src/lib/b.ts').status, 'block');
  });

  it('nie dotyczy plików, które nie są kodem, ani usuniętych', () => {
    assert.equal(fileGate({ after: 900 }, config, 'docs/long.md').status, 'pass');
    const deleted = checkGates([changed(PATH, { status: 'deleted' })], { [PATH]: { before: 900 } }, [], config);
    assert.equal(deleted.status, 'pass');
  });
});

describe('bramki z lintera: funkcja, złożoność, zagnieżdżenie', () => {
  const finding = (gate: LintFinding['gate'], value: number, path = PATH): LintFinding => ({ path, line: 7, gate, value });
  const lintGate = (findings: LintFinding[], cfg = config) => checkGates([changed(PATH)], {}, findings, cfg);

  it('progi z base: funkcja 50 linii, złożoność 15, zagnieżdżenie 4', () => {
    assert.equal(lintGate([finding('function_lines', 50), finding('complexity', 15), finding('nesting', 4)]).status, 'pass');
    assert.equal(lintGate([finding('function_lines', 51)]).status, 'block');
    assert.equal(lintGate([finding('complexity', 16)]).status, 'block');
    assert.deepEqual(lintGate([finding('nesting', 5)]).findings, [
      { path: PATH, gate: 'nesting', status: 'block', message: 'zagnieżdżenie 5 w linii 7, limit 4' },
    ]);
  });

  it('liczą się tylko zmienione pliki', () => {
    assert.equal(lintGate([finding('complexity', 30, 'src/lib/untouched.ts')]).status, 'pass');
  });

  it('wyjątek podnosi próg', () => {
    const withException = configWith(`exceptions:\n  - { path: "src/lib/**", gate: complexity, max: 20, reason: parser }\n`);
    assert.equal(lintGate([finding('complexity', 20)], withException).status, 'pass');
    assert.equal(lintGate([finding('complexity', 21)], withException).status, 'block');
  });
});

describe('raport ESLint', () => {
  it('wyciąga wartości z komunikatów reguł bramek', () => {
    const report = [
      {
        filePath: '/repo/src/lib/a.ts',
        messages: [
          { ruleId: 'complexity', line: 3, message: "Function 'f2' has a complexity of 20. Maximum allowed is 15." },
          { ruleId: 'max-depth', line: 9, message: 'Blocks are nested too deeply (5). Maximum allowed is 4.' },
          { ruleId: 'max-lines-per-function', line: 1, message: "Function 'run' has too many lines (61). Maximum allowed is 50." },
          { ruleId: 'no-unused-vars', line: 2, message: "'x' is defined but never used." },
        ],
      },
    ];
    assert.deepEqual(fromEslint(report, '/repo'), [
      { path: 'src/lib/a.ts', line: 3, gate: 'complexity', value: 20 },
      { path: 'src/lib/a.ts', line: 9, gate: 'nesting', value: 5 },
      { path: 'src/lib/a.ts', line: 1, gate: 'function_lines', value: 61 },
    ]);
  });

  it('odrzuca raport w złym formacie', () => {
    assert.throws(() => fromEslint({}, '/repo'), /oczekiwano listy plików/);
  });
});
