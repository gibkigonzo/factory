// Wspólne typy reguł ryzyka: wejście (fakty o zmianie) i wynik oceny.

import { LEVELS } from '../config/spec.ts';
import type { Gate, Level } from '../config/spec.ts';
import type { PerspectiveDef } from '../review/perspectives.ts';

export interface ChangedFile {
  path: string;
  /** Poprzednia ścieżka przy zmianie nazwy. */
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  additions: number;
  deletions: number;
  addedLines: string[];
  removedLines: string[];
  /** Niezmienione linie wokół zmian (kontekst hunków). */
  contextLines: string[];
}

/** Linie kodu bez pustych i komentarzy, przed zmianą i po niej. */
export interface FileSize {
  before?: number;
  after?: number;
}

export interface Finding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  file?: string;
  line?: number;
  issue: string;
  /** Cytat z diffu; musi w nim występować. */
  evidence?: string;
}

/** Werdykt recenzenta w stałym formacie, który czyta oceniacz ryzyka. */
export interface Review {
  perspective: string;
  verdict: 'approve' | 'request_changes';
  confidence: number;
  /** Co recenzent sprawdził i dlaczego wydał taki werdykt. */
  summary: string;
  findings: Finding[];
  risk_signals?: string[];
}

/** Dowody spoza diffu: CI, kryteria akceptacji, werdykty recenzentów, ocena zachowania. */
export interface Evidence {
  ci?: 'success' | 'failure' | 'pending';
  acceptance?: { criterion: string; evidence?: string }[];
  bugfix?: boolean;
  regression_test?: { fails_on_base: boolean; passes_on_head: boolean };
  reviews?: Review[];
  /** Liczba rund poprawek po uwagach recenzentów. */
  review_rounds?: number;
  /** Pokrycie testami zmienionych linii, w procentach. */
  diff_coverage?: number;
  /** Planer stwierdził, że zbyt dużej zmiany nie da się podzielić. */
  split_impossible?: boolean;
  /** Ryzyko produktowe ze specu; „high” wymusza High niezależnie od diffu. */
  product_risk?: 'low' | 'high';
  behavior?: { level: Level; reason: string };
}

export type LintGate = Exclude<Gate, 'file_lines'>;

export interface LintFinding {
  path: string;
  line: number;
  gate: LintGate;
  value: number;
}

export interface RiskInput {
  files: ChangedFile[];
  /** Wszystkie pliki repo po zmianie; reguła 3 szuka w nich testów. */
  repoFiles: string[];
  sizes: Record<string, FileSize>;
  evidence: Evidence;
  lint: LintFinding[];
  /** Włączone perspektywy z warunkami; bez nich wymagane są wszystkie z reviewers.perspectives i reviewers.extra. */
  perspectives?: PerspectiveDef[];
}

export type RuleId = 'zones' | 'behavior' | 'tests' | 'size' | 'evidence';

export interface RuleResult {
  rule: RuleId;
  name: string;
  level: Level;
  reasons: string[];
}

export interface GateFinding {
  path: string;
  gate: Gate;
  status: 'warn' | 'block';
  message: string;
}

export interface Assessment {
  level: Level;
  /** Zmiana za duża nawet na Medium: wraca do planera do podziału. */
  split: boolean;
  rules: RuleResult[];
  notes: string[];
  gates: { status: 'pass' | 'warn' | 'block'; findings: GateFinding[] };
}

export function rank(level: Level): number {
  return LEVELS.indexOf(level);
}

export function maxLevel(levels: readonly Level[]): Level {
  return levels.reduce<Level>((max, level) => (rank(level) > rank(max) ? level : max), 'Low');
}

export function raise(level: Level): Level {
  return LEVELS[Math.min(rank(level) + 1, LEVELS.length - 1)]!;
}
