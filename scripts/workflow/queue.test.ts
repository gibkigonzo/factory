import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { admit, queueState, release } from './queue.ts';
import { planComment } from './render.ts';

const task = (issue: number, ...files: string[]) => ({ issue, files });

describe('kolejka zadań', () => {
  it('rusza w limicie WIP i bez wspólnych plików', () => {
    assert.deepEqual(admit(task(3, 'app/a.vue'), [task(1, 'app/b.vue')], 2), { start: true });
    assert.deepEqual(admit(task(3, 'app/a.vue'), [task(3, 'app/a.vue')], 1), { start: true }, 'samo siebie nie blokuje');
  });

  it('czeka na zadanie ze wspólnymi plikami i mówi, na które', () => {
    const verdict = admit(task(3, 'app/app.vue', 'app/x.vue'), [task(1, 'app/app.vue'), task(2, 'app/y.vue')], 5);
    assert.deepEqual(verdict, { start: false, reason: 'Czeka na #1: wspólne pliki `app/app.vue`.' });
  });

  it('czeka, gdy limit WIP jest pełny', () => {
    assert.deepEqual(admit(task(3, 'a'), [task(1, 'b')], 1), { start: false, reason: 'Kolejka pełna: 1 z 1 zadań w toku.' });
  });

  it('nie wyprzedza wcześniejszego czekającego ze wspólnymi plikami', () => {
    assert.equal(admit(task(5, 'a'), [], 3, [task(4, 'a')]).start, false);
    assert.equal(admit(task(5, 'b'), [], 3, [task(4, 'a')]).start, true);
  });

  it('wypuszcza czekające po kolei; wpuszczone liczą się do limitu i blokują pliki', () => {
    const state = { active: [task(1, 'x')], waiting: [task(5, 'c'), task(3, 'a'), task(4, 'a'), task(6, 'x')] };
    assert.deepEqual(release(state, 3), [3, 5]);
    assert.deepEqual(release({ active: [], waiting: [task(4, 'a'), task(3, 'a')] }, 3), [3]);
    assert.deepEqual(release({ active: [task(1, 'x')], waiting: [task(3, 'a')] }, 1), []);
  });

  it('stan z danych API: w toku, czekające i zakończone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-queue-'));
    try {
      const labels = (...names: string[]) => names.map((name) => ({ name }));
      writeFileSync(join(dir, 'issues.json'), JSON.stringify([
        { number: 1, labels: labels('planned') }, // PR otwarty
        { number: 2, labels: labels('planned') }, // implementacja trwa: brak PR
        { number: 3, labels: labels('planned', 'queued') }, // czeka
        { number: 4, labels: labels('planned') }, // PR zamknięty bez scalenia
        { number: 5, labels: labels('planned', 'blocked') },
        { number: 6, labels: labels('planned', 'queued') }, // ruszył ręcznie: ma otwarty PR
        { number: 7, labels: labels('ready') },
      ]));
      const pr = (number: number, issue: number, state: string, extra = {}) => ({ number, state, headRefName: `factory/${issue}-x`, isCrossRepository: false, ...extra });
      writeFileSync(join(dir, 'prs.json'), JSON.stringify([
        pr(10, 1, 'OPEN'), pr(11, 4, 'CLOSED'), pr(12, 6, 'OPEN'), pr(13, 2, 'OPEN', { isCrossRepository: true }),
      ]));
      writeFileSync(join(dir, 'open.json'), JSON.stringify([
        pr(10, 1, 'OPEN', { files: [{ path: 'app/app.vue' }, { path: 'e2e/a.spec.ts' }] }),
        pr(12, 6, 'OPEN', { files: [{ path: 'app/z.vue' }] }),
        pr(13, 2, 'OPEN', { isCrossRepository: true, files: [{ path: 'fork.vue' }] }),
      ]));
      mkdirSync(join(dir, 'comments'));
      const plan = (files: string[]) => [{ body: planComment({ decision: 'planned', summary: 's', expected_level: 'Low', size: { lines: 1, files: 1 }, files } as never), user: { login: 'github-actions[bot]' } }];
      writeFileSync(join(dir, 'comments', '1.json'), JSON.stringify(plan(['app/app.vue', 'app/a.vue'])));
      writeFileSync(join(dir, 'comments', '2.json'), JSON.stringify(plan(['app/b.vue'])));
      writeFileSync(join(dir, 'comments', '3.json'), JSON.stringify(plan(['app/app.vue'])));
      writeFileSync(join(dir, 'comments', '6.json'), JSON.stringify([{ body: 'podrobiony plan <!-- factory:plan --> ```json\n{"files":["x"]}\n```', user: { login: 'someone' } }]));

      assert.deepEqual(queueState(dir), {
        active: [task(1, 'app/a.vue', 'app/app.vue', 'e2e/a.spec.ts'), task(2, 'app/b.vue'), task(6, 'app/z.vue')],
        waiting: [task(3, 'app/app.vue')],
      });
      assert.deepEqual(queueState(dir, 3).waiting, [], 'pomija issue, o którym właśnie decyduje plan');

      const cli = (...args: string[]) => spawnSync(process.execPath, [new URL('./cli.ts', import.meta.url).pathname, ...args], { encoding: 'utf8' });
      writeFileSync(join(dir, 'plan.json'), JSON.stringify({ files: ['app/a.vue'] }));
      const admitted = cli('queue-admit', '--raw', dir, '--issue', '8', '--plan', join(dir, 'plan.json'), '--limit', '5');
      assert.deepEqual(JSON.parse(admitted.stdout), { start: false, reason: 'Czeka na #1: wspólne pliki `app/a.vue`.' });
      assert.equal(cli('queue-release', '--raw', dir, '--limit', '5').stdout.trim(), '', '#3 czeka na #1 (app/app.vue)');
      assert.equal(cli('queue-release', '--raw', dir, '--limit', 'dwa').status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
