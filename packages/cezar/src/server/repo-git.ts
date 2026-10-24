import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  RepoCompare,
  RepoGitActionResponse,
  RepoGraph,
  RepoGraphFilter,
  RepoGraphRef,
  RepoIndex,
  RepoIndexFile,
  RepoOperation,
  RepoRemotes,
  RepoStashEntry,
} from '@open-mercato/cezar-contract';
import { freshestBaseRef, resolveCompareBase } from '../git-diff-base.ts';
import { isSafeGitRef } from '../git-refs.ts';
import { resolveTaskRemotes, splitRemoteRef } from '../git-remotes.ts';
import { assemblePayload } from './git-changes.ts';
import { serializeCheckout } from './repo-sync.ts';

/**
 * The Git page's Source-Control actions on the main checkout (spec 2026-10-24-git-view): the
 * commit graph, branch actions, the index, stashes and the remotes. Every helper runs `git` with
 * the checkout's own config and identity and never throws: a failure is `{ ok:false, error }` in
 * git's own words. Mutations go through the checkout's one queue (`serializeCheckout`). Nothing
 * here force-pushes, and nothing rewrites a commit a remote already has.
 */

interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitOk<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

const NETWORK_TIMEOUT_MS = 60_000;
/** A commit runs the user's hooks; they must not hold a request forever. */
const COMMIT_TIMEOUT_MS = 5 * 60_000;
const LOCAL_TIMEOUT_MS = 2 * 60_000;
const PATCH_CAP = 200_000;
const MERGE_BASE_CAP = 60;
const REMOTE_BRANCH_CAP = 300;

interface GitOptions {
  timeout?: number;
  env?: Record<string, string>;
  input?: string;
}

/** Never prompts (no terminal, no editor), never throws. */
function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((done) => {
    let settled = false;
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
        GIT_MERGE_AUTOEDIT: 'no',
        ...options.env,
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 64 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 1024 * 1024) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, stdout, stderr: stderr || `git ${args[0] ?? ''} timed out` });
    }, options.timeout ?? LOCAL_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, stdout, stderr });
    });
    // A child that exits before reading its stdin must not crash the server (#1663).
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

/** git's own words: the `fatal:`/`error:` line when there is one, else the first lines. */
function reason(res: GitResult, fallback: string): string {
  const lines = `${res.stderr}\n${res.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^hint:/.test(line));
  const marked = lines.find((line) => /^(fatal|error):/.test(line));
  return marked ?? (lines.slice(0, 3).join('\n') || fallback);
}

const runner = (root: string) => (args: string[]) => git(root, args);
const dryRun = (): boolean => process.env.CEZ_DRY_RUN === '1';
const NETWORK = ['-c', 'credential.interactive=false'];
/** Paths are literal: a file named `*.ts` or `:(top)` is that file, not a pattern. */
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

async function currentBranch(root: string): Promise<string | null> {
  const head = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const name = head.ok ? head.stdout.trim() : '';
  return name || null;
}

async function resolves(root: string, rev: string): Promise<string | null> {
  if (!isSafeGitRef(rev)) return null;
  const res = await git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return res.ok ? res.stdout.trim() || null : null;
}

async function unmergedPaths(root: string): Promise<string[]> {
  const res = await git(root, ['diff', '--name-only', '-z', '--diff-filter=U']);
  return res.ok ? [...new Set(res.stdout.split('\0').filter(Boolean))] : [];
}

async function gitPathExists(root: string, name: string): Promise<boolean> {
  const res = await git(root, ['rev-parse', '--git-path', name]);
  if (!res.ok) return false;
  const path = res.stdout.trim();
  return existsSync(isAbsolute(path) ? path : resolve(root, path));
}

/** The merge, rebase, cherry-pick or revert git is in the middle of; null when none. */
export async function repoOperation(root: string): Promise<RepoOperation | null> {
  const [merge, rebaseMerge, rebaseApply, pick, revert] = await Promise.all([
    gitPathExists(root, 'MERGE_HEAD'),
    gitPathExists(root, 'rebase-merge'),
    gitPathExists(root, 'rebase-apply'),
    gitPathExists(root, 'CHERRY_PICK_HEAD'),
    gitPathExists(root, 'REVERT_HEAD'),
  ]);
  const short = async (rev: string) => {
    const res = await git(root, ['rev-parse', '--short', rev]);
    return res.ok ? res.stdout.trim() || null : null;
  };
  if (rebaseMerge || rebaseApply) {
    const onto = await git(root, ['rev-parse', '--git-path', rebaseMerge ? 'rebase-merge/onto' : 'rebase-apply/onto']);
    let sha: string | null = null;
    if (onto.ok) {
      const path = onto.stdout.trim();
      sha = (await readFile(isAbsolute(path) ? path : resolve(root, path), 'utf8').catch(() => '')).trim().slice(0, 12) || null;
    }
    return { kind: 'rebase', onto: sha };
  }
  if (merge) return { kind: 'merge', onto: await short('MERGE_HEAD') };
  if (pick) return { kind: 'cherry-pick', onto: await short('CHERRY_PICK_HEAD') };
  if (revert) return { kind: 'revert', onto: await short('REVERT_HEAD') };
  return null;
}

// ---- graph -----------------------------------------------------------------------------------

export interface GraphTask {
  runId: string;
  title: string;
  status: NonNullable<RepoGraphRef['task']>['status'];
}

export interface GraphOptions {
  limit?: number;
  skip?: number;
  filter?: RepoGraphFilter;
  /** The project's configured base branch; else the base remote's default branch. */
  baseBranch?: string;
  /** Branch name → the run that owns it. */
  tasks?: ReadonlyMap<string, GraphTask>;
}

const SEP = '\x1f';

/** The base branch the graph measures forks against: its name, and the freshest ref it names
 *  (`origin/main` when the local `main` is behind). */
async function graphBase(root: string, configured: string | undefined): Promise<{ name: string; ref: string } | null> {
  let name = configured && isSafeGitRef(configured) ? configured : null;
  if (!name) {
    const remotes = await resolveTaskRemotes(runner(root));
    if (remotes.base) {
      const head = await git(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remotes.base}/HEAD`]);
      const short = head.ok ? head.stdout.trim() : '';
      if (short.startsWith(`${remotes.base}/`)) {
        const branch = short.slice(remotes.base.length + 1);
        name = (await resolves(root, `refs/heads/${branch}`)) ? branch : short;
      }
    }
  }
  name ??= await currentBranch(root);
  if (!name || !(await resolves(root, name))) return null;
  return { name, ref: await freshestBaseRef(runner(root), name) };
}

