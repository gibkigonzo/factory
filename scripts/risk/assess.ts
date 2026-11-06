// Ocena ryzyka zmiany: maksimum z pięciu reguł plus bramki jakości. Ten sam wejściowy diff daje zawsze ten sam wynik.

import type { FactoryConfig } from '../config/spec.ts';
import { checkGates } from './gates.ts';
import { evidenceRule } from './evidence-rule.ts';
import { behaviorRule, sizeRule, testsRule, zonesRule } from './rules.ts';
import { maxLevel } from './types.ts';
import type { Assessment, RiskInput } from './types.ts';

export function assess(input: RiskInput, config: FactoryConfig): Assessment {
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const repoFiles = [...input.repoFiles].sort();
  const size = sizeRule(files, config, input.evidence);
  const rules = [
    zonesRule(files, config),
    behaviorRule(input.evidence),
    testsRule(files, repoFiles, config),
    { rule: size.rule, name: size.name, level: size.level, reasons: size.reasons },
    evidenceRule(files, input.evidence, config),
  ];
  let level = maxLevel(rules.map((r) => r.level));
  const notes: string[] = [];
  if (level === 'Medium' && config.risk.medium_veto_hours === 0) {
    level = 'High';
    notes.push('medium_veto_hours: 0, więc Medium liczy się jak High');
  }
  return { level, split: size.split, rules, notes, gates: checkGates(files, input.sizes, input.lint, config) };
}

const GATE_STATUS = { pass: 'przechodzą', warn: 'ostrzeżenia', block: 'blokują merge' } as const;

/** Czytelne podsumowanie oceny, np. do komentarza w PR. */
export function formatAssessment(assessment: Assessment): string {
  const lines = [`Poziom ryzyka: ${assessment.level}${assessment.split ? ' (za duża zmiana: wraca do planera do podziału)' : ''}`, ''];
  assessment.rules.forEach((rule, index) => {
    lines.push(`${index + 1}. ${rule.name}: ${rule.level}`);
    lines.push(...rule.reasons.map((reason) => `   - ${reason}`));
  });
  lines.push(...assessment.notes.map((note) => `Uwaga: ${note}`));
  lines.push('', `Bramki jakości: ${GATE_STATUS[assessment.gates.status]}`);
  lines.push(...assessment.gates.findings.map((f) => `   - ${f.status === 'block' ? 'blokada' : 'ostrzeżenie'}: ${f.path}: ${f.message}`));
  return lines.join('\n');
}
