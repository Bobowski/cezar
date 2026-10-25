import { Hono, type Context } from 'hono';
import { pushPresenceInputSchema, pushSubscribeInputSchema, pushUnsubscribeInputSchema, type WorkspacePushState } from '@open-mercato/cezar-contract';
import { principalOf, type AuthEnv, type Principal } from '../auth/guard.ts';
import { jsonZodValidator } from '../server/validators.ts';
import type { PresenceBeats } from './presence.ts';
import type { PushSubscriptionStore } from './state.ts';
import type { VapidKeys } from './web-push.ts';

/**
 * `/api/v1/workspace/push*` (spec 2026-10-24-mobile-cockpit §4): workspace-level, behind sign-in.
 * A subscription belongs to the account that made it and to the sign-in session it came from, so
 * signing that device out ends it.
 */

/** The account push is addressed to, or null for a caller that is not a person (a task's token). */
export function pushAccountOf(principal: Principal | undefined): { account: string; sessionId?: string } | null {
  if (principal === undefined || principal.kind === 'host') return { account: 'owner' };
  if (principal.kind === 'run') return null;
  if (principal.kind === 'user') return { account: principal.user.id, sessionId: principal.sessionId };
  return { account: principal.user.id };
}

/** The WS topic a cockpit tab holds while its page is visible; it carries no data. */
export const PRESENCE_TOPIC = 'presence';

const UNAVAILABLE ='push notifications need a hosted cockpit served over HTTPS';
const NOT_A_PERSON = 'push subscriptions belong to a signed-in person';

export function pushRoutes(deps: {
  subscriptions: PushSubscriptionStore;
  keys: () => VapidKeys;
  available: () => boolean;
  beats: PresenceBeats;
}) {
  const stateFor = (c: Context): WorkspacePushState => {
    const available = deps.available();
    const who = pushAccountOf(principalOf(c));
    const mine = available && who !== null
      ? deps.subscriptions.list().filter((row) =>
        row.account === who.account && (who.sessionId === undefined || row.sessionId === who.sessionId))
      : [];
    const subscribed = mine.some((row) => row.stale !== true);
    const stale = !subscribed && mine.some((row) => row.stale === true);
    return { available, publicKey: available ? deps.keys().publicKey : null, subscribed, stale };
  };

  return new Hono<AuthEnv>()
    .get('/workspace/push', (c) => {
      c.header('cache-control', 'no-store');
      return c.json(stateFor(c));
    })
    .post('/workspace/push/subscribe', jsonZodValidator(pushSubscribeInputSchema), (c) => {
      if (!deps.available()) return c.json({ error: UNAVAILABLE }, 409);
      const who = pushAccountOf(principalOf(c));
      if (who === null) return c.json({ error: NOT_A_PERSON }, 409);
      const body = c.req.valid('json');
      try {
        deps.subscriptions.upsert({ ...who, target: { endpoint: body.endpoint, keys: body.keys } });
      } catch {
        return c.json({ error: 'could not save the subscription — the cezar home is not writable' }, 409);
      }
      return c.json(stateFor(c));
    })
    .post('/workspace/push/presence', jsonZodValidator(pushPresenceInputSchema), (c) => {
      const who = pushAccountOf(principalOf(c));
      if (who === null) return c.json({ error: NOT_A_PERSON }, 409);
      const { visible, tab } = c.req.valid('json');
      deps.beats.beat(who.account, tab, visible);
      return c.json({ ok: true as const });
    })
    .delete('/workspace/push/subscribe', jsonZodValidator(pushUnsubscribeInputSchema), (c) => {
      const who = pushAccountOf(principalOf(c));
      if (who === null) return c.json({ error: NOT_A_PERSON }, 409);
      const { endpoint } = c.req.valid('json');
      try {
        deps.subscriptions.remove((row) => row.account === who.account && (endpoint !== undefined
          ? row.endpoint === endpoint
          : who.sessionId !== undefined && row.sessionId === who.sessionId));
      } catch {
        return c.json({ error: 'could not remove the subscription — the cezar home is not writable' }, 409);
      }
      return c.json(stateFor(c));
    });
}
