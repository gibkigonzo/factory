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
const STAGES = ['plan', 'implement', 'review', 'risk', 'merge', 'journal', 'queue', 'commands'];
const REUSABLE = ['pipeline', ...STAGES];
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
      // Etapy fabryki z tej samej wersji ($/) nie mają własnego pinu: wersję przypina projekt jednym uses.
      const uses = [...text.matchAll(/uses:\s*(\S+)(.*)$/gm)].filter(([, ref]) => !ref!.startsWith('$/'));
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

  it('statystyki dziennika: pliki na gałęzi factory-journal bez Claude, a blokada zapisuje swój koszt', () => {
    const { text, data } = workflows.journal!;
    const publish = data.jobs.publish!;
    assert.ok(!usesClaude(publish));
    assert.deepEqual(publish.permissions, { issues: 'write', contents: 'write' });
    for (const step of publish.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.repository, 'gibkigonzo/factory', 'tylko skrypty fabryki');
    }
    assert.match(text, /publish-branch\.sh "[^"]+" journal factory-journal /);
    assert.match(text, /cli\.ts" journal-export --raw/);
    assert.match(text, /--files-url "\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY\/blob\/factory-journal"/);
    assert.match(text, /gh issue list --state all[^\n]*> "\$RAW\/issue-list\.json"/);
    assert.match(text, /contains\("<!-- factory:blocked -->"\)/);
    const blocked = (workflows.implement!.data.jobs.blocked!.steps ?? [])[0]!;
    assert.match(blocked.run!, /<!-- factory:blocked -->/);
    assert.match(blocked.run!, /<!-- factory:usage %s -->/);
    assert.equal(blocked.env?.USAGE, '${{ needs.implement.outputs.usage }}');
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
    assert.match(text, /git diff --cached --name-only --no-renames > "\$W\/paths\.txt"/, 'git mv pliku chronionego nie omija sprawdzenia');
    assert.match(text, /--add-label blocked/);
    const env = steps.findIndex((step) => step.run?.includes('FACTORY_SCREENSHOTS=$GITHUB_WORKSPACE/.factory/work/screenshots'));
    assert.ok(env >= 0 && env < steps.indexOf(claude), 'katalog zrzutów ustawiony przed implementerem, poza patchem');
  });

  it('ocena ryzyka liczy diff od punktu rozgałęzienia zapisanego w recenzji, także gdy PR scalono w trakcie', () => {
    assert.match(workflows.review!.text, /git merge-base "origin\/\$BASE" HEAD > "\$W\/base\.sha"/);
    assert.match(workflows.review!.text, /panel\.ts" --base "\$\(cat "\$W\/base\.sha"\)"/);
    assert.match(workflows.risk!.text, /FORK=\$\(cat "\$W\/base\.sha"/);
    assert.match(workflows.risk!.text, /risk-rules\.ts" --base "\$FORK"/);
  });

  it('recenzenci dostają diff bez lockfile i plików generowanych, a ich streszczenie obok', () => {
    assert.match(workflows.review!.text, /cli\.ts" review-diff --base/);
    assert.doesNotMatch(workflows.review!.text, /git diff --no-color -M[^\n]*> "\$W\/diff\.patch"/);
  });

  it('zrzuty ekranu: komenda projektu nie zatrzymuje recenzji, recenzent wyglądu dostaje zmienione sekcje, a galeria działa bez Claude i bez kodu PR', () => {
    const { data } = workflows.review!;
    type Full = Step & { id?: string; if?: string; name?: string; 'continue-on-error'?: boolean };
    const ci = (data.jobs.ci!.steps ?? []) as Full[];
    const shots = ci.find((step) => step.id === 'shots')!;
    assert.equal(shots['continue-on-error'], true);
    assert.match(shots.run!, /cli\.ts" screenshots --config "\$W\/config\.json"/);
    assert.ok(ci.indexOf(ci.find((step) => step.run?.includes('cli.ts" ci '))!) < ci.indexOf(shots), 'zrzuty po CI, na zainstalowanym projekcie');
    const base = ci.find((step) => step.name === 'Zrzuty ekranu gałęzi bazowej')!;
    assert.equal(base['continue-on-error'], true, 'bez zrzutów bazy recenzent bierze wszystkie');
    assert.match(base.run!, /git worktree add --detach "\$RUNNER_TEMP\/base-tree" "\$FORK"/);
    assert.match(base.run!, /screenshots --setup/);
    assert.equal(base.env?.FORK, '${{ steps.base.outputs.fork }}');
    assert.equal(base.env?.GH_TOKEN, undefined, 'kod gałęzi bazowej bez tokenu');

    const reviewer = (data.jobs.reviewer!.steps ?? []) as Full[];
    for (const pattern of ['factory-screenshots', 'factory-screenshots-base']) {
      const download = reviewer.find((step) => step.with?.pattern === pattern)!;
      assert.equal(download.if, 'matrix.member.screenshots', `${pattern}: tylko perspektywa, która ocenia zrzuty`);
    }
    const visual = reviewer.find((step) => step.id === 'visual')!;
    assert.match(visual.run!, /cli\.ts" screenshots-unchanged/);
    assert.equal(reviewer.find((step) => step.id === 'claude')!.if, "steps.visual.outputs.skip != 'true'", 'bez zmian wyglądu bez sesji Claude');
    assert.match(String(reviewer.find((step) => step.name === 'Sprawdzenie werdyktu')!.env?.OUTPUT), /steps\.visual\.outputs\.verdict/);

    const gallery = data.jobs.gallery! as Job & { needs?: string[] };
    assert.ok(!usesClaude(gallery));
    assert.deepEqual(gallery.permissions, { contents: 'write', 'pull-requests': 'write' });
    for (const step of gallery.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.repository, 'gibkigonzo/factory', 'tylko skrypty fabryki, nie kod PR');
    }
    const publish = (gallery.steps ?? []).map((step) => step.run ?? '').join('\n');
    assert.ok(publish.indexOf('cli.ts" gallery') < publish.indexOf('gallery-push.sh'), 'pliki sprawdzone przed publikacją');
    assert.match(publish, /gallery --dir "\$SHOTS" --before "\$RUNNER_TEMP\/shots-base" --publish "\$PUBLISH"/);
    assert.match(publish, /gallery-push\.sh" "[^"]+" "\$PUBLISH"/, 'na gałąź trafiają tylko obrazy galerii');
    assert.ok(publish.indexOf('-F body=@"$RUNNER_TEMP/gallery.md"') < publish.indexOf('-X DELETE'), 'nowy komentarz w każdej rundzie, potem usunięcie starego');
    assert.doesNotMatch(publish, /-X PATCH/);
    assert.ok(!(data.jobs.loop as Job & { needs?: string[] }).needs?.includes('gallery'), 'galeria nie wstrzymuje pętli ani oceny ryzyka');
  });

  it('limit dzienny: liczy etapy z Claude, sprawdza tylko nowe zadania, a zadanie ponad limit trafia do kolejki', () => {
    const { text, data } = workflows.implement!;
    const budget = (data.jobs.implement!.steps ?? []).find((step) => (step as { id?: string }).id === 'budget') as Step & { if?: string };
    assert.match(String(budget.if), /inputs\.pr == ''/);
    assert.match(budget.run!, /cli\.ts" budget --runs/);
    assert.match(text, /if \[ "\$OVER" = true \]; then[\s\S]*?--add-label queued[\s\S]*?exit 0/);
  });

  it('plan z nowymi zależnościami czeka na /approve, a /reject i zgoda uruchamiają kolejkę', () => {
    assert.match(workflows.plan!.text, /--add-label needs-approval/);
    assert.match(workflows.plan!.text, /--remove-label factory:approved/);
    const commands = workflows.commands!.text;
    assert.match(commands, /grep -qx needs-approval/);
    assert.equal((commands.match(/^\s+queue$/gm) ?? []).length, 3, '/approve z zależnościami, /reject i /start');
    assert.match(commands, /-f stage=queue/);
  });

  it('każdy etap z Claude ponawia sesję raz, gdy Claude nie wystartował, a prawdziwy błąd dalej przerywa job', () => {
    for (const name of ['plan', 'implement', 'review', 'risk']) {
      const steps = Object.values(workflows[name]!.data.jobs).flatMap((job) => job.steps ?? []) as (Step & { id?: string; if?: string; 'continue-on-error'?: boolean })[];
      const first = steps.find((step) => step.id === 'claude')!;
      const retry = steps.find((step) => step.id === 'claude_retry')!;
      assert.equal(first['continue-on-error'], true, name);
      assert.ok(retry?.uses?.startsWith(CLAUDE), name);
      assert.deepEqual(retry.with, first.with, `${name}: ponowna próba z tymi samymi ustawieniami`);
      assert.equal(first.with?.path_to_bun_executable, '${{ steps.bun.outputs.path }}', `${name}: Bun z npm, nie z GitHub Releases`);
      const bun = steps.find((step) => (step as { id?: string }).id === 'bun')!;
      assert.equal((bun as { 'continue-on-error'?: boolean })['continue-on-error'], true, `${name}: bez Buna z npm akcja pobiera go sama`);
      assert.ok(steps.indexOf(bun) < steps.indexOf(first));
      assert.match(String(retry.if), /steps\.started\.outputs\.retry == 'true'/, name);
      assert.ok(steps.some((step) => step.run?.includes('cli.ts" started')), name);
      assert.ok(steps.some((step) => /steps\.started\.outputs\.retry != 'true'/.test(String(step.if)) && step.run?.includes('exit 1')), name);
      assert.doesNotMatch(workflows[name]!.text, /OUTPUT: \$\{\{ steps\.claude\.outputs/, `${name}: wynik bierze z ponownej próby, gdy była`);
    }
  });

  it('strażnik zaufanych kont jest taki sam we wszystkich etapach', () => {
    const guards = ['plan', 'implement', 'review'].map((name) => JSON.stringify(workflows[name]!.data.jobs.guard));
    assert.equal(new Set(guards).size, 1);
  });
});

describe('wzorzec workflowu projektu', () => {
  const rank = { read: 1, write: 2 } as Record<string, number>;
  /** Uprawnienia w łańcuchu mogą tylko maleć: każdy job mieści się w suficie wywołującego, rekurencyjnie. */
  function checkCeiling(ceiling: Record<string, string> | undefined, workflow: string, path: string): void {
    for (const [jobName, job] of Object.entries(workflows[workflow]!.data.jobs)) {
      for (const [scope, level] of Object.entries(job.permissions ?? {})) {
        const granted = ceiling?.[scope];
        assert.ok(granted && rank[granted]! >= rank[level]!, `${path} → ${workflow}/${jobName}: ${scope}: ${level}`);
      }
      const nested = /^\$\/\.github\/workflows\/(\w+)\.yml$/.exec(job.uses ?? '')?.[1];
      if (job.uses) assert.ok(nested && workflows[nested], `${workflow}/${jobName}: etap fabryki przez $/: ${job.uses}`);
      if (nested) checkCeiling(job.permissions, nested, `${path} → ${workflow}/${jobName}`);
    }
  }

  it('to cienki plik: jeden job wywołuje dyrygenta, a jego uprawnienia są sufitem dla całej taśmy', () => {
    const jobs = Object.entries(template.jobs);
    assert.equal(jobs.length, 1);
    const [jobName, job] = jobs[0]!;
    const ref = /^gibkigonzo\/factory\/\.github\/workflows\/pipeline\.yml@(\S+)$/.exec(job.uses ?? '')?.[1];
    assert.ok(ref, String(job.uses));
    assert.equal(job.with?.factory_ref, ref, 'skrypty fabryki z tej samej wersji co workflowy');
    checkCeiling(job.permissions, 'pipeline', jobName);
  });

  it('dyrygent wywołuje każdy etap taśmy', () => {
    const called = Object.values(workflows.pipeline!.data.jobs)
      .filter((job) => job.uses)
      .map((job) => /workflows\/(\w+)\.yml$/.exec(job.uses ?? '')?.[1]);
    assert.deepEqual([...called].sort(), [...STAGES].sort());
  });

  it('zatrzymana taśma: etapy z Claude i kolejka czekają, a wstrzymane wywołanie trafia do zapisu dla /start', () => {
    type Gated = Job & { needs?: string | string[]; if?: string };
    const jobs = workflows.pipeline!.data.jobs as Record<string, Gated>;
    for (const name of ['plan', 'implement', 'review', 'queue']) {
      assert.equal(jobs[name]!.needs, 'line', name);
      assert.match(String(jobs[name]!.if), /needs\.line\.outputs\.stopped == 'false'/, name);
    }
    for (const name of ['journal', 'commands']) assert.doesNotMatch(String(jobs[name]!.if), /stopped/, `${name} działa zawsze`);
    assert.match(String(jobs.line!.steps?.[0]?.run), /gh issue list --label factory:stopped --state open/);
    const pause = jobs.pause!;
    assert.ok(!usesClaude(pause));
    assert.match(String(pause.if), /needs\.line\.outputs\.stopped == 'true'/);
    const run = String(pause.steps?.[0]?.run);
    assert.match(run, /\^\(plan\|implement\|review\)\$/, 'wejście sprawdzone, zanim trafi do zapisu');
    assert.match(run, /<!-- factory:paused %s -->/);
    assert.match(run, /--add-label factory:paused/);
    const commands = workflows.commands!.text;
    assert.match(commands, /\/\(approve\|veto\|reject\|change\|split\|stop\|start\)/);
    assert.match(commands, /gh issue create --title 'Taśma zatrzymana' --label factory:stopped/);
    assert.match(commands, /<!-- factory:paused \(\\\{\[\^<>\]\*\\\}\) -->/, '/start czyta zapis wstrzymanego etapu');
    assert.match(commands, /--remove-label factory:paused/);
    assert.match(workflows.journal!.text, /--label factory:stopped --state open[^\n]*> "\$RAW\/stopped\.json"/);
  });

  it('problem taśmy: implementer zgłasza go w opisie PR albo w komentarzu z blokadą, a taśma jedzie dalej', () => {
    const { text, data } = workflows.implement!;
    assert.match(text, /cli\.ts" line-problem --stage implement --implementation/);
    assert.equal((data.jobs.blocked!.steps ?? [])[0]!.env?.LINE, '${{ needs.implement.outputs.line }}');
  });

  it('nazwa przebiegu mówi, który etap ruszył, bo po niej liczy się dzienny limit', () => {
    const runName = String((template as Workflow & { 'run-name'?: string })['run-name']);
    assert.match(runName, /format\('factory \{0\}\{1\}\{2\}', inputs\.stage/);
    assert.match(runName, /github\.event\.label\.name == 'ready' && format\('factory plan #\{0\}'/);
  });

  it('przekazuje tylko sekret CLAUDE_CODE_OAUTH_TOKEN, nie wszystkie', () => {
    assert.doesNotMatch(read(join(ROOT, 'templates/workflows/factory.yml')), /secrets:\s*inherit/);
  });
});
