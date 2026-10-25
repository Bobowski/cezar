import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pollCheckout, statusFingerprint } from './checkout-watch.ts';

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

  it('is null outside a repository', async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-poll-none-'));
    expect(await statusFingerprint(join(root, 'missing'))).toBeNull();
  });
});
