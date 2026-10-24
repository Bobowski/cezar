import { z } from 'zod';

/**
 * Self-update (`/api/v1/workspace/self-update`, PoC — spec to follow): the cockpit's own
 * "update cezar" surface. cezar can only replace ITSELF when it runs from the managed layout
 * (`~/.cezar/versions/<id>`, activated through the `current` link and launched by
 * `~/.cezar/bin/cezar`); every other install kind is reported so the dialog can explain how to
 * get there instead of failing a download nobody can use.
 */

/** Release channels map onto npm dist-tags: `stable` → `latest`, `nightly` → `nightly`.
 *  `development` follows no tag: nothing is ever offered as an update, and the dialog picks a
 *  cezar worktree or an open pull request's preview build by hand instead. `branch` follows a git
 *  branch, built on this machine (spec 2026-10-23-branch-channel-self-update). */
export const updateChannelSchema = z.enum(['stable', 'nightly', 'development', 'branch']);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

/** A remote the `branch` channel may clone: `https://`, `ssh://` or scp-like `git@host:path`.
 *  Never a local path or `file://` — a remote is code the server will build and run. */
export function isUpdateRemote(value: string): boolean {
  if (value.length > 512 || /\s/.test(value) || value.startsWith('-')) return false;
  // A host or user that starts with `-` is an ssh option in disguise; credentials in the URL
  // would land in config.json — the fetch uses the git credentials already on the machine.
  if (/^git@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~][A-Za-z0-9._~/-]*$/.test(value)) return true;
  // No `URL` here: the contract is lib-free (ES2022 only). `scheme://[user@]host[:port]/path`.
  return /^(https|ssh):\/\/([A-Za-z0-9][A-Za-z0-9._~-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?\/[A-Za-z0-9._~/-]+$/.test(value);
}

/** A branch name git accepts and no argument parser mistakes for an option. */
export function isUpdateBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith('-') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock') &&
    !value.includes('..') &&
    !value.includes('//')
  );
}

/** The branch the `branch` channel follows. */
export const updateBranchSchema = z.object({
  remote: z.string().refine(isUpdateRemote, 'remote must be an https://, ssh:// or git@host:path URL'),
  branch: z.string().refine(isUpdateBranchName, 'branch must be a plain branch name'),
});
export type UpdateBranch = z.infer<typeof updateBranchSchema>;

/** One commit as the dialog shows it. `at` is the committer date (ISO). */
export const updateCommitSchema = z.object({ sha: z.string(), subject: z.string(), at: z.string() });
export type UpdateCommit = z.infer<typeof updateCommitSchema>;

/** How the running process was installed — decides whether a self-update is possible. */
export const installKindSchema = z.enum(['managed', 'global-npm', 'npx', 'checkout', 'unknown']);
export type InstallKind = z.infer<typeof installKindSchema>;

/** One entry under `~/.cezar/versions/`. `id` is the directory name; a local build carries a
 *  `+local` suffix so it never collides with the registry version it was built from, a linked
 *  checkout (`link`, `cezar link`) a `+<branch>` one, a `branch`-channel build `+<sha8>` and the
 *  container image's own install `+image[.<sha8>]`. */
export const installedVersionSchema = z.object({
  id: z.string(),
  version: z.string(),
  source: z.enum(['registry', 'local', 'link', 'branch', 'image']),
  installedAt: z.string(),
  active: z.boolean(),
  /** `link` only: the checkout's branch, and its package root (absent in hosted mode). */
  branch: z.string().optional(),
  checkout: z.string().optional(),
  /** `branch` and `image` builds: the commit they were built from, when known. */
  commit: updateCommitSchema.extend({ branch: z.string() }).optional(),
});
export type InstalledVersion = z.infer<typeof installedVersionSchema>;

/** One registry version the picker can install. `channel` is the dist-tag family it belongs to:
 *  a plain semver is `stable`, `-nightly.` a nightly, anything else (`-develop.`, `-pr123.`) a
 *  `preview`. `publishedAt` comes from the registry's `time` map, null when it is missing. */
