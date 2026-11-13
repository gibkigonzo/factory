// CLI limitu subskrypcji dla jobów bez `npm ci`: korzysta tylko z wbudowanych modułów Node.
//   limit --file <execution.json>                 → limited=true|false i until=<ISO> (do $GITHUB_OUTPUT)
//   line-state --issues <issues.json>             → stopped, issue, expired (otwarte issue factory:stopped)
//   stop-body --until <ISO> --stage <s> --target <n>
//   paused-comment --until --stage --issue --pr --note --stop [--run]
//   later --until <ISO> [--current <ISO>]         → późniejszy z czasów

import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { laterUntil, limitPausedComment, limitStopBody, lineState, stopUntil, usageLimit } from './limit.ts';

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string' },
    issues: { type: 'string' },
    until: { type: 'string' },
    current: { type: 'string' },
    stage: { type: 'string' },
    target: { type: 'string' },
    issue: { type: 'string', default: '' },
    pr: { type: 'string', default: '' },
    note: { type: 'string', default: '' },
    stop: { type: 'string', default: '' },
    run: { type: 'string' },
    body: { type: 'string' },
  },
});

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`brak ${name}`);
  return value;
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(command: string | undefined): string {
  switch (command) {
    case 'limit': {
      const file = need(v.file, '--file');
      let limit: { until: string } | undefined;
      try {
        limit = existsSync(file) ? usageLimit(json(file)) : undefined;
      } catch {
        limit = undefined;
      }
      return limit ? `limited=true\nuntil=${limit.until}` : 'limited=false';
    }
    case 'line-state': {
      const state = lineState(json(need(v.issues, '--issues')) as { number: number; body?: string }[]);
      return [`stopped=${state.stopped}`, `issue=${state.issue ?? ''}`, `expired=${state.expired.join(' ')}`].join('\n');
    }
    case 'stop-body':
      return limitStopBody(need(v.until, '--until'), need(v.stage, '--stage'), need(v.target, '--target'));
    case 'stop-until':
      return stopUntil(readFileSync(need(v.body, '--body'), 'utf8')) ?? '';
    case 'paused-comment':
      return limitPausedComment({
        until: need(v.until, '--until'),
        stage: need(v.stage, '--stage'),
        issue: v.issue!,
        pr: v.pr!,
        note: v.note!,
        stop: need(v.stop, '--stop'),
        ...(v.run ? { run: v.run } : {}),
      });
    case 'later':
      return laterUntil(v.current || undefined, need(v.until, '--until'));
    default:
      throw new Error('komenda: limit, line-state, stop-body, stop-until, paused-comment albo later');
  }
}

try {
  process.stdout.write(`${main(positionals[0])}\n`);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(2);
}
