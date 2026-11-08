// Wczytanie factory.yml: parsowanie YAML, warstwy (base → presety → projekt), walidacja i złożenie.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineCounter, parseDocument, visit } from 'yaml';
import { BASE_ONLY, FILE_CLASSES, PRESET_FIELDS, PROJECT_ONLY, REQUIRED, SCHEMA } from './spec.ts';
import type { FactoryConfig, LayerKind } from './spec.ts';
import { check, describe, isObject, joinPath } from './validate.ts';
import type { Issue } from './validate.ts';

type Obj = Record<string, unknown>;

export interface PresetSource {
  list(): string[];
  read(name: string): string | undefined;
}

export type LoadResult = { ok: true; config: FactoryConfig } | { ok: false; errors: string[] };

interface Layer {
  file: string;
  kind: LayerKind;
  data: Obj;
}

const PRESET_NAME = /^[a-z][a-z0-9_-]*$/;

export const PRESETS_DIR = new URL('../../presets/', import.meta.url).pathname;

export function presetDir(dir: string = PRESETS_DIR): PresetSource {
  return {
    list: () =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.yml'))
        .map((f) => f.slice(0, -'.yml'.length))
        .sort(),
    read: (name) => {
      const path = join(dir, `${name}.yml`);
      return PRESET_NAME.test(name) && existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    },
  };
}

/** Wczytuje kontrakt projektu. Zwraca złożoną konfigurację albo wszystkie znalezione błędy. */
export function loadConfig(text: string, file: string, presets: PresetSource = presetDir()): LoadResult {
  const errors: string[] = [];
  const project = parseLayer(text, file, 'project', errors);
  if (!project) return { ok: false, errors };
  const layers = [...loadPresets(project, presets, errors), project];
  checkZoneNames(layers, errors);
  if (errors.length > 0) return { ok: false, errors };
  const merged = mergeLayers(layers.map((l) => l.data));
  errors.push(...checkReviewerModels(merged, project.file));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: withDefaults(merged) };
}

/** Model można ustawić tylko dla perspektywy, która jest włączona, albo jako `default`. */
function checkReviewerModels(merged: Obj, file: string): string[] {
  const models = getPath(merged, 'models.reviewers');
  if (!isObject(models)) return [];
  const enabled = ['perspectives', 'extra'].flatMap((key) => {
    const list = getPath(merged, `reviewers.${key}`);
    return Array.isArray(list) ? list.map(String) : [];
  });
  return Object.keys(models)
    .filter((name) => name !== 'default' && !enabled.includes(name))
    .map((name) => `${file}: models.reviewers.${name}: perspektywa „${name}” nie jest włączona; włączone: ${enabled.join(', ')}`);
}

function parseLayer(text: string, file: string, kind: LayerKind, errors: string[]): Layer | undefined {
  const data = parseYaml(text, file, errors);
  if (!data) return undefined;
  const issues: Issue[] = [];
  check(data, SCHEMA, '', issues);
  checkLayerRules(data, kind, issues);
  checkRequired(data, kind, issues);
  if (kind === 'base') checkBaseThresholds(data, issues);
  errors.push(...issues.map((issue) => format(file, issue)));
  return { file, kind, data };
}

function parseYaml(text: string, file: string, errors: string[]): Obj | undefined {
  const errorsBefore = errors.length;
  const lines = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: true, lineCounter: lines });
  for (const error of doc.errors) {
    const line = error.linePos?.[0].line;
    const summary = error.message.split(/ at line \d+/)[0];
    errors.push(`${file}: ${line ? `linia ${line}: ` : ''}błąd składni YAML: ${summary}`);
  }
  // Aliasy YAML nie są potrzebne w kontrakcie, a niezacytowany wzorzec „**/x” parser czyta jako alias.
  visit(doc, {
    Alias(_, node) {
      const line = node.range ? `linia ${lines.linePos(node.range[0]).line}: ` : '';
      errors.push(`${file}: ${line}wartość zaczynająca się od „*” ujmij w cudzysłów, np. "**/plik"`);
    },
  });
  if (errors.length > errorsBefore) return undefined;
  const data: unknown = doc.toJS();
  if (data === null || data === undefined) errors.push(`${file}: plik jest pusty`);
  else if (!isObject(data)) errors.push(`${file}: oczekiwano mapy „pole: wartość”, jest: ${describe(data)}`);
  return isObject(data) ? data : undefined;
}

function format(file: string, issue: Issue): string {
  return issue.path ? `${file}: ${issue.path}: ${issue.message}` : `${file}: ${issue.message}`;
}

function presentPaths(data: Obj): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    paths.push(key);
    if (isObject(value)) paths.push(...Object.keys(value).map((sub) => joinPath(key, sub)));
  }
  return paths;
}

function checkLayerRules(data: Obj, kind: LayerKind, out: Issue[]): void {
  for (const path of presentPaths(data)) {
    const message = layerRuleProblem(path, kind);
    if (message) out.push({ path, message });
  }
}

