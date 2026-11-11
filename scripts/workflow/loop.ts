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

/**
 * Wyjście komendy w bloku kodu. Płotek jest dłuższy niż najdłuższy ciąg backticków w treści, a `<!--` traci
 * znaczenie: wyjście pisze kod z PR, więc nie może wstawić do komentarza znacznika taśmy (`<!-- factory:… -->`).
 */
export function codeBlock(text: string): string[] {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}text`, text.replace(/<!--/g, '<!- -'), fence];
}

/** Komentarz w PR z uwagami dla implementera. Czyta go też właściciel, więc jest po polsku i krótki. */
export function roundComment(input: LoopInput): string {
  const next = input.round + 1;
  const lines = [ROUND_MARKER, `## Runda poprawek ${next} z ${input.maxRounds}`, ''];
  const failed = (input.ci?.commands ?? []).filter((c) => !c.ok);
  if (input.ci?.status === 'failure') {
    const names = failed.map((c) => `\`${c.name}\``).join(', ') || 'brak wyniku komend';
    lines.push(`**CI nie przechodzi:** ${names}. Końcówka wyjścia z CI taśmy jest niżej; pełne błędy zobaczysz, uruchamiając te komendy.`, '');
    for (const c of failed.filter((c) => c.tail)) lines.push(`\`${c.name}\`:`, ...codeBlock(c.tail!), '');
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
