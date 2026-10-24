/**
 * The self-update service behind `/api/v1/workspace/self-update` and `cezar update`. Owns the
 * registry cache, the release-channel setting, the managed-layout view and the ONE install job
 * a process runs at a time. Applying an update = install (npm) → activate (`current` link) →
 * restart (re-exec, or exit for a supervisor to relaunch — see `restart.ts`). The `branch`
 * channel builds its install from a git branch first (spec 2026-10-23, `branch.ts`).
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
  SelfUpdateBranch,
  SelfUpdateDevelopment,
  SelfUpdateJob,
  SelfUpdateScheduled,
  SelfUpdateStatus,
  UpdateBranch,
  UpdateChannel,
  UpdateCommit,
} from '@open-mercato/cezar-contract';

import { loadWorkspaceConfig, mergeWriteWorkspaceConfig, seedUpdateBranchChannel } from '../workspace/config.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { installFromLocal, installFromRegistry, runNpm } from './installer.ts';
import { buildCheckout, discoverCheckouts } from './checkouts.ts';
import {
  BRANCH_CHECK_INTERVAL_MS,
  BranchSource,
  IMAGE_SOURCE_FILE,
  imageSourceBranch,
  parseUpdateBranch,
  readImageSource,
  selfUpdateCheckEnabled,
  type GitRunner,
} from './branch.ts';
import {
  activate,
  activeId,
  CURRENT_LINK,
  detectInstallKind,
  findInstalled,
  isBranchInstallId,
  linkCheckout,
  listInstalled,
  packageRootOf,
  previousId,
  readManifest,
  removeInstalled,
  versionsDir,
  type InstallKind,
} from './layout.ts';
import { CEZAR_REPO, fetchOpenPulls, OpenPullsCache, type OpenPulls } from './pulls.ts';
import { distTagFor, RegistryCache, type PackageDocument } from './registry.ts';
import { clearRollback, readRollback } from './rollback.ts';
import { classifyVersion, compareVersions, isNewer } from './semver.ts';

const LOG_CAP = 200;
/** How often a scheduled "update when idle" re-checks the workspace. */
const IDLE_POLL_MS = 5_000;
/** `branch` builds kept on disk after an activate (spec §3.5); registry installs are not pruned. */
const BRANCH_BUILDS_KEPT = 3;

export interface SelfUpdateDeps {
  pkgName: string;
  version: string;
  /** What the dialog shows as running (`0.15.2-dev` for a checkout); update checks keep `version`. */
  displayVersion?: string;
  /** The running entry file (`process.argv[1]`). */
  entry: string;
  /** Exit-or-reexec policy; the service only decides WHEN. */
  restart: () => void;
  /** The workspace's run counters — in production the `WorkspaceSemaphore` itself, so the dialog
   *  can never again read one project's store (#1524). Absent: nothing runs. */
  runs?: Pick<WorkspaceSemaphore, 'activeRuns' | 'idle'>;
  /** Test seam for the idle poll's interval. */
  idlePollMs?: number;
  /** Hosted mode trims the absolute entry path off the wire (#431). */
  trimPaths?: () => boolean;
  /** Whether the caller may change the channel and the followed branch — the same
   *  `trustedOperator()` the `PUT …/channel` route enforces. Absent: yes. */
  channelEditable?: () => boolean;
  supervised?: boolean;
  /** Report only: `capability()` answers false whatever the install kind, so `apply()` can
   *  never install or activate. For a service that has no way to restart the process. */
  readOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  registry?: RegistryCache;
  /** cezar's open pull requests, for the development channel. Defaults to GitHub. */
  pulls?: () => Promise<OpenPulls>;
  /** Builds an unbuilt or stale checkout before it is linked. Defaults to npm in the worktree. */
  buildCheckout?: typeof buildCheckout;
  /** npm for the branch channel's build and pack; tests substitute one that touches no network. */
  runNpm?: typeof runNpm;
  /** git for the branch channel's clone. */
  git?: GitRunner;
  /** The container image's source record (spec §4.4); the last seed of the followed branch. */
  imageSourceFile?: string;
  /** A branch check found (or lost) a newer build: the health chip's `latestVersion`. */
  onUpdateAvailable?: (target: string | null) => void;
}

