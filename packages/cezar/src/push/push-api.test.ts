import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspacePushStateSchema, type PushPayload } from '@open-mercato/cezar-contract';
import { pushSubscriptionsPath, pushVapidPath } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';
import type { SocketHub } from '../server/ws.ts';
import type { RunManager } from '../workflows/run.ts';
import { resetPushStateCache, PushSubscriptionStore } from './state.ts';
import type { PushOutcome, PushTarget } from './web-push.ts';

/** `/api/v1/workspace/push*` and the run-transition push (spec 2026-10-24-mobile-cockpit §3.5, §4). */

const SUBSCRIPTION = {
  endpoint: 'https://push.example.net/send/abc',
  expirationTime: null,
  keys: {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
};

describe('the push API', () => {
  const saved = { home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let visible: Set<string>;
  let sent: Array<{ target: PushTarget; payload: PushPayload }>;
  let sendOutcome: () => PushOutcome;
  let app: Hono;

  const hub: SocketHub = {
    registerTopic: () => () => undefined,
    attach: () => undefined,
    holders: () => visible,
    close: () => undefined,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-push-api-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_REMOTE = '1';
    process.env.CEZ_AUTH = '0';
    resetPushStateCache();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-push-api-repo-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    visible = new Set();
    sent = [];
    sendOutcome = () => 'sent';
    app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      socketHub: hub,
      pushSubscriptions: new PushSubscriptionStore(pushSubscriptionsPath()),
      pushSend: async (target, payload) => {
        sent.push({ target, payload });
        return sendOutcome();
      },
    });
  });

  afterEach(() => {
    store.flush();
    resetPushStateCache();
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const json = (method: string, path: string, body?: unknown) =>
    apiRequest(app, path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const state = async (response: Response | Promise<Response>) => {
    const answer = await response;
    expect(answer.status).toBe(200);
    return workspacePushStateSchema.parse(await answer.json());
  };
  const flushed = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('is unavailable on a local cockpit and generates no key there', async () => {
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_AUTH;
    expect(await state(json('GET', '/api/v1/workspace/push'))).toEqual({ available: false, publicKey: null, subscribed: false, stale: false });
    expect((await json('POST', '/api/v1/workspace/push/subscribe', SUBSCRIPTION)).status).toBe(409);
    expect(() => statSync(pushVapidPath())).toThrow();
  });

  it('subscribes and unsubscribes a device on a hosted cockpit, with the VAPID key generated once at 0600', async () => {
    const first = await state(json('GET', '/api/v1/workspace/push'));
    expect(first.available).toBe(true);
    expect(first.publicKey).toMatch(/^B[A-Za-z0-9_-]{80,}$/);
    expect(first.subscribed).toBe(false);
    if (process.platform !== 'win32') expect(statSync(pushVapidPath()).mode & 0o777).toBe(0o600);

    expect((await state(json('POST', '/api/v1/workspace/push/subscribe', SUBSCRIPTION))).subscribed).toBe(true);
    resetPushStateCache();
    expect((await state(json('GET', '/api/v1/workspace/push'))).publicKey).toBe(first.publicKey);
    expect((await state(json('DELETE', '/api/v1/workspace/push/subscribe', { endpoint: SUBSCRIPTION.endpoint }))).subscribed).toBe(false);
  });

  it('refuses a subscription that is not an https endpoint', async () => {
    expect((await json('POST', '/api/v1/workspace/push/subscribe', { ...SUBSCRIPTION, endpoint: 'http://push.example.net/x' })).status).toBe(400);
  });

  it.each([
    'https://127.0.0.1/x', 'https://127.1.2.3:8443/x', 'https://10.0.0.5/x', 'https://172.16.0.1/x', 'https://172.31.255.255/x',
    'https://192.168.1.1/x', 'https://169.254.169.254/latest/meta-data', 'https://0.0.0.0/x', 'https://[::1]/x', 'https://[fe80::1]/x',
    'https://[fd00::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[::]/x', 'https://localhost/x', 'https://api.localhost/x',
    'https://LOCALHOST./x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://intranet/x', 'https://user@127.0.0.1/x',
  ])('refuses a push endpoint on a loopback, private or link-local host: %s', async (endpoint) => {
    expect((await json('POST', '/api/v1/workspace/push/subscribe', { ...SUBSCRIPTION, endpoint })).status).toBe(400);
  });

  it.each(['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QK', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://8.8.8.8/x', 'https://172.32.0.1/x'])(
    'accepts a public push endpoint: %s', async (endpoint) => {
      expect((await json('POST', '/api/v1/workspace/push/subscribe', { ...SUBSCRIPTION, endpoint })).status).toBe(200);
    },
  );

  it('keeps at most ten subscriptions per account — the oldest goes', async () => {
    for (let i = 0; i < 11; i += 1) {
      expect((await json('POST', '/api/v1/workspace/push/subscribe', { ...SUBSCRIPTION, endpoint: `https://push.example.net/send/${i}` })).status).toBe(200);
    }
    const rows = new PushSubscriptionStore(pushSubscriptionsPath()).list();
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.endpoint)).not.toContain('https://push.example.net/send/0');
    expect(rows.map((row) => row.endpoint)).toContain('https://push.example.net/send/10');
  });

  it('pushes a task that enters review — title and status only — when no tab of the account is visible', async () => {
    expect((await state(json('POST', '/api/v1/workspace/push/subscribe', SUBSCRIPTION))).subscribed).toBe(true);
    const run = store.createRun({ title: 'Fix the login bug', workflow: 'quick-task', task: 'SECRET PROMPT TEXT', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'review' });
    await flushed();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target.endpoint).toBe(SUBSCRIPTION.endpoint);
    expect(sent[0]!.payload).toEqual({ title: 'Fix the login bug', status: 'Task needs review', url: `/p/default/tasks/${run.id}`, tag: `cezar-run-${run.id}` });
    expect(JSON.stringify(sent[0]!.payload)).not.toContain('SECRET');
  });

  it('stays silent while a cockpit tab of that account is visible', async () => {
    await json('POST', '/api/v1/workspace/push/subscribe', SUBSCRIPTION);
    visible = new Set(['owner']);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'waiting' });
    await flushed();
    expect(sent).toEqual([]);
  });

  it('marks a subscription the push service refuses with 403 stale, stops sending to it, and a re-subscribe heals it', async () => {
    await json('POST', '/api/v1/workspace/push/subscribe', SUBSCRIPTION);
    const outcomes: Array<'stale' | 'sent'> = ['stale', 'sent'];
    sendOutcome = () => outcomes.shift() ?? 'sent';
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'review' });
    await flushed();
    expect(sent).toHaveLength(1);
    expect(await state(json('GET', '/api/v1/workspace/push'))).toMatchObject({ subscribed: false, stale: true });

    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'waiting' });
    await flushed();
    expect(sent).toHaveLength(1);

    expect(await state(json('POST', '/api/v1/workspace/push/subscribe', SUBSCRIPTION))).toMatchObject({ subscribed: true, stale: false });
  });

  it('pushes nothing without a subscription, and nothing for a status that does not want you', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'review' });
    await json('POST', '/api/v1/workspace/push/subscribe', SUBSCRIPTION);
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'done' });
    await flushed();
    expect(sent).toEqual([]);
  });
});
