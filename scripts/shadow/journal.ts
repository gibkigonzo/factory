// Dziennik trybu cienia: treść przypiętego issue „Tryb cienia”. Lista zamiast tabel, bo czyta się go na telefonie.

import type { FactoryConfig } from '../config/spec.ts';
import type { PrRecord } from './collect.ts';
import { ACTION_SHORT } from './decision.ts';
import { computeMetrics, isFalseLow, MIN_GROUP, percent } from './metrics.ts';
import type { Group } from './metrics.ts';

const decimal = (value: number) => value.toFixed(1).replace('.', ',');
const usd = (value: number) => `${value.toFixed(2).replace('.', ',')} USD`;
const tokens = (value: number) => Math.round(value).toLocaleString('pl-PL');
const STAGE_NAMES: Record<string, string> = { plan: 'plan', implement: 'implementacja', review: 'recenzja', assess: 'ocena ryzyka' };
const STATE = { open: 'otwarty', merged: 'scalony', closed: "zamknięty bez merge'u" } as const;

function groupLine(label: string, group: Group): string {
  return `${label}: ${group.count} PR, przyjętych ${percent(group.accepted)}`;
}

function prLine(record: PrRecord): string {
  const parts = [`#${record.number} ${record.title}`];
  if (record.shadow) {
    const { level, action } = record.shadow.record;
    const reaction = record.shadow.reaction === 'up' ? '👍' : record.shadow.reaction === 'down' ? '👎' : 'bez oceny';
    parts.push(`${level}, ${ACTION_SHORT[action]}`, reaction);
  } else {
    parts.push('bez werdyktu');
  }
  parts.push(STATE[record.state] + (record.reverted ? ', cofnięty' : ''));
  if (record.usage?.length) parts.push(usd(record.usage.reduce((sum, u) => sum + u.cost, 0)));
  if (isFalseLow(record)) parts.push('**fałszywe Low**');
  return `- ${parts.join(' · ')}`;
}

export function renderJournal(records: readonly PrRecord[], config: FactoryConfig, updated: string): string {
  const m = computeMetrics(records, config);
  const gate = m.gate.passed
    ? '**Bramka 1: przechodzi.** Można przejść do Etapu 1, decyzja należy do Ciebie.'
    : `**Bramka 1: jeszcze nie.** ${m.gate.missing.join('; ')}.`;
  const { above, below, threshold, enoughData } = m.calibration;
  const t = String(threshold).replace('.', ',');
  const lines = [
    gate,
    '',
    '## Metryki',
    '',
    `- PR z werdyktem fabryki: ${m.withVerdict}, z Twoją oceną: ${m.evaluated}`,
    `- Zgodność: ${percent(m.agreement)}${m.evaluated ? ` (${m.agreed} z ${m.evaluated})` : ''}`,
    `- Fałszywe Low: ${m.falseLow.length}${m.falseLow.length ? ` (${m.falseLow.map((n) => `#${n}`).join(', ')})` : ''}`,
    `- Średnio rund poprawek: ${m.avgRounds === undefined ? 'brak danych' : decimal(m.avgRounds)}`,
    `- Mediana czasu od \`ready\` do merge'u: ${m.medianHoursToMerge === undefined ? 'brak danych' : `${decimal(m.medianHoursToMerge)} h`}`,
    '',
    `**Próg pewności recenzentów (${t})**, zakończone PR-y według najniższej pewności w panelu:`,
    `- ${groupLine(`pewność ≥ ${t}`, above)}`,
    `- ${groupLine(`pewność < ${t}`, below)}`,
    enoughData
      ? '- Jeśli odsetek przyjętych jest w obu grupach podobny, pewność nie przewiduje Twoich decyzji. Wtedy próg warto zastąpić zgodnością recenzentów i cytatami, które da się sprawdzić.'
      : `- Za mało danych, żeby ocenić próg: potrzeba co najmniej ${MIN_GROUP} zakończonych PR w każdej grupie.`,
    '',
    '## Koszt',
    '',
    'Równowartość cen API. Przy subskrypcji pokazuje, ile taśma waży w limitach.',
    '',
    ...(m.cost
      ? [
          `- PR z pomiarem: ${m.cost.prs}, średnio ${usd(m.cost.perPr)} i ${tokens(m.cost.outputPerPr)} tokenów wyjścia na PR`,
          `- Etapy, średnio na PR: ${m.cost.stages.map((s) => `${STAGE_NAMES[s.stage]} ${usd(s.perPr)}`).join(' · ')}`,
          ...(m.cost.reviewers.length
            ? [`- Recenzenci, średnio na PR: ${m.cost.reviewers.map((r) => `${r.name} ${usd(r.perPr)}`).join(' · ')}`]
            : []),
          ...(m.cost.output
            ? [`- Wyjście (znaki): rozumowanie ${percent(m.cost.output.thinking)} · tekst ${percent(m.cost.output.text)} · narzędzia, w tym kod ${percent(m.cost.output.tools)}`]
            : []),
        ]
      : ['- Brak pomiarów: zużycie zapisują etapy uruchomione po włączeniu pomiaru.']),
    '',
    '## PR-y fabryki',
    '',
    ...(records.length ? records.map(prLine) : ['- Jeszcze żadnego.']),
    '',
    `Progi Bramki 1: ${config.shadow.gate_prs} ocenionych PR, zgodność co najmniej ${percent(config.shadow.min_agreement)}, fałszywych Low najwyżej ${config.shadow.max_false_low}. Fałszywe Low to werdykt „scaliłaby”, który oceniłeś 👎, PR zamknięty bez merge'u albo merge cofnięty w ciągu ${config.shadow.revert_days} dni. Przyjęty PR to scalony i niecofnięty.`,
    '',
    `_Aktualizacja: ${updated}. Dziennik prowadzi workflow fabryki; nie edytuj go ręcznie._`,
  ];
  return lines.join('\n');
}
