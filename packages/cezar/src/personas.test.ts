import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTempDir } from './test-fixtures/remove-temp-dir.testkit.ts';
import {
  applyPersona,
  globalPersonasDir,
  personaNoToolsIssue,
  personaStepChecks,
  loadPersonas,
  parseClaudeAgent,
  parsePersona,
  personasDispatchPrompt,
  type Persona,
} from './personas.ts';
import { stepsIssue, unknownPersonaIssue } from './workflows/types.ts';
import { loadWorkflows } from './workflows/load.ts';

const REVIEWER = `---
name: reviewer
description: Reads a branch against the base, writes findings, never edits.
runner: claude
model: opus
allowedTools: [Read, Grep, Glob, Bash(git *)]
skills: [code-review, repo-conventions]
dispatch: { maxSubtasks: 0 }
---
You are the project's reviewer.
`;

describe('persona files', () => {
  it('reads every frontmatter field and the body as the system prompt', () => {
    const persona = parsePersona(REVIEWER, '/r/.ai/cezar/agents/reviewer.md', 'project');
    expect(persona).toEqual({
      name: 'reviewer',
      description: 'Reads a branch against the base, writes findings, never edits.',
      runner: 'claude',
      model: 'opus',
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)'],
      skills: ['code-review', 'repo-conventions'],
      dispatch: { maxSubtasks: 0 },
      body: "You are the project's reviewer.",
      path: '/r/.ai/cezar/agents/reviewer.md',
      source: 'project',
    });
  });

  it('names a persona after its file when the frontmatter does not, and tolerates CRLF', () => {
    const persona = parsePersona('---\r\nmodel: sonnet\r\n---\r\nBody.\r\n', '/r/implementer.md', 'global');
    expect(persona).toMatchObject({ name: 'implementer', model: 'sonnet', body: 'Body.', source: 'global' });
  });

  it('refuses an unknown runner, naming the allowed ones', () => {
    const persona = parsePersona('---\nrunner: gpt-cli\n---\nx', '/r/a.md', 'project');
    expect(persona).toEqual({ error: expect.stringContaining('runner: must be one of claude, codex') });
  });

  it('refuses frontmatter that is not a mapping, and a name that is not a file stem', () => {
    expect(parsePersona('---\n- a\n---\nx', '/r/a.md', 'project')).toEqual({ error: 'frontmatter must be a YAML mapping' });
    expect(parsePersona('---\nname: ../evil\n---\nx', '/r/a.md', 'project')).toHaveProperty('error');
  });
});

describe('Claude subagent mapping', () => {
  it('maps tools to allowedTools, keeps the model, and fixes the runner to claude', () => {
    const persona = parseClaudeAgent(
      '---\nname: code-reviewer\ndescription: Reviews code.\ntools: Read, Grep, Glob\nmodel: sonnet\n---\nReview carefully.\n',
      '/r/.claude/agents/code-reviewer.md',
    );
    expect(persona).toEqual({
      name: 'code-reviewer',
      description: 'Reviews code.',
      runner: 'claude',
      model: 'sonnet',
      allowedTools: ['Read', 'Grep', 'Glob'],
      body: 'Review carefully.',
      path: '/r/.claude/agents/code-reviewer.md',
      source: 'claude',
    });
  });

  it('drops `model: inherit` and an absent tools list (Claude then inherits every tool)', () => {
    const persona = parseClaudeAgent('---\nname: helper\nmodel: inherit\n---\nHelp.', '/r/helper.md');
    expect(persona).not.toHaveProperty('model');
    expect(persona).not.toHaveProperty('allowedTools');
  });
});

