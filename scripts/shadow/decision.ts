// Decyzja mergera: co fabryka zrobi z PR po ocenie ryzyka. W Etapie 0 (tryb cienia) tylko ją ogłasza,
// w kolejnych etapach ten sam kod zdecyduje o merge'u. Decyduje skrypt, nie model.
// Poziomy są dwa: Low fabryka scala sama, High przekazuje właścicielowi. Okna weta nie ma (14 listopada 2026).

import type { Assessment } from '../risk/types.ts';

export const ACTIONS = ['merge', 'escalate', 'split', 'fix-gates'] as const;
export type Action = (typeof ACTIONS)[number];

export function decide(assessment: Assessment): Action {
  if (assessment.split) return 'split';
  if (assessment.gates.status === 'block') return 'fix-gates';
  return assessment.level === 'Low' ? 'merge' : 'escalate';
}

export function describeAction(action: Action): string {
  switch (action) {
    case 'merge':
      return 'scaliłaby ten PR od razu';
    case 'escalate':
      return 'przekazałaby decyzję Tobie';
    case 'split':
      return 'odesłałaby zmianę do planera do podziału na mniejsze issue';
    case 'fix-gates':
      return 'najpierw poprawiłaby kod, bo bramki jakości blokują merge';
  }
}

/** Krótka forma do dziennika. */
export const ACTION_SHORT: Record<Action, string> = {
  merge: 'scaliłaby',
  escalate: 'do Ciebie',
  split: 'do podziału',
  'fix-gates': 'poprawki bramek',
};
