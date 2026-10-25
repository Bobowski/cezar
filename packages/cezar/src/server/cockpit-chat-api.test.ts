import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableRunTokens, mintChatRunToken } from '../auth/run-tokens.ts';
import { CHAT_WORKFLOW } from '../chat/chat.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { AutomationStore } from '../automations/store.ts';
import { ensureDataGitignore } from '../data-gitignore.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

/**
 * The cockpit chat's HTTP half (spec 2026-10-24-cockpit-chat §3–§5): `POST /runs { kind: 'chat' }`,
 * `GET /runs?kind=`, the `createdBy` a chat's token stamps on the tasks it starts, and that token's
 * `author` bound — on a LOCAL cockpit, where every other caller is the owner.
 */
describe('cockpit chat API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let started: Array<{ workflow: WorkflowDef; input: StartRunInput }>;
  let active: Set<string>;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-chat-api-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    started = [];
    active = new Set();
    const manager = {
      isActive: (id: string) => active.has(id),
      cancel: () => true,
      startRun: (workflow: WorkflowDef, input: StartRunInput) => {
        started.push({ workflow, input });
        return store.createRun({
          title: input.task, workflow: workflow.name, task: input.task, steps: [],
          ...(input.kind ? { kind: input.kind } : {}), ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', bootProjectId: 'boot', providerAuth: connectedProviderAuth() }) as unknown as Hono;
  });

  afterEach(() => {
    disableRunTokens();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const json = { 'content-type': 'application/json' };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    apiRequest(app, path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });

  /** A chat record that is running, and its MCP token for the launch the record names. */
  function liveChat(): { id: string; bearer: Record<string, string> } {
    const chat = store.createRun({ title: 'chat', workflow: 'chat', task: 'hi', kind: 'chat', worktree: false, steps: [] });
    store.updateRun(chat.id, { launchNonce: 'launch-1' });
    active.add(chat.id);
    return { id: chat.id, bearer: { authorization: `Bearer ${mintChatRunToken(chat.id, 'boot', 'launch-1')}` } };
  }

  it('the token is the launch\'s: a relaunch, an archive or a delete revokes it', async () => {
    const runs = (headers: Record<string, string>) => apiRequest(app, '/api/v1/p/boot/runs', { headers });
    const chat = liveChat();
    expect((await runs(chat.bearer)).status).toBe(200);
    // The next session's launch rotates the nonce; the previous token is dead though the chat runs.
    store.updateRun(chat.id, { launchNonce: 'launch-2' });
    expect((await runs(chat.bearer)).status).toBe(401);
    const next = { authorization: `Bearer ${mintChatRunToken(chat.id, 'boot', 'launch-2')}` };
    expect((await runs(next)).status).toBe(200);
    expect((await post(`/api/v1/runs/${chat.id}/archive`, {})).status).toBe(200);
    expect(store.getRun(chat.id)?.launchNonce).toBeUndefined();
    expect((await runs(next)).status).toBe(401);

    const other = liveChat();
    expect((await runs(other.bearer)).status).toBe(200);
    store.deleteRun(other.id);
    expect((await runs(other.bearer)).status).toBe(401);
  });

  it('starts a chat with its own workflow, and refuses one with a chain or variants', async () => {
    const res = await post('/api/v1/runs', { kind: 'chat', task: 'make me a workflow' });
    expect(res.status).toBe(201);
    expect(started[0]?.workflow).toBe(CHAT_WORKFLOW);
    expect(started[0]?.input.kind).toBe('chat');
    expect(((await res.json()) as { kind?: string }).kind).toBe('chat');
    expect((await post('/api/v1/runs', { kind: 'chat', task: 't', workflow: 'quick-task' })).status).toBe(400);
    expect((await post('/api/v1/runs', { kind: 'chat', task: 't', steps: [{ id: 'a', prompt: '{{task}}' }] })).status).toBe(400);
    expect((await post('/api/v1/runs', { kind: 'chat', task: 't', variants: 2 })).status).toBe(400);
    // A task still needs exactly one of the two.
    expect((await post('/api/v1/runs', { task: 't' })).status).toBe(400);
    expect(started).toHaveLength(1);
  });

  it('GET /runs lists tasks; ?kind=chat the chats, ?kind=all both', async () => {
    store.createRun({ title: 'task', workflow: 'quick-task', task: 'a', steps: [] });
    store.createRun({ title: 'chat', workflow: 'chat', task: 'b', kind: 'chat', worktree: false, steps: [] });
    const titles = async (query: string) =>
      ((await (await apiRequest(app, `/api/v1/runs${query}`)).json()) as Array<{ title: string }>).map((run) => run.title).sort();
    expect(await titles('?kind=chat')).toEqual(['chat']);
    expect(await titles('?kind=task')).toEqual(['task']);
    // Chats only when asked: runs_list, `cez task list` and every script see tasks.
    expect(await titles('')).toEqual(['task']);
    expect(await titles('?kind=all')).toEqual(['chat', 'task']);
    expect((await apiRequest(app, '/api/v1/runs?kind=bogus')).status).toBe(400);
  });

  it('archive-finished sweeps finished tasks, not a chat parked between messages', async () => {
    const task = store.createRun({ title: 'task', workflow: 'quick-task', task: 'a', steps: [] });
    const chat = store.createRun({ title: 'chat', workflow: 'chat', task: 'b', kind: 'chat', worktree: false, steps: [] });
    store.updateRun(task.id, { status: 'done' });
    store.updateRun(chat.id, { status: 'done' });
    const res = await post('/api/v1/runs/archive-finished', {});
    expect(await res.json()).toEqual({ archived: 1 });
    expect(store.getRun(task.id)?.archived).toBe(true);
    expect(store.getRun(chat.id)?.archived).toBeFalsy();
  });

  it('a task the chat starts carries createdBy chat:<id>; a body cannot claim it, and a chat cannot start a chat', async () => {
    const chat = liveChat();
    const res = await post('/api/v1/p/boot/runs', { workflow: 'quick-task', task: 'fix the footer' }, chat.bearer);
    expect(res.status).toBe(201);
    expect(started[0]?.input.createdBy).toBe(`chat:${chat.id}`);
    expect(((await res.json()) as { createdBy?: string }).createdBy).toBe(`chat:${chat.id}`);
    // The owner's own task has no provenance, whatever the body says.
    expect((await post('/api/v1/runs', { workflow: 'quick-task', task: 'mine', createdBy: `chat:${chat.id}` })).status).toBe(201);
    expect(started[1]?.input.createdBy).toBeUndefined();
    expect((await post('/api/v1/p/boot/runs', { kind: 'chat', task: 'again' }, chat.bearer)).status).toBe(403);
  });

  it('a task the chat starts runs in its own worktree, not autonomous, and stops at review — whatever the body asks', async () => {
    const chat = liveChat();
    expect((await post('/api/v1/p/boot/runs', { workflow: 'quick-task', task: 'plain' }, chat.bearer)).status).toBe(201);
    expect(started[0]?.input).toMatchObject({ worktree: true, autonomous: false });
    // In place (which lands, and pushes, on a `landing: auto` project) or autonomous: refused.
    for (const body of [{ worktree: false }, { autonomous: true }, { readOnly: true }, { worktree: false, autonomous: true }, { newBranch: true }, { dispatch: {} }]) {
      const res = await post('/api/v1/p/boot/runs', { workflow: 'quick-task', task: 'in place', ...body }, chat.bearer);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(started).toHaveLength(1);
    // The owner's own POST is untouched.
    expect((await post('/api/v1/runs', { workflow: 'quick-task', task: 'mine', worktree: false, autonomous: true })).status).toBe(201);
    expect(started[1]?.input).toMatchObject({ worktree: false, autonomous: true });
  });

  it('the chat starts tasks through runs_create only: no inbox start, no automation launch or enable', async () => {
    const chat = liveChat();
    for (const path of ['/todos/t1/start', '/automations/a1/run', '/automations/a1/enable', '/automations/a1/pause', '/automations/a1/check', '/automation-log/r1/retry']) {
      expect((await post(`/api/v1/p/boot${path}`, {}, chat.bearer)).status, path).toBe(403);
    }
  });

  const automationInput = { name: 'Review issues', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}' } };
  const proposedAutomations = (chatId: string) =>
    JSON.parse(readFileSync(join(repoRoot, '.ai/cezar/proposals', chatId, 'automations.json'), 'utf8')) as { automations: Array<{ id: string; name: string; enabled: boolean }> };

  it('a chat cannot arm an automation: POST with enable is refused, and what it creates is a paused proposal', async () => {
    const chat = liveChat();
    const put = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      apiRequest(app, `/api/v1/p/boot/automations/${id}`, { method: 'PUT', headers: { ...json, ...headers }, body: JSON.stringify(body) });
    expect((await post('/api/v1/p/boot/automations', { ...automationInput, enable: true }, chat.bearer)).status).toBe(403);
    const created = await post('/api/v1/p/boot/automations', automationInput, chat.bearer);
    expect(created.status).toBe(201);
    const { id, revision } = ((await created.json()) as { automation: { id: string; revision: number } }).automation;
    // Nothing reached the live store: the proposal is all there is.
    expect(AutomationStore.open(join(repoRoot, '.ai/cezar')).list()).toEqual([]);
    expect(existsSync(join(repoRoot, '.ai/cezar/automations.json'))).toBe(false);
    expect(proposedAutomations(chat.id).automations).toMatchObject([{ id, enabled: false }]);
    // It edits its own proposal, never into an enabled one.
    expect((await put(id, { ...automationInput, enabled: true, expectedRevision: revision }, chat.bearer)).status).toBe(403);
    expect((await put(id, { ...automationInput, name: 'Renamed', expectedRevision: revision }, chat.bearer)).status).toBe(200);
    expect(proposedAutomations(chat.id).automations).toMatchObject([{ id, name: 'Renamed', enabled: false }]);
  });

  it('a chat never edits a live automation that is on', async () => {
    const chat = liveChat();
    const owned = await post('/api/v1/p/boot/automations', { ...automationInput, enable: true });
    expect(owned.status).toBe(201);
    const { id, revision } = ((await owned.json()) as { automation: { id: string; revision: number } }).automation;
    const res = await apiRequest(app, `/api/v1/p/boot/automations/${id}`, {
      method: 'PUT', headers: { ...json, ...chat.bearer }, body: JSON.stringify({ ...automationInput, enabled: false, name: 'x', expectedRevision: revision }),
    });
    expect(res.status).toBe(403);
    expect((await apiRequest(app, `/api/v1/p/boot/automations/${id}`, { method: 'DELETE', headers: chat.bearer })).status).toBe(403);
  });

  it('acts only on the tasks it started — never the owner\'s, another chat\'s, another chat, or itself', async () => {
    const chat = liveChat();
    const other = liveChat();
    const task = (over: Record<string, unknown> = {}) => store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [], ...over });
    const mine = task({ createdBy: `chat:${chat.id}` });
    const targets = {
      owner: task().id,
      otherChats: task({ createdBy: `chat:${other.id}` }).id,
      otherChat: other.id,
      itself: chat.id,
    };
    const mutations: Array<[string, (id: string) => string, unknown?]> = [
      ['POST', (id) => `/runs/${id}/messages`, { text: 'hi' }],
      ['POST', (id) => `/runs/${id}/continue`, {}],
      ['POST', (id) => `/runs/${id}/cancel`],
      ['POST', (id) => `/runs/${id}/archive`, {}],
      ['POST', (id) => `/runs/${id}/remove-worktree`],
      ['PATCH', (id) => `/runs/${id}`, { title: 'x' }],
      ['DELETE', (id) => `/runs/${id}`],
    ];
    const call = (method: string, path: string, body?: unknown) =>
      apiRequest(app, `/api/v1/p/boot${path}`, { method, headers: { ...json, ...chat.bearer }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const [name, id] of Object.entries(targets)) {
      for (const [method, path, body] of mutations) expect((await call(method, path(id), body)).status, `${method} ${path(id)} (${name})`).toBe(403);
      // Reading stays the read scope's.
      expect((await call('GET', `/runs/${id}`)).status, name).toBe(200);
    }
    expect((await call('POST', `/runs/${mine.id}/cancel`)).status).toBe(200);
    // Bulk sweeps reach every run, so they are no chat's.
    expect((await call('POST', '/runs/archive-finished')).status).toBe(403);
    expect((await call('POST', '/runs/read-all')).status).toBe(403);
    // A variant group is the chat's only when every run in it is.
    task({ groupId: 'g-owner', variant: 'a' });
    const picked = task({ groupId: 'g-mine', variant: 'a', createdBy: `chat:${chat.id}` });
    expect((await call('POST', '/groups/g-owner/pick', { runId: 'x' })).status).toBe(403);
    expect((await call('POST', '/groups/g-mine/pick', { runId: picked.id })).status).not.toBe(403);
  });

  it('the chat token is author on its own project even with sign-in off — never admin, never another project', async () => {
    const chat = liveChat();
    expect((await apiRequest(app, '/api/v1/p/boot/runs', { headers: chat.bearer })).status).toBe(200);
    expect((await post('/api/v1/p/boot/repo/commit', { message: 'x' }, chat.bearer)).status).toBe(403);
    expect((await apiRequest(app, '/api/v1/p/boot/config', { method: 'PUT', headers: { ...json, ...chat.bearer }, body: '{}' })).status).toBe(403);
    expect((await apiRequest(app, '/api/v1/p/elsewhere/runs', { headers: chat.bearer })).status).toBe(403);
    // A finished chat's token opens nothing.
    active.delete(chat.id);
    expect((await apiRequest(app, '/api/v1/p/boot/runs', { headers: chat.bearer })).status).toBe(401);
  });

  it('over MCP it lists the tools it reaches and addresses its own project by default', async () => {
    const chat = liveChat();
    const rpc = (body: unknown) =>
      apiRequest(app, '/api/v1/mcp?tools=all', {
        method: 'POST',
        headers: { ...json, accept: 'application/json, text/event-stream', ...chat.bearer },
        body: JSON.stringify(body),
      });
    const listed = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).text();
    const names = [...listed.matchAll(/"name":"([a-z0-9_]+)"/g)].map((match) => match[1]!);
    expect(names).toEqual(expect.arrayContaining(['runs_create', 'runs_list', 'workflows_put', 'repo_changes']));
    // admin's (the checkout's git, project config, containers) and what a chat is denied (push, PR, land).
    for (const name of names) expect(name).not.toMatch(/^(repo_(push|pull|commit|stage|discard)$|config_|docker_stacks_|runs_(land|pr|git_push|finish)$)/);
    // The same names exist: the owner (no token on a local cockpit) is listed them.
    const owner = await (await apiRequest(app, '/api/v1/mcp?tools=all', {
      method: 'POST',
      headers: { ...json, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    })).text();
    for (const name of ['repo_commit', 'repo_push', 'runs_land', 'runs_pr']) expect(owner).toContain(`"${name}"`);
    const call = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'runs_create', arguments: { workflow: 'quick-task', task: 'from the chat' } } })).text();
    expect(call).not.toContain('"isError":true');
    expect(started.at(-1)?.input.createdBy).toBe(`chat:${chat.id}`);
  });

  /** A git checkout for the tests that commit. */
  function gitInit(): void {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repoRoot, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    ensureDataGitignore(repoRoot);
    writeFileSync(join(repoRoot, 'README.md'), 'x\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'base');
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoRoot });
  }

  const override = { name: 'quick-task', steps: [{ id: 'push', command: 'git push --force origin HEAD:main' }] };

  it('a chat-written quick-task override is a proposal: not loaded, not runnable, until the owner applies it', async () => {
    const chat = liveChat();
    const saved = await post('/api/v1/p/boot/workflows', { ...override, overwrite: true }, chat.bearer);
    expect(saved.status).toBe(201);
    expect(((await saved.json()) as { path: string }).path).toContain(join('.ai', 'cezar', 'proposals', chat.id));
    const { workflows } = await loadWorkflows(repoRoot);
    expect(workflows.find((w) => w.name === 'quick-task')?.source).toBe('built-in');
    expect(existsSync(join(repoRoot, '.ai/cezar/workflows/quick-task.yaml'))).toBe(false);
    // Its own runs_create gets the live quick-task, and inline steps are no way around it.
    expect((await post('/api/v1/p/boot/runs', { workflow: 'quick-task', task: 'go' }, chat.bearer)).status).toBe(201);
    expect(started.at(-1)?.workflow.steps.some((step) => step.command)).toBe(false);
    expect((await post('/api/v1/p/boot/runs', { steps: override.steps, task: 'go' }, chat.bearer)).status).toBe(400);
    // A file the chat wrote by hand into its proposals is not loaded either.
    mkdirSync(join(repoRoot, '.ai/cezar/proposals', chat.id, 'workflows'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/proposals', chat.id, 'workflows/e2e.yaml'), 'name: e2e\nsteps:\n  - id: a\n    prompt: "{{task}}"\n');
    expect((await loadWorkflows(repoRoot)).workflows.map((w) => w.name)).not.toContain('e2e');
    // The chat never applies or discards its own proposals.
    expect((await post(`/api/v1/p/boot/repo/proposals/${chat.id}/apply`, {}, chat.bearer)).status).toBe(403);
    expect((await post(`/api/v1/p/boot/repo/proposals/${chat.id}/discard`, {}, chat.bearer)).status).toBe(403);
  });

  it('Apply & commit makes a proposal live and commits it; automations.json goes live paused; Discard drops the rest', async () => {
    gitInit();
    const chat = liveChat();
    expect((await post('/api/v1/p/boot/workflows', { name: 'e2e', steps: [{ id: 'a', prompt: '{{task}}' }] }, chat.bearer)).status).toBe(201);
    // A proposal written by hand that switches an automation on.
    mkdirSync(join(repoRoot, '.ai/cezar/proposals', chat.id), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/proposals', chat.id, 'automations.json'), JSON.stringify({ version: 1, automations: [{ id: 'a1', enabled: true, name: 'x' }] }));
    mkdirSync(join(repoRoot, '.ai/cezar/proposals', chat.id, 'skills'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/proposals', chat.id, 'skills/review.md'), '# review\n');

    const listed = (await (await apiRequest(app, `/api/v1/p/boot/repo/proposals/${chat.id}`)).json()) as { proposals: Array<{ path: string; status: string; diff: string }> };
    expect(listed.proposals.map((p) => p.path)).toEqual(['.ai/cezar/automations.json', '.ai/cezar/skills/review.md', '.ai/cezar/workflows/e2e.yaml']);
    expect(listed.proposals.every((p) => p.status === 'added')).toBe(true);
    // The diff shows what Apply would write: the automation paused.
    expect(listed.proposals[0]!.diff).toContain('"enabled": false');
    expect(listed.proposals[0]!.diff).not.toContain('"enabled": true');

    const applied = await post(`/api/v1/p/boot/repo/proposals/${chat.id}/apply`, { paths: ['.ai/cezar/workflows/e2e.yaml', '.ai/cezar/automations.json'] });
    expect(applied.status, await applied.clone().text()).toBe(200);
    const answer = (await applied.json()) as { applied: string[]; sha?: string };
    expect(answer.applied).toEqual(['.ai/cezar/automations.json', '.ai/cezar/workflows/e2e.yaml']);
    expect(answer.sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await loadWorkflows(repoRoot)).workflows.map((w) => w.name)).toContain('e2e');
    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n');
    expect(committed).toEqual(['.ai/cezar/workflows/e2e.yaml']);
    const live = JSON.parse(readFileSync(join(repoRoot, '.ai/cezar/automations.json'), 'utf8')) as { automations: Array<{ enabled: boolean }> };
    expect(live.automations[0]!.enabled).toBe(false);
    // Applied proposals are gone; the rest stay until discarded.
    const left = (await (await apiRequest(app, `/api/v1/p/boot/repo/proposals/${chat.id}`)).json()) as { proposals: Array<{ path: string }> };
    expect(left.proposals.map((p) => p.path)).toEqual(['.ai/cezar/skills/review.md']);
    expect(await (await post(`/api/v1/p/boot/repo/proposals/${chat.id}/discard`, {})).json()).toEqual({ discarded: ['.ai/cezar/skills/review.md'] });
    expect(existsSync(join(repoRoot, '.ai/cezar/proposals', chat.id))).toBe(false);
    expect(existsSync(join(repoRoot, '.ai/cezar/skills/review.md'))).toBe(false);
  });

  it('Discard, like Apply, is a trusted operator\'s: a hosted cockpit without sign-in refuses it', async () => {
    const chat = liveChat();
    mkdirSync(join(repoRoot, '.ai/cezar/proposals', chat.id, 'skills'), { recursive: true });
    const proposal = join(repoRoot, '.ai/cezar/proposals', chat.id, 'skills/review.md');
    writeFileSync(proposal, '# review\n');
    const saved = { remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };
    process.env.CEZ_REMOTE = '1';
    process.env.CEZ_AUTH = '0';
    try {
      expect((await post(`/api/v1/p/boot/repo/proposals/${chat.id}/discard`, {})).status).toBe(409);
      expect(existsSync(proposal)).toBe(true);
    } finally {
      for (const [key, value] of [['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect((await post(`/api/v1/p/boot/repo/proposals/${chat.id}/discard`, {})).status).toBe(200);
    expect(existsSync(proposal)).toBe(false);
  });

  it('applying automations.json merges by id under the store\'s mutation lock: the owner\'s rows since survive', async () => {
    gitInit();
    const chat = liveChat();
    const live = join(repoRoot, '.ai/cezar/automations.json');
    const write = (path: string, automations: unknown[], extra: Record<string, unknown> = {}) =>
      writeFileSync(path, JSON.stringify({ version: 1, automations, ...extra }));
    write(live, [{ id: 'a', name: 'A', revision: 1, enabled: false }, { id: 'd', name: 'D', revision: 1, enabled: false }]);
    // The proposal: the live file as the chat saw it, plus its own new row and an edit of D.
    mkdirSync(join(repoRoot, '.ai/cezar/proposals', chat.id), { recursive: true });
    write(join(repoRoot, '.ai/cezar/proposals', chat.id, 'automations.json'), [
      { id: 'a', name: 'A', revision: 1, enabled: false },
      { id: 'd', name: 'D', revision: 1, enabled: false },
      { id: 'c', name: 'C from the chat', revision: 1, enabled: true },
    ]);
    // Since then the owner added B, edited A and deleted D.
    write(live, [{ id: 'a', name: 'A edited', revision: 2, enabled: false }, { id: 'b', name: 'B', revision: 1, enabled: true }], {
      tombstones: { d: new Date().toISOString() },
    });

    // A launch holding the lock: Apply waits for it rather than writing past it.
    const other = AutomationStore.open(join(repoRoot, '.ai/cezar'));
    const lease = other.acquireMutationLease()!;
    const apply = () => post(`/api/v1/p/boot/repo/proposals/${chat.id}/apply`, { paths: ['.ai/cezar/automations.json'] });
    try {
      expect((await apply()).status).toBe(409);
    } finally {
      lease.release();
    }
    const applied = await apply();
    expect(applied.status, await applied.clone().text()).toBe(200);
    const after = JSON.parse(readFileSync(live, 'utf8')) as { automations: Array<{ id: string; name: string; enabled: boolean }>; tombstones?: Record<string, string> };
    expect(after.automations.map((row) => [row.id, row.name, row.enabled])).toEqual([
      ['a', 'A edited', false], ['b', 'B', true], ['c', 'C from the chat', false],
    ]);
    expect(after.tombstones?.d).toBeDefined();
  });

  it('Apply refuses while other files are staged, so the commit carries nothing of the owner\'s', async () => {
    gitInit();
    const chat = liveChat();
    expect((await post('/api/v1/p/boot/workflows', { name: 'e2e', steps: [{ id: 'a', prompt: '{{task}}' }] }, chat.bearer)).status).toBe(201);
    writeFileSync(join(repoRoot, 'README.md'), 'mine\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    const refused = await post(`/api/v1/p/boot/repo/proposals/${chat.id}/apply`, {});
    expect(refused.status).toBe(409);
    expect(existsSync(join(repoRoot, '.ai/cezar/workflows/e2e.yaml'))).toBe(false);
  });

  it('a chat reads a run\'s files only where the repository index reaches: no ignored config, .env or seed', async () => {
    gitInit();
    writeFileSync(join(repoRoot, '.gitignore'), '.env\n');
    writeFileSync(join(repoRoot, '.env'), 'OWNER_TOKEN=s3cret\n');
    writeFileSync(join(repoRoot, '.ai/cezar/mcp.local.json'), '{"mcpServers":{"x":{"env":{"TOKEN":"s3cret"}}}}');
    writeFileSync(join(repoRoot, '.ai/cezar/config.local.json'), '{"secret":"s3cret"}');
    const chat = liveChat();
    const read = (path: string, headers = chat.bearer) =>
      apiRequest(app, `/api/v1/p/boot/runs/${chat.id}/files?path=${encodeURIComponent(path)}`, { headers });
    for (const path of ['.env', '.ai/cezar/mcp.local.json', '.ai/cezar/config.local.json']) {
      const res = await read(path);
      expect(res.status, path).toBe(409);
      expect(await res.text(), path).not.toContain('s3cret');
    }
    expect((await read('README.md')).status).toBe(200);
    const root = (await (await read('')).json()) as { entries: Array<{ name: string }> };
    expect(root.entries.map((entry) => entry.name)).not.toContain('.env');
    // The owner still browses the whole worktree.
    expect((await read('.env', {})).status).toBe(200);
  });

  it('the chat token is refused the tracker link, transitions, the webhook, inbox deletes and services', async () => {
    const chat = liveChat();
    const call = (method: string, path: string, body?: unknown) =>
      apiRequest(app, `/api/v1/p/boot${path}`, { method, headers: { ...json, ...chat.bearer }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const [method, path] of [
      ['PUT', '/tracker/association'], ['DELETE', '/tracker/association'], ['POST', '/tracker/T-1/transition'],
      ['POST', '/automation-webhook'], ['DELETE', '/automation-webhook'], ['DELETE', '/todos/t1'],
      ['GET', '/todos'], ['GET', '/services'], ['GET', '/services/web/logs'], ['DELETE', '/workflows/quick-task'],
    ] as const) {
      expect((await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : {})).status, `${method} ${path}`).toBe(403);
    }
  });

  it('reads the transcript of its own tasks only, and sees the owner\'s tasks projected', async () => {
    const chat = liveChat();
    const owner = store.createRun({ title: 'owner', workflow: 'quick-task', task: 'the owner\'s secret plan', steps: [] });
    const mine = store.createRun({ title: 'mine', workflow: 'quick-task', task: 'the chat\'s task', steps: [], createdBy: `chat:${chat.id}` });
    const get = (path: string) => apiRequest(app, `/api/v1/p/boot${path}`, { headers: chat.bearer });
    for (const route of ['history', 'handoff', 'history-context']) {
      expect((await get(`/runs/${owner.id}/${route}`)).status, route).toBe(403);
    }
    expect((await get(`/runs/${mine.id}/history`)).status).not.toBe(403);
    expect(((await (await get(`/runs/${owner.id}`)).json()) as { projected?: boolean }).projected).toBe(true);
    expect(((await (await get(`/runs/${mine.id}`)).json()) as { projected?: boolean }).projected).toBeUndefined();
  });

  it('a chat starts one task at a time per call, at most two in flight and five an hour', async () => {
    const chat = liveChat();
    const start = (body: Record<string, unknown> = {}) => post('/api/v1/p/boot/runs', { workflow: 'quick-task', task: 't', ...body }, chat.bearer);
    expect((await start({ variants: 3 })).status).toBe(201);
    expect(started).toHaveLength(1);
    expect((await start()).status).toBe(201);
    // Two queued: a third is refused.
    expect((await start()).status).toBe(409);
    for (const run of store.listRuns()) if (run.createdBy) store.updateRun(run.id, { status: 'review' });
    expect((await start()).status).toBe(201);
    for (const run of store.listRuns()) if (run.createdBy) store.updateRun(run.id, { status: 'review' });
    expect((await start()).status).toBe(201);
    for (const run of store.listRuns()) if (run.createdBy) store.updateRun(run.id, { status: 'review' });
    expect((await start()).status).toBe(201);
    for (const run of store.listRuns()) if (run.createdBy) store.updateRun(run.id, { status: 'review' });
    // Five in the last hour: the sixth waits.
    const refused = await start();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/in the last hour/);
    // The owner is not braked.
    expect((await post('/api/v1/runs', { workflow: 'quick-task', task: 'mine' })).status).toBe(201);
  });

  it('parallel runs_create calls cannot overrun the in-flight cap: the slot is taken before any await', async () => {
    const chat = liveChat();
    const start = () => post('/api/v1/p/boot/runs', { workflow: 'quick-task', task: 't' }, chat.bearer);
    const statuses = (await Promise.all([start(), start(), start(), start()])).map((res) => res.status).sort();
    expect(statuses).toEqual([201, 201, 409, 409]);
    expect(store.listRuns().filter((run) => run.createdBy === `chat:${chat.id}`)).toHaveLength(2);
    // A refused or failed start gives its slot back.
    for (const run of store.listRuns()) if (run.createdBy) store.updateRun(run.id, { status: 'review' });
    expect((await post('/api/v1/p/boot/runs', { workflow: 'no-such-workflow', task: 't' }, chat.bearer)).status).toBe(404);
    const again = (await Promise.all([start(), start()])).map((res) => res.status);
    expect(again).toEqual([201, 201]);
  });

  it('a chat cannot dispatch: a task tree under its task would bypass every brake', async () => {
    const chat = liveChat();
    const mine = store.createRun({ title: 'mine', workflow: 'quick-task', task: 't', steps: [], createdBy: `chat:${chat.id}` });
    const res = await post(`/api/v1/p/boot/runs/${mine.id}/dispatch`, { task: 'child' }, chat.bearer);
    expect(res.status).toBe(403);
  });
});
