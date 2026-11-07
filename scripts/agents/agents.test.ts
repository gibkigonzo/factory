import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../config/load.ts';
import { buildAgents, parseFrontmatter, REVIEWER_TOOLS, ROOT, staleAgents } from './build.ts';
import { parseOutput } from './output.ts';
import type { OutputKind } from './output.ts';

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
  it('są wszystkie skille z #6', () => {
    for (const name of ['planner', 'implementer', 'risk-assessor', 'review']) assert.ok(skillNames.includes(name), name);
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

describe('recenzenci', () => {
  const agents = buildAgents();
  const base = loadConfig('project: x\nextends: [base]\ncommands: { test: t, build: b }\n', 'factory.yml');
  assert.ok(base.ok);

  it('pliki agentów są aktualne względem protokołu i perspektyw', () => {
    assert.deepEqual(staleAgents(agents), []);
  });

  it('każda perspektywa z base ma recenzenta', () => {
    const names = [...agents.keys()].map((path) => path.replace(/^agents\/review-|\.md$/g, ''));
    assert.deepEqual(names, [...base.config.reviewers.perspectives].sort());
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
      assert.equal(`agents/review-${perspective}.md`, path);
    });
  }
});