export async function repoGraph(root: string, options: GraphOptions = {}): Promise<GitOk<{ graph: RepoGraph }>> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const skip = Math.max(options.skip ?? 0, 0);
  const filter = options.filter ?? 'all';
  const tasks = options.tasks ?? new Map<string, GraphTask>();

  const [refsOut, headOut, branch, baseInfo, remotes] = await Promise.all([
    git(root, ['for-each-ref', `--format=%(refname)${SEP}%(objectname)${SEP}%(symref)`, 'refs/heads', 'refs/remotes']),
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
    currentBranch(root),
    graphBase(root, options.baseBranch),
    resolveTaskRemotes(runner(root)),
  ]);
  if (!refsOut.ok) return { ok: false, error: reason(refsOut, 'git for-each-ref failed') };
  const head = headOut.ok ? headOut.stdout.trim() || null : null;
  const base = baseInfo?.ref ?? null;

  const all: Array<Omit<RepoGraphRef, 'merged' | 'mergeBase'> & { full: string }> = [];
  for (const line of refsOut.stdout.split('\n').filter(Boolean)) {
    const [full = '', commit = '', symref = ''] = line.split(SEP);
    if (symref || !isSafeGitRef(full)) continue; // `origin/HEAD` points at a branch already drawn
    const local = full.startsWith('refs/heads/');
    const name = full.replace(/^refs\/(heads|remotes)\//, '');
    const split = local ? { remote: null, branch: name } : splitRemoteRef(name, remotes.names);
    const task = tasks.get(split.branch) ?? null;
    all.push({
      full,
      name,
      kind: local ? 'local' : 'remote',
      remote: split.remote,
      branch: split.branch,
      commit,
      current: local && name === branch,
      base: baseInfo !== null && (name === baseInfo.ref || name === baseInfo.name),
      isTask: split.branch.startsWith('cez/') || task !== null,
      task: task ? { runId: task.runId, title: task.title, status: task.status } : null,
    });
  }
  const shown = all.filter((ref) => {
    if (ref.current || ref.base) return true;
    if (filter === 'tasks') return ref.isTask;
    if (filter === 'mine') return ref.kind === 'local' && !ref.isTask;
    return true;
  });

  const merged = new Set<string>();
  if (base) {
    const res = await git(root, ['for-each-ref', `--merged=${base}`, '--format=%(refname)', 'refs/heads', 'refs/remotes']);
    for (const line of res.ok ? res.stdout.split('\n') : []) if (line.trim()) merged.add(line.trim());
  }
  const mergeBases = new Map<string, string | null>();
  if (base) {
    const wanted = shown.filter((ref) => !ref.base).slice(0, MERGE_BASE_CAP);
    for (let at = 0; at < wanted.length; at += 8) {
      await Promise.all(
        wanted.slice(at, at + 8).map(async (ref) => {
          const res = await git(root, ['merge-base', base, ref.commit]);
          mergeBases.set(ref.full, res.ok ? res.stdout.trim() || null : null);
        }),
      );
    }
  }
  const refs: RepoGraphRef[] = shown.map(({ full, ...ref }) => ({
    ...ref,
    merged: !ref.base && merged.has(full),
    mergeBase: mergeBases.get(full) ?? null,
  }));

  const tips = [...new Set([...(head ? ['HEAD'] : []), ...shown.map((ref) => ref.full)])];
  if (tips.length === 0) return { ok: true, graph: { commits: [], refs, head, base, next: null } };
  const log = await git(
    root,
    ['log', '--stdin', '--date-order', `--format=%H${SEP}%P${SEP}%s${SEP}%an${SEP}%cr`, `--skip=${skip}`, `-n`, String(limit + 1)],
    { input: `${tips.join('\n')}\n` },
  );
  if (!log.ok) return { ok: false, error: reason(log, 'git log failed') };
  const commits = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', parents = '', subject = '', author = '', when = ''] = line.split(SEP);
      return { sha, parents: parents.split(' ').filter(Boolean), subject, author, when };
    });
  const more = commits.length > limit;
  return {
    ok: true,
    graph: { commits: commits.slice(0, limit), refs, head, base, next: more ? String(skip + limit) : null },
  };
}