export class SelfUpdateBusyError extends Error {
  constructor() {
    super('an update is already running');
  }
}

type BranchView = SelfUpdateBranch & { tipId: string | null };

export class SelfUpdateService {
  readonly installKind: InstallKind;
  private readonly registry: RegistryCache;
  private readonly env: NodeJS.ProcessEnv;
  private job: SelfUpdateJob | null = null;
  private scheduled: SelfUpdateScheduled | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pulls: OpenPullsCache;
  readonly source: BranchSource;
  /** The install this process runs, resolved once: `current` may be flipped under it later. */
  private readonly runningId: string | null;
  /** The branch check: last attempt (throttle), last success, last error, the one in flight. */
  private check: { key: string; attemptAt: number | null; fetchedAt: string | null; error?: string; inflight: Promise<void> | null } = {
    key: '',
    attemptAt: null,
    fetchedAt: null,
    inflight: null,
  };
  private branchCache: { key: string; view: BranchView } | null = null;

  constructor(private readonly deps: SelfUpdateDeps) {
    this.env = deps.env ?? process.env;
    this.installKind = detectInstallKind(deps.entry, this.env);
    this.registry = deps.registry ?? new RegistryCache(deps.pkgName);
    this.pulls = new OpenPullsCache(deps.pulls ?? (() => fetchOpenPulls(CEZAR_REPO, { env: this.env })));
    this.source = new BranchSource(this.env, deps.git);
    this.runningId = runningInstallId(deps.entry, this.env);
  }

  /** The raw running version — what update checks compare, never the shown `-dev` one. */
  get runningVersion(): string {
    return this.deps.version;
  }

  /** The configured channel: workspace config wins, then `CEZ_UPDATE_CHANNEL`, then stable. */
  async channel(): Promise<UpdateChannel> {
    const config = await loadWorkspaceConfig();
    if (config.updateChannel) return config.updateChannel;
    const seed = this.env.CEZ_UPDATE_CHANNEL;
    return seed === 'nightly' || seed === 'development' || seed === 'branch' ? seed : 'stable';
  }

  /** The branch the `branch` channel follows: workspace config, then `CEZ_UPDATE_BRANCH`, then
   *  the container image's own source. Null when none of them names a valid one. */
  async updateBranch(): Promise<UpdateBranch | null> {
    const config = await loadWorkspaceConfig();
    if (config.updateBranch) return { remote: config.updateBranch.remote, branch: config.updateBranch.branch };
    return parseUpdateBranch(this.env.CEZ_UPDATE_BRANCH) ?? imageSourceBranch(this.deps.imageSourceFile ?? IMAGE_SOURCE_FILE);
  }

  /** In the container, save the boot's branch seed (spec §4.5): the entrypoint exports it to the
   *  server only, so `docker compose exec … cezar update` would otherwise follow stable. */
  async persistImageSeed(): Promise<boolean> {
    if (!readImageSource(this.deps.imageSourceFile ?? IMAGE_SOURCE_FILE)) return false;
    if ((await this.channel()) !== 'branch') return false;
    const branch = await this.updateBranch();
    return branch ? seedUpdateBranchChannel(branch) : false;
  }

  async setChannel(channel: UpdateChannel, branch?: UpdateBranch): Promise<void> {
    if (channel === 'branch' && !branch && !(await this.updateBranch())) {
      throw new Error('the branch channel needs a branch to follow — give a remote and a branch, or set CEZ_UPDATE_BRANCH=<remote>#<branch>');
    }
    await mergeWriteWorkspaceConfig((config) => {
      config.updateChannel = channel;
      if (branch) config.updateBranch = { remote: branch.remote, branch: branch.branch };
    });
    this.branchCache = null;
  }

