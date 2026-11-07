// Wspólne dla skryptów agentów: katalog repo fabryki i odczyt frontmattera plików Markdown.

import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: unknown = parse(match[1]!);
  return { data: typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}, body: text.slice(match[0].length) };
}
