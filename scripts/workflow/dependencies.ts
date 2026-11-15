// Nowe zależności z planu instaluje workflow, nie implementer: implementer nie dostaje ogólnej komendy
// instalacji, bo w jego jobie działa token subskrypcji, a obcy pakiet mógłby go odczytać. Plan z nowymi
// zależnościami czeka na zgodę właściciela (/approve w issue), a dopiero potem workflow je instaluje.
// Projekt może mieć kilka menedżerów pakietów: domyślny (dependencies.add) i nazwane (dependencies.ecosystems),
// np. npm dla frontu i cargo dla Rusta.

import type { EcosystemCommands, FactoryConfig } from '../config/spec.ts';
import { DEPENDENCY_ECOSYSTEM, DEPENDENCY_FEATURE, DEPENDENCY_NAME, DEPENDENCY_VERSION } from '../agents/output.ts';

export interface Dependency {
  name: string;
  version: string;
  dev?: boolean;
  /** Menedżer z dependencies.ecosystems; bez pola: domyślny. */
  ecosystem?: string;
  /** Funkcje pakietu, np. feature skrzyni Rusta; wymagają flagi `features` menedżera. */
  features?: string[];
}

export type Install = { ok: true; commands: string[] } | { ok: false; reason: string };

/** Komendy instalacji z planu. Nazwy, wersje i funkcje sprawdza tu drugi raz, bo trafiają do powłoki. */
export function installCommands(dependencies: readonly Dependency[], config: Pick<FactoryConfig, 'dependencies'>): Install {
  const commands: string[] = [];
  for (const d of dependencies) {
    const features = d.features ?? [];
    const valid =
      DEPENDENCY_NAME.test(d.name) &&
      DEPENDENCY_VERSION.test(d.version) &&
      (d.ecosystem === undefined || DEPENDENCY_ECOSYSTEM.test(d.ecosystem)) &&
      features.every((f) => DEPENDENCY_FEATURE.test(f));
    if (!valid) return { ok: false, reason: `nieprawidłowa zależność w planie: ${JSON.stringify(d)}` };

    const prefix = d.ecosystem ? `dependencies.ecosystems.${d.ecosystem}` : 'dependencies';
    const manager: EcosystemCommands | undefined = d.ecosystem ? config.dependencies.ecosystems?.[d.ecosystem] : config.dependencies;
    if (!manager) return { ok: false, reason: `plan dodaje zależność ${d.name} z menedżera „${d.ecosystem}”, a factory.yml nie ma ${prefix}` };
    const base = d.dev ? manager.add_dev : manager.add;
    if (!base) {
      return { ok: false, reason: `plan dodaje zależność ${d.name}, a factory.yml nie ma komendy ${prefix}.${d.dev ? 'add_dev' : 'add'}` };
    }
    if (features.length > 0 && !manager.features) {
      return { ok: false, reason: `plan podaje funkcje pakietu ${d.name}, a factory.yml nie ma flagi ${prefix}.features` };
    }
    const suffix = features.length > 0 ? ` ${manager.features} ${features.join(',')}` : '';
    commands.push(`${base} ${d.name}@${d.version}${suffix}`);
  }
  return { ok: true, commands };
}
