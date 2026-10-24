import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commentFingerprint } from '../runs/github-traces.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The agent's own GitHub traces as `handleRunnerUiEvent` records them off real tool events (spec
 * 2026-10-23-github-events §6): a `gh pr comment`, a GitHub MCP comment and a `git push`, in a
 * run's first session AND in a Continue — the two places a runner's events are handled. Driven dry
 * through `scripts/mock-claude.mjs` (`mock:github-traces`).
 */
describe('github traces recorded off the agent’s tool calls', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let head: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const SINGLE_STEP: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-traces-wiring-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    for (const record of store.listRuns()) manager.cancel(record.id);
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    try {
      await removeTempDir(repoRoot);
    } catch {
      /* a leftover temp folder is not a test failure */
    }
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status=${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  const bodies = (id: string) => (store.getRun(id)?.postedCommentBodies ?? []).map(({ hash, number }) => ({ hash, number }));

  it('keeps the comment ids, the scoped bodies and the pushed sha, first session and Continue alike', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:github-traces mock:done answer the review', worktree: false });
    // Finished, so the Continue below runs in `runContinuation`, the twin event handler.
    await waitFor(record.id, (r) => (r?.status === 'done' || r?.status === 'review') && (r.pushedShas?.length ?? 0) >= 1);
    const first = store.getRun(record.id)!;
    expect(first.postedComments).toEqual([4241, 4341]);
    expect(first.pushedShas).toEqual([head]);
    expect(bodies(record.id)).toEqual([
      { hash: commentFingerprint('On it, turn 1.'), number: 8 },
      { hash: commentFingerprint('MCP reply, turn 1.'), number: 8 },
    ]);

    const continued = manager.continueRun(record.id, { text: 'mock:github-traces again' });
    expect(continued.ok).toBe(true);
    await waitFor(record.id, (r) => (r?.postedComments?.length ?? 0) >= 4 && r?.status !== 'running');
    expect(store.getRun(record.id)!.postedComments).toEqual([4241, 4341, 4242, 4342]);
    expect(bodies(record.id).map((entry) => entry.hash)).toContain(commentFingerprint('MCP reply, turn 2.'));
  }, 60_000);
});
