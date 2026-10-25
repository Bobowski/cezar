import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { assertCezarHomeWriteIsSandboxed, pushSubscriptionsPath, pushVapidPath } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import { generateVapidKeys, type PushTarget, type VapidKeys } from './web-push.ts';

/**
 * Web Push state under `CEZ_HOME` (spec 2026-10-24-mobile-cockpit §3.5): written, never required.
 * The VAPID pair is generated on first use and kept; losing the file only means every device
 * subscribes again. A read-only home keeps the pair in memory for the process.
 */

const vapidSchema = z.object({
  publicKey: z.string().min(80),
  privateKey: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string(), d: z.string() }),
});

let vapidCache: { path: string; keys: VapidKeys } | undefined;

export function loadVapidKeys(path: string = pushVapidPath()): VapidKeys {
  if (vapidCache?.path === path) return vapidCache.keys;
  let keys: VapidKeys | undefined;
  try {
    keys = vapidSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    keys = generateVapidKeys();
    try {
      assertCezarHomeWriteIsSandboxed(path);
      atomicWriteJsonSync(path, keys);
    } catch (error) {
      console.warn(`[cez] could not save ${path} (${(error as Error).message}) — push subscriptions last until restart`);
    }
  }
  vapidCache = { path, keys };
  return keys;
}

/** Tests only. */
export function resetPushStateCache(): void {
  vapidCache = undefined;
}

const subscriptionSchema = z.object({
  id: z.string(),
  /** The account it belongs to: a user id, or `owner` on a cockpit without sign-in. */
  account: z.string(),
  /** The sign-in session that made it; a sign-out (or a revoked device) ends it. */
  sessionId: z.string().optional(),
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  createdAt: z.string(),
  /** The push service refused our VAPID key for it (401/403): never sent to again, and the
   *  device is asked to re-enable push. */
  stale: z.boolean().optional(),
}).passthrough();
export type StoredPushSubscription = z.infer<typeof subscriptionSchema>;

/** One unreadable row never evicts the rest. */
function readRows(path: string): StoredPushSubscription[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const rows = (raw as { subscriptions?: unknown } | null)?.subscriptions;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const parsed = subscriptionSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Devices one account may subscribe; a new one past this replaces the oldest. */
export const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 10;

export const subscriptionIdOf = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex').slice(0, 24);

export class PushSubscriptionStore {
  private readonly path: string;

  constructor(path: string = pushSubscriptionsPath()) {
    this.path = path;
  }

  list(): StoredPushSubscription[] {
    return readRows(this.path);
  }

  /** Read-modify-write; a failed write is the caller's to report. */
  private mutate(mutator: (rows: StoredPushSubscription[]) => StoredPushSubscription[]): void {
    const before = readRows(this.path);
    const after = mutator(before);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    assertCezarHomeWriteIsSandboxed(this.path);
    atomicWriteJsonSync(this.path, { subscriptions: after });
  }

  /** One row per endpoint: re-subscribing a device moves it to the account that asked last, and
   *  replaces the stale rows its sign-in session left behind. Without a session nothing tells
   *  devices apart, so only the endpoint itself is replaced — the cockpit drops the old one. */
  upsert(input: { account: string; sessionId?: string; target: PushTarget; now?: Date }): StoredPushSubscription {
    const row: StoredPushSubscription = {
      id: subscriptionIdOf(input.target.endpoint),
      account: input.account,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      endpoint: input.target.endpoint,
      keys: { p256dh: input.target.keys.p256dh, auth: input.target.keys.auth },
      createdAt: (input.now ?? new Date()).toISOString(),
    };
    const sameDevice = (existing: StoredPushSubscription) => row.sessionId !== undefined &&
      existing.stale === true && existing.account === row.account && existing.sessionId === row.sessionId;
    this.mutate((rows) => {
      const kept = rows.filter((existing) => existing.endpoint !== row.endpoint && !sameDevice(existing));
      const own = kept.filter((existing) => existing.account === row.account);
      const evict = new Set(own.slice(0, Math.max(0, own.length - (MAX_SUBSCRIPTIONS_PER_ACCOUNT - 1))));
      return [...kept.filter((existing) => !evict.has(existing)), row];
    });
    return row;
  }

  /** Flag rows the push service refused (`stale`); answers how many changed. */
  markStale(ids: ReadonlySet<string>): number {
    let marked = 0;
    this.mutate((rows) => rows.map((row) => {
      if (!ids.has(row.id) || row.stale === true) return row;
      marked += 1;
      return { ...row, stale: true };
    }));
    return marked;
  }

  /** Remove the matching rows; answers how many went. */
  remove(match: (row: StoredPushSubscription) => boolean): number {
    let removed = 0;
    this.mutate((rows) => rows.filter((row) => {
      if (!match(row)) return true;
      removed += 1;
      return false;
    }));
    return removed;
  }
}
