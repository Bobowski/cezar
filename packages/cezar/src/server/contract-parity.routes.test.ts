import type { ExtractSchema } from 'hono/types';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { routeContracts } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * Every `response` in the route table (`packages/contract/src/routes.ts`) is the route's own 2xx
 * JSON body, both ways — the MCP catalog advertises it as the tool's output schema (spec
 * 2026-10-24-cezar-mcp-server §3), so a drifted entry would be a tool that lies. One generic
 * check instead of one line per route: a new entry is covered the moment it is written.
 */
describe('the route table\'s responses match the routes exactly', () => {
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Schema = ExtractSchema<AppType>;
  type Contracts = typeof routeContracts;
  type Endpoint<K> = K extends `${infer M} ${infer P}`
    ? `/api/v1${P}` extends keyof Schema
      ? `$${Lowercase<M>}` extends keyof Schema[`/api/v1${P}`]
        ? Schema[`/api/v1${P}`][`$${Lowercase<M>}`]
        : 'no-such-method'
      : 'no-such-path'
    : never;
  // A bare `c.json(x)` is typed with every status, so a 2xx is any status that ADMITS one.
  type Ok<E> = E extends { status: infer S; outputFormat: 'json'; output: infer O }
    ? 200 extends S ? O : 201 extends S ? O : 202 extends S ? O : never
    : never;
  type Check<K extends keyof Contracts> = Contracts[K] extends { response: infer R extends z.ZodType }
    ? Mutual<z.infer<R>, Ok<Endpoint<K>>>
    : true;
  type Failures = { [K in keyof Contracts]: Check<K> extends true ? never : [K, Check<K>] }[keyof Contracts];
  // On drift tsc names the routes: `'none'` is not assignable to `"GET /x" | …`.
  const failing: [Failures] extends [never] ? 'none' : Failures[0] = 'none';

  it('is enforced by tsc, not at runtime', () => {
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower, failing]).toEqual(['schema-is-wider', 'route-is-wider', 'none']);
  });
});
