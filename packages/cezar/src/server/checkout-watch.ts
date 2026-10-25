import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * "Something changed on disk" for an open Code page (spec `2026-10-11-code-page` §4): a debounced
 * recursive watch that exists only while somebody subscribes. It reports THAT, never what — the
 * client re-reads the hashes of its open tabs over HTTP.
 *
 * Recursive `fs.watch` is one kernel subscription on macOS and Windows. On Linux it is a watch
 * per directory, which on a tree with `node_modules` is thousands — so there the bell is
 * `pollCheckout` below instead, and the page still revalidates on focus and on save.
 */

const DEBOUNCE_MS = 250;
/** Churn that is never an edit to an open file. */
const IGNORED = /(^|[\\/])(\.git|node_modules|\.next|\.turbo|dist|\.cache)([\\/]|$)/;

export function checkoutWatchSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** Start watching `root`; `changed` fires at most once per `DEBOUNCE_MS`. Returns the stop. */
export function watchCheckout(
  root: string,
  changed: () => void,
  open: typeof watch = watch,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = open(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (typeof filename === 'string' && IGNORED.test(filename)) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        changed();
      }, DEBOUNCE_MS);
      timer.unref?.();
    });
    watcher.on('error', () => {});
  } catch {
    // A tree that vanished, or a platform that refused: no bell, and the floor still holds.
  }
  return () => {
    clearTimeout(timer);
    timer = undefined;
    try {
      watcher?.close();
    } catch {
      // Already closed.
    }
  };
}

/** How often the polling bell looks — only while somebody subscribes. */
export const POLL_INTERVAL_MS = 2_000;
/** Paths stat'ed per look: a checkout with more pending changes than this rings on status alone. */
const MAX_STATTED = 500;

/**
 * What the checkout's pending changes look like: `git status` plus each listed path's mtime and
 * size, so a second edit to an already-modified file moves it too. Null when git cannot answer.
 */
export function statusFingerprint(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const entries = stdout.split('\0').filter((entry) => entry.length > 3);
        const paths = entries.map((entry) => entry.slice(3)).filter((path) => !IGNORED.test(path)).slice(0, MAX_STATTED);
        void Promise.all(
          paths.map((path) =>
            stat(join(root, path)).then(
              (info) => `${path}:${info.mtimeMs}:${info.size}`,
              () => `${path}:-`,
            ),
          ),
        ).then((stats) => resolve(`${stdout}\n${stats.join('\n')}`));
      },
    );
  });
}

/**
 * The bell where a recursive watch is refused (Linux — spec 2026-10-24-cockpit-polish §3.2, so a
 * VPS preview hears an agent's edit too): a look at `git status` every `intervalMs` while
 * subscribed, ringing when the fingerprint moves. The first look is the baseline, never a ring.
 */
export function pollCheckout(
  root: string,
  changed: () => void,
  options: { intervalMs?: number; fingerprint?: (root: string) => Promise<string | null> } = {},
): () => void {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const fingerprint = options.fingerprint ?? statusFingerprint;
  let stopped = false;
  let last: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const look = async () => {
    const next = await fingerprint(root).catch(() => null);
    if (stopped) return;
    if (next !== null) {
      if (last !== null && next !== last) changed();
      last = next;
    }
    timer = setTimeout(() => void look(), intervalMs);
    timer.unref?.();
  };
  void look();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
