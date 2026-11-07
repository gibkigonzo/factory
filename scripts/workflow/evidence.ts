// Składa evidence.json dla reguł ryzyka z wyników poszczególnych jobów taśmy.
// Kryteria akceptacji pochodzą ze specu w issue; implementer podaje tylko dowody do nich.

import type { Evidence, Review } from '../risk/types.ts';
import { looseCriterion, normalizeCriterion } from './spec.ts';
import type { IssueSpec } from './spec.ts';

export interface CiResult {
  status: 'success' | 'failure';
  commands: { name: string; ok: boolean; seconds: number }[];
}

export interface Implementation {
  issue: number;
  bugfix: boolean;
  regression_test?: string;
  acceptance: { criterion: string; evidence: string }[];
  assumptions: string[];
}

export interface EvidenceInputs {
  spec: IssueSpec;
  ci?: CiResult;
  implementation?: Implementation;
  reviews: Review[];
  behavior?: Evidence['behavior'];
  rounds: number;
}

/** Mapa klucz → element tylko dla kluczy, które występują raz. Dwuznaczny klucz niczego nie dopasowuje. */
function unique<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return new Map(items.filter((item) => counts.get(key(item)) === 1).map((item) => [key(item), item]));
}

function acceptance(spec: IssueSpec, implementation?: Implementation): NonNullable<Evidence['acceptance']> {
  const proofs = implementation?.acceptance ?? [];
  const exact = new Map(proofs.map((a) => [normalizeCriterion(a.criterion), a.evidence]));
  // Bez końcowego dopisku w nawiasie, np. „(test)”, ale tylko gdy dopasowanie jest jednoznaczne po obu stronach:
  // „przycisk (desktop)” i „przycisk (mobile)” nadal wymagają osobnych dowodów.
  const loose = unique(proofs, (a) => looseCriterion(a.criterion));
  const specLoose = unique(spec.acceptance, looseCriterion);
  return spec.acceptance.map((criterion) => {
    const key = looseCriterion(criterion);
    const evidence = exact.get(normalizeCriterion(criterion)) ?? (specLoose.has(key) ? loose.get(key)?.evidence : undefined);
    return evidence ? { criterion, evidence } : { criterion };
  });
}

export function buildEvidence(inputs: EvidenceInputs): Evidence {
  const evidence: Evidence = {
    acceptance: acceptance(inputs.spec, inputs.implementation),
    reviews: [...inputs.reviews].sort((a, b) => a.perspective.localeCompare(b.perspective)),
    review_rounds: inputs.rounds,
  };
  if (inputs.ci) evidence.ci = inputs.ci.status;
  if (inputs.implementation?.bugfix) evidence.bugfix = true;
  if (inputs.spec.productRisk) evidence.product_risk = inputs.spec.productRisk;
  if (inputs.behavior) evidence.behavior = inputs.behavior;
  return evidence;
}
