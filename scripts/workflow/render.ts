// Teksty, które workflow publikuje: komentarz z planem w issue i opis PR implementera.
// Oba kończą się blokiem JSON, z którego korzystają kolejne etapy.

import { extractJson } from '../agents/output.ts';
import type { Implementation } from './evidence.ts';
import { usageBlock } from './usage.ts';
import type { Usage } from './usage.ts';

export const PLAN_MARKER = '<!-- factory:plan -->';
export const PR_MARKER = '<!-- factory:implementation -->';

const DECISIONS: Record<string, string> = {
  planned: 'plan gotowy, implementer rusza',
  blocked: 'potrzebna Twoja decyzja',
  split: 'zadanie za duże, propozycja podziału',
};

interface Plan {
  decision: string;
  summary: string;
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
export function planComment(plan: Plan, note?: string, usage: readonly Usage[] = [], waiting?: keyof typeof WAITING): string {
  const decision = plan.decision === 'planned' && waiting ? WAITING[waiting] : (DECISIONS[plan.decision] ?? plan.decision);
  const lines = [PLAN_MARKER, `## Plan fabryki: ${decision}`, '', plan.summary, ''];
  lines.push(`Szacunek: ${plan.size.lines} linii, plików: ${plan.size.files}. Prognoza poziomu: ${plan.expected_level}.`);
  if (plan.questions?.length) lines.push('', '**Pytania do Ciebie:**', ...plan.questions.map((q) => `- ${q}`));
  if (plan.sub_issues?.length) lines.push('', '**Proponowany podział:**', ...plan.sub_issues.map((s) => `- ${s.title}`));
  if (plan.details) lines.push('', plan.details.trim());
  if (note) lines.push('', `_${note}_`);
  lines.push('', jsonBlock(plan));
  if (usage.length) lines.push('', usageBlock(usage));
  return lines.join('\n');
}

/** usage: zużycie wszystkich rund implementacji, także poprzednich (z dotychczasowego opisu PR). */
export function prBody(implementation: Implementation & { summary?: string }, usage: readonly Usage[] = []): string {
  const lines = [PR_MARKER, `Closes #${implementation.issue}`, ''];
  if (implementation.summary) lines.push(implementation.summary.trim(), '');
  lines.push('**Kryteria i dowody:**', ...implementation.acceptance.map((a) => `- ${a.criterion} → ${a.evidence}`));
  if (implementation.assumptions.length) lines.push('', '**Założenia:**', ...implementation.assumptions.map((a) => `- ${a}`));
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
