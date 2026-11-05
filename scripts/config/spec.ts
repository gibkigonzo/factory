// Schemat kontraktu projektu: pola factory.yml i presetów, warstwy i pola wymagane.

export const LEVELS = ['Low', 'Medium', 'High'] as const;
export type Level = (typeof LEVELS)[number];

export const GATES = ['file_lines', 'function_lines', 'complexity', 'nesting'] as const;
export type Gate = (typeof GATES)[number];

export const SCHEDULES = ['nightly', 'weekly', 'off'] as const;
export type Schedule = (typeof SCHEDULES)[number];

export const FILE_CLASSES = ['tests', 'lockfiles', 'generated', 'translations'] as const;
export type FileClass = (typeof FILE_CLASSES)[number];

export type Spec =
  | { kind: 'string'; pattern?: RegExp; hint?: string }
  | { kind: 'boolean' }
  | { kind: 'integer'; min: number }
  | { kind: 'number'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'glob' }
  | { kind: 'list'; item: Spec }
  | { kind: 'map'; key: RegExp; keyHint: string; value: Spec }
  | { kind: 'object'; fields: Record<string, Spec>; required?: readonly string[] };

const NAME = /^[a-z][a-z0-9_-]*$/;
const NAME_HINT = 'małe litery, cyfry, „-” i „_”, na początku litera';

const text: Spec = { kind: 'string' };
const name: Spec = { kind: 'string', pattern: NAME, hint: NAME_HINT };
const positive: Spec = { kind: 'integer', min: 1 };
const level: Spec = { kind: 'enum', values: LEVELS };
const globs: Spec = { kind: 'list', item: { kind: 'glob' } };
const names: Spec = { kind: 'list', item: name };

function namedMap(value: Spec): Spec {
  return { kind: 'map', key: NAME, keyHint: NAME_HINT, value };
}

const sizeLimit: Spec = {
  kind: 'object',
  fields: { lines: positive, files: positive },
  required: ['lines', 'files'],
};

const risk: Spec = {
  kind: 'object',
  fields: {
    zone_levels: namedMap(level),
    unassigned: level,
    size: { kind: 'object', fields: { low: sizeLimit, medium: sizeLimit }, required: ['low', 'medium'] },
    min_confidence: { kind: 'number', min: 0, max: 1 },
    medium_veto_hours: { kind: 'integer', min: 0 },
  },
};

const gates: Spec = {
  kind: 'object',
  fields: {
    file_lines: { kind: 'object', fields: { warn: positive, block: positive }, required: ['warn', 'block'] },
    function_lines: positive,
    complexity: positive,
    nesting: positive,
  },
};

const exception: Spec = {
  kind: 'object',
  fields: { path: { kind: 'glob' }, gate: { kind: 'enum', values: GATES }, max: positive, reason: text },
  required: ['path', 'gate', 'max', 'reason'],
};

const files: Spec = {
  kind: 'object',
  fields: Object.fromEntries(FILE_CLASSES.map((c) => [c, globs])),
};

/** Wszystkie pola, które może mieć dowolna warstwa. Co wolno której warstwie, mówią reguły niżej. */
export const SCHEMA: Extract<Spec, { kind: 'object' }> = {
  kind: 'object',
  fields: {
    project: { kind: 'string', pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, hint: 'litery, cyfry, „.”, „-” i „_”' },
    extends: names,
    commands: { kind: 'map', key: /^[a-z][a-z0-9_]*$/, keyHint: 'małe litery, cyfry i „_”', value: text },
    evidence: { kind: 'object', fields: { screenshots: text, preview_deploy: { kind: 'boolean' } } },
    zones: namedMap(globs),
    files,
    disable_markers: { kind: 'list', item: text },
    protected_files: globs,
    risk,
    gates,
    reviewers: { kind: 'object', fields: { perspectives: names, extra: names } },
    human_gates: namedMap({ kind: 'list', item: text }),
    exceptions: { kind: 'list', item: exception },
    wip_limit: positive,
    daily_runs: positive,
    schedules: namedMap({ kind: 'enum', values: SCHEDULES }),
  },
};

export type LayerKind = 'base' | 'preset' | 'project';

/** Pola, które ustawia tylko factory.yml projektu. */
export const PROJECT_ONLY = [
  'project',
  'extends',
  'commands',
  'evidence',
  'human_gates',
  'exceptions',
  'schedules',
  'reviewers.extra',
] as const;

/** Progi i reguły wspólne dla wszystkich projektów; projekt ich nie zmienia. */
export const BASE_ONLY: Record<string, string> = {
  gates: 'progi bramek jakości ustala warstwa base; wyjątek dla ścieżki wpisz w exceptions',
  'risk.zone_levels': 'poziomy stref ustala warstwa base; ścieżki przypisz do stref w zones',
  'risk.unassigned': 'poziom ścieżek spoza mapy stref ustala warstwa base',
  'risk.size': 'progi rozmiaru ustala warstwa base',
  'risk.min_confidence': 'próg pewności recenzentów ustala warstwa base',
  'reviewers.perspectives': 'podstawowe perspektywy ustala warstwa base; dodatkowe wpisz w reviewers.extra',
};

/** Pola presetu języka lub frameworka. */
export const PRESET_FIELDS = ['zones', 'files', 'disable_markers', 'protected_files'] as const;

export const REQUIRED: Record<LayerKind, readonly string[]> = {
  base: [
    'risk.zone_levels',
    'risk.unassigned',
    'risk.size',
    'risk.min_confidence',
    'risk.medium_veto_hours',
    'gates.file_lines',
    'gates.function_lines',
    'gates.complexity',
    'gates.nesting',
    'reviewers.perspectives',
    'wip_limit',
    'daily_runs',
  ],
  preset: [],
  project: ['project', 'extends', 'commands.test', 'commands.build'],
};

export interface SizeLimit {
  lines: number;
  files: number;
}

export interface GateException {
  path: string;
  gate: Gate;
  max: number;
  reason: string;
}

/** Konfiguracja po złożeniu warstw i uzupełnieniu pustych list. */
export interface FactoryConfig {
  project: string;
  extends: string[];
  commands: Record<string, string>;
  evidence: { screenshots?: string; preview_deploy: boolean };
  zones: Record<string, string[]>;
  files: Record<FileClass, string[]>;
  disable_markers: string[];
  protected_files: string[];
  risk: {
    zone_levels: Record<string, Level>;
    unassigned: Level;
    size: { low: SizeLimit; medium: SizeLimit };
    min_confidence: number;
    medium_veto_hours: number;
  };
  gates: {
    file_lines: { warn: number; block: number };
    function_lines: number;
    complexity: number;
    nesting: number;
  };
  reviewers: { perspectives: string[]; extra: string[] };
  human_gates: Record<string, string[]>;
  exceptions: GateException[];
  wip_limit: number;
  daily_runs: number;
  schedules: Record<string, Schedule>;
}
