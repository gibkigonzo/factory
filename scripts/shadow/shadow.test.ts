import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { configWith } from '../risk/fixtures.ts';
import type { Assessment } from '../risk/types.ts';
import { collectIssueTasks, collectLineProblems, collectRecords, factoryIssues, issueOf, parseReverts, stopState } from './collect.ts';
import { journalCsv, journalJson, problemsCsv, taskRows } from './export.ts';
import { lineProblemBlock } from '../workflow/render.ts';
import type { PrRecord } from './collect.ts';
import { parseShadow, shadowComment, shadowRecord, SHADOW_MARKER } from './comment.ts';
import type { ShadowRecord } from './comment.ts';
import { decide } from './decision.ts';
import type { Action } from './decision.ts';
import { renderJournal } from './journal.ts';
import { computeMetrics, isFalseLow } from './metrics.ts';
import { roundComment } from '../workflow/loop.ts';
import { usageBlock } from '../workflow/usage.ts';
import type { Usage } from '../workflow/usage.ts';

const spend = (stage: Usage['stage'], cost: number, output = 1000): Usage => ({
  stage, count: 1, cost, turns: 3, ms: 1000, input: 10, output, cacheRead: 0, cacheWrite: 0,
});

const config = configWith();

/** Komentarz werdyktu z dowolnymi danymi, np. dawnym poziomem Medium sprzed dwóch poziomów ryzyka. */
function legacyBody(record: object): string {
  return `${SHADOW_MARKER}\n<!-- factory:shadow-data ${JSON.stringify(record)} -->`;
}

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return { level: 'Low', split: false, rules: [], gates: { status: 'pass', findings: [] }, ...overrides };
}

