// Zasady dla zmian implementera, pilnowane przez workflow, a nie przez model:
// nazwa gałęzi factory/*, zakaz zmian w plikach chronionych i workflowach, lista dozwolonych komend.

import type { FactoryConfig } from '../config/spec.ts';
import { matchesAny } from '../risk/glob.ts';

export function branchName(issue: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replaceAll('ł', 'l')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `factory/${issue}${slug ? `-${slug}` : ''}`;
}

/** Ścieżki, których implementer nie może zmienić: pliki chronione i workflowy. */
export function pathProblems(paths: readonly string[], config: FactoryConfig): string[] {
  const problems: string[] = [];
  for (const path of [...paths].sort()) {
    if (matchesAny(path, config.protected_files)) problems.push(`${path}: plik chroniony (protected_files)`);
    else if (path.startsWith('.github/')) problems.push(`${path}: workflowy i konfigurację GitHuba zmienia tylko człowiek`);
  }
  return problems;
}

/** Znaki, które psują cytowanie listy narzędzi w argumentach CLI. Takie komendy uruchamia tylko workflow. */
const UNSAFE = /["'`$,\\]/;

/** Narzędzia implementera: odczyt, edycja i tylko komendy z factory.yml. */
export function implementerTools(config: FactoryConfig): string {
  const commands = Object.values(config.commands)
    .filter((command) => !UNSAFE.test(command))
    .map((command) => `Bash(${command}:*)`);
  // git mv i git rm: zmiana nazwy i usunięcie pliku. Pliki chronione i .github/ i tak odrzuca sprawdzenie ścieżek patcha.
  const git = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git mv:*)', 'Bash(git rm:*)'];
  return [...new Set(['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', ...commands, ...git])].join(',');
}

export const READ_ONLY_TOOLS = 'Read,Grep,Glob';
export const DENIED_FOR_READERS = 'Bash,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch';
