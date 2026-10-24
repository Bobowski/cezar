import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerLogFollowers, type DockerSpawn } from './docker-logs.ts';

const ID = 'a'.repeat(64);

function harness() {
  const spawned: Array<{ args: string[]; killed: boolean; data: (stream: 'out' | 'err', chunk: string) => void; exit: (reason: string | null) => void }> = [];
  const spawn: DockerSpawn = (args, on) => {
    const proc = { args, killed: false, ...on };
    spawned.push(proc);
    return { kill: () => { proc.killed = true; } };
  };
  let now = 1_000;
  const bells: number[] = [];
  const forgotten: string[] = [];
  const followers = new DockerLogFollowers(spawn, (_id, cursor) => bells.push(cursor), (id) => forgotten.push(id), {
    idleMs: 15_000, now: () => now, secrets: () => ['hunter2-super-secret-value'],
  });
  return { followers, spawned, bells, forgotten, advance: (ms: number) => { now += ms; } };
}

afterEach(() => vi.useRealTimers());

describe('docker logs followers (spec 2026-10-23-docker-management §3.4)', () => {
  it('starts on the first reader, redacts whole lines, and hands back output by cursor', () => {
    const { followers, spawned } = harness();
    expect(followers.read(ID, 0)).toMatchObject({ data: '', cursor: 0, following: true });
    expect(spawned[0]?.args).toEqual(['logs', '--tail', '500', '--follow', ID]);
    // A secret split across two chunks is still caught: only whole lines are redacted and kept.
    spawned[0]!.data('out', 'DATABASE_URL=postgres://u:hunter2-super');
    expect(followers.read(ID, 0).data).toBe('');
    spawned[0]!.data('out', '-secret-value@db/app\nready ghp_abcdefghijklmnopqrstuvwxyz123456\n');
    const first = followers.read(ID, 0);
    expect(first.data).toBe('DATABASE_URL=postgres://u:[REDACTED]@db/app\nready [REDACTED]\n');
    spawned[0]!.data('err', 'warn: slow\n');
    expect(followers.read(ID, first.cursor)).toMatchObject({ data: 'warn: slow\n', truncated: false });
  });

  it('is demand-driven: the last topic release kills the process, a returning reader resumes', () => {
    const { followers, spawned } = harness();
    followers.hold(ID);
    expect(spawned).toHaveLength(1);
    followers.hold(ID);
    expect(spawned).toHaveLength(1);
    spawned[0]!.data('out', 'one\n');
    followers.release(ID);
    expect(spawned[0]!.killed).toBe(false);
    followers.release(ID);
    expect(spawned[0]!.killed).toBe(true);
    expect(followers.running()).toEqual([]);
    // The pane comes back with its cursor: picked up from where it was cut, not replayed.
    const read = followers.read(ID, 4);
    expect(spawned[1]?.args.slice(0, 2)).toEqual(['logs', '--since']);
    expect(read).toMatchObject({ data: '', cursor: 4, following: true });
  });

  it('forgets a follower nobody holds or reads, and keeps one a poller still reads', () => {
    const { followers, spawned, forgotten, advance } = harness();
    followers.read(ID, 0);
    advance(10_000);
    followers.read(ID, 0);
    advance(10_000);
    followers.sweepIdle();
    expect(forgotten).toEqual([]);
    advance(6_000);
    followers.sweepIdle();
    expect(forgotten).toEqual([ID]);
    expect(spawned[0]!.killed).toBe(true);
    followers.close();
  });

  it('says so when Docker ends the stream, and does not restart it for a reader with a cursor', () => {
    const { followers, spawned } = harness();
    followers.read(ID, 0);
    spawned[0]!.data('out', 'bye\n');
    spawned[0]!.exit(null);
    const read = followers.read(ID, 0 + 4);
    expect(read).toMatchObject({ following: false, data: '' });
    expect(spawned).toHaveLength(1);
    // A pane opened again (cursor 0) starts a fresh tail.
    followers.read(ID, 0);
    expect(spawned).toHaveLength(2);
    followers.close();
  });

  it('rings the topic with a cursor, coalesced', () => {
    vi.useFakeTimers();
    const { followers, spawned, bells } = harness();
    followers.read(ID, 0);
    spawned[0]!.data('out', 'a\n');
    spawned[0]!.data('out', 'b\n');
    vi.advanceTimersByTime(250);
    expect(bells).toEqual([4]);
    followers.close();
  });
});
