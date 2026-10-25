import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disableRunTokens, verifyRunToken } from '../auth/run-tokens.ts';
import { CHAT_ALLOWED_TOOLS, CHAT_WORKFLOW } from '../chat/chat.ts';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { DEFAULT_ALLOWED_TOOLS, QUICK_TASK_WORKFLOW } from './types.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// The seam under test is what the engine puts INTO the spec (as `private-mcp-launch.test.ts`).
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      const sessionId = `sess-${captured.specs.length}`;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId });
            resolve({ text: 'here is your workflow', toolCalls: [], tokensUsed: 0 });
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

/** Spec 2026-10-24-cockpit-chat §3/§8: a `kind: 'chat'` run and what its sessions are handed. */
describe('the cockpit chat run', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const saved = { url: process.env.CEZ_API_URL, bin: process.env.CEZ_BIN };

  beforeEach(async () => {
    captured.specs.length = 0;
    process.env.CEZ_API_URL = 'http://127.0.0.1:4999';
    process.env.CEZ_BIN = '/opt/cezar/dist/index.js';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-chat-run-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { projectId: 'proj' });
  });

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    disableRunTokens();
    for (const [key, value] of [['CEZ_API_URL', saved.url], ['CEZ_BIN', saved.bin]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    await removeTempDir(repoRoot);
  });

  async function specAt(index: number): Promise<AgentRunSpec> {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.specs[index] as AgentRunSpec;
  }

  async function settled(runId: string): Promise<string | undefined> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
    return store.getRun(runId)?.status;
  }

  function cezarServer(spec: AgentRunSpec) {
    return spec.mcpServers?.find((server) => server.name === 'cezar');
  }

  it('runs in the checkout with the chat prompt, the .ai/cezar tools and cezar\'s MCP — on the opening session AND a Continue', async () => {
    // Whatever the caller asks for, a chat runs in place and alone.
    const record = manager!.startRun(CHAT_WORKFLOW, { task: 'make me an e2e workflow', kind: 'chat', worktree: true, autonomous: true, runner: 'claude' });
    expect(record.kind).toBe('chat');
    expect(record.worktree).toBe(false);

    const opening = await specAt(0);
    expect(opening.cwd).toBe(repoRoot);
    expect(opening.allowedTools).toEqual(CHAT_ALLOWED_TOOLS);
    expect(opening.bashAllowlist).toBeUndefined();
    expect(opening.systemPrompt).toContain('You are the cezar chat for this project');
    expect(opening.systemPrompt).toContain('"proj"');
    const server = cezarServer(opening)!;
    expect(server).toMatchObject({ transport: 'stdio', command: process.execPath, args: ['/opt/cezar/dist/index.js', 'mcp', '--tools', 'all', '--as-run'] });
    expect(server.env).toMatchObject({ CEZ_API_URL: 'http://127.0.0.1:4999', CEZ_TASK_ID: record.id, CEZ_PROJECT_ID: 'proj' });
    expect(verifyRunToken(server.env.CEZ_API_TOKEN!)).toEqual({ runId: record.id, projectId: 'proj', scope: 'author' });

    // No review gate and no landing: a chat's turn ending is just a finished conversation.
    expect(await settled(record.id)).toBe('done');
    expect(store.getRun(record.id)?.landing).toBeUndefined();

    expect(manager!.continueRun(record.id, { text: 'now save it', runner: 'claude' })).toEqual({ ok: true });
    const resumed = await specAt(1);
    expect(resumed.cwd).toBe(repoRoot);
    expect(resumed.allowedTools).toEqual(CHAT_ALLOWED_TOOLS);
    expect(resumed.systemPrompt).toContain('You are the cezar chat for this project');
    expect(cezarServer(resumed)?.args).toContain('--as-run');
    expect(await settled(record.id)).toBe('done');
  });

  it('a chat on a cockpit with no address still runs, without the server, and says why', async () => {
    delete process.env.CEZ_API_URL;
    const record = manager!.startRun(CHAT_WORKFLOW, { task: 'hello', kind: 'chat', runner: 'claude' });
    const opening = await specAt(0);
    expect(cezarServer(opening)).toBeUndefined();
    expect(opening.systemPrompt).toContain('MCP server is not attached');
    await settled(record.id);
    const notes = store.readEvents(record.id).filter((e) => e.type === 'note').map((e) => String((e as { message?: unknown }).message));
    expect(notes.some((note) => note.startsWith('cezar MCP: this cockpit gave the chat no address'))).toBe(true);
  });

  it('an ordinary task is untouched: its own tools, no cezar server, no chat prompt', async () => {
    const record = manager!.startRun(QUICK_TASK_WORKFLOW, { task: 'fix it', worktree: false, runner: 'claude' });
    const opening = await specAt(0);
    expect(opening.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(cezarServer(opening)).toBeUndefined();
    expect(opening.systemPrompt ?? '').not.toContain('cezar chat');
    expect(store.getRun(record.id)?.kind).toBeUndefined();
    await settled(record.id);
  });

  it('streams a task\'s status changes back into the chat that started it', async () => {
    const chat = store.createRun({ title: 'chat', workflow: 'chat', task: 'hi', kind: 'chat', worktree: false, steps: [] });
    const task = store.createRun({ title: 'add e2e', workflow: 'quick-task', task: 'add e2e', createdBy: `chat:${chat.id}`, steps: [] });
    store.updateRun(task.id, { status: 'running' });
    store.updateRun(task.id, { status: 'review' });
    store.updateRun(task.id, { status: 'review', tokensUsed: 5 }); // no change, no note
    const notes = store.readEvents(chat.id).filter((e) => e.type === 'note');
    expect(notes.map((e) => (e as { message?: string }).message)).toEqual([`task ${task.id.slice(0, 8)} "add e2e" reached review`]);
    expect((notes[0] as { taskId?: string }).taskId).toBe(task.id);
  });
});
