// Rozpoznanie projektu fabryki: cienki workflow projektu wywołuje dyrygenta taśmy z repo fabryki.

const PIPELINE = /^\s*uses:\s*gibkigonzo\/factory\/\.github\/workflows\/pipeline\.yml@([^\s#]+)/m;

/** Wersja fabryki (ref po `@`) z pliku workflowu projektu albo nic, gdy plik nie wywołuje taśmy. */
export function factoryVersion(workflowText: string): string | undefined {
  return PIPELINE.exec(workflowText)?.[1];
}
