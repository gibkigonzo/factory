// Konflikty z gałęzią główną: scalenie w rundzie poprawek (sync-base.sh), odtworzenie w jobie zapisu
// (apply-change.sh) na prawdziwym repo git i wykrywanie PR z konfliktem (conflicts.sh) na podstawionym `gh`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SYNC = new URL('./sync-base.sh', import.meta.url).pathname;
const APPLY = new URL('./apply-change.sh', import.meta.url).pathname;
const CONFLICTS = new URL('./conflicts.sh', import.meta.url).pathname;

const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ident } });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}
function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
}
const outputs = (stdout: string) => Object.fromEntries(stdout.trim().split('\n').map((l) => l.split('=') as [string, string]));

/**
 * Repo „origin” z gałęzią główną i gałęzią PR oraz dwa klony: job implementera i job zapisu.
 * Gałąź główna po rozgałęzieniu zmienia `shared.txt` (konflikt z PR, gdy conflict) i dodaje `main.txt`.
 */
function setup(conflict: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'factory-conflict-'));
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  commit(origin, { 'shared.txt': 'a\nb\nc\n', 'app.txt': 'app\n' }, 'start');
  git(origin, 'checkout', '-q', '-b', 'factory/7-task');
  commit(origin, { 'shared.txt': 'a\nB z PR\nc\n', 'pr.txt': 'pr\n' }, 'pr');
  git(origin, 'checkout', '-q', 'main');
  commit(origin, { 'shared.txt': conflict ? 'a\nB z main\nc\n' : 'a\nb\nc\nd z main\n', 'main.txt': 'main\n' }, 'main');
  const clone = (name: string) => {
    git(root, 'clone', '-q', origin, name);
    const dir = join(root, name);
    git(dir, 'checkout', '-q', 'factory/7-task');
    mkdirSync(join(dir, '.factory/work'), { recursive: true });
    writeFileSync(join(dir, '.git/info/exclude'), '.factory/work/\n');
    return dir;
  };
  return { root, implement: clone('implement'), publish: clone('publish') };
}

/** Część joba implementera po sesji Claude: patch od wyniku scalenia (jak krok „Patch i sprawdzenie”). */
function patchFrom(dir: string, baseline: string) {
  git(dir, 'add', '-A');
  const paths = git(dir, 'diff', '--cached', '--name-only', '--no-renames', baseline);
  const patch = spawnSync('git', ['diff', '--cached', '--binary', baseline], { cwd: dir }).stdout;
  writeFileSync(join(dir, '.factory/work/change.patch'), patch);
  return { paths: paths ? paths.split('\n') : [], file: join(dir, '.factory/work/change.patch'), empty: patch.length === 0 };
}

const sync = (dir: string) => spawnSync('bash', [SYNC, 'origin/main', '.factory/work'], { cwd: dir, encoding: 'utf8' });
const apply = (dir: string, patch: string, sha: string) => spawnSync('bash', [APPLY, patch, sha], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...ident } });

