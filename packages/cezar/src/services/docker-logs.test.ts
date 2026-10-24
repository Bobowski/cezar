import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerLogFollowers, type DockerSpawn } from './docker-logs.ts';

const ID = 'a'.repeat(64);

function harness(secrets: readonly string[] = ['hunter2-super-secret-value']) {
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
    idleMs: 15_000, now: () => now, secrets: () => secrets,
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

  it('keeps a secret whole across the cut of an over-long line', () => {
    const { followers, spawned } = harness();
    followers.read(ID, 0);
    // Past the 8 KiB line bound with a stored secret and a token shape each split across chunks.
    spawned[0]!.data('out', `${'x'.repeat(8190)}pw=hunter2-sup`);
    spawned[0]!.data('out', 'er-secret-value tok=ghp_abcdefghij');
    spawned[0]!.data('out', `klmnopqrstuvwxyz123456 ${'y'.repeat(9000)}`);
    spawned[0]!.data('out', ' end\n');
    const data = followers.read(ID, 0).data;
    expect(data).not.toContain('hunter2');
    expect(data).not.toContain('ghp_');
    expect(data.endsWith('pw=[REDACTED] tok=[REDACTED] ' + 'y'.repeat(9000) + ' end\n')).toBe(true);
  });

  it('cuts a line that never ends at 32 KiB and drops the rest of it, so memory stays bounded', () => {
    const { followers, spawned } = harness();
    followers.read(ID, 0);
    spawned[0]!.data('out', 'z'.repeat(20_000));
    expect(followers.read(ID, 0).data).toBe('');
    spawned[0]!.data('out', 'z'.repeat(20_000));
    spawned[0]!.data('out', 'z'.repeat(50_000));
    spawned[0]!.data('out', 'zz\nnext\n');
    expect(followers.read(ID, 0).data).toBe(`${'z'.repeat(32 * 1024)} … [line cut at 32 KiB]\nnext\n`);
  });

  it('never lets a secret out of a pipe read past 32 KiB that ends mid-secret', () => {
    const { followers, spawned } = harness();
    followers.read(ID, 0);
    // A 40 KB read with no newline, ending inside a stored secret; the secret's rest comes next.
    spawned[0]!.data('out', `${'x'.repeat(40_000 - 14)}pw=hunter2-sup`);
    spawned[0]!.data('out', 'er-secret-value tail\nnext\n');
    const data = followers.read(ID, 0).data;
    expect(data).not.toContain('hunter2');
    expect(data).not.toContain('er-secret-value');
    expect(data).toBe(`${'x'.repeat(32 * 1024)} … [line cut at 32 KiB]\nnext\n`);
  });

  it('never lets a secret out of a single 64 KB read, whole line or not', () => {
    const { followers, spawned } = harness();
    followers.read(ID, 0);
    spawned[0]!.data('out', `${'x'.repeat(64 * 1024 - 11)}hunter2-sup`);
    spawned[0]!.data('out', 'er-secret-value\n');
    // A whole 64 KB line in one read is redacted first, then cut: a secret across the cut is gone.
    spawned[0]!.data('out', `${'y'.repeat(32 * 1024 - 5)}hunter2-super-secret-value${'y'.repeat(32 * 1024)}\n`);
    const data = followers.read(ID, 0).data;
    expect(data).not.toContain('hunter2');
    expect(data).not.toContain('er-secret-value');
    expect(data.split('\n')).toEqual([
      `${'x'.repeat(32 * 1024)} … [line cut at 32 KiB]`,
      `${'y'.repeat(32 * 1024 - 5)}[REDA … [line cut at 32 KiB]`,
      '',
    ]);
  });

  it('redacts a multi-line secret (a PEM) that line ends and reads split', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n-----END PRIVATE KEY-----';
    const { followers, spawned } = harness([pem]);
    followers.read(ID, 0);
    spawned[0]!.data('out', 'boot\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcw');
    spawned[0]!.data('out', 'ggSjAgEAAoIBAQC7VJTUt9Us8cKj\n');
    expect(followers.read(ID, 0).data).toBe('boot\n');
    spawned[0]!.data('out', '-----END PRIVATE KEY-----\nok\n');
    // A held prefix that turns out not to be the secret goes out as it was.
    spawned[0]!.data('out', '-----BEGIN PRIVATE KEY-----\nnot it\n');
    expect(followers.read(ID, 0).data).toBe('boot\n[REDACTED]\nok\n-----BEGIN PRIVATE KEY-----\nnot it\n');
  });

  it('keeps a line under the cap whole and redacts a secret its read ended inside', () => {
    const { followers, spawned } = harness();
    followers.read(ID, 0);
    spawned[0]!.data('out', `${'x'.repeat(20_000)}pw=hunter2-sup`);
    spawned[0]!.data('out', 'er-secret-value tail\n');
    expect(followers.read(ID, 0).data).toBe(`${'x'.repeat(20_000)}pw=[REDACTED] tail\n`);
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

  describe('held bytes never outlive their follower', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nSECRETBODYLINE2abcdefghijklmnop\n-----END PRIVATE KEY-----';
    const pw = 'Zq8!rT2#vLp9@xWm4$kN7';

    it('drops a partial line a release cut off instead of joining it to the next follower', () => {
      const { followers, spawned } = harness([pem, pw]);
      followers.hold(ID);
      spawned[0]!.data('out', `DB=${pw.slice(0, 16)}`);
      followers.release(ID);
      followers.hold(ID);
      spawned[1]!.data('out', 'next line\n');
      expect(followers.read(ID, 0).data).toBe('next line\n');
    });

    it('drops a half-held PEM a release cut off', () => {
      const { followers, spawned } = harness([pem, pw]);
      followers.hold(ID);
      const lines = pem.split('\n');
      spawned[0]!.data('out', `${lines[0]}\n${lines[1]}\n`);
      followers.release(ID);
      followers.hold(ID);
      spawned[1]!.data('out', 'after restart\n');
      expect(followers.read(ID, 0).data).toBe('after restart\n');
    });

    it('does not flush a half-held PEM when Docker ends the stream', () => {
      const { followers, spawned } = harness([pem, pw]);
      followers.read(ID, 0);
      const lines = pem.split('\n');
      spawned[0]!.data('out', `boot\n${lines[0]}\n${lines[1]}\n`);
      expect(followers.read(ID, 0).data).toBe('boot\n');
      spawned[0]!.exit(null);
      expect(followers.read(ID, 5)).toMatchObject({ data: '', following: false });
    });
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