  /** The channel's newest version when it is newer than the running one — what health's
   *  `latestVersion` reports and the version chip pulses for. The branch channel answers from
   *  its clone without fetching: the boot check must not reach the network on its behalf. */
  async updateAvailable(refresh = false): Promise<string | null> {
    const channel = await this.channel();
    if (channel === 'branch') {
      const view = await this.branchView(refresh);
      return view && view.behind > 0 ? view.tipId : null;
    }
    const doc = refresh ? await this.registry.refresh() : await this.registry.get();
    // Development runs whatever was picked by hand; nothing is ever "newer" than a worktree.
    if (!doc || channel === 'development') return null;
    const target = doc.distTags[distTagFor(channel)];
    return target && isNewer(target, this.deps.version) ? target : null;
  }

  /** "A cockpit is asking" (spec §3.3): start the branch channel's background fetch when one is
   *  due. At most one per `BRANCH_CHECK_INTERVAL_MS`, never with `CEZ_SELF_UPDATE_CHECK=0`. */
  touch(): void {
    if (!selfUpdateCheckEnabled(this.env)) return;
    void (async () => {
      if ((await this.channel()) !== 'branch') return;
      const branch = await this.updateBranch();
      if (!branch) return;
      const key = branchKey(branch);
      const state = this.check.key === key ? this.check : null;
      if (state?.inflight) return;
      if (state?.attemptAt != null && Date.now() - state.attemptAt < BRANCH_CHECK_INTERVAL_MS) return;
      await this.fetchBranch(branch);
    })().catch(() => {});
  }

  /** Fetch the followed branch now (single-flight), then recompute the view and tell the chip. */
  private fetchBranch(branch: UpdateBranch): Promise<void> {
    const key = branchKey(branch);
    if (this.check.key !== key) this.check = { key, attemptAt: null, fetchedAt: null, inflight: null };
    const state = this.check;
    if (state.inflight) return state.inflight;
    state.attemptAt = Date.now();
    state.inflight = (async () => {
      const fetched = await this.source.fetch(branch);
      if (fetched.ok) {
        state.fetchedAt = new Date().toISOString();
        delete state.error;
      } else {
        state.error = fetched.error;
      }
      this.branchCache = null;
      const view = await this.branchView(false);
      this.deps.onUpdateAvailable?.(view && view.behind > 0 ? view.tipId : null);
    })().finally(() => {
      state.inflight = null;
    });
    return state.inflight;
  }

  /** The branch panel, from the clone (cached until the next fetch). `refresh` fetches first. */
  private async branchView(refresh: boolean): Promise<BranchView | null> {
    const branch = await this.updateBranch();
    if (!branch) return null;
    if (refresh) await this.fetchBranch(branch);
    const key = `${branchKey(branch)}@${this.runningCommit()?.sha ?? ''}`;
    if (this.branchCache?.key !== key) {
      const local = await this.source.view(branch, this.runningCommit());
      this.branchCache = { key, view: { ...local, fetchedAt: null } };
    }
    const check = this.check.key === branchKey(branch) ? this.check : null;
    return {
      ...this.branchCache.view,
      fetchedAt: check?.fetchedAt ?? null,
      ...(check?.error ? { error: check.error } : {}),
    };
  }

  /** The commit the running build came from; null for a registry or local install. */
  private runningCommit(): UpdateCommit | null {
    const commit = this.runningId ? readManifest(this.runningId, this.env)?.commit : undefined;
    return commit ? { sha: commit.sha, subject: commit.subject, at: commit.at } : null;
  }

