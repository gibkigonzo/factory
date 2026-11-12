// Zbiera dane do dziennika trybu cienia z plików pobranych przez workflow (gh, git):
//   prs.json                 gh pr list --state all --json number,title,body,state,createdAt,mergedAt,closedAt,headRefName,isCrossRepository,labels,mergeCommit,closingIssuesReferences
//   comments/<pr>.json       komentarze PR (wystarczą te z werdyktem)
//   reactions/<comment>.json reakcje na komentarz z werdyktem
//   events/<issue>.json      zdarzenia issue (kiedy dostało etykietę ready)
//   issues/<issue>.json      data założenia issue: { created_at }
//   issue-list.json          gh issue list --state all --json number,title,state,labels,createdAt,closedAt
//   stopped.json             gh issue list --label factory:stopped --state open --json number,body,createdAt (/stop)
//   plans/<issue>.json       komentarze bota z planem albo blokadą: [{ body }] (zużycie planera i zablokowanej implementacji)
//   rounds/<pr>.json         komentarze bota z rundą poprawek: [{ body }] (zużycie recenzji rund bez werdyktu)
//   changes/<pr>.json        komentarze z komendą /change: [{ user: { login }, created_at }]
//   reverts.txt              git log gałęzi głównej: rekordy „\x1e<data ISO>\t<treść commita>”

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUND_MARKER } from '../workflow/loop.ts';
import { parseLineProblems } from '../workflow/render.ts';
import type { LineProblem } from '../workflow/render.ts';
import { parseUsageBlocks, sumUsage } from '../workflow/usage.ts';
import type { Usage } from '../workflow/usage.ts';
import { parseShadow } from './comment.ts';
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
  /** `implied`: ocena wynika z `/change` właściciela po werdykcie, a nie z reakcji na komentarz. */
  shadow?: { record: ShadowRecord; at: string; reaction?: 'up' | 'down'; implied?: 'change' };
  /** Zużycie wszystkich etapów i rund dla tego PR, zsumowane na etap. */
  usage?: Usage[];
}

interface RawPr {
  number: number;
  title: string;
  body?: string;
  state: string;
  createdAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  headRefName: string;
  isCrossRepository?: boolean;
  labels?: { name: string }[];
  mergeCommit?: { oid: string } | null;
  closingIssuesReferences?: { number: number }[];
}

interface RawComment {
  id: number;
  body?: string;
  user?: { login?: string };
  created_at: string;
}

interface RawReaction {
  content: string;
  user?: { login?: string };
  created_at: string;
}

const read = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback);

export interface Revert {
  at: string;
  sha: string;
}

export function parseReverts(text: string): Revert[] {
  return text
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [at = '', ...message] = entry.split('\t');
      return [...message.join('\t').matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => ({ at, sha: m[1]! }));
    });
}

/** Ostatnia reakcja właściciela 👍/👎 na komentarz. */
function ownerReaction(dir: string, comment: RawComment, owners: readonly string[]): 'up' | 'down' | undefined {
  const reactions = read<RawReaction[]>(join(dir, 'reactions', `${comment.id}.json`), [])
    .filter((r) => owners.includes(r.user?.login ?? '') && (r.content === '+1' || r.content === '-1'))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const reaction = reactions[reactions.length - 1];
  return reaction ? (reaction.content === '+1' ? 'up' : 'down') : undefined;
}

/**
 * Werdykt, który liczy się do kalibracji, i ocena właściciela. Zwykle to ostatni werdykt PR z reakcją 👍/👎.
 * Wyjątek: werdykt „scal” (Low) albo „okno weta” (Medium), po którym właściciel napisał `/change` przed kolejnym
 * werdyktem. W Etapie 1 taki PR scaliłby się bez tej poprawki, więc liczy się ten werdykt, jako 👎
 * (przy Low to fałszywe Low). Reakcja właściciela na ten sam werdykt ma pierwszeństwo przed `/change`.
 * Eskalacja (High) i `/change` to zgoda: decyzja i tak należała do właściciela.
 */
function latestShadow(dir: string, pr: number, owners: readonly string[]): PrRecord['shadow'] {
  const comments = read<RawComment[]>(join(dir, 'comments', `${pr}.json`), [])
    .filter((c) => c.user?.login === 'github-actions[bot]')
    .flatMap((c) => {
      const record = parseShadow(c.body ?? '');
      return record ? [{ comment: c, record }] : [];
    });
  const last = comments[comments.length - 1];
  if (!last) return undefined;
  const changes = read<{ user?: { login?: string }; created_at?: string }[]>(join(dir, 'changes', `${pr}.json`), [])
    .filter((c) => owners.includes(c.user?.login ?? '') && c.created_at)
    .map((c) => c.created_at!);
  for (const [i, verdict] of comments.entries()) {
    if (verdict.record.action !== 'merge' && verdict.record.action !== 'veto-window') continue;
    const next = comments[i + 1]?.comment.created_at ?? '\uffff';
    if (!changes.some((at) => at > verdict.comment.created_at && at < next)) continue;
    const reaction = ownerReaction(dir, verdict.comment, owners);
    return { record: verdict.record, at: verdict.comment.created_at, ...(reaction ? { reaction } : { reaction: 'down', implied: 'change' as const }) };
  }
  const shadow: NonNullable<PrRecord['shadow']> = { record: last.record, at: last.comment.created_at };
  const reaction = ownerReaction(dir, last.comment, owners);
  if (reaction) shadow.reaction = reaction;
  return shadow;
}

