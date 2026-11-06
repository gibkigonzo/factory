import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDiff, unquote } from './diff.ts';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
-old line
--- removed line that starts with two dashes
+new line
+++ added line that starts with two pluses
\\ No newline at end of file
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/from.ts b/to.ts
similarity index 100%
rename from from.ts
rename to to.ts
diff --git a/x/b.ts b/y/b.ts
similarity index 80%
rename from x/b.ts
rename to y/b.ts
index 5555555..6666666 100644
--- a/x/b.ts
+++ b/y/b.ts
@@ -1 +1 @@
-a
+b
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/img.png differ
diff --git a/my file.ts b/my file.ts
old mode 100644
new mode 100755
diff --git "a/tab\\there.ts" "b/tab\\there.ts"
index 8888888..9999999 100644
--- "a/tab\\there.ts"
+++ "b/tab\\there.ts"
@@ -1 +1 @@
-x
+y
`;

describe('parser diffu git', () => {
  const files = parseDiff(DIFF);
  const byPath = (path: string) => files.find((f) => f.path === path);

  it('rozpoznaje wszystkie pliki', () => {
    assert.deepEqual(
      files.map((f) => f.path),
      ['src/a.ts', 'src/new.ts', 'old.txt', 'to.ts', 'y/b.ts', 'img.png', 'my file.ts', 'tab\there.ts'],
    );
  });

  it('liczy linie hunka, także zaczynające się od --- i +++', () => {
    const file = byPath('src/a.ts')!;
    assert.equal(file.status, 'modified');
    assert.equal(file.additions, 2);
    assert.equal(file.deletions, 2);
    assert.deepEqual(file.addedLines, ['new line', '++ added line that starts with two pluses']);
    assert.deepEqual(file.contextLines, ['keep']);
  });

  it('nowy, usunięty i binarny plik', () => {
    assert.equal(byPath('src/new.ts')?.status, 'added');
    assert.equal(byPath('src/new.ts')?.additions, 2);
    assert.equal(byPath('old.txt')?.status, 'deleted');
    assert.equal(byPath('old.txt')?.deletions, 1);
    assert.equal(byPath('img.png')?.binary, true);
    assert.equal(byPath('img.png')?.status, 'added');
  });

  it('zmiana nazwy zapamiętuje starą ścieżkę', () => {
    assert.deepEqual([byPath('to.ts')?.status, byPath('to.ts')?.oldPath, byPath('to.ts')?.additions], ['renamed', 'from.ts', 0]);
    assert.deepEqual([byPath('y/b.ts')?.oldPath, byPath('y/b.ts')?.additions], ['x/b.ts', 1]);
  });

  it('ścieżki ze spacją i w cudzysłowie', () => {
    assert.equal(byPath('my file.ts')?.status, 'modified');
    assert.equal(byPath('tab\there.ts')?.additions, 1);
    assert.equal(unquote('"\\305\\202\\303\\263d\\305\\272.ts"'), 'łódź.ts');
  });

  it('pusty diff to brak plików', () => {
    assert.deepEqual(parseDiff(''), []);
  });
});