  /** Read the status without waiting on the network: the cached document answers, and a stale
   *  or missing one is refreshed behind the response. `refresh` forces a registry round trip
   *  (and, on the branch channel, a fetch of the followed branch). */
  async status(opts: { refresh?: boolean } = {}): Promise<SelfUpdateStatus> {
    let doc: PackageDocument | null;
    if (opts.refresh) doc = await this.registry.refresh();
    else {
      doc = this.registry.current();
      void this.registry.get().catch(() => {});
    }
    const channel = await this.channel();
    if (channel === 'branch' && !opts.refresh) this.touch();
    const branchView = channel === 'branch' ? await this.branchView(opts.refresh === true) : null;
    const installed = listInstalled(this.env);
    const installedIds = new Set(installed.map((entry) => entry.id));
    const stable = doc?.distTags.latest ?? null;
    const nightly = doc?.distTags.nightly ?? null;
    const target = channel === 'stable' ? stable : channel === 'nightly' ? nightly : null;
    const { canSelfUpdate, reason } = this.capability();
    const trim = this.deps.trimPaths?.() ?? false;
    const rollback = readRollback(this.env);
    let branch: SelfUpdateBranch | undefined;
    if (branchView) {
      const { tipId: _tipId, ...rest } = branchView;
      branch = rest;
    }
    return {
      version: this.deps.displayVersion ?? this.deps.version,
      installKind: this.installKind,
      entry: trim ? this.deps.entry.split(/[\\/]/).pop() ?? '' : this.deps.entry,
      canSelfUpdate,
      ...(reason ? { reason } : {}),
      channel,
      restartMode: this.deps.supervised ? 'supervisor' : 'reexec',
      latest: { stable, nightly },
      updateAvailable:
        channel === 'branch'
          ? branchView && branchView.behind > 0
            ? branchView.tipId
            : null
          : target && isNewer(target, this.deps.version)
            ? target
            : null,
      checkedAt: channel === 'branch' ? (branchView?.fetchedAt ?? null) : (doc?.fetchedAt ?? null),
      installed: installed.map((entry) => ({
        id: entry.id,
        version: entry.version,
        source: entry.source,
        installedAt: entry.installedAt,
        active: entry.active,
        ...(entry.branch ? { branch: entry.branch } : {}),
        ...(entry.checkout && !trim ? { checkout: entry.checkout } : {}),
        ...(entry.commit ? { commit: { sha: entry.commit.sha, subject: entry.commit.subject, at: entry.commit.at, branch: entry.commit.branch } } : {}),
      })),
      // Previews (`-pr123.`, `-develop.`) are noise in a picker meant for stable ↔ nightly
      // moves; the PoC lists stable releases and nightlies only.
      available: (doc?.versions ?? [])
        .filter((entry) => entry.channel !== 'preview')
        .slice(0, 60)
        .map((entry) => ({
          version: entry.version,
          channel: entry.channel,
          publishedAt: entry.publishedAt,
          installed: installedIds.has(entry.version),
        })),
      job: this.job,
      scheduled: this.scheduled,
      activeRuns: this.deps.runs?.activeRuns() ?? 0,
      channelEditable: this.deps.channelEditable?.() ?? true,
      ...(branch ? { branch } : {}),
      ...(rollback ? { rollback } : {}),
    };
  }

  /**
   * What the development channel picks from: cezar's own worktrees and the open pull requests
   * with a published preview build. Worktrees only on a local cockpit — linking a checkout runs
   * whatever is in it, a local-machine gesture a hosted cockpit neither offers nor accepts (see
   * `linkDiscovered`), and never worth a git call there.
   */
  async development(opts: { refresh?: boolean } = {}): Promise<SelfUpdateDevelopment> {
    const trim = this.deps.trimPaths?.() ?? false;
    const [checkouts, pulls, doc] = await Promise.all([
      trim ? Promise.resolve([]) : discoverCheckouts(this.env).catch(() => []),
      this.pulls.get(opts.refresh),
      opts.refresh ? this.registry.refresh() : this.registry.get(),
    ]);
    const installedIds = new Set(listInstalled(this.env).map((entry) => entry.id));
    const publishedAt = (version: string) => doc?.versions.find((entry) => entry.version === version)?.publishedAt ?? null;
    const prByBranch = new Map(pulls.items.map((pull) => [pull.branch, pull.number]));
    return {
      checkouts: checkouts.map((checkout) => ({
        id: checkout.id,
        branch: checkout.branch,
        version: checkout.version,
        worktree: checkout.worktree,
        built: checkout.built,
        linked: checkout.linked,
        commit: checkout.commit,
        builtAt: checkout.builtAt,
        stale: checkout.stale,
        task: checkout.task,
        pr: prByBranch.get(checkout.branch) ?? null,
      })),
      pulls: {
        available: pulls.available,
        ...(pulls.reason ? { reason: pulls.reason } : {}),
        repo: CEZAR_REPO,
        items: pulls.items.map((pull) => {
          const version = doc?.distTags[`pr-${pull.number}`] ?? null;
          return {
            ...pull,
            version,
            publishedAt: version ? publishedAt(version) : null,
            installed: version ? installedIds.has(version) : false,
          };
        }),
      },
    };
  }

