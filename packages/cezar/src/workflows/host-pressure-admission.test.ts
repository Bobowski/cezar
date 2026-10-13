import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostUsage } from '@open-mercato/cezar-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { HOST_ADMISSION_STAGGER_MS, WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * Host-pressure admission against a real RunManager (spec 2026-10-13-host-pressure-admission):
 * the queue holds a run while the machine is short of memory, and a workflow step waits for a
 * busy machine as long as another run is still working.
 */

const GIB = 1024 * 1024 * 1024;
const usage = (availableGib: number): HostUsage => ({
  sampledAt: new Date(0).toISOString(),
  cpuCount: 8,
  memTotalBytes: 16 * GIB,
  memUsedBytes: (16 - availableGib) * GIB,
  memAvailableBytes: availableGib * GIB,
});

const hold = (ms: number) => `node -e "setTimeout(()=>{},${ms})"`;
const SLOW: WorkflowDef = { name: 'slow', source: 'built-in', steps: [{ id: 'hold', command: hold(3000) }] };
const INSTANT: WorkflowDef = { name: 'instant', source: 'built-in', steps: [{ id: 'noop', command: 'node -e ""' }] };
const TWO_STEPS: WorkflowDef = {
  name: 'two-steps',
  source: 'built-in',
  steps: [
    { id: 'first', command: hold(1000) },
    { id: 'second', name: 'Second', command: 'node -e ""' },
  ],
};

const settled = ['done', 'failed', 'cancelled', 'review'];

async function waitFor(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('host-pressure admission in the run engine', () => {
  const roots: string[] = [];
  let store: RunStore | undefined;
  let manager: RunManager | undefined;

  /** One project on a semaphore whose clock and host samples the test drives. */
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'cez-host-pressure-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
    let offset = 0;
    let listener: ((sample: HostUsage) => void) | undefined;
    const semaphore = new WorkspaceSemaphore({
      initial: { maxParallel: 4 },
      hostPressure: {
        onHostUsage(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      now: () => Date.now() + offset,
    });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root, { semaphore });
    return {
      store,
      manager,
      /** Skip the start stagger without waiting it out. */
      skipStagger: () => {
        offset += HOST_ADMISSION_STAGGER_MS;
      },
      feed: (sample: HostUsage, count: number) => {
        for (let i = 0; i < count; i += 1) listener?.(sample);
      },
    };
  }

  const notes = (s: RunStore, runId: string): string[] =>
    s.readEvents(runId).filter((e) => e.type === 'note').map((e) => String(e.message ?? ''));

  afterEach(async () => {
    if (store && manager) {
      for (const run of store.listRuns()) if (!settled.includes(run.status)) manager.cancel(run.id);
      const s = store;
      await waitFor(() => s.listRuns().every((r) => settled.includes(r.status)), 'runs to settle').catch(() => undefined);
      s.flush();
      manager.dispose();
    }
    store = undefined;
    manager = undefined;
    await removeTempDir(...roots.splice(0));
  });

  it('keeps a run queued while the machine is under pressure, then starts it', async () => {
    const h = setup();
    const holder = h.manager.startRun(SLOW, { task: 'hold a slot' });
    await waitFor(() => h.store.getRun(holder.id)?.status === 'running', 'the holder to run');
    h.skipStagger();
    h.feed(usage(2), 2);

    const queued = h.manager.startRun(INSTANT, { task: 'must wait for the machine' });
    await waitFor(
      () => notes(h.store, queued.id).includes('held in the queue — waiting for the machine (memory 88% used (2.0 GiB free))'),
      'the queue to say why it is holding the run',
    );
    expect(h.store.getRun(queued.id)?.status).toBe('queued');

    // Six calm samples lift the gate and the sampler tick itself re-pumps the queue.
    h.feed(usage(8), 6);
    await waitFor(() => h.store.getRun(queued.id)?.status === 'done', 'the held run to finish');
    expect(h.store.getRun(holder.id)?.status).toBe('running');
  }, 30_000);

  it('holds the next workflow step while another run is working, and releases it after', async () => {
    const h = setup();
    const other = h.manager.startRun(SLOW, { task: 'the other run' });
    await waitFor(() => h.store.getRun(other.id)?.status === 'running', 'the other run to start');
    h.skipStagger();
    const stepped = h.manager.startRun(TWO_STEPS, { task: 'two steps' });
    await waitFor(() => h.store.getRun(stepped.id)?.currentStepId === 'first', 'the first step to start');
    h.feed(usage(2), 2);

    await waitFor(
      () => notes(h.store, stepped.id).some((n) => n.startsWith('waiting for the machine before "Second"')),
      'the second step to be held',
    );
    expect(h.store.getRun(other.id)?.status).toBe('running');

    await waitFor(() => h.store.getRun(stepped.id)?.status === 'done', 'the held step to run once the other run ends');
    expect(h.store.getRun(other.id)?.status).toBe('done');
  }, 40_000);
});