// ---- the index -------------------------------------------------------------------------------

/** A copy of the real index with every untracked file intent-to-added, so `git diff` shows
 *  untracked files as new without writing the user's own index. Cleaned up by `done`. */
async function scratchIndex(root: string): Promise<{ env: Record<string, string>; done: () => void }> {
  const file = join(tmpdir(), `cez-git-view-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const real = await git(root, ['rev-parse', '--git-path', 'index']);
  const path = real.ok ? real.stdout.trim() : '';
  const source = path ? (isAbsolute(path) ? path : resolve(root, path)) : '';
  const env = { GIT_INDEX_FILE: file, GIT_OPTIONAL_LOCKS: '0' };
  if (source && existsSync(source)) await copyFile(source, file).catch(() => undefined);
  await git(root, ['add', '-N', '--', '.'], { env });
  return { env, done: () => rmSync(file, { force: true }) };
}

async function diffFiles(root: string, args: string[], env?: Record<string, string>): Promise<GitOk<{ files: RepoIndexFile[] }>> {
  const readEnv = { GIT_OPTIONAL_LOCKS: '0', ...env };
  const [nameStatus, numstat, patch] = await Promise.all([
    git(root, ['diff', ...args, '--name-status', '-z', '-M'], { env: readEnv }),
    git(root, ['diff', ...args, '--numstat', '-z', '-M'], { env: readEnv }),
    git(root, ['diff', ...args, '--patch', '-M', '--no-color'], { env: readEnv }),
  ]);
  for (const listing of [nameStatus, numstat, patch]) {
    if (!listing.ok) return { ok: false, error: reason(listing, 'git diff failed') };
  }
  return { ok: true, files: assemblePayload(nameStatus.stdout, numstat.stdout, patch.stdout, PATCH_CAP).files };
}

export async function repoIndex(root: string): Promise<GitOk<{ index: RepoIndex }>> {
  const [branch, headOut, conflicted, operation, untrackedOut] = await Promise.all([
    currentBranch(root),
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
    unmergedPaths(root),
    repoOperation(root),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const hasHead = headOut.ok;
  const staged = await diffFiles(root, ['--cached']);
  if (!staged.ok) return staged;
  const scratch = await scratchIndex(root);
  let unstaged: GitOk<{ files: RepoIndexFile[] }>;
  try {
    unstaged = await diffFiles(root, [], scratch.env);
  } finally {
    scratch.done();
  }
  if (!unstaged.ok) return unstaged;
  const untracked = new Set(untrackedOut.ok ? untrackedOut.stdout.split('\0').filter(Boolean) : []);
  const unresolved = new Set(conflicted);
  const pushed = hasHead ? await git(root, ['branch', '-r', '--contains', 'HEAD']) : null;
  return {
    ok: true,
    index: {
      branch,
      staged: staged.files.filter((file) => !unresolved.has(file.path)),
      unstaged: unstaged.files
        .filter((file) => !unresolved.has(file.path))
        .map((file) => (untracked.has(file.path) ? { ...file, untracked: true } : file)),
      conflicted,
      operation,
      headPushed: Boolean(pushed?.ok && pushed.stdout.trim()),
      hasHead,
    },
  };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `@@ -1 +1,2 @@ fn()` → `-1,1+1,2`: what identifies a hunk, whatever context git printed. */
function hunkKey(header: string): string | null {
  const m = HUNK_HEADER.exec(header.trim());
  return m ? `-${m[1]},${m[2] ?? '1'}+${m[3]},${m[4] ?? '1'}` : null;
}

/** One hunk of a one-file patch as a patch of its own: the file header plus that hunk. */
export function extractHunk(patch: string, header: string): string | null {
  const want = hunkKey(header);
  if (!want) return null;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const first = lines.findIndex((line) => line.startsWith('@@'));
  if (first < 0) return null;
  const fileHeader = lines.slice(0, first);
  for (let at = first; at < lines.length; at++) {
    if (!lines[at]!.startsWith('@@') || hunkKey(lines[at]!) !== want) continue;
    let end = at + 1;
    while (end < lines.length && !lines[end]!.startsWith('@@')) end++;
    return `${[...fileHeader, ...lines.slice(at, end)].join('\n')}\n`;
  }
  return null;
}

type Side = 'staged' | 'unstaged';

/** The full (uncapped) patch of one path on one side of the index. */
async function onePathPatch(root: string, path: string, side: Side): Promise<GitOk<{ patch: string }>> {
  const scratch = side === 'unstaged' ? await scratchIndex(root) : null;
  try {
    const res = await git(root, ['diff', ...(side === 'staged' ? ['--cached'] : []), '--patch', '--no-color', '--', path], {
      env: { ...LITERAL, ...scratch?.env },
    });
    if (!res.ok) return { ok: false, error: reason(res, 'git diff failed') };
    return { ok: true, patch: res.stdout };
  } finally {
    scratch?.done();
  }
}

async function applyHunk(root: string, path: string, hunk: string, side: Side, args: string[]): Promise<GitOk> {
  const patch = await onePathPatch(root, path, side);
  if (!patch.ok) return patch;
  const piece = extractHunk(patch.patch, hunk);
  if (!piece) return { ok: false, error: `that change in ${path} is no longer there — refresh and try again` };
  const res = await git(root, ['apply', ...args, '--whitespace=nowarn', '-'], { input: piece });
  if (!res.ok) return { ok: false, error: reason(res, 'git apply failed') };
  return { ok: true };
}

export interface IndexChange {
  paths?: string[];
  path?: string;
  hunk?: string;
}

/** `git add` whole files, or `git apply --cached` one hunk. */
export function stagePaths(root: string, change: IndexChange): Promise<GitOk> {
  return serializeCheckout(root, async () => {
    if (change.path && change.hunk) return applyHunk(root, change.path, change.hunk, 'unstaged', ['--cached']);
    const res = await git(root, ['add', '-A', '--', ...(change.paths ?? [])], { env: LITERAL });
    return res.ok ? { ok: true } : { ok: false, error: reason(res, 'git add failed') };
  });
}

/** Back out of the index: `git restore --staged`, or `git apply --cached -R` of one hunk. */
export function unstagePaths(root: string, change: IndexChange): Promise<GitOk> {
  return serializeCheckout(root, async () => {
    if (change.path && change.hunk) return applyHunk(root, change.path, change.hunk, 'staged', ['--cached', '-R']);
    const hasHead = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
    const res = hasHead
      ? await git(root, ['restore', '--staged', '--', ...(change.paths ?? [])], { env: LITERAL })
      : await git(root, ['rm', '-r', '--cached', '--quiet', '--', ...(change.paths ?? [])], { env: LITERAL });
    return res.ok ? { ok: true } : { ok: false, error: reason(res, 'git restore failed') };
  });
}

/** Throw away unstaged work: restore tracked files from the index, delete untracked ones, or
 *  reverse one hunk in the working tree. The caller confirmed. */
export function discardPaths(root: string, change: IndexChange): Promise<GitOk> {
  return serializeCheckout(root, async () => {
    if (change.path && change.hunk) return applyHunk(root, change.path, change.hunk, 'unstaged', ['-R']);
    const paths = change.paths ?? [];
    const untrackedOut = await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], { env: LITERAL });
    const untracked = new Set(untrackedOut.ok ? untrackedOut.stdout.split('\0').filter(Boolean) : []);
    const tracked = paths.filter((path) => !untracked.has(path));
    if (untracked.size) {
      const res = await git(root, ['clean', '-f', '-q', '--', ...untracked], { env: LITERAL });
      if (!res.ok) return { ok: false, error: reason(res, 'git clean failed') };
    }
    if (tracked.length) {
      const res = await git(root, ['restore', '--worktree', '--', ...tracked], { env: LITERAL });
      if (!res.ok) return { ok: false, error: reason(res, 'git restore failed') };
    }
    return { ok: true };
  });
}

/** Commit the index (never `-a`). Amend is refused once HEAD is on a remote. */
export function commitIndex(root: string, input: { message: string; amend?: boolean }): Promise<GitOk<{ sha: string; message: string }>> {
  return serializeCheckout(root, async () => {
    const message = input.message.trim();
    if (input.amend) {
      if (!(await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok) {
        return { ok: false, error: 'there is no commit to amend yet' };
      }
      const pushed = await git(root, ['branch', '-r', '--contains', 'HEAD']);
      if (pushed.ok && pushed.stdout.trim()) {
        return {
          ok: false,
          error: `the last commit is already on ${pushed.stdout.trim().split('\n')[0]!.trim()} — amending would rewrite pushed history; make a new commit instead`,
        };
      }
    } else if (!message) {
      return { ok: false, error: 'write a commit message first' };
    }
    const args = input.amend ? ['commit', '--amend', ...(message ? ['-m', message] : ['--no-edit'])] : ['commit', '-m', message];
    const res = await git(root, args, { timeout: COMMIT_TIMEOUT_MS });
    if (!res.ok) return { ok: false, error: reason(res, 'git commit failed') };
    const sha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    return { ok: true, sha, message: `${input.amend ? 'amended' : 'committed'} ${sha.slice(0, 8)}` };
  });
}

// ---- branch and history actions --------------------------------------------------------------

type Action = GitOk<RepoGitActionResponse>;

const stopped = (what: string, conflicts: string[]): Action => ({
  ok: true,
  message: `${what} stopped on conflicts in ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} — resolve them, stage them, then Continue (or Abort)`,
  conflicts,
});
const done = (message: string): Action => ({ ok: true, message, conflicts: [] });

/** After a merge/rebase/cherry-pick that failed: conflicts leave the operation in progress. */
async function afterStop(root: string, res: GitResult, what: string, fallback: string): Promise<Action> {
  const conflicts = await unmergedPaths(root);
  if (conflicts.length && (await repoOperation(root))) return stopped(what, conflicts);
  return { ok: false, error: reason(res, fallback) };
}

async function isDirty(root: string): Promise<boolean> {
  const res = await git(root, ['status', '--porcelain', '--untracked-files=no']);
  return res.ok && res.stdout.trim() !== '';
}

function checkName(name: string): string | null {
  return isSafeGitRef(name) && !/[\s~^:?*[\\]|\.\.|@\{/.test(name) ? null : `invalid branch name: ${name}`;
}

/** A branch the graph or the Branches list named: a local branch, or `<remote>/<branch>`. */
async function lookupBranch(
  root: string,
  name: string,
): Promise<{ kind: 'local'; branch: string } | { kind: 'remote'; remote: string; branch: string } | null> {
  if (await resolves(root, `refs/heads/${name}`)) return { kind: 'local', branch: name };
  if (await resolves(root, `refs/remotes/${name}`)) {
    const split = splitRemoteRef(name, (await resolveTaskRemotes(runner(root))).names);
    if (split.remote) return { kind: 'remote', remote: split.remote, branch: split.branch };
  }
  return null;
}

/** Switch the main checkout. Refused on a dirty tree (stash or commit first); a remote-only
 *  branch gets a local tracking branch. The caller refuses while an in-place task runs. */
export function checkoutBranch(root: string, name: string): Promise<Action> {
  return serializeCheckout(root, async () => {
    const invalid = checkName(name);
    if (invalid) return { ok: false, error: invalid };
    const found = await lookupBranch(root, name);
    if (!found) return { ok: false, error: `no branch named ${name}` };
    if (found.kind === 'local' && found.branch === (await currentBranch(root))) return done(`already on ${name}`);
    if (await isDirty(root)) {
      return { ok: false, error: 'the working tree has uncommitted changes — commit or stash them before switching branches' };
    }
    if (found.kind === 'remote') {
      if (await resolves(root, `refs/heads/${found.branch}`)) {
        return { ok: false, error: `a local ${found.branch} already exists — check that out instead` };
      }
      const res = await git(root, ['checkout', '--track', '-b', found.branch, `refs/remotes/${name}`]);
      return res.ok ? done(`checked out ${found.branch} tracking ${name}`) : { ok: false, error: reason(res, 'git checkout failed') };
    }
    const res = await git(root, ['checkout', found.branch]);
    return res.ok ? done(`switched to ${found.branch}`) : { ok: false, error: reason(res, 'git checkout failed') };
  });
}

/** `git merge --no-edit <name>` into the checked-out branch; conflicts are left for the user. */
export function mergeBranch(root: string, name: string): Promise<Action> {
  return serializeCheckout(root, async () => {
    const invalid = checkName(name);
    if (invalid) return { ok: false, error: invalid };
    if (!(await lookupBranch(root, name))) return { ok: false, error: `no branch named ${name}` };
    if (await repoOperation(root)) return { ok: false, error: 'finish or abort the operation in progress first' };
    const current = await currentBranch(root);
    if (!current) return { ok: false, error: 'HEAD is detached — check out a branch to merge into' };
    const res = await git(root, ['merge', '--no-edit', name]);
    if (!res.ok) return afterStop(root, res, `merging ${name}`, 'git merge failed');
    const said = res.stdout.split('\n').map((l) => l.trim()).find((l) => /up to date|fast-forward|merge made/i.test(l));
    return done(said && /up to date/i.test(said) ? `${current} is already up to date with ${name}` : `merged ${name} into ${current}`);
  });
}

/** How many of the commits `rebase <onto>` would replay are already on a remote. */
async function pushedCommitsToReplay(root: string, onto: string): Promise<number> {
  const [all, unpushed] = await Promise.all([
    git(root, ['rev-list', '--count', `${onto}..HEAD`]),
    git(root, ['rev-list', '--count', `${onto}..HEAD`, '--not', '--remotes']),
  ]);
  const total = Number.parseInt(all.stdout.trim(), 10) || 0;
  const local = Number.parseInt(unpushed.stdout.trim(), 10) || 0;
  return Math.max(total - local, 0);
}

/** `git rebase <name>` of the checked-out branch, refused when it would rewrite pushed commits. */
export function rebaseOnto(root: string, name: string): Promise<Action> {
  return serializeCheckout(root, async () => {
    const invalid = checkName(name);
    if (invalid) return { ok: false, error: invalid };
    if (!(await lookupBranch(root, name))) return { ok: false, error: `no branch named ${name}` };
    if (await repoOperation(root)) return { ok: false, error: 'finish or abort the operation in progress first' };
    const current = await currentBranch(root);
    if (!current) return { ok: false, error: 'HEAD is detached — check out a branch to rebase' };
    if (current === name) return { ok: false, error: `${name} is the checked-out branch` };
    const pushed = await pushedCommitsToReplay(root, name);
    if (pushed > 0) {
      return {
        ok: false,
        error: `${pushed} commit${pushed === 1 ? ' of' : 's of'} ${current} ${pushed === 1 ? 'is' : 'are'} already on a remote — rebasing would rewrite pushed history; merge ${name} instead`,
      };
    }
    const res = await git(root, ['rebase', name]);
    if (!res.ok) return afterStop(root, res, `rebasing onto ${name}`, 'git rebase failed');
    return done(`rebased ${current} onto ${name}`);
  });
}

export interface DeleteBranchOptions {
  remote?: boolean;
  force?: boolean;
}

/** Delete a local branch (`-d`, or `-D` with `force`), and with `remote` the branch on its
 *  remote too (`git push <remote> --delete`, never a force push). */
export function deleteBranch(root: string, name: string, options: DeleteBranchOptions = {}): Promise<Action> {
  return serializeCheckout(root, async () => {
    const invalid = checkName(name);
    if (invalid) return { ok: false, error: invalid };
    const found = await lookupBranch(root, name);
    if (!found) return { ok: false, error: `no branch named ${name}` };
    let target: { remote: string; branch: string } | null = null;
    if (found.kind === 'remote') {
      if (!options.remote) return { ok: false, error: `${name} is on ${found.remote} — confirm deleting it there` };
      target = { remote: found.remote, branch: found.branch };
    } else {
      if (found.branch === (await currentBranch(root))) {
        return { ok: false, error: `${name} is checked out — switch to another branch first` };
      }
      if (options.remote) {
        const up = await git(root, ['for-each-ref', `--format=%(upstream:remotename)${SEP}%(upstream:remoteref)`, `refs/heads/${name}`]);
        const [remote = '', ref = ''] = up.ok ? up.stdout.trim().split(SEP) : [];
        if (remote && ref.startsWith('refs/heads/')) target = { remote, branch: ref.slice('refs/heads/'.length) };
        else {
          const push = (await resolveTaskRemotes(runner(root))).push;
          if (push && (await resolves(root, `refs/remotes/${push}/${name}`))) target = { remote: push, branch: name };
        }
        if (!target) return { ok: false, error: `${name} has no branch on a remote to delete` };
      }
    }
    const said: string[] = [];
    if (target) {
      if (!isSafeGitRef(target.remote) || !isSafeGitRef(target.branch)) return { ok: false, error: `invalid remote branch: ${name}` };
      if (dryRun()) said.push(`dry run — kept ${target.remote}/${target.branch}`);
      else {
        const res = await git(root, [...NETWORK, 'push', target.remote, '--delete', target.branch], { timeout: NETWORK_TIMEOUT_MS });
        if (!res.ok) return { ok: false, error: reason(res, 'git push --delete failed') };
        said.push(`deleted ${target.remote}/${target.branch}`);
      }
    }
    if (found.kind === 'local') {
      const res = await git(root, ['branch', options.force ? '-D' : '-d', found.branch]);
      if (!res.ok) {
        const error = reason(res, 'git branch -d failed');
        return {
          ok: false,
          error: /not fully merged/.test(error) ? `${name} is not fully merged — delete it anyway to lose its commits` : error,
        };
      }
      said.unshift(`deleted ${found.branch}`);
    }
    return done(said.join(', '));
  });
}

/** `git branch -m`. A branch a task owns is refused by the caller (its run record names it). */
export function renameBranch(root: string, name: string, to: string): Promise<Action> {
  return serializeCheckout(root, async () => {
    const invalid = checkName(name) ?? checkName(to);
    if (invalid) return { ok: false, error: invalid };
    const valid = await git(root, ['check-ref-format', '--branch', to]);
    if (!valid.ok) return { ok: false, error: `invalid branch name: ${to}` };
    if (!(await resolves(root, `refs/heads/${name}`))) return { ok: false, error: `no local branch named ${name}` };
    const res = await git(root, ['branch', '-m', name, to]);
    return res.ok ? done(`renamed ${name} to ${to}`) : { ok: false, error: reason(res, 'git branch -m failed') };
  });
}

/** Push a local branch to a named remote, setting its upstream when it has none. Never forced. */
export function pushBranch(root: string, name: string, remote: string): Promise<Action> {
  return serializeCheckout(root, async () => {
    const invalid = checkName(name);
    if (invalid) return { ok: false, error: invalid };
    const remotes = await resolveTaskRemotes(runner(root));
    if (!isSafeGitRef(remote) || !remotes.names.includes(remote)) return { ok: false, error: `no remote named ${remote}` };
    if (!(await resolves(root, `refs/heads/${name}`))) return { ok: false, error: `no local branch named ${name}` };
    if (dryRun()) return done(`dry run — push of ${name} to ${remote} skipped`);
    const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${name}@{u}`]);
    const res = await git(
      root,
      [...NETWORK, 'push', ...(up.ok ? [] : ['-u']), remote, `refs/heads/${name}:refs/heads/${name}`],
      { timeout: NETWORK_TIMEOUT_MS },
    );
    if (!res.ok) return { ok: false, error: reason(res, 'git push failed') };
    return done(`pushed ${name} to ${remote}`);
  });
}

