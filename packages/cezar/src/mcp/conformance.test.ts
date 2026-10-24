import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { createApp } from '../server/server.ts';
import { runMcpBridge } from './stdio.ts';

/**
 * An MCP conformance run with the SDK's own client against a dry-run cockpit (spec
 * 2026-10-24-cezar-mcp-server §8): list tools, call runs_create, read the thread resource — over
 * Streamable HTTP in both protocol eras, and over the stdio bridge. The client validates every
 * structured result against the tool's advertised output schema, so a drifted schema fails here.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

describe('cezar as an MCP server', () => {
  const saved = { home: process.env.CEZ_HOME, dry: process.env.CEZ_DRY_RUN };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;
  const clients: Client[] = [];

  /** The SDK's fetch, answered in-process by the app — the same bytes a socket would carry. */
  const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set('host', '127.0.0.1:4321');
    return app.request(request.url, { method: request.method, headers, body: request.body, duplex: 'half' } as RequestInit);
  }) as typeof fetch;

  async function connect(query = '', mode: 'legacy' | 'auto' = 'legacy'): Promise<Client> {
    const client = new Client({ name: 'conformance', version: '1.0.0' }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:4321/api/v1/mcp${query}`), { fetch: appFetch });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mcp-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-mcp-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    git(repoRoot, 'init', '-q', '-b', 'main');
    git(repoRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot);
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', bootProjectId: 'boot' }) as unknown as Hono;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
    for (const run of store.listRuns()) manager.cancel(run.id);
    store.flush();
    await removeTempDir(home, repoRoot);
    if (saved.home === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = saved.home;
    if (saved.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved.dry;
  });

  async function settle(client: Client, id: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const got = await client.callTool({ name: 'runs_get', arguments: { id } });
      const status = (got.structuredContent as { status?: string } | undefined)?.status ?? '';
      if (!['queued', 'running', 'starting'].includes(status)) return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the dry run never settled');
  }

  it('lists the default tool sets, starts a task and reads its thread (2025 handshake)', async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe('cezar');
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('runs_create');
    expect(names).toContain('workflows_put');
    expect(names).not.toContain('repo_push'); // not in the default sets
    expect(tools.find((tool) => tool.name === 'runs_get')?.annotations?.readOnlyHint).toBe(true);

    const created = await client.callTool({ name: 'runs_create', arguments: { task: 'Say hello', workflow: 'quick-task' } });
    expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
    const id = (created.structuredContent as { id: string }).id;
    expect(id).toMatch(/\S/);
    await settle(client, id);

    const thread = await client.readResource({ uri: `cezar://p/default/runs/${id}/thread` });
    const text = (thread.contents[0] as { text: string }).text;
    expect(thread.contents[0]?.mimeType).toBe('text/markdown');
    expect(text).toMatch(/^# /);
    expect(text).toContain('Status:');

    const projects = await client.readResource({ uri: 'cezar://projects' });
    expect(JSON.parse((projects.contents[0] as { text: string }).text)).toHaveProperty('projects');
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.name)).toEqual(['task-thread', 'workflow']);
  }, 60_000);

  it('serves the 2026-07-28 era too, and the prompts', async () => {
    const client = await connect('', 'auto');
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['new-task', 'write-workflow']);
    const prompt = await client.getPrompt({ name: 'new-task', arguments: { objective: 'fix the login bug' } });
    expect(JSON.stringify(prompt.messages)).toContain('fix the login bug');
    const workflow = await client.readResource({ uri: 'cezar://p/default/workflows/quick-task' });
    expect((workflow.contents[0] as { text: string }).text).toContain('name: quick-task');
  }, 60_000);

  it('?tools= picks the sets; all is the whole API; an unknown set is refused', async () => {
    const all = await connect('?tools=all');
    expect((await all.listTools()).tools.length).toBeGreaterThan(200);
    const repo = await connect('?tools=repo');
    expect((await repo.listTools()).tools.every((tool) => tool.name.startsWith('repo_') || tool.name.startsWith('worktree'))).toBe(true);
    const refused = await appFetch('http://127.0.0.1:4321/api/v1/mcp?tools=nope', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('unknown tool set: nope');
  }, 60_000);

  it('a route error is a tool error, not a protocol failure', async () => {
    const client = await connect();
    const missing = await client.callTool({ name: 'runs_get', arguments: { id: 'no-such-run' } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain('404');
  }, 60_000);

  it('`cezar mcp` bridges stdio to the same endpoint', async () => {
    const toBridge = new PassThrough();
    const fromBridge = new PassThrough();
    const bridged = runMcpBridge(
      { endpoint: 'http://127.0.0.1:4321/api/v1/mcp?tools=tasks' },
      { stdin: toBridge, stdout: fromBridge, fetch: appFetch, error: () => {} },
    );
    // The client end of the pipe: the SDK's own stdio framing, pointed the other way.
    const client = new Client({ name: 'stdio-conformance', version: '1.0.0' });
    await client.connect(new StdioServerTransport(fromBridge, toBridge));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('runs_send_message');
    expect(tools.every((tool) => !tool.name.startsWith('workflows_'))).toBe(true);
    const listed = await client.callTool({ name: 'runs_list', arguments: {} });
    expect(listed.isError).toBeFalsy();
    await client.close();
    toBridge.end();
    await bridged;
  }, 60_000);

  it('the bridge answers a request with a clear error when no cockpit is there', async () => {
    const toBridge = new PassThrough();
    const fromBridge = new PassThrough();
    void runMcpBridge(
      { endpoint: 'http://127.0.0.1:9/api/v1/mcp' },
      { stdin: toBridge, stdout: fromBridge, fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch, error: () => {} },
    );
    const client = new Client({ name: 'offline', version: '1.0.0' });
    await expect(client.connect(new StdioServerTransport(fromBridge, toBridge))).rejects.toThrow(/no cezar cockpit answered/);
    toBridge.end();
  });
});
