// Pętla poprawek po recenzji: czerwone CI albo `request_changes` recenzenta odsyła PR do implementera
// z listą uwag, aż do `risk.max_review_rounds` rund. Ocena ryzyka i werdykt powstają dopiero po pętli,
// a uwagi nierozstrzygnięte po ostatniej rundzie dają High (reguła 5).

import type { Review } from '../risk/types.ts';
import type { CiResult } from './evidence.ts';

export const ROUND_MARKER = '<!-- factory:round -->';

export interface LoopInput {
  ci?: CiResult;
  reviews: readonly Review[];
  /** Ile rund poprawek już było (etykiety factory:round-N); pierwsza implementacja to runda 0. */
  round: number;
  maxRounds: number;
}

export type LoopDecision = { retry: false; reason: string } | { retry: true; reason: string };

export function nextRound(input: LoopInput): LoopDecision {
  const failed = input.ci?.status === 'failure';
  const asking = input.reviews.filter((r) => r.verdict === 'request_changes').map((r) => r.perspective);
  if (!failed && asking.length === 0) return { retry: false, reason: 'CI przechodzi i nikt nie prosi o zmiany' };
  const why = [failed ? 'CI nie przechodzi' : '', asking.length ? `zmian chcą: ${asking.join(', ')}` : ''].filter(Boolean).join('; ');
  if (input.round >= input.maxRounds) return { retry: false, reason: `${why}, ale to już ostatnia runda (${input.maxRounds})` };
  return { retry: true, reason: why };
}

const SEVERITY = ['critical', 'high', 'medium', 'low'];

/** Komentarz w PR z uwagami dla implementera. Czyta go też właściciel, więc jest po polsku i krótki. */
export function roundComment(input: LoopInput): string {
  const next = input.round + 1;
  const lines = [ROUND_MARKER, `## Runda poprawek ${next} z ${input.maxRounds}`, ''];
  const failing = (input.ci?.commands ?? []).filter((c) => !c.ok).map((c) => `\`${c.name}\``);
  if (input.ci?.status === 'failure') {
    lines.push(`**CI nie przechodzi:** ${failing.join(', ') || 'brak wyniku komend'}. Uruchom te komendy, żeby zobaczyć błędy.`, '');
  }
  for (const review of input.reviews.filter((r) => r.verdict === 'request_changes')) {
    lines.push(`**${review.perspective}:** ${review.summary}`);
    const findings = [...review.findings].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
    for (const f of findings) {
      const where = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : '';
      lines.push(`- ${f.severity}: ${f.issue}${where}`);
    }
    lines.push('');
  }
  lines.push('Implementer odnosi się do każdej uwagi: poprawia albo wyjaśnia w założeniach, dlaczego uwaga nie dotyczy zmiany.');
  return lines.join('\n');
}