/** `git cherry-pick <sha>` onto the checked-out branch; conflicts are left for the user. */
export function cherryPick(root: string, sha: string): Promise<Action> {
  return serializeCheckout(root, async () => {
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) return { ok: false, error: `not a commit: ${sha}` };
    if (!(await resolves(root, sha))) return { ok: false, error: `unknown commit: ${sha}` };
    if (await repoOperation(root)) return { ok: false, error: 'finish or abort the operation in progress first' };
    const res = await git(root, ['cherry-pick', sha]);
    if (!res.ok) return afterStop(root, res, `cherry-picking ${sha.slice(0, 8)}`, 'git cherry-pick failed');
    return done(`cherry-picked ${sha.slice(0, 8)}`);
  });
}

const OPERATION_VERB = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' } as const;

/** Abort the merge/rebase/cherry-pick in progress, restoring the state before it began. */
export function abortOperation(root: string): Promise<Action> {
  return serializeCheckout(root, async () => {
    const op = await repoOperation(root);
    if (!op) return { ok: false, error: 'no merge, rebase or cherry-pick is in progress' };
    const res = await git(root, [OPERATION_VERB[op.kind], '--abort']);
    return res.ok ? done(`${op.kind} aborted`) : { ok: false, error: reason(res, `git ${op.kind} --abort failed`) };
  });
}

