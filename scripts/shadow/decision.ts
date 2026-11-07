// Decyzja mergera: co fabryka zrobi z PR po ocenie ryzyka. W Etapie 0 (tryb cienia) tylko ją ogłasza,
// w Etapie 1 ten sam kod zdecyduje o merge'u. Decyduje skrypt, nie model.

import type { FactoryConfig } from '../config/spec.ts';
import type { Assessment } from '../risk/types.ts';

export const ACTIONS = ['merge', 'veto-window', 'escalate', 'split', 'fix-gates'] as const;
export type Action = (typeof ACTIONS)[number];

export function decide(assessment: Assessment): Action {
  if (assessment.split) return 'split';
  if (assessment.gates.status === 'block') return 'fix-gates';
  if (assessment.level === 'Low') return 'merge';
  return assessment.level === 'Medium' ? 'veto-window' : 'escalate';
}

export function describeAction(action: Action, config: FactoryConfig): string {
  switch (action) {
    case 'merge':
      return 'scaliłaby ten PR od razu';
    case 'veto-window':
      return `czekałaby ${config.risk.medium_veto_hours} h na /veto, a potem scaliłaby ten PR`;
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
  'veto-window': 'okno weta',
  escalate: 'do Ciebie',
  split: 'do podziału',
  'fix-gates': 'poprawki bramek',
};
