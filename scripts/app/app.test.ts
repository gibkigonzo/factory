import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  availableCommands,
  COLUMNS,
  commandComment,
  factoryVersion,
  issueOfBranch,
  parseJournal,
  parseShadow,
  splitTooLate,
  taskColumn,
} from './index.ts';
import type { CommandTarget } from './index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

/** Wszystkie pliki, które moduł dla aplikacji wciąga, także przez `import type`, i ich importy spoza repo. */
function importGraph(entry: string): { files: string[]; external: string[] } {
  const files = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/^(?:import|export)\s[^;]*?from\s+'([^']+)'/gms)) {
      if (spec!.startsWith('.')) visit(resolve(dirname(file), spec!));
      else external.add(`${relative(ROOT, file)} → ${spec}`);
    }
  };
  visit(resolve(HERE, 'index.ts'));
  return { files: [...files].map((f) => relative(ROOT, f)), external: [...external] };
}

describe('moduł logiki fabryki dla aplikacji', () => {
  it('jest czysty: żadnego importu Node ani pakietów, także w typach, w całym grafie', () => {
    const { files, external } = importGraph(resolve(HERE, 'index.ts'));
    assert.deepEqual(external, [], 'aplikacja w przeglądarce i w Tauri nie ma Node ani pakietów fabryki');
    assert.ok(files.includes('scripts/shadow/comment.ts') && files.includes('scripts/workflow/usage.ts'));
    for (const forbidden of ['scripts/shadow/collect.ts', 'scripts/review/perspectives.ts', 'scripts/workflow/render.ts']) {
      assert.ok(!files.includes(forbidden), `${forbidden} używa Node, więc moduł go nie importuje`);
    }
  });

  it('package.json wystawia moduł jako factory/app', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { exports?: Record<string, string> };
    assert.equal(pkg.exports?.['./app'], './scripts/app/index.ts');
  });
});

describe('kolumny tablicy', () => {
  const task = (labels: string[], extra: Partial<Parameters<typeof taskColumn>[0]> = {}) => taskColumn({ state: 'open', labels, ...extra });

  it('kolumny w kolejności pracy', () => {
    assert.deepEqual(
      COLUMNS.map((c) => c.title),
      ['Nowe', 'Gotowe', 'Czeka na zgodę', 'W kolejce', 'W toku', 'Twoja decyzja', 'Zablokowane', 'Zrobione'],
    );
  });

  it('etykiety taśmy i PR fabryki wyznaczają kolumnę, od najważniejszego stanu', () => {
    assert.equal(task(['idea']), 'new');
    assert.equal(task([]), 'new');
    assert.equal(task(['ready']), 'ready');
    assert.equal(task(['ready', 'planned', 'needs-approval']), 'approval');
    assert.equal(task(['ready', 'planned', 'queued']), 'queued');
    assert.equal(task(['ready', 'planned']), 'in_progress');
    assert.equal(task(['ready', 'planned'], { pr: { state: 'open' } }), 'in_progress', 'PR bez werdyktu: recenzja trwa');
    assert.equal(task(['ready', 'planned'], { pr: { state: 'open', verdict: 'escalate' } }), 'decision');
    assert.equal(task(['ready', 'planned'], { pr: { state: 'open', verdict: 'merge' } }), 'decision', 'w trybie cienia o każdym PR decyduje właściciel');
    assert.equal(task(['ready', 'planned'], { pr: { state: 'open', verdict: 'fix-gates' } }), 'in_progress');
    assert.equal(task(['ready', 'planned', 'blocked'], { pr: { state: 'open', verdict: 'merge' } }), 'blocked');
    assert.equal(task(['ready', 'planned'], { pr: { state: 'merged' } }), 'done');
    assert.equal(task(['rejected']), 'done');
    assert.equal(task(['split']), 'done');
    assert.equal(taskColumn({ state: 'closed', labels: ['ready'] }), 'done');
  });

  it('numer issue z gałęzi PR fabryki', () => {
    assert.equal(issueOfBranch('factory/42-wspolny-przycisk'), 42);
    assert.equal(issueOfBranch('feature/42-x'), undefined);
  });
});