/** Continue the operation once every conflict is resolved and staged. */
export function continueOperation(root: string): Promise<Action> {
  return serializeCheckout(root, async () => {
    const op = await repoOperation(root);
    if (!op) return { ok: false, error: 'no merge, rebase or cherry-pick is in progress' };
    const conflicts = await unmergedPaths(root);
    if (conflicts.length) {
      return { ok: false, error: `resolve and stage ${conflicts.length === 1 ? conflicts[0] : `these ${conflicts.length} files`} first: ${conflicts.slice(0, 5).join(', ')}` };
    }
    const res = await git(root, [OPERATION_VERB[op.kind], '--continue']);
    if (!res.ok) return afterStop(root, res, op.kind, `git ${op.kind} --continue failed`);
    // A rebase may stop again on the next commit.
    const still = await repoOperation(root);
    if (still) {
      const next = await unmergedPaths(root);
      if (next.length) return stopped(op.kind, next);
    }
    return done(`${op.kind} finished`);
  });
}

// ---- compare -----------------------------------------------------------------------------

/** What `ref` brings in over the checked-out branch, from their merge-base. */
export async function compareWithCurrent(root: string, ref: string): Promise<GitOk<{ compare: RepoCompare }>> {
  if (!isSafeGitRef(ref) || !(await resolves(root, ref))) return { ok: false, error: `unknown branch or commit: ${ref}` };
  const current = (await currentBranch(root)) ?? 'HEAD';
  const anchor = await resolveCompareBase(runner(root), current, ref);
  if (!anchor) return { ok: false, error: `${ref} and ${current} share no history` };
  const range = [anchor.mergeBase, ref];
  const [nameStatus, numstat, patch] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', '-M', ...range]),
    git(root, ['diff', '--numstat', '-z', '-M', ...range]),
    git(root, ['diff', '--patch', '-M', '--no-color', ...range]),
  ]);
  for (const listing of [nameStatus, numstat, patch]) {
    if (!listing.ok) return { ok: false, error: reason(listing, 'git diff failed') };
  }
  const payload = assemblePayload(nameStatus.stdout, numstat.stdout, patch.stdout, PATCH_CAP);
  return { ok: true, compare: { ref, against: anchor.against, mergeBase: anchor.mergeBase, files: payload.files, stat: payload.stat } };
}