export const availableVersionSchema = z.object({
  version: z.string(),
  channel: z.enum(['stable', 'nightly', 'preview']),
  publishedAt: z.string().nullable(),
  installed: z.boolean(),
});
export type AvailableVersion = z.infer<typeof availableVersionSchema>;

export const selfUpdateJobStatusSchema = z.enum(['running', 'failed', 'restarting']);

/** The one in-flight or last-finished install job. `log` is npm's own output, line by line,
 *  capped server-side. `restarting` means the new version is activated and the process is about
 *  to exit — the cockpit polls health until a different `version` answers. */
export const selfUpdateJobSchema = z.object({
  status: selfUpdateJobStatusSchema,
  target: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  log: z.array(z.string()),
  error: z.string().optional(),
});
export type SelfUpdateJob = z.infer<typeof selfUpdateJobSchema>;

export const selfUpdateScheduledSchema = z.object({
  target: z.string(),
  requestedAt: z.string(),
});
export type SelfUpdateScheduled = z.infer<typeof selfUpdateScheduledSchema>;

/** The `branch` channel's view of its branch (spec 2026-10-23 §3.4). */
export const selfUpdateBranchSchema = z.object({
  remote: z.string(),
  branch: z.string(),
  /** The commit the running version was built from; null for a registry install. */
  running: updateCommitSchema.nullable(),
  /** The branch tip as of the last fetch; null before the first. */
  tip: updateCommitSchema.nullable(),
  /** Commits on the tip the running build does not have. 0 when up to date. */
  behind: z.number().int().min(0),
  /** false when `running` is not an ancestor of `tip` (a force-push, a rebase). */
  fastForward: z.boolean(),
  /** Paths under docker/ the pending commits touch — a rebuild via ssh is also due. */
  touchesImage: z.array(z.string()),
  fetchedAt: z.string().nullable(),
  error: z.string().optional(),
});
export type SelfUpdateBranch = z.infer<typeof selfUpdateBranchSchema>;

/** A crash-on-boot rollback the container's supervisor did (`<CEZ_HOME>/rollback.json`): `from`
 *  exited with `exitCode` within 30 s of being activated, so `to` — what ran before — was relinked. */
export const selfUpdateRollbackSchema = z.object({
  from: z.string(),
  to: z.string(),
  exitCode: z.number().int(),
  at: z.string(),
});
export type SelfUpdateRollback = z.infer<typeof selfUpdateRollbackSchema>;

/** `GET /api/v1/workspace/self-update` (and every mutation on the family). */
export const selfUpdateStatusSchema = z.object({
  version: z.string(),
  installKind: installKindSchema,
  /** Absolute entry file the process runs; hosted mode trims it to its basename. */
  entry: z.string(),
  canSelfUpdate: z.boolean(),
  /** Why `canSelfUpdate` is false, phrased for the dialog. Absent when it is true. */
  reason: z.string().optional(),
  channel: updateChannelSchema,
  /** How the process will come back: re-exec itself, or exit and let the supervisor (desktop
   *  shell, systemd, launchd) relaunch it. */
  restartMode: z.enum(['reexec', 'supervisor']),
  latest: z.object({
    stable: z.string().nullable(),
    nightly: z.string().nullable(),
  }),
  /** The channel's newest version when it is newer than `version`, else null. */
  updateAvailable: z.string().nullable(),
  /** When the registry was last read successfully; null when it never answered (offline). */
  checkedAt: z.string().nullable(),
  installed: z.array(installedVersionSchema),
  available: z.array(availableVersionSchema),
  job: selfUpdateJobSchema.nullable(),
  /** "Update when idle": the version this process installs and restarts into as soon as no task
   *  is running or queued. In memory only — a restart for any other reason forgets it. */
  scheduled: selfUpdateScheduledSchema.nullable(),
  /** Runs in flight across the workspace — a restart interrupts them (boot recovery re-queues). */
  activeRuns: z.number().int().min(0),
  /** Whether the caller may change the channel and the followed branch (`trustedOperator()`). */
  channelEditable: z.boolean(),
  /** The `branch` channel only: the followed branch. Absent on every other channel. */
  branch: selfUpdateBranchSchema.optional(),
  /** The last crash-on-boot rollback, until the next successful apply. */
  rollback: selfUpdateRollbackSchema.optional(),
});
export type SelfUpdateStatus = z.infer<typeof selfUpdateStatusSchema>;

