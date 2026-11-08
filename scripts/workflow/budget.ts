// Dzienny limit taśmy (daily_runs) liczy tylko etapy z Claude: plan, implementację i recenzję (z oceną ryzyka).
// Etap rozpoznaje po nazwie przebiegu, którą ustawia run-name w workflowie projektu. Przebiegi kolejki,
// dziennika i komend nie zużywają limitu, bo Claude w nich nie działa.

export interface Run {
  display_title?: string;
  event?: string;
}

const CLAUDE_STAGE = /^factory (plan|implement|review)\b/;

/** Ile przebiegów z Claude było w podanym zbiorze (zwykle: dzisiejsze przebiegi workflowu projektu). */
export function claudeRuns(runs: readonly Run[]): number {
  return runs.filter((run) => {
    const title = run.display_title ?? '';
    // Workflow projektu bez run-name: każdy przebieg z workflow_dispatch nazywa się „factory” i liczy się jak dawniej.
    return CLAUDE_STAGE.test(title) || (run.event === 'workflow_dispatch' && title === 'factory');
  }).length;
}
