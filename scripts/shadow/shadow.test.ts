import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { configWith } from '../risk/fixtures.ts';
import type { Assessment } from '../risk/types.ts';
import { collectRecords, factoryIssues, issueOf, parseReverts } from './collect.ts';
import type { PrRecord } from './collect.ts';
import { parseShadow, shadowComment, shadowRecord, SHADOW_MARKER } from './comment.ts';
import type { ShadowRecord } from './comment.ts';
import { decide } from './decision.ts';
import type { Action } from './decision.ts';
import { renderJournal } from './journal.ts';
import { computeMetrics, isFalseLow } from './metrics.ts';

const config = configWith();

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return { level: 'Low', split: false, rules: [], notes: [], gates: { status: 'pass', findings: [] }, ...overrides };
}

function verdict(action: Action, confidence = 0.9, reaction?: 'up' | 'down'): NonNullable<PrRecord['shadow']> {
  const record: ShadowRecord = {
    pr: 1,
    round: 0,
    level: action === 'merge' ? 'Low' : action === 'veto-window' ? 'Medium' : 'High',
    action,
    reviews: [{ perspective: 'correctness', verdict: 'approve', confidence }],
  };
  return reaction ? { record, at: '2026-11-01T10:00:00Z', reaction } : { record, at: '2026-11-01T10:00:00Z' };
}

let next = 1;
function pr(overrides: Partial<PrRecord> = {}): PrRecord {
  return { number: next++, title: 'zmiana', state: 'merged', createdAt: '2026-11-01T09:00:00Z', rounds: 0, reverted: false, ...overrides };
}

describe('decyzja mergera', () => {
  it('Low scala, Medium czeka na weto, High przekazuje właścicielowi', () => {
    assert.equal(decide(assessment()), 'merge');
    assert.equal(decide(assessment({ level: 'Medium' })), 'veto-window');
    assert.equal(decide(assessment({ level: 'High' })), 'escalate');
  });

  it('podział i blokada bramek jakości mają pierwszeństwo przed poziomem', () => {
    assert.equal(decide(assessment({ split: true, gates: { status: 'block', findings: [] } })), 'split');
    assert.equal(decide(assessment({ gates: { status: 'block', findings: [] } })), 'fix-gates');
    assert.equal(decide(assessment({ gates: { status: 'warn', findings: [] } })), 'merge');
  });
});

describe('komentarz z werdyktem', () => {
  const record = shadowRecord(
    7,
    assessment({ level: 'Medium' }),
    { review_rounds: 2, reviews: [{ perspective: 'tests', verdict: 'approve', confidence: 0.7, summary: 's', findings: [] }] },
  );

  it('zapisuje rundę, decyzję i pewność recenzentów', () => {
    assert.deepEqual(record, {
      pr: 7,
      round: 2,
      level: 'Medium',
      action: 'veto-window',
      reviews: [{ perspective: 'tests', verdict: 'approve', confidence: 0.7 }],
    });
  });

  it('mówi właścicielowi, co fabryka by zrobiła i jak ocenić werdykt', () => {
    const body = shadowComment(record, config);
    assert.ok(body.startsWith(SHADOW_MARKER));
    assert.match(body, /runda 2/);
    assert.match(body, /czekałaby 24 h na \/veto/);
    assert.match(body, /👍 zgoda, 👎 niezgoda/);
  });

  it('dane z komentarza wracają bez zmian, a podrobione albo uszkodzone są odrzucane', () => {
    assert.deepEqual(parseShadow(shadowComment(record, config)), record);
    assert.equal(parseShadow(`<!-- factory:shadow-data ${JSON.stringify(record)} -->`), undefined, 'bez znacznika');
    assert.equal(parseShadow(`${SHADOW_MARKER}\n<!-- factory:shadow-data {"pr": 7, -->`), undefined);
    const bad = { ...record, action: 'deploy' };
    assert.equal(parseShadow(`${SHADOW_MARKER}\n<!-- factory:shadow-data ${JSON.stringify(bad)} -->`), undefined);
  });
});

