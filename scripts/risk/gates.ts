// Bramki jakości. Nie zmieniają poziomu ryzyka: blokują merge, a fabryka poprawia kod sama.
// Długość pliku liczy ten skrypt; długość funkcji, złożoność i zagnieżdżenie mierzy linter projektu.

import { relative, sep } from 'node:path';
import type { FactoryConfig, Gate } from '../config/spec.ts';
import { matchesAny, matchesGlob } from './glob.ts';
import type { Assessment, ChangedFile, FileSize, GateFinding, LintFinding, LintGate } from './types.ts';

const GATE_NAMES: Record<LintGate, string> = {
  function_lines: 'długość funkcji',
  complexity: 'złożoność',
  nesting: 'zagnieżdżenie',
};

/** Próg bramki dla ścieżki: z base albo z wyjątku w factory.yml (wtedy najwyższy pasujący). */
export function limitFor(path: string, gate: Gate, config: FactoryConfig): number {
  const exceptions = config.exceptions.filter((e) => e.gate === gate && matchesGlob(path, e.path));
  if (exceptions.length > 0) return Math.max(...exceptions.map((e) => e.max));
  return gate === 'file_lines' ? config.gates.file_lines.block : config.gates[gate];
}

export function checkGates(
  files: readonly ChangedFile[],
  sizes: Record<string, FileSize>,
  lint: readonly LintFinding[],
  config: FactoryConfig,
): Assessment['gates'] {
  const findings = [...fileLengthFindings(files, sizes, config), ...lintFindings(files, lint, config)];
  const status = findings.some((f) => f.status === 'block') ? 'block' : findings.length > 0 ? 'warn' : 'pass';
  return { status, findings };
}

function fileLengthFindings(
  files: readonly ChangedFile[],
  sizes: Record<string, FileSize>,
  config: FactoryConfig,
): GateFinding[] {
  const findings: GateFinding[] = [];
  const checked = files.filter(
    (f) => f.status !== 'deleted' && matchesAny(f.path, config.files.source) && !matchesAny(f.path, config.files.generated),
  );
  for (const file of [...checked].sort((a, b) => a.path.localeCompare(b.path))) {
    const finding = fileLengthFinding(file.path, sizes[file.path], config);
    if (finding) findings.push(finding);
  }
  return findings;
}

function fileLengthFinding(path: string, size: FileSize | undefined, config: FactoryConfig): GateFinding | undefined {
  if (size?.after === undefined) return undefined;
  const { after, before } = size;
  const block = limitFor(path, 'file_lines', config);
  const warn = Math.min(config.gates.file_lines.warn, block);
  const finding = (status: GateFinding['status'], message: string): GateFinding => ({ path, gate: 'file_lines', status, message });
  if (before !== undefined && before > block) {
    if (after > before) return finding('block', `plik urósł z ${before} do ${after} linii; pliki ponad ${block} linii nie mogą rosnąć`);
    return finding('warn', `plik ma ${after} linii, ponad limit ${block}; nie urósł`);
  }
  if (after > block) return finding('block', `plik ma ${after} linii, limit ${block}`);
  if (after > warn) return finding('warn', `plik ma ${after} linii, ostrzeżenie od ${warn}`);
  return undefined;
}

function lintFindings(files: readonly ChangedFile[], lint: readonly LintFinding[], config: FactoryConfig): GateFinding[] {
  const changed = new Set(files.filter((f) => f.status !== 'deleted').map((f) => f.path));
  return lint
    .filter((f) => changed.has(f.path) && f.value > limitFor(f.path, f.gate, config))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.gate.localeCompare(b.gate))
    .map((f) => ({
      path: f.path,
      gate: f.gate,
      status: 'block',
      message: `${GATE_NAMES[f.gate]} ${f.value} w linii ${f.line}, limit ${limitFor(f.path, f.gate, config)}`,
    }));
}

const ESLINT_RULES: Record<string, LintGate> = {
  'max-lines-per-function': 'function_lines',
  complexity: 'complexity',
  'max-depth': 'nesting',
};

/** Zamienia raport `eslint --format json` na wyniki bramek. Ścieżki są względne od `root`. */
export function fromEslint(report: unknown, root: string): LintFinding[] {
  if (!Array.isArray(report)) throw new Error('raport ESLint: oczekiwano listy plików');
  return report.flatMap((file: { filePath?: string; messages?: { ruleId?: string; line?: number; message?: string }[] }) =>
    (file.messages ?? []).flatMap((message) => {
      const gate = message.ruleId ? ESLINT_RULES[message.ruleId] : undefined;
      const value = Number(/complexity of (\d+)|\((\d+)\)/.exec(message.message ?? '')?.slice(1).find(Boolean));
      if (!gate || !file.filePath || !Number.isFinite(value)) return [];
      const path = relative(root, file.filePath).split(sep).join('/');
      return [{ path, line: message.line ?? 0, gate, value }];
    }),
  );
}
