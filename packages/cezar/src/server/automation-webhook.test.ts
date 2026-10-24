import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationWebhookResponseSchema, hookDeliveryResponseSchema } from '@open-mercato/cezar-contract';
import { AutomationStore } from '../automations/store.ts';
import { ProjectAutomationScheduler } from '../automations/scheduler.ts';
import type { GithubAutomationDefinition } from '../automations/types.ts';
import { newWebhookIdentity, readWebhook, registerGithubHook, verifySignature, WakeThrottle, writeWebhook } from '../automations/webhook.ts';
import { isPublicHookRequest } from '../auth/guard.ts';
import { automationWebhookRoutes, HookIndex, hookRoutes, wakeGithubPolls, type WebhookRouteDeps } from './automation-webhook.ts';
import type { ProjectContext } from './project-context.ts';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'cezar-webhook-')); });
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('POST /hooks/:sender/:hookId (spec 2026-10-23-github-events §4)', () => {
  function setup(now = { value: 0 }) {
    const identity = newWebhookIdentity();
    writeWebhook(dataDir, { version: 1, ...identity, githubHookId: 7 });
    const wake = vi.fn();
    const project = { id: 'p', dataDir };
    // Timers by hand: a trailing wake fires only when the test says the window closed.
    const timers: Array<{ fire: () => void; ms: number; cleared?: boolean }> = [];
    const app = new Hono().route('/api/v1', hookRoutes({
      find: async (hookId) => (hookId === identity.hookId ? project : undefined),
      wake,
      throttle: new WakeThrottle(5_000, () => now.value, {
        set: (fire, ms) => { const timer = { fire, ms }; timers.push(timer); return timer; },
        clear: (handle) => { (handle as { cleared?: boolean }).cleared = true; },
      }),
    }));
    const deliver = (body: string, headers: Record<string, string> = {}, hookId = identity.hookId) =>
      app.request(`/api/v1/hooks/github/${hookId}`, {
        method: 'POST',
        headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sign(identity.secret, body), ...headers },
        body,
      });
    return { identity, wake, deliver, now, timers };
  }

  it('wakes once more when the window closes, for the deliveries it collapsed', async () => {
    const { wake, deliver, now, timers } = setup();
    await deliver('{}');
    now.value = 1_000;
    expect(await (await deliver('{}')).json()).toEqual({ accepted: true, woke: false });
    now.value = 2_000;
    await deliver('{}');
    // One trailing wake, at the end of the window the first delivery opened.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(4_000);
    now.value = 5_000;
    timers[0]!.fire();
    await new Promise((resolve) => setImmediate(resolve));
    expect(wake).toHaveBeenCalledTimes(2);
    expect(readWebhook(dataDir)?.lastWakeAt).toBeDefined();
    // The trailing wake opened a window of its own.
    now.value = 6_000;
    expect(await (await deliver('{}')).json()).toEqual({ accepted: true, woke: false });
    // A leading wake that comes first makes the pending trailing one unnecessary.
    now.value = 10_000;
    expect(await (await deliver('{}')).json()).toEqual({ accepted: true, woke: true });
    expect(timers[1]!.cleared).toBe(true);
  });

  it('wakes once per 5 s per project; later deliveries collapse', async () => {
    const { wake, deliver, now } = setup();
    const first = await deliver('{"action":"created"}');
    expect(first.status).toBe(202);
    expect(hookDeliveryResponseSchema.strict().parse(await first.json())).toEqual({ accepted: true, woke: true });
    now.value = 4_999;
    expect(await (await deliver('{}')).json()).toEqual({ accepted: true, woke: false });
    now.value = 5_000;
    expect(await (await deliver('{}')).json()).toEqual({ accepted: true, woke: true });
    expect(wake).toHaveBeenCalledTimes(2);
    expect(readWebhook(dataDir)).toMatchObject({ lastEvent: 'issue_comment', lastDeliveryId: 'd-1' });
  });

  it('never parses the payload: a malformed body still wakes', async () => {
    const { wake, deliver } = setup();
    expect((await deliver('{not json')).status).toBe(202);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('answers 401 for a bad signature and 404 for an unknown id or sender', async () => {
    const { identity, wake, deliver } = setup();
    expect((await deliver('{}', { 'x-hub-signature-256': sign('wrong-secret', '{}') })).status).toBe(401);
    expect((await deliver('{}', { 'x-hub-signature-256': '' })).status).toBe(401);
    expect((await deliver('{}', {}, 'f'.repeat(64))).status).toBe(404);
    expect((await deliver('{}', {}, 'not-an-id')).status).toBe(404);
    const otherSender = await new Hono().route('/api/v1', hookRoutes({ find: async () => ({ id: 'p', dataDir }), wake }))
      .request(`/api/v1/hooks/gitlab/${identity.hookId}`, { method: 'POST', body: '{}' });
    expect(otherSender.status).toBe(404);
    expect(wake).not.toHaveBeenCalled();
  });

  it('records a ping as proof of the route without waking a poll', async () => {
    const { wake, deliver } = setup();
    expect(await (await deliver('{"zen":"x"}', { 'x-github-event': 'ping' })).json()).toEqual({ accepted: true, woke: false });
    expect(wake).not.toHaveBeenCalled();
    expect(readWebhook(dataDir)?.ping).toMatchObject({ ok: true });
  });

  it('lets only a well-formed github delivery skip the session guard', () => {
    const id = 'a'.repeat(64);
    expect(isPublicHookRequest('POST', `/api/v1/hooks/github/${id}`)).toBe(true);
    expect(isPublicHookRequest('GET', `/api/v1/hooks/github/${id}`)).toBe(false);
    expect(isPublicHookRequest('POST', `/api/v1/hooks/gitlab/${id}`)).toBe(false);
    expect(isPublicHookRequest('POST', '/api/v1/hooks/github/x')).toBe(false);
    expect(isPublicHookRequest('POST', `/api/v1/hooks/github/${id}/../../runs`)).toBe(false);
  });
});

describe('signature, wake and index', () => {
  it('verifies X-Hub-Signature-256 in constant time over the raw bytes', () => {
    const body = new TextEncoder().encode('{"a":1}');
    expect(verifySignature('s'.repeat(40), body, sign('s'.repeat(40), '{"a":1}'))).toBe(true);
    expect(verifySignature('s'.repeat(40), body, sign('s'.repeat(40), '{"a":2}'))).toBe(false);
    expect(verifySignature('s'.repeat(40), body, 'sha1=abc')).toBe(false);
  });

  it('makes enabled GitHub polls due now, leaving backed-off and paused ones alone', () => {
    const store = AutomationStore.open(dataDir);
    const base = { intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'x' } };
    const due = store.create({ name: 'a', enabled: true, events: ['push'], ...base }, 'a');
    const backed = store.create({ name: 'b', enabled: true, events: ['push'], ...base }, 'b');
    store.create({ name: 'c', enabled: false, events: ['push'], ...base }, 'c');
    store.setState(due.id, () => ({ nextCheckAt: '2030-01-01T00:00:00.000Z' }));
    store.setState(backed.id, () => ({ nextCheckAt: '2030-01-01T00:00:00.000Z', backoffUntil: '2030-01-01T00:00:00.000Z' }));
    const now = Date.parse('2026-10-24T00:00:00.000Z');
    expect(wakeGithubPolls(store, now)).toBe(1);
    expect(store.state('a')?.nextCheckAt).toBe('2026-10-24T00:00:00.000Z');
    expect(store.state('b')?.nextCheckAt).toBe('2030-01-01T00:00:00.000Z');
    expect(store.state('c')).toBeUndefined();
  });

  it('never polls sooner than a minute after the last poll: wakes inside it collapse into one trailing poll', () => {
    const store = AutomationStore.open(dataDir);
    const definition = store.create({ name: 'a', enabled: true, events: ['push'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'x' } }, 'a');
    const now = Date.parse('2026-10-24T00:00:00.000Z');
    store.setState(definition.id, () => ({ lastSuccessAt: new Date(now - 10_000).toISOString(), nextCheckAt: new Date(now + 290_000).toISOString() }));
    expect(wakeGithubPolls(store, now)).toBe(1);
    expect(store.state(definition.id)?.nextCheckAt).toBe(new Date(now + 50_000).toISOString());
    // A second wake inside the minute is the same trailing poll.
    expect(wakeGithubPolls(store, now + 5_000)).toBe(0);
    expect(store.state(definition.id)?.nextCheckAt).toBe(new Date(now + 50_000).toISOString());
    // A poll more than a minute ago: due now.
    store.setState(definition.id, (state) => ({ ...state, lastSuccessAt: new Date(now - 120_000).toISOString(), nextCheckAt: new Date(now + 180_000).toISOString() }));
    expect(wakeGithubPolls(store, now)).toBe(1);
    expect(store.state(definition.id)?.nextCheckAt).toBe(new Date(now).toISOString());
  });

  it('marks a wake on a poll that is already due, so a poll in flight stays due after it persists', async () => {
    const store = AutomationStore.open(dataDir);
    const definition = store.create({ name: 'a', enabled: true, events: ['push'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'x' } }, 'a') as GithubAutomationDefinition;
    store.setState(definition.id, () => ({ revision: definition.revision, baselineAt: '2026-01-01T00:00:00.000Z', nextCheckAt: '2026-01-01T00:00:00.000Z' }));
    let woken = false;
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p', timeZone: 'UTC', store, launch: async () => ({ runId: 'r' }),
      github: {
        owner: 'acme', repo: 'demo',
        // The delivery lands while the poll is reading GitHub.
        poller: { poll: async () => { if (!woken) { woken = true; wakeGithubPolls(store); } return { candidates: [], truncated: false, pages: 1 }; } } as never,
      },
    });
    await scheduler.check(definition);
    // Due again within the minute a wake waits after a poll, not an interval away.
    expect(Date.parse(store.state(definition.id)!.nextCheckAt!)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(Date.parse(store.state(definition.id)!.nextCheckAt!)).toBeGreaterThan(Date.now() + 50_000);
    // Without a wake, the next check is an interval away as always.
    await scheduler.check(definition);
    expect(Date.parse(store.state(definition.id)!.nextCheckAt!)).toBeGreaterThan(Date.now() + 200_000);
  });

  it('rescans for an unknown id at most once per window', async () => {
    const identity = newWebhookIdentity();
    writeWebhook(dataDir, { version: 1, ...identity });
    const projects = vi.fn(async () => [{ id: 'p', dataDir }]);
    let now = 0;
    const index = new HookIndex(projects, 10_000, () => now);
    expect(await index.find('f'.repeat(64))).toBeUndefined();
    expect(await index.find('e'.repeat(64))).toBeUndefined();
    expect(projects).toHaveBeenCalledTimes(1);
    expect(await index.find(identity.hookId)).toEqual({ id: 'p', dataDir });
    now = 10_000;
    expect(await index.find('d'.repeat(64))).toBeUndefined();
    expect(projects).toHaveBeenCalledTimes(2);
  });
});

