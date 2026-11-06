// Generuje subagentów recenzentów `agents/review-<perspektywa>.md` z jednego źródła:
// wspólnego protokołu (skills/review/protocol.md) i kryteriów perspektyw (skills/review/perspectives/*.md).
//
// Użycie: node scripts/agents/build.ts          zapisuje pliki agentów
//         node scripts/agents/build.ts --check  sprawdza, czy pliki są aktualne

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REVIEW = join(ROOT, 'skills/review');
const AGENTS = join(ROOT, 'agents');

/** Narzędzia recenzenta: tylko odczyt. */
export const REVIEWER_TOOLS = ['Read', 'Grep', 'Glob'] as const;

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: unknown = parse(match[1]!);
  return { data: typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}, body: text.slice(match[0].length) };
}

function render(perspectiveFile: string, protocol: string): { name: string; content: string } {
  const { data, body } = parseFrontmatter(readFileSync(join(REVIEW, 'perspectives', perspectiveFile), 'utf8'));
  const { name, title, description } = data as { name: string; title: string; description: string };
  const source = `skills/review/perspectives/${perspectiveFile}`;
  const filled = protocol.replaceAll('{{name}}', name).replaceAll('{{title}}', title);
  const content = [
    '---',
    `name: review-${name}`,
    `description: ${description}`,
    `tools: ${REVIEWER_TOOLS.join(', ')}`,
    '---',
    '',
    `<!-- Plik generowany przez scripts/agents/build.ts z ${source} i skills/review/protocol.md. Zmieniaj tamte pliki, potem uruchom npm run agents. -->`,
    '',
    `# Recenzent: ${title}`,
    '',
    body.trim(),
    '',
    filled.trim(),
    '',
  ].join('\n');
  return { name, content };
}

/** Pliki agentów, które powinny istnieć: ścieżka względna → treść. */
export function buildAgents(): Map<string, string> {
  const protocol = readFileSync(join(REVIEW, 'protocol.md'), 'utf8');
  const files = readdirSync(join(REVIEW, 'perspectives')).filter((f) => f.endsWith('.md')).sort();
  return new Map(files.map((file) => render(file, protocol)).map(({ name, content }) => [`agents/review-${name}.md`, content]));
}

/** Różnice między wygenerowanymi a zapisanymi plikami agentów. */
export function staleAgents(expected = buildAgents()): string[] {
  const existing = existsSync(AGENTS) ? readdirSync(AGENTS).filter((f) => /^review-.*\.md$/.test(f)).map((f) => `agents/${f}`) : [];
  const outdated = [...expected].filter(([path, content]) => !existsSync(join(ROOT, path)) || readFileSync(join(ROOT, path), 'utf8') !== content);
  const extra = existing.filter((path) => !expected.has(path));
  return [...outdated.map(([path]) => path), ...extra].sort();
}

function main(args: string[]): number {
  const expected = buildAgents();
  if (args.includes('--check')) {
    const stale = staleAgents(expected);
    if (stale.length === 0) return 0;
    console.error(`Nieaktualne pliki agentów (uruchom npm run agents):\n${stale.map((p) => `- ${p}`).join('\n')}`);
    return 1;
  }
  for (const path of staleAgents(expected)) {
    if (expected.has(path)) writeFileSync(join(ROOT, path), expected.get(path)!);
    else rmSync(join(ROOT, path));
    console.log(`zapisano: ${path}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
