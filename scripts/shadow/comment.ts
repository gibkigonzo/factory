// Komentarz z werdyktem fabryki w trybie cienia. Właściciel reaguje na niego 👍 albo 👎.
// Każda ocena (także po poprawkach) dostaje nowy komentarz, żeby reakcja dotyczyła konkretnego werdyktu.
// Dane dla dziennika są w niewidocznym komentarzu HTML w tym samym komentarzu.

import type { Level } from '../config/spec.ts';
import { LEVELS } from '../config/spec.ts';
import type { Assessment, Evidence } from '../risk/types.ts';
import { parseUsageList } from '../workflow/usage.ts';
import type { Usage } from '../workflow/usage.ts';
import { ACTIONS, decide, describeAction } from './decision.ts';
import type { Action } from './decision.ts';

export const SHADOW_MARKER = '<!-- factory:shadow -->';
const DATA = /<!-- factory:shadow-data (\{.*?\}) -->/s;

export interface ShadowRecord {
  pr: number;
  round: number;
  level: Level;
  action: Action;
  reviews: { perspective: string; verdict: string; confidence: number }[];
  /** Zużycie tej rundy oceny: recenzenci i oceniacz ryzyka. */
  usage?: Usage[];
  /** Werdykt sprzed dwóch poziomów (Medium, okno weta), przeliczony jako eskalacja do właściciela. */
  recalculated?: 'Medium';
}

export function shadowRecord(pr: number, assessment: Assessment, evidence: Evidence, usage: readonly Usage[] = []): ShadowRecord {
  const reviews = (evidence.reviews ?? []).map((r) => ({ perspective: r.perspective, verdict: r.verdict, confidence: r.confidence }));
  const record: ShadowRecord = { pr, round: evidence.review_rounds ?? 0, level: assessment.level, action: decide(assessment), reviews };
  if (usage.length) record.usage = [...usage];
  return record;
}

export function shadowComment(record: ShadowRecord): string {
  return [
    SHADOW_MARKER,
    `## Werdykt fabryki (tryb cienia)${record.round > 0 ? ` · runda ${record.round}` : ''}`,
    '',
    `Fabryka **${describeAction(record.action)}** (poziom ${record.level}).`,
    '',
    'Zgadzasz się? Zareaguj na ten komentarz: 👍 zgoda, 👎 niezgoda. Uzasadnienie jest w raporcie oceny.',
    'W Etapie 0 fabryka niczego nie scala: o PR decydujesz Ty.',
    '',
    `<!-- factory:shadow-data ${JSON.stringify(record)} -->`,
  ].join('\n');
}

export function parseShadow(body: string): ShadowRecord | undefined {
  const match = DATA.exec(body);
  if (!body.includes(SHADOW_MARKER) || !match) return undefined;
  try {
    const record = JSON.parse(match[1]!) as ShadowRecord;
    // Dawny poziom Medium z oknem weta liczy się dziś jak High: eskalacja do właściciela.
    if ((record.level as string) === 'Medium') {
      record.level = 'High';
      record.recalculated = 'Medium';
      if ((record.action as string) === 'veto-window') record.action = 'escalate';
    }
    const valid =
      Number.isInteger(record.pr) &&
      Number.isInteger(record.round) &&
      (LEVELS as readonly string[]).includes(record.level) &&
      (ACTIONS as readonly string[]).includes(record.action) &&
      Array.isArray(record.reviews);
    if (!valid) return undefined;
    if (record.usage !== undefined) record.usage = parseUsageList(record.usage);
    return record;
  } catch {
    return undefined;
  }
}
