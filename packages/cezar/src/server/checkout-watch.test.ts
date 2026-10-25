import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHURN_MUTE_MS,
  CHURN_STREAK,
  CLASSIFY_TTL_MS,
  POLL_INTERVAL_MS,
  classifyPaths,
  createChurnFilter,
  pollCheckout,
  statusFingerprint,
  watchCheckout,
  type ClassifyPaths,
  type PathFacts,
} from './checkout-watch.ts';

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

describe('watchCheckout (macOS, Windows)', () => {
  /** A fake recursive watch whose events the test fires. */
  function harness(facts: Record<string, Partial<PathFacts>>, start = 10_000_000) {
    let emit: (filename: string | null) => void = () => {};
    const open = ((_root: string, _options: unknown, listener: (event: string, filename: string | null) => void) => {
      emit = (filename) => listener('change', filename);
      return { on: () => {}, close: () => {} };
    }) as unknown as typeof import('node:fs').watch;
    const classify = vi.fn<ClassifyPaths>(async (_root, paths) =>
      new Map(paths.map((path) => [path, { ignored: false, tracked: true, ...facts[path] }])),
    );
    let clock = start;
    const changed = vi.fn();
    const stop = watchCheckout('/repo', changed, { open, classify, now: () => clock });
    /** One write at `path`, then the debounce and git's answer. */
    const write = async (path: string | null, advance = 300) => {
      emit(path);
      clock += advance;
      await vi.advanceTimersByTimeAsync(advance);
    };
    return { write, classify, changed, stop, tick: (ms: number) => (clock += ms) };
  }

  it('a path git ignores never rings; one it does not, does — asked once a minute, not per write', async () => {
    vi.useFakeTimers();
    const h = harness({ 'logs/dev.log': { ignored: true, tracked: false } });
    await h.write('logs\\dev.log');
    await h.write('logs/dev.log');
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.classify.mock.calls[0]![1]).toEqual(['logs/dev.log']);
    await h.write('src/app.tsx');
    expect(h.changed).toHaveBeenCalledTimes(1);
    h.tick(CLASSIFY_TTL_MS + 1);
    await h.write('logs/dev.log');
    expect(h.classify).toHaveBeenCalledTimes(3);
    expect(h.changed).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it(`mutes an untracked path that moved in ${CHURN_STREAK} windows in a row; a tracked edit still rings`, async () => {
    vi.useFakeTimers();
    const h = harness({ 'dev.sqlite': { tracked: false } }, POLL_INTERVAL_MS * 1_000);
    for (let window = 0; window < CHURN_STREAK - 1; window += 1) await h.write('dev.sqlite', POLL_INTERVAL_MS);
    expect(h.changed).toHaveBeenCalledTimes(CHURN_STREAK - 1);
    await h.write('dev.sqlite', POLL_INTERVAL_MS);
    await h.write('dev.sqlite', POLL_INTERVAL_MS);
    expect(h.changed).toHaveBeenCalledTimes(CHURN_STREAK - 1);
    await h.write('index.html', POLL_INTERVAL_MS);
    expect(h.changed).toHaveBeenCalledTimes(CHURN_STREAK);
    // A tracked file that keeps moving is someone's edit: the poll never mutes one either.
    for (let window = 0; window < CHURN_STREAK + 1; window += 1) await h.write('index.html', POLL_INTERVAL_MS);
    expect(h.changed).toHaveBeenCalledTimes(CHURN_STREAK * 2 + 1);
    // Five minutes on, the churning file counts again.
    h.tick(CHURN_MUTE_MS);
    await h.write('dev.sqlite', POLL_INTERVAL_MS);
    expect(h.changed).toHaveBeenCalledTimes(CHURN_STREAK * 2 + 2);
    h.stop();
  });

  it('an event without a name still rings, and nothing rings after the stop', async () => {
    vi.useFakeTimers();
    const h = harness({});
    await h.write(null);
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.classify).not.toHaveBeenCalled();
    h.stop();
    await h.write('src/app.tsx');
    expect(h.changed).toHaveBeenCalledTimes(1);
  });
});

describe('classifyPaths', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('asks git which paths are ignored and which are tracked', async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-watch-classify-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(root, '.gitignore'), '*.log\n');
    writeFileSync(join(root, 'index.html'), '<p>x</p>');
    git('add', '.');
    writeFileSync(join(root, 'dev.log'), 'x');
    writeFileSync(join(root, 'new [1].txt'), 'x');
    const facts = await classifyPaths(root, ['dev.log', 'index.html', 'new [1].txt']);
    expect(facts.get('dev.log')).toEqual({ ignored: true, tracked: false });
    expect(facts.get('index.html')).toEqual({ ignored: false, tracked: true });
    expect(facts.get('new [1].txt')).toEqual({ ignored: false, tracked: false });
  });
});
