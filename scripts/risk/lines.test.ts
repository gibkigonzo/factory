import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countCodeLines } from './lines.ts';

describe('linie kodu bez pustych i komentarzy', () => {
  it('TypeScript: komentarze liniowe i blokowe', () => {
    const code = [
      '// nagłówek',
      'import x from "y"; // komentarz po kodzie',
      '',
      '/*',
      ' * opis',
      ' */',
      'const a = 1; /* krótki */ const b = 2;',
      '/* tylko komentarz */',
      'const url = "http://example.com";',
      '// link w komentarzu /* nie otwiera bloku',
      'export { a };',
    ].join('\n');
    assert.equal(countCodeLines(code, 'src/a.ts'), 4);
  });

  it('Vue: kod, komentarze HTML i JS', () => {
    const code = ['<template>', '  <!-- komentarz', '  ciąg dalszy -->', '  <div />', '</template>', '<script setup>', '// js', 'const a = 1', '</script>'].join('\n');
    assert.equal(countCodeLines(code, 'App.vue'), 6);
  });

  it('GDScript i YAML: komentarze z #', () => {
    assert.equal(countCodeLines('# opis\nfunc _ready():\n\tpass # nic\n', 'player.gd'), 2);
    assert.equal(countCodeLines('a: 1\n# b: 2\n', 'x.yml'), 1);
  });

  it('nieznane rozszerzenie: liczą się wszystkie niepuste linie', () => {
    assert.equal(countCodeLines('a\n\n# b\n// c\n', 'Makefile'), 3);
  });
});