/**
 * Issue, które zrealizował PR fabryki. Numer jest w nazwie gałęzi `factory/<numer>-<nazwa>`, którą nadaje fabryka.
 * Powiązania PR z issue to tylko zapas: GitHub nie zawsze je zwraca po scaleniu.
 */
export function issueOf(pr: Pick<RawPr, 'headRefName' | 'closingIssuesReferences'>): number | undefined {
  const fromBranch = /^factory\/(\d+)-/.exec(pr.headRefName)?.[1];
  return fromBranch ? Number(fromBranch) : pr.closingIssuesReferences?.[0]?.number;
}

/** Kiedy issue dostało etykietę ready. Bez takiego zdarzenia: data założenia, bo issue założone od razu z etykietą jej nie ma. */
function readyAt(dir: string, issue: number | undefined): string | undefined {
  if (!issue) return undefined;
  const events = read<{ event: string; label?: { name: string }; created_at: string }[]>(join(dir, 'events', `${issue}.json`), []);
  const labeled = events.filter((e) => e.event === 'labeled' && e.label?.name === 'ready').map((e) => e.created_at).sort()[0];
  return labeled ?? read<{ created_at?: string }>(join(dir, 'issues', `${issue}.json`), {}).created_at;
}

function rounds(labels: readonly { name: string }[] = []): number {
  const numbers = labels.map((l) => /^factory:round-(\d+)$/.exec(l.name)?.[1]).filter(Boolean).map(Number);
  return numbers.length > 0 ? Math.max(...numbers) : 0;
}

/** Zużycie z komentarzy bota w issue: plan i implementacje zakończone blokadą (te nie trafiają do opisu PR). */
function issueUsage(dir: string, issue: number | undefined): Usage[] {
  const comments = issue ? read<{ body?: string }[]>(join(dir, 'plans', `${issue}.json`), []) : [];
  return comments.flatMap((c) => parseUsageBlocks(c.body ?? '').filter((u) => u.stage === 'plan' || u.stage === 'implement'));
}

/**
 * Zużycie: plan i blokady (komentarze w issue), implementacja (opis PR), recenzja i ocena (wszystkie werdykty),
 * a recenzja rund odesłanych do implementera z komentarzy rund (te rundy nie mają werdyktu).
 */
function usageOf(dir: string, pr: RawPr, issue: number | undefined): Usage[] {
  const verdicts = read<RawComment[]>(join(dir, 'comments', `${pr.number}.json`), [])
    .filter((c) => c.user?.login === 'github-actions[bot]')
    .flatMap((c) => parseShadow(c.body ?? '')?.usage ?? []);
  const rounds = read<{ body?: string }[]>(join(dir, 'rounds', `${pr.number}.json`), [])
    .filter((c) => (c.body ?? '').startsWith(ROUND_MARKER))
    .flatMap((c) => parseUsageBlocks(c.body ?? ''));
  const records = [
    ...issueUsage(dir, issue),
    ...parseUsageBlocks(pr.body ?? '').filter((u) => u.stage === 'implement'),
    ...verdicts.filter((u) => u.stage === 'review' || u.stage === 'assess'),
    ...rounds.filter((u) => u.stage === 'review'),
  ];
  return sumUsage(records);
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  labels?: { name: string }[];
  createdAt: string;
  closedAt?: string | null;
}

/** Etykiety, które nadaje taśma: issue z którąś z nich jest zadaniem fabryki, także gdy nie powstał PR. */
export const TASK_LABELS = ['ready', 'planned', 'queued', 'needs-approval', 'blocked', 'split', 'rejected'] as const;

