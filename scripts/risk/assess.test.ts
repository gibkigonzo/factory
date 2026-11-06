import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assess, formatAssessment } from './assess.ts';
import { changed, configWith, fullEvidence, input } from './fixtures.ts';
import { parseEvidence } from './evidence.ts';

const config = configWith();
const component = changed('src/components/Button.vue', { additions: 12 });
const repoWithTests = ['src/components/Button.vue', 'src/components/Button.test.ts'];

describe('ocena zmiany', () => {
  it('Low, gdy wszystkie reguły dają Low', () => {
    const result = assess(input([component], { repoFiles: repoWithTests, evidence: fullEvidence(config) }), config);
    assert.equal(result.level, 'Low');
    assert.deepEqual(result.rules.map((r) => r.rule), ['zones', 'behavior', 'tests', 'size', 'evidence']);
  });

  it('poziom to maksimum reguł', () => {
    const evidence = { ...fullEvidence(config), behavior: { level: 'High' as const, reason: 'migracja danych' } };
    const result = assess(input([component], { repoFiles: repoWithTests, evidence }), config);
    assert.equal(result.level, 'High');
    assert.deepEqual(result.rules.map((r) => r.level), ['Low', 'High', 'Low', 'Low', 'Low']);
  });

  it('medium_veto_hours: 0 zamienia Medium na High', () => {
    const noVeto = configWith('risk:\n  medium_veto_hours: 0\n');
    const result = assess(input([changed('src/lib/a.ts')], { repoFiles: ['src/lib/a.test.ts'], evidence: fullEvidence(noVeto) }), noVeto);
    assert.equal(result.level, 'High');
    assert.deepEqual(result.notes, ['medium_veto_hours: 0, więc Medium liczy się jak High']);
  });

  it('za duża zmiana dostaje znacznik podziału', () => {
    const result = assess(input([changed('src/components/Big.vue', { additions: 401 })]), config);
    assert.equal(result.split, true);
    assert.match(formatAssessment(result), /^Poziom ryzyka: High \(za duża zmiana: wraca do planera do podziału\)/);
  });

  it('bramki są osobno od poziomu ryzyka', () => {
    const result = assess(
      input([component], { repoFiles: repoWithTests, evidence: fullEvidence(config), sizes: { [component.path]: { after: 700 } } }),
      config,
    );
    assert.equal(result.level, 'Low');
    assert.equal(result.gates.status, 'block');
  });

  it('ten sam diff zawsze daje ten sam wynik, niezależnie od kolejności plików', () => {
    const files = [changed('src/lib/a.ts'), component, changed('scripts/x.sh'), changed('package.json')];
    const first = assess(input(files, { evidence: fullEvidence(config) }), config);
    const second = assess(input([...files].reverse(), { evidence: fullEvidence(config) }), config);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('podsumowanie wymienia poziom, reguły i bramki', () => {
    const text = formatAssessment(assess(input([component]), config));
    assert.match(text, /^Poziom ryzyka: Medium/);
    assert.match(text, /3\. Brak testów: Medium/);
    assert.match(text, /Bramki jakości: przechodzą/);
  });
});

describe('plik z dowodami', () => {
  it('przyjmuje poprawne dowody', () => {
    assert.equal(parseEvidence(fullEvidence(config), 'evidence.json').ok, true);
  });

  it('błąd wskazuje pole', () => {
    const result = parseEvidence({ ci: 'green', reviews: [{ perspective: 'tests', verdict: 'approve', confidence: 1.5 }] }, 'evidence.json');
    assert.equal(result.ok, false);
    const errors = result.ok ? [] : result.errors;
    assert.ok(errors.includes('evidence.json: ci: oczekiwano jednej z wartości: success, failure, pending; jest: "green"'), errors.join('\n'));
    assert.ok(errors.includes('evidence.json: reviews[0].confidence: oczekiwano liczby od 0 do 1, jest: 1.5'), errors.join('\n'));
    assert.ok(errors.includes('evidence.json: reviews[0].summary: brak wymaganego pola'), errors.join('\n'));
    assert.ok(errors.includes('evidence.json: reviews[0].findings: brak wymaganego pola'), errors.join('\n'));
  });
});
