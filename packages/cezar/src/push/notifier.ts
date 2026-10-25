import type { PushPayload } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { pushLabelOf, type AttentionRun } from './attention.ts';
import type { PushSubscriptionStore, StoredPushSubscription } from './state.ts';
import { sendWebPush, type PushOutcome, type PushTarget, type VapidKeys } from './web-push.ts';

/** Which runs push, and to whom (spec 2026-10-24-mobile-cockpit §3.5); `attention.ts` decides which. */
export { pushLabelOf };

/** Title and status only — never the prompt, a path or a diff (§5). */
export function pushPayloadOf(projectId: string, run: Pick<RunRecord, 'id' | 'title' | 'titleSummary'>, label: string): PushPayload {
  return {
    title: run.titleSummary ?? run.title,
    status: `Task ${label}`,
    url: `/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(run.id)}`,
    tag: `cezar-run-${run.id}`,
  };
}

/** The gate, pure: every live (not `stale`) subscription whose sign-in session (if it had one) is
 *  still alive — sent now when no cockpit tab of its account is visible, held otherwise. */
export function pushRecipients(
  rows: readonly StoredPushSubscription[],
  gate: { visible: (account: string) => boolean; sessionAlive: (sessionId: string) => boolean },
): { send: StoredPushSubscription[]; held: StoredPushSubscription[]; expired: StoredPushSubscription[] } {
  const send: StoredPushSubscription[] = [];
  const held: StoredPushSubscription[] = [];
  const expired: StoredPushSubscription[] = [];
  for (const row of rows) {
    if (row.sessionId !== undefined && !gate.sessionAlive(row.sessionId)) expired.push(row);
    else if (row.stale === true) continue;
    else if (gate.visible(row.account)) held.push(row);
    else send.push(row);
  }
  return { send, held, expired };
}

export interface RunSource {
  listRuns(): RunRecord[];
  on(event: 'run', listener: (run: RunRecord) => void): unknown;
  off(event: 'run', listener: (run: RunRecord) => void): unknown;
}

export interface PushNotifierDeps {
  subscriptions: PushSubscriptionStore;
  keys: () => VapidKeys;
  /** Whether push may go out at all: a hosted cockpit (§3.5). */
  enabled: () => boolean;
  /** Whether a cockpit tab of this account is visible right now (the `presence` topic or beat). */
  visible: (account: string) => boolean;
  sessionAlive: (sessionId: string) => boolean;
  send?: (target: PushTarget, payload: PushPayload, keys: VapidKeys) => Promise<PushOutcome>;
  /** The clock the per-account send budget and held pushes read (tests). */
  now?: () => number;
  /** How often held pushes look for their account's presence to end (tests). */
  presenceCheckMs?: number;
}

/** Pushes one account may get in `SEND_WINDOW_MS`; past it a transition is dropped, not queued. */
export const MAX_SENDS_PER_ACCOUNT = 60;
const SEND_WINDOW_MS = 3_600_000;
/** Pushes held per account while a tab is visible, one per run; the oldest goes past it. */
export const MAX_HELD_PER_ACCOUNT = 20;
/** A push held longer than this was seen on screen, not missed. */
const HELD_MAX_AGE_MS = 10 * 60_000;
const PRESENCE_CHECK_MS = 5_000;

interface Held {
  payload: PushPayload;
  /** False once the run left the state this push announces. */
  current: () => boolean;
  heldAt: number;
}

export interface PushNotifier {
  /** Follow one project's runs; returns the detach. */
  watch(projectId: string, source: RunSource): () => void;
  /** Resolves once every push in flight has settled (tests). */
  idle(): Promise<void>;
  /** Drop held pushes and stop looking for presence to end. */
  close(): void;
}

