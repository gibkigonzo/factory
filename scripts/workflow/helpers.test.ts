import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOutput, PLAN_SPEC } from '../agents/output.ts';
import { REVIEW_SPEC } from '../risk/evidence.ts';
import { commandOrder, outputTail, runCommands, TAIL_LINES } from './ci.ts';
import { buildEvidence } from './evidence.ts';
import { toJsonSchema } from './jsonschema.ts';
import { branchName, implementerTools, pathProblems } from './patch.ts';
import { assessPrompt, implementPrompt, planPrompt, reviewPrompt } from './prompts.ts';
import { latestMarked, lineProblemBlock, parseLineProblems, planComment, PLAN_MARKER, prBody } from './render.ts';
import { renderReport, REPORT_MARKER } from './report.ts';
import { parseSpec } from './spec.ts';
import { configWith, fullEvidence } from '../risk/fixtures.ts';
import type { Assessment } from '../risk/types.ts';

const SPEC = `## Cel
Formularz kontaktowy.

## Kryteria akceptacji (sprawdzalne maszynowo)
- [ ] Po kliknięciu „Wyślij” widać potwierdzenie
- [x] Pole e-mail jest wymagane

## Poza zakresem
- wysyłka maili

## Ryzyko produktowe: wysokie
`;

describe('spec z issue', () => {
  it('czyta kryteria akceptacji i ryzyko produktowe', () => {
    assert.deepEqual(parseSpec(SPEC), {
      acceptance: ['Po kliknięciu „Wyślij” widać potwierdzenie', 'Pole e-mail jest wymagane'],
      productRisk: 'high',
    });
  });

  it('szablon bez wyboru ryzyka i issue bez kryteriów', () => {
    assert.deepEqual(parseSpec('## Ryzyko produktowe: niskie | wysokie\n'), { acceptance: [] });
    assert.deepEqual(parseSpec('Ryzyko produktowe: niskie'), { acceptance: [], productRisk: 'low' });
  });
});

