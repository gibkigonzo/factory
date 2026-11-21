// Kolejka zadań taśmy. Zadanie z etykietą `ready` dostaje plan dopiero wtedy, gdy może ruszyć: zadania z sekcji
// „Zależy od” specu są scalone, a limit WIP ma miejsce. Inaczej czeka bez planu z etykietą `queued`, żeby plan
// powstał na aktualnym kodzie. Po planie implementer rusza, gdy zadanie nie dzieli plików z zadaniem w toku ani
// z wcześniejszym czekającym; inaczej czeka z planem. Workflow kolejki wypuszcza czekające po zamknięciu PR fabryki,
// po komendach i raz dziennie: każde dostaje świeży plan, chyba że plan ma już zgodę właściciela na zależności.
// Pliki zadania to pliki z planu, a gdy ma otwarty PR, także pliki z PR.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { latestMarked, PLAN_MARKER } from './render.ts';
import { parseDependencies } from './spec.ts';

export interface Task {
  issue: number;
  files: string[];
}

/** Zadanie z etykietą `queued`: bez planu czeka przed planerem, z planem po nim. */
export interface WaitingTask extends Task {
  planned: boolean;
  /** Właściciel zgodził się na zależności z planu (`/approve`); nowy plan wymagałby nowej zgody. */
  approved: boolean;
  dependsOn: number[];
}

/** Zadanie, od którego zależy inne: scalone, jeszcze w drodze albo takie, które nie powstanie. */
export type DependencyState = 'done' | 'open' | 'dropped';