// ---- stash -----------------------------------------------------------------------------------

export async function listStashes(root: string): Promise<GitOk<{ stashes: RepoStashEntry[] }>> {
  const res = await git(root, ['stash', 'list', `--format=%gd${SEP}%gs${SEP}%cr`]);
  if (!res.ok) return { ok: false, error: reason(res, 'git stash list failed') };
  const stashes = res.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [ref = '', message = '', when = ''] = line.split(SEP);
      const index = /^stash@\{(\d+)\}$/.exec(ref)?.[1];
      return index === undefined ? [] : [{ index: Number(index), message, when }];
    });
  return { ok: true, stashes };
}

export function stashPush(root: string, input: { message?: string; includeUntracked?: boolean }): Promise<GitOk<{ message: string }>> {
  return serializeCheckout(root, async () => {
    const message = input.message?.trim();
    const res = await git(root, ['stash', 'push', ...(input.includeUntracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])]);
    if (!res.ok) return { ok: false, error: reason(res, 'git stash failed') };
    if (/no local changes to save/i.test(res.stdout)) return { ok: false, error: 'no local changes to stash' };
    return { ok: true, message: message ? `stashed “${message}”` : 'stashed' };
  });
}

/** `git stash pop stash@{n}`. A conflicting pop keeps the stash and leaves the markers. */
export function stashPop(root: string, n: number): Promise<Action> {
  return serializeCheckout(root, async () => {
    const list = await listStashes(root);
    if (!list.ok) return list;
    if (!list.stashes.some((entry) => entry.index === n)) return { ok: false, error: `no stash@{${n}}` };
    const res = await git(root, ['stash', 'pop', `stash@{${n}}`]);
    if (!res.ok) {
      const conflicts = await unmergedPaths(root);
      if (conflicts.length) {
        return {
          ok: true,
          message: `the stash conflicts in ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} — it was kept; resolve and stage them`,
          conflicts,
        };
      }
      return { ok: false, error: reason(res, 'git stash pop failed') };
    }
    return done(`popped stash@{${n}}`);
  });
}

