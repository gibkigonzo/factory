// Perspektywy recenzji: katalog fabryki (skills/review/perspectives) i perspektywy projektu (.factory/perspectives).
// Podstawowe perspektywy z base działają zawsze; dodatkowe tylko wtedy, gdy diff dotyka ich `paths` albo `zones`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FactoryConfig, Spec } from '../config/spec.ts';
import { check } from '../config/validate.ts';
import type { Issue } from '../config/validate.ts';
import { parseFrontmatter, ROOT } from '../agents/files.ts';
import { matchesAny } from '../risk/glob.ts';
import { zoneOf } from '../risk/rules.ts';
import type { ChangedFile } from '../risk/types.ts';

export const CATALOG_DIR = join(ROOT, 'skills/review/perspectives');
export const PROJECT_DIR = '.factory/perspectives';

export interface PerspectiveDef {
  name: string;
  title: string;
  description: string;
  paths?: string[];
  zones?: string[];
  /** Perspektywa ocenia zrzuty ekranu: jej recenzent dostaje zrzuty sekcji zmienionych przez PR. */
  screenshots?: boolean;
  source: 'catalog' | 'project';
  file: string;
  /** Pełna treść pliku: frontmatter i kryteria. */
  text: string;
}

const NAME: Spec = { kind: 'string', pattern: /^[a-z][a-z0-9_-]*$/, hint: 'małe litery, cyfry, „-” i „_”, na początku litera' };
const text: Spec = { kind: 'string' };

export const PERSPECTIVE_SPEC: Spec = {
  kind: 'object',
  fields: {
    name: NAME,
    title: text,
    description: text,
    paths: { kind: 'list', item: { kind: 'glob' } },
    zones: { kind: 'list', item: NAME },
    screenshots: { kind: 'boolean' },
  },
  required: ['name', 'title', 'description'],
};

export function parsePerspective(
  content: string,
  file: string,
  source: PerspectiveDef['source'],
): { ok: true; def: PerspectiveDef } | { ok: false; errors: string[] } {
  const { data, body } = parseFrontmatter(content);
  const issues: Issue[] = [];
  check(data, PERSPECTIVE_SPEC, '', issues);
  const expected = basename(file, '.md');
  if (issues.length === 0 && data.name !== expected) issues.push({ path: 'name', message: `nazwa musi być taka jak nazwa pliku: „${expected}”` });
  if (body.trim() === '') issues.push({ path: '', message: 'brak kryteriów pod frontmatterem' });
  if (issues.length > 0) return { ok: false, errors: issues.map((i) => `${file}: ${i.path ? `${i.path}: ` : ''}${i.message}`) };
  return { ok: true, def: { ...(data as Pick<PerspectiveDef, 'name' | 'title' | 'description' | 'paths' | 'zones' | 'screenshots'>), source, file, text: content } };
}

function parseAll(files: { path: string; content: string }[], source: PerspectiveDef['source']) {
  const defs: PerspectiveDef[] = [];
  const errors: string[] = [];
  for (const { path, content } of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const result = parsePerspective(content, path, source);
    if (result.ok) defs.push(result.def);
    else errors.push(...result.errors);
  }
  return { defs, errors };
}

function markdownIn(dir: string): { path: string; content: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ path: join(dir, f), content: readFileSync(join(dir, f), 'utf8') }));
}

export function loadCatalog(): PerspectiveDef[] {
  const files = markdownIn(CATALOG_DIR).map((f) => ({ ...f, path: `skills/review/perspectives/${basename(f.path)}` }));
  const { defs, errors } = parseAll(files, 'catalog');
  if (errors.length > 0) throw new Error(`Katalog perspektyw jest błędny:\n${errors.join('\n')}`);
  return defs;
}

/** Perspektywy projektu z katalogu roboczego (`root` to katalog z factory.yml). */
export function projectPerspectivesFromDir(root: string): { defs: PerspectiveDef[]; errors: string[] } {
  const files = markdownIn(join(root, PROJECT_DIR)).map((f) => ({ ...f, path: `${PROJECT_DIR}/${basename(f.path)}` }));
  return parseAll(files, 'project');
}

