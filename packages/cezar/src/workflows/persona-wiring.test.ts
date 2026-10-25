import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { graphIssues, graphToSteps, type WorkflowGraph } from './graph.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spawn, in order: which backend the engine asked for and the spec it handed over. */
const captured = vi.hoisted(() => ({
  spawns: [] as Array<{ backend: string; spec: AgentRunSpec }>,
  /** Set, a session stays live until it settles — so a test can act while a step runs. */
  hold: undefined as Promise<void> | undefined,
}));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: string) => ({
    backend,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.spawns.push({ backend, spec });
      const sessionId = `sess-${captured.spawns.length}`;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          const finish = () =>
            setTimeout(() => {
              onEvent?.({ type: 'session', sessionId });
              resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
            }, 0);
          if (captured.hold) void captured.hold.then(finish);
          else finish();
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

/**
 * Spec 2026-10-24-personas §10 ("dry run"): a two-step workflow `implementer → reviewer` with two
 * personas launches two runners with the expected system prompts, backends and tools — and a
 * Continue of the reviewer's session keeps the reviewer's read-only tools (the second
 * `ActiveRun` construction site).
 */
describe('personas on workflow steps', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  const PIPELINE: WorkflowDef = {
    name: 'implement-review',
    source: 'file',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}', agent: 'implementer' },
      { id: 'review', name: 'Review', prompt: 'review {{task}}', agent: 'reviewer' },
    ],
  };

  beforeEach(async () => {
    captured.spawns.length = 0;
    captured.hold = undefined;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-persona-wiring-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    const agents = join(repoRoot, '.ai/cezar/agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, 'implementer.md'),
      '---\nrunner: codex\ndescription: Writes the change.\nallowedTools: [Read, Edit]\n---\nYou implement.\n',
    );
    writeFileSync(
      join(agents, 'reviewer.md'),
      '---\nrunner: claude\nmodel: opus\nallowedTools: [Read, Grep, Glob]\n---\nYou review and never edit.\n',
    );
    writeFileSync(join(agents, 'gatekeeper.md'), '---\nrunner: claude\ndispatch: { maxSubtasks: 0 }\n---\nYou gate; you never delegate.\n');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    for (let attempt = 0; ; attempt++) {
      try {
        await removeTempDir(repoRoot);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  });

  async function spawnAt(index: number) {
    await expect.poll(() => captured.spawns.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.spawns[index]!;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  it('runs each step on its persona: runner, model, tools and system prompt', async () => {
    const record = manager!.startRun(PIPELINE, { task: 'add a flag', worktree: false, runner: 'claude' });
    const implement = await spawnAt(0);
    const review = await spawnAt(1);
    await settled(record.id);

    expect(implement.backend).toBe('codex');
    expect(implement.spec.systemPrompt).toMatch(/^Persona: implementer\nRole: Writes the change\.\n\nYou implement\./);
    expect(implement.spec.systemPrompt).not.toContain('You review');

    expect(review.backend).toBe('claude');
    expect(review.spec.systemPrompt).toMatch(/^Persona: reviewer\n\nYou review and never edit\./);
    expect(review.spec.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(review.spec.model).toMatch(/opus/);
    expect(store.getRun(record.id)?.steps.map((s) => [s.id, s.backend])).toEqual([
      ['implement', 'codex'],
      ['review', 'claude'],
    ]);
    // Codex ignores allowedTools: the persona's list is a note there, never a silent promise.
    const notes = store.readEvents(record.id).filter((e) => e.type === 'note').map((e) => String((e as { message?: unknown }).message));
    expect(notes).toContain('persona "implementer": its tool list is not enforced on codex, which ignores allowedTools');
    expect(notes.some((n) => n.includes('persona "reviewer"'))).toBe(false);
  });

  it("a Continue of the reviewer's session keeps the persona's tools and prompt", async () => {
    const single: WorkflowDef = { name: 'review-only', source: 'file', steps: [PIPELINE.steps[1]!] };
    const record = manager!.startRun(single, { task: 'look', worktree: false, runner: 'claude' });
    const opening = await spawnAt(0);
    await settled(record.id);

    expect(manager!.continueRun(record.id, { text: 'again', runner: 'claude' })).toEqual({ ok: true });
    const resumed = await spawnAt(1);
    expect(resumed.spec.allowedTools).toEqual(opening.spec.allowedTools);
    expect(resumed.spec.systemPrompt).toContain('You review and never edit.');
    await expect
      .poll(() => store.getRun(record.id)?.steps.find((s) => s.id === 'continue-1')?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'failed', 'cancelled'].includes(String(status)));
    await settled(record.id);
  });

  it("a persona's tools only narrow the step's, Task is never granted — and Continue says so again", async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/agents/delegator.md'), '---\nrunner: claude\nallowedTools: [Read, Task, WebFetch]\n---\nYou delegate.\n');
    const single: WorkflowDef = { name: 'delegate', source: 'file', steps: [{ id: 'd', prompt: '{{task}}', agent: 'delegator' }] };
    const record = manager!.startRun(single, { task: 'x', worktree: false, runner: 'claude' });
    const opening = await spawnAt(0);
    await settled(record.id);
    expect(opening.spec.allowedTools).toEqual(['Read']);
    // Left out of allowedTools, Task still runs under `dontAsk` — only a deny rule stops it.
    expect(opening.spec.disallowedTools).toEqual(['Task', 'Agent']);
    const toolNotes = () =>
      store.readEvents(record.id)
        .filter((e) => e.type === 'note')
        .map((e) => String((e as { message?: unknown }).message))
        .filter((m) => m.startsWith('persona "delegator"'));
    const TASK_NOTE = 'persona "delegator": Task (sub-agents) is never granted to a persona — dispatch children with cez task create, which is budgeted and visible';
    const DROP_NOTE = 'persona "delegator": not granted WebFetch — a persona can only narrow the step\'s tools';
    expect(toolNotes()).toEqual([DROP_NOTE, TASK_NOTE]);

    expect(manager!.continueRun(record.id, { text: 'again', runner: 'claude' })).toEqual({ ok: true });
    const resumed = await spawnAt(1);
    expect(resumed.spec.allowedTools).toEqual(['Read']);
    expect(resumed.spec.disallowedTools).toEqual(['Task', 'Agent']);
    expect(toolNotes()).toEqual([DROP_NOTE, TASK_NOTE, DROP_NOTE, TASK_NOTE]);
    await expect
      .poll(() => store.getRun(record.id)?.steps.find((s) => s.id === 'continue-1')?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'failed', 'cancelled'].includes(String(status)));
  });

  it('a step without a persona denies nothing extra', async () => {
    const plain: WorkflowDef = { name: 'plain', source: 'file', steps: [{ id: 'p', prompt: '{{task}}' }] };
    const record = manager!.startRun(plain, { task: 'x', worktree: false, runner: 'claude' });
    const spawn = await spawnAt(0);
    await settled(record.id);
    expect(spawn.spec.disallowedTools).toBeUndefined();
  });

  it('fails the step, never spawning, when the persona leaves it no tools', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/agents/fetcher.md'), '---\nrunner: pi\nallowedTools: [WebFetch]\n---\nYou fetch.\n');
    const single: WorkflowDef = { name: 'fetch', source: 'file', steps: [{ id: 'f', prompt: '{{task}}', agent: 'fetcher' }] };
    const record = manager!.startRun(single, { task: 'x', worktree: false, runner: 'claude' });
    await settled(record.id);
    expect(captured.spawns).toEqual([]);
    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.error).toMatch(/persona "fetcher" leaves no tools for this step/);
  });

  it('fails a pi step before spawning when its persona leaves pi no tools after the mapping', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/agents/basher.md'), '---\nrunner: pi\nallowedTools: [Bash]\n---\nYou run tests.\n');
    const single: WorkflowDef = {
      name: 'bash-only',
      source: 'file',
      steps: [{ id: 'b', prompt: '{{task}}', agent: 'basher', bashAllowlist: ['npm test'] }],
    };
    const record = manager!.startRun(single, { task: 'x', worktree: false, runner: 'claude' });
    await settled(record.id);
    expect(captured.spawns).toEqual([]);
    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.error).toMatch(/persona "basher" leaves pi no tools for this step/);
  });

  it('refuses a dispatch --as a persona that leaves the order no tools', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/agents/delegator.md'), '---\nallowedTools: [Task]\n---\nYou delegate.\n');
    let release!: () => void;
    captured.hold = new Promise<void>((resolve) => (release = resolve));
    const single: WorkflowDef = { name: 'plain', source: 'file', steps: [{ id: 'p', prompt: '{{task}}' }] };
    const record = manager!.startRun(single, { task: 'x', worktree: false, runner: 'claude' });
    await spawnAt(0);
    const delegator = { name: 'delegator', allowedTools: ['Task'], body: 'You delegate.', path: '/d.md', source: 'project' as const };
    expect(manager!.dispatch(record.id, { objective: 'help' }, { persona: delegator })).toEqual({
      refused: 'persona "delegator" leaves no tools for this step — its allowedTools share none with the step\'s',
    });
    expect(store.listRuns().filter((r) => r.dispatch?.parentRunId === record.id)).toEqual([]);
    release();
    captured.hold = undefined;
    await settled(record.id);
  });

  it("a persona's maxSubtasks counts only the children its own step dispatched", async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/agents/limited.md'), '---\nrunner: claude\ndispatch: { maxSubtasks: 1 }\n---\nYou delegate once.\n');
    let release!: () => void;
    captured.hold = new Promise<void>((resolve) => (release = resolve));
    const two: WorkflowDef = {
      name: 'plain-then-limited',
      source: 'file',
      steps: [{ id: 'plain', prompt: '{{task}}' }, { id: 'limited', prompt: '{{task}}', agent: 'limited' }],
    };
    const record = manager!.startRun(two, { task: 'x', worktree: true, runner: 'claude' });
    await spawnAt(0);
    expect(manager!.dispatch(record.id, { objective: 'from the plain step' })).toHaveProperty('id');
    let releaseLimited!: () => void;
    const limitedHold = new Promise<void>((resolve) => (releaseLimited = resolve));
    release();
    captured.hold = limitedHold;
    await expect
      .poll(() => captured.spawns.some((s) => s.spec.systemPrompt?.startsWith('Persona: limited')), { timeout: 15_000 })
      .toBe(true);
    expect(manager!.dispatch(record.id, { objective: 'first from limited' })).toHaveProperty('id');
    expect(manager!.dispatch(record.id, { objective: 'second from limited' })).toMatchObject({
      refused: expect.stringContaining('allows at most 1 subtask; 1 already dispatched'),
    });
    releaseLimited();
    captured.hold = undefined;
    await settled(record.id);
  }, 60_000);

  it("a Continue arms the persona's dispatch limits only once its session attaches", async () => {
    const gate: WorkflowDef = { name: 'gate', source: 'file', steps: [{ id: 'g', prompt: '{{task}}', agent: 'gatekeeper' }] };
    const record = manager!.startRun(gate, { task: 'x', worktree: false, runner: 'claude' });
    await spawnAt(0);
    await settled(record.id);
    const live = () => (manager as unknown as { active: Map<string, { personaDispatch?: { name: string } }> }).active.get(record.id);
    let openMcp!: () => void;
    const mcpGate = new Promise<void>((resolve) => (openMcp = resolve));
    const mcp = vi
      .spyOn(manager as unknown as { privateMcpForLaunch: () => Promise<undefined> }, 'privateMcpForLaunch')
      .mockImplementationOnce(() => mcpGate.then(() => undefined));
    let release!: () => void;
    captured.hold = new Promise<void>((resolve) => (release = resolve));
    expect(manager!.continueRun(record.id, { text: 'again', runner: 'claude' })).toEqual({ ok: true });
    await expect.poll(() => mcp.mock.calls.length, { timeout: 15_000 }).toBe(1);
    expect(live()).toBeDefined();
    expect(live()?.personaDispatch).toBeUndefined();
    openMcp();
    await spawnAt(1);
    expect(live()?.personaDispatch).toMatchObject({ name: 'gatekeeper', stepId: 'g' });
    expect(manager!.dispatch(record.id, { objective: 'help me' })).toMatchObject({ refused: expect.stringContaining('allows no subtasks') });
    release();
    captured.hold = undefined;
    await expect
      .poll(() => store.getRun(record.id)?.steps.find((s) => s.id === 'continue-1')?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'failed', 'cancelled'].includes(String(status)));
    mcp.mockRestore();
  }, 60_000);

  it('fails the step rather than run a persona-less agent when the persona is gone', async () => {
    const ghost: WorkflowDef = { name: 'ghost', source: 'file', steps: [{ id: 'g', prompt: '{{task}}', agent: 'ghost' }] };
    const record = manager!.startRun(ghost, { task: 'x', worktree: false, runner: 'claude' });
    await settled(record.id);
    expect(captured.spawns).toEqual([]);
    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.error).toMatch(/persona "ghost"/);
  });

  describe('on graph nodes', () => {
    const graphDef = (graph: WorkflowGraph): WorkflowDef => {
      expect(graphIssues(graph)).toEqual([]);
      return { name: 'graph', source: 'file', steps: graphToSteps(graph), graph };
    };

    /** A persona'd agent node, then a fork whose branches are plain agents (or one persona'd). */
    const gateThenFork = (branchAgent?: string): WorkflowGraph => ({
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'gate', type: 'agent', prompt: 'gate {{task}}', agent: 'gatekeeper' },
        { id: 'fan', type: 'fork', branches: 2 },
        { id: 'one', type: 'agent', prompt: 'branch one', ...(branchAgent ? { agent: branchAgent } : {}) },
        { id: 'two', type: 'agent', prompt: 'branch two' },
        { id: 'meet', type: 'join', wait: 'all' },
      ],
      edges: [
        { from: 'start', to: 'gate' },
        { from: 'gate.done', to: 'fan' },
        { from: 'fan.1', to: 'one' },
        { from: 'fan.2', to: 'two' },
        { from: 'one.done', to: 'meet' },
        { from: 'two.done', to: 'meet' },
      ],
    });

    const childrenOf = (id: string) => store.listRuns().filter((r) => r.dispatch?.parentRunId === id);
    const notesOf = (id: string) =>
      store.readEvents(id).filter((e) => e.type === 'note').map((e) => String((e as { message?: unknown }).message));

    it('an agent node runs as its persona: backend, tools and system prompt', async () => {
      const graph: WorkflowGraph = {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'rev', type: 'agent', prompt: 'review {{task}}', agent: 'reviewer' },
        ],
        edges: [{ from: 'start', to: 'rev' }],
      };
      const record = manager!.startRun(graphDef(graph), { task: 'x', worktree: false, runner: 'codex' });
      const spawn = await spawnAt(0);
      await settled(record.id);
      expect(spawn.backend).toBe('claude');
      expect(spawn.spec.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
      expect(spawn.spec.systemPrompt).toMatch(/^Persona: reviewer\n\nYou review and never edit\./);
    }, 30_000);

    it("a fork after a persona'd node does not inherit that node's dispatch limits", async () => {
      const record = manager!.startRun(graphDef(gateThenFork()), { task: 'x', worktree: true, runner: 'claude' });
      await settled(record.id);
      expect(notesOf(record.id).some((n) => n.includes('allows no subtasks'))).toBe(false);
      expect(childrenOf(record.id)).toHaveLength(2);
      expect(store.getRun(record.id)?.status).not.toBe('failed');
    }, 60_000);

    it("the persona'd node's own session still honours its dispatch limits", async () => {
      let release!: () => void;
      captured.hold = new Promise<void>((resolve) => (release = resolve));
      const record = manager!.startRun(graphDef(gateThenFork()), { task: 'x', worktree: true, runner: 'claude' });
      await spawnAt(0);
      const refused = manager!.dispatch(record.id, { objective: 'help me' });
      expect(refused).toMatchObject({ refused: expect.stringContaining('the "gatekeeper" persona this task runs as allows no subtasks') });
      release();
      captured.hold = undefined;
      await settled(record.id);
    }, 60_000);

    it('a fork branch with a persona runs its child as that persona', async () => {
      const record = manager!.startRun(graphDef(gateThenFork('implementer')), { task: 'x', worktree: true, runner: 'claude' });
      await settled(record.id);
      const one = childrenOf(record.id).find((c) => c.title === 'one');
      expect(one?.runner).toBe('codex');
      expect(one?.workflowDef?.steps[0]).toMatchObject({ id: 'task', agent: 'implementer' });
      const two = childrenOf(record.id).find((c) => c.title === 'two');
      expect(two?.workflowDef?.steps[0]).not.toHaveProperty('agent');
    }, 60_000);
  });
});
