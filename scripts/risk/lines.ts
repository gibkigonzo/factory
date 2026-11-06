// Liczenie linii kodu bez pustych i komentarzy (bramka długości pliku).
// To heurystyka: rozpoznaje komentarze po rozszerzeniu pliku i nie analizuje napisów w kodzie.

interface Syntax {
  line: readonly string[];
  block: readonly (readonly [string, string])[];
}

const C_LIKE: Syntax = { line: ['//'], block: [['/*', '*/']] };
const HASH: Syntax = { line: ['#'], block: [] };
const MARKUP: Syntax = { line: [], block: [['<!--', '-->']] };
const COMPONENT: Syntax = { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']] };
const CSS: Syntax = { line: [], block: [['/*', '*/']] };
const NONE: Syntax = { line: [], block: [] };

const BY_EXTENSION: Record<string, Syntax> = {
  ...Object.fromEntries(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'scss', 'less'].map((e) => [e, C_LIKE])),
  ...Object.fromEntries(['vue', 'svelte', 'astro'].map((e) => [e, COMPONENT])),
  ...Object.fromEntries(['gd', 'py', 'sh', 'rb', 'yml', 'yaml', 'toml'].map((e) => [e, HASH])),
  ...Object.fromEntries(['html', 'xml', 'md'].map((e) => [e, MARKUP])),
  css: CSS,
};

export function syntaxFor(path: string): Syntax {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return BY_EXTENSION[extension] ?? NONE;
}

export function countCodeLines(content: string, path: string): number {
  const syntax = syntaxFor(path);
  let openBlock: string | undefined;
  let count = 0;
  for (const rawLine of content.split('\n')) {
    const { code, open } = stripBlocks(rawLine, syntax, openBlock);
    openBlock = open;
    const trimmed = code.trim();
    if (trimmed !== '' && !syntax.line.some((token) => trimmed.startsWith(token))) count++;
  }
  return count;
}

/** Usuwa z linii fragmenty komentarzy blokowych; zwraca resztę kodu i znacznik końca otwartego bloku. */
function stripBlocks(line: string, syntax: Syntax, openBlock: string | undefined): { code: string; open?: string } {
  let rest = line;
  let code = '';
  let open = openBlock;
  while (rest !== '') {
    if (open) {
      const end = rest.indexOf(open);
      if (end === -1) return { code, open };
      rest = rest.slice(end + open.length);
      open = undefined;
      continue;
    }
    const next = firstBlockStart(rest, syntax);
    const lineComment = firstLineComment(rest, syntax);
    if (lineComment !== -1 && (!next || lineComment < next.index)) return { code: code + rest.slice(0, lineComment) };
    if (!next) return { code: code + rest };
    code += rest.slice(0, next.index);
    rest = rest.slice(next.index + next.start.length);
    open = next.end;
  }
  return { code, open };
}

function firstLineComment(text: string, syntax: Syntax): number {
  const indexes = syntax.line.map((token) => text.indexOf(token)).filter((index) => index !== -1);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function firstBlockStart(text: string, syntax: Syntax): { index: number; start: string; end: string } | undefined {
  let best: { index: number; start: string; end: string } | undefined;
  for (const [start, end] of syntax.block) {
    const index = text.indexOf(start);
    if (index !== -1 && (!best || index < best.index)) best = { index, start, end };
  }
  return best;
}
