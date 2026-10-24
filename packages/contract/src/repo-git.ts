import { z } from 'zod';
import { changedFileSchema } from './repo.ts';

/**
 * The Git page's Source-Control half (spec `.ai/specs/2026-10-24-git-view.md`): the commit graph,
 * branch actions, the index, stashes and the remotes, all on the project's main checkout. Every
 * mutation answers git's own words on failure as `409 { error }`.
 */

// ---- graph (§3.1) ----------------------------------------------------------------------------

/** `all`: every local and remote-tracking branch; `mine`: local, non-task branches;
 *  `tasks`: task branches. HEAD and the base branch are always drawn. */
export const repoGraphFilterSchema = z.enum(['all', 'mine', 'tasks']);
export type RepoGraphFilter = z.infer<typeof repoGraphFilterSchema>;

export const repoGraphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  /** The `next` cursor of the previous page. */
  after: z.string().regex(/^\d{1,7}$/).optional(),
  filter: repoGraphFilterSchema.optional(),
});
export type RepoGraphQuery = z.infer<typeof repoGraphQuerySchema>;

/** One commit, newest first in `--date-order` (children always before their parents). */
export const repoGraphCommitSchema = z.object({
  sha: z.string(),
  parents: z.array(z.string()),
  subject: z.string(),
  author: z.string(),
  /** git's relative `%cr`. */
  when: z.string(),
});
export type RepoGraphCommit = z.infer<typeof repoGraphCommitSchema>;

const graphTaskStatusSchema = z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']);

/** A branch label on the graph. */
export const repoGraphRefSchema = z.object({
  /** Short name: `main`, `origin/main`, `cez/1a2b3c4d`. */
  name: z.string(),
  kind: z.enum(['local', 'remote']),
  /** The remote a remote-tracking ref belongs to. */
  remote: z.string().nullable(),
  /** The branch name without the remote (`main` for `origin/main`). */
  branch: z.string(),
  /** Full sha of the tip. */
  commit: z.string(),
  current: z.boolean(),
  base: z.boolean(),
  /** A task's branch (`cez/*`, or a name a run record owns). */
  isTask: z.boolean(),
  /** The run that owns it, when cezar still has the record. */
  task: z.object({ runId: z.string(), title: z.string(), status: graphTaskStatusSchema }).nullable(),
  /** Already contained in the base branch — drawn faded. */
  merged: z.boolean(),
  /** Where it forked from the base branch; null for the base itself or past the cap. */
  mergeBase: z.string().nullable(),
});
export type RepoGraphRef = z.infer<typeof repoGraphRefSchema>;

export const repoGraphSchema = z.object({
  commits: z.array(repoGraphCommitSchema),
  refs: z.array(repoGraphRefSchema),
  /** Full sha of HEAD; null before the first commit. */
  head: z.string().nullable(),
  /** The ref the merge-base marks are measured against (`origin/main`), null when none resolves. */
  base: z.string().nullable(),
  /** The cursor for the next page; null on the last. */
  next: z.string().nullable(),
});
export type RepoGraph = z.infer<typeof repoGraphSchema>;

// ---- the index (§3.3) ------------------------------------------------------------------------

/** One file on one side of the index. `untracked` only on the unstaged side. */
export const repoIndexFileSchema = changedFileSchema.extend({ untracked: z.boolean().optional() });
export type RepoIndexFile = z.infer<typeof repoIndexFileSchema>;

/** A merge, rebase or cherry-pick git stopped in the middle of (conflicts, or a pause). */
export const repoOperationSchema = z.object({
  kind: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']),
  /** What is being merged in / rebased onto, as git recorded it; null when unknown. */
  onto: z.string().nullable(),
});
export type RepoOperation = z.infer<typeof repoOperationSchema>;

/** `GET /repo/status` — the Changes tab with the index: staged (HEAD→index) and unstaged
 *  (index→worktree, untracked included), the conflicted paths and the operation in progress. */
export const repoIndexSchema = z.object({
  branch: z.string().nullable(),
  staged: z.array(repoIndexFileSchema),
  unstaged: z.array(repoIndexFileSchema),
  conflicted: z.array(z.string()),
  operation: repoOperationSchema.nullable(),
  /** Whether HEAD is on a remote-tracking branch already — Amend is refused then. */
  headPushed: z.boolean(),
  /** HEAD exists (false before the first commit — nothing to amend). */
  hasHead: z.boolean(),
});
export type RepoIndex = z.infer<typeof repoIndexSchema>;

/** `POST /repo/{stage,unstage,discard}` — whole files, or one hunk of one file, named by its
 *  `@@ -a,b +c,d @@` header as the diff showed it. */
export const repoIndexChangeSchema = z
  .object({
    paths: z.array(z.string().min(1).max(4096)).min(1).max(2000).optional(),
    path: z.string().min(1).max(4096).optional(),
    hunk: z.string().min(1).max(2000).optional(),
  })
  .refine((body) => (body.paths !== undefined) !== (body.path !== undefined && body.hunk !== undefined), {
    message: 'send either paths, or path and hunk',
  });
export type RepoIndexChange = z.infer<typeof repoIndexChangeSchema>;

/** `POST /repo/discard` — a change as above, sent only after the cockpit's confirm: without
 *  `confirm: true` it 409s, every path must be an unstaged file named exactly, and an untracked
 *  one (deleted, not restored) also needs `untracked: true` (spec 2026-10-24-git-view §5). */
