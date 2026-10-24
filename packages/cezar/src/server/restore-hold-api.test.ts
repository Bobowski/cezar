import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RESTORE_IN_PROGRESS_ERROR, type RunManager, type StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

/** A new task under a restore would queue into an index that is not written (spec 2026-10-23 §4). */
describe('POST /api/v1/runs while a restore holds admission', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let held: boolean;
  let started: number;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-restore-hold-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    held = true;
    started = 0;
    const manager = {
      restoreInProgress: () => held,
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        started += 1;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(async () => {
    store.flush();
    await removeTempDir(repoRoot);
  });

  const start = () =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'during the restore', steps: [{ id: 'work', prompt: '{{task}}' }] }),
    });

  it('answers 409 with the Continue message and starts nothing; once lifted it starts', async () => {
    const refused = await start();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: RESTORE_IN_PROGRESS_ERROR });
    expect(started).toBe(0);
    expect(store.listRuns()).toEqual([]);

    held = false;
    const ok = await start();
    expect(ok.status).toBeLessThan(300);
    expect(started).toBe(1);
  });
});
