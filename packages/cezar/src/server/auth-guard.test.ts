import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  authDevicesResponseSchema,
  authLoginResponseSchema,
  authSessionResponseSchema,
  authSetupBeginResponseSchema,
  authSetupCompleteResponseSchema,
  authVerifyResponseSchema,
} from '@open-mercato/cezar-contract';
import { isPublicAuthPath, upgradeIsAuthenticated } from '../auth/guard.ts';
import { ensureHostKey, readHostKey } from '../auth/host-key.ts';
import { disableRunTokens, enableRunTokens, mintRunToken, runTokenAllows, verifyRunToken } from '../auth/run-tokens.ts';
import { AuthService } from '../auth/service.ts';
import { issueSetupCode } from '../auth/store.ts';
import { base32Decode, hotp, totpStep } from '../auth/totp.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { authEnforced } from './capabilities.ts';
import { createApp, startServer } from './server.ts';

/**
 * Spec `2026-10-12-cockpit-authentication.md` §6: under enforced auth every `/api` route is a
 * principal or a 401. The route table is read off a BUILT app, so a route added tomorrow is
 * covered without anyone remembering this file.
 */

const HOST = 'agents.example.dev';
const HOSTED = { host: HOST, 'x-forwarded-proto': 'https' };
const PASSWORD = 'a long enough password';