describe('dane z GitHuba', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-shadow-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path: string, value: unknown) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const comment = (id: number, record: ShadowRecord, login = 'github-actions[bot]') => ({
    id,
    body: shadowComment(record, config),
    user: { login },
    created_at: `2026-11-0${id % 9}T10:00:00Z`,
  });
  const low: ShadowRecord = { pr: 10, round: 0, level: 'Low', action: 'merge', reviews: [] };
  const high: ShadowRecord = { pr: 11, round: 1, level: 'High', action: 'escalate', reviews: [] };

  write('prs.json', [
    {
      number: 10, title: 'Low cofnięty', state: 'MERGED', createdAt: '2026-11-01T09:00:00Z',
      mergedAt: '2026-11-02T12:00:00Z', closedAt: '2026-11-02T12:00:00Z', headRefName: 'factory/1-a',
      labels: [{ name: 'factory:round-1' }, { name: 'factory:round-2' }, { name: 'risk:low' }],
      mergeCommit: { oid: 'abcdef1234567890' }, closingIssuesReferences: [{ number: 1 }],
    },
    {
      number: 11, title: 'High zamknięty', state: 'CLOSED', createdAt: '2026-11-01T09:00:00Z',
      closedAt: '2026-11-03T09:00:00Z', headRefName: 'factory/2-b', mergeCommit: null, closingIssuesReferences: [],
    },
    { number: 12, title: 'nie z fabryki', state: 'OPEN', createdAt: '2026-11-01T09:00:00Z', headRefName: 'feature/x' },
    { number: 13, title: 'z forka', state: 'OPEN', createdAt: '2026-11-01T09:00:00Z', headRefName: 'factory/9-x', isCrossRepository: true },
    {
      number: 14, title: 'bez powiązań po merge', state: 'MERGED', createdAt: '2026-11-04T09:00:00Z',
      mergedAt: '2026-11-04T12:00:00Z', headRefName: 'factory/7-bez-powiazan', closingIssuesReferences: [],
    },
  ]);
  write('issues/7.json', { created_at: '2026-11-04T08:00:00Z' });
  write('comments/10.json', [comment(1, { ...low, level: 'Medium', action: 'veto-window' }), comment(2, low), comment(3, high, 'mallory')]);
  write('comments/11.json', [comment(4, high)]);
  write('reactions/2.json', [
    { content: '-1', user: { login: 'owner' }, created_at: '2026-11-02T10:00:00Z' },
    { content: '+1', user: { login: 'owner' }, created_at: '2026-11-02T11:00:00Z' },
    { content: '-1', user: { login: 'someone' }, created_at: '2026-11-02T12:00:00Z' },
    { content: 'heart', user: { login: 'owner' }, created_at: '2026-11-02T13:00:00Z' },
  ]);
  write('events/1.json', [
    { event: 'labeled', label: { name: 'ready' }, created_at: '2026-11-01T08:00:00Z' },
    { event: 'labeled', label: { name: 'ready' }, created_at: '2026-10-31T08:00:00Z' },
  ]);
  write('reverts.txt', '\x1e2026-11-05T09:00:00Z\tRevert "Low cofnięty"\n\nThis reverts commit abcdef1.\n');

  it('bierze tylko PR-y fabryki z tego repo, ostatni werdykt bota i ostatnią reakcję właściciela', () => {
    const [ten, eleven, fourteen, ...rest] = collectRecords(dir, ['owner'], 7).sort((a, b) => a.number - b.number);
    assert.equal(rest.length, 0);
    assert.equal(fourteen!.number, 14);
    assert.deepEqual(ten, {
      number: 10, title: 'Low cofnięty', state: 'merged', createdAt: '2026-11-01T09:00:00Z',
      mergedAt: '2026-11-02T12:00:00Z', closedAt: '2026-11-02T12:00:00Z', readyAt: '2026-10-31T08:00:00Z',
      rounds: 2, reverted: true, shadow: { record: low, at: '2026-11-02T10:00:00Z', reaction: 'up' },
    });
    assert.equal(eleven!.state, 'closed');
    assert.equal(eleven!.shadow?.record.action, 'escalate');
    assert.equal(eleven!.shadow?.reaction, undefined);
  });

  it('issue bierze z nazwy gałęzi; bez zdarzenia ready liczy od założenia issue', () => {
    assert.equal(issueOf({ headRefName: 'factory/12-menu', closingIssuesReferences: [{ number: 3 }] }), 12);
    assert.equal(issueOf({ headRefName: 'factory/menu', closingIssuesReferences: [{ number: 3 }] }), 3);
    assert.equal(issueOf({ headRefName: 'factory/menu' }), undefined);
    assert.deepEqual(factoryIssues(dir), [1, 2, 7]);
    const fourteen = collectRecords(dir, ['owner'], 7).find((r) => r.number === 14);
    assert.equal(fourteen?.readyAt, '2026-11-04T08:00:00Z');
    // #10: od ready 31.10 8:00 do merge'u 2.11 12:00 to 52 h; #14: od założenia 8:00 do 12:00 to 4 h.
    assert.equal(computeMetrics(collectRecords(dir, ['owner'], 7), config).medianHoursToMerge, (52 + 4) / 2);
  });

  it('revert po oknie revert_days się nie liczy', () => {
    const ten = collectRecords(dir, ['owner'], 2).find((r) => r.number === 10);
    assert.equal(ten?.reverted, false);
  });

  it('reakcje kont spoza listy nie są ocenami', () => {
    assert.equal(collectRecords(dir, ['someone-else'], 7).find((r) => r.number === 10)?.shadow?.reaction, undefined);
  });

  it('czyta wszystkie reverty z historii', () => {
    const text = '\x1e2026-11-05T09:00:00Z\tRevert\n\nThis reverts commit abc1234.\nThis reverts commit def5678.\n\x1e2026-11-06T09:00:00Z\tfix\n';
    assert.deepEqual(parseReverts(text), [
      { at: '2026-11-05T09:00:00Z', sha: 'abc1234' },
      { at: '2026-11-05T09:00:00Z', sha: 'def5678' },
    ]);
  });
});