describe('komendy jako przyciski', () => {
  const target = (extra: Partial<CommandTarget>): CommandTarget => ({ kind: 'issue', state: 'open', labels: [], lineStopped: false, ...extra });
  const enabled = (t: CommandTarget) => availableCommands(t).filter((c) => c.enabled).map((c) => c.name);

  it('PR: zgoda, zmiana, odrzucenie i zatrzymanie taśmy; bez podziału', () => {
    assert.deepEqual(enabled(target({ kind: 'pr' })), ['approve', 'change', 'reject', 'stop', 'start']);
    const split = availableCommands(target({ kind: 'pr' })).find((c) => c.name === 'split');
    assert.deepEqual(split, { name: 'split', enabled: false, reason: 'działa w issue, nie w PR' });
  });

  it('issue: zgoda tylko przy planie z nowymi zależnościami, /change tylko w PR', () => {
    assert.deepEqual(enabled(target({})), ['reject', 'split', 'stop', 'start']);
    assert.ok(enabled(target({ labels: ['planned', 'needs-approval'] })).includes('approve'));
  });

  it('/split za późno tak samo jak w workflowie komend', () => {
    assert.equal(splitTooLate([], false), false);
    assert.equal(splitTooLate(['idea'], false), false);
    assert.equal(splitTooLate(['ready'], false), true);
    assert.equal(splitTooLate(['planned'], false), true);
    assert.equal(splitTooLate(['planned', 'queued'], false), false);
    assert.equal(splitTooLate(['planned', 'blocked'], false), false);
    assert.equal(splitTooLate(['planned', 'queued'], true), true, 'otwarty PR fabryki');
  });

  it('zatrzymana taśma: /stop niedostępne, zamknięte issue tylko /start', () => {
    assert.ok(!enabled(target({ lineStopped: true })).includes('stop'));
    assert.deepEqual(enabled(target({ state: 'closed' })), ['stop', 'start']);
  });

  it('treść komentarza: /change z uwagami, /stop z powodem albo bez', () => {
    assert.equal(commandComment('change', '  Większy odstęp nad tablicą. '), '/change Większy odstęp nad tablicą.');
    assert.throws(() => commandComment('change', ' '), /wymaga uwag/);
    assert.equal(commandComment('stop', 'awaria CI'), '/stop awaria CI');
    assert.equal(commandComment('stop'), '/stop');
    assert.equal(commandComment('approve', 'ignorowane'), '/approve');
  });
});

describe('projekt, werdykt i dziennik', () => {
  it('rozpoznaje cienki workflow fabryki i jego wersję', () => {
    const workflow = 'jobs:\n  factory:\n    uses: gibkigonzo/factory/.github/workflows/pipeline.yml@main\n    with:\n      factory_ref: main\n';
    assert.equal(factoryVersion(workflow), 'main');
    assert.equal(factoryVersion(workflow.replace('@main', '@v1  # wersja')), 'v1');
    assert.equal(factoryVersion('jobs:\n  build:\n    runs-on: ubuntu-latest\n'), undefined);
  });

  it('komentarz bez znacznika werdyktu to nie werdykt', () => {
    assert.equal(parseShadow('Zwykły komentarz'), undefined);
  });

  it('journal.json: poprawny plik, starszy bez problemów taśmy i plik w złym kształcie', () => {
    const row = { title: 'Przycisk', state: 'scalony', rounds: 0, reverted: false, cost: 1.5, output: 100, stages: {}, reviewers: {}, usage: [] };
    const file = { updated: '2026-11-15T08:00:00Z', stopped: null, tasks: 1, cost: 1.5, rows: [row], lineProblems: [] };
    assert.deepEqual(parseJournal(JSON.stringify(file)), file);
    const { lineProblems: _lineProblems, ...older } = file;
    assert.deepEqual(parseJournal(JSON.stringify(older))?.lineProblems, []);
    assert.equal(parseJournal('{"rows": "x"}'), undefined);
    assert.equal(parseJournal('nie json'), undefined);
  });
});
