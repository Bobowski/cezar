import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRecordSchema, trackerReadScope, trackerRunIssueResponseSchema, type TrackerAssociation } from '@open-mercato/cezar-contract';
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
  const continued: Array<{ id: string; text?: string }> = [];
  let refuseNext = false;
  const manager = {
    continueRun: (id: string, input: { text?: string }) => {
      if (refuseNext) { refuseNext = false; return { ok: false, error: 'run is still active' }; }
      continued.push({ id, text: input.text });
      return { ok: true };
    },
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

  /** Phase 4: `GET /runs/:id/tracker-issue`, what `cez tracker issue` calls for an agent. */
  describe('the linked ticket, re-read for the run', () => {
    const linkedRun = async (instance: ReturnType<typeof app>) => {
      const association = await connect(instance);
      const response = await start(instance, { tracker: { itemId: 'DEMO51-2', expectedScope: trackerReadScope(association) } });
      return runRecordSchema.parse(await response.json());
    };
    const read = async (instance: ReturnType<typeof app>, runId: string, query = '') =>
      apiRequest(instance, `/api/v1/runs/${runId}/tracker-issue${query}`);

    it('returns the description and comments and says the ticket is unchanged since start', async () => {
      const instance = app();
      const run = await linkedRun(instance);
      const response = await read(instance, run.id);
      expect(response.status).toBe(200);
      const body = trackerRunIssueResponseSchema.parse(await response.json());
      if (!body.available || !body.comments.available) throw new Error('expected the ticket with its comments');
      expect(body.item.id).toBe('DEMO51-2');
      expect(body.comments.items.map(comment => comment.body)).toContain('Decision: keep the old endpoint, behind a deprecation warning.');
      expect(body).toMatchObject({ sinceStart: 'unchanged', statusAtStart: 'To Do' });
    });

    it('says "changed" when the content no longer matches the run\'s snapshot', async () => {
      const instance = app();
      const run = await linkedRun(instance);
      const link = run.trackerLinks![0]!;
      store.updateRun(run.id, { trackerLinks: [{ ...link, snapshot: { ...link.snapshot!, contentHash: 'a'.repeat(64) } }] });
      expect(await (await read(instance, run.id)).json()).toMatchObject({ available: true, sinceStart: 'changed' });
    });

    it('says "unknown" for a link without a snapshot and for another ticket of the scope', async () => {
      const instance = app();
      const run = await linkedRun(instance);
      const other = await (await read(instance, run.id, '?item=DEMO51-7')).json() as Record<string, unknown>;
      expect(other).toMatchObject({ available: true, item: { id: 'DEMO51-7' }, sinceStart: 'unknown' });
      expect('statusAtStart' in other).toBe(false);
      const { snapshot: _snapshot, ...bare } = run.trackerLinks![0]!;
      store.updateRun(run.id, { trackerLinks: [bare] });
      expect(await (await read(instance, run.id)).json()).toMatchObject({ available: true, sinceStart: 'unknown' });
    });

    it('refuses a run with no link, an unknown run, a ticket outside the scope and a malformed key', async () => {
      const instance = app();
      const run = await linkedRun(instance);
      const plain = runRecordSchema.parse(await (await start(instance, {})).json());
      expect((await read(instance, plain.id)).status).toBe(404);
      expect((await read(instance, 'no-such-run')).status).toBe(404);
      expect((await read(instance, run.id, '?item=DEMO51-9999')).status).toBe(404);
      expect((await read(instance, run.id, '?item=a%2Fb')).status).toBe(400);
    });

    it('does not read another scope once the project is pointed elsewhere, or disconnected', async () => {
      const instance = app();
      const run = await linkedRun(instance);
      await apiRequest(instance, '/api/v1/tracker/association', json('PUT', { kind: 'jira', sourceId: 'dry-jira', externalId: '52' }));
      expect(await (await read(instance, run.id)).json()).toMatchObject({ available: false, code: 'source_changed' });
      await apiRequest(instance, '/api/v1/tracker/association', { method: 'DELETE' });
      expect(await (await read(instance, run.id)).json()).toMatchObject({ available: false, code: 'not_configured' });
    });
  });

  describe('what an earlier or interrupted link still gets', () => {
    it('answers an earlier automation run with its ticket link derived, without storing it', async () => {
      const instance = app();
      const association = await connect(instance);
      const legacy = create('automation task');
      store.updateRun(legacy.id, { automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', association, key: 'DEMO51-2', url: 'https://demo.atlassian.net/browse/DEMO51-2' } });
      const one = runRecordSchema.parse(await (await apiRequest(instance, `/api/v1/runs/${legacy.id}`)).json());
      expect(one.trackerLinks).toEqual([expect.objectContaining({ itemId: 'DEMO51-2', origin: 'automation', sourceId: 'dry-jira', scopeId: '51' })]);
      const list = (await (await apiRequest(instance, '/api/v1/runs')).json()) as Array<{ id: string; trackerLinks?: unknown[] }>;
      expect(list.find(run => run.id === legacy.id)?.trackerLinks).toHaveLength(1);
      expect(store.getRun(legacy.id)?.trackerLinks).toBeUndefined();
      // And its agent can re-read that ticket.
      expect(await (await apiRequest(instance, `/api/v1/runs/${legacy.id}/tracker-issue`)).json()).toMatchObject({ available: true, item: { id: 'DEMO51-2' }, sinceStart: 'unknown' });
    });

    it('fills in a key-only link the next time anyone reads that ticket', async () => {
      const instance = app();
      await connect(instance);
      const run = create('started while the vendor was down');
      const bare = { provider: 'jira' as const, sourceId: 'dry-jira', scopeId: '51', itemId: 'DEMO51-2', origin: 'handoff' as const, linkedAt: '2026-10-11T10:00:00.000Z' };
      store.updateRun(run.id, { trackerLinks: [bare] });
      const untouched = create('another ticket');
      store.updateRun(untouched.id, { trackerLinks: [{ ...bare, itemId: 'DEMO51-7' }] });
      await apiRequest(instance, '/api/v1/tracker/DEMO51-2');
      expect(store.getRun(run.id)!.trackerLinks![0]).toMatchObject({ title: 'Tracker task 2', url: 'https://demo.atlassian.net/browse/DEMO51-2', latest: { status: 'To Do' } });
      expect(store.getRun(run.id)!.trackerLinks![0]!.snapshot).toBeUndefined();
      expect(store.getRun(untouched.id)!.trackerLinks![0]!.title).toBeUndefined();
    });
  });

  describe('continuing a linked task', () => {
    const linkedRun = async (instance: ReturnType<typeof app>) => {
      const association = await connect(instance);
      const response = await start(instance, { tracker: { itemId: 'DEMO51-2', expectedScope: trackerReadScope(association) } });
      return { association, run: runRecordSchema.parse(await response.json()) };
    };
    const resume = (instance: ReturnType<typeof app>, id: string, body: unknown = { text: 'Carry on.' }) =>
      apiRequest(instance, `/api/v1/runs/${id}/continue`, json('POST', body));

    it('adds nothing when the ticket is as the task knows it', async () => {
      const instance = app();
      const { run } = await linkedRun(instance);
      expect((await resume(instance, run.id)).status).toBe(200);
      expect(continued.at(-1)).toEqual({ id: run.id, text: 'Carry on.' });
    });

    it('tells the task, once, that its ticket moved on — after the user\'s own words', async () => {
      const instance = app();
      const { association, run } = await linkedRun(instance);
      await apiRequest(instance, '/api/v1/tracker/DEMO51-2/transition', json('POST', { expectedScope: trackerReadScope(association), toStatusId: 'dry-review', expectedStatusId: 'dry-todo' }));
      await resume(instance, run.id);
      const text = continued.at(-1)!.text!;
      expect(text.startsWith('Carry on.\n\n[cezar] The tracker ticket DEMO51-2')).toBe(true);
      expect(text).toContain('its status went from "To Do" to "In Review"');
      expect(text).not.toContain('title or description changed');
      // Announced once.
      await resume(instance, run.id);
      expect(continued.at(-1)).toEqual({ id: run.id, text: 'Carry on.' });
      expect(store.getRun(run.id)!.trackerLinks![0]).toMatchObject({ noted: { status: 'In Review' }, snapshot: { status: 'To Do' } });
    });

    it('keeps the note for the Continue that is accepted when one before it was refused', async () => {
      const instance = app();
      const { association, run } = await linkedRun(instance);
      await apiRequest(instance, '/api/v1/tracker/DEMO51-2/transition', json('POST', { expectedScope: trackerReadScope(association), toStatusId: 'dry-review', expectedStatusId: 'dry-todo' }));
      refuseNext = true;
      expect((await resume(instance, run.id)).status).toBe(409);
      // A refused Continue told the task nothing, so nothing is recorded as told.
      expect(store.getRun(run.id)!.trackerLinks![0]!.noted).toBeUndefined();
      expect((await resume(instance, run.id)).status).toBe(200);
      expect(continued.at(-1)!.text).toContain('[cezar] The tracker ticket DEMO51-2');
    });

    it('carries the note alone when the user sent no text', async () => {
      const instance = app();
      const { association, run } = await linkedRun(instance);
      await apiRequest(instance, '/api/v1/tracker/DEMO51-2/transition', json('POST', { expectedScope: trackerReadScope(association), toStatusId: 'dry-review', expectedStatusId: 'dry-todo' }));
      await resume(instance, run.id, {});
      expect(continued.at(-1)!.text!.startsWith('[cezar] The tracker ticket DEMO51-2')).toBe(true);
    });

    it('continues exactly as before when the tracker cannot answer, and for a task with no ticket', async () => {
      const instance = app();
      const { run } = await linkedRun(instance);
      await apiRequest(instance, '/api/v1/tracker/association', { method: 'DELETE' });
      expect((await resume(instance, run.id)).status).toBe(200);
      expect(continued.at(-1)).toEqual({ id: run.id, text: 'Carry on.' });
      const plain = runRecordSchema.parse(await (await start(instance, {})).json());
      await resume(instance, plain.id);
      expect(continued.at(-1)).toEqual({ id: plain.id, text: 'Carry on.' });
    });
  });
});