  /**
   * Whether a HOSTED cockpit may apply `target` — hosted updates are forward-only, and "forward"
   * has to mean forward in TIME, not merely in semver order. cezar's nightlies are versioned
   * `<next-version>-nightly.<date>.<run>`, so every `0.13.0-nightly.*` outranks every later
   * `0.12.x` patch: a semver-only rule would let a hosted cockpit on 0.12.1 install a 0.13.0
   * nightly cut months earlier and restart into code that predates the guards this rule exists
   * to protect. The registry's publish dates are the honest signal; when it cannot supply them
   * (offline, or a version it does not list) the residual risk is a prerelease outranking a
   * release, so that shape is refused outright. A branch build is dated by its COMMITTER date.
   *
   * Returns the refusal reason, or null when the target may be applied.
   */
  async forwardOnlyRefusal(target: string): Promise<string | null> {
    const running = this.deps.version;
    const suffix = 'apply it on the host itself (`cezar use <id>`)';
    const installed = findInstalled(target, this.env);
    if (installed?.source === 'branch' || installed?.source === 'image' || (!installed && isBranchInstallId(target))) {
      return this.branchForwardRefusal(target, installed?.commit?.at ?? null, suffix);
    }
    if (!isNewer(target, running)) {
      return `a hosted cockpit can only update forward — ${target} is not newer than the running ${running}; ${suffix}`;
    }
    const doc = this.registry.current() ?? (await this.registry.get());
    const publishedAt = (version: string) => doc?.versions.find((entry) => entry.version === version)?.publishedAt ?? null;
    const targetAt = publishedAt(target);
    const runningAt = publishedAt(running);
    if (targetAt && runningAt) {
      return targetAt >= runningAt
        ? null
        : `a hosted cockpit can only update forward — ${target} was published before the running ${running}; ${suffix}`;
    }
    if (classifyVersion(target) !== 'stable' && classifyVersion(running) === 'stable') {
      return `a hosted cockpit can only update forward — ${target} is a prerelease and the registry gave no publish date to check it against; ${suffix}`;
    }
    return null;
  }

  /** Forward-only for a branch build (spec §3.6): committed no earlier than the running build.
   *  Ancestry is reported on the status, never enforced here. */
  private async branchForwardRefusal(target: string, committedAt: string | null, suffix: string): Promise<string | null> {
    const targetAt = committedAt ?? (await this.source.commit(target.split('+').pop() ?? ''))?.at ?? null;
    if (!targetAt) return `a hosted cockpit can only update forward — cezar cannot date ${target}'s commit; ${suffix}`;
    const runningAt = this.runningCommit()?.at;
    if (runningAt) {
      return Date.parse(targetAt) >= Date.parse(runningAt)
        ? null
        : `a hosted cockpit can only update forward — ${target} was committed before the running build; ${suffix}`;
    }
    // No running commit (a registry release, an image built without CEZ_SOURCE_*): never step back
    // a release, and never take a commit older than the running install (an image's: its build time).
    if (compareVersions(target.split('+')[0] ?? target, this.deps.version) < 0) {
      return `a hosted cockpit can only update forward — ${target} is older than the running ${this.deps.version}; ${suffix}`;
    }
    const runningInstalledAt = this.runningId ? readManifest(this.runningId, this.env)?.installedAt : undefined;
    const installedMs = runningInstalledAt ? Date.parse(runningInstalledAt) : Number.NaN;
    if (Number.isFinite(installedMs) && Date.parse(targetAt) < installedMs) {
      return `a hosted cockpit can only update forward — ${target} was committed before the running ${this.deps.version} was installed (${runningInstalledAt}), and that build carries no commit to compare with; ${suffix}`;
    }
    return null;
  }

