// Kolumny tablicy zadań: stan zadania z etykiet issue taśmy i z PR fabryki. Ta sama kolejność ważności co
// w taśmie: zamknięte i odrzucone zadanie jest zrobione, blokada i zgoda czekają na właściciela przed resztą.

import type { Action } from '../shadow/decision.ts';

export const COLUMNS = [
  { id: 'new', title: 'Nowe' },
  { id: 'ready', title: 'Gotowe' },
  { id: 'approval', title: 'Czeka na zgodę' },
  { id: 'queued', title: 'W kolejce' },
  { id: 'in_progress', title: 'W toku' },
  { id: 'decision', title: 'Twoja decyzja' },
  { id: 'blocked', title: 'Zablokowane' },
  { id: 'done', title: 'Zrobione' },
] as const;

export type ColumnId = (typeof COLUMNS)[number]['id'];

export interface TaskState {
  /** Stan issue zadania. */
  state: 'open' | 'closed';
  labels: readonly string[];
  /** Najnowszy PR fabryki zadania (gałąź factory/<numer>-…) i werdykt trybu cienia, gdy już jest. */
  pr?: { state: 'open' | 'merged' | 'closed'; verdict?: Action };
}

/**
 * Kolumna zadania. W trybie cienia każdy otwarty PR z werdyktem „scaliłaby” albo „do Ciebie” czeka na decyzję
 * właściciela; werdykt „do podziału” albo „poprawki bramek” znaczy, że fabryka dalej pracuje.
 */
export function taskColumn(task: TaskState): ColumnId {
  const has = (label: string) => task.labels.includes(label);
  if (task.state === 'closed' || task.pr?.state === 'merged' || has('rejected') || has('split')) return 'done';
  if (has('blocked')) return 'blocked';
  if (has('needs-approval')) return 'approval';
  if (task.pr?.state === 'open') return task.pr.verdict === 'merge' || task.pr.verdict === 'escalate' ? 'decision' : 'in_progress';
  if (has('queued')) return 'queued';
  if (has('planned')) return 'in_progress';
  if (has('ready')) return 'ready';
  return 'new';
}

/** Etap zadania czeka na wznowienie zatrzymanej taśmy (`/start`). */
export function isPaused(labels: readonly string[]): boolean {
  return labels.includes('factory:paused');
}

/** Numer issue zadania z gałęzi PR fabryki `factory/<numer>-…`. */
export function issueOfBranch(ref: string): number | undefined {
  const match = /^factory\/(\d+)-/.exec(ref);
  return match ? Number(match[1]) : undefined;
}