/** `POST /api/v1/workspace/self-update/apply` — a version string, never a URL or a path. */
export const selfUpdateApplyRequestSchema = z
  .object({
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9A-Za-z.+-]+$/, 'version must be a plain version string'),
    /** Wait until no task is running or queued, then apply (`scheduled` on the status). */
    whenIdle: z.boolean().optional(),
  })
  .strict();
export type SelfUpdateApplyRequest = z.infer<typeof selfUpdateApplyRequestSchema>;

/** `PUT /api/v1/workspace/self-update/channel`. `branch` also sets the followed branch, which the
 *  `branch` channel takes from here, else `CEZ_UPDATE_BRANCH`, else the container image. */
export const selfUpdateChannelRequestSchema = z
  .object({ channel: updateChannelSchema, branch: updateBranchSchema.optional() })
  .strict();
export type SelfUpdateChannelRequest = z.infer<typeof selfUpdateChannelRequestSchema>;

/** The cezar task that owns a worktree (`.ai/cezar/worktrees/<runId>` in the repo's run index). */
export const checkoutTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
});
export type CheckoutTask = z.infer<typeof checkoutTaskSchema>;

/** A cezar checkout (a worktree of a registered cezar repo) the cockpit can switch to by
 *  applying its `id` — linked on the spot, no copy, no publish. Only built ones can be applied.
 *  Everything past `linked` is there to tell forty task branches apart: what the task was, what
 *  was last committed and when, and whether the build predates that commit. */
export const cezarCheckoutSchema = z.object({
  id: z.string(),
  branch: z.string(),
  version: z.string(),
  worktree: z.string(),
  built: z.boolean(),
  linked: z.boolean(),
  /** Last commit on the worktree's HEAD; null when git could not say. */
  commit: z.object({ sha: z.string(), subject: z.string(), at: z.string() }).nullable(),
  /** When `dist/index.js` was last written; null when not built. */
  builtAt: z.string().nullable(),
  /** Built, but the last commit is newer than the build. */
  stale: z.boolean(),
  /** The task that owns this worktree, when it is one of cezar's own. */
  task: checkoutTaskSchema.nullable(),
  /** The open pull request whose head is this branch, when one is known. */
  pr: z.number().int().nullable(),
});
export type CezarCheckout = z.infer<typeof cezarCheckoutSchema>;

/** An open pull request of cezar's own repository, with the preview build CI published for it
 *  (the `pr-<N>` npm dist-tag, spec 2026-07-18-npm-preview-publish). `version` is null when the
 *  PR has no build (a fork, CI not green yet): listed, never installable. */
export const pullBuildSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  author: z.string().nullable(),
  branch: z.string(),
  draft: z.boolean(),
  updatedAt: z.string(),
  url: z.string(),
  version: z.string().nullable(),
  publishedAt: z.string().nullable(),
  installed: z.boolean(),
});
export type PullBuild = z.infer<typeof pullBuildSchema>;

/** `GET /api/v1/workspace/self-update/development?refresh=1` — `refresh` skips the caches. */
export const selfUpdateDevelopmentQuerySchema = z.object({ refresh: z.literal('1').optional() }).strict();
export type SelfUpdateDevelopmentQuery = z.infer<typeof selfUpdateDevelopmentQuerySchema>;

/** `GET /api/v1/workspace/self-update/development` — what the development channel picks from.
 *  Kept off the status route: it costs a git call per worktree and a GitHub round trip. */
export const selfUpdateDevelopmentSchema = z.object({
  /** Newest commit first. Always empty in hosted mode. */
  checkouts: z.array(cezarCheckoutSchema),
  pulls: z.object({
    available: z.boolean(),
    /** Why the list is empty or partial (`gh` missing, offline…). Absent when it is complete. */
    reason: z.string().optional(),
    repo: z.string(),
    /** Most recently updated first. */
    items: z.array(pullBuildSchema),
  }),
});
export type SelfUpdateDevelopment = z.infer<typeof selfUpdateDevelopmentSchema>;
