// Statystyki dziennika w plikach: jeden wiersz na zadanie fabryki, z PR albo bez niego (blokada, podział, odrzucenie).
// journal.csv czyta się jako tabelę na GitHubie albo w arkuszu, journal.json jako dane dla skryptów i agentów.
// Pliki leżą na gałęzi factory-journal i odświeżają się razem z dziennikiem.

import type { Usage } from '../workflow/usage.ts';
import type { IssueRecord, PrRecord } from './collect.ts';
import { ACTION_SHORT } from './decision.ts';

export interface TaskRow {
  issue?: number;
  pr?: number;
  title: string;
  /** Stan PR albo, dla zadania bez PR, etykieta taśmy i stan issue. */
  state: string;
  level?: string;
  verdict?: string;
  rating?: 'up' | 'down';
  rounds: number;
  reverted: boolean;
  readyAt?: string;
  mergedAt?: string;
  /** Suma kosztów (USD, równowartość cen API). */
  cost: number;
  output: number;
  stages: Record<string, number>;
  reviewers: Record<string, number>;
  usage: Usage[];
}

const PR_STATE = { open: 'otwarty', merged: 'scalony', closed: "zamknięty bez merge'u" } as const;
/** Od najważniejszej: ta etykieta opisuje stan zadania bez PR. */
const ISSUE_STATE = ['rejected', 'split', 'blocked', 'needs-approval', 'queued', 'planned', 'ready'];

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

function costs(usage: readonly Usage[]) {
  const stages: Record<string, number> = {};
  const reviewers: Record<string, number> = {};
  for (const u of usage) {
    stages[u.stage] = round4((stages[u.stage] ?? 0) + u.cost);
    if (u.stage === 'review' && u.name) reviewers[u.name] = round4((reviewers[u.name] ?? 0) + u.cost);
  }
  return {
    cost: round4(usage.reduce((sum, u) => sum + u.cost, 0)),
    output: usage.reduce((sum, u) => sum + u.output, 0),
    stages,
    reviewers,
  };
}

function prRow(record: PrRecord): TaskRow {
  const row: TaskRow = {
    pr: record.number,
    title: record.title,
    state: PR_STATE[record.state],
    rounds: record.rounds,
    reverted: record.reverted,
    usage: record.usage ?? [],
    ...costs(record.usage ?? []),
  };
  if (record.issue) row.issue = record.issue;
  if (record.shadow) {
    row.level = record.shadow.record.level;
    row.verdict = ACTION_SHORT[record.shadow.record.action];
    if (record.shadow.reaction) row.rating = record.shadow.reaction;
  }
  if (record.readyAt) row.readyAt = record.readyAt;
  if (record.mergedAt) row.mergedAt = record.mergedAt;
  return row;
}

function issueRow(record: IssueRecord): TaskRow {
  const label = ISSUE_STATE.find((name) => record.labels.includes(name));
  const state = `bez PR${label ? ` (${label})` : ''}${record.state === 'closed' ? ', zamknięte' : ''}`;
  const row: TaskRow = { issue: record.issue, title: record.title, state, rounds: 0, reverted: false, usage: record.usage ?? [], ...costs(record.usage ?? []) };
  if (record.readyAt) row.readyAt = record.readyAt;
  return row;
}

/** Wiersze od najnowszego zadania (numer issue, a bez niego numer PR). */
export function taskRows(prs: readonly PrRecord[], issues: readonly IssueRecord[]): TaskRow[] {
  const key = (row: TaskRow) => row.issue ?? row.pr ?? 0;
  return [...prs.map(prRow), ...issues.map(issueRow)].sort((a, b) => key(b) - key(a) || (b.pr ?? 0) - (a.pr ?? 0));
}

const STAGE_COLUMNS: [string, string][] = [
  ['plan', 'plan_usd'],
  ['implement', 'implementacja_usd'],
  ['review', 'recenzja_usd'],
  ['assess', 'ocena_ryzyka_usd'],
];

/**
 * Komórka CSV: cudzysłów przy przecinku, cudzysłowie i nowej linii, a apostrof przed znakiem, od którego
 * arkusz zaczyna formułę. Tytuły pochodzą z issue, więc nie mogą uruchomić formuły po otwarciu pliku.
 */
function cell(value: string | number | undefined): string {
  if (value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function journalCsv(rows: readonly TaskRow[]): string {
  const reviewers = [...new Set(rows.flatMap((r) => Object.keys(r.reviewers)))].sort();
  const header = [
    'zadanie', 'pr', 'tytul', 'stan', 'poziom', 'werdykt', 'ocena', 'rundy', 'cofniety', 'gotowe', 'scalone',
    'koszt_usd', ...STAGE_COLUMNS.map(([, column]) => column), 'tokeny_wyjscia', ...reviewers.map((name) => `recenzent_${name}_usd`),
  ];
  const lines = rows.map((r) =>
    [
      r.issue, r.pr, r.title, r.state, r.level, r.verdict,
      r.rating === 'up' ? '👍' : r.rating === 'down' ? '👎' : undefined,
      r.rounds, r.reverted ? 'tak' : 'nie', r.readyAt, r.mergedAt,
      r.cost, ...STAGE_COLUMNS.map(([stage]) => r.stages[stage]), r.output, ...reviewers.map((name) => r.reviewers[name]),
    ]
      .map(cell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}

export function journalJson(rows: readonly TaskRow[], updated: string): string {
  const total = round4(rows.reduce((sum, r) => sum + r.cost, 0));
  return JSON.stringify({ updated, tasks: rows.length, cost: total, rows }, null, 2) + '\n';
}
