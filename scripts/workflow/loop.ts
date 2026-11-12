// Pętla poprawek po recenzji: czerwone CI albo `request_changes` recenzenta odsyła PR do implementera
// z listą uwag, aż do `risk.max_review_rounds` rund. Ocena ryzyka i werdykt powstają dopiero po pętli,
// a uwagi nierozstrzygnięte po ostatniej rundzie dają High (reguła 5).

import type { Review } from '../risk/types.ts';
import type { CiResult, Implementation } from './evidence.ts';
import { usageBlock } from './usage.ts';
import type { Usage } from './usage.ts';

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
  return [`${fence}text`, inert(text), fence];
}

/** Tekst spoza taśmy (wyjście komend, uwagi recenzentów) bez `<!--`, więc bez podrobionych znaczników i bloków kosztu. */
export const inert = (text: string) => text.replace(/<!--/g, '<!- -');

/**
 * Komentarz w PR z uwagami dla implementera. Czyta go też właściciel, więc jest po polsku i krótki.
 * Niesie zużycie recenzentów tej rundy: runda odesłana do implementera nie ma werdyktu, a dziennik liczy koszt z komentarzy.
 */
export function roundComment(input: LoopInput, usage: readonly Usage[] = []): string {
  const next = input.round + 1;
  const lines = [ROUND_MARKER, `## Runda poprawek ${next} z ${input.maxRounds}`, ''];
  const failed = (input.ci?.commands ?? []).filter((c) => !c.ok);
  if (input.ci?.status === 'failure') {
    const names = failed.map((c) => `\`${c.name}\``).join(', ') || 'brak wyniku komend';
    lines.push(`**CI nie przechodzi:** ${names}. Końcówka wyjścia z CI taśmy jest niżej; pełne błędy zobaczysz, uruchamiając te komendy.`, '');
    for (const c of failed.filter((c) => c.tail)) lines.push(`\`${c.name}\`:`, ...codeBlock(c.tail!), '');
  }
  for (const review of input.reviews.filter((r) => r.verdict === 'request_changes')) {
    lines.push(`**${review.perspective}:** ${inert(review.summary)}`);
    const findings = [...review.findings].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
    for (const f of findings) {
      const where = f.file ? ` (\`${inert(f.file)}${f.line ? `:${f.line}` : ''}\`)` : '';
      lines.push(`- ${f.severity}: ${inert(f.issue)}${where}`);
    }
    lines.push('');
  }
  lines.push('Implementer odnosi się do każdej uwagi: poprawia albo wyjaśnia w założeniach, dlaczego uwaga nie dotyczy zmiany.');
  if (usage.length) lines.push('', usageBlock(usage));
  return lines.join('\n');
}

/**
 * Komentarz w PR po rundzie bez zmian w plikach. Wyjaśnienie implementera stoi w wątku PR, a nie tylko w opisie,
 * żeby właściciel od razu widział, co stało się z jego `/change` (lekcja z pilota: uwaga przepadła niezauważona).
 */
export function noChangeComment(implementation: Implementation & { summary?: string }, round: number): string {
  const reasons = [implementation.summary, ...implementation.assumptions].map((r) => r?.trim()).filter((r): r is string => Boolean(r));
  return [
    `**Runda ${round} bez zmian w plikach.** Implementer nie zmienił kodu, więc recenzja ocenia tę samą zmianę jeszcze raz.`,
    '',
    'Wyjaśnienie implementera:',
    ...(reasons.length ? reasons.map((r) => `- ${inert(r)}`) : ['- (brak wyjaśnienia)']),
    '',
    'Jeśli to nie odpowiada na Twoją uwagę, napisz `/change` jeszcze raz albo zamknij PR przez `/reject`.',
  ].join('\n');
}
