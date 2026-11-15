// Logika fabryki dla aplikacji do prowadzenia projektów: ten sam kod co w taśmie, żeby aplikacja nie liczyła
// stanów, werdyktów i kosztów po swojemu. Czysty TypeScript bez Node, bez systemu plików i bez sieci: działa
// w przeglądarce i w Tauri. Pilnuje tego test (scripts/app/app.test.ts) i tsconfig.app.json bez typów Node.
// Import w aplikacji: `import { taskColumn } from 'factory/app'` (zależność npm przypięta do commita fabryki).

export { COLUMNS, isPaused, issueOfBranch, taskColumn } from './board.ts';
export type { ColumnId, TaskState } from './board.ts';
export { availableCommands, commandComment, COMMANDS, splitTooLate } from './commands.ts';
export type { CommandAvailability, CommandName, CommandTarget } from './commands.ts';
export { parseJournal } from './journal.ts';
export type { JournalFile } from './journal.ts';
export { factoryVersion } from './projects.ts';

export { LEVELS } from '../config/spec.ts';
export type { Level } from '../config/spec.ts';
export { parseShadow, SHADOW_MARKER } from '../shadow/comment.ts';
export type { ShadowRecord } from '../shadow/comment.ts';
export { ACTION_SHORT, ACTIONS, describeAction } from '../shadow/decision.ts';
export type { Action } from '../shadow/decision.ts';
export type { TaskRow } from '../shadow/export.ts';
export type { LineProblemRecord, StopState } from '../shadow/records.ts';
export { parseUsageBlocks, STAGE_LABELS, STAGES, sumUsage } from '../workflow/usage.ts';
export type { Stage, Usage } from '../workflow/usage.ts';

/** Reakcja na komentarz werdyktu w API GitHuba: tak właściciel ocenia werdykt trybu cienia. */
export const RATING_REACTIONS = { up: '+1', down: '-1' } as const;
