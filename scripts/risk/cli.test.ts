import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const CLI = new URL('../risk-rules.ts', import.meta.url).pathname;
const TEMPLATE = new URL('../../templates/factory.yml', import.meta.url).pathname;

let repo: string;

function run(...args: string[]): void {
  execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { stdio: 'ignore' });
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, '--repo', repo, ...args], { encoding: 'utf8' });
}

describe('risk-rules.ts na repo git', () => {
  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'factory-risk-'));
    run('init', '-q', '-b', 'main');
    write('factory.yml', readFileSync(TEMPLATE, 'utf8'));
    write('src/components/Button.vue', '<template><button /></template>\n');
    write('src/components/Button.test.ts', 'test("button", () => {});\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'base');
    run('checkout', '-q', '-b', 'feature');
    write('src/components/Button.vue', '<template><button class="primary" /></template>\n');
    run('commit', '-q', '-am', 'kolor przycisku');
    run('checkout', '-q', '-b', 'factory-change', 'main');
    write('factory.yml', `${readFileSync(TEMPLATE, 'utf8')}wip_limit: 9\n`);
    run('commit', '-q', '-am', 'zmiana kontraktu');
  });

  after(() => rmSync(repo, { recursive: true, force: true }));

  it('ocenia zmianę komponentu i czyta factory.yml z bazy', () => {
    const result = cli('--base', 'main', '--head', 'feature', '--json');
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.config, 'factory.yml (baza)');
    assert.deepEqual(output.rules.map((r: { level: string }) => r.level), ['Low', 'Medium', 'Low', 'Low', 'Medium']);
    assert.equal(output.level, 'Medium');
  });

  it('z kompletem dowodów zmiana komponentu jest Low', () => {
    const reviews = ['correctness', 'tests', 'security', 'maintainability', 'spec'].map((perspective) => ({
      perspective,
      verdict: 'approve',
      confidence: 0.9,
      summary: 'sprawdzony kolor przycisku i test',
      findings: [],
    }));
    const evidence = {
      ci: 'success',
      acceptance: [{ criterion: 'przycisk ma klasę primary', evidence: 'test: Button.test.ts' }],
      reviews,
      behavior: { level: 'Low', reason: 'tylko wygląd' },
    };
    write('evidence.json', JSON.stringify(evidence));
    const result = cli('--base', 'main', '--head', 'feature', '--evidence', join(repo, 'evidence.json'), '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).level, 'Low');
  });

  it('zmiana factory.yml jest zawsze High', () => {
    const result = cli('--base', 'main', '--head', 'factory-change');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Poziom ryzyka: High/);
    assert.match(result.stdout, /factory\.yml: strefa factory/);
  });

  it('błędne dowody i brak --base kończą się czytelnym błędem', () => {
    write('bad.json', JSON.stringify({ ci: 'green' }));
    const bad = cli('--base', 'main', '--head', 'feature', '--evidence', join(repo, 'bad.json'));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /bad\.json: ci: oczekiwano jednej z wartości: success, failure, pending; jest: "green"/);
    const noBase = cli();
    assert.equal(noBase.status, 1);
    assert.match(noBase.stderr, /podaj --base/);
  });
});
