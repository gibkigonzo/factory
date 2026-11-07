// CI w taśmie: komendy z factory.yml po kolei, najpierw `setup`. Wynik trafia do dowodów (reguła 5).

import { spawnSync } from 'node:child_process';
import type { FactoryConfig } from '../config/spec.ts';
import type { CiResult } from './evidence.ts';

/** Kolejność: setup, potem typowe sprawdzenia, potem pozostałe komendy projektu w kolejności z factory.yml. */
export function commandOrder(commands: FactoryConfig['commands']): string[] {
  const preferred = ['setup', 'lint', 'typecheck', 'test', 'build'];
  const names = Object.keys(commands);
  return [...preferred.filter((n) => names.includes(n)), ...names.filter((n) => !preferred.includes(n))];
}

export function runCommands(commands: FactoryConfig['commands'], cwd: string, skip: readonly string[] = []): CiResult {
  const results: CiResult['commands'] = [];
  for (const name of commandOrder(commands).filter((n) => !skip.includes(n))) {
    const started = Date.now();
    console.log(`::group::${name}: ${commands[name]}`);
    const run = spawnSync('bash', ['-c', commands[name]!], { cwd, stdio: 'inherit' });
    console.log('::endgroup::');
    const ok = run.status === 0;
    results.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000) });
    if (!ok && name === 'setup') break;
  }
  return { status: results.every((r) => r.ok) ? 'success' : 'failure', commands: results };
}
