// Zasady bezpieczeństwa workflowów fabryki, sprawdzane na samych plikach YAML.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { ROOT } from '../agents/files.ts';

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
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
    assert.match(text, /git diff --cached --name-only --no-renames "\$FROM" > "\$W\/paths\.txt"/, 'git mv pliku chronionego nie omija sprawdzenia');
    assert.match(text, /FROM=\$\{BASELINE:-HEAD\}/, 'patch od wyniku scalenia gałęzi głównej, a bez niego od HEAD');
    assert.match(text, /--add-label blocked/);
    const env = steps.findIndex((step) => step.run?.includes('FACTORY_SCREENSHOTS=$GITHUB_WORKSPACE/.factory/work/screenshots'));
    assert.ok(env >= 0 && env < steps.indexOf(claude), 'katalog zrzutów ustawiony przed implementerem, poza patchem');
  });

  it('runda poprawek bez zmian w plikach: opis PR i ponowna recenzja zamiast blokady', () => {
    const { data } = workflows.implement!;
    const publish = data.jobs.publish as { if?: string; steps?: (Step & { if?: string })[] };
    const blocked = data.jobs.blocked as { if?: string };
    assert.match(String(publish.if), /inputs\.pr != '' && needs\.implement\.outputs\.blocker == ''/);
    assert.match(String(blocked.if), /needs\.implement\.outputs\.empty == 'true' && inputs\.pr == ''/);
    const download = publish.steps!.find((step) => step.uses?.startsWith('actions/download-artifact'))!;
    assert.match(String(download.if), /outputs\.empty == 'false'/, 'bez patcha nie ma artefaktu');
    const run = publish.steps!.find((step) => step.run?.includes('pr-body'))!.run!;
    assert.match(
      run,
      /^if \[ "\$EMPTY" != true \] \|\| \[ -n "\$MERGE_SHA" \]; then\n(?: .*\n)*  bash "\$F\/scripts\/workflow\/apply-change\.sh" "\$PATCH" "\$MERGE_SHA"\n(?: .*\n)*fi\n/m,
      'commit tylko z patchem albo scaleniem gałęzi głównej',
    );
    assert.match(run, /-f stage=review -f pr="\$PR"/);
  });

  it('koszt recenzji rundy bez werdyktu trafia do komentarza rundy, a dziennik go czyta', () => {
    const loop = workflows.review!.data.jobs.loop!;
    const downloads = (loop.steps ?? []).filter((step) => step.uses?.startsWith('actions/download-artifact'));
    assert.ok(downloads.some((step) => (step as { with?: { pattern?: string } }).with?.pattern === 'factory-usage-review-*'));
    assert.match(workflows.review!.text, /cli\.ts" loop .*--usage "\$W\/usage" --out "\$W\/round\.md"/);
    assert.match(workflows.journal!.text, /contains\(\\"<!-- factory:round -->\\"\)\) \| \{body\}\]" "\$RUNNER_TEMP\/comments-\$PR\.json" > "\$RAW\/rounds\/\$PR\.json"/);
  });

  it('poprawka w PR zdejmuje z issue etykietę blocked po wcześniejszej blokadzie', () => {
    const run = (workflows.implement!.data.jobs.publish!.steps ?? []).find((step) => step.run?.includes('pr-body'))!.run!;
    assert.match(run, /gh issue edit "\$ISSUE" --remove-label blocked/);
    assert.ok(run.indexOf('--remove-label blocked') > run.indexOf('gh pr edit "$PR" --body-file'), 'dopiero po publikacji poprawki');
  });

  it('komendy bez rozróżniania wielkości liter, z odpowiedzią na nieznaną; /start bez zatrzymania sprawdza kolejkę', () => {
    const { text, data } = workflows.commands!;
    const steps = data.jobs.command!.steps ?? [];
    const parse = steps.find((step) => (step as { id?: string }).id === 'parse')!.run!;
    assert.match(parse, /#Ip' <<<"\$FIRST" \| tr '\[:upper:\]' '\[:lower:\]'/);
    assert.match(parse, /echo "unknown=\$UNKNOWN"/);
    const unknown = steps.find((step) => (step as { name?: string }).name === 'Nieznana komenda') as Step & { if?: string };
    assert.match(String(unknown.if), /steps\.parse\.outputs\.unknown != ''/);
    assert.match(text, /Taśma działa; kolejka sprawdza czekające zadania/);
    assert.match(text, /\/stop\[\[:space:\]:,\.!\]\*##I/, 'powód /stop także przy „/Stop”');
  });

  it('runda bez zmian cytuje wyjaśnienie implementera, a dziennik zbiera /change właściciela', () => {
    assert.match(workflows.implement!.text, /cli\.ts" no-change-comment --implementation "\$RUNNER_TEMP\/implementation\.json" --round "\$NEXT"/);
    assert.doesNotMatch(workflows.implement!.text, /porannym/);
    assert.match(workflows.journal!.text, /> "\$RAW\/changes\/\$PR\.json"/);
  });

  it('rundy po /change właściciela nie liczą się do limitu: etykieta factory:change-N, a pętla i ryzyko liczą rundy automatyczne', () => {
    const implement = workflows.implement!.text;
    assert.match(implement, /'<!-- factory:round -->'\*\) KIND=loop ;;\n\s*'<!-- factory:conflict -->'\*\) KIND=conflict ;;\n\s*\*\) KIND=change ;;/);
    assert.match(implement, /if \[ "\$KIND" = change \]; then[\s\S]*--add-label "factory:change-\$NEXT"/);
    assert.match(implement, /elif \[ "\$KIND" = conflict \]; then[\s\S]*--add-label "factory:conflict-\$NEXT"/);
    const review = workflows.review!.text;
    assert.match(review, /AUTO=\$\(\(ROUND - CHANGES\)\)/);
    assert.match(review, /echo "final=\$\(\[ "\$AUTO" -ge "\$MAX" \]/);
    assert.match(review, /cli\.ts" loop .*--round "\$\{AUTO:-0\}"/);
    assert.match(workflows.risk!.text, /- \(\[\.labels\[\]\.name \| select\(startswith\("factory:change-"\) or startswith\("factory:conflict-"\)\)\] \| length\)/);
    assert.match(review, /select\(startswith\("factory:change-"\) or startswith\("factory:conflict-"\)\)/);
  });

  it('konflikty z gałęzią główną: runda scala ją przed implementerem, zapis robi commit scalenia, kolejka wykrywa konflikt', () => {
    const { text, data } = workflows.implement!;
    const steps = data.jobs.implement!.steps ?? [];
    const sync = steps.find((step) => step.run?.includes('sync-base.sh')) as Step & { if?: string; id?: string };
    assert.equal(sync.id, 'sync');
    assert.match(String(sync.if), /inputs\.pr != ''/, 'tylko w rundzie poprawek otwartego PR');
    const setup = steps.findIndex((step) => step.name === 'Komenda setup z factory.yml');
    const claude = steps.findIndex((step) => step.uses?.startsWith(CLAUDE));
    assert.ok(steps.indexOf(sync) < setup && setup < claude, 'scalenie przed setup i przed implementerem');
    assert.match(text, /merge_sha: \$\{\{ steps\.sync\.outputs\.sha \}\}/);
    assert.match(text, /grep -IlE '\^\(<<<<<<<\|>>>>>>>\)\( \|\$\)'/, 'znacznik konfliktu blokuje publikację');
    const publish = data.jobs.publish as { steps?: (Step & { with?: Record<string, unknown> })[] };
    const checkout = publish.steps!.find((step) => step.uses?.startsWith('actions/checkout') && step.with?.ref !== undefined)!;
    assert.equal(checkout.with!['fetch-depth'], 0, 'scalenie w jobie zapisu potrzebuje historii');
    assert.ok(!usesClaude(data.jobs.publish!), 'commit scalenia bez Claude');
    const queue = workflows.queue!.data.jobs.release!.steps ?? [];
    const conflicts = queue.find((step) => step.run?.includes('conflicts.sh')) as Step & { 'continue-on-error'?: boolean };
    assert.ok(conflicts && conflicts['continue-on-error'], 'błąd wykrywania nie zatrzymuje kolejki');
  });

  it('każdy recenzent dostaje polecenia /change właściciela i kont zaufanych, od najstarszego', () => {
    const review = workflows.review!.text;
    const block = /^ +(jq -rs --arg trusted [\s\S]*?> "\$W\/owner\.md")$/m.exec(review)?.[1];
    assert.ok(block, 'krok zapisuje owner.md');
    const dir = mkdtempSync(join(tmpdir(), 'factory-owner-'));
    try {
      const comments = [
        { login: 'wlasciciel', body: '/change Usuń test pikselowy.\nDruga linia', created_at: '2026-11-14T07:30:12Z' },
        { login: 'github-actions[bot]', body: '<!-- factory:round -->\nuwagi', created_at: '2026-11-14T07:31:00Z' },
        { login: 'obcy', body: '/change zrób coś innego', created_at: '2026-11-14T07:32:00Z' },
        { login: 'pomocnik', body: '/Change, popraw odstęp', created_at: '2026-11-14T07:33:00Z' },
        { login: 'wlasciciel', body: 'Uwaga: /change w środku zdania', created_at: '2026-11-14T07:29:00Z' },
      ];
      writeFileSync(join(dir, 'comments.jsonl'), comments.map((c) => JSON.stringify(c)).join('\n'));
      const run = spawnSync('bash', ['-c', block!.replace(/\\\n\s*/g, ' ')], {
        env: { ...process.env, OWNER: 'wlasciciel', EXTRA: 'pomocnik', RUNNER_TEMP: dir, W: dir },
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(
        readFileSync(join(dir, 'owner.md'), 'utf8'),
        '### 2026-11-14 07:30 UTC\n\n/change Usuń test pikselowy.\nDruga linia\n\n### 2026-11-14 07:33 UTC\n\n/Change, popraw odstęp\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recenzent wyglądu dostaje uwagi, na które odpowiadała runda', () => {
    const review = workflows.review!.text;
    assert.match(review, /> "\$W\/previous-round\.md"/);
    assert.match(review, /if \[ "\$SCREENSHOTS" = true \] && grep -q '\[\^\[:space:\]\]' "\$W\/previous-round\.md" 2>\/dev\/null; then ARGS\+=\(--previous "\$W\/previous-round\.md"\); fi/);
  });

  it('plan tylko dla issue ze specem: notatka z ready wraca bez Claude, /split przechodzi', () => {
    const { data } = workflows.plan!;
    const spec = data.jobs.spec as { if?: string; steps?: Step[]; permissions?: Record<string, string> };
    assert.ok(spec && !usesClaude(data.jobs.spec!), 'strażnik bez sesji Claude');
    const run = spec.steps!.find((step) => step.run?.includes('acceptance'))!.run!;
    assert.match(run, /if \[ "\$NOTE" = split \]; then echo "ok=true"/);
    assert.match(run, /cli\.ts spec "\$RUNNER_TEMP\/issue\.md" \| jq '\.acceptance \| length'/);
    assert.match(run, /--remove-label ready/);
    const plan = data.jobs.plan as { needs?: string[]; if?: string };
    assert.deepEqual(plan.needs, ['guard', 'spec']);
    assert.match(String(plan.if), /needs\.spec\.outputs\.ok == 'true'/);
    assert.match(workflows.plan!.text, /--add-label split\n[\s\S]*--remove-label idea/);
  });

  it('/split za późno, gdy taśma już planuje albo realizuje zadanie', () => {
    const { text } = workflows.commands!;
    assert.match(text, /any\(\.\[\]; \. == "ready"\) or \(any\(\.\[\]; \. == "planned"\) and/);
    assert.match(text, /startswith\(\\"factory\/\$NUMBER-\\"\)/);
    assert.match(text, /Za późno na \\`\/split\\`/);
  });

  it('limit subskrypcji: każdy etap z Claude rozpoznaje go, nie ponawia i zapisuje pauzę zamiast blokady', () => {
    const claudeJobs: [string, string, string][] = [['plan', 'plan', 'plan'], ['implement', 'implement', 'implement'], ['review', 'reviewer', 'review'], ['risk', 'assess', 'review']];
    for (const [file, job, stage] of claudeJobs) {
      const steps = (workflows[file]!.data.jobs[job]!.steps ?? []) as (Step & { id?: string; name?: string; if?: string; 'continue-on-error'?: boolean })[];
      const started = steps.find((step) => step.id === 'started')!;
      assert.ok(started.run!.indexOf('limit-cli.ts" limit') < started.run!.indexOf('cli.ts" started'), `${file}: limit przed ponowną próbą`);
      assert.equal(steps.find((step) => step.id === 'claude_retry')!['continue-on-error'], true, file);
      const limit = steps.findIndex((step) => step.id === 'limit');
      const error = steps.findIndex((step) => step.name === 'Błąd sesji Claude');
      assert.ok(limit >= 0 && limit < error, `${file}: limit przed błędem sesji`);
      assert.match(String(steps[error]!.if), /steps\.limit\.outputs\.limited != 'true'/, file);
      const pause = workflows[file]!.text.includes('limit-pause.sh');
      assert.ok(pause, `${file}: zapis pauzy`);
      assert.match(workflows[file]!.text, new RegExp(`STAGE: ${stage}\\n`), `${file}: wznawiany etap ${stage}`);
    }
    assert.match(String((workflows.plan!.data.jobs.apply as { if?: string }).if), /needs\.plan\.outputs\.limited != 'true'/);
    assert.match(String((workflows.implement!.data.jobs.blocked as { if?: string }).if), /needs\.implement\.outputs\.limited != 'true'/);
    const loop = workflows.review!.data.jobs.loop as { needs?: string[]; if?: string };
    assert.ok(loop.needs!.includes('limit') && /needs\.limit\.outputs\.limited != 'true'/.test(String(loop.if)), 'pętla czeka, gdy recenzent trafił na limit');
    assert.match(workflows.review!.text, /jobs\.limit\.outputs\.limited != 'true'\) && 'true' \|\| 'false'/, 'bez oceny ryzyka');
    assert.match(String((workflows.risk!.data.jobs.rules as { if?: string }).if), /needs\.assess\.outputs\.limited != 'true'/);
    assert.match(String((workflows.pipeline!.data.jobs.merge as { if?: string }).if), /needs\.risk\.outputs\.limited != 'true'/);
  });

  it('po resecie limitu pierwsze zdarzenie taśmy samo zamyka issue limitu i wznawia etapy', () => {
    const line = workflows.pipeline!.data.jobs.line as { steps?: Step[]; permissions?: Record<string, string> };
    const run = line.steps!.find((step) => step.run?.includes('line-state'))!.run!;
    assert.match(run, /limit-cli\.ts line-state --issues/);
    assert.match(run, /if \[ "\$STOPPED" = false \] && \[ -n "\$EXPIRED" \]; then[\s\S]*resume\.sh \$EXPIRED/);
    assert.match(run, /QUEUE=\$\(\[ "\$GITHUB_EVENT_NAME" = schedule \] && echo false \|\| echo true\)/);
    assert.equal(line.permissions?.actions, 'write');
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
    assert.equal((commands.match(/^\s+queue$/gm) ?? []).length, 3, '/approve z zależnościami, /reject i /start bez zatrzymania; po zatrzymaniu kolejkę uruchamia resume.sh');
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
    assert.match(commands, /bash \.factory-src\/scripts\/workflow\/resume\.sh \$STOPS/, '/start wznawia przez wspólny skrypt');
    const resume = readFileSync(new URL('./resume.sh', import.meta.url), 'utf8');
    assert.match(resume, /<!-- factory:paused \(\\\{\[\^<>\]\*\\\}\) -->/, 'wznowienie czyta zapis wstrzymanego etapu');
    assert.match(resume, /--remove-label factory:paused/);
    assert.match(resume, /\^\(plan\|implement\|review\)\$/, 'wejście sprawdzone, zanim trafi do workflow_dispatch');
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
