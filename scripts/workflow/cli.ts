// Jedno wejście dla kroków workflowów fabryki. Każda podkomenda robi jedną deterministyczną rzecz.
// Użycie: node scripts/workflow/cli.ts <podkomenda> [opcje]

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isOutputKind, OUTPUTS, parseOutput } from '../agents/output.ts';
import type { FactoryConfig } from '../config/spec.ts';
import type { Assessment, Evidence, Review } from '../risk/types.ts';
import { collectRecords, factoryIssues } from '../shadow/collect.ts';
import { shadowComment, shadowRecord } from '../shadow/comment.ts';
import { renderJournal } from '../shadow/journal.ts';
import { runCommands } from './ci.ts';
import { buildEvidence } from './evidence.ts';
import type { CiResult, Implementation } from './evidence.ts';
import { toJsonSchema } from './jsonschema.ts';
import { branchName, DENIED_FOR_READERS, implementerTools, pathProblems, READ_ONLY_TOOLS } from './patch.ts';
import { assessPrompt, implementPrompt, planPrompt, reviewPrompt } from './prompts.ts';
import { latestMarked, planComment, PLAN_MARKER, prBody, PR_MARKER } from './render.ts';
import { renderReport } from './report.ts';
import type { PanelSummary } from './report.ts';
import { parseSpec } from './spec.ts';

class UsageError extends Error {}

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const optionalJson = (path: string): unknown => (existsSync(path) ? json(path) : undefined);
const config = (path?: string): FactoryConfig => json(required(path, '--config')) as FactoryConfig;

function required(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`brak opcji ${name}`);
  return value;
}

function options(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      work: { type: 'string', default: '.factory/work' },
      issue: { type: 'string' },
      pr: { type: 'string' },
      agent: { type: 'string' },
      criteria: { type: 'string' },
      change: { type: 'boolean', default: false },
      out: { type: 'string' },
      skip: { type: 'string', default: '' },
      rounds: { type: 'string', default: '0' },
      assessment: { type: 'string' },
      panel: { type: 'string' },
      plan: { type: 'string' },
      note: { type: 'string' },
      implementation: { type: 'string' },
      title: { type: 'string' },
      evidence: { type: 'string' },
      raw: { type: 'string' },
      owners: { type: 'string' },
    },
  });
}

type Values = ReturnType<typeof options>['values'];

function prompt(stage: string | undefined, v: Values): string {
  const ctx = { work: v.work!, issue: v.issue ? Number(v.issue) : undefined, pr: v.pr ? Number(v.pr) : undefined };
  if (stage === 'plan') return planPrompt(ctx);
  if (stage === 'implement') return implementPrompt({ ...ctx, change: v.change });
  if (stage === 'review') return reviewPrompt({ ...ctx, agent: required(v.agent, '--agent'), criteria: v.criteria });
  if (stage === 'assess') return assessPrompt(ctx);
  throw new UsageError('prompt: etap plan, implement, review albo assess');
}

function evidence(v: Values): string {
  const work = v.work!;
  const dir = join(work, 'verdicts');
  const reviews = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => json(join(dir, f)) as Review) : [];
  const result = buildEvidence({
    spec: parseSpec(readFileSync(join(work, 'spec.md'), 'utf8')),
    ci: optionalJson(join(work, 'ci.json')) as CiResult | undefined,
    implementation: optionalJson(join(work, 'implementation.json')) as Implementation | undefined,
    reviews,
    behavior: optionalJson(join(work, 'behavior.json')) as { level: 'Low' | 'Medium' | 'High'; reason: string } | undefined,
    rounds: Number(v.rounds),
  });
  return JSON.stringify(result, null, 2);
}

