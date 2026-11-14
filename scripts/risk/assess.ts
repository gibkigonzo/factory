// Ocena ryzyka zmiany: maksimum z pięciu reguł plus bramki jakości. Ten sam wejściowy diff daje zawsze ten sam wynik.
// Poziomy są dwa: Low fabryka scala sama, High idzie do właściciela.

import type { FactoryConfig } from '../config/spec.ts';
import { checkGates } from './gates.ts';
import { panelFor } from '../review/perspectives.ts';
import { evidenceRule } from './evidence-rule.ts';
import { behaviorRule, sizeRule, testsRule, zonesRule } from './rules.ts';
import { maxLevel } from './types.ts';
import type { Assessment, RiskInput } from './types.ts';

export function assess(input: RiskInput, config: FactoryConfig): Assessment {
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const repoFiles = [...input.repoFiles].sort();
  const size = sizeRule(files, config, input.evidence);
  // Werdykt jest wymagany tylko od perspektyw, które powinny były ocenić tę zmianę.
  const required = input.perspectives ? panelFor(input.perspectives, files, config).run.map((e) => e.def.name) : undefined;
  const rules = [
    zonesRule(files, config),
    behaviorRule(input.evidence),
    testsRule(files, repoFiles, config),
    { rule: size.rule, name: size.name, level: size.level, reasons: size.reasons },
    evidenceRule(files, input.evidence, config, required),
  ];
  return { level: maxLevel(rules.map((r) => r.level)), split: size.split, rules, gates: checkGates(files, input.sizes, input.lint, config) };
}

const GATE_STATUS = { pass: 'przechodzą', warn: 'ostrzeżenia', block: 'blokują merge' } as const;

/** Czytelne podsumowanie oceny, np. do komentarza w PR. */
export function formatAssessment(assessment: Assessment): string {
  const lines = [`Poziom ryzyka: ${assessment.level}${assessment.split ? ' (za duża zmiana: wraca do planera do podziału)' : ''}`, ''];
  assessment.rules.forEach((rule, index) => {
    lines.push(`${index + 1}. ${rule.name}: ${rule.level}`);
    lines.push(...rule.reasons.map((reason) => `   - ${reason}`));
  });
  lines.push('', `Bramki jakości: ${GATE_STATUS[assessment.gates.status]}`);
  lines.push(...assessment.gates.findings.map((f) => `   - ${f.status === 'block' ? 'blokada' : 'ostrzeżenie'}: ${f.path}: ${f.message}`));
  return lines.join('\n');
}
