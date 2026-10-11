import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
import { writeTrackerAssociation } from '../../tracker-association.ts';
import { createTrackerService } from './index.ts';
import { createJiraClient } from './jira.ts';
import { createLinearClient } from './linear.ts';

/** Spec 2026-10-11-tracker-ticket-context § Phase 6: the tracker's one vendor write. */
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe('Linear status change', () => {
  const teamId = '11111111-1111-4111-8111-111111111111';
  const association: TrackerAssociation = { kind: 'linear', source: { id: 'org-1', webUrl: 'https://linear.app/acme' }, externalId: teamId, externalName: 'Engineering' };
  const states = [{ id: 's-todo', name: 'Todo', type: 'unstarted' }, { id: 's-progress', name: 'In Progress', type: 'started' }, { id: 's-done', name: 'Done', type: 'completed' }];
  const issue = (stateId: string) => ({
    id: 'issue-uuid', identifier: 'ENG-1', title: 'Fix', description: 'Detail', creator: { name: 'Ada' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    labels: { nodes: [], pageInfo: { hasNextPage: false } }, comments: { nodes: [], pageInfo: { hasNextPage: false } },
    state: states.find(state => state.id === stateId)!, team: { id: teamId }, url: 'https://linear.app/acme/issue/ENG-1/fix',
  });
  function setup(options: { mutate?: () => Response } = {}) {
    let state = 's-todo';
    const mutations: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (query.includes('TrackerSource')) return json({ data: { organization: { id: 'org-1', urlKey: 'acme' } } });
      if (query.includes('TrackerMoveIssue')) {
        mutations.push(variables);
        if (options.mutate) return options.mutate();
        state = String(variables.stateId);
        return json({ data: { issueUpdate: { success: true } } });
      }
      if (query.includes('TrackerIssueStates')) return json({ data: { issue: issue(state), workflowStates: { nodes: states } } });
      return json({ data: { issue: issue(state) } });
    }) as unknown as typeof fetch;
    return { driver: createLinearClient({ key: 'linear-secret' }, fetcher).driver(association), mutations, move: (to: string) => { state = to; } };
  }

  it('offers the team\'s other workflow states as targets', async () => {
    const result = await setup().driver.listTransitions!('ENG-1');
    expect(result).toEqual({ available: true, currentStatusId: 's-todo', writable: true, targets: [
      { statusId: 's-progress', status: 'In Progress', statusCategory: 'started', available: true },
      { statusId: 's-done', status: 'Done', statusCategory: 'done', available: true },
    ] });
  });

  it('moves the ticket with exactly one mutation, addressed by the issue\'s own id', async () => {
    const { driver, mutations } = setup();
    const result = await driver.transition!('ENG-1', { toStatusId: 's-progress', expectedStatusId: 's-todo' });
    expect(result).toMatchObject({ available: true, item: { id: 'ENG-1', statusId: 's-progress', status: 'In Progress' } });
    expect(mutations).toEqual([{ id: 'issue-uuid', stateId: 's-progress' }]);
  });

  it('writes nothing and reports the current ticket when someone moved it first', async () => {
    const { driver, mutations, move } = setup();
    move('s-done');
    const result = await driver.transition!('ENG-1', { toStatusId: 's-progress', expectedStatusId: 's-todo' });
    expect(result).toMatchObject({ available: false, code: 'conflict', item: { statusId: 's-done' } });
    expect(mutations).toEqual([]);
  });

  it('writes nothing for a status that is not one of the team\'s', async () => {
    const { driver, mutations } = setup();
    expect(await driver.transition!('ENG-1', { toStatusId: 's-other-team', expectedStatusId: 's-todo' })).toMatchObject({ available: false, code: 'unavailable' });
    expect(mutations).toEqual([]);
  });

  it('does not repeat a refused or failed mutation', async () => {
    const refused = setup({ mutate: () => json({ errors: [{ extensions: { code: 'FORBIDDEN' } }] }) });
    expect(await refused.driver.transition!('ENG-1', { toStatusId: 's-progress', expectedStatusId: 's-todo' })).toMatchObject({ available: false, code: 'unauthorized' });
    expect(refused.mutations).toHaveLength(1);
    const broken = setup({ mutate: () => json({ data: { issueUpdate: { success: false } } }) });
    expect(await broken.driver.transition!('ENG-1', { toStatusId: 's-progress', expectedStatusId: 's-todo' })).toMatchObject({ available: false, code: 'unavailable' });
    expect(broken.mutations).toHaveLength(1);
  });
});

