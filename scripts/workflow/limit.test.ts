import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { laterUntil, limitPausedComment, limitStopBody, lineState, parseLimit, stopUntil, usageLimit } from './limit.ts';

const now = new Date('2026-11-12T13:15:00Z');
const session = (result: string, cost = 0) => [{ type: 'system' }, { type: 'result', is_error: true, result, total_cost_usd: cost }];

describe('limit subskrypcji', () => {
  it('rozpoznaje komunikat o limicie i godzinę resetu w UTC, z zapasem 2 minut', () => {
    assert.deepEqual(parseLimit("You've hit your 5-hour limit · resets 4:10pm (UTC)", now), { until: '2026-11-12T16:12:00.000Z' });
    assert.deepEqual(parseLimit('Claude AI usage limit reached|1794500000', now), { until: new Date(1794500000 * 1000 + 120_000).toISOString() });
    assert.deepEqual(parseLimit("You've reached your weekly limit · resets 9am", now), { until: '2026-11-13T09:02:00.000Z' }, 'godzina już minęła: jutro');
    assert.deepEqual(parseLimit('Usage limit reached, resets at 16:00 (UTC)', now), { until: '2026-11-12T16:02:00.000Z' });
  });

  it('bez godziny albo z inną strefą czeka pełne okno 5 godzin; inny błąd to nie limit', () => {
    assert.deepEqual(parseLimit("You've hit your usage limit", now), { until: '2026-11-12T18:15:00.000Z' });
    assert.deepEqual(parseLimit("You've hit your 5-hour limit · resets 4:10pm (Europe/Warsaw)", now), { until: '2026-11-12T18:15:00.000Z' });
    assert.equal(parseLimit('API Error: 500 Internal Server Error', now), undefined);
    assert.equal(parseLimit('Credit balance is too low', now), undefined);
  });

  it('czyta limit z pliku przebiegu claude-code-action', () => {
    assert.deepEqual(usageLimit(session("You've hit your 5-hour limit · resets 4:10pm (UTC)"), now), { until: '2026-11-12T16:12:00.000Z' });
    assert.equal(usageLimit(session('Something else went wrong', 0.3), now), undefined);
    assert.equal(usageLimit([{ type: 'result', is_error: false, result: 'ok' }], now), undefined);
  });

  it('stan taśmy: /stop trzyma do /start, limit do swojej godziny, a po niej issue jest do zamknięcia', () => {
    const limit = (number: number, until: string) => ({ number, body: limitStopBody(until, 'implement', '46') });
    const manual = { number: 9, body: 'Taśmę zatrzymała komenda `/stop`.\n\n<!-- factory:stop {"reason":"test","from":"37"} -->' };
    assert.deepEqual(lineState([], now), { stopped: false, expired: [] });
    assert.deepEqual(lineState([limit(50, '2026-11-12T16:12:00.000Z')], now), { stopped: true, issue: 50, expired: [] });
    assert.deepEqual(lineState([limit(50, '2026-11-12T12:00:00.000Z')], now), { stopped: false, expired: [50] });
    assert.deepEqual(lineState([limit(50, '2026-11-12T12:00:00.000Z'), manual], now), { stopped: true, issue: 9, expired: [50] }, '/stop dalej trzyma');
    assert.equal(stopUntil(manual.body), undefined);
    assert.equal(stopUntil('<!-- factory:stop {"until":"wczoraj"} -->'), undefined, 'zły czas to nie limit');
  });

  it('treści dla właściciela: godzina resetu, wznowienie i znaczniki dla taśmy', () => {
    const body = limitStopBody('2026-11-12T16:12:00.000Z', 'implement', '46');
    assert.match(body, /do 16:12 UTC \(2026-11-12\)/);
    assert.match(body, /<!-- factory:stop \{"reason":"limit subskrypcji Claude do 16:12 UTC \(2026-11-12\)","until":"2026-11-12T16:12:00\.000Z"\} -->/);
    const comment = limitPausedComment({ until: '2026-11-12T16:12:00.000Z', stage: 'review', issue: '', pr: '46', note: '', stop: '50', run: 'https://example.test/run' });
    assert.match(comment, /etap „review” czeka do 16:12 UTC/);
    assert.match(comment, /<!-- factory:paused \{"stage":"review","issue":"","pr":"46","note":""\} -->/);
    assert.equal(laterUntil('2026-11-12T17:00:00.000Z', '2026-11-12T16:12:00.000Z'), '2026-11-12T17:00:00.000Z');
    assert.equal(laterUntil(undefined, '2026-11-12T16:12:00.000Z'), '2026-11-12T16:12:00.000Z');
  });

  it('CLI działa bez zależności z npm i zwraca wiersze do $GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-limit-'));
    const cli = (...args: string[]) => spawnSync(process.execPath, [new URL('./limit-cli.ts', import.meta.url).pathname, ...args], { encoding: 'utf8' });
    try {
      writeFileSync(join(dir, 'exec.json'), JSON.stringify(session("You've hit your 5-hour limit · resets 4:10pm (UTC)")));
      assert.match(cli('limit', '--file', join(dir, 'exec.json')).stdout, /^limited=true\nuntil=\d{4}-\d\d-\d\dT16:12:00\.000Z\n$/);
      assert.equal(cli('limit', '--file', join(dir, 'brak.json')).stdout, 'limited=false\n');
      writeFileSync(join(dir, 'issues.json'), JSON.stringify([{ number: 7, body: limitStopBody('2020-01-01T00:00:00.000Z', 'plan', '3') }]));
      assert.equal(cli('line-state', '--issues', join(dir, 'issues.json')).stdout, 'stopped=false\nissue=\nexpired=7\n');
      assert.equal(cli('nic').status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
