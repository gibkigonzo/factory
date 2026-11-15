// Rekordy dziennika trybu cienia (PR-y, zadania bez PR, problemy taśmy, zatrzymanie) bez zależności od Node.
// Zbiera je collect.ts z danych z GitHuba, a czytają eksport, dziennik i aplikacja do prowadzenia projektów.

import type { LineProblem } from '../workflow/line-problem.ts';
import type { Usage } from '../workflow/usage.ts';
import type { ShadowRecord } from './comment.ts';

export interface PrRecord {
  number: number;
  /** Issue zadania, z nazwy gałęzi factory/<numer>-…. */
  issue?: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
  readyAt?: string;
  rounds: number;
  reverted: boolean;
  /** `implied`: ocena wynika z `/change` właściciela po werdykcie (po „scal” to 👎, po eskalacji 👍), a nie z reakcji na komentarz. */
  shadow?: { record: ShadowRecord; at: string; reaction?: 'up' | 'down'; implied?: 'change' };
  /** Zużycie wszystkich etapów i rund dla tego PR, zsumowane na etap. */
  usage?: Usage[];
}

/** Zadanie fabryki, które nie dało PR: plan zablokowany, podzielony albo odrzucony, czekające albo z blokadą implementacji. */
export interface IssueRecord {
  issue: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  closedAt?: string;
  readyAt?: string;
  usage?: Usage[];
}

/** Zgłoszony problem taśmy z zadaniem, w którym go zgłoszono. */
export interface LineProblemRecord extends LineProblem {
  issue?: number;
  pr?: number;
}

/** Zatrzymana taśma: otwarte issue z etykietą factory:stopped (komenda /stop). */
export interface StopState {
  issue: number;
  since: string;
  reason?: string;
}
