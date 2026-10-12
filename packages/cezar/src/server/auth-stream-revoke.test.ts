import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { authSetupBeginResponseSchema } from '@open-mercato/cezar-contract';
import { runTokenAllows } from '../auth/run-tokens.ts';
import { AuthService } from '../auth/service.ts';
import { issueSetupCode } from '../auth/store.ts';
import { base32Decode, hotp, totpStep } from '../auth/totp.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import * as serverModule from './server.ts';
import { createApp } from './server.ts';
import { createSocketHub, WS_PATH, type SocketHub, type WsUpgradeVerdict } from './ws.ts';

/**
 * Spec `2026-10-12-cockpit-authentication.md` §5.3/§6: a stream or socket a session opened ends
 * with that session — sign-out, revoke, reset, expiry — instead of outliving it.
 */

const HOST = 'agents.example.dev';
const HOSTED = { host: HOST, 'x-forwarded-proto': 'https' };
const PASSWORD = 'a long enough password';
const TICK_MS = 20;
const DAY_MS = 24 * 60 * 60_000;

type Verifier = (req: IncomingMessage) => WsUpgradeVerdict;
/** Read off the namespace so the suite still LOADS against a tree without the fix. */
const wsUpgradeVerifier = (serverModule as unknown as {
  wsUpgradeVerifier?: (auth: AuthService, enforced: () => boolean, bindHost?: string) => Verifier;
}).wsUpgradeVerifier;

