import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableRunTokens, mintChatRunToken } from '../auth/run-tokens.ts';
import { CHAT_WORKFLOW } from '../chat/chat.ts';
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

  /** A chat record that is running, and its MCP token. */
  function liveChat(): { id: string; bearer: Record<string, string> } {
    const chat = store.createRun({ title: 'chat', workflow: 'chat', task: 'hi', kind: 'chat', worktree: false, steps: [] });
    active.add(chat.id);
    return { id: chat.id, bearer: { authorization: `Bearer ${mintChatRunToken(chat.id, 'boot')}` } };
  }

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

  it('GET /runs?kind= lists only chats or only tasks; without it, every run as before', async () => {
    store.createRun({ title: 'task', workflow: 'quick-task', task: 'a', steps: [] });
    store.createRun({ title: 'chat', workflow: 'chat', task: 'b', kind: 'chat', worktree: false, steps: [] });
    const titles = async (query: string) =>
      ((await (await apiRequest(app, `/api/v1/runs${query}`)).json()) as Array<{ title: string }>).map((run) => run.title).sort();
    expect(await titles('?kind=chat')).toEqual(['chat']);
    expect(await titles('?kind=task')).toEqual(['task']);
    expect(await titles('')).toEqual(['chat', 'task']);
    expect((await apiRequest(app, '/api/v1/runs?kind=bogus')).status).toBe(400);
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
    for (const path of ['/todos/t1/start', '/automations/a1/run', '/automations/a1/enable', '/automations/a1/check', '/automation-log/r1/retry']) {
      expect((await post(`/api/v1/p/boot${path}`, {}, chat.bearer)).status, path).toBe(403);
    }
  });

  it('the chat edits a paused automation, never switches one on or edits a live one', async () => {
    const chat = liveChat();
    const put = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      apiRequest(app, `/api/v1/p/boot/automations/${id}`, { method: 'PUT', headers: { ...json, ...headers }, body: JSON.stringify(body) });
    const input = { name: 'Review issues', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}' } };
    const created = await post('/api/v1/p/boot/automations', input, chat.bearer);
    expect(created.status).toBe(201);
    const { id, revision } = ((await created.json()) as { automation: { id: string; revision: number } }).automation;
    expect((await put(id, { ...input, enabled: true, expectedRevision: revision }, chat.bearer)).status).toBe(403);
    expect((await put(id, { ...input, name: 'Renamed', expectedRevision: revision }, chat.bearer)).status).toBe(200);
    // The owner switches it on; from then on the chat may only pause it.
    expect((await put(id, { ...input, enabled: true, expectedRevision: revision + 1 })).status).toBe(200);
    expect((await put(id, { ...input, name: 'Again', expectedRevision: revision + 2 }, chat.bearer)).status).toBe(403);
    expect((await put(id, { ...input, enabled: false, expectedRevision: revision + 2 }, chat.bearer)).status).toBe(200);
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
});
