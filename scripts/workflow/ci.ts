// CI w taśmie: komendy z factory.yml po kolei, najpierw `setup`. Wynik trafia do dowodów (reguła 5).
// Przy każdej komendzie zostaje końcówka jej wyjścia: recenzenci i implementer nie widzą logu przebiegu,
// a z niej mają dowód, co komenda wypisała (np. czysty typecheck albo błąd testu).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FactoryConfig } from '../config/spec.ts';
import type { CiResult } from './evidence.ts';

export const TAIL_LINES = 30;
const LINE_CHARS = 300;
const TAIL_CHARS = 4000;

/** Kolejność: setup, potem typowe sprawdzenia, potem pozostałe komendy projektu w kolejności z factory.yml. */
export function commandOrder(commands: FactoryConfig['commands']): string[] {
  const preferred = ['setup', 'lint', 'typecheck', 'test', 'build'];
  const names = Object.keys(commands);
  return [...preferred.filter((n) => names.includes(n)), ...names.filter((n) => !preferred.includes(n))];
}

/**
 * Ostatnie linie wyjścia bez kolorów terminala. Pasek postępu nadpisuje linię znakiem \r,
 * więc z takiej linii zostaje to, co było widać na końcu. Długie linie i całość są przycięte.
 */
export function outputTail(text: string, lines = TAIL_LINES): string {
  const clean = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
  const all = clean
    .split(/\r?\n/)
    .map((line) => line.split('\r').filter(Boolean).at(-1) ?? '')
    .map((line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line.trimEnd()));
  while (all.length && all.at(-1) === '') all.pop();
  const tail = all.slice(-lines).join('\n');
  return tail.length > TAIL_CHARS ? `…${tail.slice(-TAIL_CHARS)}` : tail;
}

export function runCommands(commands: FactoryConfig['commands'], cwd: string, skip: readonly string[] = []): CiResult {
  const results: CiResult['commands'] = [];
  const dir = mkdtempSync(join(tmpdir(), 'factory-ci-'));
  try {
    for (const name of commandOrder(commands).filter((n) => !skip.includes(n))) {
      const started = Date.now();
      const log = join(dir, `${results.length}.log`);
      console.log(`::group::${name}: ${commands[name]}`);
      // Wyjście idzie do logu przebiegu i do pliku; pipefail zachowuje kod wyjścia komendy, nie tee.
      // Komenda i plik są argumentami, a nie częścią skryptu, więc żaden znak w komendzie go nie psuje.
      const run = spawnSync('bash', ['-c', 'set -o pipefail; bash -c "$1" 2>&1 | tee "$2"', 'factory-ci', commands[name]!, log], {
        cwd,
        stdio: 'inherit',
      });
      console.log('::endgroup::');
      const ok = run.status === 0;
      // Pusty `tail` znaczy, że komenda nic nie wypisała. Bez pliku (tee nie ruszył) pola nie ma.
      let tail: string | undefined;
      try {
        tail = outputTail(readFileSync(log, 'utf8'));
      } catch {
        tail = undefined;
      }
      results.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000), ...(tail === undefined ? {} : { tail }) });
      if (!ok && name === 'setup') break;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { status: results.every((r) => r.ok) ? 'success' : 'failure', commands: results };
}