describe('cockpit authentication', () => {
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let active: Set<string>;
  const saved = { home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };

  const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.request(path, { ...init, headers: { ...HOSTED, ...init.headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  const cookieOf = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]!;

  /** Setup through the real routes; answers the session cookie and the seed. */
  async function createOwner() {
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('setup code refused');
    const begin = await post('/api/v1/auth/setup/begin', { code: issued.setup.code, username: 'mateusz', password: PASSWORD });
    expect(begin.status).toBe(200);
    const begun = authSetupBeginResponseSchema.strict().parse(await begin.json());
    const code = hotp(base32Decode(begun.secret)!, totpStep(Date.now()));
    const complete = await post('/api/v1/auth/setup/complete', { ticket: begun.ticket, code });
    expect(complete.status).toBe(200);
    authSetupCompleteResponseSchema.strict().parse(await complete.json());
    return { cookie: cookieOf(complete), secret: begun.secret };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-authguard-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-authguard-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_REMOTE = '1';
    delete process.env.CEZ_AUTH; // the real default: hosted ⇒ enforced
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    active = new Set();
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: (id: string) => active.has(id) } as unknown as RunManager,
      version: '0.0.0-test',
      bootProjectId: 'boot',
      auth: new AuthService({ scrypt: { N: 2 ** 10, r: 8, p: 1 } }),
    }) as unknown as Hono;
  });

  afterEach(async () => {
    disableRunTokens();
    store.flush();
    await removeTempDir(home, repoRoot);
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is on for a hosted cockpit, off locally, and CEZ_AUTH overrides both ways', () => {
    expect(authEnforced({})).toBe(false);
    expect(authEnforced({ CEZ_REMOTE: '1' })).toBe(true);
    expect(authEnforced({}, '0.0.0.0')).toBe(true);
    expect(authEnforced({ CEZ_REMOTE: '1', CEZ_AUTH: '0' })).toBe(false);
    expect(authEnforced({ CEZ_AUTH: '1' })).toBe(true);
    expect(authEnforced({ CEZ_AUTH: 'yes' })).toBe(false); // strict, like every other flag
  });

  it('answers 401 on EVERY registered /api route without a session — and only the auth entry points are public', async () => {
    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
      .filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/'));
    expect(routes.length).toBeGreaterThan(150); // the walk is not vacuous
    // A validated route is registered once per middleware, so the table repeats itself.
    const open = new Set<string>();
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z0-9_]+/g, 'x');
      const response = await request(path, { method: route.method });
      if (response.status !== 401) open.add(`${route.method} ${route.path}`);
      else expect(await response.json()).toEqual({ error: 'authentication required' });
    }
    expect([...open].sort()).toEqual([
      'GET /api/v1/auth/session',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/login/verify',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/setup/begin',
      'POST /api/v1/auth/setup/complete',
    ]);
    for (const entry of open) expect(isPublicAuthPath(entry.split(' ')[1]!)).toBe(true);
  }, 30_000);

  it('serves nothing outside /api but the static shell — a route added there is a route with no guard', () => {
    const outside = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
      .filter((route) => !route.path.startsWith('/api/'))
      .map((route) => `${route.method} ${route.path}`);
    // Build output only (`static-ui.ts`). Anything that serves DATA belongs under /api, where the
    // guard is; adding a line here means deciding how that route authenticates.
    expect([...new Set(outside)].sort()).toEqual([
      'ALL /*', // bodyLimit
      'GET /*', // the SPA shell
      'GET /assets/:file',
      'GET /icon.svg',
      'GET /open-mercato.svg',
    ]);
  });

  it('answers NO /api route with 401 or 403 for a signed-in owner — the other half of §6', async () => {
    const { cookie } = await createOwner();
    const routes = new Map<string, { method: string; path: string }>();
    for (const route of (app as unknown as { routes: Array<{ method: string; path: string }> }).routes) {
      if (route.method !== 'ALL' && route.path.startsWith('/api/')) routes.set(`${route.method} ${route.path}`, route);
    }
    expect(routes.size).toBeGreaterThan(150);
    // Handlers really run here, so keep them on this machine: no fetch, and no CLI to shell out to.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('no network in the unit gate');
    });
    const path = process.env.PATH;
    process.env.PATH = mkdtempSync(join(home, 'no-path-'));
    const refused: string[] = [];
    const unguarded: string[] = [];
    // Never a valid body: a malformed one stops a validated write at its validator, AFTER the guard.
    const send = (route: { method: string; path: string }, headers: Record<string, string>) =>
      request(route.path.replace(':projectId', 'boot').replace(/:[A-Za-z0-9_]+/g, 'x'), {
        method: route.method,
        headers: route.method === 'GET' ? headers : { 'content-type': 'application/json', ...headers },
        ...(route.method === 'GET' ? {} : { body: '{' }),
      });
    try {
      for (const [name, route] of routes) {
        if (name === 'POST /api/v1/auth/logout') continue; // would end the session the walk rides on
        const anonymous = await send(route, {});
        if (anonymous.status !== 401 && !isPublicAuthPath(route.path)) unguarded.push(`${anonymous.status} ${name}`);
        const response = await send(route, { cookie });
        void response.body?.cancel().catch(() => undefined); // an SSE stream would otherwise stay open
        if (response.status === 401 || response.status === 403) refused.push(`${response.status} ${name}`);
      }
    } finally {
      vi.unstubAllGlobals();
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    // The guard answers before any validator: the malformed body never bought an anonymous 400.
    expect(unguarded).toEqual([]);
    expect(refused).toEqual([]);
    expect((await request('/api/v1/auth/logout', { method: 'POST', headers: { cookie } })).status).toBe(200);
  }, 60_000);

  it('does not run a guarded handler for an anonymous caller: health leaks nothing', async () => {
    const response = await request('/api/v1/health');
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(repoRoot);
  });

  it.each([
    '/api/v1/health/',
    '/API/v1/health',
    '/%61pi/v1/health',
    '/api/v1/%68ealth',
    '//api/v1/health',
    '/api//v1/health',
    '/api/v1/auth/../health',
    '/api/v1/auth/session/../../health',
  ])('no alternative spelling of a guarded path reaches its handler: %s', async (path) => {
    const response = await request(path);
    const body = await response.text();
    // The guard's 401, the router's 404, or — for a path that is not under /api at all — the
    // public cockpit shell. Never the handler's JSON.
    if (response.status === 200) expect(response.headers.get('content-type')).toContain('text/html');
    else expect([401, 404]).toContain(response.status);
    expect(body).not.toContain(repoRoot);
    expect(body).not.toContain('"version"');
  });

  it('local cockpits are untouched: no login, and the auth routes say so', async () => {
    delete process.env.CEZ_REMOTE;
    const local = { host: '127.0.0.1:4321' };
    expect((await app.request('/api/v1/health', { headers: local })).status).toBe(200);
    const session = await app.request('/api/v1/auth/session', { headers: local });
    expect(authSessionResponseSchema.strict().parse(await session.json()))
      .toEqual({ enforced: false, authenticated: true, setupRequired: false });
    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { ...local, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'b' }),
    });
    expect(login.status).toBe(409);
  });

  it('CEZ_AUTH=0 hands a hosted cockpit back to its proxy', async () => {
    process.env.CEZ_AUTH = '0';
    expect((await request('/api/v1/health')).status).toBe(200);
  });

  it('walks setup → session → sign-out → two-step sign-in, matching the contract at every step', async () => {
    const before = authSessionResponseSchema.strict().parse(await (await request('/api/v1/auth/session')).json());
    expect(before).toEqual({ enforced: true, authenticated: false, setupRequired: true });

    const owner = await createOwner();
    expect(owner.cookie.startsWith('__Host-cez_session=')).toBe(true);
    expect((await request('/api/v1/health', { headers: { cookie: owner.cookie } })).status).toBe(200);
    const session = await request('/api/v1/auth/session', { headers: { cookie: owner.cookie } });
    expect(authSessionResponseSchema.strict().parse(await session.json()))
      .toMatchObject({ authenticated: true, setupRequired: false, user: { name: 'mateusz', role: 'owner' } });

    const out = await request('/api/v1/auth/logout', { method: 'POST', headers: { cookie: owner.cookie } });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await request('/api/v1/health', { headers: { cookie: owner.cookie } })).status).toBe(401);

    const wrong = await post('/api/v1/auth/login', { username: 'mateusz', password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const first = await post('/api/v1/auth/login', { username: 'mateusz', password: PASSWORD });
    expect(first.headers.get('set-cookie')).toBeNull(); // a password alone is not a session
    const { ticket } = authLoginResponseSchema.strict().parse(await first.json());
    // The setup step consumed the current time step, so sign in with the next one.
    const code = hotp(base32Decode(owner.secret)!, totpStep(Date.now()) + 1);
    const verified = await post('/api/v1/auth/login/verify', { ticket, code });
    expect(verified.status).toBe(200);
    authVerifyResponseSchema.strict().parse(await verified.json());
    const attrs = verified.headers.get('set-cookie')!;
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(attrs).toContain(attr);
    expect(attrs).not.toContain('Domain');

    const cookie = cookieOf(verified);
    const devices = await request('/api/v1/auth/sessions', { headers: { cookie } });
    const { sessions } = authDevicesResponseSchema.strict().parse(await devices.json());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ current: true });
    const revoked = await request(`/api/v1/auth/sessions/${sessions[0]!.id}`, { method: 'DELETE', headers: { cookie } });
    expect(revoked.status).toBe(200);
    expect((await request('/api/v1/health', { headers: { cookie } })).status).toBe(401);
  });

  it('refuses to sign anyone in over plain HTTP on a public host', async () => {
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('refused');
    const response = await app.request('/api/v1/auth/setup/begin', {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.setup.code, username: 'mateusz', password: PASSWORD }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining('HTTPS') });
  });

  it('honours the plain cookie on loopback only — never on a public host', async () => {
    process.env.CEZ_AUTH = '1';
    delete process.env.CEZ_REMOTE;
    const local = { host: 'localhost:4321', 'content-type': 'application/json' };
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('refused');
    const begin = await app.request('/api/v1/auth/setup/begin', {
      method: 'POST', headers: local, body: JSON.stringify({ code: issued.setup.code, username: 'mateusz', password: PASSWORD }),
    });
    const begun = authSetupBeginResponseSchema.parse(await begin.json());
    const complete = await app.request('/api/v1/auth/setup/complete', {
      method: 'POST', headers: local,
      body: JSON.stringify({ ticket: begun.ticket, code: hotp(base32Decode(begun.secret)!, totpStep(Date.now())) }),
    });
    const cookie = cookieOf(complete);
    expect(cookie.startsWith('cez_session=')).toBe(true);
    expect(complete.headers.get('set-cookie')).not.toContain('Secure');
    expect((await app.request('/api/v1/health', { headers: { host: 'localhost:4321', cookie } })).status).toBe(200);
    // The same cookie arriving for a public host is a planted one: hosted, it opens nothing.
    process.env.CEZ_REMOTE = '1';
    expect((await request('/api/v1/health', { headers: { cookie } })).status).toBe(401);
  });

  it('rejects malformed auth bodies with the API’s one 400 shape', async () => {
    const response = await post('/api/v1/auth/setup/begin', { code: 'x', username: 'Has Spaces', password: 'short' });
    expect(response.status).toBe(400);
    expect(Object.keys((await response.json()) as object)).toEqual(['error']);
  });

  it('a task’s token opens its own agent routes while it runs, and nothing else', async () => {
    enableRunTokens();
    const token = mintRunToken('run-1', 'boot')!;
    const bearer = { authorization: `Bearer ${token}` };
    expect((await request('/api/v1/p/boot/runs', { headers: bearer })).status).toBe(401); // not running
    active.add('run-1');
    expect((await request('/api/v1/p/boot/runs', { headers: bearer })).status).toBe(200);
    expect((await request('/api/v1/health', { headers: bearer })).status).toBe(403);
    expect((await request('/api/v1/p/boot/runs/run-2/dispatch', { method: 'POST', headers: bearer })).status).toBe(403);
    expect((await request('/api/v1/auth/sessions', { headers: bearer })).status).toBe(403);
    expect((await request('/api/v1/p/boot/runs', { headers: { authorization: 'Bearer cezrun_forged.sig' } })).status).toBe(401);
  });

  it('this host’s key file authenticates a shell, and a wrong key does not', async () => {
    ensureHostKey();
    const key = readHostKey()!;
    expect((await request('/api/v1/health', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    expect((await request('/api/v1/health', { headers: { authorization: `Bearer ${key}x` } })).status).toBe(401);
    if (process.platform !== 'win32') {
      const { statSync } = await import('node:fs');
      expect(statSync(join(home, 'auth-host.key')).mode & 0o777).toBe(0o600);
    }
  });

  it('a signed-in owner is a trusted operator: the hosted gates open for them and for nobody else', async () => {
    const { cookie } = await createOwner();
    const asOwner = { cookie };
    const health = (await (await request('/api/v1/health', { headers: asOwner })).json()) as {
      capabilities: Record<string, boolean>;
    };
    expect(health.capabilities).toMatchObject({ terminal: true, fileEdit: true });
    // Machine properties did not move: there is still no editor to open on the viewer's side.
    expect(health.capabilities).toMatchObject({ localHandoff: false, preview: false });

    const listing = (await (await request('/api/v1/agent-config', { headers: asOwner })).json()) as { editable: boolean };
    expect(listing.editable).toBe(true);
    const write = (headers: Record<string, string>) =>
      request('/api/v1/agent-config/claude.project.settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ content: '{"hooks":{}}', version: null }),
      });
    expect((await write(asOwner)).status).toBe(200);
    expect(readFileSync(join(repoRoot, '.claude/settings.json'), 'utf8')).toBe('{"hooks":{}}');
    expect((await write({})).status).toBe(401); // the same write, anonymous

    // Handing auth back to the proxy closes it again — the hooks RCE path #404 named.
    process.env.CEZ_AUTH = '0';
    const refused = await write({});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: expect.stringContaining('CEZ_AUTH=0') });
    expect((await request('/api/v1/open-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"target":"finder"}' })).status).toBe(409);
  });

  it('gates the WebSocket handshake on the same session', async () => {
    const service = new AuthService({ scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    const enforced = () => authEnforced(process.env);
    const upgrade = (headers: Record<string, string>) =>
      upgradeIsAuthenticated({ headers } as unknown as IncomingMessage, { service, enforced });
    expect(upgrade({ host: HOST })).toBe(false);
    const owner = await createOwner();
    expect(upgrade({ host: HOST, cookie: owner.cookie })).toBe(true);
    expect(upgrade({ host: HOST, cookie: '__Host-cez_session=forged' })).toBe(false);
    process.env.CEZ_AUTH = '0';
    expect(upgrade({ host: HOST })).toBe(true);
  });

  it('the real listener refuses a WebSocket handshake without a session, and accepts one with it', async () => {
    const { cookie } = await createOwner();
    const pinned = { dry: process.env.CEZ_DRY_RUN, automations: process.env.CEZ_AUTOMATIONS, skills: process.env.CEZ_SKILLS_AUTO_UPDATE };
    // Nothing in the background: this boots the listener for its upgrade hook only.
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_AUTOMATIONS = '0';
    process.env.CEZ_SKILLS_AUTO_UPDATE = '0';
    // Its own AuthService, as `serve` builds one: the session is found through the store on disk.
    const server = startServer(
      { repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test', bootProjectId: 'boot', auth: new AuthService({ scrypt: { N: 2 ** 10, r: 8, p: 1 } }) },
      0,
    );
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const { port } = server.address() as { port: number };
      /** 101 when the socket opened, else the status the handshake was refused with. */
      const handshake = (headers: Record<string, string>, path = '/api/v1/ws') =>
        new Promise<number>((resolve) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { ...HOSTED, ...headers } });
          socket.once('open', () => { socket.terminate(); resolve(101); });
          socket.once('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode ?? 0); });
          socket.once('error', () => resolve(0));
        });
      expect(await handshake({})).toBe(403);
      expect(await handshake({ origin: `https://${HOST}` })).toBe(403); // same-origin is not a session
      expect(await handshake({ cookie: '__Host-cez_session=forged' })).toBe(403);
      expect(await handshake({ cookie: cookie.replace('__Host-', '') })).toBe(403); // the plain name, on a public host
      expect(await handshake({ cookie })).toBe(101);
      expect(await handshake({ cookie, origin: `https://${HOST}` })).toBe(101);
      // A session does not replace the #426 origin guard — both halves of the `&&` are wired.
      expect(await handshake({ cookie, origin: 'https://evil.example' })).toBe(403);
      // And the plain HTTP surface of the same listener is the guarded app.
      const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      expect(health.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); });
      for (const [key, value] of [['CEZ_DRY_RUN', pinned.dry], ['CEZ_AUTOMATIONS', pinned.automations], ['CEZ_SKILLS_AUTO_UPDATE', pinned.skills]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30_000);

  it('has no listener or upgrade hook outside the ones the spec accounts for', () => {
    // §6: a new server or upgrade path is a new way in. Adding one means deciding how it
    // authenticates, then adding it here. Pinned per file as COUNTS, so a second listener in a
    // file that already has one is seen too.
    const accounted: Record<string, { listeners: number; upgrades: number }> = {
      'server/server.ts': { listeners: 1, upgrades: 0 }, // the cockpit itself: `serve()`, guarded app + the hub below
      'server/ws.ts': { listeners: 1, upgrades: 1 }, // /api/v1/ws, `noServer` — gated in startServer by upgradeIsAuthenticated
      'server/preview/gateway.ts': { listeners: 1, upgrades: 1 }, // its own ticket + cookie (spec 2026-10-10-preview-gateway §4)
      'server/preview/design-proxy.ts': { listeners: 1, upgrades: 1 }, // loopback-only; unreachable from a hosted cockpit
      'index.ts': { listeners: 1, upgrades: 0 }, // a free-port probe: listens, never accepts a request
      'server-install/state.ts': { listeners: 1, upgrades: 0 }, // the same probe, for the installer
    };
    const LISTENER = /\b(?:createServer|createSecureServer|serve)\(|\bnew\s+(?:[\w.]+\.)?(?:WebSocketServer|Server)\(/g;
    const UPGRADE = /\.(?:on|once|addListener|prependListener)\(\s*['"`]upgrade['"`]/g;
    const root = join(import.meta.dirname, '..');
    const found: Record<string, { listeners: number; upgrades: number }> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(entry.name)) {
          // Comments talk about `serve()`; only code can open a port. Whole comment LINES only —
          // pairing `/*` with `*/` would swallow the code between two `'/api/*'` route patterns.
          const source = readFileSync(path, 'utf8').replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, '');
          const counts = { listeners: source.match(LISTENER)?.length ?? 0, upgrades: source.match(UPGRADE)?.length ?? 0 };
          if (counts.listeners + counts.upgrades > 0) found[path.slice(root.length + 1).replaceAll('\\', '/')] = counts;
        }
      }
    };
    walk(root);
    expect(found).toEqual(accounted);
  });
});