describe('discovery', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-personas-'));
  });
  afterEach(async () => {
    await removeTempDir(repoRoot);
    await removeTempDir(globalPersonasDir());
  });

  const put = (dir: string, file: string, text: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
  };

  it('is empty — and says nothing — when no directory exists', async () => {
    expect(await loadPersonas(repoRoot)).toEqual({ personas: [], issues: [] });
  });

  it('resolves a name project → global → .claude/agents, and lists all three sources', async () => {
    put(join(repoRoot, '.ai/cezar/agents'), 'reviewer.md', '---\nmodel: opus\n---\nproject reviewer');
    put(globalPersonasDir(), 'reviewer.md', '---\nmodel: haiku\n---\nglobal reviewer');
    put(globalPersonasDir(), 'writer.md', 'global writer');
    put(join(repoRoot, '.claude/agents'), 'writer.md', '---\nname: writer\n---\nclaude writer');
    put(join(repoRoot, '.claude/agents'), 'tester.md', '---\nname: tester\ntools: Read\n---\nclaude tester');

    const { personas, issues } = await loadPersonas(repoRoot);
    expect(issues).toEqual([]);
    expect(personas.map((p) => [p.name, p.source, p.body])).toEqual([
      ['reviewer', 'project', 'project reviewer'],
      ['tester', 'claude', 'claude tester'],
      ['writer', 'global', 'global writer'],
    ]);
  });

  it('validates a workflow file\'s agent: at load time — an unknown persona is a load issue', async () => {
    put(join(repoRoot, '.ai/cezar/agents'), 'reviewer.md', 'Review.');
    put(join(repoRoot, '.ai/cezar/workflows'), 'ok.yaml', 'name: ok\nsteps:\n  - id: review\n    agent: reviewer\n');
    put(join(repoRoot, '.ai/cezar/workflows'), 'bad.yaml', 'name: bad\nsteps:\n  - id: review\n    agent: ghost\n');
    const { workflows, issues } = await loadWorkflows(repoRoot);
    expect(workflows.map((w) => w.name)).toContain('ok');
    expect(workflows.map((w) => w.name)).not.toContain('bad');
    expect(issues).toEqual([{ path: expect.stringContaining('bad.yaml'), message: expect.stringMatching(/^step "review": unknown agent persona "ghost"/) }]);
  });

  it('a workflow file or graph whose persona leaves a step no tools is a load issue', async () => {
    put(join(repoRoot, '.ai/cezar/agents'), 'empty.md', '---\nallowedTools: []\n---\nNothing.');
    put(join(repoRoot, '.ai/cezar/workflows'), 'steps.yaml', 'name: steps\nsteps:\n  - id: s\n    agent: empty\n');
    put(
      join(repoRoot, '.ai/cezar/workflows'),
      'graph.yaml',
      'version: 2\nname: graph\nnodes:\n  - { id: start, type: start }\n  - { id: n, type: agent, prompt: x, agent: empty }\nedges:\n  - { from: start, to: n }\n',
    );
    const { workflows, issues } = await loadWorkflows(repoRoot);
    expect(workflows.map((w) => w.name)).not.toContain('steps');
    expect(workflows.map((w) => w.name)).not.toContain('graph');
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: expect.stringContaining('steps.yaml'), message: expect.stringMatching(/^step "s": persona "empty" leaves no tools/) },
        { path: expect.stringContaining('graph.yaml'), message: expect.stringMatching(/^agent node "n": persona "empty" leaves no tools/) },
      ]),
    );
  });

  it('reports a broken file by name and keeps loading the rest', async () => {
    put(join(repoRoot, '.ai/cezar/agents'), 'broken.md', '---\nrunner: nope\n---\nx');
    put(join(repoRoot, '.ai/cezar/agents'), 'fine.md', 'fine');
    const { personas, issues } = await loadPersonas(repoRoot);
    expect(personas.map((p) => p.name)).toEqual(['fine']);
    expect(issues).toEqual([{ path: expect.stringContaining('broken.md'), message: expect.stringMatching(/^broken\.md: runner: must be one of/) }]);
  });
});