function verdict(action: Action, confidence = 0.9, reaction?: 'up' | 'down'): NonNullable<PrRecord['shadow']> {
  const record: ShadowRecord = {
    pr: 1,
    round: 0,
    level: action === 'merge' ? 'Low' : 'High',
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
  it('dwa poziomy: Low scala, High przekazuje właścicielowi', () => {
    assert.equal(decide(assessment()), 'merge');
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
    assessment({ level: 'High' }),
    { review_rounds: 2, reviews: [{ perspective: 'tests', verdict: 'approve', confidence: 0.7, summary: 's', findings: [] }] },
  );

  it('zapisuje rundę, decyzję i pewność recenzentów', () => {
    assert.deepEqual(record, {
      pr: 7,
      round: 2,
      level: 'High',
      action: 'escalate',
      reviews: [{ perspective: 'tests', verdict: 'approve', confidence: 0.7 }],
    });
  });

  it('mówi właścicielowi, co fabryka by zrobiła i jak ocenić werdykt', () => {
    const body = shadowComment(record);
    assert.ok(body.startsWith(SHADOW_MARKER));
    assert.match(body, /runda 2/);
    assert.match(body, /przekazałaby decyzję Tobie\*\* \(poziom High\)/);
    assert.doesNotMatch(body, /veto/);
    assert.match(body, /👍 zgoda, 👎 niezgoda/);
  });

  it('dane z komentarza wracają bez zmian, a podrobione albo uszkodzone są odrzucane', () => {
    assert.deepEqual(parseShadow(shadowComment(record)), record);
    assert.equal(parseShadow(`<!-- factory:shadow-data ${JSON.stringify(record)} -->`), undefined, 'bez znacznika');
    assert.equal(parseShadow(`${SHADOW_MARKER}\n<!-- factory:shadow-data {"pr": 7, -->`), undefined);
    const bad = { ...record, action: 'deploy' };
    assert.equal(parseShadow(`${SHADOW_MARKER}\n<!-- factory:shadow-data ${JSON.stringify(bad)} -->`), undefined);
  });

  it('dawny werdykt Medium z oknem weta czyta jako eskalację do właściciela, z adnotacją', () => {
    const old = { pr: 7, round: 0, level: 'Medium', action: 'veto-window', reviews: [] };
    assert.deepEqual(parseShadow(legacyBody(old)), { ...old, level: 'High', action: 'escalate', recalculated: 'Medium' });
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
    body: shadowComment(record),
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
      body: `Closes #1\n${usageBlock([spend('implement', 0.6), spend('implement', 0.2)])}`,
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
  write('comments/10.json', [
    { ...comment(1, low), body: legacyBody({ ...low, level: 'Medium', action: 'veto-window', usage: [spend('review', 0.5), spend('assess', 0.1)] }) },
    comment(2, { ...low, usage: [spend('review', 0.4)] }),
    comment(3, { ...high, usage: [spend('review', 99)] }, 'mallory'),
  ]);
  write('plans/1.json', [{ body: `plan\n${usageBlock([spend('plan', 0.3)])}` }]);
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
  write('issue-list.json', [
    { number: 1, title: 'Low cofnięty', state: 'CLOSED', labels: [{ name: 'planned' }], createdAt: '2026-10-31T07:00:00Z' },
    { number: 20, title: 'Zablokowane', state: 'OPEN', labels: [{ name: 'planned' }, { name: 'blocked' }], createdAt: '2026-11-05T07:00:00Z' },
    { number: 21, title: 'Odrzucone', state: 'CLOSED', labels: [{ name: 'rejected' }], createdAt: '2026-11-05T07:00:00Z', closedAt: '2026-11-06T07:00:00Z' },
    { number: 22, title: 'Zwykłe issue', state: 'OPEN', labels: [{ name: 'bug' }], createdAt: '2026-11-05T07:00:00Z' },
  ]);
  write('plans/20.json', [
    { body: `plan\n${usageBlock([spend('plan', 0.4)])}\n${lineProblemBlock({ stage: 'plan', problem: 'Brak komendy lint', at: '2026-11-05T08:00:00Z' })}` },
    { body: `<!-- factory:blocked -->\nblokada\n${usageBlock([spend('implement', 0.3)])}` },
  ]);
  const typecheck = { stage: 'implement', problem: 'typecheck wypisuje szum vue-tsc', at: '2026-11-06T08:00:00Z' };
  write('prs.json', [
    ...JSON.parse(readFileSync(join(dir, 'prs.json'), 'utf8')).map((pr: { number: number; body?: string }) =>
      pr.number === 14 ? { ...pr, body: `${lineProblemBlock(typecheck)}\n${lineProblemBlock(typecheck)}` } : pr),
  ]);
  write('stopped.json', [{ number: 40, createdAt: '2026-11-07T09:00:00Z', body: 'Taśma\n<!-- factory:stop {"reason":"szum typecheck \\u003cvue-tsc\\u003e","from":"30"} -->' }]);

  it('bierze tylko PR-y fabryki z tego repo, ostatni werdykt bota i ostatnią reakcję właściciela', () => {
    const [ten, eleven, fourteen, ...rest] = collectRecords(dir, ['owner'], 7).sort((a, b) => a.number - b.number);
    assert.equal(rest.length, 0);
    assert.equal(fourteen!.number, 14);
    assert.deepEqual(ten, {
      number: 10, issue: 1, title: 'Low cofnięty', state: 'merged', createdAt: '2026-11-01T09:00:00Z',
      mergedAt: '2026-11-02T12:00:00Z', closedAt: '2026-11-02T12:00:00Z', readyAt: '2026-10-31T08:00:00Z',
      rounds: 2, reverted: true, shadow: { record: { ...low, usage: [spend('review', 0.4)] }, at: '2026-11-02T10:00:00Z', reaction: 'up' },
      usage: ten!.usage,
    });
    assert.equal(eleven!.state, 'closed');
    assert.equal(eleven!.shadow?.record.action, 'escalate');
    assert.equal(eleven!.shadow?.reaction, undefined);
  });

  it('issue bierze z nazwy gałęzi; bez zdarzenia ready liczy od założenia issue', () => {
    assert.equal(issueOf({ headRefName: 'factory/12-menu', closingIssuesReferences: [{ number: 3 }] }), 12);
    assert.equal(issueOf({ headRefName: 'factory/menu', closingIssuesReferences: [{ number: 3 }] }), 3);
    assert.equal(issueOf({ headRefName: 'factory/menu' }), undefined);
    assert.deepEqual(factoryIssues(dir), [1, 2, 7, 20, 21], 'także issue z etykietami taśmy bez PR');
    const fourteen = collectRecords(dir, ['owner'], 7).find((r) => r.number === 14);
    assert.equal(fourteen?.readyAt, '2026-11-04T08:00:00Z');
    // #10: od ready 31.10 8:00 do merge'u 2.11 12:00 to 52 h; #14: od założenia 8:00 do 12:00 to 4 h.
    assert.equal(computeMetrics(collectRecords(dir, ['owner'], 7), config).medianHoursToMerge, (52 + 4) / 2);
  });

  it('koszt recenzji rundy odesłanej do implementera bierze z komentarza rundy, bez podróbek', () => {
    const own = mkdtempSync(join(tmpdir(), 'factory-rounds-'));
    try {
      const named = (name: string, cost: number) => ({ ...spend('review', cost), name });
      writeFileSync(join(own, 'prs.json'), JSON.stringify([
        { number: 40, title: 'Pętla', state: 'OPEN', createdAt: '2026-11-01T09:00:00Z', headRefName: 'factory/39-petla', body: '' },
      ]));
      mkdirSync(join(own, 'comments'));
      writeFileSync(join(own, 'comments', '40.json'), JSON.stringify([
        { id: 1, body: shadowComment({ pr: 40, round: 1, level: 'Low', action: 'merge', reviews: [], usage: [named('spec', 0.2)] }), user: { login: 'github-actions[bot]' }, created_at: '2026-11-02T10:00:00Z' },
      ]));
      mkdirSync(join(own, 'rounds'));
      writeFileSync(join(own, 'rounds', '40.json'), JSON.stringify([
        { body: roundComment({ reviews: [], round: 0, maxRounds: 3 }, [named('spec', 0.3), named('tests', 0.1)]) },
        { body: `nie runda\n${usageBlock([named('spec', 50)])}` },
      ]));
      const usage = collectRecords(own, ['owner'], 7)[0]!.usage!;
      assert.deepEqual(usage.map((u) => [u.name, u.count, u.cost]), [['spec', 2, 0.5], ['tests', 1, 0.1]]);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('/change po „scal” liczy ten werdykt jako 👎; po eskalacji to zgoda; dawne Medium liczy się jak eskalacja', () => {
    const own = mkdtempSync(join(tmpdir(), 'factory-change-'));
    try {
      const put = (path: string, value: unknown) => {
        mkdirSync(join(own, path, '..'), { recursive: true });
        writeFileSync(join(own, path), JSON.stringify(value));
      };
      const verdict = (id: number, round: number, level: string, action: string, at: string) => ({
        id, body: legacyBody({ pr: 50, round, level, action, reviews: [] }), user: { login: 'github-actions[bot]' }, created_at: at,
      });
      const pr = (number: number) => ({ number, title: `PR ${number}`, state: 'MERGED', createdAt: '2026-11-12T05:00:00Z', mergedAt: '2026-11-12T07:00:00Z', headRefName: `factory/${number}-x` });
      put('prs.json', [pr(50), pr(51), pr(52), pr(53), pr(54)]);
      const twoVerdicts = (first: ShadowRecord['action'], level: ShadowRecord['level']) => [
        verdict(1, 0, level, first, '2026-11-12T05:58:00Z'),
        verdict(2, 1, 'Low', 'merge', '2026-11-12T06:53:00Z'),
      ];
      // #50: Low, potem /change, potem drugi werdykt z 👍. Liczy się pierwszy werdykt jako 👎 (fałszywe Low).
      put('comments/50.json', twoVerdicts('merge', 'Low'));
      put('reactions/2.json', [{ content: '+1', user: { login: 'owner' }, created_at: '2026-11-12T06:55:00Z' }]);
      put('changes/50.json', [{ user: { login: 'owner' }, created_at: '2026-11-12T06:43:00Z' }]);
      // #51: eskalacja (High), potem /change: zgoda, liczy się ostatni werdykt.
      put('comments/51.json', twoVerdicts('escalate', 'High'));
      put('changes/51.json', [{ user: { login: 'owner' }, created_at: '2026-11-12T06:43:00Z' }]);
      // #52: /change od kogoś spoza właścicieli się nie liczy.
      put('comments/52.json', twoVerdicts('merge', 'Low'));
      put('changes/52.json', [{ user: { login: 'mallory' }, created_at: '2026-11-12T06:43:00Z' }]);
      // #53: dawne Medium (dziś eskalacja), 👍 właściciela na tym werdykcie i /change: reakcja ma pierwszeństwo.
      put('comments/53.json', [verdict(7, 0, 'Medium', 'veto-window', '2026-11-12T05:58:00Z'), verdict(8, 1, 'Low', 'merge', '2026-11-12T06:53:00Z')]);
      put('reactions/7.json', [{ content: '+1', user: { login: 'owner' }, created_at: '2026-11-12T06:00:00Z' }]);
      put('changes/53.json', [{ user: { login: 'owner' }, created_at: '2026-11-12T06:43:00Z' }]);
      // #54: dawne Medium bez reakcji, potem /change, a ostatni werdykt bez oceny: eskalacja z /change to 👍.
      put('comments/54.json', [verdict(9, 0, 'Medium', 'veto-window', '2026-11-12T05:58:00Z'), verdict(10, 1, 'Low', 'merge', '2026-11-12T06:53:00Z')]);
      put('changes/54.json', [{ user: { login: 'owner' }, created_at: '2026-11-12T06:43:00Z' }]);
      const records = collectRecords(own, ['owner'], 7);
      const shadow = (n: number) => records.find((r) => r.number === n)?.shadow;
      assert.deepEqual([shadow(50)?.record.round, shadow(50)?.reaction, shadow(50)?.implied], [0, 'down', 'change']);
      assert.ok(isFalseLow(records.find((r) => r.number === 50)!), 'Low z /change to fałszywe Low');
      assert.deepEqual([shadow(51)?.record.round, shadow(51)?.implied], [1, undefined]);
      assert.deepEqual([shadow(52)?.record.round, shadow(52)?.implied], [1, undefined]);
      assert.deepEqual([shadow(53)?.record.round, shadow(53)?.reaction, shadow(53)?.implied], [0, 'up', undefined]);
      assert.deepEqual([shadow(54)?.record.action, shadow(54)?.record.recalculated, shadow(54)?.reaction, shadow(54)?.implied], ['escalate', 'Medium', 'up', 'change']);
      assert.ok(!isFalseLow(records.find((r) => r.number === 54)!));
      assert.match(renderJournal(records, config, 'teraz'), /#54 .*High \(było Medium\), do Ciebie · 👍 \(po \/change\)/);
      assert.match(renderJournal(records, config, 'teraz'), /#50 .*👎 \(po \/change\)/);
      assert.match(journalCsv(taskRows(records, [])), /👎 \(po \/change\)/);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('zużycie zbiera z planu, opisu PR i wszystkich werdyktów bota, zsumowane na etap', () => {
    const ten = collectRecords(dir, ['owner'], 7).find((r) => r.number === 10);
    assert.deepEqual(ten?.usage?.map((u) => [u.stage, u.count, u.cost]), [
      ['plan', 1, 0.3],
      ['implement', 2, 0.8],
      ['review', 2, 0.9],
      ['assess', 1, 0.1],
    ]);
    const m = computeMetrics(collectRecords(dir, ['owner'], 7), config).cost;
    assert.equal(m?.prs, 1, 'tylko PR z pomiarem');
    assert.equal(m?.perPr.toFixed(2), '2.10');
    assert.deepEqual(m?.stages.map((s) => [s.stage, s.perPr.toFixed(2)]), [['plan', '0.30'], ['implement', '0.80'], ['review', '0.90'], ['assess', '0.10']]);
  });

  it('koszt recenzentów osobno i podział wyjścia w dzienniku', () => {
    const record = (number: number, usage: Usage[]) => ({ number, title: `PR ${number}`, usage }) as never;
    const named = (name: string, cost: number) => ({ ...spend('review', cost), name, chars: { thinking: 6, text: 2, tools: 2 } });
    const m = computeMetrics([record(1, [named('security', 0.4), named('tests', 0.1)]), record(2, [named('security', 0.2), spend('plan', 0.3)])], config).cost!;
    assert.deepEqual(m.reviewers.map((r) => [r.name, r.perPr.toFixed(2)]), [['security', '0.30'], ['tests', '0.10']]);
    assert.deepEqual(m.output, { thinking: 0.6, text: 0.2, tools: 0.2 });
    const body = renderJournal([record(1, [named('security', 0.4), named('tests', 0.1)])], config, 'teraz');
    assert.match(body, /- Recenzenci, średnio na PR: security 0,40 USD · tests 0,10 USD/);
    assert.match(body, /- Wyjście \(znaki\): rozumowanie 60% · tekst 20% · narzędzia, w tym kod 20%/);
  });

  it('zadania bez PR: po etykietach taśmy, z kosztem planu i zablokowanej implementacji', () => {
    assert.deepEqual(factoryIssues(dir), [1, 2, 7, 20, 21]);
    const tasks = collectIssueTasks(dir);
    assert.deepEqual(tasks.map((t) => [t.issue, t.state, t.labels.join('+')]), [[21, 'closed', 'rejected'], [20, 'open', 'planned+blocked']]);
    assert.deepEqual(tasks.find((t) => t.issue === 20)?.usage?.map((u) => [u.stage, u.cost]), [['plan', 0.4], ['implement', 0.3]]);
    assert.equal(tasks.find((t) => t.issue === 21)?.usage, undefined);
  });

  it('statystyki w plikach: wiersz na zadanie, koszt na etap i recenzenta, ocena i bezpieczne komórki CSV', () => {
    const named = (name: string, cost: number) => ({ ...spend('review', cost), name });
    const prs = collectRecords(dir, ['owner'], 7).map((r) => (r.number === 10 ? { ...r, usage: [...(r.usage ?? []), named('security', 0.25)] } : r));
    const rows = taskRows([...prs, { number: 30, title: '=HYPERLINK("x")', state: 'open', createdAt: 'x', rounds: 0, reverted: false } as never], collectIssueTasks(dir));
    assert.deepEqual(rows.map((r) => [r.issue, r.pr]), [[undefined, 30], [21, undefined], [20, undefined], [7, 14], [2, 11], [1, 10]], 'od najnowszego numeru');
    const csv = journalCsv(rows).split('\n');
    const line = (start: string) => csv.find((l) => l.startsWith(start))!;
    assert.equal(csv[0], 'zadanie,pr,tytul,stan,poziom,werdykt,ocena,rundy,cofniety,gotowe,scalone,koszt_usd,plan_usd,implementacja_usd,recenzja_usd,ocena_ryzyka_usd,tokeny_wyjscia,recenzent_security_usd');
    assert.equal(line('20,'), '20,,Zablokowane,bez PR (blocked),,,,0,nie,,,0.7,0.4,0.3,,,2000,');
    assert.equal(line('21,'), '21,,Odrzucone,"bez PR (rejected), zamknięte",,,,0,nie,,,0,,,,,0,');
    assert.ok(line('1,10,').startsWith('1,10,Low cofnięty,scalony,Low,scaliłaby,👍,2,tak,2026-10-31T08:00:00Z,2026-11-02T12:00:00Z,2.35,0.3,0.8,1.15,0.1,'), line('1,10,'));
    assert.ok(line('1,10,').endsWith(',0.25'));
    assert.equal(line(',30,'), `,30,"'=HYPERLINK(""x"")",otwarty,,,,0,nie,,,0,,,,,0,`, 'tytuł nie uruchomi formuły w arkuszu');
    const json = JSON.parse(journalJson(rows, '2026-11-11T08:00:00Z'));
    assert.equal(json.tasks, 6);
    assert.equal(json.cost, 3.05);
    assert.equal(json.rows[5].reviewers.security, 0.25);
  });

  it('problemy taśmy: z planu, blokady i opisu PR, bez powtórzeń, od najnowszego; stan zatrzymanej taśmy', () => {
    assert.deepEqual(collectLineProblems(dir), [
      { ...typecheck, issue: 7, pr: 14 },
      { stage: 'plan', problem: 'Brak komendy lint', at: '2026-11-05T08:00:00Z', issue: 20 },
    ]);
    assert.deepEqual(stopState(dir), { issue: 40, since: '2026-11-07T09:00:00Z', reason: 'szum typecheck <vue-tsc>' });
    const csv = problemsCsv(collectLineProblems(dir)).split('\n');
    assert.equal(csv[0], 'zgloszono,etap,zadanie,pr,problem');
    assert.equal(csv[1], '2026-11-06T08:00:00Z,implement,7,14,typecheck wypisuje szum vue-tsc');
    const json = JSON.parse(journalJson([], 'teraz', { problems: collectLineProblems(dir), stopped: stopState(dir) }));
    assert.equal(json.lineProblems.length, 2);
    assert.equal(json.stopped.issue, 40);
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
      pr({ rounds: 0, readyAt: '2026-11-01T00:00:00Z', mergedAt: '2026-11-01T02:00:00Z', shadow: verdict('escalate', 0.9, 'up') }),
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
    assert.deepEqual(m.gate, { passed: false, missing: ['brakuje 20 ocenionych PR (0 z 20)', 'trafne Low: 0, potrzeba co najmniej 8'] });
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

  it('Bramka 1 wymaga co najmniej min_low trafnych Low w oknie, bo sama zgodność z eskalacjami nie wystarcza', () => {
    const escalations = (n: number) => Array.from({ length: n }, () => pr({ shadow: verdict('escalate', 0.9, 'up') }));
    const lows = (n: number) => Array.from({ length: n }, () => pr({ shadow: verdict('merge', 0.9, 'up') }));
    const onlyEscalations = computeMetrics(escalations(20), config);
    assert.equal(onlyEscalations.window.agreement, 1);
    assert.deepEqual(onlyEscalations.gate.missing, ['trafne Low: 0, potrzeba co najmniej 8']);
    assert.deepEqual(computeMetrics([...escalations(13), ...lows(7)], config).gate.missing, ['trafne Low: 7, potrzeba co najmniej 8']);
    assert.deepEqual(computeMetrics([...escalations(12), ...lows(8)], config).gate, { passed: true, missing: [] });
    // Low zamknięte bez merge'u albo cofnięte nie jest trafne, nawet z 👍.
    const reverted = pr({ reverted: true, shadow: verdict('merge', 0.9, 'up') });
    const m = computeMetrics([...escalations(11), ...lows(8), reverted], config);
    assert.equal(m.window.low, 8);
    assert.deepEqual(m.window.falseLow, [reverted.number]);
  });

  it('Bramka 1 liczy okno ostatnich gate_prs PR: stary błąd wypada z okna, nowy w nim zostaje', () => {
    const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`;
    const withAt = (action: Action, reaction: 'up' | 'down', day: number) => ({ ...verdict(action, 0.9, reaction), at: at(day) });
    const oldFalseLow = pr({ shadow: withAt('merge', 'down', 1) });
    const good = Array.from({ length: 20 }, (_, i) => pr({ shadow: withAt('merge', 'up', i + 2) }));
    const m = computeMetrics([oldFalseLow, ...good], config);
    assert.deepEqual(m.falseLow, [oldFalseLow.number], 'w historii fałszywe Low zostaje');
    assert.equal(m.window.prs.length, 20);
    assert.ok(!m.window.prs.includes(oldFalseLow.number), 'najstarszy werdykt poza oknem');
    assert.deepEqual(m.gate, { passed: true, missing: [] });
    const recentFalseLow = pr({ shadow: withAt('merge', 'down', 25) });
    const later = computeMetrics([oldFalseLow, ...good, recentFalseLow], config);
    assert.deepEqual(later.window.falseLow, [recentFalseLow.number]);
    assert.deepEqual(later.gate.missing, ['fałszywe Low: 1 (dozwolone 0)']);
    // PR bez oceny nie wchodzi do okna, chyba że jest fałszywym Low przez zamknięcie bez merge'u.
    const closed = pr({ state: 'closed', shadow: { ...verdict('merge', 0.9), at: at(26) } });
    const unrated = pr({ shadow: { ...verdict('merge', 0.9), at: at(27) } });
    const w = computeMetrics([...good, closed, unrated], config).window;
    assert.ok(w.prs.includes(closed.number) && !w.prs.includes(unrated.number));
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
    assert.match(body, /^\*\*Bramka 1: jeszcze nie\.\*\* brakuje 19 ocenionych PR \(1 z 20\); zgodność 0%, potrzeba co najmniej 90%; fałszywe Low: 1 \(dozwolone 0\); trafne Low: 0, potrzeba co najmniej 8\./);
    assert.match(body, /- Fałszywe Low: 1 \(#42\)/);
    assert.match(body, /- #42 Przycisk · Low, scaliłaby · 👎 · zamknięty bez merge'u · \*\*fałszywe Low\*\*/);
    assert.match(body, /- #41 Menu · bez werdyktu · otwarty/);
    assert.match(body, /Próg pewności recenzentów \(0,8\)/);
    assert.match(body, /_Aktualizacja: 2026-11-07 10:00 UTC\./);
  });

  it('koszt: średnio na PR i na etap, a przy PR suma', () => {
    const records = [
      pr({ number: 50, title: 'A', usage: [spend('implement', 1), spend('review', 0.5, 3000)] }),
      pr({ number: 51, title: 'B', usage: [spend('implement', 0.5, 2000)] }),
      pr({ number: 52, title: 'C' }),
    ];
    const body = renderJournal(records, config, 'teraz');
    assert.match(body, /- PR z pomiarem: 2, średnio 1,00 USD i 3000 tokenów wyjścia na PR/);
    assert.match(body, /- Etapy, średnio na PR: implementacja 0,75 USD · recenzja 0,25 USD/);
    assert.match(body, /- #50 A · bez werdyktu · scalony · 1,50 USD/);
    assert.match(body, /- #52 C · bez werdyktu · scalony\n/);
    assert.match(body, /- Razem wszystkie zadania: 2,00 USD/);
    assert.doesNotMatch(body, /journal\.csv/);
    const task = { issue: 60, title: 'Blokada', state: 'open', labels: ['blocked'], createdAt: 'x', usage: [spend('plan', 0.5)] } as const;
    const full = renderJournal(records, config, 'teraz', { tasks: [task as never], filesUrl: 'https://example.test/blob/factory-journal' });
    assert.match(full, /- Zadania bez PR \(blokada, podział, odrzucenie, czekające\): 1, razem 0,50 USD\n- Razem wszystkie zadania: 2,50 USD/);
    assert.match(full, /\[journal\.csv\]\(https:\/\/example\.test\/blob\/factory-journal\/journal\.csv\) \(tabela\)/);
  });

  it('zatrzymana taśma na górze dziennika i zbiorcza lista problemów taśmy', () => {
    const problems = Array.from({ length: 12 }, (_, i) => ({ stage: 'implement', problem: `Problem ${i}\n z narzędziem`, at: `2026-11-${String(20 - i).padStart(2, '0')}T08:00:00Z`, issue: i + 1 }));
    const body = renderJournal([], config, 'teraz', { problems, stopped: { issue: 40, since: '2026-11-07T09:15:00Z', reason: 'szum typecheck' } });
    assert.match(body, /^\*\*⏸️ Taśma zatrzymana\*\* od 2026-11-07 09:15 UTC \(#40\): szum typecheck\. [^\n]*`\/start`\.\n\n\*\*Bramka 1/);
    assert.match(body, /## Problemy taśmy\n\nZgłoszenia agentów [^\n]*: 12\./);
    assert.match(body, /- 2026-11-20 · implementacja \(#1\): Problem 0 z narzędziem/);
    assert.match(body, /- …i 2 starszych \(pełna lista w problemy\.csv\)/);
    assert.match(renderJournal([], config, 'teraz'), /## Problemy taśmy\n\n- Brak zgłoszeń\./);
    assert.doesNotMatch(renderJournal([], config, 'teraz'), /Taśma zatrzymana/);
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
      const out = join(dir, 'out');
      mkdirSync(out);
      const exported = spawnSync(process.execPath, [cli, 'journal-export', '--raw', dir, '--config', join(dir, 'config.json'), '--owners', 'owner', '--out', out], { encoding: 'utf8' });
      assert.equal(exported.status, 0, exported.stderr);
      assert.match(readFileSync(join(out, 'journal.csv'), 'utf8'), /^zadanie,pr,tytul,[^\n]*\n5,5,Stopka,otwarty,/);
      assert.equal(JSON.parse(readFileSync(join(out, 'journal.json'), 'utf8')).tasks, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
