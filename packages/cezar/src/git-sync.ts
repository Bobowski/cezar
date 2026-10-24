import { execFile } from 'node:child_process';
import { isSafeGitRef } from './git-refs.ts';
import { serializeCheckout } from './server/repo-sync.ts';

/**
 * How far the MAIN checkout is from its upstream, and the two things cezar does about it: a
 * throttled background `git fetch` while a view shows the answer, and a fast-forward-only pull.
 * Nothing here rewrites history or touches a tree git would have to merge: a diverged branch or a
 * conflicting local change is reported, never resolved. `CEZ_REPO_AUTO_SYNC=0` turns the
 * unattended half off (the fetch timer and the in-place fast-forward); an explicit Pull still works.
 */

/** How stale `origin/*` may get while a view is showing it. */
export const REPO_FETCH_INTERVAL_MS = 5 * 60_000;
/** A slow or unreachable remote must not hold a request or a task start. */
const FETCH_TIMEOUT_MS = 15_000;

export interface RepoSyncCounts {
  /** The checked-out branch; null on a detached HEAD. */
  branch: string | null;
  /** The remote-tracking ref it is compared with (`origin/main`); null when there is none. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** When cezar last fetched this repo successfully (ISO), null if it has not this process. */
  fetchedAt: string | null;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git, never throw. */
function git(cwd: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

export function repoAutoSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_REPO_AUTO_SYNC !== '0';
}

const fetches = new Map<string, { at: number | null; inflight: Promise<boolean> | null }>();
const fetchState = (root: string) => {
  let state = fetches.get(root);
  if (!state) fetches.set(root, (state = { at: null, inflight: null }));
  return state;
};

/** The branch and the `origin/<name>` it follows. Another remote's upstream is left alone. */
async function tracking(root: string): Promise<{ branch: string | null; upstream: string | null }> {
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.ok ? head.stdout.trim() : '';
  if (!branch || !isSafeGitRef(branch)) return { branch: null, upstream: null };
  const configured = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
  const named = configured.ok ? configured.stdout.trim() : '';
  if (named) return { branch, upstream: named.startsWith('origin/') && isSafeGitRef(named) ? named : null };
  const sameName = await git(root, ['rev-parse', '--verify', '--quiet', `origin/${branch}^{commit}`]);
  return { branch, upstream: sameName.ok ? `origin/${branch}` : null };
}

/** Fetch `upstream` from origin. Best effort; single-flight per repo. True when it ran and succeeded. */
function fetchUpstream(root: string, upstream: string): Promise<boolean> {
  const state = fetchState(root);
  if (state.inflight) return state.inflight;
  const name = upstream.slice('origin/'.length);
  const refspec = `+refs/heads/${name}:refs/remotes/origin/${name}`;
  state.inflight = (async () => {
    if (process.env.CEZ_DRY_RUN === '1') return false;
    if (!(await git(root, ['remote', 'get-url', 'origin'])).ok) return false;
    const fetched = await git(root, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', refspec], {
      timeout: FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (fetched.ok) state.at = Date.now();
    return fetched.ok;
  })().finally(() => {
    state.inflight = null;
  });
  return state.inflight;
}

/** The background fetch: at most once per `REPO_FETCH_INTERVAL_MS`, and only with auto-sync on.
 *  True when the upstream ref moved, i.e. when a reader has something new to show. */
export async function refreshRepoSync(root: string): Promise<boolean> {
  if (!repoAutoSyncEnabled()) return false;
  const state = fetchState(root);
  if (state.at !== null && Date.now() - state.at < REPO_FETCH_INTERVAL_MS) return false;
  const { upstream } = await tracking(root);
  if (!upstream) return false;
  const tip = async () => (await git(root, ['rev-parse', '--verify', '--quiet', upstream])).stdout.trim();
  const before = await tip();
  if (!(await fetchUpstream(root, upstream))) return false;
  return (await tip()) !== before;
}

/** A pure local read: no network. */
export async function repoSyncCounts(root: string): Promise<RepoSyncCounts> {
  const { branch, upstream } = await tracking(root);
  const at = fetches.get(root)?.at ?? null;
  const fetchedAt = at === null ? null : new Date(at).toISOString();
  if (!upstream) return { branch, upstream, ahead: 0, behind: 0, fetchedAt };
  const counted = await git(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
  const [ahead, behind] = counted.ok ? counted.stdout.trim().split(/\s+/).map(Number) : [0, 0];
  return { branch, upstream, ahead: ahead || 0, behind: behind || 0, fetchedAt };
}

/** A refusal carries how far behind the checkout still is, so a caller can say so without re-reading. */
export type PullResult =
  | { ok: true; updated: number }
  | { ok: false; error: string; behind: number; upstream: string | null };

/**
 * Fetch, then fast-forward the checked-out branch to its upstream — or say why not. A diverged
 * branch is refused before git is asked; a local change the update would overwrite is git's own
 * refusal, passed on. `requireClean` is for the unattended caller, which must not touch a tree
 * someone is editing.
 */
export function pullFastForward(root: string, opts: { requireClean?: boolean } = {}): Promise<PullResult> {
  // The checkout's one queue: never between a Git-page action's or a landing's steps.
  return serializeCheckout(root, () => pullUnqueued(root, opts));
}

async function pullUnqueued(root: string, opts: { requireClean?: boolean }): Promise<PullResult> {
  const { branch, upstream } = await tracking(root);
  if (!branch) return { ok: false, error: 'HEAD is detached — there is no branch to pull', behind: 0, upstream: null };
  if (!upstream) return { ok: false, error: `"${branch}" has no branch on origin to pull from`, behind: 0, upstream: null };
  await fetchUpstream(root, upstream);
  const { ahead, behind } = await repoSyncCounts(root);
  if (behind === 0) return { ok: true, updated: 0 };
  if (ahead > 0) {
    return {
      ok: false,
      error: `"${branch}" and ${upstream} have diverged (${ahead} local, ${behind} upstream) — merge or rebase by hand`,
      behind,
      upstream,
    };
  }
  if (opts.requireClean) {
    const status = await git(root, ['status', '--porcelain']);
    if (!status.ok || status.stdout.trim()) return { ok: false, error: 'the working tree has uncommitted changes', behind, upstream };
  }
  const merged = await git(root, ['merge', '--ff-only', upstream]);
  if (merged.ok) return { ok: true, updated: behind };
  const reason = (merged.stderr || merged.stdout).trim().split('\n')[0]?.replace(/^(error|fatal):\s*/, '');
  return { ok: false, error: reason || 'git could not fast-forward', behind, upstream };
}

/**
 * Keep a view's answer fresh while someone is looking (the `repo-sync:<project>` topic's publisher):
 * one fetch now, then one per interval; `onMoved` fires only when the upstream actually moved.
 * Returns the stop function.
 */
export function watchRepoSync(root: string, onMoved: () => void): () => void {
  let stopped = false;
  const tick = () => {
    void refreshRepoSync(root).then((moved) => {
      if (moved && !stopped) onMoved();
    });
  };
  tick();
  const timer = setInterval(tick, REPO_FETCH_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