function taskIssues(dir: string): RawIssue[] {
  const labels: readonly string[] = TASK_LABELS;
  return read<RawIssue[]>(join(dir, 'issue-list.json'), []).filter((i) => i.labels?.some((l) => labels.includes(l.name)));
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

const DAY = 24 * 60 * 60 * 1000;

/** PR-y fabryki z tego repo: gałęzie factory/*, bez forków. */
function factoryPrs(dir: string): RawPr[] {
  return read<RawPr[]>(join(dir, 'prs.json'), []).filter((pr) => pr.headRefName.startsWith('factory/') && !pr.isCrossRepository);
}

/** Numery issue, dla których workflow ma pobrać zdarzenia, datę założenia i komentarze z planem lub blokadą. */
export function factoryIssues(dir: string): number[] {
  const fromPrs = factoryPrs(dir).map(issueOf).filter((n): n is number => n !== undefined);
  return [...new Set([...fromPrs, ...taskIssues(dir).map((i) => i.number)])].sort((a, b) => a - b);
}

/** Zgłoszony problem taśmy z zadaniem, w którym go zgłoszono. */
export interface LineProblemRecord extends LineProblem {
  issue?: number;
  pr?: number;
}

/**
 * Problemy taśmy z komentarzy planu i blokady w issue oraz z opisów PR fabryki, od najnowszego.
 * Opis PR przenosi zgłoszenia z poprzednich rund, więc to samo zgłoszenie liczy się raz.
 */
export function collectLineProblems(dir: string): LineProblemRecord[] {
  const found = new Map<string, LineProblemRecord>();
  const add = (problem: LineProblem, issue?: number, pr?: number) => {
    const key = `${issue ?? ''}|${problem.stage}|${problem.at}|${problem.problem}`;
    const record: LineProblemRecord = { ...problem };
    if (issue) record.issue = issue;
    if (pr) record.pr = pr;
    if (!found.has(key) || pr) found.set(key, record);
  };
  for (const issue of factoryIssues(dir)) {
    for (const comment of read<{ body?: string }[]>(join(dir, 'plans', `${issue}.json`), [])) {
      for (const problem of parseLineProblems(comment.body ?? '')) add(problem, issue);
    }
  }
  for (const pr of factoryPrs(dir)) {
    for (const problem of parseLineProblems(pr.body ?? '')) add(problem, issueOf(pr), pr.number);
  }
  return [...found.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** Zatrzymana taśma: otwarte issue z etykietą factory:stopped (komenda /stop). */
export interface StopState {
  issue: number;
  since: string;
  reason?: string;
}

const STOP_BLOCK = /<!-- factory:stop (\{.*?\}) -->/s;

export function stopState(dir: string): StopState | undefined {
  const open = read<{ number: number; body?: string; createdAt: string }[]>(join(dir, 'stopped.json'), [])[0];
  if (!open) return undefined;
  const state: StopState = { issue: open.number, since: open.createdAt };
  try {
    const reason = (JSON.parse(STOP_BLOCK.exec(open.body ?? '')?.[1] ?? '{}') as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.trim()) state.reason = reason.trim();
  } catch {
    // Bez czytelnego powodu dziennik pokazuje samo zatrzymanie.
  }
  return state;
}

export function collectIssueTasks(dir: string): IssueRecord[] {
  const withPr = new Set(factoryPrs(dir).map(issueOf));
  return taskIssues(dir)
    .filter((i) => !withPr.has(i.number))
    .sort((a, b) => b.number - a.number)
    .map((i) => {
      const record: IssueRecord = {
        issue: i.number,
        title: i.title,
        state: i.state === 'CLOSED' ? 'closed' : 'open',
        labels: (i.labels ?? []).map((l) => l.name),
        createdAt: i.createdAt,
      };
      if (i.closedAt) record.closedAt = i.closedAt;
      const ready = readyAt(dir, i.number);
      if (ready) record.readyAt = ready;
      const usage = sumUsage(issueUsage(dir, i.number));
      if (usage.length) record.usage = usage;
      return record;
    });
}

/** owners: konta, których 👍/👎 liczą się jako ocena werdyktu (właściciel repo i zaufane konta). */
export function collectRecords(dir: string, owners: readonly string[], revertDays: number): PrRecord[] {
  const reverts = existsSync(join(dir, 'reverts.txt')) ? parseReverts(readFileSync(join(dir, 'reverts.txt'), 'utf8')) : [];
  return factoryPrs(dir)
    .sort((a, b) => b.number - a.number)
    .map((pr) => {
      const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
      const sha = pr.mergeCommit?.oid;
      const merged = pr.mergedAt ? Date.parse(pr.mergedAt) : undefined;
      const reverted = Boolean(
        sha && merged && reverts.some((r) => sha.startsWith(r.sha) && Date.parse(r.at) - merged <= revertDays * DAY),
      );
      const record: PrRecord = { number: pr.number, title: pr.title, state, createdAt: pr.createdAt, rounds: rounds(pr.labels), reverted };
      const issue = issueOf(pr);
      if (issue) record.issue = issue;
      if (pr.mergedAt) record.mergedAt = pr.mergedAt;
      if (pr.closedAt) record.closedAt = pr.closedAt;
      const ready = readyAt(dir, issue);
      if (ready) record.readyAt = ready;
      const usage = usageOf(dir, pr, issue);
      if (usage.length) record.usage = usage;
      const shadow = latestShadow(dir, pr.number, owners);
      if (shadow) record.shadow = shadow;
      return record;
    });
}
