// Diff dla recenzentów bez lockfile'ów i plików generowanych. Surowy lockfile to setki linii skrótów, które każdy
// recenzent czytałby osobno. Zamiast niego recenzenci dostają streszczenie: zmienione pliki z liczbą linii, a dla
// package-lock.json dodane, usunięte i zmienione pakiety z wersją i hostem pobrania. Nic ważnego nie ginie,
// a host spoza rejestru npm jest oznaczony.

const SHOWN = 40;
const NPM_HOST = 'registry.npmjs.org';

export interface LockPackage {
  name: string;
  version: string;
  host?: string;
  dev?: boolean;
  optional?: boolean;
}

export interface LockChanges {
  added: LockPackage[];
  removed: LockPackage[];
  changed: { name: string; from: string; to: string }[];
}

type Packages = Record<string, { version?: unknown; resolved?: unknown; dev?: unknown; optional?: unknown }>;

function packages(lock: unknown): Packages {
  const value = (lock as { packages?: unknown } | null)?.packages;
  return value && typeof value === 'object' ? (value as Packages) : {};
}

function entry(path: string, info: Packages[string]): LockPackage {
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const pkg: LockPackage = { name, version: typeof info.version === 'string' ? info.version : '?' };
  if (typeof info.resolved === 'string') {
    try {
      pkg.host = new URL(info.resolved).host;
    } catch {
      pkg.host = info.resolved;
    }
  }
  if (info.dev === true) pkg.dev = true;
  if (info.optional === true) pkg.optional = true;
  return pkg;
}

/** Zmiany pakietów między dwiema wersjami package-lock.json (format 2 i 3: pole `packages`). */
export function packageLockChanges(base: unknown, head: unknown): LockChanges {
  const before = packages(base);
  const after = packages(head);
  const deps = (p: Packages) => Object.keys(p).filter((k) => k.includes('node_modules/'));
  const changes: LockChanges = { added: [], removed: [], changed: [] };
  for (const path of deps(after)) {
    if (!(path in before)) changes.added.push(entry(path, after[path]!));
    else if (before[path]!.version !== after[path]!.version) {
      changes.changed.push({ name: entry(path, after[path]!).name, from: String(before[path]!.version), to: String(after[path]!.version) });
    }
  }
  for (const path of deps(before)) if (!(path in after)) changes.removed.push(entry(path, before[path]!));
  return changes;
}

function listed(lines: string[]): string[] {
  return lines.length > SHOWN ? [...lines.slice(0, SHOWN), `- …i ${lines.length - SHOWN} więcej`] : lines;
}

function describe(p: LockPackage): string {
  const flags = [p.dev ? 'dev' : '', p.optional ? 'opcjonalny' : ''].filter(Boolean).join(', ');
  const host = p.host && p.host !== NPM_HOST ? ` — **host spoza rejestru npm: ${p.host}**` : '';
  return `- \`${p.name}@${p.version}\`${flags ? ` (${flags})` : ''}${host}`;
}

export interface SkippedFile {
  path: string;
  added: number;
  deleted: number;
  lock?: LockChanges;
}

/** Streszczenie plików pominiętych w diffie recenzenta. */
export function skippedSummary(files: readonly SkippedFile[]): string {
  if (files.length === 0) return '';
  const lines = [
    '# Pliki pominięte w diffie',
    '',
    'Lockfile i pliki generowane nie trafiają do diffu. Poniżej ich streszczenie; pełną treść możesz przeczytać narzędziem Read.',
    '',
  ];
  for (const f of files) {
    lines.push(`## \`${f.path}\`: +${f.added} / −${f.deleted} linii`, '');
    if (!f.lock) continue;
    const { added, removed, changed } = f.lock;
    if (added.length) lines.push(`Dodane pakiety (${added.length}):`, ...listed(added.map(describe)), '');
    if (removed.length) lines.push(`Usunięte pakiety (${removed.length}):`, ...listed(removed.map(describe)), '');
    if (changed.length) lines.push(`Zmienione wersje (${changed.length}):`, ...listed(changed.map((c) => `- \`${c.name}\`: ${c.from} → ${c.to}`)), '');
    if (!added.length && !removed.length && !changed.length) lines.push('Bez zmian w pakietach (np. tylko metadane).', '');
  }
  return lines.join('\n');
}