// ---- remotes ---------------------------------------------------------------------------------

/** `https://user:token@host/x` → `https://host/x`. */
export function stripCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');
}

export async function listRemotes(root: string): Promise<GitOk<{ remotes: RepoRemotes }>> {
  const [config, refs, resolved] = await Promise.all([
    git(root, ['config', '--get-regexp', '^remote\\.']),
    git(root, ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/remotes']),
    resolveTaskRemotes(runner(root)),
  ]);
  const urls = new Map<string, string>();
  const pushUrls = new Map<string, string>();
  for (const line of config.ok ? config.stdout.split('\n') : []) {
    const m = /^remote\.(.+)\.(url|pushurl) (.*)$/.exec(line.trim());
    if (!m) continue;
    const [, name = '', key, value = ''] = m;
    const into = key === 'url' ? urls : pushUrls;
    if (!into.has(name)) into.set(name, stripCredentials(value));
  }
  const branches = new Map<string, string[]>(resolved.names.map((name) => [name, []]));
  for (const line of refs.ok ? refs.stdout.split('\n') : []) {
    const [full = '', symref = ''] = line.split('\0');
    if (!full || symref) continue;
    const split = splitRemoteRef(full.slice('refs/remotes/'.length), resolved.names);
    const list = split.remote ? branches.get(split.remote) : undefined;
    if (list && list.length < REMOTE_BRANCH_CAP) list.push(split.branch);
  }
  return {
    ok: true,
    remotes: {
      remotes: resolved.names.map((name) => ({
        name,
        url: urls.get(name) ?? null,
        pushUrl: pushUrls.get(name) ?? null,
        branches: branches.get(name) ?? [],
      })),
      prTarget: resolved.base,
      pushDefault: resolved.push,
      reasons: { prTarget: resolved.baseReason, pushDefault: resolved.pushReason },
    },
  };
}

/** `git fetch --prune <remote>`. Skipped under `CEZ_DRY_RUN=1`. */
export function fetchRemote(root: string, remote: string): Promise<GitOk<{ message: string }>> {
  return serializeCheckout(root, async () => {
    const names = (await resolveTaskRemotes(runner(root))).names;
    if (!isSafeGitRef(remote) || !names.includes(remote)) return { ok: false, error: `no remote named ${remote}` };
    if (dryRun()) return { ok: true, message: `dry run — fetch from ${remote} skipped` };
    const res = await git(root, [...NETWORK, 'fetch', '--prune', '--quiet', remote], { timeout: NETWORK_TIMEOUT_MS });
    if (!res.ok) return { ok: false, error: reason(res, 'git fetch failed') };
    return { ok: true, message: `fetched ${remote}` };
  });
}
