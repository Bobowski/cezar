import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from './store.ts';

/** The archive's index, as a restore places it (spec 2026-10-23-backup-restore §10). */
const RESTORED = [{
  id: 'restored-1',
  title: 'from the backup',
  workflow: 'quick-task',
  task: 'from the backup',
  status: 'done',
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
}];

describe('RunStore.holdIndex — a restored runs.json survives the restart flush', () => {
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-hold-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('drops the pending debounced save and every flush while held; the next open reads the restored file', () => {
    const store = RunStore.open(dataDir);
    const mine = store.createRun({ title: 'local', workflow: 'quick-task', task: 'local', steps: [] });
    const release = store.holdIndex();
    const restored = JSON.stringify(RESTORED);
    writeFileSync(join(dataDir, 'runs.json'), restored);

    store.updateRun(mine.id, { title: 'renamed while held' });
    vi.advanceTimersByTime(5_000);
    store.flush({ pretty: true }); // index.ts restartCockpit
    store.flush({ throwOnError: true }); // startServer's shutdownLifecycle
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(restored);
    expect(RunStore.open(dataDir).listRuns().map((run) => run.id)).toEqual(['restored-1']);

    release();
    release(); // idempotent
    store.flush();
    expect(RunStore.open(dataDir).listRuns().map((run) => run.id).sort()).toEqual([mine.id, 'restored-1'].sort());
  });
});
