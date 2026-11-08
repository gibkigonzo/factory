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
const REUSABLE = ['plan', 'implement', 'review', 'risk', 'merge', 'journal', 'queue', 'commands'];
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
            assert.equal(step.with?.allowed_bots, 'github-actions[bot]', 'dopuszczony tylko bot workflowów, nigdy *');
            assert.match(String(step.with?.claude_args), /--allowedTools/);
          }
        }
      });
    }
  }

  it('merger i dziennik działają bez Claude: decyduje i liczy skrypt', () => {
    for (const name of ['merge', 'journal']) {
      for (const [jobName, job] of Object.entries(workflows[name]!.data.jobs)) assert.ok(!usesClaude(job), `${name}/${jobName}`);
    }
  });

  it('dziennik nie pobiera kodu z PR, bo projekt uruchamia go też z pull_request_target', () => {
    for (const job of Object.values(workflows.journal!.data.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/checkout@')) assert.doesNotMatch(String(step.with?.ref ?? ''), /pull|head/);
      }
    }
  });

  it('kontrakt dla implementera i recenzji przy PR pochodzi z gałęzi bazowej, nie z PR', () => {
    for (const name of ['implement', 'review']) assert.match(workflows[name]!.text, /git archive "origin\/\$BASE" factory\.yml/, name);
  });

  it('/change bierze numer issue z gałęzi factory/<numer>-…, a powiązanie PR z issue to zapas', () => {
    const text = workflows.commands!.text;
    assert.match(text, /s#\^factory\/\(\[0-9\]\+\)-\.\*#\\1#p/);
    assert.ok(text.indexOf('headRefName') < text.indexOf('closingIssuesReferences'), 'najpierw gałąź');
  });

  it('dziennik zamyka issue tylko po scaleniu PR i tylko na podstawie gałęzi factory/<numer>-…', () => {
    const job = workflows.journal!.data.jobs['close-issue'] as Job & { if?: string };
    assert.match(String(job.if), /pull_request_target/);
    assert.match(String(job.if), /merged == true/);
    assert.deepEqual(job.permissions, { issues: 'write' });
    assert.match(String(job.steps?.[0]?.run), /s#\^factory\/\(\[0-9\]\+\)-\.\*#\\1#p/);
  });

  it('kolejka nie pobiera kodu z PR i decyduje skryptem: plan i kolejka korzystają z tej samej logiki', () => {
    const { text, data } = workflows.queue!;
    assert.doesNotMatch(text, /head\.(ref|sha)|pull_request\.head/);
    assert.ok(!Object.values(data.jobs).some(usesClaude));
    for (const name of ['plan', 'queue']) assert.match(workflows[name]!.text, /queue-raw\.sh/, name);
    assert.match(workflows.plan!.text, /queue-admit/);
    assert.match(text, /queue-release/);
    assert.match(workflows.plan!.text, /--add-label queued/);
  });

  it('pętla poprawek: decyduje skrypt bez Claude, czerwone CI omija recenzentów, a ocena ryzyka czeka na wynik', () => {
    const { text, data } = workflows.review!;
    const loop = data.jobs.loop!;
    assert.ok(!usesClaude(loop));
    assert.match(text, /cli\.ts" loop /);
    assert.match(text, /-f stage=implement -f issue="\$ISSUE" -f pr="\$PR" -f note="\$ID"/);
    assert.match(text, /needs\.ci\.outputs\.status != 'failure' \|\| needs\.ci\.outputs\.final == 'true'/);
    assert.match(text, /jobs\.loop\.outputs\.retry != 'true'/, 'ok jest false, gdy PR wrócił do poprawek');
  });

  it('implementer: zależności instaluje workflow po zgodzie, a blokada nie otwiera PR', () => {
    const { text, data } = workflows.implement!;
    const steps = data.jobs.implement!.steps ?? [];
    const deps = steps.find((step) => step.run?.includes('install-commands'))!;
    assert.match(String((deps as { if?: string }).if), /inputs\.pr == ''/, 'tylko w pierwszej rundzie');
    assert.match(deps.run!, /grep -qx factory:approved/);
    const claude = steps.find((step) => step.uses?.startsWith(CLAUDE)) as Step & { if?: string };
    assert.match(String(claude.if), /steps\.deps\.outputs\.blocker == ''/);
    assert.ok(steps.indexOf(deps) < steps.indexOf(claude));
    assert.match(String((data.jobs.publish as { if?: string }).if), /outputs\.status == 'done'/);
    assert.ok(data.jobs.blocked && !usesClaude(data.jobs.blocked));
    assert.match(text, /--add-label blocked/);
  });

  it('plan z nowymi zależnościami czeka na /approve, a /reject i zgoda uruchamiają kolejkę', () => {
    assert.match(workflows.plan!.text, /--add-label needs-approval/);
    assert.match(workflows.plan!.text, /--remove-label factory:approved/);
    const commands = workflows.commands!.text;
    assert.match(commands, /grep -qx needs-approval/);
    assert.equal((commands.match(/^\s+queue$/gm) ?? []).length, 2, '/approve z zależnościami i /reject');
    assert.match(commands, /-f stage=queue/);
  });

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
