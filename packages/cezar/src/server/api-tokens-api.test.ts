import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiTokensResponseSchema,
  authSetupBeginResponseSchema,
  createApiTokenResponseSchema,
  type ApiTokenScope,
} from '@open-mercato/cezar-contract';
import { FAMILY_SCOPES, routeFamily } from '../auth/api-tokens.ts';
import { AuthService } from '../auth/service.ts';
import { issueSetupCode } from '../auth/store.ts';
import { base32Decode, hotp, totpStep } from '../auth/totp.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';

/**
 * Owner API tokens through the real routes and guards (spec 2026-10-24-cezar-mcp-server §4, §8):
 * minted by the signed-in owner, scoped per route family, never for `/auth/*`, and — only when it
 * verifies — exempt from the #426 origin guard, which is all a Bearer request is exempt from.
 */

const HOST = 'agents.example.dev';
const HOSTED = { host: HOST, 'x-forwarded-proto': 'https' };

describe('API tokens', () => {
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let secret: string;
  let cookie: string;
  let clock = Date.now();
  const saved = { home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };

  const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.request(path, { ...init, headers: { ...HOSTED, ...init.headers } });
  const json = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  /** A code from a time step nothing has spent yet (each confirmation consumes one): the clock moves on. */
  const freshCode = () => hotp(base32Decode(secret)!, totpStep((clock += 30_000)));

  async function mint(scopes: ApiTokenScope[], name = 'desktop') {
    const response = await json('POST', '/api/v1/auth/tokens', { name, scopes, code: freshCode() }, { cookie });
    expect(response.status, await response.clone().text()).toBe(201);
    return createApiTokenResponseSchema.strict().parse(await response.json());
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-tokens-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-tokens-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_REMOTE = '1';
    delete process.env.CEZ_AUTH;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      bootProjectId: 'boot',
      // The service's clock is the test's, so every code comes from a step nothing has used.
      auth: new AuthService({ scrypt: { N: 2 ** 10, r: 8, p: 1 }, now: () => clock }),
    }) as unknown as Hono;
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('setup refused');
    const begin = await json('POST', '/api/v1/auth/setup/begin', { code: issued.setup.code, username: 'mateusz', password: 'a long enough password' });
    const begun = authSetupBeginResponseSchema.parse(await begin.json());
    secret = begun.secret;

    const complete = await json('POST', '/api/v1/auth/setup/complete', { ticket: begun.ticket, code: freshCode() });
    expect(complete.status).toBe(200);
    cookie = complete.headers.get('set-cookie')!.split(';')[0]!;
  });

  afterEach(async () => {
    store.flush();
    await removeTempDir(home, repoRoot);
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('the signed-in owner mints, lists and revokes; the value is shown once', async () => {
    const created = await mint(['tasks']);
    expect(created.value.startsWith(`ceztok_${created.token.id}_`)).toBe(true);
    const listed = apiTokensResponseSchema.strict().parse(await (await request('/api/v1/auth/tokens', { headers: { cookie } })).json());
    expect(listed.tokens.map((token) => token.id)).toEqual([created.token.id]);
    expect(JSON.stringify(listed)).not.toContain(created.value);
    expect((await request('/api/v1/runs', { headers: bearer(created.value) })).status).toBe(200);
    const revoked = await request(`/api/v1/auth/tokens/${created.token.id}`, { method: 'DELETE', headers: { cookie } });
    expect(revoked.status).toBe(200);
    expect((await request('/api/v1/runs', { headers: bearer(created.value) })).status).toBe(401);
  });

  it('minting needs a fresh authenticator code', async () => {
    const response = await json('POST', '/api/v1/auth/tokens', { name: 'x', scopes: ['read'], code: '000000' }, { cookie });
    expect(response.status).toBe(401);
  });

  it('a token never reaches /auth/*, not even to mint or revoke another token', async () => {
    const created = await mint(['admin']);
    expect((await request('/api/v1/auth/tokens', { headers: bearer(created.value) })).status).toBe(403);
    expect((await json('POST', '/api/v1/auth/tokens', { name: 'y', scopes: ['admin'], code: freshCode() }, bearer(created.value))).status).toBe(403);
    expect((await request(`/api/v1/auth/tokens/${created.token.id}`, { method: 'DELETE', headers: bearer(created.value) })).status).toBe(403);
    expect((await request('/api/v1/auth/session', { headers: bearer(created.value) })).status).toBe(403);
  });

  it('enforces the scope per route family, server-side', async () => {
    const tasks = await mint(['tasks']);
    const read = await mint(['read'], 'reader');
    const forbidden = await json('POST', '/api/v1/workflows', { name: 'x', yaml: 'steps: []' }, bearer(tasks.value));
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: string }).error).toMatch(/scopes \(tasks\)/);
    expect((await request('/api/v1/workflows', { headers: bearer(read.value) })).status).toBe(200);
    expect((await request('/api/v1/runs/read-all', { method: 'POST', headers: bearer(read.value) })).status).toBe(403);
    expect((await request('/api/v1/runs/read-all', { method: 'POST', headers: bearer(tasks.value) })).status).toBe(200);
  });

  it('a token reads a task\'s files through the repository index — an ignored secret stays unreadable', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@cezar.local');
    git('config', 'user.name', 'cezar-test');
    writeFileSync(join(repoRoot, '.gitignore'), '.env\n.claude/settings.local.json\n.ai/\n');
    mkdirSync(join(repoRoot, 'src'));
    writeFileSync(join(repoRoot, 'src/a.ts'), 'export const a = 1\n');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
    writeFileSync(join(repoRoot, '.env'), 'TOKEN=shh\n');
    mkdirSync(join(repoRoot, '.claude'));
    writeFileSync(join(repoRoot, '.claude/settings.local.json'), '{"env":{"KEY":"shh"}}\n');
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', worktree: false, steps: [] });
    const read = await mint(['read']);
    const tasks = await mint(['tasks'], 'tasks');
    const files = (path: string, headers: Record<string, string>) =>
      request(`/api/v1/runs/${run.id}/files?path=${encodeURIComponent(path)}`, { headers });

    for (const token of [read.value, tasks.value]) {
      for (const path of ['.env', './.env', 'src/../.env', '.claude/settings.local.json']) {
        const refused = await files(path, bearer(token));
        expect(refused.status, path).toBe(409);
        expect(await refused.text()).not.toContain('shh');
      }
      const ok = await files('src/a.ts', bearer(token));
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { content?: string }).content).toContain('export const a');
      const listing = (await (await files('', bearer(token))).json()) as { entries: Array<{ name: string }> };
      const names = listing.entries.map((entry) => entry.name);
      expect(names).toContain('src');
      expect(names).not.toContain('.env');
      expect(names).not.toContain('.claude');
    }
    // The signed-in owner's own cockpit is unchanged.
    expect((await files('.env', { cookie })).status).toBe(200);
  });

  it('an unknown or malformed token is a 401, never a pass', async () => {
    expect((await request('/api/v1/runs', { headers: bearer('ceztok_0123456789ab_aaaaaaaaaaaaaaaaaaaaaaaaaaaa') })).status).toBe(401);
    expect((await request('/api/v1/runs', { headers: bearer('ceztok_garbage') })).status).toBe(401);
  });

  it('a VALID token skips the origin guard — and nothing else does', async () => {
    const created = await mint(['tasks']);
    const evil = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    // A browser session from a foreign page is still refused…
    expect((await request('/api/v1/runs/read-all', { method: 'POST', headers: { cookie, ...evil } })).status).toBe(403);
    // …a token that does not verify gets no pass either…
    const forged = await request('/api/v1/runs/read-all', { method: 'POST', headers: { ...bearer('ceztok_0123456789ab_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'), ...evil } });
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { error: string }).error).toMatch(/cross-(origin|site)/);
    // …and a real one is not a browser.
    expect((await request('/api/v1/runs/read-all', { method: 'POST', headers: { ...bearer(created.value), ...evil } })).status).toBe(200);
  });

  it('on a local cockpit a token still means its scopes, and only a valid one passes a foreign Host', async () => {
    const created = await mint(['read']);
    delete process.env.CEZ_REMOTE;
    const foreign = { host: 'rebound.example' };
    expect((await app.request('/api/v1/runs', { headers: foreign })).status).toBe(403);
    expect((await app.request('/api/v1/runs', { headers: { ...foreign, ...bearer('ceztok_0123456789ab_aaaaaaaaaaaaaaaaaaaaaaaaaaaa') } })).status).toBe(403);
    expect((await app.request('/api/v1/runs', { headers: { ...foreign, ...bearer(created.value) } })).status).toBe(200);
    expect((await app.request('/api/v1/runs/read-all', { method: 'POST', headers: { host: '127.0.0.1:4321', ...bearer(created.value) } })).status).toBe(403);
  });

  it('over MCP, a scope is enforced on the route each tool calls — not by the tools the client saw', async () => {
    const read = await mint(['read']);
    const fetchApp = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(HOSTED)) headers.set(name, value);
      return app.request(request.url, { method: request.method, headers, body: request.body, duplex: 'half' } as RequestInit);
    }) as typeof fetch;
    expect((await fetchApp(`https://${HOST}/api/v1/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    const client = new Client({ name: 'scoped', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`https://${HOST}/api/v1/mcp?tools=all`), {
      fetch: fetchApp,
      requestInit: { headers: bearer(read.value) },
    }));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('runs_read_all'); // shown…
      const refused = await client.callTool({ name: 'runs_read_all', arguments: {} });
      expect(refused.isError).toBe(true); // …and still refused by the guard
      expect(JSON.stringify(refused.content)).toContain('403');
      expect((await client.callTool({ name: 'runs_list', arguments: {} })).isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('every route family the app serves has a scope owner — a new family is a decision', () => {
    const families = new Set(
      (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
        .filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/v1/'))
        .map((route) => routeFamily(route.path.replace(':projectId', 'x'))!)
        .filter((family) => family !== 'auth'),
    );
    expect(families.size).toBeGreaterThan(30);
    expect([...families].filter((family) => !(family in FAMILY_SCOPES)).sort()).toEqual([]);
  });
});