  capability(): { canSelfUpdate: boolean; reason?: string } {
    if (this.deps.readOnly) return { canSelfUpdate: false, reason: 'This cezar was started without an updater.' };
    switch (this.installKind) {
      case 'managed':
        return { canSelfUpdate: true };
      case 'npx':
        return {
          canSelfUpdate: false,
          reason: 'This cezar runs from the npx cache, which npx replaces on its own. Install it permanently to update from here.',
        };
      case 'global-npm':
        return {
          canSelfUpdate: false,
          reason: 'This cezar was installed with npm -g. Update it with npm, or install the managed layout to update from here.',
        };
      case 'checkout':
        return { canSelfUpdate: false, reason: 'This cezar runs from a git checkout — rebuild it instead of updating.' };
      default:
        return { canSelfUpdate: false, reason: 'cezar could not tell how it was installed.' };
    }
  }

  /**
   * Install `target` (a registry version, an already-installed id such as `0.11.1+local`, the
   * id of a built cezar checkout `status()` lists — linked on the spot — or, on the branch
   * channel, a `<version>+<sha8>` built from the followed branch), activate it and restart.
   * Returns as soon as the job is started; progress is on `status()`. A branch build switches
   * only once the workspace is idle when `whenIdle` asks for it or runs are active (spec §3.5):
   * the build itself never waits.
   */
  apply(target: string, opts: { whenIdle?: boolean } = {}): SelfUpdateJob {
    if (this.job?.status === 'running' || this.job?.status === 'restarting') throw new SelfUpdateBusyError();
    const { canSelfUpdate, reason } = this.capability();
    if (!canSelfUpdate) throw new Error(reason ?? 'self-update is not available for this install');
    // An explicit apply supersedes whatever was waiting for idle.
    this.cancelScheduled();
    const job: SelfUpdateJob = { status: 'running', target, startedAt: new Date().toISOString(), finishedAt: null, log: [] };
    this.job = job;
    const log = (line: string) => {
      job.log.push(line);
      if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
    };
    void (async () => {
      try {
        const installed = findInstalled(target, this.env);
        if (!installed && (await this.isBranchTarget(target))) {
          const id = await this.buildBranch(target, log);
          if (opts.whenIdle || !this.idle()) {
            log(`built ${id} — switching once no task is running`);
            // The build is done; what is left is the idle wait the dialog already shows.
            if (this.job === job) this.job = null;
            this.waitForIdle(id);
            return;
          }
          this.switchTo(id, job, log);
          return;
        }
        if (opts.whenIdle) {
          // `scheduleWhenIdle` guessed a branch build from the id's shape; it is not one.
          if (this.job === job) this.job = null;
          this.waitForIdle(target);
          return;
        }
        // A linked checkout goes through discovery too: it may need a rebuild before it runs.
        const linked = !installed || installed.source === 'link' ? await this.linkDiscovered(target, log) : null;
        const id = linked ?? installed?.id ?? (await installFromRegistry(target, { onLog: log, env: this.env })).id;
        if (installed && !linked) log(`${id} is already installed`);
        this.switchTo(id, job, log);
      } catch (error) {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.error = error instanceof Error ? error.message : String(error);
        log(`failed: ${job.error}`);
      }
    })();
    return job;
  }

