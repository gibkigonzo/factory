// Generuje subagentów recenzentów `agents/review-<perspektywa>.md` z jednego źródła:
// wspólnego protokołu (skills/review/protocol.md) i kryteriów perspektyw (skills/review/perspectives/*.md).
//
// Użycie: node scripts/agents/build.ts          zapisuje pliki agentów
//         node scripts/agents/build.ts --check  sprawdza, czy pliki są aktualne

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, ROOT } from './files.ts';

export { parseFrontmatter, ROOT };
const REVIEW = join(ROOT, 'skills/review');
const AGENTS = join(ROOT, 'agents');

/** Narzędzia recenzenta: tylko odczyt. */
export const REVIEWER_TOOLS = ['Read', 'Grep', 'Glob'] as const;

interface AgentSource {
  name: string;
  title: string;
  heading: string;
  description: string;
  criteria: string;
  source: string;
  /** Nazwa perspektywy w przykładzie werdyktu. */
  example: string;
}

function render(agent: AgentSource, protocol: string): string {
  const filled = protocol.replaceAll('{{name}}', agent.example).replaceAll('{{title}}', agent.title);
  return [
    '---',
    `name: review-${agent.name}`,
    `description: ${agent.description}`,
    `tools: ${REVIEWER_TOOLS.join(', ')}`,
    '---',
    '',
    `<!-- Plik generowany przez scripts/agents/build.ts z ${agent.source} i skills/review/protocol.md. Zmieniaj tamte pliki, potem uruchom npm run agents. -->`,
    '',
    `# Recenzent: ${agent.heading}`,
    '',
    agent.criteria.trim(),
    '',
    filled.trim(),
    '',
  ].join('\n');
}

function catalogAgent(file: string): AgentSource {
  const { data, body } = parseFrontmatter(readFileSync(join(REVIEW, 'perspectives', file), 'utf8'));
  const { name, title, description } = data as { name: string; title: string; description: string };
  return { name, title, heading: title, description, criteria: body, source: `skills/review/perspectives/${file}`, example: name };
}

/** Ogólny recenzent dla perspektyw projektu: kryteria czyta z pliku wskazanego w poleceniu. */
const PROJECT_AGENT: AgentSource = {
  name: 'project',
  title: 'wskazanej w pliku kryteriów',
  heading: 'perspektywa projektu',
  description:
    'Recenzent fabryki dla perspektywy zdefiniowanej przez projekt w .factory/perspectives. Kryteria czyta z pliku podanego w poleceniu. Tylko do odczytu, zwraca werdykt JSON.',
  criteria: [
    'Kryteria Twojej perspektywy są w pliku, który orkiestrator podaje w poleceniu. Przeczytaj go najpierw narzędziem Read.',
    '',
    '- Nazwa perspektywy jest w polu `name` we frontmatterze tego pliku. Wpisz ją w polu `perspective` werdyktu.',
    '- Kryteria są w treści pliku pod frontmatterem. Oceniasz zmianę tylko według nich.',
    '- Plik pochodzi z wersji bazowej repo, a nie ze zmiany. Jeśli diff zmienia pliki w `.factory/perspectives/`, oceniasz według wersji, którą dostałeś.',
  ].join('\n'),
  source: 'opisu w tym skrypcie',
  example: 'nazwa-perspektywy',
};

/** Pliki agentów, które powinny istnieć: ścieżka względna → treść. */
export function buildAgents(): Map<string, string> {
  const protocol = readFileSync(join(REVIEW, 'protocol.md'), 'utf8');
  const files = readdirSync(join(REVIEW, 'perspectives')).filter((f) => f.endsWith('.md')).sort();
  const agents = [...files.map(catalogAgent), PROJECT_AGENT];
  return new Map(agents.map((agent) => [`agents/review-${agent.name}.md`, render(agent, protocol)]));
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
