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

/** The gate, pure: every subscription of every account with no visible cockpit tab, whose
 *  sign-in session (if it had one) is still alive. */
export function pushRecipients(
  rows: readonly StoredPushSubscription[],
  gate: { visible: (account: string) => boolean; sessionAlive: (sessionId: string) => boolean },
): { send: StoredPushSubscription[]; expired: StoredPushSubscription[] } {
  const send: StoredPushSubscription[] = [];
  const expired: StoredPushSubscription[] = [];
  for (const row of rows) {
    if (row.sessionId !== undefined && !gate.sessionAlive(row.sessionId)) expired.push(row);
    else if (!gate.visible(row.account)) send.push(row);
  }
  return { send, expired };
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
  /** Whether a cockpit tab of this account is visible right now (the `presence` topic). */
  visible: (account: string) => boolean;
  sessionAlive: (sessionId: string) => boolean;
  send?: (target: PushTarget, payload: PushPayload, keys: VapidKeys) => Promise<PushOutcome>;
}

export interface PushNotifier {
  /** Follow one project's runs; returns the detach. */
  watch(projectId: string, source: RunSource): () => void;
  /** Resolves once every push in flight has settled (tests). */
  idle(): Promise<void>;
}

export function createPushNotifier(deps: PushNotifierDeps): PushNotifier {
  const send = deps.send ?? sendWebPush;
  const inFlight = new Set<Promise<void>>();

  const deliver = (payload: PushPayload): void => {
    if (!deps.enabled()) return;
    const rows = deps.subscriptions.list();
    if (rows.length === 0) return;
    const { send: recipients, expired } = pushRecipients(rows, deps);
    const gone = new Set(expired.map((row) => row.id));
    if (recipients.length === 0 && gone.size === 0) return;
    const keys = deps.keys();
    const job = Promise.all(recipients.map(async (row) => {
      if ((await send({ endpoint: row.endpoint, keys: row.keys }, payload, keys)) === 'gone') gone.add(row.id);
    })).then(() => {
      if (gone.size === 0) return;
      try {
        deps.subscriptions.remove((row) => gone.has(row.id));
      } catch {
        // A read-only home keeps the dead rows; the next push drops them again.
      }
    }).catch(() => undefined);
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
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
        const now = keyOf(run);
        statuses.set(run.id, now);
        if (before === undefined || before === now) return;
        const label = pushLabelOf(run);
        if (label !== null) deliver(pushPayloadOf(projectId, run, label));
      };
      source.on('run', onRun);
      return () => source.off('run', onRun);
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
