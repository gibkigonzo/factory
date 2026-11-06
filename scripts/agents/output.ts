// Wyjście agentów fabryki: wyciąga ostatni blok ```json z odpowiedzi agenta i sprawdza go schematem.
// Workflowy ustawiają etykiety i składają dowody tylko na podstawie sprawdzonego wyjścia.
//
// Użycie: node scripts/agents/output.ts <plan|implementation|verdict|behavior> <plik z odpowiedzią agenta>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEVELS } from '../config/spec.ts';
import type { Spec } from '../config/spec.ts';
import { check } from '../config/validate.ts';
import type { Issue } from '../config/validate.ts';
import { BEHAVIOR_SPEC, REVIEW_SPEC } from '../risk/evidence.ts';

const text: Spec = { kind: 'string' };
const texts: Spec = { kind: 'list', item: text };
const count: Spec = { kind: 'integer', min: 0 };

const CRITERION: Spec = {
  kind: 'object',
  fields: { criterion: text, evidence: text },
  required: ['criterion', 'evidence'],
};

/** Plan planera: decyzja, szacowany rozmiar, pliki, prognoza poziomu i plan dowodów. */
export const PLAN_SPEC: Spec = {
  kind: 'object',
  fields: {
    decision: { kind: 'enum', values: ['planned', 'blocked', 'split'] },
    summary: text,
    size: { kind: 'object', fields: { lines: count, files: count }, required: ['lines', 'files'] },
    files: texts,
    expected_level: { kind: 'enum', values: LEVELS },
    tests: texts,
    acceptance: { kind: 'list', item: CRITERION },
    assumptions: texts,
    questions: texts,
    sub_issues: {
      kind: 'list',
      item: { kind: 'object', fields: { title: text, body: text }, required: ['title', 'body'] },
    },
  },
  required: ['decision', 'summary', 'size', 'files', 'expected_level', 'acceptance', 'assumptions'],
};

/** Blok JSON w opisie PR implementera: dowody kryteriów i założenia. */
export const IMPLEMENTATION_SPEC: Spec = {
  kind: 'object',
  fields: {
    issue: { kind: 'integer', min: 1 },
    bugfix: { kind: 'boolean' },
    regression_test: text,
    acceptance: { kind: 'list', item: CRITERION },
    assumptions: texts,
  },
  required: ['issue', 'bugfix', 'acceptance', 'assumptions'],
};

export const OUTPUTS = {
  plan: PLAN_SPEC,
  implementation: IMPLEMENTATION_SPEC,
  verdict: REVIEW_SPEC,
  behavior: BEHAVIOR_SPEC,
} as const;

export type OutputKind = keyof typeof OUTPUTS;

export function isOutputKind(kind: string): kind is OutputKind {
  return Object.hasOwn(OUTPUTS, kind);
}

/** Ostatni blok ```json z wiadomości albo cała wiadomość, jeśli jest samym JSON-em. */
export function extractJson(message: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const blocks = [...message.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)];
  const source = blocks.length > 0 ? blocks[blocks.length - 1]![1]! : message.trim();
  if (blocks.length === 0 && !source.startsWith('{')) return { ok: false, error: 'brak bloku ```json w odpowiedzi agenta' };
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch (error) {
    return { ok: false, error: `nieprawidłowy JSON: ${(error as Error).message}` };
  }
}

function semanticProblems(kind: OutputKind, value: Record<string, unknown>): Issue[] {
  const length = (key: string) => (Array.isArray(value[key]) ? (value[key] as unknown[]).length : 0);
  if (kind === 'plan') {
    if (value.decision === 'blocked' && length('questions') === 0) {
      return [{ path: 'questions', message: 'decyzja blocked wymaga pytań do właściciela' }];
    }
    if (value.decision === 'split' && length('sub_issues') < 2) {
      return [{ path: 'sub_issues', message: 'decyzja split wymaga co najmniej dwóch mniejszych issue' }];
    }
    if (value.decision === 'planned' && length('questions') > 0) {
      return [{ path: 'questions', message: 'plan z decyzją planned nie może mieć otwartych pytań' }];
    }
  }
  if (kind === 'implementation' && value.bugfix === true && value.regression_test === undefined) {
    return [{ path: 'regression_test', message: 'poprawka błędu wymaga testu regresji' }];
  }
  return [];
}

export function parseOutput(
  kind: OutputKind,
  message: string,
  file: string,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const extracted = extractJson(message);
  if (!extracted.ok) return { ok: false, errors: [`${file}: ${extracted.error}`] };
  const issues: Issue[] = [];
  check(extracted.value, OUTPUTS[kind], '', issues);
  if (issues.length === 0) issues.push(...semanticProblems(kind, extracted.value as Record<string, unknown>));
  if (issues.length > 0) return { ok: false, errors: issues.map((i) => `${file}: ${i.path ? `${i.path}: ` : ''}${i.message}`) };
  return { ok: true, value: extracted.value };
}

function main(args: string[]): number {
  const [kind, file] = args;
  if (!kind || !file || !isOutputKind(kind)) {
    console.error(`Użycie: node scripts/agents/output.ts <${Object.keys(OUTPUTS).join('|')}> <plik>`);
    return 1;
  }
  const result = parseOutput(kind, readFileSync(file, 'utf8'), file);
  if (!result.ok) {
    console.error(`Wyjście agenta odrzucone:\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
