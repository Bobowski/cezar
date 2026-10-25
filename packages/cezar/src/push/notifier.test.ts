import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
// Test-only reach into the cockpit: the server's push gate must answer exactly what the browser
// notification's `wantsAttention` answers (spec 2026-10-24-mobile-cockpit §3.5).
import { deriveAttention, wantsAttention } from '../../../web/src/lib/attention.ts';
import { createPushNotifier, pushLabelOf, pushRecipients, type RunSource } from './notifier.ts';
import type { PushSubscriptionStore, StoredPushSubscription } from './state.ts';
import { generateVapidKeys } from './web-push.ts';

const base = { id: 'r1', title: 'Title', status: 'running' } as unknown as RunRecord;
const variants: Array<Partial<RunRecord>> = [
  { status: 'queued' }, { status: 'running' }, { status: 'running', activity: 'monitoring' } as Partial<RunRecord>,
  { status: 'waiting' }, { status: 'review' }, { status: 'done' }, { status: 'failed' }, { status: 'cancelled' },
  { status: 'failed', autoResumeAt: '2026-10-25T00:00:00Z' } as Partial<RunRecord>,
  { status: 'failed', awaitingAnswerSince: '2026-10-25T00:00:00Z' } as Partial<RunRecord>,
  { status: 'waiting', dispatch: { overBudget: true, budgetUsd: 2 } } as Partial<RunRecord>,
  { status: 'done', worktreeLifecycle: { needsAttention: true, phase: 'cleanup' } } as Partial<RunRecord>,
  { status: 'review', worktreeLifecycle: { activeOperationId: 'op', phase: 'setup' } } as Partial<RunRecord>,
];

describe('pushLabelOf — the server twin of wantsAttention', () => {
  it.each(variants.map((variant) => [JSON.stringify(variant), variant]))('%s', (_name, variant) => {
    const run = { ...base, ...variant } as RunRecord;
    const label = pushLabelOf(run);
    expect(label !== null).toBe(wantsAttention(run as never));
    if (label !== null) expect(label).toBe(deriveAttention(run as never).label);
  });
});

const row = (id: string, account: string, sessionId?: string): StoredPushSubscription => ({
  id, account, ...(sessionId ? { sessionId } : {}), endpoint: `https://push.example.net/${id}`, keys: { p256dh: 'p', auth: 'a' }, createdAt: '',
});

describe('pushRecipients', () => {
  it('skips an account with a visible tab, and expires a subscription whose session ended', () => {
    const rows = [row('a', 'alice', 's1'), row('b', 'bob'), row('c', 'alice', 'gone')];
    const result = pushRecipients(rows, { visible: (account) => account === 'bob', sessionAlive: (id) => id !== 'gone' });
    expect(result.send.map((r) => r.id)).toEqual(['a']);
    expect(result.expired.map((r) => r.id)).toEqual(['c']);
  });
});

class FakeSource extends EventEmitter implements RunSource {
  constructor(private readonly runs: RunRecord[]) {
    super();
  }
  listRuns(): RunRecord[] {
    return this.runs;
  }
  emitRun(run: RunRecord): void {
    this.emit('run', run);
  }
}

function fakeStore(rows: StoredPushSubscription[]) {
  const removed: string[] = [];
  const store = {
    list: () => rows.filter((r) => !removed.includes(r.id)),
    remove: (match: (r: StoredPushSubscription) => boolean) => {
      for (const r of rows) if (match(r)) removed.push(r.id);
      return removed.length;
    },
  } as unknown as PushSubscriptionStore;
  return { store, removed };
}

describe('createPushNotifier', () => {
  const keys = generateVapidKeys();

  it('never pushes a run on first sight or for an unchanged status, and drops a gone subscription', async () => {
    const { store, removed } = fakeStore([row('a', 'owner'), row('b', 'owner')]);
    const sent: string[] = [];
    const notifier = createPushNotifier({
      subscriptions: store, keys: () => keys, enabled: () => true, visible: () => false, sessionAlive: () => true,
      send: async (target) => {
        sent.push(target.endpoint);
        return target.endpoint.endsWith('/b') ? 'gone' : 'sent';
      },
    });
    const seeded = { ...base, id: 'seeded', status: 'waiting' } as RunRecord;
    const source = new FakeSource([seeded]);
    const detach = notifier.watch('proj', source);
    source.emitRun(seeded); // unchanged
    source.emitRun({ ...base, id: 'new', status: 'review' } as RunRecord); // first sight
    expect(sent).toEqual([]);
    source.emitRun({ ...seeded, status: 'review' } as RunRecord);
    await notifier.idle();
    expect(sent.sort()).toEqual(['https://push.example.net/a', 'https://push.example.net/b']);
    expect(removed).toEqual(['b']);
    detach();
    source.emitRun({ ...seeded, status: 'failed' } as RunRecord);
    await notifier.idle();
    expect(sent).toHaveLength(2);
  });

  it('sends nothing while disabled (a local cockpit)', async () => {
    const { store } = fakeStore([row('a', 'owner')]);
    const sent: string[] = [];
    const notifier = createPushNotifier({
      subscriptions: store, keys: () => keys, enabled: () => false, visible: () => false, sessionAlive: () => true,
      send: async (target) => { sent.push(target.endpoint); return 'sent'; },
    });
    const run = { ...base } as RunRecord;
    const source = new FakeSource([run]);
    notifier.watch('proj', source);
    source.emitRun({ ...run, status: 'waiting' } as RunRecord);
    await notifier.idle();
    expect(sent).toEqual([]);
  });
});