  /** Activate, prune, and hand over to the restart. */
  private switchTo(id: string, job: SelfUpdateJob, log: (line: string) => void): void {
    activate(id, this.env);
    log(`activated ${id}`);
    clearRollback(this.env);
    if (readManifest(id, this.env)?.source === 'branch') this.pruneBranchBuilds(log);
    job.status = 'restarting';
    job.finishedAt = new Date().toISOString();
    log('restarting…');
    // Let the status poll that observes `restarting` get its answer before the listener goes.
    setTimeout(() => this.deps.restart(), 750);
  }

  private idle(): boolean {
    return !this.deps.runs || this.deps.runs.idle();
  }

  /** A target the branch channel builds: an id shaped `<version>+<sha8>`, on that channel. */
  private async isBranchTarget(target: string): Promise<boolean> {
    return isBranchInstallId(target) && (await this.channel()) === 'branch';
  }

  /**
   * Build `target` from the followed branch into `versions/<version>+<sha8>` (spec §3.5 steps
   * 1–3). A failure leaves `current` and `previous` untouched and the clone on the attempted sha
   * — the next attempt resets it.
   */
  private async buildBranch(target: string, log: (line: string) => void): Promise<string> {
    const branch = await this.updateBranch();
    if (!branch) throw new Error('the branch channel has no branch to follow');
    // One build in the clone at a time, across processes: the server's job and `cezar update`.
    const release = this.source.lock(branch);
    try {
      log(`fetching ${branch.branch} from ${branch.remote}`);
      await this.fetchBranch(branch);
      if (this.check.error) log(`fetch failed (${this.check.error}) — building from the clone as it is`);
      const short = target.split('+').pop() ?? '';
      const commit = await this.source.commit(short);
      if (!commit) throw new Error(`commit ${short} is not on ${branch.branch}`);
      const id = await this.source.installIdAt(commit.sha);
      if (id !== target) throw new Error(`${target} does not name commit ${short} (it builds as ${id ?? 'nothing cezar can install'})`);
      log(`checking out ${commit.sha.slice(0, 8)} — ${commit.subject}`);
      await this.source.checkout(commit.sha);
      const npm: typeof runNpm = (args, cwd, onLog) => (this.deps.runNpm ?? runNpm)(args, cwd, onLog, { nice: true });
      await (this.deps.buildCheckout ?? buildCheckout)({ worktree: this.source.dir, packageRoot: join(this.source.dir, 'packages', 'cezar') }, log, npm);
      const result = await installFromLocal(join(this.source.dir, 'packages', 'cezar'), {
        onLog: log,
        env: this.env,
        runNpm: npm,
        branchCommit: { ...commit, branch: branch.branch },
      });
      return result.id;
    } finally {
      release();
    }
  }

  /** Keep the newest `BRANCH_BUILDS_KEPT` branch builds; never the active one or `previous`. */
  private pruneBranchBuilds(log: (line: string) => void): void {
    const keep = new Set([activeId(this.env), previousId(this.env)]);
    const builds = listInstalled(this.env).filter((entry) => entry.source === 'branch');
    for (const entry of builds.slice(BRANCH_BUILDS_KEPT)) {
      if (keep.has(entry.id)) continue;
      try {
        removeInstalled(entry.id, this.env);
        log(`removed the older build ${entry.id}`);
      } catch {
        // Not removable right now: the next prune tries again.
      }
    }
  }

  /**
   * "Update when idle": apply `target` once no task is running or queued, so the user can close
   * the dialog and keep working. Applies at once when the workspace is already idle; replaces an
   * earlier schedule. The same refusals as `apply()` are raised up front. A branch build that is
   * not on disk yet starts building now and only its switch waits.
   */
  scheduleWhenIdle(target: string): void {
    if (this.job?.status === 'running' || this.job?.status === 'restarting') throw new SelfUpdateBusyError();
    const { canSelfUpdate, reason } = this.capability();
    if (!canSelfUpdate) throw new Error(reason ?? 'self-update is not available for this install');
    if (!findInstalled(target, this.env) && isBranchInstallId(target)) {
      // The channel is checked again inside `apply`; a non-branch id falls through to the registry.
      this.apply(target, { whenIdle: true });
      return;
    }
    this.waitForIdle(target);
  }

