// Walidacja factory.yml z linii poleceń.
// Użycie: node scripts/config/cli.ts [ścieżka/do/factory.yml] [--json]
// --json wypisuje konfigurację złożoną z warstw, gotową dla skryptów i workflowów.

import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './load.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const file = args.find((arg) => !arg.startsWith('--')) ?? 'factory.yml';

if (!existsSync(file)) {
  console.error(`${file}: nie ma takiego pliku`);
  process.exit(1);
}

const result = loadConfig(readFileSync(file, 'utf8'), file);

if (!result.ok) {
  console.error(`Konfiguracja odrzucona:\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
  process.exit(1);
}

if (json) console.log(JSON.stringify(result.config, null, 2));
else console.log(`OK: ${file} (warstwy: ${result.config.extends.join(', ')}, projekt)`);