describe('runda poprawek scala gałąź główną', () => {
  it('bez konfliktu: scala skrypt, patch ma tylko zmianę implementera, a zapis robi commit scalenia', () => {
    const { root, implement, publish } = setup(false);
    try {
      const run = sync(implement);
      assert.equal(run.status, 0, run.stderr);
      const out = outputs(run.stdout);
      assert.equal(out.merged, 'clean');
      assert.equal(readFileSync(join(implement, '.factory/work/conflicts.txt'), 'utf8'), '');
      assert.ok(existsSync(join(implement, 'main.txt')), 'zmiany z gałęzi głównej są w katalogu roboczym');

      writeFileSync(join(implement, 'pr.txt'), 'pr po poprawce\n');
      const patch = patchFrom(implement, out.baseline!);
      assert.deepEqual(patch.paths, ['pr.txt'], 'pliki z gałęzi głównej nie trafiają do sprawdzenia ścieżek');

      const done = apply(publish, patch.file, out.sha!);
      assert.equal(done.status, 0, done.stderr);
      git(publish, 'commit', '-q', '-m', 'factory: poprawka');
      assert.equal(git(publish, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'commit scalenia ma dwóch rodziców');
      assert.equal(readFileSync(join(publish, 'pr.txt'), 'utf8'), 'pr po poprawce\n');
      assert.equal(readFileSync(join(publish, 'shared.txt'), 'utf8'), 'a\nB z PR\nc\nd z main\n');
      assert.equal(git(publish, 'merge-base', '--is-ancestor', out.sha!, 'HEAD'), '', 'gałąź główna jest w historii PR');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('z konfliktem: lista plików dla implementera, a zapis odtwarza scalenie i nakłada jego rozwiązanie', () => {
    const { root, implement, publish } = setup(true);
    try {
      const out = outputs(sync(implement).stdout);
      assert.equal(out.merged, 'conflict');
      assert.equal(readFileSync(join(implement, '.factory/work/conflicts.txt'), 'utf8'), 'shared.txt\n');
      assert.match(readFileSync(join(implement, 'shared.txt'), 'utf8'), /^<<<<<<< HEAD$/m);

      // Implementer rozwiązuje konflikt, zachowując obie zmiany.
      writeFileSync(join(implement, 'shared.txt'), 'a\nB z PR i z main\nc\n');
      const patch = patchFrom(implement, out.baseline!);
      assert.deepEqual(patch.paths, ['shared.txt']);

      assert.equal(apply(publish, patch.file, out.sha!).status, 0);
      git(publish, 'commit', '-q', '-m', 'factory: konflikt');
      assert.equal(readFileSync(join(publish, 'shared.txt'), 'utf8'), 'a\nB z PR i z main\nc\n');
      assert.ok(existsSync(join(publish, 'main.txt')));
      assert.equal(git(publish, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gałąź aktualna: bez scalenia, a zły SHA w zapisie przerywa job zamiast commita bez scalenia', () => {
    const { root, implement, publish } = setup(false);
    try {
      git(implement, 'merge', '-q', '--no-edit', 'origin/main');
      const out = outputs(sync(implement).stdout);
      assert.deepEqual([out.merged, out.sha], ['none', '']);
      assert.equal(out.baseline, git(implement, 'rev-parse', 'HEAD^{tree}'));
      assert.equal(apply(publish, '', '0000000000000000000000000000000000000000').status, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Udawany gh: log wywołań, stan PR, komentarze taśmy i przebiegi w plikach katalogu. */
function fakeGh(dir: string, data: { prs: { number: number; headRefName: string }[]; states: Record<number, string[]>; comments?: Record<number, string[]>; runs?: string[] }) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'prs.json'), JSON.stringify(data.prs));
  for (const [n, states] of Object.entries(data.states)) writeFileSync(join(dir, `states-${n}`), states.join('\n') + '\n');
  for (const [n, firsts] of Object.entries(data.comments ?? {})) writeFileSync(join(dir, `comments-${n}`), firsts.join('\n') + '\n');
  writeFileSync(join(dir, 'runs'), (data.runs ?? []).join('\n'));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
D=${JSON.stringify(dir)}
echo "$*" >> "$D/calls.log"
args="$*"
case "$args" in
  "api repos/o/r --jq .default_branch") echo main ;;
  "pr list"*) jq -r '.[] | select(.headRefName | startswith("factory/")) | .number' "$D/prs.json" ;;
  "api repos/o/r/pulls/"*"--jq .mergeable_state")
    n=$(echo "$args" | sed -E 's#.*pulls/([0-9]+).*#\\1#'); f="$D/states-$n"
    head -n 1 "$f"; if [ "$(wc -l < "$f")" -gt 1 ]; then sed -i 1d "$f"; fi ;;
  "pr view "*"--json headRefName"*) n=$(echo "$args" | awk '{print $3}'); jq -r --argjson n "$n" '.[] | select(.number == $n) | .headRefName' "$D/prs.json" ;;
  "run list"*) cat "$D/runs" ;;
  "api --paginate repos/o/r/issues/"*) n=$(echo "$args" | sed -E 's#.*issues/([0-9]+)/comments.*#\\1#'); cat "$D/comments-$n" 2>/dev/null ;;
  "pr comment "*) n=$(echo "$args" | awk '{print $3}'); cat > "$D/comment-$n"; echo "https://github.com/o/r/pull/$n#issuecomment-9$n" ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, GH_REPO: 'o/r', GH_TOKEN: 'x', WORKFLOW: 'factory.yml', WAIT: '0' };
}

describe('wykrywanie konfliktów po zamknięciu PR fabryki', () => {
  it('PR z konfliktem dostaje komentarz i rundę; czysty, w toku i po limicie rund nie dostają', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-conflicts-'));
    try {
      const prs = [
        { number: 54, headRefName: 'factory/52-karty' },
        { number: 55, headRefName: 'factory/53-czysty' },
        { number: 56, headRefName: 'factory/54-w-toku' },
        { number: 57, headRefName: 'factory/55-po-limicie' },
        { number: 58, headRefName: 'inna/gałąź' },
      ];
      const env = {
        ...process.env,
        ...fakeGh(dir, {
          prs,
          states: { 54: ['unknown', 'dirty'], 55: ['clean'], 56: ['dirty'], 57: ['dirty'] },
          comments: { 57: ['<!-- factory:conflict -->', '<!-- factory:round -->', '<!-- factory:conflict -->'] },
          runs: ['factory review PR #56'],
        }),
      };
      const run = spawnSync('bash', [CONFLICTS], { env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, '1\n');
      const log = readFileSync(join(dir, 'calls.log'), 'utf8');
      assert.ok(log.includes('workflow run factory.yml --ref main -f stage=implement -f issue=52 -f pr=54 -f note=954'));
      assert.match(readFileSync(join(dir, 'comment-54'), 'utf8'), /^<!-- factory:conflict -->\n## Konflikt z gałęzią główną\n[\s\S]*runda 1 z 2/);
      assert.ok(!log.includes('pr=55') && !log.includes('pr=56') && !log.includes('pr=57'));
      assert.match(readFileSync(join(dir, 'comment-57'), 'utf8'), /^<!-- factory:conflict-stop -->\nPR dalej ma konflikt[\s\S]*po 2 rundach/);

      // Drugi przegląd nie powtarza prośby do właściciela.
      writeFileSync(join(dir, 'comments-57'), '<!-- factory:conflict -->\n<!-- factory:conflict -->\n<!-- factory:conflict-stop -->\n');
      rmSync(join(dir, 'comment-57'));
      writeFileSync(join(dir, 'states-57'), 'dirty\n');
      writeFileSync(join(dir, 'prs.json'), JSON.stringify([prs[3]]));
      assert.equal(spawnSync('bash', [CONFLICTS], { env, encoding: 'utf8' }).stdout, '0\n');
      assert.ok(!existsSync(join(dir, 'comment-57')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
