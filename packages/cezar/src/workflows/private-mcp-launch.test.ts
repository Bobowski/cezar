import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { privateMcpPath, projectMcpPath } from '../core/private-mcp.ts';
import { approveProjectMcp, mcpContentHash } from '../mcp-servers/approval.ts';
import { readMcpStatus } from '../mcp-servers/status.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// Same capture stub as `continuation-tools.test.ts`: the seam under test is what the engine puts
// INTO the spec; each runner's spec → wire mapping is `private-mcp.test.ts`'s business.
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

const TASK: WorkflowDef = {
  name: 'one-step',
  source: 'file',
  steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
};

/** Spec 2026-10-07-private-project-mcp: the project's private servers reach every agent session. */
describe('private MCP servers at launch', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-private-mcp-launch-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    await removeTempDir(repoRoot);
  });

  function writePrivateMcp(servers: Record<string, unknown>): void {
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });
    writeFileSync(privateMcpPath(repoRoot), JSON.stringify({ mcpServers: servers }));
  }

  async function specAt(index: number): Promise<AgentRunSpec> {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.specs[index] as AgentRunSpec;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  function notes(runId: string): string[] {
    return store
      .readEvents(runId)
      .filter((e) => e.type === 'note')
      .map((e) => String((e as { message?: unknown }).message));
  }

  it('the opening session and its Continue both carry the servers, read fresh each launch', async () => {
    writePrivateMcp({ tracker: { command: 'tracker-mcp', env: { TOKEN: 't' } } });
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'claude' });
    const opening = await specAt(0);
    expect(opening.mcpServers?.map((s) => s.name)).toEqual(['tracker']);
    await settled(record.id);
    expect(notes(record.id)).toContain('private MCP servers from .ai/cezar/mcp.local.json: tracker');

    // An edit between sessions applies to the next one — no restart, no cache.
    writePrivateMcp({ tracker: { command: 'tracker-mcp' }, docs: { type: 'http', url: 'https://mcp.example.com/mcp' } });
    expect(manager!.continueRun(record.id, { text: 'more', runner: 'claude' })).toEqual({ ok: true });
    const resumed = await specAt(1);
    expect(resumed.mcpServers?.map((s) => s.name)).toEqual(['tracker', 'docs']);
    await settled(record.id);
  });

  it('no file → no servers and no note', async () => {
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'claude' });
    expect((await specAt(0)).mcpServers).toBeUndefined();
    await settled(record.id);
    expect(notes(record.id).some((n) => n.includes('MCP'))).toBe(false);
  });

  it('a runner with no launch-time channel gets a note instead of silence', async () => {
    writePrivateMcp({ tracker: { command: 'tracker-mcp' } });
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'cursor' });
    expect((await specAt(0)).mcpServers).toBeUndefined();
    await settled(record.id);
    expect(notes(record.id)).toContain('private MCP: cursor cannot attach tracker — cursor has no launch-time MCP channel');
  });

  it('project mcp.json and private mcp.local.json both reach the session, private winning, secrets resolved (spec 2026-10-24-easy-mcp)', async () => {
    manager?.dispose();
    const secrets = new SecretStore(process.env, { keychain: async () => null });
    await secrets.set({ kind: 'workspace' }, 'STRIPE_SECRET_KEY', 'sk_test_resolved_at_launch', ['cezar']);
    await secrets.set({ kind: 'workspace' }, 'CHECKS_ONLY', 'not-for-cezar-value', ['checks']);
    manager = new RunManager(store, repoRoot, { secrets });
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });
    const projectText = JSON.stringify({
      mcpServers: {
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
        shared: { command: 'from-project' },
        gated: { command: 'gated-mcp', env: { KEY: '${{ secrets.CHECKS_ONLY }}' } },
      },
    });
    writeFileSync(projectMcpPath(repoRoot), projectText);
    // The committed file is repo content: it reaches a session only once approved on this machine.
    expect(await approveProjectMcp(repoRoot, mcpContentHash(projectText), { gated: ['CHECKS_ONLY'] })).toEqual({ ok: true });
    writePrivateMcp({
      shared: { command: 'from-private' },
      stripe: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer ${{ secrets.STRIPE_SECRET_KEY }}' } },
    });
    const record = manager.startRun(TASK, { task: 'do it', worktree: false, runner: 'claude' });
    const opening = await specAt(0);
    expect(opening.mcpServers?.map((s) => [s.name, s.command ?? s.url])).toEqual([
      ['context7', 'npx'],
      ['shared', 'from-private'],
      ['stripe', 'https://mcp.stripe.com'],
    ]);
    expect(opening.mcpServers?.find((s) => s.name === 'stripe')?.headers).toEqual({ Authorization: 'Bearer sk_test_resolved_at_launch' });
    await settled(record.id);
    const runNotes = notes(record.id);
    expect(runNotes).toContain('MCP servers from .ai/cezar/mcp.json: context7');
    expect(runNotes).toContain('private MCP servers from .ai/cezar/mcp.local.json: shared, stripe');
    expect(runNotes.some((n) => n.startsWith('project MCP: MCP server "gated" skipped: secret CHECKS_ONLY is not available to cezar'))).toBe(true);
    // The resolved value never reaches the event log.
    expect(JSON.stringify(store.readEvents(record.id))).not.toContain('sk_test_resolved_at_launch');
    await expect.poll(async () => (await readMcpStatus(repoRoot)).get('private:stripe')?.state).toBe('injected');
    expect((await readMcpStatus(repoRoot)).get('project:gated')).toMatchObject({ state: 'failed', runId: record.id });
  });

  it('an unapproved committed mcp.json reaches no session — a note says why, the private file still applies', async () => {
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });
    writeFileSync(projectMcpPath(repoRoot), JSON.stringify({ mcpServers: { pulled: { command: 'repo-chosen-mcp' } } }));
    writePrivateMcp({ mine: { command: 'mine-mcp' } });
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'claude' });
    expect((await specAt(0)).mcpServers?.map((s) => s.name)).toEqual(['mine']);
    await settled(record.id);
    expect(notes(record.id).some((n) => n.startsWith('project MCP: MCP server "pulled" skipped: mcp.json is not approved on this machine'))).toBe(true);
  });

  it('a broken file is a note, never a failed run', async () => {
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });
    writeFileSync(privateMcpPath(repoRoot), '{not json');
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'claude' });
    expect((await specAt(0)).mcpServers).toBeUndefined();
    await settled(record.id);
    expect(store.getRun(record.id)?.status).not.toBe('failed');
    expect(notes(record.id).some((n) => n.startsWith('private MCP: mcp.local.json is not valid JSON'))).toBe(true);
  });
});
