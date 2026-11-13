// Skrypty limitu i wznowienia na podstawionym `gh`: zapisuje wywołania i zwraca przygotowane dane.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { limitStopBody } from './limit.ts';

const PAUSE = new URL('./limit-pause.sh', import.meta.url).pathname;
const RESUME = new URL('./resume.sh', import.meta.url).pathname;

/** Katalog z udawanym gh: log wywołań w calls.log, treści komentarzy i issue w plikach. */
function fakeGh(dir: string, data: { stops?: unknown[]; state?: Record<string, string>; paused?: number[]; comments?: Record<string, string> }) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'stops.json'), JSON.stringify(data.stops ?? []));
  for (const [n, state] of Object.entries(data.state ?? {})) writeFileSync(join(dir, `state-${n}`), state);
  for (const [n, body] of Object.entries(data.comments ?? {})) writeFileSync(join(dir, `comments-${n}`), body);
  writeFileSync(join(dir, 'paused'), (data.paused ?? []).join('\n'));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
D=${JSON.stringify(dir)}
echo "$*" >> "$D/calls.log"
args="$*"
body=""; prev=""
for a in "$@"; do [ "$prev" = --body-file ] && body="$a"; prev="$a"; done
if [ -n "$body" ]; then n=$(ls "$D" | grep -c '^body-'); cp "$body" "$D/body-$n"; fi
case "$args" in
  "api repos/"*"--jq .default_branch") echo main ;;
  "issue list --label factory:stopped"*) cat "$D/stops.json" ;;
  "issue create"*) echo "https://github.com/o/r/issues/77" ;;
  "issue view "*"--json state"*) n=$(echo "$args" | awk '{print $3}'); cat "$D/state-$n" 2>/dev/null || echo OPEN ;;
  "issue list --label factory:paused"*) cat "$D/paused" ;;
  "pr list --label factory:paused"*) ;;
  "api --paginate repos/"*"/comments"*) n=$(echo "$args" | sed -E 's#.*issues/([0-9]+)/comments.*#\\1#'); cat "$D/comments-$n" 2>/dev/null ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, GH_REPO: 'o/r', GH_TOKEN: 'x' };
}

const calls = (dir: string) => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
const body = (dir: string, n: number) => readFileSync(join(dir, `body-${n}`), 'utf8');

describe('skrypty limitu subskrypcji', () => {
  it('pierwszy limit: issue „Taśma czeka na limit” i zapis wstrzymanego etapu w PR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pause-'));
    try {
      const env = { ...process.env, ...fakeGh(dir, {}), STAGE: 'implement', ISSUE: '42', PR: '46', NOTE: '6824', UNTIL: '2026-11-12T16:12:00.000Z', RUN: 'https://example.test/run' };
      const run = spawnSync('bash', [PAUSE], { env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const log = calls(dir);
      assert.ok(log.some((c) => c.startsWith("issue create --title Taśma czeka na limit subskrypcji --label factory:stopped")));
      assert.ok(log.includes('issue edit 46 --add-label factory:paused'));
      assert.match(body(dir, 0), /<!-- factory:stop \{"reason":"limit subskrypcji Claude do 16:12 UTC/);
      assert.match(body(dir, 1), /<!-- factory:paused \{"stage":"implement","issue":"42","pr":"46","note":"6824"\} -->/);
      assert.match(body(dir, 1), /\(#77\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kolejny limit z późniejszym resetem przesuwa godzinę w istniejącym issue, a złe wejście nic nie zapisuje', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pause-'));
    try {
      const stops = [{ number: 50, body: limitStopBody('2026-11-12T16:12:00.000Z', 'implement', '46') }];
      const env = { ...process.env, ...fakeGh(dir, { stops }), STAGE: 'review', ISSUE: '', PR: '48', NOTE: '', UNTIL: '2026-11-12T17:30:00.000Z' };
      assert.equal(spawnSync('bash', [PAUSE], { env, encoding: 'utf8' }).status, 0);
      const log = calls(dir);
      assert.ok(!log.some((c) => c.startsWith('issue create')));
      assert.ok(log.some((c) => c.startsWith('issue edit 50 --body-file')));
      assert.match(body(dir, 0), /do 17:30 UTC/);
      const bad = spawnSync('bash', [PAUSE], { env: { ...env, STAGE: 'deploy' }, encoding: 'utf8' });
      assert.equal(bad.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wznowienie: zamyka issue, uruchamia zapisane etapy i kolejkę; drugi przebieg nic nie dubluje', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-resume-'));
    try {
      const comments = { 46: 'x\n<!-- factory:paused {"stage":"implement","issue":"42","pr":"46","note":"6824"} -->\n', 47: '<!-- factory:paused {"stage":"deploy"} -->' };
      const env = { ...process.env, ...fakeGh(dir, { paused: [46, 47], comments }), MESSAGE: 'Limit odnowiony.', WORKFLOW: 'factory.yml' };
      const run = spawnSync('bash', [RESUME, '50'], { env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, '1\n', 'tylko poprawny zapis');
      const log = calls(dir);
      assert.ok(log.includes('issue close 50 --comment Limit odnowiony.'));
      assert.ok(log.includes('workflow run factory.yml --ref main -f stage=implement -f issue=42 -f pr=46 -f note=6824'));
      assert.ok(log.includes('workflow run factory.yml --ref main -f stage=queue'));
      assert.ok(log.includes('issue edit 47 --remove-label factory:paused'));
      const again = spawnSync('bash', [RESUME, '50'], { env: { ...env, ...fakeGh(join(dir, 'b'), { state: { 50: 'CLOSED' }, paused: [46], comments }) }, encoding: 'utf8' });
      assert.equal(again.stdout, '0\n');
      assert.ok(!calls(join(dir, 'b')).some((c) => c.startsWith('workflow run')), 'issue już zamknięte: nic nie rusza');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