describe('merge order: step field > persona > project default', () => {
  const persona: Persona = {
    name: 'reviewer',
    runner: 'claude',
    model: 'opus',
    allowedTools: ['Read', 'Grep'],
    skills: ['code-review', 'conventions'],
    body: 'Review.',
    path: '/p.md',
    source: 'project',
  };

  it('fills every gap the step leaves from the persona', () => {
    const { step, systemPrompt, extraSkills } = applyPersona({ id: 's', agent: 'reviewer', prompt: '{{task}}' }, persona);
    expect(step).toMatchObject({ runner: 'claude', model: 'opus', allowedTools: ['Read', 'Grep'] });
    expect(systemPrompt).toBe('Persona: reviewer\n\nReview.');
    expect(extraSkills).toEqual(['code-review', 'conventions']);
  });

  it('keeps every field the step sets, and the step skill is not repeated', () => {
    const { step, extraSkills } = applyPersona(
      { id: 's', agent: 'reviewer', prompt: 'x', runner: 'claude', model: 'sonnet', allowedTools: ['Read'], skill: 'code-review' },
      persona,
    );
    expect(step).toMatchObject({ runner: 'claude', model: 'sonnet', allowedTools: ['Read'], skill: 'code-review' });
    expect(extraSkills).toEqual(['conventions']);
  });

  it("drops the persona's model when the step moves it to another runner", () => {
    const { step } = applyPersona({ id: 's', agent: 'reviewer', prompt: 'x', runner: 'codex' }, persona);
    expect(step.runner).toBe('codex');
    expect(step.model).toBeUndefined();
  });

  it('leaves a gap for the project default when neither sets a field', () => {
    const { step } = applyPersona({ id: 's', agent: 'bare', prompt: 'x' }, { name: 'bare', body: '', path: '/b.md', source: 'project' });
    expect(step).toEqual({ id: 's', agent: 'bare', prompt: 'x' });
  });

  it("only narrows: the persona's tools are intersected with the step's, never added to them", () => {
    const wide: Persona = { ...persona, allowedTools: ['Read', 'Edit', 'WebFetch', 'Bash(git *)'] };
    const onDefault = applyPersona({ id: 's', agent: 'reviewer', prompt: 'x' }, wide);
    // WebFetch is not in the default list, so a persona cannot grant it.
    expect(onDefault.step.allowedTools).toEqual(['Read', 'Edit', 'Bash(git *)']);
    expect(onDefault.droppedTools).toEqual(['WebFetch']);
    const onStep = applyPersona({ id: 's', agent: 'reviewer', prompt: 'x', allowedTools: ['Read', 'Grep'] }, wide);
    expect(onStep.step.allowedTools).toEqual(['Read']);
    expect(onStep.droppedTools).toEqual(['Edit', 'WebFetch', 'Bash(git *)']);
    // A bare persona tool keeps the step's narrower pattern, and a step's bashAllowlist stays the bound.
    const bare: Persona = { ...persona, allowedTools: ['Bash'] };
    expect(applyPersona({ id: 's', agent: 'r', prompt: 'x', allowedTools: ['Bash(npm *)'] }, bare).step.allowedTools).toEqual(['Bash(npm *)']);
    expect(
      applyPersona({ id: 's', agent: 'r', prompt: 'x', bashAllowlist: ['npm test'] }, { ...persona, allowedTools: ['Bash(rm *)'] }).step.allowedTools,
    ).toEqual(['Bash']);
  });

  it('never grants Task (unbudgeted sub-agents) to a persona — not from the persona, not from the step', () => {
    const delegating: Persona = { ...persona, allowedTools: ['Read', 'Task', 'Agent(*)'] };
    const fromPersona = applyPersona({ id: 's', agent: 'reviewer', prompt: 'x', allowedTools: ['Read', 'Task'] }, delegating);
    expect(fromPersona.step.allowedTools).toEqual(['Read']);
    expect(fromPersona.subagentToolRefused).toBe(true);
    expect(fromPersona.droppedTools).toBeUndefined();
    const fromStep = applyPersona({ id: 's', agent: 'reviewer', prompt: 'x', allowedTools: ['Read', 'Task'] }, { ...persona, allowedTools: undefined });
    expect(fromStep.step.allowedTools).toEqual(['Read']);
    expect(fromStep.subagentToolRefused).toBe(true);
  });

  it(".claude/agents tools: are intersected the same way — Claude's Task and extra tools do not ride in", () => {
    const mapped = parseClaudeAgent('---\nname: helper\ntools: Read, Task, WebSearch\n---\nHelp.', '/r/.claude/agents/helper.md');
    if ('error' in mapped) throw new Error(mapped.error);
    const { step, droppedTools, subagentToolRefused } = applyPersona({ id: 's', agent: 'helper', prompt: 'x' }, mapped);
    expect(step.allowedTools).toEqual(['Read']);
    expect(droppedTools).toEqual(['WebSearch']);
    expect(subagentToolRefused).toBe(true);
  });

  it('fails closed when the intersection is empty: [WebFetch], [] and [Task] leave a step no tools', () => {
    for (const allowedTools of [['WebFetch'], [], ['Task']]) {
      const narrow: Persona = { ...persona, allowedTools };
      expect(applyPersona({ id: 's', agent: 'reviewer', prompt: 'x' }, narrow)).toMatchObject({ step: { allowedTools: [] }, noToolsLeft: true });
      expect(personaNoToolsIssue({}, narrow)).toBe(
        'persona "reviewer" leaves no tools for this step — its allowedTools share none with the step\'s',
      );
    }
    expect(personaNoToolsIssue({ allowedTools: ['Grep'] }, { ...persona, allowedTools: ['Read'] })).toMatch(/leaves no tools/);
    expect(personaNoToolsIssue({}, persona)).toBeNull();
    expect(personaNoToolsIssue({}, { ...persona, allowedTools: undefined })).toBeNull();
    expect(personaNoToolsIssue({}, undefined)).toBeNull();
    expect(applyPersona({ id: 's', agent: 'reviewer', prompt: 'x' }, persona).noToolsLeft).toBeUndefined();
  });

  it('is the identity without a persona', () => {
    const step = { id: 's', prompt: 'x' };
    expect(applyPersona(step, undefined)).toEqual({ step, extraSkills: [] });
  });
});