describe('metryki i Bramka 1', () => {
  it('fałszywe Low: werdykt „scaliłaby”, a właściciel dał 👎, zamknął PR albo cofnął merge', () => {
    assert.equal(isFalseLow(pr({ shadow: verdict('merge', 0.9, 'up') })), false);
    assert.equal(isFalseLow(pr({ shadow: verdict('merge', 0.9, 'down') })), true);
    assert.equal(isFalseLow(pr({ state: 'closed', shadow: verdict('merge') })), true);
    assert.equal(isFalseLow(pr({ reverted: true, shadow: verdict('merge', 0.9, 'up') })), true);
    assert.equal(isFalseLow(pr({ state: 'closed', shadow: verdict('escalate', 0.9, 'up') })), false);
  });

  it('liczy zgodność, rundy poprawek i medianę czasu od ready do merge’u', () => {
    const records = [
      pr({ rounds: 2, readyAt: '2026-11-01T00:00:00Z', mergedAt: '2026-11-01T10:00:00Z', shadow: verdict('merge', 0.9, 'up') }),
      pr({ rounds: 0, readyAt: '2026-11-01T00:00:00Z', mergedAt: '2026-11-01T02:00:00Z', shadow: verdict('veto-window', 0.9, 'up') }),
      pr({ state: 'closed', rounds: 1, shadow: verdict('escalate', 0.9, 'down') }),
      pr({ state: 'open', rounds: 5, shadow: verdict('merge') }),
      pr({ state: 'open' }),
    ];
    const m = computeMetrics(records, config);
    assert.equal(m.withVerdict, 4);
    assert.equal(m.evaluated, 3);
    assert.equal(m.agreed, 2);
    assert.equal(m.agreement, 2 / 3);
    assert.deepEqual(m.falseLow, []);
    assert.equal(m.avgRounds, 1, 'tylko zakończone PR-y');
    assert.equal(m.medianHoursToMerge, 6);
  });

  it('bez danych metryki są puste, a bramka czeka na oceny', () => {
    const m = computeMetrics([], config);
    assert.equal(m.agreement, undefined);
    assert.equal(m.avgRounds, undefined);
    assert.equal(m.medianHoursToMerge, undefined);
    assert.deepEqual(m.gate, { passed: false, missing: ['brakuje 20 ocenionych PR (0 z 20)'] });
  });

  it('bramka przechodzi przy dość ocenach, wysokiej zgodności i bez fałszywych Low', () => {
    const good = Array.from({ length: 20 }, () => pr({ shadow: verdict('merge', 0.9, 'up') }));
    assert.deepEqual(computeMetrics(good, config).gate, { passed: true, missing: [] });
    const bad = [...good.slice(0, 18), pr({ shadow: verdict('merge', 0.9, 'down') }), pr({ shadow: verdict('escalate', 0.9, 'down') })];
    const m = computeMetrics(bad, config);
    assert.equal(m.gate.passed, false);
    assert.equal(m.agreement, 0.9, 'zgodność na progu wystarcza');
    assert.deepEqual(m.gate.missing, ['fałszywe Low: 1 (dozwolone 0)']);
  });

  it('kalibracja progu porównuje odsetek przyjętych PR w grupach pewności', () => {
    const records = [
      ...Array.from({ length: 5 }, () => pr({ shadow: verdict('merge', 0.95) })),
      ...Array.from({ length: 4 }, () => pr({ state: 'closed', shadow: verdict('escalate', 0.6) })),
      pr({ shadow: verdict('escalate', 0.6) }),
      pr({ state: 'open', shadow: verdict('escalate', 0.6) }),
      pr({ shadow: { ...verdict('merge'), record: { ...verdict('merge').record, reviews: [] } } }),
    ];
    const { above, below, enoughData, threshold } = computeMetrics(records, config).calibration;
    assert.equal(threshold, 0.8);
    assert.deepEqual(above, { count: 5, accepted: 1 });
    assert.deepEqual(below, { count: 5, accepted: 0.2 });
    assert.equal(enoughData, true);
  });
});

