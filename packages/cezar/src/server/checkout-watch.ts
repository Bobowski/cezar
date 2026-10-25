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

/** An untracked path that moved on this many looks in a row is churn — a dev SQLite file, a log. */
export const CHURN_STREAK = 3;
/** …and stays out of the fingerprint this long, so it cannot reload a preview forever. */
export const CHURN_MUTE_MS = 5 * 60_000;

/** Which untracked paths are churning, across the looks at one checkout. */
export interface ChurnFilter {
  /** Feed one look's untracked `path → signature`; answers the paths muted right now. */
  look(untracked: ReadonlyMap<string, string>): Set<string>;
}

export function createChurnFilter(now: () => number = Date.now): ChurnFilter {
  const seen = new Map<string, { sig: string; streak: number; mutedUntil: number }>();
  return {
    look(untracked) {
      const at = now();
      const muted = new Set<string>();
      for (const [path, sig] of untracked) {
        const prev = seen.get(path);
        if (!prev) {
          seen.set(path, { sig, streak: 0, mutedUntil: 0 });
          continue;
        }
        prev.streak = sig === prev.sig ? 0 : prev.streak + 1;
        prev.sig = sig;
        if (prev.mutedUntil <= at && prev.streak >= CHURN_STREAK) prev.mutedUntil = at + CHURN_MUTE_MS;
        if (prev.mutedUntil > at) {
          muted.add(path);
          prev.streak = 0;
        }
      }
      for (const path of seen.keys()) if (!untracked.has(path)) seen.delete(path);
      return muted;
    },
  };
}

/** One filter per checkout for the stateless `?stamp=1` looks; dropped when nobody looked for a while. */
const sharedChurn = new Map<string, { filter: ChurnFilter; lastLook: number }>();
function churnFor(root: string): ChurnFilter {
  const at = Date.now();
  for (const [key, entry] of sharedChurn) if (at - entry.lastLook > 2 * CHURN_MUTE_MS) sharedChurn.delete(key);
  const entry = sharedChurn.get(root) ?? { filter: createChurnFilter(), lastLook: at };
  entry.lastLook = at;
  sharedChurn.set(root, entry);
  return entry.filter;
}

/**
 * What the checkout's pending changes look like: `git status` plus each listed path's mtime and
 * size, so a second edit to an already-modified file moves it too — except an untracked path the
 * churn filter has muted. Null when git cannot answer.
 */
export function statusFingerprint(
  root: string,
  run: typeof execFile = execFile,
  churn: ChurnFilter = churnFor(root),
): Promise<string | null> {
  return new Promise((resolve) => {
    run(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      // A look every 2 s must never take `index.lock` from under the agent's own `git add`.
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error: Error | null, stdout: string) => {
        if (error) return resolve(null);
        const entries = parseStatus(stdout).filter((entry) => !IGNORED.test(entry.path)).slice(0, MAX_STATTED);
        void Promise.all(
          entries.map((entry) =>
            stat(join(root, entry.path)).then(
              (info) => `${info.mtimeMs}:${info.size}`,
              () => '-',
            ),
          ),
        ).then((sigs) => {
          const untracked = new Map<string, string>();
          entries.forEach((entry, index) => {
            if (entry.untracked) untracked.set(entry.path, sigs[index]!);
          });
          const muted = churn.look(untracked);
          const stats = entries.map((entry, index) => `${entry.path}:${muted.has(entry.path) ? '~' : sigs[index]}`);
          resolve(`${stdout}\n${stats.join('\n')}`);
        });
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

/** `git status --porcelain=v1 -z`: `XY path`, a rename's or copy's source as the next token. */
function parseStatus(stdout: string): Array<{ path: string; untracked: boolean }> {
  const tokens = stdout.split('\0');
  const entries: Array<{ path: string; untracked: boolean }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    entries.push({ path: token.slice(3), untracked: code === '??' });
    if (code[0] === 'R' || code[0] === 'C') index += 1;
  }
  return entries;
}
