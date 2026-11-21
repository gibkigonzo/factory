import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Hook startu sesji w projekcie pobiera z fabryki skille i reguły. Test podmienia `git clone` na kopię tego repo,
// więc sprawdza cały skrypt bez sieci.
const ROOT = new URL('../../', import.meta.url).pathname;
const HOOK = join(ROOT, 'templates/claude/hooks/factory.sh');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const sessionSkills = () => read('templates/claude/session-skills.txt').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);

function project(ref: string) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-hook-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, '.github/workflows/factory.yml'), read('templates/workflows/factory.yml').replace(/factory_ref: main/, `factory_ref: ${ref}`));
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\ncase "$*" in\n  clone*) echo "$*" >> "${dir}/.clone.log"; for last; do :; done; mkdir -p "$last" && cp -R "${ROOT}skills" "${ROOT}templates" "$last/" ;;\n  "-C "*" rev-parse --short HEAD") echo abc1234 ;;\n  *) exec "${git}" "$@" ;;\nesac\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  const run = (source: string) =>
    spawnSync(HOOK, [], { input: JSON.stringify({ source, hook_event_name: 'SessionStart' }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, PATH: `${bin}:${process.env.PATH}` } });
  return { dir, run };
}

describe('hook startu sesji: skille i reguły fabryki bez kopii w projekcie', () => {
  it('ustawienia projektu uruchamiają hook na starcie sesji, a skrypt jest wykonywalny', () => {
    const settings = JSON.parse(read('templates/claude/settings.json'));
    const command = settings.hooks.SessionStart[0].hooks[0];
    assert.equal(command.type, 'command');
    assert.match(command.command, /\.claude\/hooks\/factory\.sh/);
    assert.ok(statSync(HOOK).mode & 0o111, 'hook ma prawo wykonania');
  });

  it('każdy skill z listy sesji istnieje w fabryce', () => {
    assert.ok(sessionSkills().includes('spec-writer'));
    for (const skill of sessionSkills()) assert.ok(existsSync(join(ROOT, 'skills', skill, 'SKILL.md')), skill);
  });

  it('pobiera wersję z workflowu, kopiuje skille, podaje reguły i nie brudzi repo', () => {
    const { dir, run } = project('v1');
    try {
      const out = run('startup');
      assert.equal(out.status, 0, out.stderr);
      assert.match(readFileSync(join(dir, '.clone.log'), 'utf8'), /--branch v1 https:\/\/github\.com\/gibkigonzo\/factory /);
      assert.match(out.stdout, /^Fabryka oprogramowania \(https:\/\/github\.com\/gibkigonzo\/factory, wersja v1 abc1234\)/);
      assert.ok(out.stdout.includes(read('templates/claude/CLAUDE.md').trim()), 'reguły fabryki w kontekście sesji');
      for (const skill of sessionSkills()) {
        assert.equal(readFileSync(join(dir, '.claude/skills', skill, 'SKILL.md'), 'utf8'), read(`skills/${skill}/SKILL.md`));
      }
      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
      assert.doesNotMatch(status, /\.claude\//, 'kopie pomija git lokalnie');

      rmSync(join(dir, '.clone.log'));
      const resumed = run('resume');
      assert.equal(resumed.status, 0);
      assert.ok(!existsSync(join(dir, '.clone.log')), 'wznowienie korzysta z kopii ze startu');
      assert.match(resumed.stdout, /wersja v1 abc1234/);
      run('startup');
      const exclude = readFileSync(join(dir, '.git/info/exclude'), 'utf8');
      assert.equal(exclude.split('\n').filter((l) => l === '/.claude/factory/').length, 1, 'bez powtórzeń w exclude');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bez sieci sesja startuje: kopia z poprzedniego startu albo informacja, że skille są niedostępne', () => {
    const { dir, run } = project('v1');
    try {
      writeFileSync(join(dir, '.bin/git'), '#!/bin/sh\nexit 128\n');
      const out = run('startup');
      assert.equal(out.status, 0);
      assert.match(out.stdout, /nie udało się pobrać fabryki[^\n]*Skille fabryki są niedostępne/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