describe('registration through gh api', () => {
  it('sends the secret on stdin, never as an argument', async () => {
    const run = vi.fn(async (_args: readonly string[], _stdin?: string) => '{"id":42,"type":"Repository"}');
    const id = await registerGithubHook({ owner: 'acme', repo: 'demo', url: 'https://cezar.example/api/v1/hooks/github/x', secret: 'top-secret', run });
    expect(id).toBe(42);
    const [args, stdin] = run.mock.calls[0]!;
    expect(args).toEqual(['api', '--method', 'POST', 'repos/acme/demo/hooks', '--input', '-']);
    expect(args.join(' ')).not.toContain('top-secret');
    expect(JSON.parse(stdin!)).toMatchObject({ name: 'web', active: true, config: { url: 'https://cezar.example/api/v1/hooks/github/x', content_type: 'json', secret: 'top-secret' } });
    await registerGithubHook({ owner: 'acme', repo: 'demo', host: 'ghe.corp', url: 'u', secret: 's', run });
    expect(run.mock.calls[1]![0].slice(0, 3)).toEqual(['api', '--hostname', 'ghe.corp']);
  });

  function routes(over: Partial<WebhookRouteDeps> = {}) {
    const project = { id: 'p', root: dataDir, dataDir } as unknown as ProjectContext;
    const run = vi.fn(async (args: readonly string[]) => (args.includes('hooks') || args.at(-1) === '-' ? '{"id":9}' : ''));
    const changed = vi.fn();
    const app = new Hono<{ Variables: { project: ProjectContext } }>()
      .use('*', async (c, next) => { c.set('project', project); await next(); })
      .route('/api/v1', automationWebhookRoutes({
        enabled: () => true,
        offMessage: 'off',
        canRegister: () => ({ ok: true }),
        publicOrigin: ({ host }) => (host ? `https://${host}` : undefined),
        remote: async () => ({ owner: 'acme', repo: 'demo', host: 'github.com' }),
        changed,
        run,
        ...over,
      }));
    return { app, run, changed };
  }
  const host = { host: 'cezar.example' };

  it('registers, reports, pings and removes the project hook', async () => {
    const { app, run, changed } = routes();
    const registered = await app.request('/api/v1/automation-webhook', { method: 'POST', headers: host });
    expect(registered.status).toBe(200);
    const { webhook } = automationWebhookResponseSchema.strict().parse(await registered.json());
    const file = readWebhook(dataDir)!;
    expect(webhook).toMatchObject({ available: true, registered: true, url: `https://cezar.example/api/v1/hooks/github/${file.hookId}` });
    expect(JSON.stringify(webhook)).not.toContain(file.secret);
    expect(file.githubHookId).toBe(9);
    expect(changed).toHaveBeenCalled();
    // Idempotent at the same URL: nothing new is registered.
    await app.request('/api/v1/automation-webhook', { method: 'POST', headers: host });
    expect(run.mock.calls.filter(([args]) => args.includes('POST') && args.includes('repos/acme/demo/hooks'))).toHaveLength(1);
    const pinged = automationWebhookResponseSchema.parse(await (await app.request('/api/v1/automation-webhook/ping', { method: 'POST', headers: host })).json());
    expect(pinged.webhook.ping).toMatchObject({ ok: true });
    expect(run.mock.calls.at(-1)![0]).toContain('repos/acme/demo/hooks/9/pings');
    const removed = automationWebhookResponseSchema.parse(await (await app.request('/api/v1/automation-webhook', { method: 'DELETE', headers: host })).json());
    expect(removed.webhook.registered).toBe(false);
    expect(readWebhook(dataDir)).toBeUndefined();
  });

  it('refuses where there is no public URL, and says why', async () => {
    const { app, run } = routes({ canRegister: () => ({ ok: false, reason: 'This cockpit runs locally.' }) });
    const status = automationWebhookResponseSchema.parse(await (await app.request('/api/v1/automation-webhook')).json());
    expect(status.webhook).toMatchObject({ available: false, reason: 'This cockpit runs locally.', registered: false, route: '/api/v1/hooks/github/<hook-id>' });
    expect((await app.request('/api/v1/automation-webhook', { method: 'POST' })).status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the registered hook when re-registering at a new URL fails, and drops the old one only after success', async () => {
    const previous = { version: 1 as const, ...newWebhookIdentity(), githubHookId: 7, repo: 'acme/demo', url: 'https://old.example/api/v1/hooks/github/x', registeredAt: '2026-10-01T00:00:00.000Z' };
    writeWebhook(dataDir, previous);
    const refusing = routes({ run: async (args) => { if (args.includes('POST')) throw new Error('HTTP 422: Validation failed'); return ''; } });
    const failed = await refusing.app.request('/api/v1/automation-webhook', { method: 'POST', headers: host });
    expect(failed.status).toBe(409);
    // GitHub still has hook 7 calling the old URL, so cezar still knows it.
    expect(readWebhook(dataDir)).toMatchObject({ hookId: previous.hookId, secret: previous.secret, githubHookId: 7 });

    const calls: string[] = [];
    const { app } = routes({ run: async (args) => { calls.push(args.join(' ')); return args.includes('POST') ? '{"id":9}' : ''; } });
    expect((await app.request('/api/v1/automation-webhook', { method: 'POST', headers: host })).status).toBe(200);
    expect(readWebhook(dataDir)).toMatchObject({ githubHookId: 9 });
    expect(calls.findIndex((call) => call.includes('POST'))).toBeLessThan(calls.findIndex((call) => call.includes('DELETE') && call.includes('hooks/7')));
  });

  it('leaves no half-registered hook when GitHub refuses', async () => {
    const { app } = routes({ run: async () => { throw new Error('HTTP 403: Resource not accessible'); } });
    const response = await app.request('/api/v1/automation-webhook', { method: 'POST', headers: host });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('403');
    expect(readWebhook(dataDir)).toBeUndefined();
  });
});
