// Plik journal.json z gałęzi factory-journal: koszty i stan zadań, problemy taśmy i jej zatrzymanie.

import type { TaskRow } from '../shadow/export.ts';
import type { LineProblemRecord, StopState } from '../shadow/records.ts';

export interface JournalFile {
  updated: string;
  stopped: StopState | null;
  tasks: number;
  /** Suma kosztów wszystkich zadań (USD, równowartość cen API). */
  cost: number;
  rows: TaskRow[];
  lineProblems: LineProblemRecord[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** journal.json albo nic, gdy plik nie ma oczekiwanego kształtu (np. starsza wersja fabryki). */
export function parseJournal(text: string): JournalFile | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(data)) return undefined;
  const ok =
    typeof data.updated === 'string' &&
    typeof data.tasks === 'number' &&
    typeof data.cost === 'number' &&
    Array.isArray(data.rows) &&
    data.rows.every((row) => isObject(row) && typeof row.title === 'string' && typeof row.cost === 'number') &&
    (data.lineProblems === undefined || Array.isArray(data.lineProblems)) &&
    (data.stopped === null || data.stopped === undefined || isObject(data.stopped));
  if (!ok) return undefined;
  return {
    updated: data.updated as string,
    stopped: (data.stopped as StopState | undefined) ?? null,
    tasks: data.tasks as number,
    cost: data.cost as number,
    rows: data.rows as TaskRow[],
    lineProblems: (data.lineProblems as LineProblemRecord[] | undefined) ?? [],
  };
}
