// Nowe zależności z planu instaluje workflow, nie implementer: implementer nie dostaje ogólnej komendy
// instalacji, bo w jego jobie działa token subskrypcji, a obcy pakiet mógłby go odczytać. Plan z nowymi
// zależnościami czeka na zgodę właściciela (/approve w issue), a dopiero potem workflow je instaluje.

import type { FactoryConfig } from '../config/spec.ts';
import { DEPENDENCY_NAME, DEPENDENCY_VERSION } from '../agents/output.ts';

export interface Dependency {
  name: string;
  version: string;
  dev?: boolean;
}

export type Install = { ok: true; commands: string[] } | { ok: false; reason: string };

/** Komendy instalacji z planu. Nazwy i wersje sprawdza tu drugi raz, bo trafiają do powłoki. */
export function installCommands(dependencies: readonly Dependency[], config: Pick<FactoryConfig, 'dependencies'>): Install {
  const commands: string[] = [];
  for (const d of dependencies) {
    if (!DEPENDENCY_NAME.test(d.name) || !DEPENDENCY_VERSION.test(d.version)) {
      return { ok: false, reason: `nieprawidłowa zależność w planie: ${JSON.stringify(d)}` };
    }
    const base = d.dev ? config.dependencies.add_dev : config.dependencies.add;
    if (!base) {
      const field = d.dev ? 'dependencies.add_dev' : 'dependencies.add';
      return { ok: false, reason: `plan dodaje zależność ${d.name}, a factory.yml nie ma komendy ${field}` };
    }
    commands.push(`${base} ${d.name}@${d.version}`);
  }
  return { ok: true, commands };
}
