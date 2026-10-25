import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHURN_MUTE_MS, CHURN_STREAK, createChurnFilter, pollCheckout, statusFingerprint } from './checkout-watch.ts';

/** The polling bell (spec 2026-10-24-cockpit-polish §3.2): where Linux refuses the watch. */

afterEach(() => {
  vi.useRealTimers();
});

describe('pollCheckout', () => {
  it('takes the first look as the baseline, rings when the fingerprint moves, and stops', async () => {
    vi.useFakeTimers();
    const prints = ['a', 'a', 'b', 'b', 'c'];
    const fingerprint = vi.fn(async () => prints.shift() ?? 'c');
    const changed = vi.fn();
    const stop = pollCheckout('/repo', changed, { intervalMs: 100, fingerprint });
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    const looks = fingerprint.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fingerprint.mock.calls.length).toBe(looks);
  });

  it('a look git could not answer neither rings nor resets the baseline', async () => {
    vi.useFakeTimers();
    const prints: Array<string | null> = ['a', null, 'a', 'b'];
    const changed = vi.fn();
    const stop = pollCheckout('/repo', changed, { intervalMs: 50, fingerprint: async () => (prints.length > 0 ? prints.shift()! : 'b') });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('createChurnFilter', () => {
  it(`mutes a path after ${CHURN_STREAK} moves in a row, a still look resets the streak`, () => {
    let clock = 0;
    const filter = createChurnFilter(() => clock);
    const look = (sig: string) => filter.look(new Map([['db.sqlite', sig]])).has('db.sqlite');
    expect([look('a'), look('b'), look('b'), look('c'), look('d')]).toEqual([false, false, false, false, false]);
    expect(look('e')).toBe(true);
    clock += CHURN_MUTE_MS - 1;
    expect(look('f')).toBe(true);
    clock += 1;
    expect(look('g')).toBe(false);
  });

  it('forgets a path that left the status', () => {
    const filter = createChurnFilter(() => 0);
    for (const sig of ['a', 'b', 'c']) filter.look(new Map([['x', sig]]));
    filter.look(new Map());
    expect(filter.look(new Map([['x', 'd']])).has('x')).toBe(false);
  });
});

describe('statusFingerprint', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('moves on a new file, and again on a second edit to a file that was already changed', async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-poll-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init', '-q');
    const before = await statusFingerprint(root);
    expect(before).not.toBeNull();
    writeFileSync(join(root, 'index.html'), '<p>one</p>');
    const added = await statusFingerprint(root);
    expect(added).not.toBe(before);
    writeFileSync(join(root, 'index.html'), '<p>one, then two</p>');
    utimesSync(join(root, 'index.html'), new Date(), new Date(Date.now() + 5_000));
    expect(await statusFingerprint(root)).not.toBe(added);
  });

  it('looks without optional locks, so it never races the agent for index.lock', async () => {
    let seen: { env?: NodeJS.ProcessEnv } | undefined;
    const run = ((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }, done: (error: Error | null, stdout: string) => void) => {
      seen = options;
      done(null, '');
    }) as unknown as typeof execFile;
    expect(await statusFingerprint('/repo', run)).not.toBeNull();
    expect(seen?.env?.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(seen?.env?.PATH ?? seen?.env?.Path).toBe(process.env.PATH ?? process.env.Path);
  });

  it('mutes an untracked file that moves on every look, and only for five minutes', async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-poll-churn-'));
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    let clock = 1_000_000;
    const churn = createChurnFilter(() => clock);
    let tick = 0;
    const look = async (touchLog = true) => {
      tick += 1;
      if (touchLog) {
        writeFileSync(join(root, 'dev.log'), 'x'.repeat(tick));
        utimesSync(join(root, 'dev.log'), new Date(), new Date(Date.now() + tick * 1_000));
      }
      clock += 2_000;
      return statusFingerprint(root, execFile, churn);
    };
    const prints = [await look(), await look(), await look(), await look()];
    // Moves on looks 2 and 3, is muted on the third move (look 4) — then holds still.
    expect(new Set(prints).size).toBe(4);
    const quiet = [await look(), await look(), await look()];
    expect(new Set([prints[3], ...quiet]).size).toBe(1);
    // A real edit still rings while the churn is muted.
    writeFileSync(join(root, 'index.html'), '<p>edit</p>');
    const edited = await look();
    expect(edited).not.toBe(quiet[2]);
    // Five minutes on, the log counts again.
    clock += CHURN_MUTE_MS;
    expect(await look()).not.toBe(edited);
  });

  it('is null outside a repository', async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-poll-none-'));
    expect(await statusFingerprint(join(root, 'missing'))).toBeNull();
  });
});
