import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changed, configWith } from '../risk/fixtures.ts';
import { isTriggered, loadCatalog, modelFor, panelFor, parsePerspective, resolvePerspectives } from './perspectives.ts';
import type { PerspectiveDef } from './perspectives.ts';

const catalog = loadCatalog();
const byName = (name: string) => catalog.find((d) => d.name === name)!;

const BRAND = `---
name: brand
title: Zgodność z marką
description: Sprawdza kolory i typografię marki.
paths: ["src/components/**"]
---

Kolory tylko z palety marki.
`;

function project(text = BRAND, file = '.factory/perspectives/brand.md'): PerspectiveDef {
  const result = parsePerspective(text, file, 'project');
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.def;
}

describe('katalog perspektyw', () => {
  it('ma perspektywy podstawowe i gotowe do włączenia', () => {
    const names = catalog.map((d) => d.name);
    for (const name of ['correctness', 'tests', 'security', 'maintainability', 'spec']) assert.ok(names.includes(name), name);
    for (const name of ['ux-visual', 'accessibility-web', 'web-performance', 'devils-advocate']) assert.ok(names.includes(name), name);
  });

  it('perspektywy podstawowe działają zawsze, dodatkowe mają warunki', () => {
    for (const name of configWith().reviewers.perspectives) assert.equal(byName(name).paths, undefined);
    assert.ok(byName('ux-visual').paths?.includes('**/*.vue'));
    assert.deepEqual(byName('devils-advocate').zones, ['data', 'security', 'release', 'dependencies']);
  });
});

describe('plik perspektywy', () => {
  it('poprawny plik projektu', () => {
    assert.deepEqual({ ...project(), text: '' }, {
      name: 'brand',
      title: 'Zgodność z marką',
      description: 'Sprawdza kolory i typografię marki.',
      paths: ['src/components/**'],
      source: 'project',
      file: '.factory/perspectives/brand.md',
      text: '',
    });
  });

  it('błędy wskazują plik i pole', () => {
    const errors = (text: string, file = '.factory/perspectives/brand.md') => {
      const result = parsePerspective(text, file, 'project');
      return result.ok ? [] : result.errors;
    };
    assert.deepEqual(errors(BRAND.replace('title: Zgodność z marką\n', '')), ['.factory/perspectives/brand.md: title: brak wymaganego pola']);
    assert.deepEqual(errors(BRAND, '.factory/perspectives/marka.md'), ['.factory/perspectives/marka.md: name: nazwa musi być taka jak nazwa pliku: „marka”']);
    assert.match(errors(BRAND.replace('paths: ["src/components/**"]', 'paths: ["/abs/**"]')).join(), /paths\[0\]: nieprawidłowy wzorzec/);
    assert.deepEqual(errors(BRAND.replace('Kolory tylko z palety marki.\n', '')), ['.factory/perspectives/brand.md: brak kryteriów pod frontmatterem']);
  });
});

describe('włączone perspektywy', () => {
  it('dodatkowe z katalogu i z projektu', () => {
    const config = configWith('reviewers:\n  extra: [ux-visual, brand]\n');
    const { enabled, errors } = resolvePerspectives(config, catalog, [project()]);
    assert.deepEqual(errors, []);
    assert.deepEqual(enabled.map((d) => `${d.name}:${d.source}`).slice(-2), ['ux-visual:catalog', 'brand:project']);
  });

  it('nieznana perspektywa podpowiada katalog i plik do dodania', () => {
    const config = configWith('reviewers:\n  extra: [i18n]\n');
    const [error] = resolvePerspectives(config, catalog, []).errors;
    assert.match(error!, /^factory\.yml: reviewers\.extra\[0\]: nieznana perspektywa „i18n”; w katalogu fabryki: .*ux-visual.*; własną dodaj jako \.factory\/perspectives\/i18n\.md$/);
  });

  it('perspektywa projektu nie może zająć nazwy z katalogu i musi używać znanych stref', () => {
    const clash = project(BRAND.replace('name: brand', 'name: security'), '.factory/perspectives/security.md');
    const badZone = project(BRAND.replace('paths: ["src/components/**"]', 'zones: [payments]'));
    const { errors } = resolvePerspectives(configWith(), catalog, [clash, badZone]);
    assert.deepEqual(errors, [
      '.factory/perspectives/security.md: perspektywa „security” jest już w katalogu fabryki; wybierz inną nazwę',
      '.factory/perspectives/brand.md: zones[0]: nieznana strefa „payments”; dostępne: data, security, release, dependencies, factory, shared, code',
    ]);
  });
});

describe('kiedy perspektywa ocenia zmianę', () => {
  const config = configWith();

  it('bez warunków zawsze, z paths gdy diff ich dotyka', () => {
    assert.equal(isTriggered(byName('security'), [changed('docs/a.md')], config).run, true);
    assert.deepEqual(isTriggered(byName('ux-visual'), [changed('src/components/Hero.vue')], config), {
      run: true,
      reason: 'diff dotyka src/components/Hero.vue',
    });
    assert.equal(isTriggered(byName('ux-visual'), [changed('src/lib/api.ts')], config).run, false);
  });

  it('z zones, gdy diff dotyka strefy', () => {
    assert.deepEqual(isTriggered(byName('devils-advocate'), [changed('src/auth/login.ts')], config), {
      run: true,
      reason: 'diff dotyka strefy security (src/auth/login.ts)',
    });
    assert.equal(isTriggered(byName('devils-advocate'), [changed('src/components/A.vue')], config).run, false);
  });

  it('skład panelu: podstawowe zawsze, dodatkowe według warunków', () => {
    const withExtra = configWith('reviewers:\n  extra: [ux-visual, devils-advocate]\n');
    const { enabled } = resolvePerspectives(withExtra, catalog, []);
    const panel = panelFor(enabled, [changed('src/components/Hero.vue')], withExtra);
    assert.deepEqual(panel.run.map((e) => e.def.name), ['correctness', 'tests', 'security', 'maintainability', 'spec', 'ux-visual']);
    assert.deepEqual(panel.skipped.map((e) => e.def.name), ['devils-advocate']);
  });

  it('model recenzenta: własny wpis albo domyślny', () => {
    const custom = configWith('reviewers:\n  extra: [ux-visual]\nmodels:\n  reviewers:\n    ux-visual: haiku\n');
    assert.equal(modelFor(custom, 'ux-visual'), 'haiku');
    assert.equal(modelFor(custom, 'security'), 'opus');
    assert.equal(modelFor(custom, 'tests'), 'sonnet');
  });
});
