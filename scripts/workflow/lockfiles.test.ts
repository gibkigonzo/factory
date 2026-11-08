import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { packageLockChanges, skippedSummary } from './lockfiles.ts';

const lock = (packages: Record<string, object>) => ({ lockfileVersion: 3, packages: { '': { name: 'app' }, ...packages } });
const npm = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

describe('lockfile dla recenzentów', () => {
  it('dodane, usunięte i zmienione pakiety z package-lock.json', () => {
    const base = lock({ 'node_modules/a': { version: '1.0.0', resolved: npm('a', '1.0.0') }, 'node_modules/old': { version: '2.0.0' } });
    const head = lock({
      'node_modules/a': { version: '1.1.0', resolved: npm('a', '1.1.0') },
      'node_modules/@scope/b': { version: '3.0.0', resolved: npm('b', '3.0.0'), dev: true },
      'node_modules/x/node_modules/c': { version: '0.1.0', resolved: 'https://evil.example.com/c.tgz', optional: true },
    });
    const changes = packageLockChanges(base, head);
    assert.deepEqual(changes.added.map((p) => [p.name, p.version, p.host]), [
      ['@scope/b', '3.0.0', 'registry.npmjs.org'],
      ['c', '0.1.0', 'evil.example.com'],
    ]);
    assert.deepEqual(changes.removed.map((p) => p.name), ['old']);
    assert.deepEqual(changes.changed, [{ name: 'a', from: '1.0.0', to: '1.1.0' }]);

    const summary = skippedSummary([{ path: 'package-lock.json', added: 30, deleted: 4, lock: changes }, { path: 'pnpm-lock.yaml', added: 2, deleted: 0 }]);
    assert.match(summary, /## `package-lock\.json`: \+30 \/ −4 linii/);
    assert.match(summary, /- `@scope\/b@3\.0\.0` \(dev\)\n/);
    assert.match(summary, /- `c@0\.1\.0` \(opcjonalny\) — \*\*host spoza rejestru npm: evil\.example\.com\*\*/);
    assert.match(summary, /- `a`: 1\.0\.0 → 1\.1\.0/);
    assert.match(summary, /## `pnpm-lock\.yaml`: \+2 \/ −0 linii/);
    assert.equal(skippedSummary([]), '');
  });

  it('CLI: diff bez lockfile, streszczenie obok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-lock-'));
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock({}), null, 2));
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock({ 'node_modules/z': { version: '9.0.0', resolved: npm('z', '9.0.0') } }), null, 2));
      writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
      git('commit', '-qam', 'head');
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ files: { lockfiles: ['**/package-lock.json'], generated: [] } }));
      const cli = spawnSync(process.execPath, [new URL('./cli.ts', import.meta.url).pathname, 'review-diff', '--base', 'HEAD~1', '--config', 'config.json', '--out', 'diff.patch', '--summary', 'skipped.md'], { cwd: dir, encoding: 'utf8' });
      assert.equal(cli.status, 0, cli.stderr);
      const diff = readFileSync(join(dir, 'diff.patch'), 'utf8');
      assert.match(diff, /a\.ts/);
      assert.doesNotMatch(diff, /package-lock/);
      assert.match(readFileSync(join(dir, 'skipped.md'), 'utf8'), /- `z@9\.0\.0`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
