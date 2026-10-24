/**
 * The `branch` channel's source (spec 2026-10-23-branch-channel-self-update §3): the updater's OWN
 * clone of the followed branch under `<CEZ_HOME>/source` — never a project, so what is deployed
 * from is never what an agent edits. It holds one branch (`remote.origin.fetch` names only it),
 * full history (ancestry and `diff --name-only` need it) and its `node_modules` between builds.
 * State, not configuration: delete it and the next check clones again.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { updateBranchSchema, type SelfUpdateBranch, type UpdateBranch, type UpdateCommit } from '@open-mercato/cezar-contract';

import { REPO_FETCH_INTERVAL_MS } from '../git-sync.ts';
import { cezarHomeDir } from '../paths.ts';
import { branchInstallId, PACKAGE_NAME } from './layout.ts';

/** The background check's cadence — repo auto-sync's, deliberately (AGENTS.md § Zero config). */
export const BRANCH_CHECK_INTERVAL_MS = REPO_FETCH_INTERVAL_MS;
/** A slow remote must not hold a status poll; the first fetch of a fresh clone gets longer. */
const FETCH_TIMEOUT_MS = 15_000;
const FIRST_FETCH_TIMEOUT_MS = 10 * 60_000;
/** Where the container image records the commit it was built from (spec §4.4). */
export const IMAGE_SOURCE_FILE = '/opt/cezar/source.json';

export function sourceDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'source');
}

/** Held for a build in the clone, across processes (the server's job and a CLI `cezar update`). */
export function sourceLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'source.lock');
}
/** A build that has held the lock this long is a pid that was reused, not a build. */
const SOURCE_LOCK_STALE_MS = 2 * 60 * 60_000;

export class BranchBusyError extends Error {
  constructor(pid: number) {
    super(`another cezar (pid ${pid}) is building in the updater's clone — try again once it finishes`);
  }
}

/** This process, told apart from an earlier one that had the same pid (a container restart
 *  recycles pids from 1): written into the lock beside the pid. */
const LOCK_TOKEN = randomBytes(8).toString('hex');

/** A process's start time in clock ticks since boot (Linux `/proc/<pid>/stat` field 22), or
 *  null where /proc cannot say — then the pid alone has to do. */
export function processStartTicks(pid: number | 'self'): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `comm` (field 2) may hold spaces and parentheses; the fields after its last `)` are fixed.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
  } catch {
    return null;
  }
}

/** The pid of a live process holding the source lock, or null when it is free or stale. A lock
 *  is live only while its pid runs AND is the same process that wrote it (spec 2026-10-23 §3.5). */
export function sourceLockHolder(env: NodeJS.ProcessEnv = process.env): number | null {
  const path = sourceLockPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const [pidText, atText, startText, token] = text.trim().split(/\r?\n/).map((line) => line.trim());
  const pid = Number(pidText);
  const at = Number(atText);
  let since = Number.isFinite(at) ? at : 0;
  if (!since) {
    try {
      since = statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || Date.now() - since > SOURCE_LOCK_STALE_MS) return null;
  // Our own pid: held by this very process, or left by an earlier one the pid was recycled from.
  if (pid === process.pid) return token === LOCK_TOKEN ? pid : null;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null;
  }
  const start = startText ? processStartTicks(pid) : null;
  return start !== null && start !== startText ? null : pid;
}

