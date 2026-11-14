// Raport fabryki w PR i w checku factory/risk: poziom, reguły, bramki i skład panelu.
// Lista zamiast tabeli, bo raport czyta się na telefonie.

import type { Assessment } from '../risk/types.ts';

export const REPORT_MARKER = '<!-- factory:report -->';

export interface PanelSummary {
  run: { name: string; reason: string }[];
  skipped: { name: string; reason: string }[];
}

const GATES = { pass: 'przechodzą', warn: 'ostrzeżenia', block: 'blokują merge' } as const;

export function renderReport(assessment: Assessment, panel?: PanelSummary): string {
  const lines = [
    REPORT_MARKER,
    '## Ocena fabryki (tryb cienia)',
    '',
    `**Poziom ryzyka: ${assessment.level}**${assessment.split ? ' · za duża zmiana: wraca do planera do podziału' : ''}`,
    `**Bramki jakości:** ${GATES[assessment.gates.status]}`,
    '',
  ];
  assessment.rules.forEach((rule, index) => {
    lines.push(`${index + 1}. **${rule.name}: ${rule.level}**`);
    lines.push(...rule.reasons.map((reason) => `   - ${reason}`));
  });
  if (assessment.gates.findings.length > 0) {
    lines.push('', '**Bramki jakości:**');
    lines.push(...assessment.gates.findings.map((f) => `- ${f.status === 'block' ? 'blokada' : 'ostrzeżenie'}: \`${f.path}\` – ${f.message}`));
  }
  if (panel) {
    lines.push('', `**Panel:** ${panel.run.map((m) => m.name).join(', ')}`);
    if (panel.skipped.length > 0) lines.push(`**Pominięte:** ${panel.skipped.map((m) => `${m.name} (${m.reason})`).join(', ')}`);
  }
  lines.push('', 'Etap 0: fabryka niczego nie scala. Decyzja należy do właściciela.');
  return lines.join('\n');
}
