// Powtórzenia w kodzie projektu, liczone skryptem, nie modelem. Dwa rodzaje:
// - blok co najmniej `quality.duplicate_lines` znaczących linii, który występuje w repo więcej niż raz
//   (kandydat na wspólny helper, hook albo komponent);
// - atrybut class/className z co najmniej `quality.repeated_classes` klasami, którego zestaw klas powtarza się
//   w kilku miejscach (ten sam element zbudowany na nowo zamiast wspólnego komponentu albo wariantu).
// W PR liczą się tylko powtórzenia, które PR wprowadza; przegląd architektury dostaje je z całego repo.

export interface SourceFile {
  path: string;
  text: string;
}

export interface Location {
  file: string;
  /** Pierwsza i ostatnia linia, liczone od 1. */
  start: number;
  end: number;
  /** Lokalizacja nachodzi na linie dodane w PR. */
  added?: boolean;
}

export interface CloneGroup {
  kind: 'lines' | 'classes';
  /** Liczba znaczących linii bloku albo liczba klas w zestawie. */
  size: number;
  /** Początek bloku albo posortowany zestaw klas. */
  sample: string;
  /** Zestawy klas nie są identyczne, tylko różnią się jedną klasą (dodaną, usuniętą albo zamienioną). */
  similar?: boolean;
  locations: Location[];
}

/** Linie bez treści: puste, sama interpunkcja, zamykające tagi, importy, komentarze i atrybuty. */
const TRIVIAL = [
  /^[\s{}()[\];,.:<>/=|&?!+-]*$/,
  /^<\/[\w.:-]+>$/,
  /^(import\b|export \{|export \* from|use\s|mod\s|pub mod\s|pub use\s|from\s|require\()/,
  /^(\/\/|\/\*|\*|#|<!--)/,
];

interface Significant {
  line: number;
  norm: string;
}

export function significantLines(text: string): Significant[] {
  const out: Significant[] = [];
  text.split('\n').forEach((raw, index) => {
    const norm = raw.trim().replace(/\s+/g, ' ');
    if (!TRIVIAL.some((re) => re.test(norm))) out.push({ line: index + 1, norm });
  });
  return out;
}

interface Window {
  file: number;
  index: number;
}

/** Bloki co najmniej `minLines` znaczących linii, które występują w więcej niż jednym miejscu. */
export function duplicateBlocks(files: readonly SourceFile[], minLines: number): CloneGroup[] {
  const lines = files.map((f) => significantLines(f.text));
  const key = (w: Window) =>
    lines[w.file]!.slice(w.index, w.index + minLines)
      .map((s) => s.norm)
      .join('\n');
  const byKey = new Map<string, Window[]>();
  lines.forEach((sig, file) => {
    for (let index = 0; index + minLines <= sig.length; index++) {
      const w = { file, index };
      const k = key(w);
      byKey.set(k, [...(byKey.get(k) ?? []), w]);
    }
  });

  const visited = new Set<string>();
  const id = (w: Window) => `${w.file}:${w.index}`;
  const groups: CloneGroup[] = [];
  for (const windows of byKey.values()) {
    const starts = nonOverlapping(windows, minLines).filter((w) => !visited.has(id(w)));
    if (starts.length < 2) continue;
    // Wydłuża blok, dopóki kolejne okna we wszystkich miejscach są takie same.
    let length = minLines;
    while (
      starts.every((w) => w.index + length < lines[w.file]!.length) &&
      new Set(starts.map((w) => lines[w.file]![w.index + length]!.norm)).size === 1 &&
      nonOverlapping(starts, length + 1).length === starts.length
    ) {
      length++;
    }
    for (const w of starts) for (let i = 0; i + minLines <= length; i++) visited.add(id({ file: w.file, index: w.index + i }));
    groups.push({
      kind: 'lines',
      size: length,
      sample: lines[starts[0]!.file]!.slice(starts[0]!.index, starts[0]!.index + 3).map((s) => s.norm).join('\n'),
      locations: starts.map((w) => ({
        file: files[w.file]!.path,
        start: lines[w.file]![w.index]!.line,
        end: lines[w.file]![w.index + length - 1]!.line,
      })),
    });
  }
  return groups;
}

/** Okna, które nie nachodzą na siebie w tym samym pliku (blok powtórzony jeden po drugim liczy się raz). */
function nonOverlapping(windows: readonly Window[], length: number): Window[] {
  const sorted = [...windows].sort((a, b) => a.file - b.file || a.index - b.index);
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out.at(-1);
    if (!last || last.file !== w.file || w.index >= last.index + length) out.push(w);
  }
  return out;
}

const CLASS_ATTR = /\b(?:class|className)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`$]*)["'`]\s*\})/g;

/** Atrybuty class/className z co najmniej `minClasses` klasami, których zestaw klas występuje w kilku miejscach.
 * Zestawy różniące się jedną klasą (np. innym marginesem) trafiają do tej samej grupy jako podobne. */
