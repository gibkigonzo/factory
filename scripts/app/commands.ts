// Komendy taśmy jako przyciski w aplikacji: które mają sens w danym miejscu i jaki komentarz wysłać.
// Zasady są takie same jak w workflowie komend (.github/workflows/commands.yml); on i tak sprawdza je ponownie
// po komentarzu, więc przycisk tylko oszczędza właścicielowi komendy, która nic by nie zrobiła.

export const COMMANDS = ['approve', 'change', 'reject', 'split', 'stop', 'start'] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface CommandTarget {
  kind: 'issue' | 'pr';
  state: 'open' | 'closed';
  labels: readonly string[];
  /** Issue: zadanie ma otwarty PR fabryki. */
  openPr?: boolean;
  /** Taśma zatrzymana (otwarte issue z etykietą factory:stopped). */
  lineStopped: boolean;
}

export interface CommandAvailability {
  name: CommandName;
  enabled: boolean;
  /** Dlaczego komenda jest niedostępna; tekst dla właściciela. */
  reason?: string;
}

/** `/split` jest za późno, gdy taśma już planuje albo realizuje zadanie: podział zdublowałby jej pracę. */
export function splitTooLate(labels: readonly string[], openPr: boolean): boolean {
  const has = (label: string) => labels.includes(label);
  const waiting = has('queued') || has('needs-approval') || has('blocked');
  return openPr || has('ready') || (has('planned') && !waiting);
}

function check(name: CommandName, t: CommandTarget): string | undefined {
  const open = t.state === 'open';
  switch (name) {
    case 'approve':
      if (!open) return 'zamknięte';
      return t.kind === 'pr' || t.labels.includes('needs-approval') ? undefined : 'w issue tylko przy planie z nowymi zależnościami';
    case 'change':
      if (t.kind !== 'pr') return 'działa tylko w PR';
      return open ? undefined : 'PR jest zamknięty';
    case 'reject':
      return open ? undefined : 'zamknięte';
    case 'split':
      if (t.kind !== 'issue') return 'działa w issue, nie w PR';
      if (!open) return 'zamknięte';
      return splitTooLate(t.labels, t.openPr ?? false) ? 'za późno: taśma już planuje albo realizuje zadanie' : undefined;
    case 'stop':
      return t.lineStopped ? 'taśma już stoi' : undefined;
    case 'start':
      return undefined;
  }
}

export function availableCommands(target: CommandTarget): CommandAvailability[] {
  return COMMANDS.map((name) => {
    const reason = check(name, target);
    return reason === undefined ? { name, enabled: true } : { name, enabled: false, reason };
  });
}

/** Treść komentarza z komendą. `/change` wymaga uwag, `/stop` przyjmuje powód, reszta nie ma treści. */
export function commandComment(name: CommandName, text = ''): string {
  const body = text.trim();
  if (name === 'change' && !body) throw new Error('/change wymaga uwag dla implementera');
  return name === 'change' || (name === 'stop' && body) ? `/${name} ${body}` : `/${name}`;
}
