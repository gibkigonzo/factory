import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evidenceRule } from './evidence-rule.ts';
import { changed, configWith, fullEvidence } from './fixtures.ts';
import type { Evidence, Finding } from './types.ts';

const config = configWith();
const files = [changed('src/components/A.vue')];
const evidence = fullEvidence(config);
const reviews = evidence.reviews!;

function result(override: Evidence = {}, changedFiles = files) {
  return evidenceRule(changedFiles, { ...evidence, ...override }, config);
}

describe('reguła 5: komplet dowodów daje Low', () => {
  it('wszystkie warunki spełnione', () => {
    assert.deepEqual(result(), { rule: 'evidence', name: 'Dowody', level: 'Low', reasons: ['komplet dowodów dla Low'] });
  });

  it('poprawka z testem regresji', () => {
    assert.equal(result({ bugfix: true, regression_test: { fails_on_base: true, passes_on_head: true } }).level, 'Low');
  });

  it('pewność równa progowi 0,8 wystarcza', () => {
    assert.equal(result({ reviews: [{ ...reviews[0]!, confidence: 0.8 }, ...reviews.slice(1)] }).level, 'Low');
  });

  it('przeniesiony znacznik i znacznik poza kodem nie odbierają Low', () => {
    const moved = changed('src/a.ts', { addedLines: ['// @ts-ignore'], removedLines: ['// @ts-ignore'] });
    const docs = changed('docs/lint.md', { addedLines: ['użyj eslint-disable tylko wyjątkowo'] });
    assert.equal(result({}, [moved, docs]).level, 'Low');
  });
});

describe('reguła 5: braki dają Medium', () => {
  const cases: [string, Evidence, string][] = [
    ['czerwone CI', { ci: 'failure' }, 'CI: failure'],
    ['brak kryteriów', { acceptance: [] }, 'brak kryteriów akceptacji'],
    ['kryterium bez dowodu', { acceptance: [{ criterion: 'menu działa' }] }, 'kryterium bez dowodu: „menu działa”'],
    ['poprawka bez testu regresji', { bugfix: true }, 'poprawka błędu bez testu, który nie przechodzi przed zmianą, a przechodzi po niej'],
    ['brak werdyktu', { reviews: reviews.slice(1) }, 'brak werdyktu recenzenta: correctness'],
    ['recenzenci się różnią', { reviews: [{ ...reviews[0]!, verdict: 'request_changes' }, ...reviews.slice(1)] }, 'recenzent correctness: request_changes'],
    ['pewność poniżej 0,8', { reviews: [{ ...reviews[0]!, confidence: 0.79 }, ...reviews.slice(1)] }, 'recenzent correctness: pewność 0.79 poniżej 0.8'],
  ];
  for (const [title, override, reason] of cases) {
    it(title, () => {
      assert.deepEqual([result(override).level, result(override).reasons], ['Medium', [reason]]);
    });
  }

  it('dodatkowe perspektywy z factory.yml też muszą dać approve', () => {
    const extra = configWith('reviewers:\n  extra: [accessibility]\n');
    assert.deepEqual(evidenceRule(files, evidence, extra).reasons, ['brak werdyktu recenzenta: accessibility']);
  });

  it('nowe wyłączenie reguły lub testu', () => {
    const file = changed('src/a.ts', { addedLines: ['// eslint-disable-next-line', 'x()'], additions: 2 });
    assert.deepEqual(result({}, [file]).reasons, ['nowy znacznik wyłączenia „eslint-disable” w src/a.ts']);
    const skipped = changed('src/a.test.ts', { addedLines: ["it.skip('menu', () => {})"] });
    assert.equal(result({}, [skipped]).level, 'Medium');
  });
});

