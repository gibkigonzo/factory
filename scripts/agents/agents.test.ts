import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../config/load.ts';
import { buildAgents, parseFrontmatter, REVIEWER_TOOLS, ROOT, staleAgents } from './build.ts';
import { loadCatalog } from '../review/perspectives.ts';
import { parseOutput } from './output.ts';
import type { OutputKind } from './output.ts';
import { parseSpec, SPEC_SECTIONS } from '../workflow/spec.ts';

const SKILLS = join(ROOT, 'skills');
const skillNames = readdirSync(SKILLS).filter((name) => existsSync(join(SKILLS, name, 'SKILL.md'))).sort();
const skill = (name: string) => parseFrontmatter(readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8'));

/** Skill → rodzaj wyjścia, którego przykład musi przejść walidację. */
const EXAMPLES: Record<string, OutputKind> = {
  planner: 'plan',
  implementer: 'implementation',
  'risk-assessor': 'behavior',
};

describe('skille', () => {
  it('są wszystkie skille taśmy', () => {
    for (const name of ['planner', 'implementer', 'risk-assessor', 'review', 'spec-writer']) assert.ok(skillNames.includes(name), name);
  });

  for (const name of skillNames) {
    it(`${name}: ma nazwę, opis oraz sekcje Wejście i Wyjście`, () => {
      const { data, body } = skill(name);
      assert.equal(data.name, name);
      assert.ok(typeof data.description === 'string' && data.description.length > 40, 'opis mówi, kiedy używać skilla');
      assert.match(body, /^## Wejście$/m);
      assert.match(body, /^## Wyjście$/m);
    });
  }

  for (const [name, kind] of Object.entries(EXAMPLES)) {
    it(`${name}: przykład wyjścia przechodzi walidację (${kind})`, () => {
      const result = parseOutput(kind, skill(name).body, `skills/${name}/SKILL.md`);
      assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
    });
  }
});

describe('spec-writer i format specu', () => {
  const { data, body } = skill('spec-writer');
  const blocks = [...body.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
  const section = (heading: string) => SPEC_SECTIONS.find((name) => heading.startsWith(name));

  it('opis i nazwa mieszczą się w limitach skilli wgrywanych do aplikacji Claude', () => {
    assert.match(String(data.name), /^[a-z0-9-]{1,64}$/);
    assert.ok(String(data.description).length <= 200, `opis ma ${String(data.description).length} znaków`);
  });

  it('szablon i przykład mają wszystkie sekcje specu w kolejności planera', () => {
    assert.equal(blocks.length, 2, 'szablon i przykład w blokach ```markdown');
    for (const block of blocks) assert.deepEqual(headings(block).map(section), [...SPEC_SECTIONS]);
  });

  it('przykład czyta skrypt taśmy: kryteria akceptacji i ryzyko produktowe', () => {
    const spec = parseSpec(blocks[1]!);
    assert.ok(spec.acceptance.length >= 2 && spec.acceptance.length <= 6, `${spec.acceptance.length} kryteriów`);
    assert.equal(spec.productRisk, 'low');
  });

  it('reguła dla CLAUDE.md projektu kieruje pomysły do spec-writera i taśmy', () => {
    const rule = readFileSync(join(ROOT, 'templates/claude/CLAUDE.md'), 'utf8');
    assert.match(rule, /`spec-writer`/);
    assert.match(rule, /`ready`/);
    assert.match(rule, /Nie implementuj/);
  });

  it('planer zna te same sekcje', () => {
    const planner = skill('planner').body;
    for (const name of SPEC_SECTIONS) assert.ok(planner.includes(name), `planer nie wymienia sekcji ${name}`);
  });
});

describe('recenzenci', () => {
  const agents = buildAgents();
  const base = loadConfig('project: x\nextends: [base]\ncommands: { test: t, build: b }\n', 'factory.yml');
  assert.ok(base.ok);

  it('pliki agentów są aktualne względem protokołu i perspektyw', () => {
    assert.deepEqual(staleAgents(agents), []);
  });

  it('każda perspektywa z katalogu ma recenzenta, a perspektywy projektu mają recenzenta ogólnego', () => {
    const names = [...agents.keys()].map((path) => path.replace(/^agents\/review-|\.md$/g, ''));
    assert.deepEqual(names, [...loadCatalog().map((d) => d.name), 'project']);
    for (const name of base.config.reviewers.perspectives) assert.ok(names.includes(name), `brak recenzenta dla ${name}`);
  });

  for (const [path, content] of agents) {
    it(`${path}: tylko narzędzia do odczytu`, () => {
      const { data } = parseFrontmatter(content);
      const tools = String(data.tools).split(',').map((t) => t.trim());
      assert.deepEqual(tools, [...REVIEWER_TOOLS]);
      assert.ok(tools.every((tool) => !['Write', 'Edit', 'Bash', 'NotebookEdit'].includes(tool)));
    });

    it(`${path}: przykład werdyktu przechodzi walidację i ma właściwą perspektywę`, () => {
      const result = parseOutput('verdict', content, path);
      assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
      const perspective = (result.value as { perspective: string }).perspective;
      const expected = path === 'agents/review-project.md' ? 'nazwa-perspektywy' : path.replace(/^agents\/review-|\.md$/g, '');
      assert.equal(perspective, expected);
    });
  }
});
