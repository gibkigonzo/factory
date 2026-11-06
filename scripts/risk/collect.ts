// Zbiera fakty o zmianie z repo git: diff od punktu rozgałęzienia, pliki po zmianie, długość zmienionych plików kodu.

import { execFileSync } from 'node:child_process';
import type { FactoryConfig } from '../config/spec.ts';
import { parseDiff } from './diff.ts';
import { matchesAny } from './glob.ts';
import { countCodeLines } from './lines.ts';
import type { ChangedFile, FileSize, RiskInput } from './types.ts';

export type GitFacts = Pick<RiskInput, 'files' | 'repoFiles' | 'sizes'>;

export function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function mergeBase(repo: string, base: string, head: string): string {
  return git(repo, ['merge-base', base, head]).trim();
}

/** Plik w danej wersji albo undefined, gdy go tam nie ma. */
export function fileAt(repo: string, revision: string, path: string): string | undefined {
  try {
    return git(repo, ['show', `${revision}:${path}`]);
  } catch {
    return undefined;
  }
}

export function collect(repo: string, base: string, head: string, config: FactoryConfig): GitFacts {
  const forkPoint = mergeBase(repo, base, head);
  const diff = git(repo, ['diff', '--no-color', '--no-ext-diff', '-M', forkPoint, head]);
  const files = parseDiff(diff);
  const repoFiles = git(repo, ['ls-tree', '-r', '-z', '--name-only', head]).split('\0').filter(Boolean);
  const sizes: Record<string, FileSize> = {};
  for (const file of files) {
    if (!file.binary && matchesAny(file.path, config.files.source)) sizes[file.path] = sizeOf(repo, forkPoint, head, file);
  }
  return { files, repoFiles, sizes };
}

function sizeOf(repo: string, forkPoint: string, head: string, file: ChangedFile): FileSize {
  const size: FileSize = {};
  const before = file.status === 'added' ? undefined : fileAt(repo, forkPoint, file.oldPath ?? file.path);
  const after = file.status === 'deleted' ? undefined : fileAt(repo, head, file.path);
  if (before !== undefined) size.before = countCodeLines(before, file.oldPath ?? file.path);
  if (after !== undefined) size.after = countCodeLines(after, file.path);
  return size;
}
