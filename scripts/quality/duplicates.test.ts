import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addedLines, duplicateBlocks, duplicatesReport, introducedBy, repeatedClasses, significantLines } from './duplicates.ts';

const helper = [
  'export function formatCost(value: number): string {',
  '  const rounded = Math.round(value * 100) / 100',
  "  const text = rounded.toFixed(2).replace('.', ',')",
  '  if (rounded < 0.01) return "<$0,01"',
  '  const sign = rounded < 0 ? "-" : ""',
  '  return `${sign}$${text}`',
  '}',
].join('\n');

describe('powtórzenia: bloki linii', () => {
  it('pomija linie bez treści: puste, interpunkcję, zamykające tagi, importy i komentarze', () => {
    const text = ["import { a } from 'a'", '', '}', '</div>', '// komentarz', '#[derive(Debug)]', 'const x = 1'].join('\n');
    assert.deepEqual(significantLines(text), [{ line: 7, norm: 'const x = 1' }]);
  });

  it('znajduje ten sam blok w dwóch plikach i podaje jego linie w każdym', () => {
    const files = [
      { path: 'src/a.ts', text: `const a = 1\n${helper}` },
      { path: 'src/b.ts', text: `${helper}\nconst b = 2` },
    ];
    const [group, ...rest] = duplicateBlocks(files, 6);
    assert.equal(rest.length, 0);
    assert.equal(group!.kind, 'lines');
    assert.equal(group!.size, 6, 'linia z samym „}” się nie liczy');
    assert.deepEqual(group!.locations, [
      { file: 'src/a.ts', start: 2, end: 7 },
      { file: 'src/b.ts', start: 1, end: 6 },
    ]);
  });

  it('blok krótszy niż próg nie jest powtórzeniem, a różnica w wcięciu nie przeszkadza', () => {
    const short = 'const a = 1\nconst b = 2\nconst c = 3';
    assert.deepEqual(duplicateBlocks([{ path: 'x.ts', text: short }, { path: 'y.ts', text: short }], 6), []);
    const indented = helper.split('\n').map((l) => `    ${l}`).join('\n');
    assert.equal(duplicateBlocks([{ path: 'x.ts', text: helper }, { path: 'y.ts', text: indented }], 6).length, 1);
  });

  it('powtórzenie w tym samym pliku liczy się, ale blok nie nachodzi sam na siebie', () => {
    assert.equal(duplicateBlocks([{ path: 'x.ts', text: `${helper}\n${helper}` }], 6)[0]!.locations.length, 2);
    const same = Array.from({ length: 10 }, () => 'count += 1').join('\n');
    const groups = duplicateBlocks([{ path: 'loop.ts', text: same }], 6);
    for (const g of groups) {
      const [a, b] = g.locations;
      assert.ok(!a || !b || a.end < b.start, 'miejsca bloku nie nachodzą na siebie');
    }
  });
});

describe('powtórzenia: zestawy klas', () => {
  const button = 'flex h-10 items-center justify-center rounded-base bg-accent px-6 text-[14px]';

  it('ten sam zestaw klas w kolejności dowolnej, w class i className', () => {
    const shuffled = button.split(' ').reverse().join(' ');
    const files = [
      { path: 'A.vue', text: `<template>\n  <span class="${button}">A</span>\n</template>` },
      { path: 'B.tsx', text: `export const B = () => <a className="${shuffled}">B</a>` },
      { path: 'C.tsx', text: `export const C = () => <a className={'${button}'}>C</a>` },
    ];
    const [group] = repeatedClasses(files, 6);
    assert.equal(group!.size, 8);
    assert.equal(group!.similar, undefined);
    assert.deepEqual(group!.locations.map((l) => `${l.file}:${l.start}`), ['A.vue:2', 'B.tsx:1', 'C.tsx:1']);
  });

  it('zestawy różniące się jedną klasą są podobne; większa różnica i krótkie zestawy się nie liczą', () => {
    const files = [
      { path: 'A.vue', text: `<a class="${button}"></a>` },
      { path: 'B.vue', text: `<a class="${button.replace('px-6', 'px-4')}"></a>` },
      { path: 'C.vue', text: `<a class="${button.replace('px-6 text-[14px]', 'px-2 text-xs')}"></a>` },
      { path: 'D.vue', text: '<a class="flex items-center"></a><b class="flex items-center"></b>' },
    ];
    const groups = repeatedClasses(files, 6);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.similar, true);
    assert.deepEqual(groups[0]!.locations.map((l) => l.file), ['A.vue', 'B.vue']);
  });
});

describe('powtórzenia w PR', () => {
  const diff = [
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -0,0 +1,7 @@',
    '+export function formatCost(value: number): string {',
    'diff --git a/src/old.ts b/src/old.ts',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    'diff --git a/src/c.ts b/src/c.ts',
    '--- a/src/c.ts',
    '+++ b/src/c.ts',
    '@@ -10 +10 @@',
  ].join('\n');

  it('linie dodane w PR z diffu bez kontekstu; usunięty plik ich nie ma', () => {
    const added = addedLines(diff);
    assert.deepEqual([...added.get('src/b.ts')!], [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...added.get('src/c.ts')!], [10]);
    assert.equal(added.has('src/old.ts'), false);
  });

  it('PR wprowadza powtórzenie, gdy jedno z miejsc nachodzi na dodane linie; stare powtórzenia nie trafiają do raportu', () => {
    const files = [
      { path: 'src/a.ts', text: `const a = 1\n${helper}` },
      { path: 'src/b.ts', text: `${helper}\nconst b = 2` },
      { path: 'src/x.ts', text: helper },
    ];
    const groups = duplicateBlocks(files, 6);
    const introduced = introducedBy(groups, addedLines(diff));
    assert.equal(introduced.length, 1);
    assert.deepEqual(introduced[0]!.locations.map((l) => Boolean(l.added)), [false, true, false]);
    assert.deepEqual(introducedBy(groups, new Map()), []);
  });

  it('raport dla recenzentów: miejsca z oznaczeniem nowych, a bez powtórzeń jedno zdanie', () => {
    const files = [
      { path: 'src/a.ts', text: `const a = 1\n${helper}` },
      { path: 'src/b.ts', text: `${helper}\nconst b = 2` },
    ];
    const introduced = introducedBy(duplicateBlocks(files, 6), addedLines(diff));
    const report = duplicatesReport(introduced, { minLines: 6, minClasses: 6, scope: 'pr' });
    assert.match(report, /^# Powtórzenia w kodzie/);
    assert.match(report, /- \*\*Blok 6 linii\*\* w 2 miejscach: `src\/a\.ts:2–7`, `src\/b\.ts:1–6` \(nowe w PR\)/);
    assert.match(duplicatesReport([], { minLines: 6, minClasses: 6, scope: 'pr' }), /PR nie wprowadza powtórzeń\./);
    assert.match(duplicatesReport([], { minLines: 6, minClasses: 6, scope: 'repo' }), /Brak powtórzeń ponad progi\./);
  });

  it('raport ogranicza liczbę pozycji i mówi, ile pominął, od największych', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      kind: 'classes' as const,
      size: 6 + i,
      sample: `s${i}`,
      locations: [
        { file: 'a', start: i + 1, end: i + 1 },
        { file: 'b', start: i + 1, end: i + 1 },
      ],
    }));
    const report = duplicatesReport(many, { minLines: 6, minClasses: 6, scope: 'repo', limit: 2 });
    assert.match(report, /Zestaw 9 klas[\s\S]*Zestaw 8 klas[\s\S]*…i 2 więcej/);
  });
});
