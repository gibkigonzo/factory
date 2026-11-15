import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseOutput } from '../agents/output.ts';
import { parseUsageBlocks } from '../workflow/usage.ts';
import type { Usage } from '../workflow/usage.ts';
import { ARCHITECTURE_MARKER, isDue, newProposals, proposalBody, REFACTOR_MARKER, runComment } from './architecture.ts';
import type { ArchitectureOutput, Proposal } from './architecture.ts';

const proposal = (title: string): Proposal => ({
  title,
  problem: 'Trzy ekrany budują przycisk strzałki z tym samym zestawem 14 klas.',
  proposal: 'Komponent CarouselArrow w src/components/ z wariantem kierunku.',
  places: ['src/features/hero/HeroBanner.tsx:8', 'src/features/services/ServiceBar.tsx:19'],
  size: { lines: 60, files: 4 },
});

describe('przegląd architektury', () => {
  it('rusza po każdych every scalonych PR fabryki, nigdy przy zerze', () => {
    assert.equal(isDue(0, 5), false);
    assert.equal(isDue(4, 5), false);
    assert.equal(isDue(5, 5), true);
    assert.equal(isDue(10, 5), true);
    assert.equal(isDue(11, 5), false);
  });

  it('propozycje: bez otwartych pod tym samym tytułem, bez powtórek w wyniku i najwyżej max', () => {
    const output: ArchitectureOutput = {
      summary: 'Strzałki karuzeli i formatowanie kosztu powtarzają się.',
      proposals: [
        proposal('Wspólny komponent strzałki karuzeli'),
        proposal('Wspólny komponent strzałki karuzeli!'),
        proposal('Helper formatowania kosztu'),
        proposal('Hook odpytywania projektu'),
        proposal('Wariant przycisku ikony'),
      ],
    };
    const titles = newProposals(output, ['helper  FORMATOWANIA kosztu'], 3).map((p) => p.title);
    assert.deepEqual(titles, ['Wspólny komponent strzałki karuzeli', 'Hook odpytywania projektu', 'Wariant przycisku ikony']);
    assert.deepEqual(newProposals({ summary: 'Spójnie.', proposals: [] }, [], 3), []);
  });

  it('treść propozycji: znacznik, sekcje, miejsca jako kod i informacja, że to notatka do backlogu', () => {
    const body = proposalBody({ ...proposal('X'), places: ['src/a.ts:1', 'src/`b`.ts:2'] });
    assert.ok(body.startsWith(REFACTOR_MARKER));
    assert.match(body, /## Co się powtarza\n\nTrzy ekrany/);
    assert.match(body, /## Propozycja\n\nKomponent CarouselArrow/);
    assert.match(body, /- `src\/a\.ts:1`\n- `src\/'b'\.ts:2`/);
    assert.match(body, /około 60 linii w 4 plikach/);
    assert.match(body, /notatka do backlogu, nie zadanie/);
  });

  it('komentarz przeglądu podaje nowe propozycje i koszt, który dziennik odczyta', () => {
    const usage: Usage[] = [{ stage: 'architecture', count: 1, cost: 1.5, turns: 20, ms: 60000, input: 10, output: 4000, cacheRead: 0, cacheWrite: 0 }];
    const comment = runComment({ merged: 10, summary: 'Jedno powtórzenie.', created: [{ number: 42, title: 'Wspólny komponent strzałki karuzeli' }], usage });
    assert.ok(comment.startsWith(ARCHITECTURE_MARKER));
    assert.match(comment, /po 10 scalonych PR fabryki/);
    assert.match(comment, /- #42 Wspólny komponent strzałki karuzeli/);
    assert.deepEqual(parseUsageBlocks(comment), usage);
    assert.match(runComment({ merged: 5, summary: 'Spójnie.', created: [], usage: [] }), /Brak nowych propozycji refaktoru\./);
  });

  it('wyjście agenta sprawdza schemat: propozycja bez miejsc albo rozmiaru jest odrzucona', () => {
    const ok = JSON.stringify({ summary: 'S', proposals: [proposal('T')] });
    assert.equal(parseOutput('architecture', ok, 'a.json').ok, true);
    const { places: _places, ...noPlaces } = proposal('T');
    const bad = parseOutput('architecture', JSON.stringify({ summary: 'S', proposals: [noPlaces] }), 'a.json');
    assert.equal(bad.ok, false);
    assert.ok(!bad.ok && bad.errors.some((e) => e.includes('places')));
  });
});
