// Reguły ryzyka: ocenia zmianę między dwiema wersjami repo projektu.
//
// Użycie (w katalogu repo projektu albo z --repo):
//   node scripts/risk-rules.ts --base origin/main --head HEAD [--evidence evidence.json] [--eslint eslint.json] [--json]
//
// factory.yml jest czytany z punktu rozgałęzienia, czyli z wersji, do której zmiana trafia,
// a nie z samej zmiany. Wyjątek: gdy na bazie go nie ma, skrypt bierze wersję z gałęzi.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config/load.ts';
import type { FactoryConfig } from './config/spec.ts';
import { assess, formatAssessment } from './risk/assess.ts';
import { collect, fileAt, mergeBase } from './risk/collect.ts';
import { parseEvidence } from './risk/evidence.ts';
import { fromEslint } from './risk/gates.ts';
import type { Evidence, LintFinding } from './risk/types.ts';

class InputError extends Error {}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new InputError(`${path}: nie da się odczytać JSON (${(error as Error).message})`);
  }
}

function loadProjectConfig(repo: string, base: string, head: string, path?: string): { config: FactoryConfig; source: string } {
  let text: string | undefined;
  let source: string;
  if (path) {
    text = readFileSync(path, 'utf8');
    source = path;
  } else {
    const forkPoint = mergeBase(repo, base, head);
    text = fileAt(repo, forkPoint, 'factory.yml');
    source = 'factory.yml (baza)';
    if (text === undefined) {
      text = fileAt(repo, head, 'factory.yml');
      source = 'factory.yml (gałąź; na bazie go nie ma)';
    }
    if (text === undefined) throw new InputError('w repo nie ma factory.yml');
  }
  const result = loadConfig(text, source);
  if (!result.ok) throw new InputError(`Konfiguracja odrzucona:\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
  return { config: result.config, source };
}

function loadEvidence(path?: string): Evidence {
  if (!path) return {};
  const result = parseEvidence(readJson(path), path);
  if (!result.ok) throw new InputError(`Dowody odrzucone:\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
  return result.evidence;
}

function loadLint(repo: string, path?: string): LintFinding[] {
  if (!path) return [];
  try {
    return fromEslint(readJson(path), resolve(repo));
  } catch (error) {
    throw new InputError(`${path}: ${(error as Error).message}`);
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      repo: { type: 'string', default: '.' },
      config: { type: 'string' },
      evidence: { type: 'string' },
      eslint: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (!values.base) throw new InputError('podaj --base, np. --base origin/main');
  const { repo, base, head } = { repo: values.repo, base: values.base, head: values.head };
  const { config, source } = loadProjectConfig(repo, base, head, values.config);
  const facts = collect(repo, base, head, config);
  const assessment = assess({ ...facts, evidence: loadEvidence(values.evidence), lint: loadLint(repo, values.eslint) }, config);
  if (values.json) console.log(JSON.stringify({ config: source, ...assessment }, null, 2));
  else console.log(`${formatAssessment(assessment)}\n\nKonfiguracja: ${source}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof InputError ? error.message : error);
  process.exit(1);
}
