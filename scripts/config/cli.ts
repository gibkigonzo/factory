// Walidacja factory.yml z linii poleceń: konfiguracja z warstw oraz perspektywy recenzji
// (katalog fabryki i pliki .factory/perspectives/ obok factory.yml).
// Użycie: node scripts/config/cli.ts [ścieżka/do/factory.yml] [--json]
// --json wypisuje konfigurację złożoną z warstw, gotową dla skryptów i workflowów.

import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadCatalog, projectPerspectivesFromDir, resolvePerspectives } from '../review/perspectives.ts';
import { loadConfig } from './load.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const file = args.find((arg) => !arg.startsWith('--')) ?? 'factory.yml';

function reject(errors: readonly string[]): never {
  console.error(`Konfiguracja odrzucona:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  process.exit(1);
}

if (!existsSync(file)) {
  console.error(`${file}: nie ma takiego pliku`);
  process.exit(1);
}

const result = loadConfig(readFileSync(file, 'utf8'), file);
if (!result.ok) reject(result.errors);

const project = projectPerspectivesFromDir(dirname(file));
const perspectives = resolvePerspectives(result.config, loadCatalog(), project.defs, file);
const errors = [...project.errors, ...perspectives.errors];
if (errors.length > 0) reject(errors);

if (json) console.log(JSON.stringify(result.config, null, 2));
else console.log(`OK: ${file} (warstwy: ${result.config.extends.join(', ')}, projekt; perspektywy: ${perspectives.enabled.map((d) => d.name).join(', ')})`);
