import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { reviewPrompt } from './prompts.ts';
import { collectScreenshots, galleryComment, INDEX, MAX_FILES, runScreenshots, screenshotsTask, SCREENSHOTS_MARKER } from './screenshots.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const temp = () => mkdtempSync(join(tmpdir(), 'factory-shots-'));
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recenzent dostaje spis par; bez komendy zrzutów prompt o nich milczy', () => {
    const dir = temp();
    try {
      const shots = join(dir, 'screenshots');
      assert.deepEqual(screenshotsTask(shots), []);
      mkdirSync(shots);
      assert.deepEqual(screenshotsTask(shots), [], 'pusty katalog z pobrania artefaktu');
      writeFileSync(join(shots, INDEX), '{"ok":false}');
      assert.match(screenshotsTask(shots)[0]!, /zakończyła się błędem i nie zostawiła żadnego zrzutu/);
      writeFileSync(join(shots, 'newsletter@375.png'), PNG);
      writeFileSync(join(shots, 'newsletter@375.ref.png'), PNG);
      writeFileSync(join(shots, 'footer@375.ref.png'), PNG);
      const [line] = screenshotsTask(shots);
      assert.match(line!, /części zrzutów może brakować/);
      assert.ok(line!.includes(`  - footer, 375 px: wykonanie brak, wzorzec \`${shots}/footer@375.ref.png\``));
      assert.ok(line!.includes(`  - newsletter, 375 px: wykonanie \`${shots}/newsletter@375.png\`, wzorzec \`${shots}/newsletter@375.ref.png\``));
      assert.ok(reviewPrompt({ work: dir, agent: 'review-ux-visual' }).includes(`\`${shots}/newsletter@375.png\``));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('galeria w PR: wzorzec obok wykonania, bez wzorca jedna kolumna, nazwy odrzuconych plików bez znaków Markdown', () => {
    const url = (file: string) => `https://example.test/pr-1/abc/${encodeURIComponent(file)}`;
    const pairs = galleryComment(
      { shots: [{ name: 'newsletter', width: 375, actual: 'newsletter@375.png', reference: 'newsletter@375.ref.png' }, { name: 'hero', actual: 'hero.png' }], rejected: [{ file: '[x](http://e)`|.gif', reason: 'to nie PNG' }] },
      { url, sha: 'abcdef1234567', ok: false, runUrl: 'https://example.test/run/1' },
    );
    assert.ok(pairs.startsWith(SCREENSHOTS_MARKER));
    assert.match(pairs, /Commit `abcdef1`/);
    assert.match(pairs, /komenda zrzutów zakończyła się błędem[^\n]*\[przebieg\]\(https:\/\/example\.test\/run\/1\)/i);
    assert.match(pairs, /\| Zrzut \| Wzorzec \| Wykonanie \|/);
    assert.ok(pairs.includes('| newsletter, 375 px | <a href="https://example.test/pr-1/abc/newsletter%40375.ref.png"><img src="https://example.test/pr-1/abc/newsletter%40375.ref.png"'));
    assert.match(pairs, /\| hero \| — \| <a href/);
    assert.ok(pairs.includes('`?x??http???e???.gif` (to nie PNG)'));
    const single = galleryComment({ shots: [{ name: 'hero', actual: 'hero.png' }], rejected: [] }, { url, sha: 'abc1234' });
    assert.match(single, /\| Zrzut \| Wykonanie \|/);
    assert.doesNotMatch(single, /Wzorzec|błędem/);
    assert.match(galleryComment({ shots: [], rejected: [] }, { url, sha: 'abc1234' }), /nie zostawiła żadnego zrzutu/);
  });

  it('CLI: bez evidence.screenshots nic nie robi, a galeria sprawdza pliki od nowa', () => {
    const dir = temp();
    try {
      writeFileSync(join(dir, 'none.json'), JSON.stringify({ evidence: { preview_deploy: false } }));
      assert.deepEqual(JSON.parse(cli('screenshots', '--config', join(dir, 'none.json'), '--out', join(dir, 'shots')).stdout), { configured: false });
      assert.ok(!existsSync(join(dir, 'shots')));

      writeFileSync(join(dir, 'set.json'), JSON.stringify({ evidence: { screenshots: `printf '\\211PNG\\r\\n\\032\\n' > "$FACTORY_SCREENSHOTS/a@375.png"; echo "log komendy"` } }));
      const run = cli('screenshots', '--config', join(dir, 'set.json'), '--out', join(dir, 'shots'));
      assert.deepEqual(JSON.parse(run.stdout), { configured: true, ok: true, shots: 1, rejected: 0 }, 'wyjście komendy nie miesza się z JSON');
      assert.match(run.stderr, /log komendy/);

      writeFileSync(join(dir, 'shots', 'evil.sh'), '#!/bin/sh');
      const gallery = cli('gallery', '--dir', join(dir, 'shots'), '--url', 'https://example.test/x/', '--sha', 'abc1234', '--out', join(dir, 'gallery.md'));
      assert.equal(gallery.status, 0, gallery.stderr);
      assert.ok(!existsSync(join(dir, 'shots', 'evil.sh')));
      assert.match(readFileSync(join(dir, 'gallery.md'), 'utf8'), /src="https:\/\/example\.test\/x\/a%40375\.png"/);
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
