// Reguła 5: dowody. Low wymaga kompletu dowodów; braki dają Medium. Nierozstrzygnięta uwaga high lub critical,
// osłabienie testów (usunięty plik testów przy zachowanym kodzie, ubytek asercji), niskie pokrycie zmienionych
// linii i uwagi nierozstrzygnięte po limicie rund poprawek dają High.

import type { FactoryConfig, Level } from '../config/spec.ts';
import { matchesAny } from './glob.ts';
import type { ChangedFile, Evidence, Finding, Review, RuleResult } from './types.ts';

export function evidenceRule(
  files: readonly ChangedFile[],
  evidence: Evidence,
  config: FactoryConfig,
  required?: readonly string[],
): RuleResult {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const tests = testProblems(sorted, config);
  const high = [
    ...seriousFindings(evidence),
    ...tests.high,
    ...coverageProblems(evidence, config),
    ...unresolved(evidence, config),
  ];
  const medium = [
    ...ciProblems(evidence),
    ...acceptanceProblems(evidence),
    ...regressionProblems(evidence),
    ...reviewProblems(evidence, config, required),
    ...citationProblems(sorted, evidence),
    ...tests.medium,
    ...newMarkers(sorted, config),
  ];
  const level: Level = high.length > 0 ? 'High' : medium.length > 0 ? 'Medium' : 'Low';
  const reasons = [...high.map((p) => `High: ${p}`), ...medium];
  return { rule: 'evidence', name: 'Dowody', level, reasons: reasons.length > 0 ? reasons : ['komplet dowodów dla Low'] };
}

function ciProblems(evidence: Evidence): string[] {
  return evidence.ci === 'success' ? [] : [`CI: ${evidence.ci ?? 'brak wyniku'}`];
}

function acceptanceProblems(evidence: Evidence): string[] {
  const criteria = evidence.acceptance ?? [];
  if (criteria.length === 0) return ['brak kryteriów akceptacji'];
  return criteria.filter((c) => !c.evidence?.trim()).map((c) => `kryterium bez dowodu: „${c.criterion}”`);
}

function regressionProblems(evidence: Evidence): string[] {
  if (!evidence.bugfix) return [];
  const test = evidence.regression_test;
  if (test?.fails_on_base && test.passes_on_head) return [];
  return ['poprawka błędu bez testu, który nie przechodzi przed zmianą, a przechodzi po niej'];
}

const SERIOUS: readonly Finding['severity'][] = ['high', 'critical'];

/** `approve` z uwagą o wadze high lub critical jest sprzeczny, więc liczy się jak `request_changes`. */
export function effectiveVerdict(review: Review): Review['verdict'] {
  return review.findings.some((f) => SERIOUS.includes(f.severity)) ? 'request_changes' : review.verdict;
}

/** Recenzenci, którzy się różnią, albo pewność poniżej progu dają Medium. */
function reviewProblems(evidence: Evidence, config: FactoryConfig, required?: readonly string[]): string[] {
  const perspectives = [...new Set(required ?? [...config.reviewers.perspectives, ...config.reviewers.extra])];
  const minimum = config.risk.min_confidence;
  return perspectives.flatMap((perspective) => {
    const review = evidence.reviews?.find((r) => r.perspective === perspective);
    if (!review) return [`brak werdyktu recenzenta: ${perspective}`];
    const verdict = effectiveVerdict(review);
    if (verdict !== review.verdict) return [`recenzent ${perspective}: approve z uwagą high lub critical liczy się jak request_changes`];
    if (verdict !== 'approve') return [`recenzent ${perspective}: ${verdict}`];
    if (review.confidence < minimum) return [`recenzent ${perspective}: pewność ${review.confidence} poniżej ${minimum}`];
    return [];
  });
}

/** Cytat w uwadze recenzenta musi występować w diffie (w zmienionych liniach albo ich kontekście). */
function citationProblems(files: readonly ChangedFile[], evidence: Evidence): string[] {
  return (evidence.reviews ?? []).flatMap((review) =>
    review.findings
      .filter((finding) => !citationFound(finding, files))
      .map((finding) => `recenzent ${review.perspective}: cytat nie występuje w diffie (${where(finding)})`),
  );
}