export function repeatedClasses(files: readonly SourceFile[], minClasses: number): CloneGroup[] {
  const clusters: { classes: string[]; similar: boolean; locations: Location[] }[] = [];
  for (const file of files) {
    const starts = lineStarts(file.text);
    for (const match of file.text.matchAll(CLASS_ATTR)) {
      const value = match[1] ?? match[2] ?? match[3] ?? '';
      const classes = [...new Set(value.split(/\s+/).filter(Boolean))].sort();
      if (classes.length < minClasses) continue;
      const line = lineOf(starts, match.index);
      const location = { file: file.path, start: line, end: line };
      const cluster = clusters.find((c) => symmetricDifference(c.classes, classes) <= 2);
      if (!cluster) clusters.push({ classes, similar: false, locations: [location] });
      else {
        cluster.locations.push(location);
        if (cluster.classes.join(' ') !== classes.join(' ')) cluster.similar = true;
      }
    }
  }
  return clusters
    .filter((c) => c.locations.length >= 2)
    .map((c) => ({
      kind: 'classes' as const,
      size: c.classes.length,
      sample: c.classes.join(' '),
      ...(c.similar ? { similar: true } : {}),
      locations: c.locations,
    }));
}

function symmetricDifference(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  return [...left].filter((x) => !right.has(x)).length + [...right].filter((x) => !left.has(x)).length;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Numery linii dodanych w PR z `git diff --unified=0`, po ścieżce pliku. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let file: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? undefined : line.replace(/^\+\+\+ b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = added.get(file) ?? new Set<number>();
    for (let n = start; n < start + count; n++) lines.add(n);
    added.set(file, lines);
  }
  return added;
}

/** Zostawia grupy, które PR wprowadza: przynajmniej jedno miejsce nachodzi na linie dodane w PR. */
export function introducedBy(groups: readonly CloneGroup[], added: ReadonlyMap<string, ReadonlySet<number>>): CloneGroup[] {
  const touches = (l: Location) => {
    const lines = added.get(l.file);
    if (!lines) return false;
    for (let n = l.start; n <= l.end; n++) if (lines.has(n)) return true;
    return false;
  };
  return groups
    .map((g) => ({ ...g, locations: g.locations.map((l) => (touches(l) ? { ...l, added: true } : l)) }))
    .filter((g) => g.locations.some((l) => l.added));
}

/** Najpierw największe: rozmiar razy liczba miejsc. */
export function ranked(groups: readonly CloneGroup[]): CloneGroup[] {
  const weight = (g: CloneGroup) => g.size * g.locations.length;
  return [...groups].sort((a, b) => weight(b) - weight(a) || a.sample.localeCompare(b.sample));
}

const place = (l: Location) => `\`${l.file}:${l.start === l.end ? l.start : `${l.start}–${l.end}`}\`${l.added ? ' (nowe w PR)' : ''}`;

function groupLine(g: CloneGroup): string {
  const where = g.locations.map(place).join(', ');
  if (g.kind === 'classes') {
    const what = g.similar ? `Podobne zestawy ${g.size} klas (różnią się jedną klasą)` : `Zestaw ${g.size} klas`;
    return `- **${what}** w ${g.locations.length} miejscach: ${where}\n  \`${g.sample}\``;
  }
  const sample = g.sample.split('\n').map((l) => `  ${l}`).join('\n');
  return `- **Blok ${g.size} linii** w ${g.locations.length} miejscach: ${where}\n  \`\`\`\n${sample}\n  \`\`\``;
}

export interface ReportOptions {
  minLines: number;
  minClasses: number;
  /** PR: tylko powtórzenia wprowadzone przez PR. Repo: wszystkie, do przeglądu architektury. */
  scope: 'pr' | 'repo';
  limit?: number;
}

export function duplicatesReport(groups: readonly CloneGroup[], options: ReportOptions): string {
  const intro =
    `Skrypt fabryki szuka bloków co najmniej ${options.minLines} znaczących linii i atrybutów class z co najmniej ` +
    `${options.minClasses} klasami, które powtarzają się w repo.`;
  const scope =
    options.scope === 'pr'
      ? 'Poniżej tylko powtórzenia, które wprowadza ten PR; „nowe w PR” to miejsce dodane w tej zmianie.'
      : 'Poniżej największe powtórzenia w całym repo.';
  const sorted = ranked(groups);
  const shown = sorted.slice(0, options.limit ?? 15);
  const body =
    shown.length === 0
      ? options.scope === 'pr'
        ? 'PR nie wprowadza powtórzeń.'
        : 'Brak powtórzeń ponad progi.'
      : [...shown.map(groupLine), ...(sorted.length > shown.length ? [`- …i ${sorted.length - shown.length} więcej`] : [])].join('\n');
  return ['# Powtórzenia w kodzie', '', `${intro} ${scope}`, '', body, ''].join('\n');
}
