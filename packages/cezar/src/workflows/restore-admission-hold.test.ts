import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RESTORE_IN_PROGRESS_ERROR, RunManager } from './run.ts';
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

  it('refuses a Continue while held — resumes never pass through the queue — and queues a deferred one', async () => {
    const savedDry = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    try {
      root = mkdtempSync(join(tmpdir(), 'cez-restore-hold-'));
      const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 4 } });
      store = RunStore.open(join(root, '.ai/cezar'));
      manager = new RunManager(store, root, { semaphore });
      const finished = (title: string) => {
        const run = store!.createRun({ title, workflow: 'quick-task', task: title, steps: [] });
        store!.addStep(run.id, { id: 'agent', name: 'Agent', kind: 'agent' });
        store!.updateStep(run.id, 'agent', { sessionId: `session-${title}`, status: 'done' });
        store!.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString() });
        return run.id;
      };
      const continued = finished('continued');
      const recovered = finished('recovered');
      // Never released here: the queued continuation must not start once the dry-run env is gone.
      semaphore.holdAdmission();
      expect(manager.restoreInProgress()).toBe(true);
      expect(manager.continueRun(continued, { text: 'more' })).toEqual({ ok: false, error: RESTORE_IN_PROGRESS_ERROR });
      expect(store.getRun(continued)?.status).toBe('done');
      // Restart recovery and auto-resume defer: they queue, and the held pump keeps them there.
      expect(manager.continueRun(recovered, { text: 'more' }, true)).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(store.getRun(recovered)?.status).toBe('queued');
      expect(manager.sendMessage(continued, [{ type: 'text', text: 'hi' }])).toBe(false);
    } finally {
      if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDry;
    }
  }, 30_000);
});