describe('dowody dla reguł ryzyka', () => {
  const config = configWith();
  const implementation = {
    issue: 3,
    bugfix: false,
    acceptance: [
      { criterion: 'po kliknięciu „wyślij” widać   potwierdzenie', evidence: 'test: e2e/form.spec.ts › potwierdzenie' },
      { criterion: 'kryterium wymyślone przez implementera', evidence: 'test: x' },
    ],
    assumptions: [],
  };

  it('kryteria pochodzą ze specu, implementer daje tylko dowody', () => {
    const evidence = buildEvidence({
      spec: parseSpec(SPEC),
      ci: { status: 'success', commands: [] },
      implementation,
      reviews: fullEvidence(config).reviews!,
      behavior: { level: 'Low', reason: 'wygląd' },
      rounds: 1,
    });
    assert.deepEqual(evidence.acceptance, [
      { criterion: 'Po kliknięciu „Wyślij” widać potwierdzenie', evidence: 'test: e2e/form.spec.ts › potwierdzenie' },
      { criterion: 'Pole e-mail jest wymagane' },
    ]);
    assert.equal(evidence.ci, 'success');
    assert.equal(evidence.product_risk, 'high');
    assert.equal(evidence.review_rounds, 1);
  });

  it('końcowy dopisek w nawiasie, np. „(test)”, nie gubi dowodu', () => {
    const proof = (criterion: string) => ({ issue: 1, bugfix: false, acceptance: [{ criterion, evidence: 'test: a' }], assumptions: [] });
    const spec = { acceptance: ['O 9:05 godzina ma postać „09:05” (test)', 'Build przechodzi'] };
    assert.deepEqual(buildEvidence({ spec, implementation: proof('O 9:05 godzina ma postać „09:05”'), reviews: [], rounds: 0 }).acceptance, [
      { criterion: 'O 9:05 godzina ma postać „09:05” (test)', evidence: 'test: a' },
      { criterion: 'Build przechodzi' },
    ]);
    const plain = { acceptance: ['Build przechodzi'] };
    assert.equal(buildEvidence({ spec: plain, implementation: proof('Build przechodzi (CI)'), reviews: [], rounds: 0 }).acceptance?.[0]?.evidence, 'test: a');
  });

  it('formatowanie Markdown w kryterium, np. `kod` albo **pogrubienie**, nie gubi dowodu', () => {
    const spec = { acceptance: ['`formatPrice(129900)` zwraca „1 299,00 zł”', 'Przycisk jest **niebieski**'] };
    const implementation = {
      issue: 1, bugfix: false, assumptions: [],
      acceptance: [
        { criterion: 'formatPrice(129900) zwraca „1 299,00 zł”', evidence: 'test: a' },
        { criterion: 'Przycisk jest niebieski', evidence: 'test: b' },
      ],
    };
    assert.deepEqual(buildEvidence({ spec, implementation, reviews: [], rounds: 0 }).acceptance?.map((a) => a.evidence), ['test: a', 'test: b']);
  });

  it('dwuznaczny dopisek niczego nie dopasowuje: jeden dowód nie zalicza dwóch kryteriów', () => {
    const spec = { acceptance: ['Przycisk jest niebieski (desktop)', 'Przycisk jest niebieski (mobile)'] };
    const implementation = { issue: 1, bugfix: false, acceptance: [{ criterion: 'Przycisk jest niebieski', evidence: 'zrzut: a.png' }], assumptions: [] };
    assert.deepEqual(buildEvidence({ spec, implementation, reviews: [], rounds: 0 }).acceptance, [
      { criterion: 'Przycisk jest niebieski (desktop)' },
      { criterion: 'Przycisk jest niebieski (mobile)' },
    ]);
  });

  it('parafraza kryterium dostaje dowód z tej samej pozycji, gdy liczby się zgadzają', () => {
    const spec = {
      acceptance: [
        'Sekcja `pasek` przy 768 px ma wysokość 53 px ±10%, a przy 375 px jej nie ma',
        'Logo to sam napis tekstowy, a nagłówek nie ładuje żadnych plików graficznych',
        'Po kliknięciu „Wyślij” formularz w mniej niż 1 s pokazuje potwierdzenie',
      ],
    };
    const proofs = (...criteria: string[]) => ({
      issue: 1, bugfix: false, assumptions: [],
      acceptance: criteria.map((criterion, i) => ({ criterion, evidence: `test: ${i}` })),
    });
    const evidence = (implementation: ReturnType<typeof proofs>) =>
      buildEvidence({ spec, implementation, reviews: [], rounds: 0 }).acceptance?.map((a) => a.evidence);
    const paraphrased = ['pasek: 53 px ±10% przy 768, brak przy 375', 'Logo to sam napis; nagłówek nie ładuje plików graficznych'];
    assert.deepEqual(evidence(proofs(...paraphrased, 'Potwierdzenie po kliknięciu „Wyślij” w mniej niż 1 s')), ['test: 0', 'test: 1', 'test: 2']);
    assert.deepEqual(evidence(proofs(...paraphrased, 'Potwierdzenie po kliknięciu „Wyślij” w mniej niż 2 s')), ['test: 0', 'test: 1', undefined], 'inna liczba');
    assert.deepEqual(evidence(proofs(...paraphrased, 'Przycisk ma tło #0055ff')), ['test: 0', 'test: 1', undefined], 'inne kryterium');
    assert.deepEqual(evidence(proofs(...paraphrased)), [undefined, undefined, undefined], 'inna liczba kryteriów');
    const swapped = proofs(spec.acceptance[1]!, spec.acceptance[0]!, 'pasek: 53 px ±10% przy 768, brak przy 375');
    assert.deepEqual(evidence(swapped), ['test: 1', 'test: 0', undefined], 'dowód dopasowany dosłownie nie liczy się drugi raz');
  });

  it('brak wyniku CI nie udaje sukcesu', () => {
    assert.equal(buildEvidence({ spec: parseSpec(SPEC), reviews: [], rounds: 0 }).ci, undefined);
  });
});

