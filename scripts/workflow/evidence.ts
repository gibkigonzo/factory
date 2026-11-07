// Składa evidence.json dla reguł ryzyka z wyników poszczególnych jobów taśmy.
// Kryteria akceptacji pochodzą ze specu w issue; implementer podaje tylko dowody do nich.

import type { Evidence, Review } from '../risk/types.ts';
import { normalizeCriterion } from './spec.ts';
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

function acceptance(spec: IssueSpec, implementation?: Implementation): NonNullable<Evidence['acceptance']> {
  const proofs = new Map((implementation?.acceptance ?? []).map((a) => [normalizeCriterion(a.criterion), a.evidence]));
  return spec.acceptance.map((criterion) => {
    const evidence = proofs.get(normalizeCriterion(criterion));
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
