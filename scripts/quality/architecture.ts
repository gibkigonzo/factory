// Okresowy przegląd architektury: kiedy go uruchomić i jak z wyjścia agenta zrobić propozycje refaktoru.
// Decyduje skrypt: agent tylko proponuje, a issue zakłada job bez Claude, z limitem i bez powtórzeń.

import type { Usage } from '../workflow/usage.ts';
import { usageBlock } from '../workflow/usage.ts';

export const ARCHITECTURE_LABEL = 'factory:architecture';
export const REFACTOR_LABEL = 'refactor';
export const REFACTOR_MARKER = '<!-- factory:refactor -->';
export const ARCHITECTURE_MARKER = '<!-- factory:architecture -->';

export interface Proposal {
  title: string;
  problem: string;
  proposal: string;
  places: string[];
  size: { lines: number; files: number };
}

export interface ArchitectureOutput {
  summary: string;
  proposals: Proposal[];
  line_problem?: string;
}

/** Przegląd po każdych `every` scalonych PR fabryki. */
export function isDue(merged: number, every: number): boolean {
  return merged > 0 && merged % every === 0;
}

const normalize = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Propozycje do założenia: bez tych, które już są otwarte (ten sam tytuł), najwyżej `max`. */
export function newProposals(output: ArchitectureOutput, openTitles: readonly string[], max: number): Proposal[] {
  const open = new Set(openTitles.map(normalize));
  const seen = new Set<string>();
  return output.proposals
    .filter((p) => {
      const key = normalize(p.title);
      if (!key || open.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

export function proposalBody(p: Proposal): string {
  return [
    REFACTOR_MARKER,
    '## Co się powtarza',
    '',
    p.problem,
    '',
    '## Propozycja',
    '',
    p.proposal,
    '',
    '## Miejsca',
    '',
    ...p.places.map((place) => `- \`${place.replace(/`/g, "'")}\``),
    '',
    `Szacowany rozmiar: około ${p.size.lines} linii w ${p.size.files} plikach.`,
    '',
    '_Propozycja przeglądu architektury fabryki: notatka do backlogu, nie zadanie. Gdy chcesz ją zrobić, zamień ją w spec (spec-writer) i dodaj `ready`; gdy nie, zamknij issue._',
    '',
  ].join('\n');
}

/** Komentarz w issue „Przegląd architektury”: co powstało w tym przeglądzie i jego koszt dla dziennika. */
export function runComment(input: { merged: number; summary: string; created: { number: number; title: string }[]; usage: readonly Usage[] }): string {
  const created = input.created.length
    ? ['Nowe propozycje refaktoru (notatki z etykietą `idea`):', '', ...input.created.map((c) => `- #${c.number} ${c.title}`)]
    : ['Brak nowych propozycji refaktoru.'];
  return [
    ARCHITECTURE_MARKER,
    `**Przegląd architektury** po ${input.merged} scalonych PR fabryki.`,
    '',
    input.summary,
    '',
    ...created,
    '',
    ...(input.usage.length ? [usageBlock(input.usage)] : []),
    '',
  ].join('\n');
}

export const TRACKING_TITLE = 'Przegląd architektury';

export const TRACKING_BODY = [
  ARCHITECTURE_MARKER,
  'Tu taśma zapisuje okresowe przeglądy architektury: co kilka scalonych PR fabryki agent czyta całe repo, raport powtórzeń i konwencje projektu (`CLAUDE.md`) i proponuje refaktor jako notatki z etykietami `idea` i `refactor`.',
  '',
  'Propozycje nie blokują PR. Wybierasz, które zamienić w spec; resztę zamykasz. Komentarze niżej mówią, co powstało w każdym przeglądzie i ile kosztował.',
  '',
].join('\n');
