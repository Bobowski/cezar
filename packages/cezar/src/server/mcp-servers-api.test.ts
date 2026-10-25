import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpRegistryResponseSchema, mcpServersListSchema, mcpServerTestResponseSchema } from '@open-mercato/cezar-contract';
import { privateMcpPath, projectMcpPath } from '../core/private-mcp.ts';
import { McpRegistrySearch } from '../mcp-catalog/registry.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/** A stdio server whose one tool says whether the secret reached its env. */
const SERVER = `
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: {} });
  if (msg.method === 'tools/list') reply({ tools: [{ name: process.env.TOKEN === 'resolved-secret-value' ? 'token-resolved' : 'token-missing' }] });
});
`;

describe('MCP servers API (spec 2026-10-24-easy-mcp §4)', () => {
  let root: string;
  let store: RunStore;
  let secrets: SecretStore;
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-mcp-servers-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), 'home/\n');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    writeFileSync(join(root, 'server.cjs'), SERVER);
    store = RunStore.open(join(root, '.ai/cezar'));
    secrets = new SecretStore(process.env, { keychain: async () => null });
    fetch = vi.fn(async () => new Response(JSON.stringify({ servers: [{ server: { name: 'io.github.x/found', packages: [{ registryType: 'npm', identifier: 'found-mcp' }] } }] })));
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = async () => {
    const project = await registerProject(root);
    const mcpRegistry = new McpRegistrySearch({ fetch: fetch as unknown as typeof globalThis.fetch, env: {} });
    return { id: project.id, instance: createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id, secrets, mcpRegistry }) };
  };
  const put = (definition: unknown): RequestInit => ({
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definition }),
  });

  it('adds to either file under both mounts, lists, tests with a resolved secret, and removes', async () => {
    const { id, instance } = await app();
    const empty = mcpServersListSchema.parse(await (await apiRequest(instance, '/api/v1/mcp-servers')).json());
    expect(empty).toMatchObject({ project: [], private: [], editable: true });
    expect(empty.catalog.map((entry) => entry.id)).toContain('context7');

    const definition = { command: process.execPath, args: [join(root, 'server.cjs')], env: { TOKEN: '${{ secrets.MY_TOKEN }}' } };
    const added = await apiRequest(instance, `/api/v1/p/${id}/mcp-servers/project/probe`, put(definition));
    expect(added.status).toBe(200);
    expect(mcpServersListSchema.parse(await added.json()).project[0]).toMatchObject({ name: 'probe', missingSecrets: ['MY_TOKEN'] });
    expect(JSON.parse(readFileSync(projectMcpPath(root), 'utf8')).mcpServers.probe.env.TOKEN).toBe('${{ secrets.MY_TOKEN }}');

    // Without the secret, Test names it instead of starting a half-configured server.
    const missing = mcpServerTestResponseSchema.parse(await (await apiRequest(instance, '/api/v1/mcp-servers/project/probe/test', { method: 'POST' })).json());
    expect(missing).toEqual({ ok: false, reason: 'secret MY_TOKEN is not stored for this project or workspace' });

    await secrets.set({ kind: 'project', projectId: id, root }, 'MY_TOKEN', 'resolved-secret-value', ['cezar']);
    const tested = mcpServerTestResponseSchema.parse(await (await apiRequest(instance, `/api/v1/p/${id}/mcp-servers/project/probe/test`, { method: 'POST' })).json());
    expect(tested).toEqual({ ok: true, tools: ['token-resolved'] });

    expect((await apiRequest(instance, '/api/v1/mcp-servers/private/mine', put({ type: 'http', url: 'https://mcp.example.com/mcp' }))).status).toBe(200);
    expect(JSON.parse(readFileSync(privateMcpPath(root), 'utf8')).mcpServers.mine.url).toBe('https://mcp.example.com/mcp');

    expect((await apiRequest(instance, '/api/v1/mcp-servers/project/probe', { method: 'DELETE' })).status).toBe(200);
    expect((await apiRequest(instance, '/api/v1/mcp-servers/project/probe', { method: 'DELETE' })).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/mcp-servers/project/probe/test', { method: 'POST' })).status).toBe(404);
  });

  it('validates the scope, the name and the definition as middleware', async () => {
    const { instance } = await app();
    expect((await apiRequest(instance, '/api/v1/mcp-servers/team/x', put({ command: 'x' }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/mcp-servers/project/bad%20name', put({ command: 'x' }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/mcp-servers/project/x', put({ command: 'x', env: { K: '${{ env.HOME }}' } }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/mcp-servers/project/x', put({ type: 'http' }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/mcp-servers/registry')).status).toBe(400);
  });

  it('proxies the registry, marked unreviewed and cached', async () => {
    const { id, instance } = await app();
    const first = mcpRegistryResponseSchema.parse(await (await apiRequest(instance, '/api/v1/mcp-servers/registry?q=found')).json());
    expect(first.items[0]).toMatchObject({ id: 'io.github.x/found', unreviewed: true, definition: { command: 'npx', args: ['-y', 'found-mcp'] } });
    await apiRequest(instance, `/api/v1/p/${id}/mcp-servers/registry?q=found`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses writes and Test on a hosted cockpit without sign-in, and still lists', async () => {
    vi.stubEnv('CEZ_REMOTE', '1');
    vi.stubEnv('CEZ_AUTH', '0');
    writeFileSync(projectMcpPath(root), JSON.stringify({ mcpServers: { probe: { command: 'x' } } }));
    const { instance } = await app();
    expect(mcpServersListSchema.parse(await (await apiRequest(instance, '/api/v1/mcp-servers')).json())).toMatchObject({ editable: false, project: [{ name: 'probe' }] });
    expect((await apiRequest(instance, '/api/v1/mcp-servers/project/other', put({ command: 'x' }))).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/mcp-servers/project/probe', { method: 'DELETE' })).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/mcp-servers/project/probe/test', { method: 'POST' })).status).toBe(409);
    expect(JSON.parse(readFileSync(projectMcpPath(root), 'utf8')).mcpServers).toEqual({ probe: { command: 'x' } });
  });
});