function layerRuleProblem(path: string, kind: LayerKind): string | undefined {
  if (kind === 'project') return Object.hasOwn(BASE_ONLY, path) ? BASE_ONLY[path] : undefined;
  if ((PROJECT_ONLY as readonly string[]).includes(path)) return 'to pole należy do factory.yml projektu';
  if (kind === 'preset' && !path.includes('.') && !(PRESET_FIELDS as readonly string[]).includes(path)) {
    return `preset języka lub frameworka ustawia tylko: ${PRESET_FIELDS.join(', ')}`;
  }
  return undefined;
}

function checkRequired(data: Obj, kind: LayerKind, out: Issue[]): void {
  for (const path of REQUIRED[kind]) {
    if (getPath(data, path) === undefined) out.push({ path, message: 'brak wymaganego pola' });
  }
}

function getPath(data: unknown, path: string): unknown {
  let current = data;
  for (const key of path.split('.')) current = isObject(current) ? current[key] : undefined;
  return current;
}

function checkBaseThresholds(data: Obj, out: Issue[]): void {
  for (const measure of ['lines', 'files']) {
    const low = getPath(data, `risk.size.low.${measure}`);
    const medium = getPath(data, `risk.size.medium.${measure}`);
    if (typeof low === 'number' && typeof medium === 'number' && low > medium) {
      out.push({ path: `risk.size.low.${measure}`, message: `próg Low (${low}) jest wyższy niż Medium (${medium})` });
    }
  }
  const warn = getPath(data, 'gates.file_lines.warn');
  const block = getPath(data, 'gates.file_lines.block');
  if (typeof warn === 'number' && typeof block === 'number' && warn > block) {
    out.push({ path: 'gates.file_lines.warn', message: `ostrzeżenie (${warn}) jest powyżej blokady (${block})` });
  }
}

function loadPresets(project: Layer, presets: PresetSource, errors: string[]): Layer[] {
  const names = project.data.extends;
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) return [];
  if (names[0] !== 'base') {
    errors.push(`${project.file}: extends: pierwszym presetem musi być base`);
    return [];
  }
  const layers: Layer[] = [];
  names.forEach((name, index) => {
    const path = joinPath('extends', index);
    if (names.indexOf(name) !== index) {
      errors.push(`${project.file}: ${path}: preset „${name}” powtarza się`);
      return;
    }
    const text = presets.read(name);
    if (text === undefined) {
      errors.push(`${project.file}: ${path}: nieznany preset „${name}”; dostępne: ${presets.list().join(', ')}`);
      return;
    }
    const layer = parseLayer(text, `presets/${name}.yml`, name === 'base' ? 'base' : 'preset', errors);
    if (layer) layers.push(layer);
  });
  return layers;
}

function checkZoneNames(layers: Layer[], errors: string[]): void {
  const levels = getPath(layers.find((l) => l.kind === 'base')?.data, 'risk.zone_levels');
  if (!isObject(levels)) return;
  const known = Object.keys(levels);
  for (const layer of layers) {
    for (const field of ['zones', 'zone_tests']) {
      const zones = layer.data[field];
      if (!isObject(zones)) continue;
      for (const zone of Object.keys(zones).filter((z) => !known.includes(z))) {
        errors.push(`${layer.file}: ${field}.${zone}: nieznana strefa „${zone}”; dostępne: ${known.join(', ')}`);
      }
    }
  }
}

/** Składa warstwy: mapy łączy rekurencyjnie, listy dokleja bez powtórzeń, pojedyncze wartości nadpisuje. */
export function mergeLayers(layers: Obj[]): Obj {
  return layers.reduce<Obj>((merged, layer) => mergeObjects(merged, layer), {});
}

function mergeObjects(target: Obj, source: Obj): Obj {
  const result: Obj = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = result[key];
    if (Array.isArray(current) && Array.isArray(value)) result[key] = unique([...current, ...value]);
    else if (isObject(current) && isObject(value)) result[key] = mergeObjects(current, value);
    else result[key] = value;
  }
  return result;
}

function unique(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withDefaults(merged: Obj): FactoryConfig {
  const defaults = {
    evidence: { preview_deploy: false },
    dependencies: {},
    zones: {},
    zone_tests: {},
    files: Object.fromEntries(FILE_CLASSES.map((c) => [c, []])),
    disable_markers: [],
    assertion_markers: [],
    protected_files: [],
    reviewers: { extra: [] },
    human_gates: {},
    exceptions: [],
    schedules: {},
  };
  const complete = mergeObjects(defaults, merged);
  // Kolejność pól jak w schemacie, żeby wynik --json był zawsze taki sam i czytelny.
  const ordered = Object.keys(SCHEMA.fields).filter((key) => key in complete);
  return Object.fromEntries(ordered.map((key) => [key, complete[key]])) as unknown as FactoryConfig;
}
