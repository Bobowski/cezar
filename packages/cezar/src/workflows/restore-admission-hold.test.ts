import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/** A restore holds run admission until the process restarts (spec 2026-10-23-backup-restore §4). */
const INSTANT: WorkflowDef = { name: 'instant', source: 'built-in', steps: [{ id: 'noop', command: 'node -e ""' }] };

async function waitFor(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the restore admission hold', () => {
  let root: string | undefined;
  let store: RunStore | undefined;
  let manager: RunManager | undefined;

  afterEach(async () => {
    store?.flush();
    manager?.dispose();
    await removeTempDir(root);
  });

  it('keeps a new run queued while held, and starts it on release', async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-restore-hold-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 4 } });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root, { semaphore });
    const release = semaphore.holdAdmission();
    expect(semaphore.admissionHeld()).toBe(true);
    const run = manager.startRun(INSTANT, { task: 'waits for the restore' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(store.getRun(run.id)?.status).toBe('queued');
    release();
    release(); // idempotent: a second call must not lift someone else's hold
    expect(semaphore.admissionHeld()).toBe(false);
    const s = store;
    await waitFor(() => s.getRun(run.id)?.status === 'done', 'the held run to finish');
  }, 30_000);
});
