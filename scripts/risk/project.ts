// Kontekst projektu dla oceny zmiany: factory.yml i perspektywy projektu z punktu rozgałęzienia,
// czyli z wersji, do której zmiana trafia. Zmiana nie może więc sama poluzować zasad, którymi jest oceniana.

import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.ts';
import type { FactoryConfig } from '../config/spec.ts';
import { loadCatalog, PROJECT_DIR, projectPerspectives, resolvePerspectives } from '../review/perspectives.ts';
import type { PerspectiveDef } from '../review/perspectives.ts';
import { fileAt, git, mergeBase } from './collect.ts';

/** Błąd danych wejściowych: skrypt kończy się czytelnym komunikatem zamiast śladu stosu. */
export class InputError extends Error {}

export interface ProjectContext {
  config: FactoryConfig;
  source: string;
  forkPoint: string;
  /** Włączone perspektywy z definicjami: podstawowe i dodatkowe. */
  perspectives: PerspectiveDef[];
}

function configText(repo: string, forkPoint: string, head: string, path?: string): { text: string; source: string } {
  if (path) return { text: readFileSync(path, 'utf8'), source: path };
  const atBase = fileAt(repo, forkPoint, 'factory.yml');
  if (atBase !== undefined) return { text: atBase, source: 'factory.yml (baza)' };
  const atHead = fileAt(repo, head, 'factory.yml');
  if (atHead !== undefined) return { text: atHead, source: 'factory.yml (gałąź; na bazie go nie ma)' };
  throw new InputError('w repo nie ma factory.yml');
}

function bullets(title: string, errors: readonly string[]): string {
  return `${title}:\n${errors.map((e) => `- ${e}`).join('\n')}`;
}

export function loadProjectContext(repo: string, base: string, head: string, configPath?: string): ProjectContext {
  const forkPoint = mergeBase(repo, base, head);
  const { text, source } = configText(repo, forkPoint, head, configPath);
  const loaded = loadConfig(text, source);
  if (!loaded.ok) throw new InputError(bullets('Konfiguracja odrzucona', loaded.errors));
  const paths = git(repo, ['ls-tree', '-r', '-z', '--name-only', forkPoint, '--', PROJECT_DIR])
    .split('\0')
    .filter((path) => path.endsWith('.md') && path.split('/').length === PROJECT_DIR.split('/').length + 1);
  const project = projectPerspectives(paths.map((path) => ({ path, content: fileAt(repo, forkPoint, path) ?? '' })));
  const resolved = resolvePerspectives(loaded.config, loadCatalog(), project.defs, source);
  const errors = [...project.errors, ...resolved.errors];
  if (errors.length > 0) throw new InputError(bullets('Perspektywy odrzucone', errors));
  return { config: loaded.config, source, forkPoint, perspectives: resolved.enabled };
}