describe('reguła 5: werdykty recenzentów', () => {
  const finding: Finding = { severity: 'medium', file: 'src/components/A.vue', line: 1, issue: 'brak alt', evidence: '<img src="a.png">' };
  const withFinding = (f: Finding) => [{ ...reviews[0]!, findings: [f] }, ...reviews.slice(1)];
  const component = changed('src/components/A.vue', { addedLines: ['<img src="a.png">'], contextLines: ['<template>'] });

  it('approve z uwagą o wadze high liczy się jak request_changes', () => {
    const reasons = result({ reviews: withFinding({ ...finding, severity: 'high' }) }, [component]).reasons;
    assert.deepEqual(reasons, ['recenzent correctness: approve z uwagą o wadze high liczy się jak request_changes']);
  });

  it('cytat z uwagi musi występować w diffie', () => {
    assert.equal(result({ reviews: withFinding(finding) }, [component]).level, 'Low');
    assert.equal(result({ reviews: withFinding({ ...finding, evidence: '<template>' }) }, [component]).level, 'Low');
    const invented = result({ reviews: withFinding({ ...finding, evidence: 'console.log(token)' }) }, [component]);
    assert.deepEqual(invented.reasons, ['recenzent correctness: cytat nie występuje w diffie (src/components/A.vue:1)']);
    const otherFile = result({ reviews: withFinding({ ...finding, file: 'src/other.ts' }) }, [component]);
    assert.equal(otherFile.level, 'Medium');
  });
});

describe('reguła 5: usunięte testy, spadek pokrycia i nierozstrzygnięte uwagi dają High', () => {
  it('usunięty plik testów, gdy testowany kod został', () => {
    const deleted = changed('src/components/A.test.ts', { status: 'deleted', additions: 0, deletions: 20 });
    assert.deepEqual(result({}, [deleted]).reasons, ['High: usunięty plik testów, a testowany kod został: src/components/A.test.ts']);
  });

  it('usunięcie testów razem z testowanym kodem to tylko Medium', () => {
    const test = changed('src/components/A.test.ts', { status: 'deleted', additions: 0, deletions: 20 });
    const code = changed('src/components/A.vue', { status: 'deleted', additions: 0, deletions: 40 });
    assert.deepEqual([result({}, [test, code]).level, result({}, [test, code]).reasons], [
      'Medium',
      ['usunięty plik testów razem z testowanym kodem: src/components/A.test.ts'],
    ]);
  });

  it('ubyło asercji w teście', () => {
    const file = changed('src/a.test.ts', {
      addedLines: ['expect(a).toBe(1);'],
      removedLines: ['expect(a).toBe(1);', 'expect(b).toBe(2);'],
    });
    assert.deepEqual([result({}, [file]).level, result({}, [file]).reasons], ['High', ['High: ubyło asercji w src/a.test.ts: 1']]);
    const reworded = changed('src/a.test.ts', { addedLines: ['expect(a).toEqual(1);'], removedLines: ['expect(a).toBe(1);'] });
    assert.equal(result({}, [reworded]).level, 'Low');
  });

  it('pokrycie zmienionych linii poniżej progu 80%', () => {
    assert.deepEqual(result({ diff_coverage: 79.5 }).reasons, ['High: pokrycie zmienionych linii 79.5%, próg 80%']);
    assert.equal(result({ diff_coverage: 80 }).level, 'Low');
    assert.equal(result({}).level, 'Low', 'bez danych o pokryciu warunek nie działa');
  });

  it('uwagi nierozstrzygnięte po 3 rundach poprawek', () => {
    const open = [{ ...reviews[0]!, verdict: 'request_changes' as const }, ...reviews.slice(1)];
    assert.equal(result({ reviews: open, review_rounds: 2 }).level, 'Medium');
    assert.deepEqual(result({ reviews: open, review_rounds: 3 }).reasons, [
      'High: uwagi nierozstrzygnięte po 3 rundach poprawek (correctness)',
      'recenzent correctness: request_changes',
    ]);
    assert.equal(result({ review_rounds: 5 }).level, 'Low');
  });
});
