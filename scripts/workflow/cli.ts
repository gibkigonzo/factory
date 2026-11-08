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
import { claudeRuns } from './budget.ts';
import type { Run } from './budget.ts';
import { installCommands } from './dependencies.ts';
import type { Dependency } from './dependencies.ts';
import { nextRound, roundComment } from './loop.ts';
import { admit, queueState, release } from './queue.ts';
import { renderReport } from './report.ts';
import type { PanelSummary } from './report.ts';
import { parseSpec } from './spec.ts';
import { isStage, parseUsageBlocks, parseUsageList, readUsage, sessionError, sessionStarted, sumUsage } from './usage.ts';
import type { Usage } from './usage.ts';

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
      usage: { type: 'string' },
      previous: { type: 'string' },
      file: { type: 'string' },
      stage: { type: 'string' },
      dir: { type: 'string' },
      limit: { type: 'string' },
      round: { type: 'string', default: '0' },
      waiting: { type: 'string' },
      runs: { type: 'string' },
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

function verdicts(work: string): Review[] {
  const dir = join(work, 'verdicts');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => json(join(dir, f)) as Review) : [];
}

function waiting(value: string | undefined): 'queue' | 'approval' | undefined {
  if (value === undefined || value === '') return undefined;
  if (value !== 'queue' && value !== 'approval') throw new UsageError(`--waiting: queue albo approval, jest: ${value}`);
  return value;
}

function evidence(v: Values): string {
  const work = v.work!;
  const reviews = verdicts(work);
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

/** Plik z listą rekordów zużycia; brak pliku albo zły format to pusta lista. */
function usageFile(path: string | undefined): Usage[] {
  if (!path || !existsSync(path)) return [];
  try {
    return parseUsageList(json(path));
  } catch {
    return [];
  }
}

/** Zużycie jednej sesji z pliku przebiegu claude-code-action. Zapisuje plik tylko, gdy przebieg ma wynik. */
function usage(v: Values): string {
  const stage = required(v.stage, '--stage');
  if (!isStage(stage)) throw new UsageError(`usage: etap ${['plan', 'implement', 'review', 'assess'].join('|')}`);
  const file = required(v.file, '--file');
  const raw = existsSync(file) ? json(file) : undefined;
  const record = raw === undefined ? undefined : readUsage(raw, stage);
  if (!record) return `zużycie: brak wyniku w ${file}`;
  writeFileSync(required(v.out, '--out'), JSON.stringify([record]));
  const error = sessionError(raw);
  const line = `zużycie ${stage}: ${record.cost} USD, tury ${record.turns}, tokeny wyjścia ${record.output}`;
  return error ? `${line}\n::warning::Sesja Claude zakończyła się błędem: ${error}` : line;
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
    case 'usage':
      return usage(v);
    case 'budget':
      return String(claudeRuns(json(required(v.runs, '--runs')) as Run[]));
    case 'started': {
      const file = required(v.file, '--file');
      if (!existsSync(file) || !sessionStarted(json(file))) throw new UsageError('Claude nie wystartował: brak wyniku sesji albo błąd bez kosztu');
      return 'Claude wystartował';
    }
    case 'usage-sum': {
      const dir = required(v.dir, '--dir');
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
      return JSON.stringify(sumUsage(files.flatMap((f) => usageFile(join(dir, f)))));
    }
    case 'report':
      return renderReport(json(required(v.assessment, '--assessment')) as Assessment, v.panel ? (json(v.panel) as PanelSummary) : undefined);
    case 'plan-comment':
      return planComment(json(required(v.plan, '--plan')) as Parameters<typeof planComment>[0], v.note, usageFile(v.usage), waiting(v.waiting));
    case 'install-commands': {
      const plan = json(required(v.plan, '--plan')) as { dependencies?: Dependency[] };
      const result = installCommands(plan.dependencies ?? [], config(v.config));
      if (!result.ok) throw new UsageError(result.reason);
      return result.commands.join('\n');
    }
    case 'loop': {
      const work = v.work!;
      const input = { ci: optionalJson(join(work, 'ci.json')) as CiResult | undefined, reviews: verdicts(work), round: Number(v.round), maxRounds: config(v.config).risk.max_review_rounds };
      const decision = nextRound(input);
      if (decision.retry) writeFileSync(required(v.out, '--out'), roundComment(input));
      return JSON.stringify(decision);
    }
    case 'pr-body': {
      const previous = v.previous && existsSync(v.previous) ? parseUsageBlocks(readFileSync(v.previous, 'utf8')) : [];
      return prBody(json(required(v.implementation, '--implementation')) as Implementation, [...previous, ...usageFile(v.usage)]);
    }
    case 'shadow-comment':
      return shadowComment(
        shadowRecord(
          Number(required(v.pr, '--pr')),
          json(required(v.assessment, '--assessment')) as Assessment,
          json(required(v.evidence, '--evidence')) as Evidence,
          usageFile(v.usage),
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
    case 'queue-admit': {
      const issue = Number(required(v.issue, '--issue'));
      const plan = json(required(v.plan, '--plan')) as { files?: string[] };
      const state = queueState(required(v.raw, '--raw'), issue);
      return JSON.stringify(admit({ issue, files: plan.files ?? [] }, state.active, limit(v), state.waiting));
    }
    case 'queue-release':
      return release(queueState(required(v.raw, '--raw')), limit(v)).join('\n');
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

function limit(v: Values): number {
  const value = Number(required(v.limit, '--limit'));
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`--limit: oczekiwano liczby całkowitej ≥ 1, jest: ${v.limit}`);
  return value;
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
