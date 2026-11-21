import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { admit, closedDependencies, gate, queueState, release } from './queue.ts';
import type { QueueState, WaitingTask } from './queue.ts';
import { planComment } from './render.ts';

const task = (issue: number, ...files: string[]) => ({ issue, files });
const planned = (issue: number, ...files: string[]): WaitingTask => ({ issue, files, planned: true, approved: false, dependsOn: [] });
const unplanned = (issue: number, ...dependsOn: number[]): WaitingTask => ({ issue, files: [], planned: false, approved: false, dependsOn });
const queue = (state: Partial<QueueState>): QueueState => ({ active: [], waiting: [], planning: [], dependencies: {}, ...state });

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
    const issues = (steps: { issue: number }[]) => steps.map((s) => s.issue);
    const state = queue({ active: [task(1, 'x')], waiting: [planned(5, 'c'), planned(3, 'a'), planned(4, 'a'), planned(6, 'x')] });
    assert.deepEqual(issues(release(state, 3)), [3, 5]);
    assert.deepEqual(issues(release(queue({ waiting: [planned(4, 'a'), planned(3, 'a')] }), 3)), [3]);
    assert.deepEqual(release(queue({ active: [task(1, 'x')], waiting: [planned(3, 'a')] }), 1), []);
  });

  it('wypuszczone zadanie dostaje świeży plan, a implementer rusza od razu tylko z planem po /approve', () => {
    const approved = { ...planned(4, 'b'), approved: true };
    assert.deepEqual(release(queue({ waiting: [planned(3, 'a'), approved, unplanned(5)] }), 5), [
      { issue: 3, action: 'plan' },
      { issue: 4, action: 'implement' },
      { issue: 5, action: 'plan' },
    ]);
  });

  it('planowane teraz zajmują miejsce w limicie', () => {
    assert.deepEqual(release(queue({ planning: [7], waiting: [unplanned(3)] }), 1), []);
    assert.deepEqual(release(queue({ planning: [7], waiting: [unplanned(3)] }), 2), [{ issue: 3, action: 'plan' }]);
  });

  it('zależności ze specu: czeka na niescalone, a odrzucone albo nieistniejące blokuje z prośbą o decyzję', () => {
    const dependencies = { 1: 'done', 2: 'open', 3: 'dropped' } as const;
    const steps = release(queue({ dependencies, waiting: [unplanned(5, 1), unplanned(6, 2), unplanned(7, 1, 3), unplanned(8, 9)] }), 5);
    assert.deepEqual(steps.map((s) => [s.issue, s.action]), [[5, 'plan'], [7, 'blocked'], [8, 'blocked']]);
    const blocked = steps.find((s) => s.issue === 7) as { reason: string };
    assert.match(blocked.reason, /zależy od #3, a to nie zostanie zrobione/);
    assert.match(blocked.reason, /Popraw sekcję „Zależy od”[^\n]*`\/reject`/);
  });

  it('przed planem: zależności, potem limit WIP z wcześniejszymi planowanymi, ale bez późniejszych', () => {
    assert.deepEqual(gate(5, [], queue({}), 2), { action: 'plan' });
    assert.deepEqual(gate(5, [2], queue({ dependencies: { 2: 'open' } }), 2), {
      action: 'wait',
      reason: 'Czeka na #2: spec mówi, że zadanie od nich zależy.',
    });
    assert.equal(gate(5, [2], queue({ dependencies: { 2: 'dropped' } }), 2).action, 'blocked');
    assert.deepEqual(gate(5, [], queue({ active: [task(1, 'a')], planning: [3] }), 2), { action: 'wait', reason: 'Kolejka pełna: 2 z 2 zadań w toku.' });
    assert.deepEqual(gate(5, [], queue({ active: [task(1, 'a')], planning: [6, 7, 8] }), 2), { action: 'plan' }, 'paczka ready naraz nie blokuje się wzajemnie');
    assert.deepEqual(gate(5, [], queue({ active: [task(5, 'a')] }), 1), { action: 'plan' }, 'nowy plan zadania nie czeka na siebie');
  });

  it('stan z danych API: w toku, czekające i zakończone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-queue-'));
    try {
      const labels = (...names: string[]) => names.map((name) => ({ name }));
      writeFileSync(join(dir, 'issues.json'), JSON.stringify([
        { number: 1, labels: labels('planned') }, // PR otwarty
        { number: 2, labels: labels('planned') }, // implementacja trwa: brak PR
        { number: 3, labels: labels('planned', 'queued', 'factory:approved') }, // czeka z planem po /approve
        { number: 4, labels: labels('planned') }, // PR zamknięty bez scalenia
        { number: 5, labels: labels('planned', 'blocked') },
        { number: 6, labels: labels('planned', 'queued') }, // ruszył ręcznie: ma otwarty PR
        { number: 7, labels: labels('ready') }, // planer pracuje
        { number: 9, labels: labels('planned', 'needs-approval') }, // plan czeka na zgodę na zależności
        { number: 14, labels: labels('queued'), body: '## Cel\nx\n\n## Zależy od: #2, #20, #21, #22, #23, #14' }, // czeka przed planem
        { number: 15, labels: labels('idea') }, // notatka
        { number: 16, labels: labels('rejected'), body: '## Zależy od: #2' },
        { number: 20, labels: labels('split') },
        { number: 24, labels: labels('ready'), body: '## Zależy od: #2' }, // ready, ale czeka na #2: planu teraz nie dostanie
      ]));
      writeFileSync(join(dir, 'closed.json'), JSON.stringify([
        { number: 21, state: 'closed', state_reason: 'completed' },
        { number: 22, state: 'closed', state_reason: 'not_planned' },
        { number: 23, state: 'open', state_reason: null }, // PR zamiast issue
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

      writeFileSync(join(dir, 'prs.json'), JSON.stringify([
        pr(10, 1, 'OPEN'), pr(11, 4, 'CLOSED'), pr(12, 6, 'OPEN'), pr(13, 2, 'OPEN', { isCrossRepository: true }),
      ]));
      const state = queueState(dir);
      assert.deepEqual(state.active, [task(1, 'app/a.vue', 'app/app.vue', 'e2e/a.spec.ts'), task(2, 'app/b.vue'), task(6, 'app/z.vue')]);
      assert.deepEqual(state.waiting, [
        { issue: 3, files: ['app/app.vue'], planned: true, approved: true, dependsOn: [] },
        { issue: 14, files: [], planned: false, approved: false, dependsOn: [2, 20, 21, 22, 23] },
      ]);
      assert.deepEqual(state.planning, [7], '#24 z ready czeka na zależność, więc nie zajmuje miejsca w limicie');
      assert.deepEqual(state.dependencies, { 2: 'open', 20: 'dropped', 21: 'done', 22: 'dropped', 23: 'open' });
      assert.deepEqual(closedDependencies(dir), [21, 22, 23], 'stan otwartych zna lista issue; zamknięte pobiera queue-raw.sh');
      assert.deepEqual(queueState(dir, 3).waiting.map((t) => t.issue), [14], 'pomija issue, o którym właśnie decyduje plan');
      writeFileSync(join(dir, 'prs.json'), JSON.stringify([pr(17, 2, 'MERGED'), pr(10, 1, 'OPEN'), pr(12, 6, 'OPEN')]));
      assert.equal(queueState(dir).dependencies[2], 'done', 'scalony PR fabryki to zrobiona zależność, choć issue jeszcze otwarte');

      const cli = (...args: string[]) => spawnSync(process.execPath, [new URL('./cli.ts', import.meta.url).pathname, ...args], { encoding: 'utf8' });
      writeFileSync(join(dir, 'plan.json'), JSON.stringify({ files: ['app/a.vue'] }));
      const admitted = cli('queue-admit', '--raw', dir, '--issue', '8', '--plan', join(dir, 'plan.json'), '--limit', '5');
      assert.deepEqual(JSON.parse(admitted.stdout), { start: false, reason: 'Czeka na #1: wspólne pliki `app/a.vue`.' });
      writeFileSync(join(dir, 'prs.json'), JSON.stringify([pr(10, 1, 'OPEN'), pr(11, 4, 'CLOSED'), pr(12, 6, 'OPEN')]));
      assert.deepEqual(
        JSON.parse(cli('queue-release', '--raw', dir, '--limit', '5').stdout),
        [{ issue: 14, action: 'blocked', reason: JSON.parse(cli('queue-gate', '--raw', dir, '--issue', '14', '--limit', '5').stdout).reason }],
        '#3 czeka na #1 (app/app.vue), a #14 zależy od podzielonego #20',
      );
      assert.equal(JSON.parse(cli('queue-gate', '--raw', dir, '--issue', '14', '--limit', '5').stdout).action, 'blocked');
      assert.equal(cli('queue-deps', '--raw', dir).stdout.trim(), '21\n22\n23');
      assert.equal(cli('queue-release', '--raw', dir, '--limit', 'dwa').status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