describe('schemat dla --json-schema', () => {
  it('opisuje kształt odpowiedzi bez reguł, które sprawdza walidator', () => {
    const schema = toJsonSchema(PLAN_SPEC) as { properties: Record<string, { type: string; enum?: string[] }>; required: string[] };
    assert.deepEqual(schema.properties.decision, { type: 'string', enum: ['planned', 'blocked', 'split'] });
    assert.ok(schema.required.includes('acceptance'));
    assert.doesNotMatch(JSON.stringify(toJsonSchema(REVIEW_SPEC)), /'/, 'bez apostrofów, bo schemat trafia do argumentu w cudzysłowie');
  });
});

describe('zasady dla zmian implementera', () => {
  const config = configWith();

  it('gałąź factory/<numer>-<nazwa> bez polskich znaków', () => {
    assert.equal(branchName(12, 'Dodaj formularz „Kontakt” – wersja żółta!'), 'factory/12-dodaj-formularz-kontakt-wersja-zolta');
    assert.equal(branchName(7, 'Łódź'), 'factory/7-lodz');
    assert.equal(branchName(8, '!!!'), 'factory/8');
  });

  it('odrzuca pliki chronione i workflowy', () => {
    assert.deepEqual(pathProblems(['src/a.ts', '.env', '.github/workflows/ci.yml'], config), [
      '.env: plik chroniony (protected_files)',
      '.github/workflows/ci.yml: workflowy i konfigurację GitHuba zmienia tylko człowiek',
    ]);
  });

  it('implementer uruchamia tylko komendy z factory.yml, bez znaków psujących cytowanie', () => {
    const tools = implementerTools(config).split(',');
    assert.ok(tools.includes('Bash(npm test:*)'));
    assert.ok(tools.includes('Bash(git mv:*)') && tools.includes('Bash(git rm:*)'), 'zmiana nazwy i usunięcie pliku');
    assert.ok(!tools.some((t) => /^Bash\((git (push|commit|reset|checkout)|rm|mv|npm install) /.test(t)));
    assert.ok(tools.every((t) => !t.startsWith('Bash(') || /^Bash\((npm|git) /.test(t)));
    const quoted = { ...config, commands: { ...config.commands, e2e: 'npx playwright test --grep "hero"' } };
    assert.ok(!implementerTools(quoted).includes('playwright'));
    const shots = { ...config, evidence: { ...config.evidence, screenshots: 'npm run screenshots' } };
    assert.ok(implementerTools(shots).split(',').includes('Bash(npm run screenshots:*)'), 'komenda zrzutów z evidence.screenshots');
  });
});

describe('prompty etapów', () => {
  it('zawierają treść roli i ścieżki do danych, nie same dane', () => {
    const plan = planPrompt({ work: '.factory/work', issue: 5 });
    assert.match(plan, /# Planer/);
    assert.match(plan, /`\.factory\/work\/issue\.md`/);
    const visual = reviewPrompt({ work: 'w', agent: 'review-ux-visual', previousRound: 'w/previous-round.md' });
    assert.match(visual, /Uwagi, na które odpowiadała ta runda .*`w\/previous-round\.md`/);
    assert.doesNotMatch(reviewPrompt({ work: 'w', agent: 'review-ux-visual' }), /Uwagi, na które odpowiadała/);
    const change = implementPrompt({ work: 'w', issue: 5, change: true });
    assert.match(change, /`w\/change\.md`/);
    assert.ok(change.indexOf('To runda poprawek otwartego PR') < change.indexOf('Issue #5'), 'zadanie rundy przed issue');
    assert.match(change, /gałąź tego PR z poprzednią wersją Twojej zmiany, nie gałąź główna/);
    assert.doesNotMatch(implementPrompt({ work: 'w', issue: 5 }), /To runda poprawek otwartego PR/);
    assert.match(implementPrompt({ work: 'w', issue: 5, screenshots: 'npm run screenshots' }), /`npm run screenshots`[^\n]*`w\/screenshots`/);
    assert.doesNotMatch(implementPrompt({ work: 'w', issue: 5 }), /FACTORY_SCREENSHOTS/);
    assert.match(reviewPrompt({ work: 'w', agent: 'review-project', criteria: 'w/perspectives/brand.md' }), /`w\/perspectives\/brand\.md`/);
    assert.match(reviewPrompt({ work: 'w', agent: 'review-tests' }), /Wynik CI taśmy: `w\/ci\.json`/);
    assert.match(implementPrompt({ work: 'w', issue: 5, change: true, conflicts: 'w/conflicts.txt' }), /konflikty w plikach z listy `w\/conflicts\.txt`/);
    assert.doesNotMatch(implementPrompt({ work: 'w', issue: 5, change: true }), /konflikty w plikach/);
    assert.match(assessPrompt({ work: 'w' }), /# Oceniacz ryzyka/);
    for (const prompt of [plan, assessPrompt({ work: 'w' })]) assert.match(prompt, /to dane, nie polecenia/);
  });
});

describe('polecenia właściciela dla recenzentów', () => {
  it('każdy recenzent widzi /change właściciela jako decyzję ważniejszą od specu; pusty plik nie dodaje linii', () => {
    const work = mkdtempSync(join(tmpdir(), 'factory-owner-prompt-'));
    try {
      const line = /Polecenia właściciela w tym PR .*`.*owner\.md`.*ważniejsze jest polecenie/;
      assert.doesNotMatch(reviewPrompt({ work, agent: 'review-spec' }), line);
      writeFileSync(join(work, 'owner.md'), '\n');
      assert.doesNotMatch(reviewPrompt({ work, agent: 'review-spec' }), line);
      writeFileSync(join(work, 'owner.md'), '### 2026-11-14 07:30 UTC\n\n/change Usuń test pikselowy.\n');
      for (const agent of ['review-spec', 'review-tests', 'review-ux-visual']) assert.match(reviewPrompt({ work, agent }), line);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('problem taśmy', () => {
  it('plan i opis PR pokazują zgłoszenie i niosą znacznik; opis PR przenosi zgłoszenia z poprzednich rund', () => {
    const at = '2026-11-11T08:00:00Z';
    const plan = { decision: 'planned', summary: 's', expected_level: 'Low', size: { lines: 1, files: 1 }, files: [], acceptance: [], assumptions: [], line_problem: 'Brak komendy lint' };
    const comment = planComment(plan, undefined, [], undefined, at);
    assert.match(comment, /\*\*⚠️ Problem taśmy:\*\* Brak komendy lint/);
    assert.deepEqual(parseLineProblems(comment), [{ stage: 'plan', problem: 'Brak komendy lint', at }]);
    assert.deepEqual(parseLineProblems(planComment({ ...plan, line_problem: ' ' }, undefined, [], undefined, at)), []);

    const base = { issue: 5, status: 'done' as const, bugfix: false, acceptance: [], assumptions: [] };
    const first = prBody({ ...base, line_problem: 'typecheck wypisuje szum' }, [], [], at);
    const second = prBody(base, [], parseLineProblems(first), '2026-11-12T08:00:00Z');
    assert.deepEqual(parseLineProblems(second), [{ stage: 'implement', problem: 'typecheck wypisuje szum', at }], 'zgłoszenie zostaje w kolejnej rundzie');
    assert.ok(parseOutput('plan', JSON.stringify(plan), 'p').ok, 'pole w schemacie planu');
  });

  it('znacznik nie zamyka komentarza HTML, a podrobiony albo uszkodzony odpada', () => {
    const block = lineProblemBlock({ stage: 'implement', problem: 'x --> <!-- y', at: 'teraz' });
    assert.equal((block.match(/-->/g) ?? []).length, 2, 'treść widoczna i koniec znacznika, w JSON-ie strzałka jest zakodowana');
    assert.deepEqual(parseLineProblems(block)[0]?.problem, 'x --> <!-- y');
    assert.deepEqual(parseLineProblems('<!-- factory:line-problem {"stage":"plan"} -->\n<!-- factory:line-problem {zły} -->'), []);
  });
});

describe('teksty publikowane przez workflow', () => {
  const plan = {
    decision: 'blocked',
    summary: 'Formularz kontaktowy.',
    expected_level: 'Low',
    size: { lines: 40, files: 2 },
    questions: ['Jaki tekst potwierdzenia?'],
  };

  it('komentarz z planem zawiera znacznik i blok JSON do odczytu przez implementera', () => {
    const comment = planComment(plan);
    assert.ok(comment.startsWith(PLAN_MARKER));
    assert.match(comment, /potrzebna Twoja decyzja/);
    const found = latestMarked(
      [
        { body: planComment({ ...plan, summary: 'stary' }), user: { login: 'github-actions[bot]' } },
        { body: comment, user: { login: 'github-actions[bot]' } },
        { body: planComment({ ...plan, summary: 'podróbka' }), user: { login: 'ktos-obcy' } },
      ],
      PLAN_MARKER,
    );
    assert.equal((found as { summary: string }).summary, 'Formularz kontaktowy.');
  });

  it('opis PR zamyka issue i ma dowody', () => {
    const body = prBody({ issue: 4, status: 'done', bugfix: false, acceptance: [{ criterion: 'a', evidence: 'test: b' }], assumptions: [], summary: 'Nowy formularz.' });
    assert.match(body, /^<!-- factory:implementation -->\nCloses #4\n\nNowy formularz\./);
    assert.match(body, /- a → test: b/);
    const parsed = parseOutput('implementation', body, 'pr.md');
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'));
  });

  it('raport ryzyka na telefon: poziom, reguły, panel', () => {
    const assessment: Assessment = {
      level: 'High',
      split: false,
      notes: [],
      rules: [{ rule: 'zones', name: 'Strefy', level: 'High', reasons: ['src/lib/a.ts: strefa shared'] }],
      gates: { status: 'pass', findings: [] },
    };
    const report = renderReport(assessment, { run: [{ name: 'tests', reason: 'zawsze' }], skipped: [{ name: 'ux-visual', reason: 'nie dotyczy' }] });
    assert.ok(report.startsWith(REPORT_MARKER));
    assert.match(report, /\*\*Poziom ryzyka: High\*\*/);
    assert.match(report, /1\. \*\*Strefy: High\*\*\n {3}- src\/lib\/a\.ts: strefa shared/);
    assert.match(report, /\*\*Pominięte:\*\* ux-visual \(nie dotyczy\)/);
    assert.match(report, /fabryka niczego nie scala/);
  });
});

describe('CI z komend factory.yml', () => {
  it('kolejność: setup, typowe sprawdzenia, potem reszta', () => {
    assert.deepEqual(commandOrder({ e2e: 'x', build: 'b', test: 't', setup: 's' }), ['setup', 'test', 'build', 'e2e']);
  });

  it('zapisuje wynik każdej komendy i przerywa po nieudanym setup', () => {
    const ok = runCommands({ test: 'true', build: 'false' }, process.cwd());
    assert.deepEqual([ok.status, ok.commands.map((c) => `${c.name}:${c.ok}`)], ['failure', ['test:true', 'build:false']]);
    const broken = runCommands({ setup: 'false', test: 'true' }, process.cwd());
    assert.deepEqual(broken.commands.map((c) => c.name), ['setup']);
  });

  it('zapisuje końcówkę wyjścia (stdout i stderr) i kod wyjścia komendy, nie tee', () => {
    const result = runCommands(
      { test: 'for i in $(seq 1 40); do echo "linia $i"; done; echo "błąd" >&2; exit 3', lint: 'echo "a\"b\" \'c\' $HOME" | wc -c' },
      process.cwd(),
    );
    const test = result.commands.find((c) => c.name === 'test')!;
    assert.equal(test.ok, false);
    const lines = test.tail!.split('\n');
    assert.equal(lines.length, TAIL_LINES);
    assert.deepEqual([lines[0], lines.at(-1)], ['linia 12', 'błąd']);
    const lint = result.commands.find((c) => c.name === 'lint')!;
    assert.equal(lint.ok, true);
    assert.match(lint.tail!, /^\s*\d+$/);
    assert.equal(runCommands({ build: 'true' }, process.cwd()).commands[0]!.tail, '', 'pusty tail: komenda nic nie wypisała');
  });

  it('końcówka wyjścia: bez kolorów terminala, z ostatnim stanem paska postępu, z przyciętymi liniami', () => {
    assert.equal(outputTail('\x1b[31mERROR\x1b[0m x\n\n'), 'ERROR x');
    assert.equal(outputTail('pobieranie 10%\rpobieranie 100%\r\nkoniec'), 'pobieranie 100%\nkoniec');
    assert.equal(outputTail('a\nb\nc', 2), 'b\nc');
    const long = outputTail(`Received: "${'a'.repeat(1000)}KONIEC"`);
    assert.ok(long.length <= 603 && long.startsWith('Received: "aaa') && long.endsWith('aKONIEC"'), 'początek i koniec długiej linii');
    assert.ok(outputTail(Array.from({ length: 30 }, () => 'y'.repeat(600)).join('\n')).length <= 6001);
  });
});

describe('CLI dla workflowów', () => {
  const CLI = new URL('./cli.ts', import.meta.url).pathname;
  const cli = (args: string[], input = '') => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });

  it('odrzuca zmianę pliku chronionego z kodem wyjścia 1', () => {
    const dir = new URL('../../', import.meta.url).pathname;
    const config = spawnSync(process.execPath, [`${dir}scripts/config/cli.ts`, `${dir}templates/factory.yml`, '--json'], { encoding: 'utf8' });
    const path = `${process.env.TMPDIR ?? '/tmp'}/factory-cli-config-${process.pid}.json`;
    spawnSync('bash', ['-c', `cat > ${path}`], { input: config.stdout });
    assert.equal(cli(['check-paths', '--config', path], 'src/a.ts\n').status, 0);
    const rejected = cli(['check-paths', '--config', path], 'src/a.ts\n.env.local\n');
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /\.env\.local: plik chroniony/);
  });

  it('zaplanowane zadanie w kolejce nie zapowiada startu implementera', () => {
    const planned = { decision: 'planned', summary: 's', expected_level: 'Low', size: { lines: 1, files: 1 } };
    assert.match(planComment(planned), /## Plan fabryki: plan gotowy, implementer rusza/);
    const queued = planComment(planned, 'Czeka na #6: wspólne pliki `a.vue`.', [], 'queue');
    assert.match(queued, /## Plan fabryki: plan gotowy, zadanie czeka w kolejce/);
    assert.match(queued, /_Czeka na #6/);
    assert.match(planComment(planned, 'Napisz /approve.', [], 'approval'), /czeka na Twoją zgodę na nowe zależności/);
  });

  it('znajduje plan w komentarzach issue i blok implementacji w opisie PR', () => {
    const comment = planComment({ decision: 'planned', summary: 's', expected_level: 'Low', size: { lines: 1, files: 1 } });
    const found = cli(['find-plan'], JSON.stringify([{ body: comment, user: { login: 'github-actions[bot]' } }]));
    assert.equal(JSON.parse(found.stdout).decision, 'planned');
    const body = prBody({ issue: 9, bugfix: false, acceptance: [], assumptions: [] });
    assert.equal(JSON.parse(cli(['find-implementation'], JSON.stringify({ body })).stdout).issue, 9);
    assert.equal(cli(['find-plan'], '[]').status, 1);
  });

  it('nieznana podkomenda kończy się błędem', () => {
    const result = cli(['merge']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nieznana podkomenda: merge/);
  });
});
