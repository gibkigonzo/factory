import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = new URL('./base-config.sh', import.meta.url).pathname;

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-base-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

describe('kontrakt z gałęzi bazowej', () => {
  it('bez katalogu perspektyw wyciąga sam factory.yml (na macOS zapas po tar się nie uruchamiał)', () => {
    const dir = repo({ 'factory.yml': 'project: x\n' });
    try {
      execFileSync('bash', [SCRIPT, 'main', join(dir, 'out')], { cwd: dir });
      assert.equal(readFileSync(join(dir, 'out/factory.yml'), 'utf8'), 'project: x\n');
      assert.ok(!existsSync(join(dir, 'out/.factory')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('z katalogiem perspektyw wyciąga też perspektywy projektu', () => {
    const dir = repo({ 'factory.yml': 'project: x\n', '.factory/perspectives/p.md': 'perspektywa\n' });
    try {
      execFileSync('bash', [SCRIPT, 'main', join(dir, 'out')], { cwd: dir });
      assert.equal(readFileSync(join(dir, 'out/.factory/perspectives/p.md'), 'utf8'), 'perspektywa\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bez factory.yml na gałęzi bazowej kończy się błędem zamiast pustej konfiguracji', () => {
    const dir = repo({ 'README.md': 'x\n' });
    try {
      assert.throws(() => execFileSync('bash', [SCRIPT, 'main', join(dir, 'out')], { cwd: dir, stdio: 'pipe' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
