import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { automationWebhookResponseSchema, hookDeliveryResponseSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * The webhook wake-up's routes (spec 2026-10-23-github-events §4) answer EXACTLY their contract
 * schemas, both directions — the guard `contract-parity.automations.test.ts` explains.
 * Compile-time; `npm run typecheck` enforces it.
 */
describe('webhook wake-up schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Assert<T extends true> = T;
  type Webhook = z.infer<typeof automationWebhookResponseSchema>;

  type Get200 = InferResponseType<(typeof client.api.v1)['automation-webhook']['$get'], 200>;
  type Post200 = InferResponseType<(typeof client.api.v1)['automation-webhook']['$post'], 200>;
  type Delete200 = InferResponseType<(typeof client.api.v1)['automation-webhook']['$delete'], 200>;
  type Ping200 = InferResponseType<(typeof client.api.v1)['automation-webhook']['ping']['$post'], 200>;
  type ScopedGet200 = InferResponseType<(typeof client.api.v1.p)[':projectId']['automation-webhook']['$get'], 200>;
  type Hook202 = InferResponseType<(typeof client.api.v1.hooks)[':sender'][':hookId']['$post'], 202>;

  type _get = Assert<Mutual<Webhook, Get200>>;
  type _post = Assert<Mutual<Webhook, Post200>>;
  type _delete = Assert<Mutual<Webhook, Delete200>>;
  type _ping = Assert<Mutual<Webhook, Ping200>>;
  type _scoped = Assert<Mutual<Webhook, ScopedGet200>>;
  type _hook = Assert<Mutual<z.infer<typeof hookDeliveryResponseSchema>, Hook202>>;

  it('is checked at compile time', () => {
    expect(true).toBe(true);
  });
});
