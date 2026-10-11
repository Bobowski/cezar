import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  trackerItemsResponseSchema, trackerReadScope, trackerTransitionConflictSchema, trackerTransitionResponseSchema,
  trackerTransitionsResponseSchema, type TrackerAssociation,
} from '@open-mercato/cezar-contract';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/** Spec 2026-10-11-tracker-ticket-context § Phase 6, through the real routes and the demo tracker. */
describe('tracker status change API', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-tracker-move-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(async () => { store.flush(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await removeTempDir(root); });

  const app = () => createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const connect = async (instance: ReturnType<typeof app>, externalId = '51'): Promise<TrackerAssociation> =>
    ((await (await apiRequest(instance, '/api/v1/tracker/association', json('PUT', { kind: 'jira', sourceId: 'dry-jira', externalId }))).json()) as { association: TrackerAssociation }).association;
  const move = (instance: ReturnType<typeof app>, id: string, body: unknown) => apiRequest(instance, `/api/v1/tracker/${id}/transition`, json('POST', body));

  it('lists where a ticket may go, including a target that cannot be performed from here', async () => {
    const instance = app();
    const association = await connect(instance);
    // DEMO51-4 is in Backlog; the demo Jira asks for fields before Done.
    const response = await apiRequest(instance, `/api/v1/tracker/DEMO51-4/transitions?expectedScope=${encodeURIComponent(trackerReadScope(association))}`);
    expect(response.status).toBe(200);
    const body = trackerTransitionsResponseSchema.parse(await response.json());
    if (!body.available) throw new Error('expected targets');
    expect(body).toMatchObject({ currentStatusId: 'dry-backlog', writable: true });
    expect(body.targets.find(target => target.statusId === 'dry-backlog')).toBeUndefined();
    expect(body.targets.find(target => target.statusId === 'dry-progress')).toMatchObject({ available: true });
    expect(body.targets.find(target => target.statusId === 'dry-done')).toMatchObject({ available: false, reason: expect.stringContaining('Complete it in Jira') });
  });

  it('moves a ticket, and the list and detail then agree', async () => {
    const instance = app();
    const association = await connect(instance);
    const expectedScope = trackerReadScope(association);
    const response = await move(instance, 'DEMO51-2', { expectedScope, toStatusId: 'dry-review', expectedStatusId: 'dry-todo' });
    expect(response.status).toBe(200);
    expect(trackerTransitionResponseSchema.parse(await response.json())).toMatchObject({ available: true, item: { id: 'DEMO51-2', statusId: 'dry-review', status: 'In Review' } });
    expect(await (await apiRequest(instance, '/api/v1/tracker/DEMO51-2')).json()).toMatchObject({ item: { statusId: 'dry-review' } });
    const list = trackerItemsResponseSchema.parse(await (await apiRequest(instance, '/api/v1/tracker?limit=5&refresh=1')).json());
    if (!list.available) throw new Error('expected a list');
    expect(list.items.find(item => item.id === 'DEMO51-2')).toMatchObject({ statusId: 'dry-review' });
  });

  it('answers 409 with the current ticket, and changes nothing, when the status the user saw is stale', async () => {
    const instance = app();
    const expectedScope = trackerReadScope(await connect(instance));
    await move(instance, 'DEMO51-2', { expectedScope, toStatusId: 'dry-review', expectedStatusId: 'dry-todo' });
    const stale = await move(instance, 'DEMO51-2', { expectedScope, toStatusId: 'dry-done', expectedStatusId: 'dry-todo' });
    expect(stale.status).toBe(409);
    expect(trackerTransitionConflictSchema.parse(await stale.json())).toMatchObject({ item: { statusId: 'dry-review' } });
    expect(await (await apiRequest(instance, '/api/v1/tracker/DEMO51-2')).json()).toMatchObject({ item: { statusId: 'dry-review' } });
  });

  it('does not perform a move the tracker would need more input for', async () => {
    const instance = app();
    const expectedScope = trackerReadScope(await connect(instance));
    const blocked = await move(instance, 'DEMO51-4', { expectedScope, toStatusId: 'dry-done', expectedStatusId: 'dry-backlog' });
    expect(await blocked.json()).toMatchObject({ available: false, code: 'unavailable', reason: expect.stringContaining('Complete it in Jira') });
    expect(await (await apiRequest(instance, '/api/v1/tracker/DEMO51-4')).json()).toMatchObject({ item: { statusId: 'dry-backlog' } });
  });

  it('refuses a stale scope, a ticket outside the scope, a project with no tracker and a malformed body', async () => {
    const instance = app();
    expect(await (await move(instance, 'DEMO51-2', { expectedScope: 'x', toStatusId: 'dry-review', expectedStatusId: 'dry-todo' })).json()).toMatchObject({ available: false, code: 'not_configured' });
    const association = await connect(instance);
    const expectedScope = trackerReadScope(association);
    expect(await (await move(instance, 'DEMO51-2', { expectedScope: trackerReadScope({ ...association, externalId: '52' }), toStatusId: 'dry-review', expectedStatusId: 'dry-todo' })).json()).toMatchObject({ available: false, code: 'source_changed' });
    expect((await move(instance, 'DEMO51-9999', { expectedScope, toStatusId: 'dry-review', expectedStatusId: 'dry-todo' })).status).toBe(404);
    for (const body of [{}, { expectedScope, toStatusId: 'dry-review' }, { expectedScope, toStatusId: 'dry-review', expectedStatusId: 'dry-todo', force: true }, { toStatusId: 'dry-review', expectedStatusId: 'dry-todo' }]) {
      expect((await move(instance, 'DEMO51-2', body)).status).toBe(400);
    }
    expect(await (await apiRequest(instance, '/api/v1/tracker/DEMO51-2')).json()).toMatchObject({ item: { statusId: 'dry-todo' } });
  });

  it('tells the tasks linked to the ticket where it now stands, keeping what they started from', async () => {
    const instance = app();
    const association = await connect(instance);
    const link = (itemId: string, sourceId = 'dry-jira') => ({
      provider: 'jira' as const, sourceId, scopeId: '51', itemId, origin: 'handoff' as const, linkedAt: '2026-10-11T10:00:00.000Z',
      snapshot: { status: 'To Do', statusCategory: 'unstarted' as const, updatedAt: '2026-01-01T00:00:00.000Z', contentHash: 'a'.repeat(64), syncedAt: '2026-10-11T10:00:00.000Z' },
    });
    const run = (trackerLinks: ReturnType<typeof link>[] | undefined) => {
      const created = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 'work', name: 'work', kind: 'agent' }] });
      return trackerLinks ? store.updateRun(created.id, { trackerLinks })! : created;
    };
    const linked = run([link('DEMO51-2')]);
    const another = run([link('DEMO51-2')]);
    const otherTicket = run([link('DEMO51-7')]);
    const otherSource = run([link('DEMO51-2', 'another-site')]);
    const plain = run(undefined);

    await move(instance, 'DEMO51-2', { expectedScope: trackerReadScope(association), toStatusId: 'dry-review', expectedStatusId: 'dry-todo' });

    for (const id of [linked.id, another.id]) {
      const [updated] = store.getRun(id)!.trackerLinks!;
      expect(updated!.latest).toMatchObject({ status: 'In Review', statusCategory: 'started' });
      // The starting point is history and is not rewritten.
      expect(updated!.snapshot).toEqual(link('DEMO51-2').snapshot);
    }
    expect(store.getRun(otherTicket.id)!.trackerLinks![0]!.latest).toBeUndefined();
    expect(store.getRun(otherSource.id)!.trackerLinks![0]!.latest).toBeUndefined();
    expect(store.getRun(plain.id)!.trackerLinks).toBeUndefined();

    // A refused or stale move tells them nothing new.
    await move(instance, 'DEMO51-2', { expectedScope: trackerReadScope(association), toStatusId: 'dry-done', expectedStatusId: 'dry-todo' });
    expect(store.getRun(linked.id)!.trackerLinks![0]!.latest).toMatchObject({ status: 'In Review' });
  });

  it('keeps a demo move inside this process and this scope', async () => {
    const instance = app();
    const expectedScope = trackerReadScope(await connect(instance));
    await move(instance, 'DEMO51-2', { expectedScope, toStatusId: 'dry-review', expectedStatusId: 'dry-todo' });
    await connect(instance, '52');
    expect(await (await apiRequest(instance, '/api/v1/tracker/DEMO52-2')).json()).toMatchObject({ item: { statusId: 'dry-todo' } });
  });
});
