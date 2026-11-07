// Zbiera dane do dziennika trybu cienia z plików pobranych przez workflow (gh, git):
//   prs.json                 gh pr list --state all --json number,title,state,createdAt,mergedAt,closedAt,headRefName,isCrossRepository,labels,mergeCommit,closingIssuesReferences
//   comments/<pr>.json       komentarze PR (wystarczą te z werdyktem)
//   reactions/<comment>.json reakcje na komentarz z werdyktem
//   events/<issue>.json      zdarzenia issue (kiedy dostało etykietę ready)
//   reverts.txt              git log gałęzi głównej: rekordy „\x1e<data ISO>\t<treść commita>”

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseShadow } from './comment.ts';
import type { ShadowRecord } from './comment.ts';

export interface PrRecord {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
  readyAt?: string;
  rounds: number;
  reverted: boolean;
  shadow?: { record: ShadowRecord; at: string; reaction?: 'up' | 'down' };
}

interface RawPr {
  number: number;
  title: string;
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

function latestShadow(dir: string, pr: number, owners: readonly string[]): PrRecord['shadow'] {
  const comments = read<RawComment[]>(join(dir, 'comments', `${pr}.json`), [])
    .filter((c) => c.user?.login === 'github-actions[bot]')
    .flatMap((c) => {
      const record = parseShadow(c.body ?? '');
      return record ? [{ comment: c, record }] : [];
    });
  const last = comments[comments.length - 1];
  if (!last) return undefined;
  const reactions = read<RawReaction[]>(join(dir, 'reactions', `${last.comment.id}.json`), [])
    .filter((r) => owners.includes(r.user?.login ?? '') && (r.content === '+1' || r.content === '-1'))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const reaction = reactions[reactions.length - 1];
  const shadow: NonNullable<PrRecord['shadow']> = { record: last.record, at: last.comment.created_at };
  if (reaction) shadow.reaction = reaction.content === '+1' ? 'up' : 'down';
  return shadow;
}

function readyAt(dir: string, issue: number | undefined): string | undefined {
  if (!issue) return undefined;
  const events = read<{ event: string; label?: { name: string }; created_at: string }[]>(join(dir, 'events', `${issue}.json`), []);
  return events.filter((e) => e.event === 'labeled' && e.label?.name === 'ready').map((e) => e.created_at).sort()[0];
}

function rounds(labels: readonly { name: string }[] = []): number {
  const numbers = labels.map((l) => /^factory:round-(\d+)$/.exec(l.name)?.[1]).filter(Boolean).map(Number);
  return numbers.length > 0 ? Math.max(...numbers) : 0;
}

const DAY = 24 * 60 * 60 * 1000;

/** owners: konta, których 👍/👎 liczą się jako ocena werdyktu (właściciel repo i zaufane konta). */
export function collectRecords(dir: string, owners: readonly string[], revertDays: number): PrRecord[] {
  const reverts = existsSync(join(dir, 'reverts.txt')) ? parseReverts(readFileSync(join(dir, 'reverts.txt'), 'utf8')) : [];
  return read<RawPr[]>(join(dir, 'prs.json'), [])
    .filter((pr) => pr.headRefName.startsWith('factory/') && !pr.isCrossRepository)
    .sort((a, b) => b.number - a.number)
    .map((pr) => {
      const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
      const sha = pr.mergeCommit?.oid;
      const merged = pr.mergedAt ? Date.parse(pr.mergedAt) : undefined;
      const reverted = Boolean(
        sha && merged && reverts.some((r) => sha.startsWith(r.sha) && Date.parse(r.at) - merged <= revertDays * DAY),
      );
      const record: PrRecord = { number: pr.number, title: pr.title, state, createdAt: pr.createdAt, rounds: rounds(pr.labels), reverted };
      if (pr.mergedAt) record.mergedAt = pr.mergedAt;
      if (pr.closedAt) record.closedAt = pr.closedAt;
      const ready = readyAt(dir, pr.closingIssuesReferences?.[0]?.number);
      if (ready) record.readyAt = ready;
      const shadow = latestShadow(dir, pr.number, owners);
      if (shadow) record.shadow = shadow;
      return record;
    });
}