/** Take the source lock (the skills updater's pattern: `wx`, pid + time, stale when dead). */
function acquireSourceLock(env: NodeJS.ProcessEnv): () => void {
  const path = sourceLockPath(env);
  mkdirSync(cezarHomeDir(env), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid}\n${Date.now()}\n${processStartTicks('self') ?? ''}\n${LOCK_TOKEN}\n`);
      } finally {
        closeSync(fd);
      }
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = sourceLockHolder(env);
      if (holder !== null) throw new BranchBusyError(holder);
      rmSync(path, { force: true });
    }
  }
  throw new BranchBusyError(0);
}

/** The default-on background fetch; `CEZ_SELF_UPDATE_CHECK=0` turns it off (Check still works). */
export function selfUpdateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_SELF_UPDATE_CHECK !== '0';
}

/** `CEZ_UPDATE_BRANCH=<remote>#<branch>`; null when absent or not a remote and a branch. */
export function parseUpdateBranch(value: string | undefined): UpdateBranch | null {
  if (!value) return null;
  const at = value.lastIndexOf('#');
  if (at <= 0) return null;
  const parsed = updateBranchSchema.safeParse({ remote: value.slice(0, at).trim(), branch: value.slice(at + 1).trim() });
  return parsed.success ? parsed.data : null;
}

const imageSourceSchema = z
  .object({
    commit: z.string().catch(''),
    branch: z.string().catch(''),
    remote: z.string().catch(''),
    committedAt: z.string().catch(''),
  })
  .passthrough();
export type ImageSource = z.infer<typeof imageSourceSchema>;

/** The image's `/opt/cezar/source.json`, or null outside the container (or a build without args). */
export function readImageSource(file: string = IMAGE_SOURCE_FILE): ImageSource | null {
  try {
    const parsed = imageSourceSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The branch an image's source names, when it names a valid one. */
export function imageSourceBranch(file?: string): UpdateBranch | null {
  const source = readImageSource(file);
  if (!source) return null;
  const parsed = updateBranchSchema.safeParse({ remote: source.remote, branch: source.branch });
  return parsed.success ? parsed.data : null;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type GitRunner = (cwd: string, args: string[], opts: { timeout?: number; env: NodeJS.ProcessEnv }) => Promise<GitResult>;

/** Run git, never throw; never prompt for a password a browser cannot type. */
export const runGit: GitRunner = (cwd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', timeout: opts.timeout, env: { ...opts.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });

const firstLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
    ?.replace(/^(error|fatal):\s*/, '') ?? '';

const versionSchema = z.object({ name: z.string(), version: z.string().min(1) }).passthrough();

/** The followed branch's clone. Every method answers; a git failure is a null or a false. */
export class BranchSource {
  readonly dir: string;
  /** The remote this process's own build follows, while it holds the source lock. */
  private building: string | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly git: GitRunner = runGit,
  ) {
    this.dir = sourceDir(env);
  }

  private run(args: string[], timeout?: number): Promise<GitResult> {
    return this.git(this.dir, args, { timeout, env: this.env });
  }

  private trackingRef(branch: string): string {
    return `refs/remotes/origin/${branch}`;
  }

  /** Hold the source lock for one build of `target`; throws `BranchBusyError` when another
   *  process holds it. Returns the release. */
  lock(target: UpdateBranch): () => void {
    const release = acquireSourceLock(this.env);
    this.building = target.remote;
    return () => {
      this.building = null;
      release();
    };
  }

  /** The clone exists and its `origin` is `target.remote` — re-created when the remote changed,
   *  but never under a build (this process's, for another remote, or any other process's). */
  async ensure(target: UpdateBranch): Promise<{ ok: true } | { ok: false; error: string }> {
    if (existsSync(join(this.dir, '.git'))) {
      // The configured value, not `remote get-url`: that one applies `insteadOf` rewrites.
      const url = await this.run(['config', '--get', 'remote.origin.url']);
      if (url.ok && url.stdout.trim() === target.remote) return this.setFetchSpec(target);
      const busy = this.building !== null ? this.building !== target.remote : sourceLockHolder(this.env) !== null;
      if (busy) return { ok: false, error: 'a build is running in the updater\'s clone — the new remote is fetched once it finishes' };
      rmSync(this.dir, { recursive: true, force: true });
    }
    mkdirSync(this.dir, { recursive: true });
    for (const args of [
      ['init', '--quiet'],
      ['remote', 'add', 'origin', target.remote],
    ]) {
      const result = await this.run(args);
      if (!result.ok) return { ok: false, error: firstLine(result.stderr) || `git ${args[0]} failed` };
    }
    return this.setFetchSpec(target);
  }

  /** `--single-branch`'s shape: origin fetches the followed branch and nothing else. */
  private async setFetchSpec(target: UpdateBranch): Promise<{ ok: true } | { ok: false; error: string }> {
    const spec = `+refs/heads/${target.branch}:${this.trackingRef(target.branch)}`;
    const set = await this.run(['config', 'remote.origin.fetch', spec]);
    return set.ok ? { ok: true } : { ok: false, error: firstLine(set.stderr) || 'git config failed' };
  }

  /** One bounded fetch of the followed branch. */
  async fetch(target: UpdateBranch): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.env.CEZ_DRY_RUN === '1') return { ok: false, error: 'CEZ_DRY_RUN=1 — nothing is fetched' };
    const ready = await this.ensure(target);
    if (!ready.ok) return ready;
    const first = (await this.tipSha(target)) === null;
    const spec = `+refs/heads/${target.branch}:${this.trackingRef(target.branch)}`;
    const fetched = await this.run(
      ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', spec],
      first ? FIRST_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS,
    );
    if (fetched.ok) return { ok: true };
    return { ok: false, error: firstLine(fetched.stderr) || 'git fetch failed (timed out or offline)' };
  }

  /** The tip as of the last fetch, or null before the first. */
  async tipSha(target: UpdateBranch): Promise<string | null> {
    if (!existsSync(join(this.dir, '.git'))) return null;
    const tip = await this.run(['rev-parse', '--verify', '--quiet', `${this.trackingRef(target.branch)}^{commit}`]);
    return tip.ok && tip.stdout.trim() ? tip.stdout.trim() : null;
  }

  /** A commit's full sha, subject and committer date — or null when the clone does not have it. */
  async commit(rev: string): Promise<UpdateCommit | null> {
    if (!/^[0-9a-f]{4,40}$/i.test(rev) && !rev.startsWith('refs/')) return null;
    const shown = await this.run(['show', '-s', '--format=%H%x1f%cI%x1f%s', `${rev}^{commit}`, '--']);
    if (!shown.ok) return null;
    const [sha, at, subject] = shown.stdout.trim().split('\x1f');
    if (!sha || !at) return null;
    return { sha, subject: subject ?? '', at: new Date(at).toISOString() };
  }

  /** The cezar package version a commit carries — the `<version>` of its install id. */
  async versionAt(sha: string): Promise<string | null> {
    for (const path of ['packages/cezar/package.json', 'package.json']) {
      const shown = await this.run(['show', `${sha}:${path}`]);
      if (!shown.ok) continue;
      try {
        const pkg = versionSchema.safeParse(JSON.parse(shown.stdout));
        if (pkg.success && pkg.data.name === PACKAGE_NAME) return pkg.data.version;
      } catch {
        // Not JSON at that path: try the next layout.
      }
    }
    return null;
  }

  /** The install id a commit builds into, `<version>+<sha8>`. */
  async installIdAt(sha: string): Promise<string | null> {
    const version = await this.versionAt(sha);
    try {
      return version ? branchInstallId(version, sha) : null;
    } catch {
      return null;
    }
  }

  private async count(from: string, to: string): Promise<number | null> {
    const counted = await this.run(['rev-list', '--count', to, `^${from}`, '--']);
    const n = Number(counted.stdout.trim());
    return counted.ok && Number.isFinite(n) ? n : null;
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.run(['merge-base', '--is-ancestor', a, b])).ok;
  }

  /** The `docker/` paths that differ between two commits — an image rebuild is also due. */
  private async imagePaths(from: string, to: string): Promise<string[]> {
    const diff = await this.run(['diff', '--name-only', from, to, '--', 'docker/']);
    return diff.ok ? diff.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  }

  /**
   * The status panel's numbers, from local reads only (no network). `running` is the commit the
   * running build came from; when it is unknown (a registry install, an image built without its
   * source args) or not in the clone (a force-push dropped it), the tip is offered as one step.
   */
  async view(
    target: UpdateBranch,
    running: UpdateCommit | null,
  ): Promise<Omit<SelfUpdateBranch, 'fetchedAt' | 'error'> & { tipId: string | null }> {
    const base = { remote: target.remote, branch: target.branch, running };
    const tipSha = await this.tipSha(target);
    const tip = tipSha ? await this.commit(tipSha) : null;
    if (!tip) return { ...base, tip: null, behind: 0, fastForward: true, touchesImage: [], tipId: null };
    const tipId = await this.installIdAt(tip.sha);
    if (running && tip.sha.startsWith(running.sha.toLowerCase())) {
      return { ...base, tip, behind: 0, fastForward: true, touchesImage: [], tipId };
    }
    const known = running ? await this.commit(running.sha) : null;
    if (!known) return { ...base, tip, behind: 1, fastForward: false, touchesImage: [], tipId };
    const behind = (await this.count(known.sha, tip.sha)) ?? 0;
    return {
      ...base,
      tip,
      behind,
      fastForward: await this.isAncestor(known.sha, tip.sha),
      touchesImage: behind > 0 ? await this.imagePaths(known.sha, tip.sha) : [],
      tipId,
    };
  }

  /** Resolve a short sha the clone has to its full sha. */
  async resolve(short: string): Promise<string | null> {
    return (await this.commit(short))?.sha ?? null;
  }

  /** Put the work tree on `sha`, discarding whatever an earlier attempt left — ignored build
   *  output too (a stale `dist/` would ship in `npm pack`), but never `node_modules`, so
   *  installs survive between builds. */
  async checkout(sha: string): Promise<void> {
    for (const args of [
      ['checkout', '--quiet', '--detach', '--force', sha],
      ['reset', '--quiet', '--hard', sha],
      ['clean', '--quiet', '-fdx', '-e', 'node_modules'],
    ]) {
      const result = await this.run(args, 5 * 60_000);
      if (!result.ok) throw new Error(`git ${args[0]} ${sha.slice(0, 8)} failed: ${firstLine(result.stderr)}`);
    }
  }
}