export interface QueueState {
  /** Zadania w toku: implementacja trwa albo PR jest otwarty. */
  active: Task[];
  /** Zadania z etykietą `queued` bez otwartego PR, w kolejności numerów. */
  waiting: WaitingTask[];
  /** Issue z etykietą `ready`, które planer właśnie planuje: bez niescalonych zależności ze specu. */
  planning: number[];
  /** Stan zadań z sekcji „Zależy od” otwartych issue. */
  dependencies: Record<number, DependencyState>;
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

export type Gate = { action: 'plan' } | { action: 'wait' | 'blocked'; reason: string };

function issues(numbers: readonly number[]): string {
  return numbers.map((n) => `#${n}`).join(', ');
}

/** Zależności ze specu, które blokują zadanie: jeszcze w drodze albo takie, które nie powstaną. */
function unmet(task: Pick<WaitingTask, 'dependsOn'>, states: QueueState['dependencies']): Gate | undefined {
  const dropped = task.dependsOn.filter((n) => (states[n] ?? 'dropped') === 'dropped');
  if (dropped.length > 0) {
    return {
      action: 'blocked',
      reason:
        `Zadanie zależy od ${issues(dropped)}, a to nie zostanie zrobione: issue odrzucone, podzielone, zamknięte bez realizacji albo go nie ma. ` +
        'Popraw sekcję „Zależy od” w specu i dodaj `ready` albo odrzuć zadanie komendą `/reject`.',
    };
  }
  const open = task.dependsOn.filter((n) => states[n] === 'open');
  if (open.length > 0) return { action: 'wait', reason: `Czeka na ${issues(open)}: spec mówi, że zadanie od nich zależy.` };
  return undefined;
}

/**
 * Czy zadanie z etykietą `ready` dostaje plan teraz. `state` bez tego zadania. W limicie WIP liczą się zadania w toku
 * i wcześniejsze issue, które planer właśnie planuje. Późniejszych nie liczymy: przy `ready` na wielu issue naraz
 * każde czekałoby na pozostałe i żadne by nie ruszyło.
 */
export function gate(issue: number, dependsOn: readonly number[], state: QueueState, limit: number): Gate {
  const blocked = unmet({ dependsOn: [...dependsOn] }, state.dependencies);
  if (blocked) return blocked;
  const busy = state.active.filter((t) => t.issue !== issue).length + state.planning.filter((n) => n < issue).length;
  if (busy >= limit) return { action: 'wait', reason: `Kolejka pełna: ${busy} z ${limit} zadań w toku.` };
  return { action: 'plan' };
}

export type Step = { issue: number; action: 'plan' | 'implement' } | { issue: number; action: 'blocked'; reason: string };

/**
 * Co zrobić z czekającymi zadaniami teraz, w kolejności numerów. Wpuszczone liczą się już jako zadania w toku
 * dla następnych, a planowane teraz zajmują miejsce w limicie. Zadanie dostaje świeży plan, bo od poprzedniego
 * mogły wejść zmiany w jego plikach; implementer rusza od razu tylko z planem, na którego zależności jest zgoda.
 */
export function release(state: QueueState, limit: number): Step[] {
  const active: Task[] = [...state.active, ...state.planning.map((issue) => ({ issue, files: [] }))];
  const ahead: Task[] = [];
  const steps: Step[] = [];
  for (const task of [...state.waiting].sort((a, b) => a.issue - b.issue)) {
    const blocked = unmet(task, state.dependencies);
    if (blocked?.action === 'blocked') {
      steps.push({ issue: task.issue, action: 'blocked', reason: blocked.reason });
    } else if (!blocked && admit(task, active, limit, ahead).start) {
      active.push(task);
      steps.push({ issue: task.issue, action: task.planned && task.approved ? 'implement' : 'plan' });
    } else {
      ahead.push(task);
    }
  }
  return steps;
}

interface RawIssue {
  number: number;
  body?: string;
  labels?: { name: string }[];
}

interface RawClosedIssue {
  number: number;
  /** `open` tylko dla PR wskazanego w „Zależy od” zamiast issue. */
  state?: string;
  state_reason?: string | null;
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

/** Zadanie odrzucone albo podzielone nie zostanie scalone, więc nie odblokuje zadań, które od niego zależą. */
const DROPPED = ['rejected', 'split'];

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

function labelsOf(issue: RawIssue): string[] {
  return (issue.labels ?? []).map((l) => l.name);
}

/** Zadania z sekcji „Zależy od” otwartych issue, których nie ma wśród otwartych: ich stan trzeba pobrać osobno. */
export function closedDependencies(dir: string): number[] {
  const open = read<RawIssue[]>(join(dir, 'issues.json'), []);
  const numbers = new Set(open.map((i) => i.number));
  const deps = open.flatMap((i) => parseDependencies(i.body ?? '', i.number)).filter((n) => !numbers.has(n));
  return [...new Set(deps)].sort((a, b) => a - b);
}

/**
 * Stan kolejki z danych API: `issues.json` (otwarte issue z etykietami i treścią), `prs.json` (PR-y, wszystkie stany),
 * `open.json` (otwarte PR-y z plikami), `closed.json` (zamknięte issue z sekcji „Zależy od”) i `comments/<issue>.json`
 * (komentarze z planem). Issue z planem bez PR jest w toku (implementacja trwa); issue, którego PR-y są tylko
 * zamknięte, już nie. Zależność jest zrobiona, gdy ma scalony PR fabryki albo issue zamknięte jako zrobione.
 */
export function queueState(dir: string, skip?: number): QueueState {
  const own = (pr: RawPr) => pr.headRefName.startsWith('factory/') && !pr.isCrossRepository;
  const prs = read<RawPr[]>(join(dir, 'prs.json'), []).filter(own);
  const open = read<RawPr[]>(join(dir, 'open.json'), []).filter(own);
  const all = read<RawIssue[]>(join(dir, 'issues.json'), []);
  const closed = read<RawClosedIssue[]>(join(dir, 'closed.json'), []);
  const state: QueueState = { active: [], waiting: [], planning: [], dependencies: {} };

  for (const issue of all) {
    for (const n of parseDependencies(issue.body ?? '', issue.number)) {
      const merged = prs.some((pr) => pr.state === 'MERGED' && issueOfBranch(pr.headRefName) === n);
      const openIssue = all.find((i) => i.number === n);
      const closedIssue = closed.find((i) => i.number === n);
      state.dependencies[n] = merged
        ? 'done'
        : openIssue
          ? labelsOf(openIssue).some((l) => DROPPED.includes(l)) ? 'dropped' : 'open'
          : closedIssue?.state === 'open'
            ? 'open'
            : closedIssue && !['not_planned', 'duplicate'].includes(closedIssue.state_reason ?? '')
              ? 'done'
              : 'dropped';
    }
  }

  for (const issue of all) {
    const labels = labelsOf(issue);
    if (issue.number === skip || labels.some((l) => STOPPED.includes(l))) continue;
    const dependsOn = parseDependencies(issue.body ?? '', issue.number);
    if (!labels.includes('planned')) {
      if (labels.includes('queued')) state.waiting.push({ issue: issue.number, files: [], planned: false, approved: false, dependsOn });
      // Zadanie z `ready`, które czeka na zależności, planu teraz nie dostanie, więc nie zajmuje miejsca w limicie.
      else if (labels.includes('ready') && dependsOn.every((n) => state.dependencies[n] === 'done')) state.planning.push(issue.number);
      continue;
    }
    const mine = (pr: RawPr) => issueOfBranch(pr.headRefName) === issue.number;
    const openPr = open.find(mine);
    const files = [...new Set([...planFiles(dir, issue.number), ...(openPr?.files ?? []).map((f) => f.path)])].sort();
    const task = { issue: issue.number, files };
    if (openPr) state.active.push(task);
    else if (labels.includes('queued')) {
      state.waiting.push({ ...task, planned: true, approved: labels.includes('factory:approved'), dependsOn });
    } else if (!prs.some(mine)) state.active.push(task);
    else if (labels.includes('ready')) state.planning.push(issue.number);
  }
  state.waiting.sort((a, b) => a.issue - b.issue);
  state.planning.sort((a, b) => a - b);
  return state;
}
