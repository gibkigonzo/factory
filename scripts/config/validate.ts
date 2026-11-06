// Sprawdzanie wartości względem schematu. Każdy problem wskazuje ścieżkę pola, np. zones.data[1].

import type { Spec } from './spec.ts';

export interface Issue {
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;

export function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function joinPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

export function describe(value: unknown): string {
  if (value === null || value === undefined) return 'pusta wartość';
  if (Array.isArray(value)) return 'lista';
  if (isObject(value)) return 'mapa';
  return JSON.stringify(value);
}

/** Sprawdza wartość i dopisuje problemy do `out`. */
export function check(value: unknown, spec: Spec, path: string, out: Issue[]): void {
  if (spec.kind === 'object') return checkObject(value, spec, path, out);
  if (spec.kind === 'map') return checkMap(value, spec, path, out);
  if (spec.kind === 'list') return checkList(value, spec, path, out);
  const message = scalarProblem(value, spec);
  if (message) out.push({ path, message });
}

function checkObject(value: unknown, spec: Extract<Spec, { kind: 'object' }>, path: string, out: Issue[]): void {
  if (!isObject(value)) {
    out.push({ path, message: `oczekiwano mapy „pole: wartość”, jest: ${describe(value)}` });
    return;
  }
  const known = Object.keys(spec.fields);
  for (const [key, item] of Object.entries(value)) {
    const fieldSpec = spec.fields[key];
    if (fieldSpec) check(item, fieldSpec, joinPath(path, key), out);
    else out.push({ path: joinPath(path, key), message: unknownField(key, known) });
  }
  for (const key of spec.required ?? []) {
    if (!(key in value)) out.push({ path: joinPath(path, key), message: 'brak wymaganego pola' });
  }
}

function checkMap(value: unknown, spec: Extract<Spec, { kind: 'map' }>, path: string, out: Issue[]): void {
  if (!isObject(value)) {
    out.push({ path, message: `oczekiwano mapy „nazwa: wartość”, jest: ${describe(value)}` });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!spec.key.test(key)) {
      out.push({ path: joinPath(path, key), message: `niedozwolona nazwa „${key}”; dozwolone: ${spec.keyHint}` });
      continue;
    }
    check(item, spec.value, joinPath(path, key), out);
  }
}

function checkList(value: unknown, spec: Extract<Spec, { kind: 'list' }>, path: string, out: Issue[]): void {
  if (!Array.isArray(value)) {
    out.push({ path, message: `oczekiwano listy, jest: ${describe(value)}` });
    return;
  }
  value.forEach((item, index) => check(item, spec.item, joinPath(path, index), out));
}

function scalarProblem(value: unknown, spec: Spec): string | undefined {
  switch (spec.kind) {
    case 'string':
      return stringProblem(value, spec.pattern, spec.hint);
    case 'glob':
      return stringProblem(value) ?? globProblem(value as string);
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `oczekiwano true albo false, jest: ${describe(value)}`;
    case 'integer':
      return Number.isInteger(value) && (value as number) >= spec.min
        ? undefined
        : `oczekiwano liczby całkowitej ≥ ${spec.min}, jest: ${describe(value)}`;
    case 'number':
      return typeof value === 'number' && value >= spec.min && value <= spec.max
        ? undefined
        : `oczekiwano liczby od ${spec.min} do ${spec.max}, jest: ${describe(value)}`;
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
        ? undefined
        : `oczekiwano jednej z wartości: ${spec.values.join(', ')}; jest: ${describe(value)}`;
    default:
      return undefined;
  }
}

function stringProblem(value: unknown, pattern?: RegExp, hint?: string): string | undefined {
  if (typeof value !== 'string') return `oczekiwano tekstu, jest: ${describe(value)}`;
  if (value.trim() === '') return 'oczekiwano niepustego tekstu';
  if (pattern && !pattern.test(value)) return `niedozwolona wartość ${describe(value)}; dozwolone: ${hint}`;
  return undefined;
}

/** Wzorce ścieżek: względne od korzenia repo, tylko `*`, `**` i `?`. */
export function globProblem(glob: string): string | undefined {
  const reason = globReason(glob);
  return reason ? `nieprawidłowy wzorzec ${describe(glob)}: ${reason}` : undefined;
}

function globReason(glob: string): string | undefined {
  if (glob.startsWith('/') || glob.startsWith('./')) return 'ścieżka ma być względna od korzenia repo, bez „/” i „./” na początku';
  if (glob.includes('\\')) return 'separatorem katalogów jest „/”';
  if (glob.endsWith('/')) return 'cały katalog zapisz jako „katalog/**”';
  const segments = glob.split('/');
  if (segments.includes('..')) return '„..” jest niedozwolone';
  if (segments.includes('')) return 'pusty segment ścieżki („//”)';
  if (/[{}[\]!]/.test(glob)) return 'wzorce obsługują tylko „*”, „**” i „?”, bez „{}”, „[]” i „!”';
  if (segments.some((s) => s.includes('**') && s !== '**')) return '„**” musi być całym segmentem, np. „src/**/x.ts”';
  return undefined;
}

function unknownField(key: string, known: readonly string[]): string {
  const hint = closest(key, known);
  return hint ? `nieznane pole (czy chodziło o „${hint}”?)` : `nieznane pole; dozwolone: ${known.join(', ')}`;
}

function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = levenshtein(word, candidate);
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}
