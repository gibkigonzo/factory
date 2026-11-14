// Reguły ryzyka 1–4 (reguła 5 jest w evidence-rule.ts). Każda zwraca poziom i uzasadnienie; wynik zmiany to maksimum z reguł.

import type { FactoryConfig, Level } from '../config/spec.ts';
import { matchesAny } from './glob.ts';
import { maxLevel, rank, raise } from './types.ts';
import type { ChangedFile, Evidence, RuleResult } from './types.ts';

const MAX_LISTED = 10;

export interface ZoneMatch {
  zone?: string;
  level: Level;
}

/** Strefa pliku: najwyższa z pasujących; ścieżka spoza mapy dostaje poziom `risk.unassigned`. */
export function zoneOf(path: string, config: FactoryConfig): ZoneMatch {
  let best: ZoneMatch | undefined;
  for (const [zone, level] of Object.entries(config.risk.zone_levels)) {
    if (!matchesAny(path, config.zones[zone] ?? [])) continue;
    if (!best || rank(level) > rank(best.level)) best = { zone, level };
  }
  return best ?? { level: config.risk.unassigned };
}

function touchedPaths(files: readonly ChangedFile[]): string[] {
  const paths = files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
  return [...new Set(paths)].sort();
}

function listed(items: readonly string[]): string[] {
  if (items.length <= MAX_LISTED) return [...items];
  return [...items.slice(0, MAX_LISTED), `…i ${items.length - MAX_LISTED} więcej`];
}

/** Strefa dla reguły 1: plik testów spoza mapy stref liczy się jak `code`, bo ryzyko samych testów
 * (usunięcie, ubytek asercji) sprawdza reguła 5. Inna ścieżka spoza mapy dostaje `risk.unassigned`. */
function ruleZone(path: string, config: FactoryConfig): ZoneMatch {
  const match = zoneOf(path, config);
  if (match.zone || !matchesAny(path, config.files.tests) || !config.risk.zone_levels.code) return match;
  return { zone: 'code', level: config.risk.zone_levels.code };
}

/** Reguła 1: strefy. Przy zmianie nazwy liczy się stara i nowa ścieżka. */
export function zonesRule(files: readonly ChangedFile[], config: FactoryConfig): RuleResult {
  const matches = touchedPaths(files).map((path) => ({ path, ...ruleZone(path, config) }));
  const level = maxLevel(matches.map((m) => m.level));
  const top = matches.filter((m) => m.level === level).map((m) => `${m.path}: ${m.zone ? `strefa ${m.zone}` : 'poza mapą stref'}`);
  const reasons = matches.length === 0 ? ['brak zmienionych plików'] : listed(top);
  return { rule: 'zones', name: 'Strefy', level, reasons };
}

/** Reguła 2: zachowanie i odwracalność. Ocenia LLM (oceniacz ryzyka); brak oceny nie pozwala na Low.
 * Wysokie ryzyko produktowe ze specu daje High bez względu na ocenę. */
export function behaviorRule(evidence: Evidence): RuleResult {
  const name = 'Zachowanie i odwracalność';
  const assessed: RuleResult = evidence.behavior
    ? { rule: 'behavior', name, level: evidence.behavior.level, reasons: [evidence.behavior.reason] }
    : { rule: 'behavior', name, level: 'High', reasons: ['brak oceny oceniacza ryzyka'] };
  if (evidence.product_risk !== 'high') return assessed;
  return { ...assessed, level: 'High', reasons: ['ryzyko produktowe w specu: wysokie', ...assessed.reasons] };
}

/** Reguła 3: kod w strefie bez testów nie może mieć Low (o poziom wyżej, czyli High). Testy strefy to pliki testów
 * pasujące do jej wzorców albo do wzorców tej strefy w zone_tests. */
export function testsRule(files: readonly ChangedFile[], repoFiles: readonly string[], config: FactoryConfig): RuleResult {
  const name = 'Brak testów';
  const testFiles = repoFiles.filter((f) => matchesAny(f, config.files.tests));
  const untested = new Map<string, string[]>();
  for (const path of touchedPaths(files)) {
    if (!matchesAny(path, config.files.source) || matchesAny(path, config.files.tests)) continue;
    const { zone } = zoneOf(path, config);
    if (!zone) continue;
    const covering = [...(config.zones[zone] ?? []), ...(config.zone_tests[zone] ?? [])];
    if (testFiles.some((t) => matchesAny(t, covering))) continue;
    untested.set(zone, [...(untested.get(zone) ?? []), path]);
  }
  if (untested.size === 0) return { rule: 'tests', name, level: 'Low', reasons: ['zmieniony kod jest w strefach z testami'] };
  const raised = [...untested.keys()].map((zone) => raise(config.risk.zone_levels[zone]!));
  const reasons = [...untested].map(([zone, paths]) => `strefa ${zone} nie ma testów, więc nie ma Low: ${listed(paths).join(', ')}`);
  return { rule: 'tests', name, level: maxLevel(raised), reasons };
}

export function excludedFromSize(path: string, config: FactoryConfig): boolean {
  const { tests, lockfiles, generated, translations } = config.files;
  return matchesAny(path, [...tests, ...lockfiles, ...generated, ...translations]);
}

/** Reguła 4: rozmiar kodu produkcyjnego. Ponad próg Low zmiana ma High. Ponad próg podziału dostaje też znacznik
 * podziału: wraca do planera, a do właściciela trafia dopiero, gdy podziału nie da się zrobić. */
export function sizeRule(
  files: readonly ChangedFile[],
  config: FactoryConfig,
  evidence: Evidence = {},
): RuleResult & { split: boolean } {
  const counted = files.filter((f) => !excludedFromSize(f.path, config));
  const lines = counted.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const { low, split } = config.risk.size;
  const fits = (limit: { lines: number; files: number }) => lines <= limit.lines && counted.length <= limit.files;
  const tooBig = !fits(split);
  const level: Level = fits(low) ? 'Low' : 'High';
  const reasons = [
    `kod produkcyjny: zmienionych linii: ${lines}, plików: ${counted.length}`,
    `progi: Low do ${low.lines} linii i ${low.files} plików, podział powyżej ${split.lines} linii albo ${split.files} plików`,
  ];
  const skipped = files.length - counted.length;
  if (skipped > 0) reasons.push(`pominięte pliki (testy, lockfile, generowane, tłumaczenia): ${skipped}`);
  if (tooBig && evidence.split_impossible) reasons.push('za duża zmiana, a planer stwierdził, że podziału nie da się zrobić: decyduje właściciel');
  else if (tooBig) reasons.push('za duża zmiana: wraca do planera do podziału, do właściciela trafia dopiero, gdy podział jest niemożliwy');
  return { rule: 'size', name: 'Rozmiar', level, reasons, split: tooBig && !evidence.split_impossible };
}
