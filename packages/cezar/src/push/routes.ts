import { Hono, type Context } from 'hono';
import {
  pushPresenceInputSchema,
  pushSubscribeInputSchema,
  pushUnsubscribeInputSchema,
  workspacePushQuerySchema,
  type WorkspacePushState,
} from '@open-mercato/cezar-contract';
import { principalOf, type AuthEnv, type Principal } from '../auth/guard.ts';
import { jsonZodValidator, queryZodValidator } from '../server/validators.ts';
import type { PresenceBeats } from './presence.ts';
import { subscriptionIdOf, type PushSubscriptionStore } from './state.ts';
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

/** Beats one tab may send a minute: its 30 s beat plus a few visibility flips. */
export const PRESENCE_BEATS_PER_MINUTE = 4;
/** Tabs one caller (its sign-in session, else its browser's push device id, else the account) may
 *  beat for in a minute; every reload is a new tab. */
export const PRESENCE_TABS_PER_CALLER = 20;
const PRESENCE_WINDOW_MS = 60_000;

/** A refused beat only means push may hold a little longer; it is never queued. */
function presenceLimiter(now: () => number) {
  const byCaller = new Map<string, Map<string, number[]>>();
  return (caller: string, tab: string): boolean => {
    const at = now();
    const tabs = byCaller.get(caller) ?? new Map<string, number[]>();
    for (const [id, times] of tabs) {
      const recent = times.filter((t) => at - t < PRESENCE_WINDOW_MS);
      if (recent.length > 0) tabs.set(id, recent);
      else tabs.delete(id);
    }
    const times = tabs.get(tab);
    const allowed = times !== undefined ? times.length < PRESENCE_BEATS_PER_MINUTE : tabs.size < PRESENCE_TABS_PER_CALLER;
    if (allowed) tabs.set(tab, [...(times ?? []), at]);
    if (tabs.size > 0) byCaller.set(caller, tabs);
    else byCaller.delete(caller);
    return allowed;
  };
}

export function pushRoutes(deps: {
  subscriptions: PushSubscriptionStore;
  keys: () => VapidKeys;
  available: () => boolean;
  beats: PresenceBeats;
  /** The presence rate limit's clock (tests). */
  now?: () => number;
}) {
  const presenceAllowed = presenceLimiter(deps.now ?? Date.now);
  // `device` (a subscription id) narrows the answer to one browser; without it a sign-in session
  // still names the device, but owner mode cannot, so it reports no stale hint (#review 4).
  const stateFor = (c: Context, device?: string): WorkspacePushState => {
    const available = deps.available();
    const who = pushAccountOf(principalOf(c));
    const mine = available && who !== null
      ? deps.subscriptions.list().filter((row) =>
        row.account === who.account && (who.sessionId === undefined || row.sessionId === who.sessionId) &&
        (device === undefined || row.id === device))
      : [];
    const subscribed = mine.some((row) => row.stale !== true);
    const perDevice = device !== undefined || who?.sessionId !== undefined;
    const stale = perDevice && !subscribed && mine.some((row) => row.stale === true);
    return { available, publicKey: available ? deps.keys().publicKey : null, subscribed, stale };
  };

  return new Hono<AuthEnv>()
    .get('/workspace/push', queryZodValidator(workspacePushQuerySchema), (c) => {
      c.header('cache-control', 'no-store');
      return c.json(stateFor(c, c.req.valid('query').device));
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
      return c.json(stateFor(c, subscriptionIdOf(body.endpoint)));
    })
    .post('/workspace/push/presence', jsonZodValidator(pushPresenceInputSchema), (c) => {
      const who = pushAccountOf(principalOf(c));
      if (who === null) return c.json({ error: NOT_A_PERSON }, 409);
      const { visible, tab, device } = c.req.valid('json');
      // Without sign-in every browser is `owner`: its device id keeps one reloading browser from
      // exhausting the cap for the phone that gets the push.
      const caller = who.sessionId !== undefined ? `s:${who.sessionId}` : device !== undefined ? `d:${device}` : '';
      if (!presenceAllowed(`${who.account}\0${caller}`, tab)) {
        c.header('retry-after', '60');
        return c.json({ error: 'too many presence beats — try again in a minute' }, 429);
      }
      deps.beats.beat(who.account, tab, visible);
      return c.json({ ok: true as const });
    })
    // No body is "this device": every subscription of the caller's own sign-in session.
    .delete('/workspace/push/subscribe', jsonZodValidator(pushUnsubscribeInputSchema, { absent: {} }), (c) => {
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
      return c.json(stateFor(c, endpoint !== undefined ? subscriptionIdOf(endpoint) : undefined));
    });
}