/**
 * §7: a task's CLIs need a credential wherever they are given the cockpit's address — the three
 * of them (`cez task`, `cez automation`, `cez tracker`) are gated separately, and only one is
 * dispatch. Read at `agentEnvForStep`, the one seam `execute` and `runContinuation` both spawn
 * through.
 */
describe('a task’s CEZ_API_TOKEN', () => {
  const NAMES = ['CEZ_HOME', 'CEZ_REMOTE', 'CEZ_AUTH', 'CEZ_API_URL', 'CEZ_BIN', 'CEZ_DISPATCH', 'CEZ_AUTOMATIONS'] as const;
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  type Seam = { agentEnvForStep(runId: string, backend: 'claude'): Promise<{ env: Record<string, string> }> };
  const envOf = async (projectId: string | undefined = 'proj') => {
    const manager = new RunManager(store, repoRoot, projectId ? { projectId } : {});
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 'work', name: 'work', kind: 'agent' }] });
    return { run, env: (await (manager as unknown as Seam).agentEnvForStep(run.id, 'claude')).env };
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-runtoken-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-runtoken-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_REMOTE = '1';
    delete process.env.CEZ_AUTH;
    // What `serve` writes into its own environment, and every agent inherits (`buildChildEnv`).
    process.env.CEZ_API_URL = 'http://127.0.0.1:4321';
    process.env.CEZ_BIN = '/opt/cezar/bin.js';
    delete process.env.CEZ_DISPATCH;
    delete process.env.CEZ_AUTOMATIONS;
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
  });

  afterEach(async () => {
    disableRunTokens();
    store.flush();
    await removeTempDir(home, repoRoot);
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('is minted with dispatch on, for the project the CLI will address', async () => {
    enableRunTokens();
    const { run, env } = await envOf();
    expect(verifyRunToken(env.CEZ_API_TOKEN!)).toEqual({ runId: run.id, projectId: 'proj' });
    expect(env.CEZ_PROJECT_ID).toBe('proj');
  });

  it('is minted with CEZ_DISPATCH=0 too — `cez automation` is still reachable and still needs it', async () => {
    enableRunTokens();
    process.env.CEZ_DISPATCH = '0';
    const { run, env } = await envOf();
    const claims = verifyRunToken(env.CEZ_API_TOKEN ?? '');
    expect(claims).toEqual({ runId: run.id, projectId: 'proj' });
    // The token only opens the project it names, so the CLI has to be told to address it.
    expect(env.CEZ_PROJECT_ID).toBe('proj');
    expect(runTokenAllows(claims!, 'GET', `/api/v1/p/${env.CEZ_PROJECT_ID}/automations`)).toBe(true);
  });

  it('is not minted when no CLI can reach the cockpit', async () => {
    enableRunTokens();
    process.env.CEZ_DISPATCH = '0';
    process.env.CEZ_AUTOMATIONS = '0';
    expect((await envOf()).env.CEZ_API_TOKEN).toBeUndefined();
    delete process.env.CEZ_DISPATCH;
    delete process.env.CEZ_AUTOMATIONS;
    delete process.env.CEZ_API_URL; // a headless `cezar run`
    expect((await envOf()).env.CEZ_API_TOKEN).toBeUndefined();
  });

  it.each(['1', '0'])('auth off leaves the environment as it was (CEZ_DISPATCH=%s)', async (dispatch) => {
    process.env.CEZ_AUTH = '0';
    process.env.CEZ_DISPATCH = dispatch;
    const { env } = await envOf();
    expect(env.CEZ_API_TOKEN).toBeUndefined();
    expect('CEZ_PROJECT_ID' in env).toBe(dispatch === '1');
    expect('CEZ_API_URL' in env).toBe(dispatch === '1');
  });
});
