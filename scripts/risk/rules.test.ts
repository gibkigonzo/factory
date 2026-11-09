import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changed, configWith } from './fixtures.ts';
import { loadConfig } from '../config/load.ts';
import { behaviorRule, sizeRule, testsRule, zoneOf, zonesRule } from './rules.ts';

const config = configWith();

describe('reguła 1: strefy', () => {
  it('zwykły kod to Low, logika współdzielona Medium', () => {
    assert.equal(zonesRule([changed('src/components/Button.vue')], config).level, 'Low');
    assert.equal(zonesRule([changed('src/lib/api.ts')], config).level, 'Medium');
  });

  it('preset nuxt: komponenty i strony Low, serwer i composables Medium, middleware High', () => {
    const nuxt = loadConfig('project: x\nextends: [base, typescript, web, nuxt]\ncommands: { test: t, build: b }\n', 'factory.yml');
    assert.ok(nuxt.ok, nuxt.ok ? '' : nuxt.errors.join('\n'));
    const level = (path: string) => zoneOf(path, nuxt.config).level;
    assert.equal(level('app/components/SiteHeader.vue'), 'Low');
    assert.equal(level('app/pages/index.vue'), 'Low');
    assert.equal(level('app/composables/useCart.ts'), 'Medium');
    assert.equal(level('app/app.vue'), 'Medium');
    assert.equal(level('server/api/products.get.ts'), 'Medium');
    assert.equal(level('nuxt.config.ts'), 'Medium');
    assert.equal(level('app/middleware/auth.ts'), 'High');
    assert.equal(level('server/middleware/log.ts'), 'High');
  });

  it('plik testów spoza mapy stref liczy się jak code, inna ścieżka spoza mapy dostaje Medium', () => {
    const result = zonesRule([changed('e2e/header.spec.ts'), changed('tests/naming.test.ts')], config);
    assert.equal(result.level, 'Low');
    assert.deepEqual(result.reasons, ['e2e/header.spec.ts: strefa code', 'tests/naming.test.ts: strefa code']);
    assert.equal(zonesRule([changed('e2e/header.spec.ts'), changed('scripts/x.sh')], config).level, 'Medium');
  });

  it('ścieżka spoza mapy stref dostaje Medium', () => {
    const result = zonesRule([changed('scripts/deploy.sh')], config);
    assert.equal(result.level, 'Medium');
    assert.deepEqual(result.reasons, ['scripts/deploy.sh: poza mapą stref']);
  });

  it('plik w dwóch strefach należy do wyższej', () => {
    const result = zonesRule([changed('src/components/middleware.ts')], config);
    assert.equal(result.level, 'High');
    assert.deepEqual(result.reasons, ['src/components/middleware.ts: strefa security']);
  });

  it('poziom zmiany to najwyższe minimum spośród plików', () => {
    const files = [changed('src/components/A.vue'), changed('src/lib/b.ts'), changed('package.json')];
    assert.equal(zonesRule(files, config).level, 'High');
  });

  it('zmiana nazwy liczy też starą ścieżkę', () => {
    const file = changed('docs/ci.yml', { status: 'renamed', oldPath: '.github/workflows/ci.yml' });
    assert.equal(zonesRule([file], config).level, 'High');
  });

  it('projekt dopisuje ścieżki do stref', () => {
    const own = configWith('zones:\n  data: ["src/db/**"]\n');
    assert.equal(zonesRule([changed('src/db/schema.ts')], own).level, 'High');
  });
});

describe('reguła 2: zachowanie i odwracalność', () => {
  it('brak oceny nie pozwala na Low', () => {
    assert.equal(behaviorRule({}).level, 'Medium');
  });

  it('przyjmuje poziom oceniacza', () => {
    assert.equal(behaviorRule({ behavior: { level: 'High', reason: 'zmienia liczenie kwot' } }).level, 'High');
    assert.equal(behaviorRule({ behavior: { level: 'Low', reason: 'tylko wygląd' } }).level, 'Low');
  });

  it('wysokie ryzyko produktowe ze specu daje High bez względu na ocenę', () => {
    const result = behaviorRule({ product_risk: 'high', behavior: { level: 'Low', reason: 'tylko wygląd' } });
    assert.deepEqual([result.level, result.reasons], ['High', ['ryzyko produktowe w specu: wysokie', 'tylko wygląd']]);
    assert.equal(behaviorRule({ product_risk: 'low', behavior: { level: 'Low', reason: 'tylko wygląd' } }).level, 'Low');
  });
});