export const repoDiscardSchema = z
  .object({
    paths: z.array(z.string().min(1).max(4096)).min(1).max(2000).optional(),
    path: z.string().min(1).max(4096).optional(),
    hunk: z.string().min(1).max(2000).optional(),
    confirm: z.boolean().optional(),
    untracked: z.boolean().optional(),
  })
  .refine((body) => (body.paths !== undefined) !== (body.path !== undefined && body.hunk !== undefined), {
    message: 'send either paths, or path and hunk',
  });
export type RepoDiscard = z.infer<typeof repoDiscardSchema>;

/** `POST /repo/commit` — commit the index (never `-a`); `amend` rewrites an unpushed HEAD. */
export const repoCommitSchema = z.object({
  message: z.string().max(20_000),
  amend: z.boolean().optional(),
});
export type RepoCommitInput = z.infer<typeof repoCommitSchema>;
export const repoCommitResponseSchema = z.object({ message: z.string(), sha: z.string() });
export type RepoCommitResponse = z.infer<typeof repoCommitResponseSchema>;

// ---- branch and history actions (§3.2) -------------------------------------------------------

/** Every branch, merge and history action. `conflicts` is non-empty when git stopped on them:
 *  the operation is left in progress for Continue or Abort. */
export const repoGitActionResponseSchema = z.object({
  message: z.string(),
  conflicts: z.array(z.string()),
});
export type RepoGitActionResponse = z.infer<typeof repoGitActionResponseSchema>;

export const repoBranchParamSchema = z.object({ name: z.string().min(1).max(512) });
export const repoBranchRenameSchema = z.object({ to: z.string().min(1).max(512) });
export type RepoBranchRename = z.infer<typeof repoBranchRenameSchema>;
export const repoBranchPushSchema = z.object({ remote: z.string().min(1).max(256) });
export type RepoBranchPush = z.infer<typeof repoBranchPushSchema>;
/** `remote=1` deletes the branch on its remote too (never a force push); `force=1` deletes a
 *  local branch git calls unmerged. */
export const repoBranchDeleteQuerySchema = z.object({
  remote: z.enum(['0', '1']).optional(),
  force: z.enum(['0', '1']).optional(),
});
export type RepoBranchDeleteQuery = z.infer<typeof repoBranchDeleteQuerySchema>;
export const repoCommitShaParamSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{4,64}$/i) });

/** `GET /repo/compare?ref=` — what `ref` brings in over the checked-out branch: the diff from
 *  their merge-base (against the freshest copy of the current branch) to `ref`. */
export const repoCompareQuerySchema = z.object({ ref: z.string().min(1).max(512) });
export const repoCompareSchema = z.object({
  ref: z.string(),
  /** What it was compared with (`main`, or `origin/main` when that is fresher). */
  against: z.string(),
  mergeBase: z.string(),
  files: z.array(changedFileSchema),
  stat: z.object({ adds: z.number(), dels: z.number(), files: z.number() }),
});
export type RepoCompare = z.infer<typeof repoCompareSchema>;

// ---- stash (§3.3) ----------------------------------------------------------------------------

export const repoStashEntrySchema = z.object({
  index: z.number().int(),
  /** git's own line: `On main: wip` / `WIP on main: 1a2b3c4 subject`. */
  message: z.string(),
  when: z.string(),
});
export type RepoStashEntry = z.infer<typeof repoStashEntrySchema>;
export const repoStashListSchema = z.object({ stashes: z.array(repoStashEntrySchema) });
export type RepoStashList = z.infer<typeof repoStashListSchema>;
export const repoStashPushSchema = z.object({
  message: z.string().max(2000).optional(),
  includeUntracked: z.boolean().optional(),
});
export type RepoStashPush = z.infer<typeof repoStashPushSchema>;
export const repoStashParamSchema = z.object({ n: z.coerce.number().int().min(0).max(100_000) });

// ---- remotes (§3.4) --------------------------------------------------------------------------

/** Why `prTarget` is the PR target, as `resolveTaskRemotes` decided (`git-remotes.ts`). */
export const repoPrTargetReasonSchema = z.enum(['gh-default', 'fork-parent', 'origin', 'first-remote']);
/** Why `pushDefault` is where branches are pushed. */
export const repoPushReasonSchema = z.enum(['push-default', 'origin', 'pr-target']);

export const repoRemoteSchema = z.object({
  name: z.string(),
  /** Fetch URL with any credentials stripped; null when unreadable. */
  url: z.string().nullable(),
  /** A distinct push URL (`remote.<name>.pushurl`), credentials stripped. */
  pushUrl: z.string().nullable(),
  /** Its remote-tracking branches, as last fetched (capped). */
  branches: z.array(z.string()),
});
export type RepoRemote = z.infer<typeof repoRemoteSchema>;

export const repoRemotesSchema = z.object({
  remotes: z.array(repoRemoteSchema),
  prTarget: z.string().nullable(),
  pushDefault: z.string().nullable(),
  reasons: z.object({
    prTarget: repoPrTargetReasonSchema.nullable(),
    pushDefault: repoPushReasonSchema.nullable(),
  }),
});
export type RepoRemotes = z.infer<typeof repoRemotesSchema>;

export const repoRemoteParamSchema = z.object({ name: z.string().min(1).max(256) });
export const repoMessageResponseSchema = z.object({ message: z.string() });
export type RepoMessageResponse = z.infer<typeof repoMessageResponseSchema>;
