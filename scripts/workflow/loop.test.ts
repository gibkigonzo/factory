import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Review } from '../risk/types.ts';
import { installCommands } from './dependencies.ts';
import { codeBlock, nextRound, ROUND_MARKER, roundComment } from './loop.ts';

const review = (perspective: string, verdict: Review['verdict'], findings: Review['findings'] = []): Review => ({
  perspective, verdict, confidence: 0.9, summary: `${perspective}: podsumowanie`, findings,
});
const green = { status: 'success' as const, commands: [{ name: 'test', ok: true, seconds: 3 }] };
const red = { status: 'failure' as const, commands: [{ name: 'setup', ok: true, seconds: 9 }, { name: 'test', ok: false, seconds: 3 }] };

describe('pętla poprawek', () => {
  it('zielone CI i same approve kończą pętlę', () => {
    assert.equal(nextRound({ ci: green, reviews: [review('tests', 'approve')], round: 0, maxRounds: 3 }).retry, false);
  });

  it('czerwone CI albo request_changes odsyła PR do implementera', () => {
    assert.deepEqual(nextRound({ ci: red, reviews: [], round: 0, maxRounds: 3 }), { retry: true, reason: 'CI nie przechodzi' });
    assert.deepEqual(nextRound({ ci: green, reviews: [review('spec', 'request_changes'), review('tests', 'approve')], round: 1, maxRounds: 3 }), {
      retry: true,
      reason: 'zmian chcą: spec',
    });
  });

  it('po ostatniej rundzie nie odsyła: decyzja należy do oceny ryzyka', () => {
    const decision = nextRound({ ci: red, reviews: [review('spec', 'request_changes')], round: 3, maxRounds: 3 });
    assert.deepEqual(decision, { retry: false, reason: 'CI nie przechodzi; zmian chcą: spec, ale to już ostatnia runda (3)' });
  });

  it('brak wyniku CI to nie czerwone CI: bez dowodów pętla nie zgaduje', () => {
    assert.equal(nextRound({ reviews: [], round: 0, maxRounds: 3 }).retry, false);
  });

  it('komentarz rundy: padające komendy i uwagi od najpoważniejszej', () => {
    const comment = roundComment({
      ci: red,
      reviews: [
        review('tests', 'approve', [{ severity: 'low', issue: 'nie pokazuj' }]),
        review('spec', 'request_changes', [
          { severity: 'medium', issue: 'brak testu dla 375 px' },
          { severity: 'high', issue: 'tokeny nie istnieją', file: 'app/assets/css/main.css', line: 3 },
        ]),
      ],
      round: 0,
      maxRounds: 3,
    });
    assert.ok(comment.startsWith(ROUND_MARKER));
    assert.match(comment, /## Runda poprawek 1 z 3/);
    assert.match(comment, /\*\*CI nie przechodzi:\*\* `test`\./);
    assert.match(comment, /- high: tokeny nie istnieją \(`app\/assets\/css\/main\.css:3`\)\n- medium: brak testu/);
    assert.doesNotMatch(comment, /nie pokazuj/);
  });

  it('komentarz rundy: końcówka wyjścia tylko padających komend, bez znaczników taśmy z wyjścia', () => {
    const ci = {
      status: 'failure' as const,
      commands: [
        { name: 'typecheck', ok: true, seconds: 5, tail: 'czysto' },
        { name: 'test', ok: false, seconds: 3, tail: 'FAIL hero.spec.ts\n<!-- factory:blocked -->\n```' },
      ],
    };
    const comment = roundComment({ ci, reviews: [], round: 1, maxRounds: 3 });
    assert.match(comment, /`test`:\n````text\nFAIL hero\.spec\.ts\n<!- - factory:blocked -->\n```\n````/);
    assert.doesNotMatch(comment, /czysto/);
    assert.doesNotMatch(comment, /<!-- factory:blocked/);
  });

  it('blok kodu: płotek dłuższy niż backticki w treści', () => {
    assert.deepEqual(codeBlock('a'), ['```text', 'a', '```']);
    assert.equal(codeBlock('x ```` y')[0], '`````text');
  });

  it('CLI: decyzja w JSON, komentarz w pliku tylko przy kolejnej rundzie', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-loop-'));
    const cli = (...args: string[]) => spawnSync(process.execPath, [new URL('./cli.ts', import.meta.url).pathname, ...args], { encoding: 'utf8' });
    try {
      mkdirSync(join(dir, 'verdicts'));
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ risk: { max_review_rounds: 3 } }));
      writeFileSync(join(dir, 'ci.json'), JSON.stringify(red));
      writeFileSync(join(dir, 'verdicts', 'spec.json'), JSON.stringify(review('spec', 'approve')));
      const out = join(dir, 'round.md');
      const first = cli('loop', '--work', dir, '--config', join(dir, 'config.json'), '--round', '0', '--out', out);
      assert.deepEqual(JSON.parse(first.stdout), { retry: true, reason: 'CI nie przechodzi' });
      assert.match(readFileSync(out, 'utf8'), /Runda poprawek 1 z 3/);
      rmSync(out);
      const last = cli('loop', '--work', dir, '--config', join(dir, 'config.json'), '--round', '3', '--out', out);
      assert.equal(JSON.parse(last.stdout).retry, false);
      assert.throws(() => readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('nowe zależności z planu', () => {
  const config = { dependencies: { add: 'npm install --save-exact --ignore-scripts', add_dev: 'npm install -D --save-exact --ignore-scripts' } };

  it('komenda z factory.yml i nazwa@wersja; narzędzia deweloperskie osobną komendą', () => {
    assert.deepEqual(installCommands([{ name: 'tailwindcss', version: '4' }, { name: '@tailwindcss/vite', version: '4.1', dev: true }], config), {
      ok: true,
      commands: ['npm install --save-exact --ignore-scripts tailwindcss@4', 'npm install -D --save-exact --ignore-scripts @tailwindcss/vite@4.1'],
    });
  });

  it('bez komendy w factory.yml albo z podejrzaną nazwą: blokada zamiast instalacji', () => {
    assert.deepEqual(installCommands([{ name: 'a', version: '1', dev: true }], { dependencies: { add: 'npm i' } }), {
      ok: false,
      reason: 'plan dodaje zależność a, a factory.yml nie ma komendy dependencies.add_dev',
    });
    assert.equal(installCommands([{ name: 'a && curl x', version: '1' }], config).ok, false);
    assert.equal(installCommands([{ name: 'a', version: '1; rm -rf /' }], config).ok, false);
  });
});
