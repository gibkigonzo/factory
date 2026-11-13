// Limit subskrypcji Claude (okno 5 h albo tygodniowe): sesja kończy się błędem bez pracy i kosztu.
// Zamiast blokady zadania etap czeka na reset: zapis w issue albo PR (`factory:paused`, jak przy /stop)
// i issue „Taśma czeka na limit subskrypcji” (`factory:stopped`) z godziną resetu. Pierwsze zdarzenie taśmy
// po tej godzinie zamyka to issue i wznawia wstrzymane etapy, tak jak /start.
// Moduł nie ma zależności z npm: joby bez `npm ci` uruchamiają go przez limit-cli.ts.

import { sessionError } from './usage.ts';

/** Bez godziny resetu w komunikacie czekamy pełne okno subskrypcji. */
export const DEFAULT_WAIT_MS = 5 * 60 * 60 * 1000;
/** Zapas po resecie: limit odnawia się po stronie serwera z małym opóźnieniem. */
const MARGIN_MS = 2 * 60 * 1000;

const LIMIT = /(hit|reached|exceeded)\s+(your|the)\s+[\w\s-]*limit|usage limit|limit reached/i;
const EPOCH = /\|(\d{10})\b/;
const RESETS = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

/** Godzina resetu z komunikatu o limicie albo undefined, gdy to inny błąd. */
export function parseLimit(message: string, now = new Date()): { until: string } | undefined {
  if (!LIMIT.test(message)) return undefined;
  const at = (ms: number) => ({ until: new Date(ms + MARGIN_MS).toISOString() });
  const epoch = EPOCH.exec(message);
  if (epoch) return at(Number(epoch[1]) * 1000);
  const resets = RESETS.exec(message);
  const zone = resets?.[4]?.trim().toUpperCase();
  // Godzinę bez strefy albo w UTC liczymy w UTC (runner GitHuba ma UTC); innej strefy nie zgadujemy.
  if (resets && (!zone || zone === 'UTC' || zone === 'GMT')) {
    let hour = Number(resets[1]) % 12;
    if (!resets[3]) hour = Number(resets[1]);
    else if (resets[3].toLowerCase() === 'pm') hour += 12;
    const minute = Number(resets[2] ?? 0);
    if (hour < 24 && minute < 60) {
      const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
      if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
      return at(reset.getTime());
    }
  }
  return at(now.getTime() + DEFAULT_WAIT_MS - MARGIN_MS);
}

/** Limit z pliku przebiegu claude-code-action (ostatni wynik sesji). */
export function usageLimit(raw: unknown, now = new Date()): { until: string } | undefined {
  const error = sessionError(raw);
  return error ? parseLimit(error, now) : undefined;
}

export const STOP_MARKER = /<!-- factory:stop (\{.*?\}) -->/s;

/** Czas resetu z issue zatrzymania; undefined dla zatrzymania przez /stop (to czeka na /start). */
export function stopUntil(body: string): string | undefined {
  try {
    const until = (JSON.parse(STOP_MARKER.exec(body)?.[1] ?? '{}') as { until?: unknown }).until;
    return typeof until === 'string' && !Number.isNaN(Date.parse(until)) ? until : undefined;
  } catch {
    return undefined;
  }
}

export interface LineState {
  stopped: boolean;
  /** Pierwsze issue, które wciąż trzyma taśmę. */
  issue?: number;
  /** Issue z limitem, którego czas minął: do zamknięcia przy automatycznym wznowieniu. */
  expired: number[];
}

/**
 * Stan taśmy z otwartych issue `factory:stopped`. /stop trzyma taśmę do /start; limit do swojej godziny.
 * Gdy zostały tylko limity po czasie, taśma rusza, a te issue trzeba zamknąć i wznowić wstrzymane etapy.
 */
export function lineState(issues: readonly { number: number; body?: string }[], now = new Date()): LineState {
  const expired: number[] = [];
  const holding: number[] = [];
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const until = stopUntil(issue.body ?? '');
    if (until && Date.parse(until) <= now.getTime()) expired.push(issue.number);
    else holding.push(issue.number);
  }
  return holding.length ? { stopped: true, issue: holding[0]!, expired } : { stopped: false, expired };
}

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
const day = (iso: string) => iso.slice(0, 10);

/** Treść issue zatrzymania przez limit; znacznik jest w tym samym formacie co przy /stop (dziennik czyta powód). */
export function limitStopBody(until: string, stage: string, target: string): string {
  const reason = `limit subskrypcji Claude do ${hhmm(until)} (${day(until)})`;
  const data = JSON.stringify({ reason, until }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return [
    `Limit subskrypcji Claude wyczerpany w etapie „${stage}” (#${target}). Taśma wstrzymuje nowe etapy do ${hhmm(until)} (${day(until)}).`,
    '',
    'Po tej godzinie pierwsze zdarzenie taśmy (komentarz z komendą, etykieta `ready`, PR fabryki albo dzienny przegląd) zamknie to issue i wznowi wstrzymane etapy. Wcześniej: `/start` w dowolnym issue albo PR.',
    '',
    `<!-- factory:stop ${data} -->`,
    '',
  ].join('\n');
}

/** Komentarz w issue albo PR, którego etap czeka na limit; znacznik czyta wznowienie (/start i automatyczne). */
export function limitPausedComment(input: { until: string; stage: string; issue: string; pr: string; note: string; stop: string; run?: string }): string {
  const data = JSON.stringify({ stage: input.stage, issue: input.issue, pr: input.pr, note: input.note });
  return [
    `⏸️ Limit subskrypcji Claude wyczerpany, więc etap „${input.stage}” czeka do ${hhmm(input.until)} (${day(input.until)}) i wtedy ruszy sam (#${input.stop}). Wcześniej: \`/start\`.${input.run ? ` Log: ${input.run}` : ''}`,
    '',
    `<!-- factory:paused ${data} -->`,
    '',
  ].join('\n');
}

/** Późniejszy z dwóch czasów resetu (kilka etapów może trafić na limit z różnymi godzinami). */
export function laterUntil(a: string | undefined, b: string): string {
  return a && Date.parse(a) > Date.parse(b) ? a : b;
}
