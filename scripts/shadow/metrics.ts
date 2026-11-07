// Metryki trybu cienia i stan Bramki 1. Liczy je skrypt z danych z PR-ów, nie model.

import type { FactoryConfig } from '../config/spec.ts';
import { STAGES } from '../workflow/usage.ts';
import type { Stage } from '../workflow/usage.ts';
import type { PrRecord } from './collect.ts';

/** Ile ocen w grupie trzeba, żeby wnioskować o progu pewności. */
export const MIN_GROUP = 5;

/** PR-y zakończone (scalone albo zamknięte) z daną pewnością recenzentów. */
export interface Group {
  count: number;
  /** Odsetek przyjętych: scalonych i niecofniętych. */
  accepted?: number;
}

export interface Metrics {
  withVerdict: number;
  evaluated: number;
  agreed: number;
  agreement?: number;
  falseLow: number[];
  avgRounds?: number;
  medianHoursToMerge?: number;
  calibration: { threshold: number; above: Group; below: Group; enoughData: boolean };
  /** Średni koszt na PR (równowartość cen API) z PR-ów, które mają pomiar zużycia. */
  cost?: { prs: number; perPr: number; outputPerPr: number; stages: { stage: Stage; perPr: number }[] };
  gate: { passed: boolean; missing: string[] };
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : undefined);

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Fałszywe Low: fabryka scaliłaby, a właściciel się nie zgodził, odrzucił PR albo cofnął merge. */
export function isFalseLow(record: PrRecord): boolean {
  if (record.shadow?.record.action !== 'merge') return false;
  return record.shadow.reaction === 'down' || record.state === 'closed' || record.reverted;
}

function group(records: PrRecord[]): Group {
  const accepted = records.filter((r) => r.state === 'merged' && !r.reverted).length;
  const result: Group = { count: records.length };
  const value = ratio(accepted, records.length);
  if (value !== undefined) result.accepted = value;
  return result;
}

/**
 * Czy pewność recenzentów przewiduje Twoją decyzję o PR? Dzieli zakończone PR-y z werdyktem według najniższej
 * pewności w panelu i porównuje odsetek przyjętych. Reakcja 👍/👎 nie nadaje się do tego, bo werdykt już zależy od pewności.
 */
function calibration(records: readonly PrRecord[], threshold: number): Metrics['calibration'] {
  const scored = records.flatMap((r) => {
    const confidences = r.shadow?.record.reviews.map((v) => v.confidence) ?? [];
    return r.state !== 'open' && confidences.length > 0 ? [{ record: r, min: Math.min(...confidences) }] : [];
  });
  const above = group(scored.filter((s) => s.min >= threshold).map((s) => s.record));
  const below = group(scored.filter((s) => s.min < threshold).map((s) => s.record));
  return { threshold, above, below, enoughData: above.count >= MIN_GROUP && below.count >= MIN_GROUP };
}

function gate(m: Omit<Metrics, 'gate'>, config: FactoryConfig): Metrics['gate'] {
  const { gate_prs, min_agreement, max_false_low } = config.shadow;
  const missing: string[] = [];
  if (m.evaluated < gate_prs) missing.push(`brakuje ${gate_prs - m.evaluated} ocenionych PR (${m.evaluated} z ${gate_prs})`);
  // Bez ocen zgodności nie ma; tę lukę opisuje już brak ocenionych PR (gate_prs jest dodatnie).
  if (m.agreement !== undefined && m.agreement < min_agreement) {
    missing.push(`zgodność ${percent(m.agreement)}, potrzeba co najmniej ${percent(min_agreement)}`);
  }
  if (m.falseLow.length > max_false_low) missing.push(`fałszywe Low: ${m.falseLow.length} (dozwolone ${max_false_low})`);
  return { passed: missing.length === 0, missing };
}

function cost(records: readonly PrRecord[]): Metrics['cost'] {
  const measured = records.filter((r) => r.usage?.length);
  if (measured.length === 0) return undefined;
  const all = measured.flatMap((r) => r.usage!);
  const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / measured.length;
  return {
    prs: measured.length,
    perPr: avg(all.map((u) => u.cost)),
    outputPerPr: avg(all.map((u) => u.output)),
    stages: STAGES.filter((s) => all.some((u) => u.stage === s)).map((stage) => ({
      stage,
      perPr: avg(all.filter((u) => u.stage === stage).map((u) => u.cost)),
    })),
  };
}

export function percent(value: number | undefined): string {
  return value === undefined ? 'brak danych' : `${Math.round(value * 100)}%`;
}

export function computeMetrics(records: readonly PrRecord[], config: FactoryConfig): Metrics {
  const withVerdict = records.filter((r) => r.shadow);
  const evaluated = withVerdict.filter((r) => r.shadow?.reaction);
  const agreed = evaluated.filter((r) => r.shadow?.reaction === 'up').length;
  const finished = records.filter((r) => r.state !== 'open');
  const hours = records
    .filter((r) => r.mergedAt && r.readyAt)
    .map((r) => (Date.parse(r.mergedAt!) - Date.parse(r.readyAt!)) / 3_600_000);
  const base: Omit<Metrics, 'gate'> = {
    withVerdict: withVerdict.length,
    evaluated: evaluated.length,
    agreed,
    falseLow: records.filter(isFalseLow).map((r) => r.number),
    calibration: calibration(withVerdict, config.risk.min_confidence),
  };
  const costs = cost(records);
  if (costs) base.cost = costs;
  const agreement = ratio(agreed, evaluated.length);
  if (agreement !== undefined) base.agreement = agreement;
  const avgRounds = ratio(finished.reduce((sum, r) => sum + r.rounds, 0), finished.length);
  if (avgRounds !== undefined) base.avgRounds = avgRounds;
  const medianHours = median(hours);
  if (medianHours !== undefined) base.medianHoursToMerge = medianHours;
  return { ...base, gate: gate(base, config) };
}
