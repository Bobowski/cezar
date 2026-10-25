import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spawn, in order: which backend the engine asked for and the spec it handed over. */
const captured = vi.hoisted(() => ({ spawns: [] as Array<{ backend: string; spec: AgentRunSpec }> }));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (backend: string) => ({
    backend,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.spawns.push({ backend, spec });
      const sessionId = `sess-${captured.spawns.length}`;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId });
            resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          }, 0);
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-persona-wiring-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    const agents = join(repoRoot, '.ai/cezar/agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'implementer.md'), '---\nrunner: codex\ndescription: Writes the change.\n---\nYou implement.\n');
    writeFileSync(
      join(agents, 'reviewer.md'),
      '---\nrunner: claude\nmodel: opus\nallowedTools: [Read, Grep, Glob]\n---\nYou review and never edit.\n',
    );
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

  it('fails the step rather than run a persona-less agent when the persona is gone', async () => {
    const ghost: WorkflowDef = { name: 'ghost', source: 'file', steps: [{ id: 'g', prompt: '{{task}}', agent: 'ghost' }] };
    const record = manager!.startRun(ghost, { task: 'x', worktree: false, runner: 'claude' });
    await settled(record.id);
    expect(captured.spawns).toEqual([]);
    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.error).toMatch(/persona "ghost"/);
  });
});