function extract(kind: string | undefined, file: string | undefined): string {
  if (!kind || !isOutputKind(kind)) throw new UsageError(`extract: rodzaj ${Object.keys(OUTPUTS).join('|')}`);
  const result = parseOutput(kind, readFileSync(required(file, 'plik'), 'utf8'), file!);
  if (!result.ok) throw new UsageError(`Wyjście agenta odrzucone:\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
  return JSON.stringify(result.value, null, 2);
}

function marked(kind: 'plan' | 'implementation', v: Values): string {
  const source = JSON.parse(readFileSync(0, 'utf8')) as unknown;
  const comments = Array.isArray(source) ? source : [{ body: (source as { body?: string }).body, user: { login: 'github-actions[bot]' } }];
  const value = latestMarked(comments, kind === 'plan' ? PLAN_MARKER : PR_MARKER);
  if (value === undefined) throw new UsageError(`nie znaleziono bloku ${kind} (${v.issue ?? v.pr ?? ''})`);
  return JSON.stringify(value, null, 2);
}

function run(command: string | undefined, rest: string[]): string {
  const { values: v, positionals: p } = options(rest);
  switch (command) {
    case 'schema':
      if (!p[0] || !isOutputKind(p[0])) throw new UsageError('schema: rodzaj plan|implementation|verdict|behavior');
      return JSON.stringify(toJsonSchema(OUTPUTS[p[0]]));
    case 'prompt':
      return prompt(p[0], v);
    case 'extract':
      return extract(p[0], p[1]);
    case 'spec':
      return JSON.stringify(parseSpec(readFileSync(required(p[0], 'plik'), 'utf8')), null, 2);
    case 'evidence':
      return evidence(v);
    case 'report':
      return renderReport(json(required(v.assessment, '--assessment')) as Assessment, v.panel ? (json(v.panel) as PanelSummary) : undefined);
    case 'plan-comment':
      return planComment(json(required(v.plan, '--plan')) as Parameters<typeof planComment>[0], v.note);
    case 'pr-body':
      return prBody(json(required(v.implementation, '--implementation')) as Implementation);
    case 'shadow-comment':
      return shadowComment(
        shadowRecord(
          Number(required(v.pr, '--pr')),
          json(required(v.assessment, '--assessment')) as Assessment,
          json(required(v.evidence, '--evidence')) as Evidence,
        ),
        config(v.config),
      );
    case 'journal': {
      const cfg = config(v.config);
      const owners = required(v.owners, '--owners').split(',').map((o) => o.trim()).filter(Boolean);
      const updated = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      return renderJournal(collectRecords(required(v.raw, '--raw'), owners, cfg.shadow.revert_days), cfg, updated);
    }
    case 'journal-issues':
      return factoryIssues(required(v.raw, '--raw')).join('\n');
    case 'find-plan':
      return marked('plan', v);
    case 'find-implementation':
      return marked('implementation', v);
    case 'branch':
      return branchName(Number(required(v.issue, '--issue')), v.title ?? '');
    case 'tools':
      return p[0] === 'implement' ? implementerTools(config(v.config)) : READ_ONLY_TOOLS;
    case 'denied-tools':
      return DENIED_FOR_READERS;
    case 'model':
      return modelFor(p[0], config(v.config));
    case 'check-paths':
      return checkPaths(config(v.config));
    case 'ci': {
      const result = runCommands(config(v.config).commands, process.cwd(), v.skip!.split(',').filter(Boolean));
      writeFileSync(required(v.out, '--out'), JSON.stringify(result, null, 2));
      return `CI: ${result.status}`;
    }
    default:
      throw new UsageError(`nieznana podkomenda: ${command ?? '(brak)'}`);
  }
}

function modelFor(stage: string | undefined, cfg: FactoryConfig): string {
  if (stage === 'planner' || stage === 'implementer' || stage === 'risk_assessor') return cfg.models[stage];
  throw new UsageError('model: planner, implementer albo risk_assessor');
}

function checkPaths(cfg: FactoryConfig): string {
  const paths = readFileSync(0, 'utf8').split('\n').map((p) => p.trim()).filter(Boolean);
  const problems = pathProblems(paths, cfg);
  if (problems.length > 0) throw new UsageError(`Zmiana odrzucona:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return `ok: ${paths.length} plików`;
}

try {
  const [command, ...rest] = process.argv.slice(2);
  console.log(run(command, rest));
} catch (error) {
  console.error(error instanceof UsageError ? error.message : error);
  process.exit(1);
}