describe('Jira status change', () => {
  const origin = 'https://acme.atlassian.net';
  const association: TrackerAssociation = { kind: 'jira', source: { id: 'cloud-1', webUrl: origin }, externalId: '10000', externalName: 'Project One' };
  const statuses: Record<string, { id: string; name: string; statusCategory: { key: string } }> = {
    todo: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
    progress: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    review: { id: '4', name: 'In Review', statusCategory: { key: 'indeterminate' } },
    done: { id: '5', name: 'Done', statusCategory: { key: 'done' } },
  };
  const transitions = [
    { id: '11', to: statuses.progress, hasScreen: false },
    // Two ways to Done: the first needs a screen, the second asks for nothing.
    { id: '21', to: statuses.done, hasScreen: true },
    { id: '22', to: statuses.done, hasScreen: false, fields: { resolution: { required: true, hasDefaultValue: true } } },
    { id: '31', to: statuses.review, hasScreen: false, fields: { reviewer: { required: true } } },
    { id: '41', to: statuses.todo },
  ];
  function setup(options: { post?: () => Response } = {}) {
    let status = statuses.todo!;
    const posts: { url: string; body: unknown }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${origin}/_edge/tenant_info`) return json({ cloudId: 'cloud-1' });
      if (url.includes('/comment?')) return json({ total: 0, comments: [] });
      if (url.includes('/transitions')) {
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          if (options.post) return options.post();
          const chosen = transitions.find(candidate => candidate.id === (JSON.parse(String(init.body)) as { transition: { id: string } }).transition.id)!;
          status = chosen.to!;
          return new Response(null, { status: 204 });
        }
        return json({ transitions });
      }
      return json({ id: '10001', key: 'PROJ-1', fields: { project: { id: '10000' }, summary: 'First issue', creator: { displayName: 'Ada' }, created: '2026-01-02T03:04:05.000+0000', updated: '2026-02-03T04:05:06.000+0000', labels: [], description: null, status } });
    }) as unknown as typeof fetch;
    const driver = createJiraClient({ origin, email: 'dev@example.com', token: 'jira-secret-token' }, fetcher).driver(association);
    return { driver, posts, move: (to: keyof typeof statuses) => { status = statuses[to]!; } };
  }

  it('lists one target per status, performable only when Jira asks for nothing, and never the current status', async () => {
    const result = await setup().driver.listTransitions!('PROJ-1');
    if (!result.available) throw new Error('expected targets');
    expect(result.currentStatusId).toBe('1');
    expect(result.targets).toEqual([
      { statusId: '3', status: 'In Progress', statusCategory: 'started', available: true },
      { statusId: '5', status: 'Done', statusCategory: 'done', available: true },
      { statusId: '4', status: 'In Review', statusCategory: 'started', available: false, reason: expect.stringContaining('requires fields') },
    ]);
  });

  it('posts the performable transition once and returns the ticket afterwards', async () => {
    const { driver, posts } = setup();
    const result = await driver.transition!('PROJ-1', { toStatusId: '5', expectedStatusId: '1' });
    expect(result).toMatchObject({ available: true, item: { id: 'PROJ-1', statusId: '5', status: 'Done', statusCategory: 'done' } });
    expect(posts).toHaveLength(1);
    expect(new URL(posts[0]!.url).pathname.endsWith('/rest/api/3/issue/PROJ-1/transitions')).toBe(true);
    // Not the screen transition 21: the one that needs nothing.
    expect(posts[0]!.body).toEqual({ transition: { id: '22' } });
  });

  it('never attempts a transition that needs a screen or a field, nor one Jira does not offer', async () => {
    const { driver, posts } = setup();
    expect(await driver.transition!('PROJ-1', { toStatusId: '4', expectedStatusId: '1' })).toMatchObject({ available: false, code: 'unavailable', reason: expect.stringContaining('requires fields') });
    expect(await driver.transition!('PROJ-1', { toStatusId: '999', expectedStatusId: '1' })).toMatchObject({ available: false, code: 'unavailable' });
    expect(posts).toEqual([]);
  });

  it('writes nothing and reports the current ticket when someone moved it first', async () => {
    const { driver, posts, move } = setup();
    move('review');
    expect(await driver.transition!('PROJ-1', { toStatusId: '5', expectedStatusId: '1' })).toMatchObject({ available: false, code: 'conflict', item: { statusId: '4' } });
    expect(posts).toEqual([]);
  });

  it('reports a refused write as unauthorized without leaking the token', async () => {
    const { driver, posts } = setup({ post: () => json({}, 403) });
    const result = await driver.transition!('PROJ-1', { toStatusId: '3', expectedStatusId: '1' });
    expect(result).toMatchObject({ available: false, code: 'unauthorized' });
    expect(JSON.stringify(result)).not.toContain('jira-secret-token');
    // Sent once: a refusal is not a cue to try the write again on the other transport.
    expect(posts).toHaveLength(1);
  });
});

describe('write access is discovered, not configured', () => {
  const team = '11111111-1111-4111-8111-111111111111';
  let root: string;
  let project: string;
  let mutations: string[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tracker-write-'));
    project = join(root, 'project');
    await mkdir(project);
    mutations = [];
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const fetcher: typeof fetch = async (_url, init) => {
    const key = (init?.headers as Record<string, string>).Authorization!;
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const state = { id: 's-todo', name: 'Todo', type: 'unstarted' };
    const issue = { id: 'issue-uuid', identifier: 'ENG-1', title: 'T', description: '', url: 'https://linear.app/same/issue/ENG-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', creator: null, team: { id: team }, state, labels: { nodes: [], pageInfo: { hasNextPage: false } }, comments: { nodes: [], pageInfo: { hasNextPage: false } } };
    if (query.includes('TrackerSource')) return json({ data: { organization: { id: 'same-org', urlKey: 'same' } } });
    if (query.includes('TrackerTeam(')) return json({ data: { team: { id: team, name: 'Team' } } });
    if (query.includes('TrackerMoveIssue')) {
      mutations.push(key);
      return key === 'read-only-key' ? json({ errors: [{ extensions: { code: 'FORBIDDEN' } }] }) : json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes('TrackerIssueStates')) return json({ data: { issue, workflowStates: { nodes: [state, { id: 's-done', name: 'Done', type: 'completed' }] } } });
    return json({ data: { issue } });
  };
  const dataDir = () => join(project, '.ai/cezar');
  async function connect(service: ReturnType<typeof createTrackerService>, key: string) {
    await service.saveConnection(project, { kind: 'linear', key });
    const resolved = await service.resolve(project, { kind: 'linear', sourceId: 'same-org', externalId: team, connectionId: (await service.connection(project)).connection?.id });
    if (!resolved.available) throw new Error(resolved.reason);
    await writeTrackerAssociation(dataDir(), resolved.association);
    const driver = await service.driver(project, dataDir());
    if ('available' in driver) throw new Error(driver.reason);
    return driver;
  }
  const move = { toStatusId: 's-done', expectedStatusId: 's-todo' };

  it('marks a connection read-only after its first refused write, stops sending writes, and clears on new credentials', async () => {
    const service = createTrackerService({ CEZ_HOME: join(root, 'home') }, fetcher);
    const readOnly = await connect(service, 'read-only-key');
    expect(await readOnly.listTransitions!('ENG-1')).toMatchObject({ available: true, writable: true });
    expect(await readOnly.transition!('ENG-1', move)).toMatchObject({ available: false, code: 'unauthorized', reason: expect.stringContaining('read-only') });
    expect(mutations).toEqual(['read-only-key']);
    // Remembered: the next attempt is refused locally, and the targets say why.
    expect(await readOnly.transition!('ENG-1', move)).toMatchObject({ available: false, code: 'unauthorized' });
    expect(mutations).toEqual(['read-only-key']);
    expect(await readOnly.listTransitions!('ENG-1')).toMatchObject({ available: true, writable: false, reason: expect.stringContaining('read-only') });
    // Reads are untouched.
    expect(await readOnly.getItem('ENG-1')).toMatchObject({ available: true });

    const writable = await connect(service, 'write-key');
    expect(await writable.listTransitions!('ENG-1')).toMatchObject({ available: true, writable: true });
    expect(await writable.transition!('ENG-1', move)).toMatchObject({ available: true });
    expect(mutations).toEqual(['read-only-key', 'write-key']);
  });
});

describe('who may reach the vendor write', () => {
  it('is only the cockpit\'s transition route, through the tracker service', async () => {
    const src = join(import.meta.dirname, '../..');
    const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
    const callers: string[] = [];
    for (const file of (await walk(src)).filter(path => /\.ts$/.test(path) && !/\.test\.ts$/.test(path))) {
      const text = await readFile(file, 'utf8');
      if (/\.transition!?\(/.test(text)) callers.push(file.slice(src.length + 1).replaceAll('\\', '/'));
    }
    // The service wrapper delegates to the adapter; server.ts holds the one route that calls the wrapper.
    expect(callers.sort()).toEqual(['server/server.ts', 'server/tracker/index.ts']);
    const server = await readFile(join(src, 'server/server.ts'), 'utf8');
    expect(server.match(/\.transition!?\(/g)).toHaveLength(1);
    expect(server).toContain(".post('/tracker/:id/transition'");
  });
});
