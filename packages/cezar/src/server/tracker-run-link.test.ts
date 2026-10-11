import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRecordSchema, trackerReadScope, type TrackerAssociation } from '@open-mercato/cezar-contract';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/** Spec 2026-10-11-tracker-ticket-context, phase 1: `POST /runs` records the ticket a task is for. */
describe('POST /runs ticket link', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-tracker-link-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(async () => { store.flush(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await removeTempDir(root); });

  const create = (task: string) => store.createRun({ title: task, workflow: 'quick-task', task, steps: [{ id: 'work', name: 'work', kind: 'agent' }] });
  const manager = {
    startRun: (_workflow: unknown, input: { task: string }) => create(input.task),
    startVariants: (_workflow: unknown, input: { task: string }, count: number) => Array.from({ length: count }, () => create(input.task)),
  } as unknown as RunManager;
  const app = () => createApp({ repoRoot: root, store, manager, version: 'test' });
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const connect = async (instance: ReturnType<typeof app>): Promise<TrackerAssociation> =>
    ((await (await apiRequest(instance, '/api/v1/tracker/association', json('PUT', { kind: 'jira', sourceId: 'dry-jira', externalId: '51' }))).json()) as { association: TrackerAssociation }).association;
  const start = (instance: ReturnType<typeof app>, body: Record<string, unknown>) =>
    apiRequest(instance, '/api/v1/runs', json('POST', { workflow: 'quick-task', task: 'Work on the ticket', ...body }));

  it('links the run to the ticket from the saved scope and the server\'s own read', async () => {
    const instance = app();
    const association = await connect(instance);
    const response = await start(instance, { tracker: { itemId: 'DEMO51-2', expectedScope: trackerReadScope(association) } });
    expect(response.status).toBe(201);
    const run = runRecordSchema.parse(await response.json());
    expect(run.trackerLinks).toHaveLength(1);
    expect(run.trackerLinks![0]).toMatchObject({
      provider: 'jira', sourceId: 'dry-jira', scopeId: '51', itemId: 'DEMO51-2', origin: 'handoff',
      title: 'Tracker task 2', url: 'https://demo.atlassian.net/browse/DEMO51-2',
      snapshot: { status: 'To Do', statusCategory: 'unstarted' },
    });
    expect(run.trackerLinks![0]!.snapshot!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Durable, not just echoed: the stored record carries it.
    expect(store.getRun(run.id)?.trackerLinks?.[0]?.itemId).toBe('DEMO51-2');
  });

  it('links a second task to the same ticket rather than replacing the first', async () => {
    const instance = app();
    const association = await connect(instance);
    const body = { tracker: { itemId: 'DEMO51-1', expectedScope: trackerReadScope(association) } };
    expect((await start(instance, body)).status).toBe(201);
    expect((await start(instance, body)).status).toBe(201);
    expect(store.listRuns().filter(run => run.trackerLinks?.[0]?.itemId === 'DEMO51-1')).toHaveLength(2);
  });

  it('starts an ordinary run, with no link, when the body names no ticket', async () => {
    const instance = app();
    await connect(instance);
    const response = await start(instance, {});
    expect(response.status).toBe(201);
    expect(runRecordSchema.parse(await response.json()).trackerLinks).toBeUndefined();
  });

  it('refuses a stale scope, an unknown ticket and a project with no tracker — and starts nothing', async () => {
    const instance = app();
    const unconfigured = await start(instance, { tracker: { itemId: 'DEMO51-2', expectedScope: 'anything' } });
    expect(unconfigured.status).toBe(409);
    const association = await connect(instance);
    const stale = await start(instance, { tracker: { itemId: 'DEMO51-2', expectedScope: trackerReadScope({ ...association, externalId: '52' }) } });
    expect(stale.status).toBe(409);
    const missing = await start(instance, { tracker: { itemId: 'DEMO51-9999', expectedScope: trackerReadScope(association) } });
    expect(missing.status).toBe(404);
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects a malformed tracker key as a 400', async () => {
    const instance = app();
    await connect(instance);
    expect((await start(instance, { tracker: { itemId: 'a/b', expectedScope: 'x' } })).status).toBe(400);
    expect((await start(instance, { tracker: { itemId: 'DEMO51-2', expectedScope: 'x', url: 'https://evil.example' } })).status).toBe(400);
    expect(store.listRuns()).toHaveLength(0);
  });
});
