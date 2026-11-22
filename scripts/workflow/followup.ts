// Uwagi recenzentów, które zostały w PR po pętli poprawek. Medium i poważniejsze pętla odsyła do implementera,
// więc zostają zwykle low, a medium i wyżej tylko po ostatniej rundzie. Raport oceny pokazuje je właścicielowi
// i niesie w ukrytym bloku, a po merge'u skrypt zakłada z nich jedną notatkę `idea` + `follow-up` do sesji
// backlogu. Bez Claude: treść to uwagi z werdyktów recenzentów, więc trafia do komentarzy bez znaczników taśmy.

import type { Finding, Review } from '../risk/types.ts';
import { codeBlock, inert, SEVERITY } from './loop.ts';

export const FOLLOW_UP_LABEL = 'follow-up';
const BLOCK = /<!-- factory:follow-up (\[.*?\]) -->/s;

export interface FollowUp extends Finding {
  perspective: string;
}

/** Notatka po PR ma jeden znacznik z numerem PR, żeby ponowne uruchomienie nie zakładało jej drugi raz. */
export const noteMarker = (pr: number) => `<!-- factory:follow-up-note ${pr} -->`;

/** Wszystkie uwagi z werdyktów, od najpoważniejszej. */
export function remainingFindings(reviews: readonly Review[]): FollowUp[] {
  return reviews
    .flatMap((review) => review.findings.map((finding) => ({ perspective: review.perspective, ...finding })))
    .sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function where(f: Finding): string {
  if (!f.file) return '';
  return ` (\`${inert(f.file).replace(/`/g, "'")}${f.line ? `:${f.line}` : ''}\`)`;
}

/**
 * Ukryty blok z uwagami w raporcie oceny. `<` i `>` są zakodowane, więc tekst recenzenta nie zamknie komentarza HTML
 * ani nie wstawi znacznika taśmy, a JSON dalej jest poprawny.
 */
export function followUpBlock(items: readonly FollowUp[]): string {
  const data = items.map(({ perspective, severity, issue, file, line, evidence }) => ({ perspective, severity, issue, file, line, evidence }));
  return `<!-- factory:follow-up ${JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;
}

/** Sekcja raportu oceny: uwagi, które zostały w PR, i zapowiedź notatki po merge'u. */
export function followUpSection(items: readonly FollowUp[]): string[] {
  if (items.length === 0) return [];
  return [
    `**Uwagi recenzentów, które zostały (${items.length}):**`,
    ...items.map((f) => `- ${f.severity} · ${f.perspective}: ${inert(oneLine(f.issue))}${where(f)}`),
    '',
    "Po merge'u fabryka zapisze je jako notatkę z etykietami `idea` i `follow-up`.",
    followUpBlock(items),
  ];
}

const isFollowUp = (x: unknown): x is FollowUp => {
  const f = x as Partial<FollowUp> | null;
  return (
    typeof f?.perspective === 'string' &&
    typeof f.issue === 'string' &&
    (SEVERITY as readonly string[]).includes(String(f.severity)) &&
    (f.file === undefined || typeof f.file === 'string') &&
    (f.line === undefined || typeof f.line === 'number') &&
    (f.evidence === undefined || typeof f.evidence === 'string')
  );
};

/** Uwagi z ukrytego bloku raportu; zły albo brakujący blok to brak uwag. */
export function parseFollowUps(body: string): FollowUp[] {
  const match = BLOCK.exec(body);
  if (!match) return [];
  try {
    const data: unknown = JSON.parse(match[1]!);
    return Array.isArray(data) ? data.filter(isFollowUp) : [];
  } catch {
    return [];
  }
}

/** Notatka po merge'u: jedno issue na PR, z uwagami i cytatami, do sesji backlogu w spec-writerze. */
export function followUpNote(input: { pr: number; title?: string; items: readonly FollowUp[] }): { title: string; body: string } {
  const suffix = input.title ? `: ${oneLine(input.title).slice(0, 80)}` : '';
  const body = [
    noteMarker(input.pr),
    `Uwagi recenzentów, które zostały w PR #${input.pr} w chwili merge'u. Fabryka zebrała je po scaleniu.`,
    '',
    ...input.items.flatMap((f) => [
      `### ${f.severity} · ${f.perspective}`,
      '',
      `${inert(oneLine(f.issue))}${where(f)}`,
      ...(f.evidence ? ['', ...codeBlock(f.evidence)] : []),
      '',
    ]),
    '_Notatka do backlogu, nie zadanie. Gdy chcesz coś z niej zrobić, zamień ją w spec (spec-writer) i dodaj `ready`; gdy nie, zamknij issue._',
    '',
  ].join('\n');
  return { title: `Uwagi recenzentów po PR #${input.pr}${suffix}`, body };
}