export function createPushNotifier(deps: PushNotifierDeps): PushNotifier {
  const send = deps.send ?? sendWebPush;
  const now = deps.now ?? Date.now;
  const inFlight = new Set<Promise<void>>();
  // Per account, when its last pushes went: a run flapping in and out of review cannot flood a phone.
  const sentAt = new Map<string, number[]>();
  const withinBudget = (account: string): boolean => {
    const at = now();
    const recent = (sentAt.get(account) ?? []).filter((t) => at - t < SEND_WINDOW_MS);
    if (recent.length >= MAX_SENDS_PER_ACCOUNT) {
      sentAt.set(account, recent);
      return false;
    }
    recent.push(at);
    sentAt.set(account, recent);
    return true;
  };

  const sendTo = (rows: readonly StoredPushSubscription[], payload: PushPayload, gone: Set<string>): void => {
    const budget = new Map<string, boolean>();
    const recipients = rows.filter((row) => {
      if (!budget.has(row.account)) budget.set(row.account, withinBudget(row.account));
      return budget.get(row.account);
    });
    if (recipients.length === 0 && gone.size === 0) return;
    const keys = deps.keys();
    const stale = new Set<string>();
    const job = Promise.all(recipients.map(async (row) => {
      const outcome = await send({ endpoint: row.endpoint, keys: row.keys }, payload, keys);
      if (outcome === 'gone') gone.add(row.id);
      else if (outcome === 'stale') stale.add(row.id);
    })).then(() => {
      try {
        if (gone.size > 0) deps.subscriptions.remove((row) => gone.has(row.id));
        if (stale.size > 0) deps.subscriptions.markStale(stale);
      } catch {
        // A read-only home keeps the rows as they were; the next push finds them again.
      }
    }).catch(() => undefined);
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
  };

  // A visible tab may be a frozen page still holding presence (#review 5): hold its account's
  // pushes, one per run, and send the ones still true once nothing of that account is on screen.
  const held = new Map<string, Held[]>();
  let checker: ReturnType<typeof setInterval> | undefined;
  const hold = (account: string, entry: Held): void => {
    const queue = (held.get(account) ?? []).filter((other) => other.payload.tag !== entry.payload.tag);
    queue.push(entry);
    held.set(account, queue.slice(-MAX_HELD_PER_ACCOUNT));
    if (checker === undefined) {
      checker = setInterval(releaseHeld, deps.presenceCheckMs ?? PRESENCE_CHECK_MS);
      checker.unref?.();
    }
  };
  function releaseHeld(): void {
    const at = now();
    for (const [account, queue] of held) {
      const fresh = queue.filter((entry) => at - entry.heldAt < HELD_MAX_AGE_MS && entry.current());
      if (fresh.length > 0 && deps.enabled() && deps.visible(account)) {
        held.set(account, fresh);
        continue;
      }
      held.delete(account);
      if (fresh.length === 0 || !deps.enabled()) continue;
      const { send: rows, expired } = pushRecipients(deps.subscriptions.list().filter((row) => row.account === account), deps);
      const gone = new Set(expired.map((row) => row.id));
      for (const entry of fresh) sendTo(rows, entry.payload, gone);
    }
    if (held.size === 0 && checker !== undefined) {
      clearInterval(checker);
      checker = undefined;
    }
  }

  const deliver = (payload: PushPayload, current: () => boolean): void => {
    if (!deps.enabled()) return;
    const rows = deps.subscriptions.list();
    if (rows.length === 0) return;
    const { send: recipients, held: waiting, expired } = pushRecipients(rows, deps);
    for (const account of new Set(waiting.map((row) => row.account))) hold(account, { payload, current, heldAt: now() });
    sendTo(recipients, payload, new Set(expired.map((row) => row.id)));
  };

  return {
    watch(projectId, source) {
      // Seeded from what is there: a run seen for the first time never pushes, and an unchanged
      // status never pushes again — the same two silences as the browser notification.
      const statuses = new Map<string, string>();
      const keyOf = (run: AttentionRun): string => `${run.status}:${pushLabelOf(run) ?? ''}`;
      for (const run of source.listRuns()) statuses.set(run.id, keyOf(run));
      const onRun = (run: RunRecord): void => {
        const before = statuses.get(run.id);
        const key = keyOf(run);
        statuses.set(run.id, key);
        if (before === undefined || before === key) return;
        const label = pushLabelOf(run);
        if (label !== null) deliver(pushPayloadOf(projectId, run, label), () => statuses.get(run.id) === key);
      };
      source.on('run', onRun);
      return () => source.off('run', onRun);
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    close() {
      held.clear();
      if (checker !== undefined) clearInterval(checker);
      checker = undefined;
    },
  };
}
