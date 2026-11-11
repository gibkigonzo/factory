import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = new URL('./publish-branch.sh', import.meta.url).pathname;

describe('publikacja na gałęzi', () => {
  it('jeden commit bez historii, tylko pliki CSV, JSON i Markdown; gałąź spoza factory-* odrzucona', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-publish-'));
    const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' }).stdout.trim();
    try {
      const remote = join(dir, 'remote.git');
      git('init', '-q', '--bare', remote);
      const src = join(dir, 'src');
      mkdirSync(join(src, 'sub'), { recursive: true });
      for (const [name, body] of [['journal.csv', 'a'], ['journal.json', '{}'], ['journal.md', '#'], ['evil.sh', 'x'], ['sub/x.csv', 'x']]) {
        writeFileSync(join(src, name!), body!);
      }
      // Katalog względny, tak jak w workflowie: skrypt przechodzi do katalogu tymczasowego, a pliki ma znaleźć.
      const publish = (branch: string) => spawnSync('bash', [SCRIPT, remote, 'src', branch, 'Statystyki'], { encoding: 'utf8', cwd: dir });
      for (let i = 0; i < 2; i++) {
        const run = publish('factory-journal');
        assert.equal(run.status, 0, run.stderr);
      }
      assert.deepEqual(git('--git-dir', remote, 'ls-tree', '--name-only', 'factory-journal').split('\n'), ['journal.csv', 'journal.json', 'journal.md']);
      assert.equal(git('--git-dir', remote, 'rev-list', '--count', 'factory-journal'), '1', 'gałąź nie rośnie');
      assert.equal(publish('main').status, 2);
      assert.equal(git('--git-dir', remote, 'branch', '--list', 'main'), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
