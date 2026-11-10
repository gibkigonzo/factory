import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseOutput } from '../agents/output.ts';
import { decodePng, encodePng } from './png.ts';
import { reviewPrompt } from './prompts.ts';
import {
  collectScreenshots,
  compareScreenshots,
  galleryComment,
  INDEX,
  MAX_FILES,
  runScreenshots,
  screenshotsTask,
  SCREENSHOTS_MARKER,
  unchangedVerdict,
  writeGallery,
} from './screenshots.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const temp = () => mkdtempSync(join(tmpdir(), 'factory-shots-'));
/** Prawdziwy PNG w jednolitym kolorze: porównanie pikseli i składanie obrazów go odczytują. */
const image = (shade: number, width = 4, height = 4) => encodePng({ width, height, data: Buffer.alloc(width * height * 4, shade * 25).fill(255, 3, 4) });
/** Katalog zrzutów z plikiem INDEX udanej komendy. */
const shots = (dir: string, files: Record<string, Buffer>) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  if (!existsSync(join(dir, INDEX))) writeFileSync(join(dir, INDEX), '{"ok":true}');
};
const cli = (...args: string[]) => spawnSync(process.execPath, [new URL('./cli.ts', import.meta.url).pathname, ...args], { encoding: 'utf8' });

describe('zrzuty ekranu', () => {
  it('łączy wykonanie i wzorzec w pary po nazwie i szerokości, w kolejności nazw i szerokości', () => {
    const dir = temp();
    try {
      for (const f of ['newsletter@768.png', 'newsletter@375.ref.png', 'newsletter@375.png', 'footer@1440.ref.png', 'hero.png']) writeFileSync(join(dir, f), PNG);
      assert.deepEqual(collectScreenshots(dir), {
        shots: [
          { name: 'footer', width: 1440, reference: 'footer@1440.ref.png' },
          { name: 'hero', actual: 'hero.png' },
          { name: 'newsletter', width: 375, actual: 'newsletter@375.png', reference: 'newsletter@375.ref.png' },
          { name: 'newsletter', width: 768, actual: 'newsletter@768.png' },
        ],
        rejected: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('odrzuca i usuwa pliki spoza wzorca nazw, nie-PNG, katalogi i dowiązania; plik INDEX zostaje', () => {
    const dir = temp();
    try {
      writeFileSync(join(dir, 'ok@375.png'), PNG);
      writeFileSync(join(dir, 'Zły plik.png'), PNG);
      writeFileSync(join(dir, 'fake@375.png'), 'GIF89a');
      writeFileSync(join(dir, 'notes.txt'), 'x');
      mkdirSync(join(dir, 'sub'));
      symlinkSync('/etc/passwd', join(dir, 'link@375.png'));
      writeFileSync(join(dir, INDEX), '{"ok":true}');
      const { shots, rejected } = collectScreenshots(dir);
      assert.deepEqual(shots, [{ name: 'ok', width: 375, actual: 'ok@375.png' }]);
      assert.deepEqual(
        rejected.map((r) => r.file),
        ['Zły plik.png', 'fake@375.png', 'link@375.png', 'notes.txt', 'sub'],
      );
      assert.deepEqual(readdirSync(dir).sort(), [INDEX, 'ok@375.png']);
      assert.match(rejected.find((r) => r.file === 'fake@375.png')!.reason, /nie PNG/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bez usuwania tylko sprawdza, a ponad limit plików odrzuca resztę', () => {
    const dir = temp();
    try {
      for (let i = 0; i < MAX_FILES + 2; i++) writeFileSync(join(dir, `s${String(i).padStart(3, '0')}.png`), PNG);
      const { shots, rejected } = collectScreenshots(dir, false);
      assert.equal(shots.length, MAX_FILES);
      assert.equal(rejected.length, 2);
      assert.equal(readdirSync(dir).length, MAX_FILES + 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('komenda projektu dostaje katalog w FACTORY_SCREENSHOTS, a wynik trafia do INDEX', () => {
    const dir = temp();
    try {
      const out = join(dir, 'shots');
      const command = `printf '\\211PNG\\r\\n\\032\\n' > "$FACTORY_SCREENSHOTS/a@375.png"; echo log`;
      assert.deepEqual(runScreenshots(command, out, dir), { ok: true, shots: [{ name: 'a', width: 375, actual: 'a@375.png' }], rejected: [] });
      assert.equal(JSON.parse(readFileSync(join(out, INDEX), 'utf8')).ok, true);
      assert.equal(runScreenshots('exit 3', out, dir).ok, false, 'czerwona komenda');
      assert.deepEqual(readdirSync(out), [INDEX], 'każde uruchomienie zaczyna od pustego katalogu');
      assert.equal(runScreenshots(command, out, dir, { setup: 'exit 1' }).ok, false, 'nieudany setup: bez zrzutów');
      assert.deepEqual(readdirSync(out), [INDEX]);
      assert.equal(runScreenshots(command, out, dir, { setup: 'true' }).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('porównanie z gałęzią bazową: zmienione, nowe, bez zmian i usunięte sekcje; bez bazy brak oceny', () => {
    const dir = temp();
    try {
      const head = join(dir, 'head');
      const base = join(dir, 'base');
      shots(head, { 'a@375.png': image(1), 'a@375.ref.png': image(9), 'b@375.png': image(2), 'c@375.png': image(3), 'e@375.ref.png': image(9) });
      shots(base, { 'a@375.png': image(1), 'b@375.png': image(5), 'd@375.png': image(4), 'e@375.png': image(4) });
      const compared = compareScreenshots(head, base, false);
      assert.equal(compared.base, true);
      assert.deepEqual(
        compared.shots.map((s) => `${s.name}:${s.change}`),
        ['a:unchanged', 'b:changed', 'c:new', 'd:removed', 'e:removed'],
      );
      assert.equal(compareScreenshots(head, join(dir, 'brak'), false).base, false, 'bez zrzutów bazy');
      writeFileSync(join(base, INDEX), '{"ok":false}');
      assert.equal(compareScreenshots(head, base, false).base, false, 'czerwona komenda na bazie');
      writeFileSync(join(base, INDEX), '{"ok":true}');
      writeFileSync(join(head, INDEX), '{"ok":false}');
      assert.equal(compareScreenshots(head, base, false).base, false, 'czerwona komenda po zmianie');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recenzent wyglądu dostaje tylko zmienione sekcje; bez komendy zrzutów prompt o nich milczy', () => {
    const dir = temp();
    try {
      const head = join(dir, 'screenshots');
      const base = join(dir, 'screenshots-base');
      assert.deepEqual(screenshotsTask(head, base), []);
      mkdirSync(head);
      assert.deepEqual(screenshotsTask(head, base), [], 'pusty katalog z pobrania artefaktu');
      writeFileSync(join(head, INDEX), '{"ok":false}');
      assert.match(screenshotsTask(head, base)[0]!, /zakończyła się błędem i nie zostawiła żadnego zrzutu/);

      writeFileSync(join(head, INDEX), '{"ok":true}');
      shots(head, { 'newsletter@375.png': image(1), 'newsletter@375.ref.png': image(9), 'footer@375.png': image(2), 'footer@375.ref.png': image(9) });
      const [all] = screenshotsTask(head, base);
      assert.match(all!, /Porównanie z gałęzią główną się nie udało/);
      assert.ok(all!.includes(`  - footer, 375 px: wykonanie \`${head}/footer@375.png\`, wzorzec \`${head}/footer@375.ref.png\``));

      shots(base, { 'newsletter@375.png': image(5), 'footer@375.png': image(2) });
      const [changed] = screenshotsTask(head, base);
      assert.ok(changed!.includes(`  - newsletter, 375 px: wykonanie \`${head}/newsletter@375.png\``));
      assert.ok(!changed!.includes('footer@375.png'), 'sekcja bez zmian poza spisem');
      assert.match(changed!, /1 zrzut jest identyczny jak przed zmianą/);
      assert.ok(reviewPrompt({ work: dir, agent: 'review-ux-visual' }).includes(`\`${head}/newsletter@375.png\``));
      assert.equal(unchangedVerdict(head, base, 'ux-visual'), undefined, 'wygląd się zmienił: ocenia recenzent');

      shots(base, { 'newsletter@375.png': image(1) });
      assert.match(screenshotsTask(head, base)[0]!, /Wszystkie zrzuty z CI \(2\) są identyczne/);
      const verdict = unchangedVerdict(head, base, 'ux-visual')!;
      assert.equal(verdict.verdict, 'approve');
      assert.ok(parseOutput('verdict', JSON.stringify(verdict), 'v').ok, 'werdykt zgodny ze schematem');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('galeria: linki do obrazów wzorzec|wykonanie, zmienione sekcje na wierzchu, reszta zwinięta', () => {
    const dir = temp();
    try {
      const head = join(dir, 'head');
      const base = join(dir, 'base');
      const out = join(dir, 'publish');
      shots(head, { 'newsletter@375.png': image(1, 3, 2), 'newsletter@375.ref.png': image(9, 3, 2), 'hero@375.png': image(2), 'hero@768.png': image(2), 'logo.ref.png': image(9) });
      shots(base, { 'newsletter@375.png': image(5, 3, 2), 'hero@375.png': image(2), 'hero@768.png': image(2), 'stopka@375.png': image(7) });
      const compared = compareScreenshots(head, base);
      const files = writeGallery(compared, head, out);
      assert.deepEqual(readdirSync(out).sort(), ['hero@375.png', 'hero@768.png', 'logo.ref.png', 'newsletter@375.png']);
      const pair = decodePng(readFileSync(join(out, 'newsletter@375.png')));
      assert.deepEqual([pair.width, pair.height], [3 + 12 + 3, 2], 'wzorzec obok wykonania');
      assert.deepEqual([...pair.data.subarray(0, 4)], [225, 225, 225, 255], 'wzorzec po lewej');

      const url = (file: string) => `https://example.test/x/${encodeURIComponent(file)}`;
      const comment = galleryComment({ ...compared, ok: false, rejected: [{ file: '[x](http://e)`|.gif', reason: 'to nie PNG' }] }, files, { url, sha: 'abcdef1234567', runUrl: 'https://example.test/run/1' });
      assert.ok(comment.startsWith(SCREENSHOTS_MARKER));
      assert.doesNotMatch(comment, /<img/, 'bez obrazów w treści: repo prywatne');
      assert.match(comment, /Commit `abcdef1`/);
      assert.match(comment, /komenda zrzutów zakończyła się błędem[^\n]*\[przebieg\]\(https:\/\/example\.test\/run\/1\)/i);
      assert.ok(comment.indexOf('**Zmienione względem gałęzi głównej (2):**') < comment.indexOf('<details><summary>Bez zmian: 2 zrzuty</summary>'));
      assert.ok(comment.indexOf('<details><summary>Bez zmian') < comment.indexOf('<details><summary>Sekcji jeszcze nie ma na stronie (sam wzorzec): 1</summary>'));
      assert.ok(comment.includes('- newsletter: [375 px](https://example.test/x/newsletter%40375.png)'));
      assert.ok(comment.includes('- stopka: 375 px: sekcji już nie ma'));
      assert.ok(comment.includes('- hero: [375 px](https://example.test/x/hero%40375.png) (tylko wykonanie) · [768 px]'));
      assert.ok(comment.includes('- logo: [obraz](https://example.test/x/logo.ref.png) (tylko wzorzec)'));
      assert.ok(comment.includes('`?x??http???e???.gif` (to nie PNG)'));

      const same = compareScreenshots(head, head, false);
      assert.match(galleryComment(same, files, { url, sha: 'abc1234' }), /\*\*Wygląd bez zmian względem gałęzi głównej\.\*\*/);
      const noBase = compareScreenshots(head, undefined, false);
      assert.match(galleryComment(noBase, files, { url, sha: 'abc1234' }), /Porównanie z gałęzią główną się nie udało, więc lista obejmuje wszystkie zrzuty\.\n\n- hero:/);
      assert.match(galleryComment({ shots: [], rejected: [], base: false }, new Map(), { url, sha: 'abc1234' }), /nie zostawiła żadnego zrzutu/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLI: bez evidence.screenshots nic nie robi, galeria sprawdza pliki od nowa, werdykt bez modelu tylko bez zmian', () => {
    const dir = temp();
    try {
      writeFileSync(join(dir, 'none.json'), JSON.stringify({ commands: {}, evidence: { preview_deploy: false } }));
      assert.deepEqual(JSON.parse(cli('screenshots', '--config', join(dir, 'none.json'), '--out', join(dir, 'shots')).stdout), { configured: false });
      assert.ok(!existsSync(join(dir, 'shots')));

      const command = `printf '\\211PNG\\r\\n\\032\\n' > "$FACTORY_SCREENSHOTS/a@375.png"; echo "log komendy"`;
      writeFileSync(join(dir, 'set.json'), JSON.stringify({ commands: { setup: 'echo "log setup"' }, evidence: { screenshots: command } }));
      const run = cli('screenshots', '--setup', '--config', join(dir, 'set.json'), '--out', join(dir, 'shots'));
      assert.deepEqual(JSON.parse(run.stdout), { configured: true, ok: true, shots: 1, rejected: 0 }, 'wyjście komend nie miesza się z JSON');
      assert.match(run.stderr, /log setup[\s\S]*log komendy/);

      writeFileSync(join(dir, 'shots', 'evil.sh'), '#!/bin/sh');
      const gallery = cli('gallery', '--dir', join(dir, 'shots'), '--publish', join(dir, 'publish'), '--url', 'https://example.test/x/', '--sha', 'abc1234', '--out', join(dir, 'gallery.md'));
      assert.equal(gallery.status, 0, gallery.stderr);
      assert.ok(!existsSync(join(dir, 'shots', 'evil.sh')));
      assert.deepEqual(readdirSync(join(dir, 'publish')), ['a@375.png']);
      assert.match(readFileSync(join(dir, 'gallery.md'), 'utf8'), /\[375 px\]\(https:\/\/example\.test\/x\/a%40375\.png\)/);

      const work = join(dir, 'work');
      shots(join(work, 'screenshots'), { 'a@375.png': image(1) });
      shots(join(work, 'screenshots-base'), { 'a@375.png': image(1) });
      const same = cli('screenshots-unchanged', '--work', work, '--name', 'ux-visual');
      assert.equal(same.status, 0, same.stderr);
      assert.equal(JSON.parse(same.stdout).perspective, 'ux-visual');
      shots(join(work, 'screenshots-base'), { 'a@375.png': image(2) });
      assert.equal(cli('screenshots-unchanged', '--work', work, '--name', 'ux-visual').status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gałąź ze zrzutami: jeden commit, tylko otwarte PR i najnowszy commit każdego z nich', () => {
    const dir = temp();
    const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' }).stdout.trim();
    try {
      const remote = join(dir, 'remote.git');
      git('init', '-q', '--bare', remote);
      const shots = (name: string, ...files: string[]) => {
        mkdirSync(join(dir, name));
        for (const f of files) writeFileSync(join(dir, name, f), PNG);
        writeFileSync(join(dir, name, INDEX), '{}');
        return join(dir, name);
      };
      const push = (src: string, pr: string, sha: string, open: string) => {
        const run = spawnSync('bash', [new URL('./gallery-push.sh', import.meta.url).pathname, remote, src, pr, sha, open], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
      };
      const tree = () => git('--git-dir', remote, 'ls-tree', '-r', '--name-only', 'factory-screenshots').split('\n');
      push(shots('a', 'x@375.png', 'x@375.ref.png'), '13', 'aaaaaaa', '13 14');
      push(shots('b', 'y@768.png'), '14', 'bbbbbbb', '13 14');
      assert.deepEqual(tree(), ['pr-13/aaaaaaa/x@375.png', 'pr-13/aaaaaaa/x@375.ref.png', 'pr-14/bbbbbbb/y@768.png']);
      push(shots('c', 'x@375.png'), '13', 'ccccccc', '13 15');
      assert.deepEqual(tree(), ['pr-13/ccccccc/x@375.png'], 'nowy commit PR zastępuje stary, a zamknięty PR znika');
      assert.equal(git('--git-dir', remote, 'rev-list', '--count', 'factory-screenshots'), '1');
      const bad = spawnSync('bash', [new URL('./gallery-push.sh', import.meta.url).pathname, remote, join(dir, 'a'), '13; rm', 'ccccccc', ''], { encoding: 'utf8' });
      assert.equal(bad.status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
