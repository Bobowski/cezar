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

/** What git says about a path the watch saw move. */
export interface PathFacts {
  ignored: boolean;
  tracked: boolean;
}
export type ClassifyPaths = (root: string, paths: string[]) => Promise<Map<string, PathFacts>>;

/** How long one path's ignored/tracked answer is reused: a busy log asks git once a minute. */
export const CLASSIFY_TTL_MS = 60_000;
/** Paths asked about tracked-ness per window; past it a path counts as tracked (never muted). */
const MAX_TRACKED_ASKED = 200;

/** Every git the bell runs: a look must never take `index.lock` from under the agent's `git add`. */
function quietGit(
  run: typeof execFile,
  root: string,
  args: string[],
  done: (error: Error | null, stdout: string) => void,
  input?: string,
): void {
  const child = run(
    'git',
    ['-C', root, ...args],
    { timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    done,
  ) as ReturnType<typeof execFile> | undefined;
  if (input === undefined) return;
  // A git that exits before reading everything must not take the process down with EPIPE.
  child?.stdin?.on('error', () => {});
  child?.stdin?.end(input);
}

/** One ask per root and path set at a time: a slow git is joined, never asked twice in parallel. */
const inFlight = new Map<string, Promise<Map<string, PathFacts>>>();

/** `git check-ignore --stdin` for the lot, `git ls-files` for the rest. A git that fails answers
 *  "not ignored, tracked" — the bell rings, as it did before it could ask. */
export function classifyPaths(root: string, paths: string[], run: typeof execFile = execFile): Promise<Map<string, PathFacts>> {
  const key = `${root}\0${[...new Set(paths)].sort().join('\0')}`;
  const joined = inFlight.get(key);
  if (joined) return joined;
  const asking = askGit(root, paths, run).finally(() => inFlight.delete(key));
  inFlight.set(key, asking);
  return asking;
}

async function askGit(root: string, paths: string[], run: typeof execFile): Promise<Map<string, PathFacts>> {
  const ignored = new Set(await ignoredAmong(root, paths, run));
  const rest = paths.filter((path) => !ignored.has(path));
  const asked = rest.slice(0, MAX_TRACKED_ASKED);
  const tracked = await trackedAmong(root, asked, run);
  const facts = new Map<string, PathFacts>();
  for (const path of paths) {
    if (ignored.has(path)) facts.set(path, { ignored: true, tracked: false });
    else facts.set(path, { ignored: false, tracked: tracked === null || !asked.includes(path) || tracked.has(path) });
  }
  return facts;
}

function ignoredAmong(root: string, paths: string[], run: typeof execFile): Promise<string[]> {
  if (paths.length === 0) return Promise.resolve([]);
  // Exit 1 means "none of them", which is an answer rather than a failure; stdout says which.
  return new Promise((resolve) => {
    quietGit(run, root, ['check-ignore', '-z', '--stdin'], (_error, stdout) => resolve((stdout ?? '').split('\0').filter(Boolean)), `${paths.join('\0')}\0`);
  });
}

function trackedAmong(root: string, paths: string[], run: typeof execFile): Promise<Set<string> | null> {
  if (paths.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    quietGit(run, root, ['ls-files', '-z', '--', ...paths.map((path) => `:(literal)${path}`)], (error, stdout) =>
      resolve(error ? null : new Set(stdout.split('\0').filter(Boolean))),
    );
  });
}

/**
 * The poll's churn rule for an event-driven watch (cockpit-polish §3.2): time is cut into
 * `POLL_INTERVAL_MS` windows, and an untracked path that moved in `CHURN_STREAK` windows in a
 * row is muted for `CHURN_MUTE_MS` — a dev server's log or SQLite file, written per request.
 */
export interface WatchChurn {
  /** The untracked paths that moved now; answers those muted right now. */
  moved(paths: Iterable<string>): Set<string>;
}

export function createWatchChurn(now: () => number = Date.now): WatchChurn {
  const seen = new Map<string, { window: number; streak: number; mutedUntil: number }>();
  return {
    moved(paths) {
      const at = now();
      const window = Math.floor(at / POLL_INTERVAL_MS);
      const muted = new Set<string>();
      for (const path of paths) {
        const prev = seen.get(path) ?? { window: -2, streak: 0, mutedUntil: 0 };
        if (prev.window !== window) prev.streak = prev.window === window - 1 ? prev.streak + 1 : 1;
        prev.window = window;
        if (prev.mutedUntil <= at && prev.streak >= CHURN_STREAK) prev.mutedUntil = at + CHURN_MUTE_MS;
        if (prev.mutedUntil > at) {
          muted.add(path);
          prev.streak = 0;
        }
        seen.set(path, prev);
      }
      for (const [path, entry] of seen) if (entry.window < window - 1 && entry.mutedUntil <= at) seen.delete(path);
      return muted;
    },
  };
}

export interface WatchCheckoutOptions {
  open?: typeof watch;
  classify?: ClassifyPaths;
  now?: () => number;
}

/**
 * Start watching `root`; `changed` fires at most once per `DEBOUNCE_MS`, and only for a path git
 * does not ignore and the churn rule has not muted — the same bell the Linux poll rings, so a
 * dev server writing a gitignored log cannot reload a preview forever. Returns the stop.
 */
export function watchCheckout(root: string, changed: () => void, options: WatchCheckoutOptions = {}): () => void {
  const open = options.open ?? watch;
  const classify = options.classify ?? classifyPaths;
  const now = options.now ?? Date.now;
  const churn = createWatchChurn(now);
  const known = new Map<string, { facts: PathFacts; at: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let stopped = false;
  let pending = new Set<string>();
  let unnamed = false;

  const settle = async (paths: string[], blind: boolean) => {
    // An event without a name cannot be asked about: it rings, as every event did before.
    if (blind) return changed();
    const at = now();
    for (const [path, entry] of known) if (at - entry.at > CLASSIFY_TTL_MS) known.delete(path);
    const unknown = paths.filter((path) => !known.has(path));
    if (unknown.length > 0) {
      const answered = await classify(root, unknown).catch(() => new Map<string, PathFacts>());
      for (const path of unknown) known.set(path, { facts: answered.get(path) ?? { ignored: false, tracked: true }, at });
    }
    if (stopped) return;
    const live = paths.filter((path) => !known.get(path)!.facts.ignored);
    const muted = churn.moved(live.filter((path) => !known.get(path)!.facts.tracked));
    if (live.some((path) => !muted.has(path))) changed();
  };

  try {
    watcher = open(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (typeof filename === 'string') {
        const path = filename.replace(/\\/g, '/');
        if (IGNORED.test(path)) return;
        pending.add(path);
      } else unnamed = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const paths = [...pending];
        const blind = unnamed;
        pending = new Set();
        unnamed = false;
        void settle(paths, blind);
      }, DEBOUNCE_MS);
      timer.unref?.();
    });
    watcher.on('error', () => {});
  } catch {
    // A tree that vanished, or a platform that refused: no bell, and the floor still holds.
  }
  return () => {
    stopped = true;
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
