// Kolejka zadań taśmy. Implementer rusza, gdy zadanie mieści się w limicie WIP i nie dzieli plików z zadaniem
// w toku ani z wcześniejszym czekającym. Inaczej issue czeka z etykietą `queued`, a workflow kolejki uruchamia je
// po zamknięciu PR fabryki i raz dziennie. Pliki zadania to pliki z planu, a gdy ma otwarty PR, także pliki z PR.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { latestMarked, PLAN_MARKER } from './render.ts';

export interface Task {
  issue: number;
  files: string[];
}

export interface QueueState {
  /** Zadania w toku: implementacja trwa albo PR jest otwarty. */
  active: Task[];
  /** Zadania z etykietą `queued` bez otwartego PR, w kolejności numerów. */
  waiting: Task[];
}

export type Admission = { start: true } | { start: false; reason: string };

const SHOWN = 3;

function shown(items: readonly string[]): string {
  const head = items.slice(0, SHOWN).map((f) => `\`${f}\``).join(', ');
  return items.length > SHOWN ? `${head} i ${items.length - SHOWN} więcej` : head;
}

/** Czy zadanie może ruszyć. `ahead`: czekające przed nim; ich pliki też blokują, żeby kolejka nie dała się wyprzedzić. */
export function admit(task: Task, active: readonly Task[], limit: number, ahead: readonly Task[] = []): Admission {
  const mine = new Set(task.files);
  const others = active.filter((t) => t.issue !== task.issue);
  const clashes = [...others, ...ahead.filter((t) => t.issue !== task.issue)]
    .map((t) => ({ issue: t.issue, files: t.files.filter((f) => mine.has(f)) }))
    .filter((c) => c.files.length > 0);
  if (clashes.length > 0) {
    const files = [...new Set(clashes.flatMap((c) => c.files))].sort();
    return { start: false, reason: `Czeka na ${clashes.map((c) => `#${c.issue}`).join(', ')}: wspólne pliki ${shown(files)}.` };
  }
  if (others.length >= limit) return { start: false, reason: `Kolejka pełna: ${others.length} z ${limit} zadań w toku.` };
  return { start: true };
}

/** Czekające zadania, które mogą ruszyć teraz. Każde wpuszczone liczy się już jako zadanie w toku dla następnych. */
export function release(state: QueueState, limit: number): number[] {
  const active = [...state.active];
  const ahead: Task[] = [];
  const started: number[] = [];
  for (const task of [...state.waiting].sort((a, b) => a.issue - b.issue)) {
    if (admit(task, active, limit, ahead).start) {
      active.push(task);
      started.push(task.issue);
    } else {
      ahead.push(task);
    }
  }
  return started;
}

interface RawIssue {
  number: number;
  labels?: { name: string }[];
}

interface RawPr {
  number: number;
  state: string;
  headRefName: string;
  isCrossRepository?: boolean;
  files?: { path: string }[];
}

/** Etykiety, przy których issue nie jest ani w toku, ani w kolejce. `needs-approval`: plan czeka na zgodę właściciela. */
const STOPPED = ['blocked', 'rejected', 'split', 'needs-approval'];

function read<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) ?? fallback : fallback;
}

function issueOfBranch(branch: string): number | undefined {
  const number = /^factory\/(\d+)-/.exec(branch)?.[1];
  return number ? Number(number) : undefined;
}

function planFiles(dir: string, issue: number): string[] {
  const plan = latestMarked(read(join(dir, 'comments', `${issue}.json`), []), PLAN_MARKER) as { files?: unknown } | undefined;
  return Array.isArray(plan?.files) ? plan.files.filter((f): f is string => typeof f === 'string') : [];
}

/**
 * Stan kolejki z danych API: `issues.json` (otwarte issue z etykietą `planned`), `prs.json` (PR-y, wszystkie stany),
 * `open.json` (otwarte PR-y z plikami) i `comments/<issue>.json` (komentarze z planem).
 * Issue bez PR jest w toku (implementacja trwa); issue, którego PR-y są tylko zamknięte, już nie.
 */
export function queueState(dir: string, skip?: number): QueueState {
  const own = (pr: RawPr) => pr.headRefName.startsWith('factory/') && !pr.isCrossRepository;
  const prs = read<RawPr[]>(join(dir, 'prs.json'), []).filter(own);
  const open = read<RawPr[]>(join(dir, 'open.json'), []).filter(own);
  const state: QueueState = { active: [], waiting: [] };
  for (const issue of read<RawIssue[]>(join(dir, 'issues.json'), [])) {
    const labels = (issue.labels ?? []).map((l) => l.name);
    if (issue.number === skip || !labels.includes('planned') || labels.some((l) => STOPPED.includes(l))) continue;
    const mine = (pr: RawPr) => issueOfBranch(pr.headRefName) === issue.number;
    const openPr = open.find(mine);
    const files = [...new Set([...planFiles(dir, issue.number), ...(openPr?.files ?? []).map((f) => f.path)])].sort();
    const task = { issue: issue.number, files };
    if (openPr) state.active.push(task);
    else if (labels.includes('queued')) state.waiting.push(task);
    else if (!prs.some(mine)) state.active.push(task);
  }
  state.waiting.sort((a, b) => a.issue - b.issue);
  return state;
}
