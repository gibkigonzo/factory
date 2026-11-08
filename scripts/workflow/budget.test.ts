import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeRuns } from './budget.ts';

describe('dzienny limit taśmy', () => {
  it('liczy tylko etapy z Claude: plan, implementację i recenzję', () => {
    const runs = [
      { display_title: 'factory plan #6', event: 'issues' },
      { display_title: 'factory implement #6', event: 'workflow_dispatch' },
      { display_title: 'factory implement #7 PR #9', event: 'workflow_dispatch' },
      { display_title: 'factory review PR #9', event: 'workflow_dispatch' },
      { display_title: 'factory queue', event: 'workflow_dispatch' },
      { display_title: 'factory journal', event: 'workflow_dispatch' },
      { display_title: 'factory issues', event: 'issues' },
      { display_title: 'factory pull_request_target', event: 'pull_request_target' },
      { display_title: 'factory planner', event: 'workflow_dispatch' },
    ];
    assert.equal(claudeRuns(runs), 4);
  });

  it('workflow projektu bez run-name: każdy przebieg z workflow_dispatch liczy się jak dawniej', () => {
    assert.equal(claudeRuns([
      { display_title: 'factory', event: 'workflow_dispatch' },
      { display_title: 'Tokeny wyglądu', event: 'issues' },
      { display_title: 'factory', event: 'schedule' },
    ]), 1);
  });
});