describe('streams end with the session that opened them', () => {
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let auth: AuthService;
  let clock: number;
  let servers: Server[];
  let hubs: SocketHub[];
  const saved = { home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };

  const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.request(path, { ...init, headers: { ...HOSTED, ...init.headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

  async function createOwner(): Promise<string> {
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('setup code refused');
    const begin = await post('/api/v1/auth/setup/begin', { code: issued.setup.code, username: 'mateusz', password: PASSWORD });
    const begun = authSetupBeginResponseSchema.parse(await begin.json());
    const code = hotp(base32Decode(begun.secret)!, totpStep(Date.now()));
    const complete = await post('/api/v1/auth/setup/complete', { ticket: begun.ticket, code });
    expect(complete.status).toBe(200);
    return complete.headers.get('set-cookie')!.split(';')[0]!;
  }

  /** Opens an SSE stream and reports whether the SERVER ended it within `withinMs`. */
  async function openStream(path: string, headers: Record<string, string>) {
    const response = await request(path, { headers });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let ended = false;
    const drained = (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      ended = true;
    })().catch(() => undefined);
    return {
      endedWithin: async (withinMs: number): Promise<boolean> => {
        await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, withinMs))]);
        return ended;
      },
      cancel: () => reader.cancel().catch(() => undefined),
    };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-streamrevoke-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-streamrevoke-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_REMOTE = '1';
    delete process.env.CEZ_AUTH; // the real default: hosted ⇒ enforced
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    clock = 0;
    servers = [];
    hubs = [];
    auth = new AuthService({ scrypt: { N: 2 ** 10, r: 8, p: 1 }, now: () => Date.now() + clock });
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      bootProjectId: 'boot',
      auth,
      ssePingMs: TICK_MS,
    } as Parameters<typeof createApp>[0]) as unknown as Hono;
  });

  afterEach(async () => {
    for (const hub of hubs) hub.close();
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
    store.flush();
    await removeTempDir(home, repoRoot);
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const ssePaths = (): Array<[string, string]> => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    return [
      ['workspace events', '/api/v1/workspace/events'],
      ['project events', '/api/v1/events'],
      ['run events', `/api/v1/runs/${run.id}/events`],
    ];
  };

  it('ends each of the three SSE routes once its session signs out', async () => {
    const cookie = await createOwner();
    const streams = await Promise.all(ssePaths().map(async ([label, path]) => ({ label, stream: await openStream(path, { cookie }) })));
    for (const { label, stream } of streams) expect(await stream.endedWithin(TICK_MS * 3), `${label}: open while the session stands`).toBe(false);
    expect((await post('/api/v1/auth/logout', {}, { cookie })).status).toBe(200);
    const ended = await Promise.all(streams.map(async ({ label, stream }) => [label, await stream.endedWithin(1_500)] as const));
    await Promise.all(streams.map(({ stream }) => stream.cancel()));
    expect(ended).toEqual([['workspace events', true], ['project events', true], ['run events', true]]);
  });

  it('ends an SSE stream when the session expires idle, without the stream keeping it alive', async () => {
    const cookie = await createOwner();
    const stream = await openStream('/api/v1/workspace/events', { cookie });
    expect(await stream.endedWithin(TICK_MS * 5)).toBe(false);
    clock = 8 * DAY_MS; // past the 7-day idle window
    const ended = await stream.endedWithin(1_500);
    await stream.cancel();
    expect(ended).toBe(true);
  });

  // Guard: passes with and without the fix — a cockpit without auth must not change.
  it('leaves a stream alone when auth is not enforced', async () => {
    process.env.CEZ_AUTH = '0';
    const stream = await openStream('/api/v1/workspace/events', {});
    const ended = await stream.endedWithin(TICK_MS * 10);
    await stream.cancel();
    expect(ended).toBe(false);
  });

  // Guard: a run token reaches no stream at all, so there is no run-opened stream to end.
  it('has no SSE or WebSocket route on the run-token allowlist', () => {
    const claims = { runId: 'r1', projectId: 'boot' };
    for (const path of ['/api/v1/workspace/events', '/api/v1/events', '/api/v1/p/boot/events', '/api/v1/runs/r1/events', '/api/v1/p/boot/runs/r1/events', WS_PATH]) {
      expect(runTokenAllows(claims, 'GET', path), path).toBe(false);
    }
  });

  async function bootHub(verify: Verifier): Promise<string> {
    const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
    const hub = createSocketHub({ heartbeatMs: TICK_MS });
    hub.attach(server, verify);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    hubs.push(hub);
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}${WS_PATH}`;
  }

  async function connectAndWaitClose(url: string, headers: Record<string, string>) {
    const ws = new WebSocket(url, { headers });
    let closed = false;
    const closing = new Promise<void>((resolve) => ws.on('close', () => { closed = true; resolve(); }));
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    return {
      closedWithin: async (withinMs: number): Promise<boolean> => {
        await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, withinMs))]);
        return closed;
      },
      terminate: () => ws.terminate(),
    };
  }

  it('the hub terminates a client whose verdict says its session is gone', async () => {
    let alive = true;
    const url = await bootHub(() => ({ trusted: true, alive: () => alive }) as WsUpgradeVerdict);
    const client = await connectAndWaitClose(url, {});
    expect(await client.closedWithin(TICK_MS * 5)).toBe(false);
    alive = false;
    const closed = await client.closedWithin(1_500);
    client.terminate();
    expect(closed).toBe(true);
  });

  it('a socket opened with a session cookie is terminated when that session signs out', async () => {
    const cookie = await createOwner();
    expect(wsUpgradeVerifier, 'server.ts exports the upgrade verifier startServer attaches').toBeTypeOf('function');
    // The hub listens on loopback here; the verifier sees the hosted Host the proxy would forward.
    const verify = wsUpgradeVerifier!(auth, () => true);
    const url = await bootHub((req) => verify({ headers: { ...req.headers, host: HOST } } as IncomingMessage));
    const client = await connectAndWaitClose(url, { cookie });
    expect(await client.closedWithin(TICK_MS * 5)).toBe(false);
    expect((await post('/api/v1/auth/logout', {}, { cookie })).status).toBe(200);
    const closed = await client.closedWithin(1_500);
    client.terminate();
    expect(closed).toBe(true);
  });

  it('refuses the upgrade without a session, and never ends a host-key or auth-off socket', async () => {
    expect(wsUpgradeVerifier).toBeTypeOf('function');
    const req = (headers: Record<string, string>) => ({ headers: { host: HOST, ...headers } }) as IncomingMessage;
    expect(wsUpgradeVerifier!(auth, () => true)(req({}))).toBe(false);
    // Auth off: the verdict is exactly verifyWsUpgrade's, with nothing to poll.
    expect(wsUpgradeVerifier!(auth, () => false)(req({}))).toEqual({ trusted: true });
  });
});