function citationFound(finding: Finding, files: readonly ChangedFile[]): boolean {
  const quoted = (finding.evidence ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (quoted.length === 0) return true;
  const scope = finding.file ? files.filter((f) => f.path === finding.file || f.oldPath === finding.file) : files;
  const text = scope.flatMap((f) => [...f.addedLines, ...f.removedLines, ...f.contextLines]).map((l) => l.trim()).join('\n');
  return quoted.every((line) => text.includes(line));
}

function where(finding: Finding): string {
  if (!finding.file) return finding.issue;
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

/** Nierozstrzygnięta uwaga o wadze high lub critical daje High. */
function seriousFindings(evidence: Evidence): string[] {
  return (evidence.reviews ?? []).flatMap((review) =>
    review.findings
      .filter((finding) => SERIOUS.includes(finding.severity))
      .map((finding) => `nierozstrzygnięta uwaga ${finding.severity} recenzenta ${review.perspective}: ${finding.issue} (${where(finding)})`),
  );
}

function unresolved(evidence: Evidence, config: FactoryConfig): string[] {
  const rounds = evidence.review_rounds ?? 0;
  const open = (evidence.reviews ?? []).filter((r) => effectiveVerdict(r) !== 'approve').map((r) => r.perspective);
  if (rounds < config.risk.max_review_rounds || open.length === 0) return [];
  return [`uwagi nierozstrzygnięte po ${rounds} rundach poprawek (${[...open].sort().join(', ')})`];
}

/** Pokrycie zmienionych linii; warunek działa dopiero, gdy CI je liczy. */
function coverageProblems(evidence: Evidence, config: FactoryConfig): string[] {
  const coverage = evidence.diff_coverage;
  const minimum = config.risk.min_diff_coverage;
  if (coverage === undefined || coverage >= minimum) return [];
  return [`pokrycie zmienionych linii ${coverage}%, próg ${minimum}%`];
}

function occurrences(lines: readonly string[], marker: string): number {
  return lines.reduce((sum, line) => sum + line.split(marker).length - 1, 0);
}

/** Więcej wystąpień w liniach dodanych niż w usuniętych; przeniesienie znacznika się nie liczy. */
function netAdded(file: ChangedFile, marker: string): number {
  return occurrences(file.addedLines, marker) - occurrences(file.removedLines, marker);
}

/** Nazwa pliku bez rozszerzenia i znaczników testu: Button.test.ts, button.vue i test_button.gd → button. */
export function stem(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return name.replace(/\.[^.]+$/, '').replace(/[._-](test|spec)$/, '').replace(/^test[_-]/, '');
}

/** Usunięty plik testów daje High, chyba że ta sama zmiana usuwa też testowany kod. */
function testProblems(files: readonly ChangedFile[], config: FactoryConfig): { high: string[]; medium: string[] } {
  const isTest = (path: string) => matchesAny(path, config.files.tests);
  const deletedCode = new Set(files.filter((f) => f.status === 'deleted' && !isTest(f.path)).map((f) => stem(f.path)));
  const high: string[] = [];
  const medium: string[] = [];
  for (const file of files.filter((f) => isTest(f.path))) {
    if (file.status === 'deleted') {
      if (deletedCode.has(stem(file.path))) medium.push(`usunięty plik testów razem z testowanym kodem: ${file.path}`);
      else high.push(`usunięty plik testów, a testowany kod został: ${file.path}`);
      continue;
    }
    const removed = -config.assertion_markers.reduce((sum, marker) => sum + netAdded(file, marker), 0);
    if (removed > 0) high.push(`ubyło asercji w ${file.path}: ${removed}`);
  }
  return { high, medium };
}

/** Nowe wyłączenie reguły lub testu w kodzie daje Medium i wymaga uzasadnienia. */
function newMarkers(files: readonly ChangedFile[], config: FactoryConfig): string[] {
  return files
    .filter((file) => matchesAny(file.path, config.files.source))
    .flatMap((file) =>
      config.disable_markers
        .filter((marker) => netAdded(file, marker) > 0)
        .map((marker) => `nowy znacznik wyłączenia „${marker}” w ${file.path}`),
    );
}
