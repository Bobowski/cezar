import { watch, type FSWatcher } from 'node:fs';

/**
 * "Something changed on disk" for an open Code page (spec `2026-10-11-code-page` §4): a debounced
 * recursive watch that exists only while somebody subscribes. It reports THAT, never what — the
 * client re-reads the hashes of its open tabs over HTTP.
 *
 * Recursive `fs.watch` is one kernel subscription on macOS and Windows. On Linux it is a watch
 * per directory, which on a tree with `node_modules` is thousands — so there this answers
 * "cannot watch" and the page falls back to revalidating on focus and on save.
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
