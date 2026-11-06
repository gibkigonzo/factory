// Dane pomocnicze do testów reguł ryzyka.

import { loadConfig } from '../config/load.ts';
import type { FactoryConfig } from '../config/spec.ts';
import type { ChangedFile, Evidence, RiskInput } from './types.ts';

const PROJECT = `
project: test
extends: [base, typescript, web]
commands: { test: npm test, build: npm run build }
`;

export function configWith(extra = ''): FactoryConfig {
  const result = loadConfig(`${PROJECT}${extra}`, 'factory.yml');
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.config;
}

export function changed(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  const additions = overrides.additions ?? 1;
  return {
    path,
    status: 'modified',
    binary: false,
    additions,
    deletions: 0,
    addedLines: Array.from({ length: additions }, (_, i) => `line ${i}`),
    removedLines: [],
    contextLines: [],
    ...overrides,
  };
}

/** Komplet dowodów dla Low przy danej konfiguracji. */
export function fullEvidence(config: FactoryConfig): Evidence {
  const perspectives = [...config.reviewers.perspectives, ...config.reviewers.extra];
  return {
    ci: 'success',
    acceptance: [{ criterion: 'przycisk jest niebieski', evidence: 'zrzut: button.png' }],
    reviews: perspectives.map((perspective) => ({
      perspective,
      verdict: 'approve',
      confidence: 0.9,
      summary: 'sprawdzone zmiany w komponencie i test',
      findings: [],
    })),
    behavior: { level: 'Low', reason: 'zmiana wyglądu, cofa ją jeden revert' },
  };
}

export function input(files: ChangedFile[], overrides: Partial<RiskInput> = {}): RiskInput {
  return { files, repoFiles: files.map((f) => f.path), sizes: {}, evidence: {}, lint: [], ...overrides };
}