describe('dziennik', () => {
  it('pokazuje stan bramki, metryki i listę PR-ów z fałszywym Low', () => {
    const records = [
      pr({ number: 42, title: 'Przycisk', state: 'closed', shadow: verdict('merge', 0.9, 'down') }),
      pr({ number: 41, title: 'Menu', state: 'open' }),
    ];
    const body = renderJournal(records, config, '2026-11-07 10:00 UTC');
    assert.match(body, /^\*\*Bramka 1: jeszcze nie\.\*\* brakuje 19 ocenionych PR \(1 z 20\); zgodność 0%, potrzeba co najmniej 90%; fałszywe Low: 1 \(dozwolone 0\)\./);
    assert.match(body, /- Fałszywe Low: 1 \(#42\)/);
    assert.match(body, /- #42 Przycisk · Low, scaliłaby · 👎 · zamknięty bez merge'u · \*\*fałszywe Low\*\*/);
    assert.match(body, /- #41 Menu · bez werdyktu · otwarty/);
    assert.match(body, /Próg pewności recenzentów \(0,8\)/);
    assert.match(body, /_Aktualizacja: 2026-11-07 10:00 UTC\./);
  });

  it('pusty dziennik przed pierwszym PR', () => {
    const body = renderJournal([], config, 'teraz');
    assert.match(body, /- Jeszcze żadnego\./);
    assert.match(body, /- Zgodność: brak danych\n/);
  });

  it('CLI składa dziennik z surowych danych', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-journal-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
      writeFileSync(join(dir, 'prs.json'), JSON.stringify([{ number: 5, title: 'Stopka', state: 'OPEN', createdAt: '2026-11-01T09:00:00Z', headRefName: 'factory/5-stopka' }]));
      const cli = new URL('../workflow/cli.ts', import.meta.url).pathname;
      const result = spawnSync(process.execPath, [cli, 'journal', '--raw', dir, '--config', join(dir, 'config.json'), '--owners', 'owner,'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /- #5 Stopka · bez werdyktu · otwarty/);
      const issues = spawnSync(process.execPath, [cli, 'journal-issues', '--raw', dir], { encoding: 'utf8' });
      assert.equal(issues.stdout.trim(), '5', issues.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