describe('reguła 3: brak testów', () => {
  it('zwykły kod bez testów to Medium, logika współdzielona bez testów to High', () => {
    assert.equal(testsRule([changed('src/components/A.vue')], [], config).level, 'Medium');
    assert.equal(testsRule([changed('src/lib/a.ts')], [], config).level, 'High');
  });

  it('strefa z testami nie podnosi poziomu', () => {
    const repo = ['src/components/A.vue', 'src/components/A.test.ts'];
    assert.equal(testsRule([changed('src/components/A.vue')], repo, config).level, 'Low');
  });

  it('testy w osobnym katalogu liczą się, gdy projekt przypisze go do strefy', () => {
    const repo = ['e2e/home.spec.ts'];
    assert.equal(testsRule([changed('src/components/A.vue')], repo, config).level, 'Medium');
    const mapped = configWith('zones:\n  code: ["e2e/**"]\n');
    assert.equal(testsRule([changed('src/components/A.vue')], repo, mapped).level, 'Low');
  });

  it('zone_tests wskazuje testy, które sprawdzają strefę spoza jej ścieżek', () => {
    const repo = ['qa/home.spec.ts', 'qa/README.md'];
    const files = [changed('src/components/A.vue'), changed('src/app.ts')];
    assert.equal(testsRule(files, repo, config).level, 'High');
    const mapped = configWith('zone_tests:\n  code: ["qa/**"]\n  shared: ["qa/**"]\n');
    assert.equal(testsRule(files, repo, mapped).level, 'Low');
    const onlyCode = configWith('zone_tests:\n  code: ["qa/**"]\n');
    assert.deepEqual(testsRule(files, repo, onlyCode).reasons, ['strefa shared nie ma testów: Medium → High (src/app.ts)']);
    assert.equal(testsRule(files, ['qa/README.md'], mapped).level, 'High', 'liczą się tylko pliki testów');
  });

  it('nie dotyczy plików, które nie są kodem, samych testów ani ścieżek spoza mapy', () => {
    const files = [changed('docs/guide.md'), changed('src/components/A.test.ts'), changed('scripts/x.ts')];
    assert.equal(testsRule(files, [], config).level, 'Low');
  });
});

describe('reguła 4: rozmiar', () => {
  const lines = (count: number, files = 1) =>
    Array.from({ length: files }, (_, i) => changed(`src/components/F${i}.vue`, { additions: i === 0 ? count - (files - 1) : 1 }));

  it('progi Low: 100 linii i 5 plików', () => {
    assert.equal(sizeRule(lines(100, 5), config).level, 'Low');
    assert.equal(sizeRule(lines(101, 5), config).level, 'Medium');
    assert.equal(sizeRule(lines(10, 6), config).level, 'Medium');
  });

  it('progi Medium: 400 linii i 15 plików, większa zmiana wraca do podziału', () => {
    assert.deepEqual(pick(sizeRule(lines(400, 15), config)), ['Medium', false]);
    assert.deepEqual(pick(sizeRule(lines(401, 15), config)), ['High', true]);
    assert.deepEqual(pick(sizeRule(lines(20, 16), config)), ['High', true]);
  });

  it('za duża zmiana idzie do właściciela dopiero, gdy podziału nie da się zrobić', () => {
    assert.deepEqual(pick(sizeRule(lines(401, 15), config, { split_impossible: true })), ['High', false]);
    assert.deepEqual(pick(sizeRule(lines(100, 5), config, { split_impossible: true })), ['Low', false]);
  });

  it('linie usunięte też się liczą', () => {
    assert.equal(sizeRule([changed('src/a.ts', { additions: 60, deletions: 41 })], config).level, 'Medium');
  });

  it('testy, lockfile, pliki generowane i tłumaczenia się nie liczą', () => {
    const files = [
      changed('src/components/A.test.ts', { additions: 500 }),
      changed('package-lock.json', { additions: 3000 }),
      changed('dist/app.js', { additions: 900 }),
      changed('locales/pl.json', { additions: 300 }),
      changed('src/components/A.vue', { additions: 10 }),
    ];
    const result = sizeRule(files, config);
    assert.equal(result.level, 'Low');
    assert.ok(result.reasons.includes('pominięte pliki (testy, lockfile, generowane, tłumaczenia): 4'));
  });

  it('plik binarny liczy się jako plik bez linii', () => {
    const images = Array.from({ length: 6 }, (_, i) => changed(`public/${i}.png`, { binary: true, additions: 0 }));
    assert.equal(sizeRule(images, config).level, 'Medium');
  });
});

function pick(result: { level: string; split: boolean }): [string, boolean] {
  return [result.level, result.split];
}