export function projectPerspectives(files: { path: string; content: string }[]): { defs: PerspectiveDef[]; errors: string[] } {
  return parseAll(files, 'project');
}

/** Włączone perspektywy (podstawowe i dodatkowe) z ich definicjami oraz błędy konfiguracji. */
export function resolvePerspectives(
  config: FactoryConfig,
  catalog: readonly PerspectiveDef[],
  project: readonly PerspectiveDef[],
  configFile = 'factory.yml',
): { enabled: PerspectiveDef[]; errors: string[] } {
  const errors: string[] = [];
  const known = Object.keys(config.risk.zone_levels);
  for (const def of project) {
    if (catalog.some((c) => c.name === def.name)) errors.push(`${def.file}: perspektywa „${def.name}” jest już w katalogu fabryki; wybierz inną nazwę`);
  }
  for (const def of [...catalog, ...project]) {
    (def.zones ?? []).forEach((zone, i) => {
      if (!known.includes(zone)) errors.push(`${def.file}: zones[${i}]: nieznana strefa „${zone}”; dostępne: ${known.join(', ')}`);
    });
  }
  const enabled: PerspectiveDef[] = [];
  const lists = [['perspectives', config.reviewers.perspectives], ['extra', config.reviewers.extra]] as const;
  for (const [key, names] of lists) {
    names.forEach((name, i) => {
      const def = project.find((d) => d.name === name) ?? catalog.find((d) => d.name === name);
      if (def) enabled.push(def);
      else errors.push(unknownPerspective(configFile, `reviewers.${key}[${i}]`, name, catalog));
    });
  }
  return { enabled, errors };
}

function unknownPerspective(file: string, path: string, name: string, catalog: readonly PerspectiveDef[]): string {
  const available = catalog.map((d) => d.name).join(', ');
  return `${file}: ${path}: nieznana perspektywa „${name}”; w katalogu fabryki: ${available}; własną dodaj jako ${PROJECT_DIR}/${name}.md`;
}

/** Czy perspektywa powinna ocenić zmianę: bez `paths` i `zones` zawsze, inaczej gdy diff ich dotyka. */
export function isTriggered(def: PerspectiveDef, files: readonly ChangedFile[], config: FactoryConfig): { run: boolean; reason: string } {
  if (!def.paths?.length && !def.zones?.length) return { run: true, reason: 'zawsze' };
  const paths = [...new Set(files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])))].sort();
  const byPath = paths.find((p) => matchesAny(p, def.paths ?? []));
  if (byPath) return { run: true, reason: `diff dotyka ${byPath}` };
  for (const path of paths) {
    const { zone } = zoneOf(path, config);
    if (zone && def.zones?.includes(zone)) return { run: true, reason: `diff dotyka strefy ${zone} (${path})` };
  }
  return { run: false, reason: 'diff nie dotyka plików ani stref tej perspektywy' };
}

export interface PanelEntry {
  def: PerspectiveDef;
  reason: string;
}

/** Skład panelu: podstawowe perspektywy zawsze, dodatkowe według warunków. */
export function panelFor(
  enabled: readonly PerspectiveDef[],
  files: readonly ChangedFile[],
  config: FactoryConfig,
): { run: PanelEntry[]; skipped: PanelEntry[] } {
  const run: PanelEntry[] = [];
  const skipped: PanelEntry[] = [];
  for (const def of enabled) {
    if (config.reviewers.perspectives.includes(def.name)) {
      run.push({ def, reason: 'perspektywa podstawowa' });
      continue;
    }
    const trigger = isTriggered(def, files, config);
    (trigger.run ? run : skipped).push({ def, reason: trigger.reason });
  }
  return { run, skipped };
}

export function modelFor(config: FactoryConfig, perspective: string): string {
  return config.models.reviewers[perspective] ?? config.models.reviewers.default;
}
