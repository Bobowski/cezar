import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { MAX_STUCK_SNAPSHOT_READS, foregroundCommand, freshSnapshotReader, hasForeground, parseProcessRows, tidyCommand } from './foreground.ts';

/** A `ps -axo pid=,ppid=,command=` sample: a shell (900) running `npm run dev`, which has its
 *  own child, plus an unrelated process to prove the walk does not wander. */
const PS = `
  900   1 /bin/zsh -il
  901 900 npm run dev
  902 901 node /repo/node_modules/.bin/vite
  950   1 /usr/bin/unrelated --daemon
`;

describe('parseProcessRows', () => {
  it('keeps the whole command line, arguments and all', () => {
    const rows = parseProcessRows(PS);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual({ pid: 901, ppid: 900, command: 'npm run dev' });
  });

  it('skips rows ps truncated mid-exit', () => {
    expect(parseProcessRows('  900\n  not a row\n  901 900 npm run dev\n')).toEqual([
      { pid: 901, ppid: 900, command: 'npm run dev' },
    ]);
  });

  it('has nothing to say about empty output — a host with no readable table', () => {
    expect(parseProcessRows('')).toEqual([]);
  });
});

describe('foregroundCommand', () => {
  const rows = parseProcessRows(PS);

  it('names the tab after what the user typed, not the leaf process', () => {
    // `npm run dev`, not `node …/vite`: the first generation is the recognisable one.
    expect(foregroundCommand(rows, 900)).toBe('npm run dev');
  });

  it('is null at an idle prompt', () => {
    expect(foregroundCommand(rows, 902)).toBeNull();
  });

  it('never attributes an unrelated process to a shell', () => {
    expect(foregroundCommand(rows, 999)).toBeNull();
  });
});

describe('hasForeground', () => {
  const rows = parseProcessRows(PS);

  it('is the same reading the tab name comes from, so the two cannot disagree', () => {
    expect(hasForeground(rows, 900)).toBe(true);
    expect(foregroundCommand(rows, 900)).not.toBeNull();
  });

  it('is false for a shell sitting at its prompt', () => {
    expect(hasForeground(rows, 902)).toBe(false);
  });
});

describe('tidyCommand', () => {
  it('drops the directory, which never distinguishes one tab from another', () => {
    expect(tidyCommand('/opt/homebrew/bin/node server.js')).toBe('node server.js');
  });

  it('keeps a short command whole', () => {
    expect(tidyCommand('npm run dev:server')).toBe('npm run dev:server');
  });

  it('caps a long one so the strip stays a strip', () => {
    const tidy = tidyCommand(`npm run ${'x'.repeat(80)}`);
    expect(tidy).toHaveLength(40);
    expect(tidy.endsWith('…')).toBe(true);
  });

  it('survives whitespace-only input', () => {
    expect(tidyCommand('   ')).toBe('');
  });
});

describe('freshSnapshotReader (spec 2026-10-24-code-page-terminal §9)', () => {
  it('runs one ps at a time: a burst shares the one read queued behind the running one', async () => {
    let reads = 0;
    let live = 0;
    let peak = 0;
    const finish: Array<() => void> = [];
    const reader = freshSnapshotReader(() => {
      reads += 1;
      live += 1;
      peak = Math.max(peak, live);
      return new Promise((resolve) => finish.push(() => { live -= 1; resolve([]); }));
    }, 10_000);
    const answers = Array.from({ length: 30 }, () => reader());
    expect(reads).toBe(1);
    finish.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    finish.shift()!();
    expect(await Promise.all(answers)).toEqual(Array.from({ length: 30 }, () => []));
    expect(peak).toBe(1);
  });

  it('kills a hung ps at its timeout, answers null, and frees the slot', async () => {
    const children: ChildProcess[] = [];
    const reader = freshSnapshotReader((signal) => new Promise((resolve) => {
      children.push(execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal }, () => resolve(null)));
    }), 100);
    const started = Date.now();
    expect(await reader()).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    const child = children[0]!;
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    expect(child.killed).toBe(true);
    // The slot is free: the next caller gets a read of its own, not the dead one.
    void reader();
    expect(children).toHaveLength(2);
    children[1]!.kill();
  });

  it('spawns no ps while three killed ones have not exited (D-state), and again once one does', async () => {
    const exits: Array<() => void> = [];
    // As execFile does: the read settles on the abort, and the child exits (if ever) later.
    const reader = freshSnapshotReader((signal, exited) => new Promise((resolve) => {
      exits.push(() => exited?.());
      signal.addEventListener('abort', () => resolve(null));
    }), 10);
    for (let index = 0; index < MAX_STUCK_SNAPSHOT_READS; index += 1) expect(await reader()).toBeNull();
    expect(exits).toHaveLength(MAX_STUCK_SNAPSHOT_READS);
    expect(await reader()).toBeNull();
    expect(exits).toHaveLength(MAX_STUCK_SNAPSHOT_READS);
    exits[0]!();
    void reader();
    expect(exits).toHaveLength(MAX_STUCK_SNAPSHOT_READS + 1);
  });

  it('counts a killed real child as stuck until it closes, not until its callback fires', async () => {
    // The child hands its stdout to a grandchild, so killing it leaves the pipe open: `close`
    // waits for the grandchild, as it would for a `ps` the kernel has not let go of. Detached, or
    // Windows kills it with the child's job object.
    const script = [
      "const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });",
      'process.stderr.write(String(g.pid));',
      'setInterval(() => {}, 1000);',
    ].join('');
    const children: ChildProcess[] = [];
    const grandchildren: number[] = [];
    let ready: () => void = () => {};
    const spawned = new Promise<void>((resolve) => { ready = resolve; });
    const reader = freshSnapshotReader((signal, exited) => new Promise((resolve) => {
      // `spawn`, not execFile: execFile destroys the pipes on abort. The read answers the abort at once either way.
      const child = spawn(process.execPath, ['-e', script], { signal, stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('error', () => resolve(null));
      child.stderr?.on('data', (chunk: Buffer) => {
        grandchildren.push(Number(String(chunk).trim()));
        ready();
      });
      child.once('close', () => exited?.());
      children.push(child);
    }), 3_000, 1);
    try {
      const first = reader();
      await spawned;
      expect(await first).toBeNull();
      const child = children[0]!;
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      // Dead, its callback fired, but its pipe is still open: no second ps.
      expect(await reader()).toBeNull();
      expect(children).toHaveLength(1);
      const closed = once(child, 'close');
      process.kill(grandchildren[0]!);
      await closed;
      void reader();
      expect(children).toHaveLength(2);
    } finally {
      for (const child of children) child.kill();
      for (const pid of grandchildren) {
        try { process.kill(pid); } catch { /* already gone */ }
      }
    }
  });
});
