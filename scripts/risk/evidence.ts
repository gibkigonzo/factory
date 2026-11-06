// Schemat pliku z dowodami (evidence.json), który składają workflowy: CI, kryteria, werdykty recenzentów, ocena zachowania.

import { LEVELS } from '../config/spec.ts';
import type { Spec } from '../config/spec.ts';
import { check } from '../config/validate.ts';
import type { Issue } from '../config/validate.ts';
import type { Evidence } from './types.ts';

const text: Spec = { kind: 'string' };
const percent: Spec = { kind: 'number', min: 0, max: 100 };

const FINDING_SPEC: Spec = {
  kind: 'object',
  fields: {
    severity: { kind: 'enum', values: ['low', 'medium', 'high'] },
    file: text,
    line: { kind: 'integer', min: 1 },
    issue: text,
    evidence: text,
  },
  required: ['severity', 'issue'],
};

/** Werdykt recenzenta: perspektywa, werdykt, pewność 0–1, podsumowanie, uwagi z cytatami z diffu i sygnały ryzyka dla oceniacza. */
export const REVIEW_SPEC: Spec = {
  kind: 'object',
  fields: {
    perspective: { kind: 'string', pattern: /^[a-z][a-z0-9_-]*$/, hint: 'nazwa perspektywy, np. correctness' },
    verdict: { kind: 'enum', values: ['approve', 'request_changes'] },
    confidence: { kind: 'number', min: 0, max: 1 },
    summary: text,
    findings: { kind: 'list', item: FINDING_SPEC },
    risk_signals: { kind: 'list', item: text },
  },
  required: ['perspective', 'verdict', 'confidence', 'summary', 'findings'],
};

export const EVIDENCE_SPEC: Spec = {
  kind: 'object',
  fields: {
    ci: { kind: 'enum', values: ['success', 'failure', 'pending'] },
    acceptance: {
      kind: 'list',
      item: { kind: 'object', fields: { criterion: text, evidence: text }, required: ['criterion'] },
    },
    bugfix: { kind: 'boolean' },
    regression_test: {
      kind: 'object',
      fields: { fails_on_base: { kind: 'boolean' }, passes_on_head: { kind: 'boolean' } },
      required: ['fails_on_base', 'passes_on_head'],
    },
    reviews: { kind: 'list', item: REVIEW_SPEC },
    review_rounds: { kind: 'integer', min: 0 },
    diff_coverage: percent,
    split_impossible: { kind: 'boolean' },
    behavior: {
      kind: 'object',
      fields: { level: { kind: 'enum', values: LEVELS }, reason: text },
      required: ['level', 'reason'],
    },
  },
};

export function parseEvidence(value: unknown, file: string): { ok: true; evidence: Evidence } | { ok: false; errors: string[] } {
  const issues: Issue[] = [];
  check(value, EVIDENCE_SPEC, '', issues);
  if (issues.length > 0) {
    return { ok: false, errors: issues.map((i) => (i.path ? `${file}: ${i.path}: ${i.message}` : `${file}: ${i.message}`)) };
  }
  return { ok: true, evidence: value as Evidence };
}