  private waitForIdle(target: string): void {
    this.scheduled = { target, requestedAt: new Date().toISOString() };
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => this.applyIfIdle(), this.deps.idlePollMs ?? IDLE_POLL_MS);
      this.idleTimer.unref?.();
    }
    this.applyIfIdle();
  }

  cancelScheduled(): void {
    this.scheduled = null;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private applyIfIdle(): void {
    const scheduled = this.scheduled;
    if (!scheduled) return;
    if (!this.idle()) return;
    try {
      this.apply(scheduled.target);
    } catch (error) {
      // Nobody is watching a deferred apply — leave the refusal where the dialog shows a failure.
      this.cancelScheduled();
      const now = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      this.job = { status: 'failed', target: scheduled.target, startedAt: now, finishedAt: now, log: [`failed: ${message}`], error: message };
    }
  }

  /** A checkout `status()` offers under `target`: build it when it is unbuilt or older than its
   *  last commit, link it and return its id. Null when no checkout answers to that id — the
   *  target is then an installed entry or a registry version. A hosted cockpit never builds or
   *  links here (`trimPaths`); at most it activates a link the host itself created, and only one
   *  `forwardOnlyRefusal` lets through. */
  private async linkDiscovered(target: string, log: (line: string) => void): Promise<string | null> {
    if (this.deps.trimPaths?.()) return null;
    const checkout = (await discoverCheckouts(this.env)).find((entry) => entry.id === target);
    if (!checkout) return null;
    if (!checkout.built || checkout.stale) {
      log(`${checkout.built ? 'rebuilding' : 'building'} ${checkout.branch} first`);
      await (this.deps.buildCheckout ?? buildCheckout)(checkout, log);
    }
    log(`linking ${checkout.packageRoot} (${checkout.branch})`);
    return linkCheckout(checkout.packageRoot, checkout.branch, this.env, checkout.id).id;
  }

  /** `cezar install` from a checkout or the npx cache: pack the running package into the managed
   *  layout and activate it. Headless — the CLI prints the log. */
  async installSelf(onLog: (line: string) => void): Promise<{ id: string; entry: string }> {
    const result = await installFromLocal(packageRootOf(this.deps.entry), { onLog, env: this.env });
    activate(result.id, this.env);
    return result;
  }

  /**
   * `cezar update` on the branch channel (spec §3.8): fetch, build the tip, install and activate
   * it. Never restarts a server — the CLI says what to restart. Null when already up to date.
   */
  async installBranchTip(onLog: (line: string) => void): Promise<{ id: string; branch: SelfUpdateBranch } | { id: null; branch: SelfUpdateBranch | null }> {
    const view = await this.branchView(true);
    if (!view) return { id: null, branch: null };
    const { tipId, ...branch } = view;
    if (view.behind === 0 || !tipId) return { id: null, branch };
    const id = findInstalled(tipId, this.env)?.id ?? (await this.buildBranch(tipId, onLog));
    activate(id, this.env);
    clearRollback(this.env);
    this.pruneBranchBuilds(onLog);
    return { id, branch };
  }
}

function branchKey(branch: UpdateBranch): string {
  return `${branch.remote}#${branch.branch}`;
}

/** The managed install a running entry belongs to: `versions/<id>/…`, or `current`'s target at
 *  boot when it was launched through the link. Null outside the managed layout. */
function runningInstallId(entry: string, env: NodeJS.ProcessEnv): string | null {
  const rel = relative(resolve(versionsDir(env)), resolve(entry));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const first = rel.split(sep)[0] ?? '';
  return first === CURRENT_LINK ? activeId(env) : first || null;
}
