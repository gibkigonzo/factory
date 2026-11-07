// Zasady bezpieczeństwa workflowów fabryki, sprawdzane na samych plikach YAML.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { ROOT } from '../agents/files.ts';

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { permissions?: Record<string, string>; steps?: Step[]; uses?: string; with?: Record<string, unknown> };
type Workflow = { permissions?: unknown; on: unknown; jobs: Record<string, Job> };

const DIR = join(ROOT, '.github/workflows');
const REUSABLE = ['plan', 'implement', 'review', 'risk', 'commands'];
const read = (path: string) => readFileSync(path, 'utf8');
const workflows = Object.fromEntries(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => [f.replace(/\.yml$/, ''), { text: read(join(DIR, f)), data: parse(read(join(DIR, f))) as Workflow }]),
);
const template = parse(read(join(ROOT, 'templates/workflows/factory.yml'))) as Workflow;

const CLAUDE = 'anthropics/claude-code-action@';
const usesClaude = (job: Job) => (job.steps ?? []).some((s) => s.uses?.startsWith(CLAUDE));

describe('workflowy fabryki', () => {
  it('są wszystkie etapy taśmy', () => {
    for (const name of REUSABLE) assert.ok(workflows[name], `brak ${name}.yml`);
  });

  for (const [name, { text, data }] of Object.entries(workflows)) {
    it(`${name}: każda akcja przypięta do commita z opisem wersji`, () => {
      const uses = [...text.matchAll(/uses:\s*(\S+)(.*)$/gm)];
      for (const [, ref, comment] of uses) assert.match(`${ref}${comment}`, /@[0-9a-f]{40} # v\d+/, `${name}: ${ref}`);
    });

    it(`${name}: skrypty nie wklejają wyrażeń; dane idą przez zmienne środowiskowe`, () => {
      for (const [jobName, job] of Object.entries(data.jobs)) {
        for (const step of job.steps ?? []) assert.doesNotMatch(step.run ?? '', /\$\{\{/, `${name}/${jobName}`);
      }
    });

    if (REUSABLE.includes(name)) {
      it(`${name}: domyślnie żadnych uprawnień, każdy job deklaruje własne`, () => {
        assert.deepEqual(data.permissions, {});
        for (const [jobName, job] of Object.entries(data.jobs)) assert.ok(job.permissions, `${name}/${jobName}`);
      });
    }

    for (const [jobName, job] of Object.entries(data.jobs).filter(([, j]) => usesClaude(j))) {
      it(`${name}/${jobName}: Claude bez prawa zapisu i bez poświadczeń git`, () => {
        const writes = Object.entries(job.permissions ?? {}).filter(([, level]) => level === 'write');
        assert.deepEqual(writes, []);
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false);
          if (step.uses?.startsWith(CLAUDE)) {
            assert.equal(step.with?.github_token, '${{ github.token }}', 'token joba zamiast tokenu aplikacji z prawem zapisu');
            assert.match(String(step.with?.claude_args), /--allowedTools/);
          }
        }
      });
    }
  }

  it('strażnik zaufanych kont jest taki sam we wszystkich etapach', () => {
    const guards = ['plan', 'implement', 'review'].map((name) => JSON.stringify(workflows[name]!.data.jobs.guard));
    assert.equal(new Set(guards).size, 1);
  });
});

describe('wzorzec workflowu projektu', () => {
  it('wywołuje każdy etap i daje mu co najmniej uprawnienia, których potrzebują jego joby', () => {
    const rank = { read: 1, write: 2 } as Record<string, number>;
    for (const [jobName, job] of Object.entries(template.jobs)) {
      const name = /workflows\/(\w+)\.yml@/.exec(job.uses ?? '')?.[1];
      assert.ok(name && workflows[name], `${jobName}: ${job.uses}`);
      for (const [inner, innerJob] of Object.entries(workflows[name]!.data.jobs)) {
        for (const [scope, level] of Object.entries(innerJob.permissions ?? {})) {
          const granted = job.permissions?.[scope];
          assert.ok(granted && rank[granted]! >= rank[level]!, `${jobName} → ${name}/${inner}: ${scope}: ${level}`);
        }
      }
    }
  });

  it('przekazuje tylko sekret CLAUDE_CODE_OAUTH_TOKEN, nie wszystkie', () => {
    assert.doesNotMatch(read(join(ROOT, 'templates/workflows/factory.yml')), /secrets:\s*inherit/);
  });
});
