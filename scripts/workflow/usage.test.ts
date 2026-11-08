import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseUsageBlocks, parseUsageList, readUsage, sessionError, sumUsage, usageBlock } from './usage.ts';
import type { Usage } from './usage.ts';
import { planComment, prBody } from './render.ts';

const RESULT = {
  type: 'result',
  subtype: 'success',
  duration_ms: 8791,
  num_turns: 6,
  total_cost_usd: 0.1149949,
  usage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 },
  modelUsage: {
    'model-a': { inputTokens: 12, outputTokens: 350, cacheReadInputTokens: 2100, cacheCreationInputTokens: 600, costUSD: 0.1 },
    'model-b': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
  },
};

const usage = (stage: Usage['stage'], cost: number, output = 100): Usage => ({
  stage, count: 1, cost, turns: 2, ms: 1000, input: 10, output, cacheRead: 0, cacheWrite: 0,
});

describe('zużycie etapów', () => {
  it('czyta ostatni wynik z pliku przebiegu i sumuje tokeny wszystkich modeli sesji', () => {
    const messages = [{ type: 'system', subtype: 'init' }, { type: 'assistant' }, RESULT];
    assert.deepEqual(readUsage(messages, 'review'), {
      stage: 'review', count: 1, cost: 0.1149949, turns: 6, ms: 8791, input: 112, output: 370, cacheRead: 2100, cacheWrite: 600,
    });
  });

  it('bez modelUsage bierze usage głównej pętli; bez wyniku nie zgaduje', () => {
    const { modelUsage: _, ...plain } = RESULT;
    assert.deepEqual(readUsage(plain, 'plan'), {
      stage: 'plan', count: 1, cost: 0.1149949, turns: 6, ms: 8791, input: 10, output: 300, cacheRead: 2000, cacheWrite: 500,
    });
    assert.equal(readUsage([{ type: 'system' }], 'plan'), undefined);
    assert.equal(readUsage(null, 'plan'), undefined);
  });

  it('błąd sesji trafia do logu, bo akcja ukrywa pełne wyjście', () => {
    assert.equal(sessionError([RESULT]), undefined);
    assert.equal(sessionError([{ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit\nreached' }]), 'Claude AI usage limit reached');
    assert.equal(sessionError({ type: 'result', subtype: 'success', is_error: true }), 'bez opisu (success)');
  });

  it('sumuje na etap w kolejności taśmy', () => {
    const totals = sumUsage([usage('review', 0.1), usage('assess', 0.05), usage('review', 0.2, 50)]);
    assert.deepEqual(totals.map((t) => [t.stage, t.count, t.cost, t.output]), [['review', 2, 0.3, 150], ['assess', 1, 0.05, 100]]);
  });

  it('blok w komentarzu wraca bez zmian, a podrobione pola odpadają', () => {
    const records = [usage('plan', 0.3), usage('implement', 0.5)];
    assert.deepEqual(parseUsageBlocks(`tekst\n${usageBlock(records)}\nkoniec`), records);
    assert.deepEqual(parseUsageList([{ stage: 'deploy', cost: 1 }, { stage: 'plan', cost: 'dużo', turns: -3 }, 7]), [
      { stage: 'plan', count: 0, cost: 0, turns: 0, ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
    assert.deepEqual(parseUsageBlocks('<!-- factory:usage [zepsute -->'), []);
  });

  it('komentarz planu i opis PR niosą blok zużycia', () => {
    const plan = { decision: 'planned', summary: 's', expected_level: 'Low', size: { lines: 1, files: 1 } };
    assert.deepEqual(parseUsageBlocks(planComment(plan, undefined, [usage('plan', 0.3)])), [usage('plan', 0.3)]);
    assert.doesNotMatch(planComment(plan), /factory:usage/);
    const implementation = { issue: 1, bugfix: false, acceptance: [], assumptions: [] };
    assert.deepEqual(parseUsageBlocks(prBody(implementation, [usage('implement', 0.5)])), [usage('implement', 0.5)]);
  });

  it('CLI: zapis z pliku przebiegu, suma katalogu i opis PR z rundami poprzednimi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-usage-'));
    const cli = (args: string[]) => spawnSync(process.execPath, [new URL('./cli.ts', import.meta.url).pathname, ...args], { encoding: 'utf8' });
    try {
      writeFileSync(join(dir, 'exec.json'), JSON.stringify([RESULT]));
      assert.equal(cli(['usage', '--file', join(dir, 'exec.json'), '--stage', 'review', '--out', join(dir, 'u', 'a.json')]).status, 1, 'brak katalogu to błąd');
      spawnSync('mkdir', ['-p', join(dir, 'u')]);
      assert.equal(cli(['usage', '--file', join(dir, 'exec.json'), '--stage', 'review', '--out', join(dir, 'u', 'a.json')]).status, 0);
      assert.equal(cli(['usage', '--file', join(dir, 'brak.json'), '--stage', 'review', '--out', join(dir, 'u', 'b.json')]).status, 0);
      writeFileSync(join(dir, 'u', 'c.json'), JSON.stringify([usage('assess', 0.05)]));
      const sum = JSON.parse(cli(['usage-sum', '--dir', join(dir, 'u')]).stdout) as Usage[];
      assert.deepEqual(sum.map((s) => [s.stage, s.count]), [['review', 1], ['assess', 1]]);

      writeFileSync(join(dir, 'impl.json'), JSON.stringify({ issue: 4, bugfix: false, acceptance: [], assumptions: [] }));
      writeFileSync(join(dir, 'prev.md'), `stary opis\n${usageBlock([usage('implement', 0.4)])}`);
      writeFileSync(join(dir, 'new.json'), JSON.stringify([usage('implement', 0.6)]));
      const body = cli(['pr-body', '--implementation', join(dir, 'impl.json'), '--usage', join(dir, 'new.json'), '--previous', join(dir, 'prev.md')]);
      assert.deepEqual(parseUsageBlocks(body.stdout).map((u) => u.cost), [0.4, 0.6]);
      assert.ok(!readFileSync(join(dir, 'u', 'a.json'), 'utf8').includes('"type"'), 'zapisany jest sam rekord');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
