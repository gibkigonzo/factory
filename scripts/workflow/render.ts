// Teksty, które workflow publikuje: komentarz z planem w issue i opis PR implementera.
// Oba kończą się blokiem JSON, z którego korzystają kolejne etapy.

import { extractJson } from '../agents/output.ts';
import type { Implementation } from './evidence.ts';
import { usageBlock } from './usage.ts';
import type { Usage } from './usage.ts';

export const PLAN_MARKER = '<!-- factory:plan -->';
export const PR_MARKER = '<!-- factory:implementation -->';

/**
 * Problem taśmy: kłopot z narzędziami albo komendami projektu, a nie z samym zadaniem (np. komenda wypisuje
 * błąd, którego zadanie nie usunie). Agent go zgłasza, taśma się nie zatrzymuje, a dziennik zbiera zgłoszenia.
 */
export interface LineProblem {
  stage: string;
  problem: string;
  /** Kiedy zgłoszono (ISO); razem z treścią odróżnia zgłoszenia, gdy opis PR przenosi je między rundami. */
  at: string;
}

const LINE_BLOCK = /<!-- factory:line-problem (\{.*?\}) -->/gs;

/** JSON bez znaków < i >, więc treść nie zamknie komentarza HTML. */
const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

export function lineProblemBlock(problem: LineProblem): string {
  return [`**⚠️ Problem taśmy:** ${problem.problem.trim()}`, '', `<!-- factory:line-problem ${safeJson(problem)} -->`].join('\n');
}

export function parseLineProblems(text: string): LineProblem[] {
  return [...text.matchAll(LINE_BLOCK)].flatMap((m) => {
    try {
      const value = JSON.parse(m[1]!) as Partial<LineProblem>;
      return typeof value.stage === 'string' && typeof value.problem === 'string' && typeof value.at === 'string'
        ? [{ stage: value.stage, problem: value.problem, at: value.at }]
        : [];
    } catch {
      return [];
    }
  });
}

const DECISIONS: Record<string, string> = {
  planned: 'plan gotowy, implementer rusza',
  blocked: 'potrzebna Twoja decyzja',
  split: 'zadanie za duże, propozycja podziału',
};

interface Plan {
  decision: string;
  summary: string;
  line_problem?: string;
  details?: string;
  expected_level: string;
  size: { lines: number; files: number };
  questions?: string[];
  sub_issues?: { title: string }[];
}

function jsonBlock(value: unknown): string {
  return ['<details><summary>JSON</summary>', '', '```json', JSON.stringify(value, null, 2), '```', '', '</details>'].join('\n');
}

const WAITING = {
  queue: 'plan gotowy, zadanie czeka w kolejce',
  approval: 'plan gotowy, czeka na Twoją zgodę na nowe zależności',
} as const;

/** waiting: zaplanowane zadanie nie trafia od razu do implementera; note mówi, na co czeka. */
export function planComment(
  plan: Plan,
  note?: string,
  usage: readonly Usage[] = [],
  waiting?: keyof typeof WAITING,
  at = new Date().toISOString(),
): string {
  const decision = plan.decision === 'planned' && waiting ? WAITING[waiting] : (DECISIONS[plan.decision] ?? plan.decision);
  const lines = [PLAN_MARKER, `## Plan fabryki: ${decision}`, '', plan.summary, ''];
  lines.push(`Szacunek: ${plan.size.lines} linii, plików: ${plan.size.files}. Prognoza poziomu: ${plan.expected_level}.`);
  if (plan.questions?.length) lines.push('', '**Pytania do Ciebie:**', ...plan.questions.map((q) => `- ${q}`));
  if (plan.sub_issues?.length) lines.push('', '**Proponowany podział:**', ...plan.sub_issues.map((s) => `- ${s.title}`));
  if (plan.details) lines.push('', plan.details.trim());
  if (note) lines.push('', `_${note}_`);
  if (plan.line_problem?.trim()) lines.push('', lineProblemBlock({ stage: 'plan', problem: plan.line_problem, at }));
  lines.push('', jsonBlock(plan));
  if (usage.length) lines.push('', usageBlock(usage));
  return lines.join('\n');
}

/**
 * usage: zużycie wszystkich rund implementacji, także poprzednich (z dotychczasowego opisu PR).
 * previousProblems: problemy taśmy zgłoszone w poprzednich rundach; zostają w opisie, żeby dziennik ich nie zgubił.
 */
export function prBody(
  implementation: Implementation & { summary?: string; line_problem?: string },
  usage: readonly Usage[] = [],
  previousProblems: readonly LineProblem[] = [],
  at = new Date().toISOString(),
): string {
  const lines = [PR_MARKER, `Closes #${implementation.issue}`, ''];
  if (implementation.summary) lines.push(implementation.summary.trim(), '');
  lines.push('**Kryteria i dowody:**', ...implementation.acceptance.map((a) => `- ${a.criterion} → ${a.evidence}`));
  if (implementation.assumptions.length) lines.push('', '**Założenia:**', ...implementation.assumptions.map((a) => `- ${a}`));
  const problems = [...previousProblems];
  if (implementation.line_problem?.trim()) problems.push({ stage: 'implement', problem: implementation.line_problem, at });
  for (const problem of problems) lines.push('', lineProblemBlock(problem));
  lines.push('', 'Zmianę przygotował implementer fabryki. Ocena ryzyka pojawi się po recenzji.', '', jsonBlock(implementation));
  if (usage.length) lines.push('', usageBlock(usage));
  return lines.join('\n');
}

/** Najnowszy komentarz z markerem od konta workflowów; zwraca jego blok JSON. */
export function latestMarked(comments: readonly { body?: string; user?: { login?: string } }[], marker: string): unknown {
  const marked = comments.filter((c) => c.user?.login === 'github-actions[bot]' && c.body?.includes(marker));
  const last = marked[marked.length - 1];
  if (!last?.body) return undefined;
  const extracted = extractJson(last.body);
  return extracted.ok ? extracted.value : undefined;
}
