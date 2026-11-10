import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const PANEL = new URL('./panel.ts', import.meta.url).pathname;
const RISK = new URL('../risk-rules.ts', import.meta.url).pathname;
const VALIDATE = new URL('../config/cli.ts', import.meta.url).pathname;

const FACTORY_YML = `project: test
extends: [base, typescript, web]
commands: { test: npm test, build: npm run build }
reviewers:
  extra: [ux-visual, devils-advocate, brand]
models:
  reviewers:
    ux-visual: haiku
`;

const BRAND = `---
name: brand
title: Zgodność z marką
description: Sprawdza kolory i typografię marki.
---

Kolory tylko z palety marki.
`;

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { stdio: 'ignore' });
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function run(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('skład panelu na repo git', () => {
  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'factory-panel-'));
    git('init', '-q', '-b', 'main');
    write('factory.yml', FACTORY_YML);
    write('.factory/perspectives/brand.md', BRAND);
    write('src/components/Hero.vue', '<template><h1>Lorem</h1></template>\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
    write('src/components/Hero.vue', '<template><h1 class="big">Lorem</h1></template>\n');
    write('.factory/perspectives/brand.md', BRAND.replace('Kolory tylko z palety marki.', 'Wszystko wolno.'));
    git('commit', '-q', '-am', 'nagłówek');
  });

  after(() => rmSync(repo, { recursive: true, force: true }));

  it('uruchamia podstawowe perspektywy, ux-visual i perspektywę projektu, a pomija adwokata diabła', () => {
    const out = join(repo, '.factory/review');
    const result = run(PANEL, '--repo', repo, '--base', 'main', '--head', 'feature', '--out', out);
    assert.equal(result.status, 0, result.stderr);
    const panel = JSON.parse(result.stdout);
    assert.deepEqual(
      panel.run.map((m: { name: string; agent: string; model: string }) => `${m.name}:${m.agent}:${m.model}`),
      [
        'correctness:review-correctness:sonnet',
        'tests:review-tests:sonnet',
        'security:review-security:opus',
        'maintainability:review-maintainability:sonnet',
        'spec:review-spec:sonnet',
        'ux-visual:review-ux-visual:haiku',
        'brand:review-project:sonnet',
      ],
    );
    assert.deepEqual(panel.skipped, [{ name: 'devils-advocate', reason: 'diff nie dotyka plików ani stref tej perspektywy' }]);
    const screenshots = panel.run.filter((m: { screenshots?: boolean }) => m.screenshots).map((m: { name: string }) => m.name);
    assert.deepEqual(screenshots, ['ux-visual'], 'zrzuty dostaje tylko perspektywa, która ich używa');
    const brand = panel.run.find((m: { name: string }) => m.name === 'brand');
    assert.equal(brand.criteria, join(out, 'perspectives/brand.md'));
  });

  it('kryteria perspektywy projektu pochodzą z bazy, a nie ze zmiany', () => {
    const criteria = readFileSync(join(repo, '.factory/review/perspectives/brand.md'), 'utf8');
    assert.match(criteria, /Kolory tylko z palety marki\./);
    assert.doesNotMatch(criteria, /Wszystko wolno/);
  });

  it('reguły ryzyka wymagają werdyktu tylko od perspektyw z panelu', () => {
    const result = run(RISK, '--repo', repo, '--base', 'main', '--head', 'feature', '--json');
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout).rules.find((r: { rule: string }) => r.rule === 'evidence');
    const missing = evidence.reasons.filter((r: string) => r.startsWith('brak werdyktu recenzenta'));
    assert.ok(missing.includes('brak werdyktu recenzenta: ux-visual'));
    assert.ok(missing.includes('brak werdyktu recenzenta: brand'));
    assert.ok(!missing.includes('brak werdyktu recenzenta: devils-advocate'));
  });

  it('walidacja wskazuje brakującą perspektywę i podpowiada, jak ją dodać', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-validate-'));
    try {
      writeFileSync(join(dir, 'factory.yml'), FACTORY_YML);
      const missing = run(VALIDATE, join(dir, 'factory.yml'));
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /reviewers\.extra\[2\]: nieznana perspektywa „brand”; .*własną dodaj jako \.factory\/perspectives\/brand\.md/);
      mkdirSync(join(dir, '.factory/perspectives'), { recursive: true });
      writeFileSync(join(dir, '.factory/perspectives/brand.md'), BRAND);
      const ok = run(VALIDATE, join(dir, 'factory.yml'));
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /perspektywy: .*ux-visual, devils-advocate, brand/);
      assert.ok(existsSync(join(dir, 'factory.yml')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
