// Schemat JSON dla `--json-schema` w claude-code-action. Opisuje tylko kształt odpowiedzi;
// pełne reguły (wzorce, zakresy, spójność) sprawdza potem scripts/agents/output.ts.

import type { Spec } from '../config/spec.ts';

export function toJsonSchema(spec: Spec): Record<string, unknown> {
  switch (spec.kind) {
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(spec.fields).map(([key, field]) => [key, toJsonSchema(field)])),
        required: [...(spec.required ?? [])],
        additionalProperties: false,
      };
    case 'map':
      return { type: 'object', additionalProperties: toJsonSchema(spec.value) };
    case 'list':
      return { type: 'array', items: toJsonSchema(spec.item) };
    case 'enum':
      return { type: 'string', enum: [...spec.values] };
    case 'boolean':
      return { type: 'boolean' };
    case 'integer':
      return { type: 'integer' };
    case 'number':
      return { type: 'number' };
    default:
      return { type: 'string' };
  }
}
