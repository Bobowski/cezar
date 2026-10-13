import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * A worktree-off task works in the user's checkout, so nothing forks it from a fresh
 * `origin/<base>`. Before it starts, a checkout that is clean and merely behind origin is
 * fast-forwarded; anything else is left exactly as it is, with a note saying so.
 * Dry (`mock-claude`), so the upstream state is what a manual `git fetch` left in `origin/main`.
 */
describe('an in-place task starts on an up-to-date checkout', () => {
  let origin: string;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    origin = mkdtempSync(join(tmpdir(), 'cez-inplace-origin-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-inplace-work-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: origin });
    writeFileSync(join(origin, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: origin });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: origin });
    await run('git', ['clone', '-q', '-c', 'gc.auto=0', origin, repoRoot], { cwd: tmpdir() });
    writeFileSync(join(repoRoot, '.git/info/exclude'), '.ai/\n');
    writeFileSync(join(origin, 'upstream.txt'), 'new\n');
    await run('git', ['add', '-A'], { cwd: origin });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'upstream'], { cwd: origin });
    await run('git', ['fetch', '-q', 'origin'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    for (const record of store.listRuns()) manager.cancel(record.id);
    manager.dispose();
    vi.unstubAllEnvs();
    store.flush();
    await removeTempDir(repoRoot, origin);
  });

  const settled = async (id: string): Promise<RunRecord> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const record = store.getRun(id);
      if (record && record.status !== 'queued' && record.status !== 'running') return record;
      if (Date.now() > deadline) throw new Error('run did not settle in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const notes = (id: string): string[] =>
    store.readEvents(id).flatMap((event) => (event.type === 'note' ? [String(event.message)] : []));
  const head = async () => (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();

  it('fast-forwards a clean checkout and anchors the task at the new tip', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done work in place', worktree: false });
    const done = await settled(record.id);
    expect(existsSync(join(repoRoot, 'upstream.txt'))).toBe(true);
    expect(notes(record.id)).toContain('fast-forwarded the checkout by 1 commit(s) from origin before starting');
    expect(done.baseBranch).toBe(await head());
  });

  it('leaves a dirty checkout alone and says it is behind', async () => {
    writeFileSync(join(repoRoot, 'a.txt'), 'edited\n');
    const before = await head();
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done work in place', worktree: false });
    await settled(record.id);
    expect(await head()).toBe(before);
    expect(readFileSync(join(repoRoot, 'a.txt'), 'utf8')).toBe('edited\n');
    expect(notes(record.id).some((m) => m.startsWith('the checkout is 1 commit(s) behind origin/main and was left as it is'))).toBe(true);
  });

  it('CEZ_REPO_AUTO_SYNC=0 leaves the checkout where it was', async () => {
    vi.stubEnv('CEZ_REPO_AUTO_SYNC', '0');
    const before = await head();
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done work in place', worktree: false });
    await settled(record.id);
    expect(await head()).toBe(before);
    expect(notes(record.id).some((m) => m.includes('fast-forwarded') || m.includes('behind origin'))).toBe(false);
  });
});
