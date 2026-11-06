import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesGlob } from './glob.ts';

const CASES: [glob: string, path: string, expected: boolean][] = [
  ['factory.yml', 'factory.yml', true],
  ['factory.yml', 'sub/factory.yml', false],
  ['*.md', 'README.md', true],
  ['*.md', 'docs/a.md', false],
  ['**/*.md', 'README.md', true],
  ['**/*.md', 'docs/deep/a.md', true],
  ['docs/**', 'docs/a.md', true],
  ['docs/**', 'docs/x/y/z.txt', true],
  ['docs/**', 'docs', false],
  ['docs/**', 'documents/a.md', false],
  ['src/**/x.ts', 'src/x.ts', true],
  ['src/**/x.ts', 'src/a/b/x.ts', true],
  ['src/*/x.ts', 'src/a/b/x.ts', false],
  ['**/tsconfig*.json', 'tsconfig.json', true],
  ['**/tsconfig*.json', 'packages/app/tsconfig.build.json', true],
  ['file?.ts', 'file1.ts', true],
  ['file?.ts', 'file10.ts', false],
  ['.github/**', '.github/workflows/ci.yml', true],
  ['**/.env.*', 'app/.env.local', true],
  ['a.b', 'axb', false],
  ['src/(x)/*.ts', 'src/(x)/a.ts', true],
];

describe('wzorce ścieżek', () => {
  for (const [glob, path, expected] of CASES) {
    it(`${glob} ${expected ? 'pasuje do' : 'nie pasuje do'} ${path}`, () => {
      assert.equal(matchesGlob(path, glob), expected);
    });
  }
});
