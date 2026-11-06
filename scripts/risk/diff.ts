// Parser wyniku `git diff` (format unified, z wykrywaniem zmian nazw `-M`).

import type { ChangedFile } from './types.ts';

const HEADER = 'diff --git ';

export function parseDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith(HEADER)) {
      current = startFile(line);
      files.push(current);
      inHunk = false;
    } else if (current && inHunk) {
      readHunkLine(current, line);
    } else if (current) {
      inHunk = readMetaLine(current, line);
    }
  }
  return files;
}

function startFile(header: string): ChangedFile {
  const path = pathFromHeader(header.slice(HEADER.length));
  return { path, status: 'modified', binary: false, additions: 0, deletions: 0, addedLines: [], removedLines: [], contextLines: [] };
}

/** Ścieżka z nagłówka „a/P b/P”. Przy zmianie nazwy poprawią ją linie rename, --- i +++. */
function pathFromHeader(rest: string): string {
  if (rest.startsWith('"')) return stripPrefix(rest.slice(0, closingQuote(rest) + 1), 'a/');
  const size = (rest.length - 5) / 2;
  const path = rest.slice(2, size + 2);
  if (Number.isInteger(size) && rest === `a/${path} b/${path}`) return path;
  return rest.slice(2, Math.max(rest.indexOf(' b/'), 2));
}

function closingQuote(text: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return text.length - 1;
}

/** Zwraca true, gdy zaczyna się hunk. */
function readMetaLine(file: ChangedFile, line: string): boolean {
  if (line.startsWith('@@')) return true;
  if (line.startsWith('new file mode')) file.status = 'added';
  else if (line.startsWith('deleted file mode')) file.status = 'deleted';
  else if (line.startsWith('rename from ')) setRename(file, unquote(line.slice('rename from '.length)), undefined);
  else if (line.startsWith('rename to ')) setRename(file, undefined, unquote(line.slice('rename to '.length)));
  else if (line.startsWith('Binary files ')) file.binary = true;
  else if (line.startsWith('--- ') && file.status !== 'added') setOldPath(file, line.slice(4));
  else if (line.startsWith('+++ ') && file.status !== 'deleted') file.path = stripPrefix(line.slice(4), 'b/');
  return false;
}

function setRename(file: ChangedFile, from: string | undefined, to: string | undefined): void {
  file.status = 'renamed';
  if (from !== undefined) file.oldPath = from;
  if (to !== undefined) file.path = to;
}

function setOldPath(file: ChangedFile, raw: string): void {
  const path = stripPrefix(raw, 'a/');
  if (file.status === 'deleted') file.path = path;
  else if (file.status === 'renamed') file.oldPath = path;
}

function readHunkLine(file: ChangedFile, line: string): void {
  if (line.startsWith('+')) {
    file.additions++;
    file.addedLines.push(line.slice(1));
  } else if (line.startsWith('-')) {
    file.deletions++;
    file.removedLines.push(line.slice(1));
  } else if (line.startsWith(' ')) {
    file.contextLines.push(line.slice(1));
  }
}

function stripPrefix(raw: string, prefix: string): string {
  const path = unquote(raw.replace(/\t$/, ''));
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Ścieżki ze znakami specjalnymi git podaje w cudzysłowie, z ucieczkami jak w C. */
export function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else {
      bytes.push(escapes[body[i + 1]!] ?? body.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
