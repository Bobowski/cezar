import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthEnv, Principal } from '../auth/guard.ts';
import { createPresenceBeats } from './presence.ts';
import { PRESENCE_BEATS_PER_MINUTE, PRESENCE_TABS_PER_CALLER, pushRoutes } from './routes.ts';
import { PushSubscriptionStore } from './state.ts';
import { generateVapidKeys } from './web-push.ts';

/** `DELETE /workspace/push/subscribe` for a signed-in device (spec 2026-10-24-mobile-cockpit §4, §5). */

const keys = { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) };
const user = { id: 'u1', role: 'owner' } as unknown as Extract<Principal, { kind: 'user' }>['user'];

describe('the push routes for a signed-in device', () => {
  let dir: string;
  let store: PushSubscriptionStore;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-push-routes-'));
    store = new PushSubscriptionStore(join(dir, 'push-subscriptions.json'));
    const vapid = generateVapidKeys();
    store.upsert({ account: 'u1', sessionId: 's1', target: { endpoint: 'https://push.example.net/phone', keys } });
    store.upsert({ account: 'u1', sessionId: 's1', target: { endpoint: 'https://push.example.net/phone-2', keys } });
    store.upsert({ account: 'u1', sessionId: 's2', target: { endpoint: 'https://push.example.net/laptop', keys } });
    app = new Hono<AuthEnv>()
      .use('*', async (c, next) => {
        c.set('principal', { kind: 'user', role: 'owner', user, sessionId: 's1' });
        await next();
      })
      .route('/', pushRoutes({ subscriptions: store, keys: () => vapid, available: () => true, beats: createPresenceBeats() }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const endpoints = () => store.list().map((row) => row.endpoint).sort();

  it('a DELETE with no body removes every subscription of the caller\'s own session, and nothing else', async () => {
    const answer = await app.request('/workspace/push/subscribe', { method: 'DELETE' });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ subscribed: false });
    expect(endpoints()).toEqual(['https://push.example.net/laptop']);
  });

  it('a DELETE naming an endpoint removes that one device', async () => {
    const answer = await app.request('/workspace/push/subscribe', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example.net/phone' }),
    });
    expect(answer.status).toBe(200);
    expect(endpoints()).toEqual(['https://push.example.net/laptop', 'https://push.example.net/phone-2']);
  });
});

describe('the presence beat route (spec 2026-10-24-mobile-cockpit §4)', () => {
  function presenceApp(sessionId: string | undefined, now: () => number) {
    const store = new PushSubscriptionStore(join(tmpdir(), 'cez-push-presence-unused.json'));
    const vapid = generateVapidKeys();
    const beats = createPresenceBeats(now);
    const app = new Hono<AuthEnv>()
      .use('*', async (c, next) => {
        c.set('principal', sessionId === undefined ? { kind: 'host' } as Principal : { kind: 'user', role: 'owner', user, sessionId });
        await next();
      })
      .route('/', pushRoutes({ subscriptions: store, keys: () => vapid, available: () => true, beats, now }));
    const beat = (tab: string, visible = true) => app.request('/workspace/push/presence', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visible, tab }),
    });
    return { beat, beats };
  }

  it('answers 429 past four beats a minute from one tab, and lets it beat again a minute later', async () => {
    let clock = 0;
    const { beat } = presenceApp('s1', () => clock);
    for (let i = 0; i < PRESENCE_BEATS_PER_MINUTE; i += 1) expect((await beat('tab-1')).status).toBe(200);
    expect((await beat('tab-1')).status).toBe(429);
    clock += 60_000;
    expect((await beat('tab-1')).status).toBe(200);
  });

  it('caps the tabs one caller may beat for, so minting tab ids is no way around the limit', async () => {
    const { beat } = presenceApp(undefined, () => 0);
    for (let i = 0; i < PRESENCE_TABS_PER_CALLER; i += 1) expect((await beat(`tab-${i}`)).status).toBe(200);
    expect((await beat('one-more')).status).toBe(429);
  });

  it.each(['', 'x'.repeat(65), 'has space', '../etc', 'tab\u0000', 'taß'])('refuses a tab that is not a bounded token: %j', async (tab) => {
    const { beat } = presenceApp('s1', () => 0);
    expect((await beat(tab)).status).toBe(400);
  });

  it('accepts the cockpit\'s own tab id, a UUID', async () => {
    const { beat, beats } = presenceApp('s1', () => 0);
    expect((await beat('3f0c2a9e-8b1d-4c7a-9e2f-1a2b3c4d5e6f')).status).toBe(200);
    expect(beats.visible('u1')).toBe(true);
  });
});
