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
}

const NUMBERS = ['count', 'cost', 'turns', 'ms', 'input', 'output', 'cacheRead', 'cacheWrite'] as const;
const BLOCK = /<!-- factory:usage (\[.*?\]) -->/gs;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/** Rekord z wyniku sesji: ostatniej wiadomości `result` w pliku przebiegu (tablica wiadomości albo sam wynik). */
export function readUsage(raw: unknown, stage: Stage): Usage | undefined {
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

/** Suma rekordów na etap, w kolejności taśmy. */
export function sumUsage(records: readonly Usage[]): Usage[] {
  const totals = new Map<Stage, Usage>();
  for (const r of records) {
    const t = totals.get(r.stage) ?? { stage: r.stage, count: 0, cost: 0, turns: 0, ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const key of NUMBERS) t[key] += r[key];
    totals.set(r.stage, t);
  }
  return STAGES.flatMap((s) => (totals.has(s) ? [round(totals.get(s)!)] : []));
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
