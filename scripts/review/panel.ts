// Skład panelu recenzji dla zmiany: którzy recenzenci oceniają PR, z jakim modelem i dlaczego.
// Te same warunki stosują reguły ryzyka, więc panel i reguły zawsze zgadzają się, czyj werdykt jest wymagany.
//
// Użycie: node scripts/review/panel.ts --base origin/main [--head HEAD] [--repo .] [--config factory.yml] [--out katalog]
// Z --out skrypt zapisuje kryteria perspektyw projektu z wersji bazowej do <katalog>/perspectives/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { collect } from '../risk/collect.ts';
import { InputError, loadProjectContext } from '../risk/project.ts';
import { modelFor, panelFor } from './perspectives.ts';
import type { PanelEntry } from './perspectives.ts';

export interface PanelMember {
  name: string;
  title: string;
  source: 'catalog' | 'project';
  /** Subagent, który ocenia zmianę. */
  agent: string;
  model: string;
  reason: string;
  /** Plik z kryteriami dla recenzenta perspektywy projektu. */
  criteria?: string;
}

function member(entry: PanelEntry, model: string, out?: string): PanelMember {
  const { def, reason } = entry;
  const base = { name: def.name, title: def.title, source: def.source, model, reason };
  if (def.source === 'catalog') return { ...base, agent: `review-${def.name}` };
  const criteria = out ? join(out, 'perspectives', `${def.name}.md`) : def.file;
  return { ...base, agent: 'review-project', criteria };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      repo: { type: 'string', default: '.' },
      config: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.base) throw new InputError('podaj --base, np. --base origin/main');
  const context = loadProjectContext(values.repo, values.base, values.head, values.config);
  const { files } = collect(values.repo, values.base, values.head, context.config);
  const panel = panelFor(context.perspectives, files, context.config);
  if (values.out) {
    mkdirSync(join(values.out, 'perspectives'), { recursive: true });
    for (const { def } of panel.run.filter((e) => e.def.source === 'project')) {
      writeFileSync(join(values.out, 'perspectives', `${def.name}.md`), def.text);
    }
  }
  const run = panel.run.map((entry) => member(entry, modelFor(context.config, entry.def.name), values.out));
  const skipped = panel.skipped.map(({ def, reason }) => ({ name: def.name, reason }));
  console.log(JSON.stringify({ config: context.source, run, skipped }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof InputError ? error.message : error);
  process.exit(1);
}
