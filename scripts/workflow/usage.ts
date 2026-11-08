// Zużycie etapów taśmy: koszt, tury, czas i tokeny z pliku przebiegu claude-code-action.
// Koszt to równowartość cen API (total_cost_usd); przy subskrypcji pokazuje, ile etap waży w limitach.
// Workflowy zapisują zużycie w ukrytym bloku komentarza planu, opisu PR i werdyktu, a dziennik je sumuje.

export const STAGES = ['plan', 'implement', 'review', 'assess'] as const;
export type Stage = (typeof STAGES)[number];

export interface Usage {
  stage: Stage;
  /** Ile sesji Claude złożyło się na ten rekord (np. 5 recenzentów). */
  count: number;
  cost: number;
  turns: number;
  ms: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Perspektywa recenzenta; dziennik pokazuje dzięki niej koszt każdego recenzenta osobno. */
  name?: string;
  /** Znaki wyjścia według rodzaju: rozumowanie, tekst i wywołania narzędzi (np. kod pisany przez implementera). */
  chars?: OutputChars;
}

export interface OutputChars {
  thinking: number;
  text: number;
  tools: number;
}

const CHAR_KINDS = ['thinking', 'text', 'tools'] as const;
const NAME = /^[a-z][a-z0-9_-]*$/;

const NUMBERS = ['count', 'cost', 'turns', 'ms', 'input', 'output', 'cacheRead', 'cacheWrite'] as const;
const BLOCK = /<!-- factory:usage (\[.*?\]) -->/gs;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/** Znaki wyjścia z wiadomości asystenta w pliku przebiegu, według rodzaju bloku. */
export function outputChars(raw: unknown): OutputChars | undefined {
  const chars: OutputChars = { thinking: 0, text: 0, tools: 0 };
  for (const m of Array.isArray(raw) ? raw : [raw]) {
    const content = (m as { type?: unknown; message?: { content?: unknown } } | null)?.type === 'assistant'
      ? (m as { message?: { content?: unknown } }).message?.content
      : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: unknown; text?: unknown; thinking?: unknown; input?: unknown }[]) {
      if (block?.type === 'thinking' && typeof block.thinking === 'string') chars.thinking += block.thinking.length;
      else if (block?.type === 'text' && typeof block.text === 'string') chars.text += block.text.length;
      else if (block?.type === 'tool_use') chars.tools += JSON.stringify(block.input ?? {}).length;
    }
  }
  return chars.thinking + chars.text + chars.tools > 0 ? chars : undefined;
}

/** Rekord z wyniku sesji: ostatniej wiadomości `result` w pliku przebiegu (tablica wiadomości albo sam wynik). */
export function readUsage(raw: unknown, stage: Stage, name?: string): Usage | undefined {
  const messages = Array.isArray(raw) ? raw : [raw];
  const result = [...messages].reverse().find((m) => (m as { type?: unknown } | null)?.type === 'result') as
    | Record<string, unknown>
    | undefined;
  if (!result) return undefined;
  const usage: Usage = {
    stage,
    count: 1,
    cost: num(result.total_cost_usd),
    turns: num(result.num_turns),
    ms: num(result.duration_ms),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  // modelUsage obejmuje wszystkie modele sesji (także pomocnicze wywołania); usage tylko główną pętlę.
  const models = Object.values((result.modelUsage ?? {}) as Record<string, Record<string, unknown>>).filter(
    (m) => typeof m?.inputTokens === 'number',
  );
  if (models.length > 0) {
    for (const m of models) {
      usage.input += num(m.inputTokens);
      usage.output += num(m.outputTokens);
      usage.cacheRead += num(m.cacheReadInputTokens);
      usage.cacheWrite += num(m.cacheCreationInputTokens);
    }
  } else {
    const u = (result.usage ?? {}) as Record<string, unknown>;
    usage.input = num(u.input_tokens);
    usage.output = num(u.output_tokens);
    usage.cacheRead = num(u.cache_read_input_tokens);
    usage.cacheWrite = num(u.cache_creation_input_tokens);
  }
  if (name && NAME.test(name)) usage.name = name;
  const chars = outputChars(raw);
  if (chars) usage.chars = chars;
  return usage;
}

/** Treść błędu sesji (np. limit subskrypcji), gdy wynik ma is_error; claude-code-action ukrywa pełne wyjście. */
export function sessionError(raw: unknown): string | undefined {
  const messages = Array.isArray(raw) ? raw : [raw];
  const result = [...messages].reverse().find((m) => (m as { type?: unknown } | null)?.type === 'result') as
    | { is_error?: unknown; result?: unknown; subtype?: unknown }
    | undefined;
  if (!result || result.is_error !== true) return undefined;
  const text = typeof result.result === 'string' && result.result.trim() ? result.result.trim() : `bez opisu (${String(result.subtype)})`;
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

/** Czy sesja Claude zaczęła pracę: jest wynik i koszt większy od zera. Inaczej to awaria startu, którą warto ponowić. */
export function sessionStarted(raw: unknown): boolean {
  const messages = Array.isArray(raw) ? raw : [raw];
  const result = [...messages].reverse().find((m) => (m as { type?: unknown } | null)?.type === 'result') as
    | { total_cost_usd?: unknown }
    | undefined;
  return typeof result?.total_cost_usd === 'number' && result.total_cost_usd > 0;
}

/** Suma rekordów na etap (i perspektywę recenzenta, gdy jest), w kolejności taśmy. */
export function sumUsage(records: readonly Usage[]): Usage[] {
  const totals = new Map<string, Usage>();
  for (const r of records) {
    const key = `${r.stage}/${r.name ?? ''}`;
    const t = totals.get(key) ?? { stage: r.stage, count: 0, cost: 0, turns: 0, ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (r.name) t.name = r.name;
    for (const k of NUMBERS) t[k] += r[k];
    if (r.chars) {
      const c = t.chars ?? { thinking: 0, text: 0, tools: 0 };
      for (const k of CHAR_KINDS) c[k] += r.chars[k];
      t.chars = c;
    }
    totals.set(key, t);
  }
  const order = (u: Usage) => STAGES.indexOf(u.stage);
  return [...totals.values()].sort((a, b) => order(a) - order(b) || (a.name ?? '').localeCompare(b.name ?? '')).map(round);
}

function round(u: Usage): Usage {
  return { ...u, cost: Math.round(u.cost * 10_000) / 10_000 };
}

/** Rekordy z niezaufanego źródła (komentarz, plik): tylko poprawne pola, reszta odpada. */
export function parseUsageList(value: unknown): Usage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const r = item as Record<string, unknown> | null;
    if (!r || !isStage(r.stage)) return [];
    const usage = { stage: r.stage } as Usage;
    for (const key of NUMBERS) usage[key] = Math.max(0, num(r[key]));
    if (typeof r.name === 'string' && NAME.test(r.name)) usage.name = r.name;
    const c = r.chars as Record<string, unknown> | undefined;
    if (c && typeof c === 'object') usage.chars = { thinking: Math.max(0, num(c.thinking)), text: Math.max(0, num(c.text)), tools: Math.max(0, num(c.tools)) };
    return [usage];
  });
}

export function usageBlock(records: readonly Usage[]): string {
  return `<!-- factory:usage ${JSON.stringify(records)} -->`;
}

/** Wszystkie bloki zużycia z tekstu (komentarza albo opisu PR). */
export function parseUsageBlocks(text: string): Usage[] {
  return [...text.matchAll(BLOCK)].flatMap((m) => {
    try {
      return parseUsageList(JSON.parse(m[1]!));
    } catch {
      return [];
    }
  });
}