describe('the step and dispatch surfaces', () => {
  it('names the step and the persona an unknown agent: points at', () => {
    expect(unknownPersonaIssue([{ id: 'a' }, { id: 'b', agent: 'ghost' }], new Set(['reviewer']))).toMatch(
      /^step "b": unknown agent persona "ghost"/,
    );
    expect(unknownPersonaIssue([{ id: 'b', agent: 'reviewer' }], new Set(['reviewer']))).toBeNull();
  });

  it('is a stepsIssue when the caller knows the personas, and unchecked when it does not', () => {
    const steps = [{ id: 'review', agent: 'ghost' }];
    expect(stepsIssue(steps, { personas: new Set() })).toMatch(/unknown agent persona "ghost"/);
    expect(stepsIssue(steps)).toBeNull();
  });

  it('is a stepsIssue when a persona leaves a step no tools', () => {
    const checks = personaStepChecks([
      { name: 'fetcher', allowedTools: ['WebFetch'], body: '', path: '/f.md', source: 'project' },
      { name: 'reader', allowedTools: ['Read'], body: '', path: '/r.md', source: 'project' },
    ]);
    expect(stepsIssue([{ id: 'read', agent: 'reader' }, { id: 'fetch', agent: 'fetcher' }], checks)).toBe(
      'step "fetch": persona "fetcher" leaves no tools for this step — its allowedTools share none with the step\'s',
    );
    expect(stepsIssue([{ id: 'read', agent: 'reader' }, { id: 'plain' }], checks)).toBeNull();
  });

  it('lists personas for a dispatching task, and nothing when there are none', () => {
    expect(personasDispatchPrompt([])).toBeUndefined();
    const prompt = personasDispatchPrompt([
      { name: 'reviewer', description: 'Reviews.', runner: 'claude', model: 'opus', body: '', path: '/p', source: 'project' },
    ]);
    expect(prompt).toContain('--as <name>');
    expect(prompt).toContain('- reviewer — Reviews. (claude, opus)');
  });
});
