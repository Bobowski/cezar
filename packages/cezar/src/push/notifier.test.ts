import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { createPushNotifier, pushRecipients, type RunSource } from './notifier.ts';
import type { PushSubscriptionStore, StoredPushSubscription } from './state.ts';
import { generateVapidKeys } from './web-push.ts';

// `pushLabelOf` is held to the cockpit's `wantsAttention` in packages/web/src/lib/push-attention-parity.test.ts.
const base = { id: 'r1', title: 'Title', status: 'running' } as unknown as RunRecord;

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

  it('sends at most sixty pushes per account an hour', async () => {
    const { store } = fakeStore([row('a', 'alice'), row('b', 'bob')]);
    const sent: string[] = [];
    let now = 0;
    const notifier = createPushNotifier({
      subscriptions: store, keys: () => keys, enabled: () => true, visible: () => false, sessionAlive: () => true,
      now: () => now,
      send: async (target) => { sent.push(target.endpoint); return 'sent'; },
    });
    const run = { ...base } as RunRecord;
    const source = new FakeSource([run]);
    notifier.watch('proj', source);
    for (let i = 0; i < 70; i += 1) {
      source.emitRun({ ...run, status: 'running' } as RunRecord);
      source.emitRun({ ...run, status: 'review' } as RunRecord);
      now += 1_000;
    }
    await notifier.idle();
    expect(sent.filter((e) => e.endsWith('/a'))).toHaveLength(60);
    now += 3_600_000;
    source.emitRun({ ...run, status: 'running' } as RunRecord);
    source.emitRun({ ...run, status: 'waiting' } as RunRecord);
    await notifier.idle();
    expect(sent.filter((e) => e.endsWith('/a'))).toHaveLength(61);
  });

  describe('while a tab of the account is visible', () => {
    function heldNotifier(rows: StoredPushSubscription[]) {
      const { store } = fakeStore(rows);
      const sent: Array<{ endpoint: string; tag: string }> = [];
      const gate = { visible: true };
      const notifier = createPushNotifier({
        subscriptions: store, keys: () => keys, enabled: () => true, visible: () => gate.visible, sessionAlive: () => true,
        presenceCheckMs: 5,
        send: async (target, payload) => { sent.push({ endpoint: target.endpoint, tag: payload.tag }); return 'sent'; },
      });
      return { notifier, sent, gate };
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

    it('holds the push and sends it once presence ends — a frozen page that still looks visible loses nothing', async () => {
      const { notifier, sent, gate } = heldNotifier([row('a', 'owner')]);
      const run = { ...base } as RunRecord;
      const source = new FakeSource([run]);
      notifier.watch('proj', source);
      source.emitRun({ ...run, status: 'review' } as RunRecord);
      await settle();
      expect(sent).toEqual([]);
      gate.visible = false;
      await settle();
      await notifier.idle();
      expect(sent).toEqual([{ endpoint: 'https://push.example.net/a', tag: 'cezar-run-r1' }]);
      await settle();
      expect(sent).toHaveLength(1);
    });

    it('drops the held push when the run moved on before presence ended', async () => {
      const { notifier, sent, gate } = heldNotifier([row('a', 'owner')]);
      const run = { ...base } as RunRecord;
      const source = new FakeSource([run]);
      notifier.watch('proj', source);
      source.emitRun({ ...run, status: 'review' } as RunRecord);
      source.emitRun({ ...run, status: 'running' } as RunRecord);
      gate.visible = false;
      await settle();
      await notifier.idle();
      expect(sent).toEqual([]);
    });

    it('holds at most twenty per account, one per run', async () => {
      const { notifier, sent, gate } = heldNotifier([row('a', 'owner')]);
      const runs = Array.from({ length: 25 }, (_, i) => ({ ...base, id: `r${i}` }) as RunRecord);
      const source = new FakeSource(runs);
      notifier.watch('proj', source);
      for (const run of runs) source.emitRun({ ...run, status: 'review' } as RunRecord);
      source.emitRun({ ...runs[24]!, status: 'waiting' } as RunRecord);
      gate.visible = false;
      await settle();
      await notifier.idle();
      expect(sent).toHaveLength(20);
      expect(new Set(sent.map((s) => s.tag)).size).toBe(20);
      expect(sent.map((s) => s.tag)).not.toContain('cezar-run-r0');
    });
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
