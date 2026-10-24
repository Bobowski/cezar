import { z } from 'zod';
import { agentConfigFileContentSchema, agentConfigListingSchema } from './agent-config.ts';
import {
  agentAccountDetailsResponseSchema,
  agentAccountStatusResponseSchema,
  agentProfileResponseSchema,
  agentProfileSelectionsResponseSchema,
  agentProfilesResponseSchema,
  openAgentAccountFileResponseSchema,
  removeAgentProfileResponseSchema,
} from './agent-profiles.ts';
import {
  automationCheckQueuedResponseSchema,
  automationCheckSchema,
  automationDetailResponseSchema,
  automationLogResponseSchema,
  automationResponseSchema,
  automationRetryResponseSchema,
  automationRunResponseSchema,
  automationsResponseSchema,
  automationTemplatesResponseSchema,
  dashboardAutomationsSchema,
} from './automations.ts';
import {
  dashboardFeedSchema,
  dashboardSnapshotSchema,
  dashboardTasksPageSchema,
  dashboardTelemetrySchema,
} from './dashboard.ts';
import { dashboardCostsSchema } from './dashboard-costs.ts';
import { dashboardInsightsSchema } from './dashboard-insights.ts';
import { dashboardOverviewSchema } from './dashboard-overview.ts';
import { dispatchResponseSchema } from './dispatch.ts';
import { dockerStateSchema } from './docker.ts';
import {
  deleteDraftResponseSchema,
  draftEntrySchema,
  draftImageSchema,
  runDraftsResponseSchema,
} from './drafts.ts';
import { e2eSetupResponseSchema, e2eStatusSchema } from './e2e.ts';
import { envFileContentSchema, envFileRenderSchema, envFilesListSchema, envFilesRerenderSchema } from './env-files.ts';
import { runHistoryContextSchema, runHistoryPageSchema } from './events.ts';
import {
  githubChecksDataSchema,
  githubCommentsDataSchema,
  githubDataSchema,
  githubMergeResponseSchema,
  githubPrChangesDataSchema,
  githubPrMergeStateResponseSchema,
  githubRefStatusDataSchema,
  githubSearchDataSchema,
} from './github.ts';
import { healthResponseSchema } from './health.ts';
import { hostUsageSchema } from './host.ts';
import { designProxyResponseSchema, previewGatewayResponseSchema } from './preview.ts';
import {
  fsBrowseResponseSchema,
  githubOwnersResponseSchema,
  githubReposResponseSchema,
  launchKeyResponseSchema,
  projectIconCandidatesSchema,
  projectsResponseSchema,
  registerProjectResponseSchema,
  removeProjectResponseSchema,
  updateProjectResponseSchema,
} from './projects.ts';
import {
  changesPayloadSchema,
  codeSearchResultSchema,
  codeWatchSchema,
  reclaimWorktreesResponseSchema,
  repoBranchResponseSchema,
  repoPullResponseSchema,
  repoResponseSchema,
  repoSyncActionResponseSchema,
  repoSyncSchema,
  repoTreeSchema,
  runFileDeleteResponseSchema,
  runFileRenameSchema,
  runFileWriteResponseSchema,
  worktreesResponseSchema,
} from './repo.ts';
import {
  adoptPrResponseSchema,
  apiRunSchema,
  cancelAutoResumeResponseSchema,
  createRunResponseSchema,
  markAllReadResponseSchema,
  archiveFinishedResponseSchema,
  cancelResponseSchema,
  continueResponseSchema,
  createPrResponseSchema,
  deleteRunResponseSchema,
  deleteUploadResponseSchema,
  editQueuedMessageResponseSchema,
  editQueuedPromptResponseSchema,
  finishResponseSchema,
  gitCommitResponseSchema,
  gitPushResponseSchema,
  gitStatusResponseSchema,
  groupResponseSchema,
  landResponseSchema,
  messageResponseSchema,
  openInCliResponseSchema,
  pickVariantResponseSchema,
  promptQueueResponseSchema,
  removeQueuedMessageResponseSchema,
  removeQueuedPromptResponseSchema,
  removeWorktreeResponseSchema,
  runCommitsResponseSchema,
  runRecordSchema,
  runsIndexResponseSchema,
  stagedUploadSchema,
} from './runs.ts';
import { secretsListSchema } from './secrets.ts';
import { selfUpdateStatusSchema } from './self-update.ts';
import { servicePinSchema, serviceLogsSchema, servicesStateSchema } from './services.ts';
import { importableSkillSchema, skillSchema, removeTodoResponseSchema, startTodoResponseSchema, todoItemSchema } from './skills.ts';
import { startAppStateSchema } from './start-app.ts';
import { starCountSchema } from './star-count.ts';
import { workspaceLayoutsResponseSchema } from './workspace-layouts.ts';
import { telemetryConsentSchema } from './telemetry.ts';
import { terminalOutputSchema, terminalSessionSchema, terminalStateSchema } from './terminal.ts';
import {
  trackerAssociationResponseSchema,
  trackerAssociationSavedResponseSchema,
  trackerCandidatesResponseSchema,
  trackerClearedResponseSchema,
  trackerConnectionResponseSchema,
  trackerConnectionSourcesResponseSchema,
  trackerItemResponseSchema,
  trackerItemsResponseSchema,
  trackerRunIssueResponseSchema,
  trackerTransitionResponseSchema,
  trackerTransitionsResponseSchema,
  trackerWatchHandleSchema,
  trackerWatchSnapshotSchema,
} from './tracker.ts';
import {
  deleteWorkflowResponseSchema,
  parsedWorkflowSchema,
  planResponseSchema,
  saveWorkflowResponseSchema,
  validateWorkflowGraphResponseSchema,
  workflowNodeCatalogResponseSchema,
  workflowsResponseSchema,
} from './workflows.ts';
import {
  configResponseSchema,
  openProjectInResponseSchema,
  openTargetsResponseSchema,
  providerConnectResponseSchema,
  providerStatusResponseSchema,
  providerUpdateResponseSchema,
  runnerModelCatalogResponseSchema,
  setConfigResponseSchema,
  skillsUpdateStateSchema,
  workspaceBrandingLogoResponseSchema,
  workspaceConfigResponseSchema,
} from './workspace.ts';
import {
  lifecycleDetailResponseSchema,
  lifecycleListResponseSchema,
  lifecycleOperationResponseSchema,
  lifecycleOutputResponseSchema,
  lifecyclePreviewResponseSchema,
} from './worktree-lifecycle.ts';

/**
 * Every `/api/v1` route, by `METHOD /path` — project routes by their unscoped path (spec
 * 2026-10-24-cezar-mcp-server §3). Each entry is one MCP tool: the route's request validators
 * give its input, `response` (the route's 2xx JSON body) its output. A route missing here fails
 * `mcp/catalog.test.ts`; a `response` that drifts from its route fails
 * `contract-parity.routes.test.ts` at typecheck.
 */
export interface RouteContract {
  /** One line, what the route does: the tool's description. */
  summary: string;
  /** The 2xx JSON body. Absent where none is in the contract yet; the tool then answers JSON text. */
  response?: z.ZodType;
  /** Not a tool, and why: a byte or event stream, a cockpit-only beacon, or sign-in itself. */
  notTool?: 'stream' | 'binary' | 'browser' | 'auth';
  /** The tool's name, where the one derived from the path reads badly. */
  tool?: string;
  /** The tool set, where it is not the family's own (see `mcp/catalog.ts`). */
  set?: 'tasks';
  /** A step the cockpit confirms before it sends (DELETE routes are destructive already). */
  destructive?: true;
}

const list = <T extends z.ZodType>(item: T) => z.array(item);

export const routeContracts = {
  // ---- runs (tasks) ----------------------------------------------------------
  'GET /runs': { summary: 'List the project\'s tasks with status, cost and branch.', response: list(apiRunSchema), set: 'tasks' },
  'POST /runs': { summary: 'Start a task: a prompt run through a workflow (quick-task by default) in its own worktree.', response: createRunResponseSchema, set: 'tasks' },
  'GET /runs/:id': { summary: 'One task: status, steps, usage, branch and PR.', response: apiRunSchema, set: 'tasks' },
  'PATCH /runs/:id': { summary: 'Rename a task or change its editable fields.', response: runRecordSchema, set: 'tasks' },
  'DELETE /runs/:id': { summary: 'Delete a task and its record.', response: deleteRunResponseSchema },
  'POST /runs/:id/archive': { summary: 'Archive or unarchive a task.', response: runRecordSchema, set: 'tasks' },
  'DELETE /runs/:id/auto-resume': { summary: 'Cancel a task\'s scheduled automatic resume.', response: cancelAutoResumeResponseSchema },
  'POST /runs/:id/cancel': { summary: 'Stop a running or queued task.', response: cancelResponseSchema, set: 'tasks' },
  'GET /runs/:id/changes': { summary: 'The files a task changed, with per-file stats.', response: changesPayloadSchema, set: 'tasks' },
  'GET /runs/:id/commit/:sha': { summary: 'One commit on a task\'s branch, with its diff.' },
  'GET /runs/:id/commits': { summary: 'The commits on a task\'s branch.', response: runCommitsResponseSchema },
  'POST /runs/:id/continue': { summary: 'Continue a finished task with a follow-up prompt.', response: continueResponseSchema, set: 'tasks' },
  'GET /runs/:id/diff': { summary: 'A task\'s whole diff against its base, as text.', set: 'tasks' },
  'POST /runs/:id/dispatch': { summary: 'Dispatch a child task from a running task (cez task create).', response: dispatchResponseSchema },
  'GET /runs/:id/drafts': { summary: 'The unsent composer drafts saved for a task.', response: runDraftsResponseSchema },
  'PUT /runs/:id/drafts/:surface': { summary: 'Save the composer draft for one surface of a task.', response: draftEntrySchema },
  'DELETE /runs/:id/drafts/:surface': { summary: 'Discard a task\'s composer draft.', response: deleteDraftResponseSchema },
  'POST /runs/:id/drafts/:surface/images': { summary: 'Attach an image to a task\'s composer draft.', response: draftImageSchema },
  'GET /runs/:id/drafts/:surface/images/:imageId': { summary: 'One image attached to a draft.', notTool: 'binary' },
  'DELETE /runs/:id/drafts/:surface/images/:imageId': { summary: 'Remove an image from a draft.', response: deleteDraftResponseSchema },
  'GET /runs/:id/events': { summary: 'A task\'s live event stream (SSE).', notTool: 'stream' },
  'GET /runs/:id/files': { summary: 'Read a file or list a directory in a task\'s worktree.' },
  'PUT /runs/:id/files': { summary: 'Overwrite a file in a task\'s worktree.', response: runFileWriteResponseSchema },
  'POST /runs/:id/files': { summary: 'Create a file in a task\'s worktree.', response: runFileWriteResponseSchema },
  'DELETE /runs/:id/files': { summary: 'Delete a file in a task\'s worktree.', response: runFileDeleteResponseSchema },
  'POST /runs/:id/files/rename': { summary: 'Rename a file in a task\'s worktree.', response: runFileRenameSchema },
  'POST /runs/:id/finish': { summary: 'Mark a task finished and leave the review gate.', response: finishResponseSchema },
  'POST /runs/:id/git/commit': { summary: 'Commit the changes in a task\'s worktree.', response: gitCommitResponseSchema },
  'POST /runs/:id/git/push': { summary: 'Push a task\'s branch.', response: gitPushResponseSchema },
  'GET /runs/:id/git/status': { summary: 'Git status of a task\'s worktree.', response: gitStatusResponseSchema },
  'GET /runs/:id/handoff': { summary: 'The commands to take a task over locally (checkout, resume).' },
  'GET /runs/:id/history': { summary: 'A task\'s transcript, newest page first (pass cursor for older pages).', response: runHistoryPageSchema, set: 'tasks' },
  'GET /runs/:id/history-context': { summary: 'The context events that frame a task\'s transcript.', response: runHistoryContextSchema },
  'GET /runs/:id/images/:file': { summary: 'An image a task produced.', notTool: 'binary' },
  'POST /runs/:id/land': { summary: 'Merge a reviewed task\'s branch into its base.', response: landResponseSchema, destructive: true },
  'GET /runs/:id/layouts': { summary: 'The cockpit\'s saved pane layout for a task.', response: workspaceLayoutsResponseSchema },
  'PUT /runs/:id/layouts': { summary: 'Save the cockpit\'s pane layout for a task.', response: workspaceLayoutsResponseSchema },
  'POST /runs/:id/messages': { summary: 'Send a message to a task: steer a running one or queue a follow-up.', response: messageResponseSchema, tool: 'runs_send_message', set: 'tasks' },
  'POST /runs/:id/open-in': { summary: 'Open a task\'s worktree in a local app (editor, terminal).' },
  'POST /runs/:id/open-in-cli': { summary: 'Resume a task\'s agent session in a local terminal.', response: openInCliResponseSchema },
  'POST /runs/:id/pin': { summary: 'Pin or unpin a task.', response: runRecordSchema },
  'POST /runs/:id/pr': { summary: 'Push a task\'s branch and open a draft PR.', response: createPrResponseSchema, set: 'tasks' },
  'POST /runs/:id/pr/adopt': { summary: 'Link a task to the PR already open for its branch.', response: adoptPrResponseSchema },
  'POST /runs/:id/prompt-queue': { summary: 'Queue a prompt to run after the task\'s current turn.', response: promptQueueResponseSchema },
  'PATCH /runs/:id/prompt-queue/:msgId': { summary: 'Edit a queued prompt.', response: editQueuedPromptResponseSchema },
  'DELETE /runs/:id/prompt-queue/:msgId': { summary: 'Remove a queued prompt.', response: removeQueuedPromptResponseSchema },
  'PATCH /runs/:id/queued-messages/:msgId': { summary: 'Edit a message queued on a not-yet-started task.', response: editQueuedMessageResponseSchema },
  'DELETE /runs/:id/queued-messages/:msgId': { summary: 'Remove a message queued on a not-yet-started task.', response: removeQueuedMessageResponseSchema },
  'POST /runs/:id/read': { summary: 'Mark a task read.', response: runRecordSchema },
  'POST /runs/:id/remove-worktree': { summary: 'Discard a task\'s worktree (its branch stays).', response: removeWorktreeResponseSchema, destructive: true },
  'POST /runs/:id/report': { summary: 'Report a dispatched task\'s result to its parent (cez task report).' },
  'GET /runs/:id/search': { summary: 'Search the code in a task\'s worktree.', response: codeSearchResultSchema },
  'GET /runs/:id/terminal': { summary: 'The terminal sessions open in a task\'s worktree.', response: terminalStateSchema },
  'POST /runs/:id/terminal': { summary: 'Open a terminal session in a task\'s worktree.', response: terminalSessionSchema },
  'DELETE /runs/:id/terminal/:sessionId': { summary: 'Close a task terminal session.' },
  'POST /runs/:id/terminal/:sessionId/input': { summary: 'Type into a task terminal session.' },
  'GET /runs/:id/terminal/:sessionId/output': { summary: 'Read a task terminal session\'s output since a cursor.', response: terminalOutputSchema },
  'POST /runs/:id/terminal/:sessionId/resize': { summary: 'Resize a task terminal session.' },
  'GET /runs/:id/terminal/commands': { summary: 'The commands a task\'s terminal offers (project scripts).' },
  'GET /runs/:id/terminal/urls': { summary: 'The local URLs a task\'s terminal sessions printed.' },
  'GET /runs/:id/tracker-issue': { summary: 'The tracker ticket linked to a task.', response: trackerRunIssueResponseSchema },
  'GET /runs/:id/tree': { summary: 'The file tree of a task\'s worktree.', response: repoTreeSchema },
  'POST /runs/:id/unread': { summary: 'Mark a task unread.', response: runRecordSchema },
  'POST /runs/archive-finished': { summary: 'Archive every finished task.', response: archiveFinishedResponseSchema, destructive: true },
  'POST /runs/read-all': { summary: 'Mark every task read.', response: markAllReadResponseSchema },
  'GET /groups/:groupId': { summary: 'A variant group: the parallel runs of one prompt, side by side.', response: groupResponseSchema },
  'POST /groups/:groupId/pick': { summary: 'Pick the winning variant of a group.', response: pickVariantResponseSchema },
  'GET /todos': { summary: 'The project\'s todo inbox.', response: list(todoItemSchema) },
  'DELETE /todos/:id': { summary: 'Remove a todo.', response: removeTodoResponseSchema },
  'POST /todos/:id/start': { summary: 'Start a task from a todo.', response: startTodoResponseSchema },
  'GET /events': { summary: 'The project\'s live event stream (SSE).', notTool: 'stream' },

  // ---- workflows, skills ------------------------------------------------------
  'GET /workflows': { summary: 'The project\'s workflows, built-in and its own, with load issues.', response: workflowsResponseSchema },
  'POST /workflows': { summary: 'Create or replace a workflow from YAML.', response: saveWorkflowResponseSchema, tool: 'workflows_put' },
  'DELETE /workflows/:name': { summary: 'Delete a workflow (a built-in comes back).', response: deleteWorkflowResponseSchema },
  'POST /workflows/graph': { summary: 'Save a workflow from its graph form.', response: saveWorkflowResponseSchema },
  'GET /workflows/nodes': { summary: 'The node kinds a workflow graph can use.', response: workflowNodeCatalogResponseSchema },
  'POST /workflows/parse': { summary: 'Parse workflow YAML without saving it.', response: parsedWorkflowSchema },
  'POST /workflows/validate': { summary: 'Validate a workflow graph without saving it.', response: validateWorkflowGraphResponseSchema },
  'POST /plan': { summary: 'Draft a plan for a task prompt without starting it.', response: planResponseSchema },
  'GET /skills': { summary: 'The skills the project\'s agents can use.', response: list(skillSchema) },
  'GET /skills/importable': { summary: 'Skills found in agent folders that can be imported.', response: list(importableSkillSchema) },
  'POST /skills/refresh': { summary: 'Re-read skills from disk and the team repo.', response: list(skillSchema) },

  // ---- projects ---------------------------------------------------------------
  'GET /projects': { summary: 'Every project this cockpit serves, with status and branch.', response: projectsResponseSchema },
  'POST /projects': { summary: 'Register a folder as a project.', response: registerProjectResponseSchema },
  'DELETE /projects/:projectId': { summary: 'Forget a project (nothing on disk is touched).', response: removeProjectResponseSchema },
  'PATCH /projects/:projectId': { summary: 'Change a project\'s settings (name, concurrency).', response: updateProjectResponseSchema },
  'GET /projects/:projectId/icon': { summary: 'A project\'s icon.', notTool: 'binary' },
  'PUT /projects/:projectId/icon': { summary: 'Set a project\'s icon.' },
  'DELETE /projects/:projectId/icon': { summary: 'Remove a project\'s icon.' },
  'GET /projects/:projectId/icon-candidates': { summary: 'Icons found in a project\'s repo.', response: projectIconCandidatesSchema },
  'POST /projects/checkout': { summary: 'Clone a repository and register it as a project.', response: registerProjectResponseSchema },
  'POST /projects/create': { summary: 'Create a new repository and register it as a project.' },
  'GET /projects/github-owners': { summary: 'The GitHub accounts and orgs a new repo can belong to.', response: githubOwnersResponseSchema },
  'GET /projects/github-repos': { summary: 'GitHub repositories that can be cloned.', response: githubReposResponseSchema },
  'GET /fs/browse': { summary: 'Browse folders on this machine, to pick a project.', response: fsBrowseResponseSchema },

  // ---- repo (the project checkout) --------------------------------------------
  'GET /repo': { summary: 'The project checkout: branch, remotes, status.', response: repoResponseSchema },
  'POST /repo/branch': { summary: 'Create or switch a branch in the checkout.', response: repoBranchResponseSchema },
  'GET /repo/changes': { summary: 'Uncommitted changes in the checkout.', response: changesPayloadSchema },
  'GET /repo/commit/:sha': { summary: 'One commit in the checkout, with its diff.' },
  'GET /repo/diff': { summary: 'The checkout\'s uncommitted diff, as text.' },
  'POST /repo/fetch': { summary: 'Fetch the checkout\'s upstream.', response: repoSyncActionResponseSchema },
  'GET /repo/files': { summary: 'Read a file or list a directory in the checkout.' },
  'PUT /repo/files': { summary: 'Overwrite a file in the checkout.', response: runFileWriteResponseSchema },
  'POST /repo/files': { summary: 'Create a file in the checkout.', response: runFileWriteResponseSchema },
  'DELETE /repo/files': { summary: 'Delete a file in the checkout.', response: runFileDeleteResponseSchema },
  'POST /repo/files/rename': { summary: 'Rename a file in the checkout.', response: runFileRenameSchema },
  'POST /repo/pull': { summary: 'Pull the checkout\'s upstream.', response: repoPullResponseSchema },
  'POST /repo/push': { summary: 'Push the checkout\'s branch.', response: repoSyncActionResponseSchema },
  'GET /repo/search': { summary: 'Search the code in the checkout.', response: codeSearchResultSchema },
  'GET /repo/sync': { summary: 'How the checkout stands against its upstream.', response: repoSyncSchema },
  'POST /repo/sync': { summary: 'Fast-forward a clean checkout to its upstream.', response: repoSyncActionResponseSchema },
  'GET /repo/terminal': { summary: 'The terminal sessions open in the checkout.', response: terminalStateSchema },
  'POST /repo/terminal': { summary: 'Open a terminal session in the checkout.', response: terminalSessionSchema },
  'DELETE /repo/terminal/:sessionId': { summary: 'Close a checkout terminal session.' },
  'POST /repo/terminal/:sessionId/input': { summary: 'Type into a checkout terminal session.' },
  'GET /repo/terminal/:sessionId/output': { summary: 'Read a checkout terminal session\'s output since a cursor.', response: terminalOutputSchema },
  'POST /repo/terminal/:sessionId/resize': { summary: 'Resize a checkout terminal session.' },
  'GET /repo/tree': { summary: 'The checkout\'s file tree.', response: repoTreeSchema },
  'GET /repo/watch': { summary: 'Whether files in the checkout changed since a stamp.', response: codeWatchSchema },
  'GET /worktrees': { summary: 'Task worktrees on disk and what they hold.', response: worktreesResponseSchema },
  'POST /worktrees/reclaim': { summary: 'Delete the worktrees of finished tasks.', response: reclaimWorktreesResponseSchema, destructive: true },
  'GET /worktree-lifecycle': { summary: 'Worktree setup/teardown scripts and their state.', response: lifecycleListResponseSchema },
  'GET /worktree-lifecycle/:worktreeId': { summary: 'One worktree\'s lifecycle detail.', response: lifecycleDetailResponseSchema },
  'POST /worktree-lifecycle/operations': { summary: 'Run a lifecycle script for a worktree.', response: lifecycleOperationResponseSchema },
  'GET /worktree-lifecycle/operations/:operationId': { summary: 'One lifecycle operation.', response: lifecycleOperationResponseSchema },
  'POST /worktree-lifecycle/operations/:operationId/actions': { summary: 'Act on a lifecycle operation (retry, bypass, cancel).', response: lifecycleOperationResponseSchema },
  'GET /worktree-lifecycle/operations/:operationId/output': { summary: 'A lifecycle operation\'s output since a cursor.', response: lifecycleOutputResponseSchema },
  'POST /worktree-lifecycle/preview': { summary: 'Render a lifecycle command without running it.', response: lifecyclePreviewResponseSchema },

  // ---- github -----------------------------------------------------------------
  'GET /github': { summary: 'The repo\'s open GitHub issues and PRs.', response: githubDataSchema },
  'GET /github/checks': { summary: 'CI checks for a branch or PR.', response: githubChecksDataSchema },
  'GET /github/comments/:kind/:number': { summary: 'The comments on an issue or PR.', response: githubCommentsDataSchema },
  'GET /github/prs/:number/changes': { summary: 'The files a PR changes.', response: githubPrChangesDataSchema },
  'POST /github/prs/:number/merge': { summary: 'Merge a PR.', response: githubMergeResponseSchema, destructive: true },
  'GET /github/prs/:number/merge-state': { summary: 'Whether a PR can be merged, and why not.', response: githubPrMergeStateResponseSchema },
  'GET /github/ref-status': { summary: 'The state of issue and PR references.', response: githubRefStatusDataSchema },
  'GET /github/search': { summary: 'Search the repo\'s GitHub issues and PRs.', response: githubSearchDataSchema },

  // ---- automations --------------------------------------------------------------
  'GET /automations': { summary: 'The project\'s automations (GitHub polls, schedules, tracker watches).', response: automationsResponseSchema },
  'POST /automations': { summary: 'Create an automation.', response: automationResponseSchema },
  'GET /automations/:id': { summary: 'One automation with its recent activity.', response: automationDetailResponseSchema },
  'PUT /automations/:id': { summary: 'Replace an automation.', response: automationResponseSchema },
  'DELETE /automations/:id': { summary: 'Delete an automation.' },
  'POST /automations/:id/check': { summary: 'Dry-run an automation\'s poll now.', response: automationCheckQueuedResponseSchema },
  'POST /automations/:id/enable': { summary: 'Enable an automation.', response: automationResponseSchema },
  'POST /automations/:id/pause': { summary: 'Pause an automation.', response: automationResponseSchema },
  'POST /automations/:id/run': { summary: 'Run an automation once, now.', response: automationRunResponseSchema },
  'GET /automation-log': { summary: 'What automations did: receipts, newest first.', response: automationLogResponseSchema },
  'POST /automation-log/:receiptId/retry': { summary: 'Retry a failed automation receipt.', response: automationRetryResponseSchema },
  'GET /automation-checks/:checkId': { summary: 'The result of an automation dry-run.', response: automationCheckSchema },

  // ---- tracker ------------------------------------------------------------------
  'GET /tracker': { summary: 'Tickets in the project\'s linked issue tracker.', response: trackerItemsResponseSchema },
  'GET /tracker/:id': { summary: 'One tracker ticket.', response: trackerItemResponseSchema },
  'POST /tracker/:id/transition': { summary: 'Move a tracker ticket to another status.', response: trackerTransitionResponseSchema },
  'GET /tracker/:id/transitions': { summary: 'The statuses a tracker ticket can move to.', response: trackerTransitionsResponseSchema },
  'GET /tracker/association': { summary: 'Which tracker project this project is linked to.', response: trackerAssociationResponseSchema },
  'PUT /tracker/association': { summary: 'Link this project to a tracker project.', response: trackerAssociationSavedResponseSchema },
  'DELETE /tracker/association': { summary: 'Unlink this project from its tracker project.', response: trackerClearedResponseSchema },
  'GET /tracker/automation-options': { summary: 'What a tracker automation can watch and filter on.' },
  'GET /tracker/candidates': { summary: 'Tracker projects this project can be linked to.', response: trackerCandidatesResponseSchema },
  'GET /tracker/connection': { summary: 'The project\'s tracker connection (no secrets).', response: trackerConnectionResponseSchema },
  'PUT /tracker/connection': { summary: 'Connect the project to an issue tracker.', response: trackerConnectionResponseSchema },
  'DELETE /tracker/connection': { summary: 'Disconnect the project from its issue tracker.', response: trackerClearedResponseSchema },
  'POST /tracker/connection/copy': { summary: 'Copy another project\'s tracker connection.', response: trackerConnectionResponseSchema },
  'GET /tracker/connection/sources': { summary: 'Projects whose tracker connection can be copied.', response: trackerConnectionSourcesResponseSchema },
  'GET /tracker/search': { summary: 'Search tracker tickets.', response: trackerItemsResponseSchema },
  'POST /tracker/watch': { summary: 'Start watching tracker tickets for changes.', response: trackerWatchHandleSchema },
  'GET /tracker/watch/:watchId': { summary: 'What changed on a tracker watch.', response: trackerWatchSnapshotSchema },
  'POST /tracker/watch/:watchId': { summary: 'Refresh a tracker watch now.', response: trackerWatchSnapshotSchema },

  // ---- services, docker, e2e, start app, preview -----------------------------------
  'GET /services': { summary: 'The project\'s pinned services (dev servers, workers) and their state.', response: servicesStateSchema },
  'POST /services': { summary: 'Pin a command as a project service.', response: servicePinSchema },
  'PATCH /services/:id': { summary: 'Change a pinned service.', response: servicePinSchema },
  'DELETE /services/:id': { summary: 'Unpin a service.' },
  'POST /services/:id/input': { summary: 'Type into a service\'s terminal.' },
  'GET /services/:id/logs': { summary: 'A service\'s recent log lines.', response: serviceLogsSchema },
  'GET /services/:id/output': { summary: 'A service\'s terminal output since a cursor.', response: terminalOutputSchema },
  'POST /services/:id/resize': { summary: 'Resize a service\'s terminal.' },
  'POST /services/:id/restart': { summary: 'Restart a service.' },
  'POST /services/:id/start': { summary: 'Start a service.' },
  'POST /services/:id/stop': { summary: 'Stop a service.' },
  'POST /services/resume': { summary: 'Start the services that were running before a restart.', response: servicesStateSchema },
  'POST /services/start-all': { summary: 'Start every service.', response: servicesStateSchema },
  'POST /services/stop-all': { summary: 'Stop every service.', response: servicesStateSchema },
  'GET /docker': { summary: 'The project\'s Docker compose stacks and containers.', response: dockerStateSchema },
  'POST /docker/containers/:id/start': { summary: 'Start a container.' },
  'POST /docker/containers/:id/stop': { summary: 'Stop a container.' },
  'POST /docker/stacks/:name/start': { summary: 'Start a compose stack.' },
  'POST /docker/stacks/:name/stop': { summary: 'Stop a compose stack.' },
  'GET /e2e': { summary: 'Whether the project has an end-to-end test setup.', response: e2eStatusSchema },
  'POST /e2e/setup': { summary: 'Scaffold an end-to-end test setup.', response: e2eSetupResponseSchema },
  'GET /start-app': { summary: 'The command that starts the project\'s app.', response: startAppStateSchema },
  'PUT /start-app': { summary: 'Set the command that starts the project\'s app.', response: startAppStateSchema },
  'POST /preview/design-proxy': { summary: 'Open the Design Mode proxy for a previewed dev server.', response: designProxyResponseSchema, notTool: 'browser' },
  'POST /preview/gateway': { summary: 'Open the preview gateway for a dev server.', response: previewGatewayResponseSchema, notTool: 'browser' },

  // ---- env files, secrets ----------------------------------------------------------
  'GET /env-files': { summary: 'The project\'s managed .env files.', response: envFilesListSchema },
  'PUT /env-files': { summary: 'Write a managed .env file.', response: envFileContentSchema },
  'DELETE /env-files': { summary: 'Delete a managed .env file.' },
  'GET /env-files/content': { summary: 'The content of a managed .env file.', response: envFileContentSchema },
  'POST /env-files/render': { summary: 'Render a .env template with secrets filled in.', response: envFileRenderSchema },
  'POST /env-files/rerender': { summary: 'Re-render every .env file that uses a template.', response: envFilesRerenderSchema },
  'GET /secrets': { summary: 'The names of the project\'s secrets (never values).', response: secretsListSchema },
  'PUT /secrets/:name': { summary: 'Set a project secret.' },
  'DELETE /secrets/:name': { summary: 'Delete a project secret.' },
  'POST /secrets/:name/share': { summary: 'Copy a project secret to the user\'s workspace secrets.' },
  'GET /workspace/secrets': { summary: 'The names of the user\'s workspace secrets (never values).', response: secretsListSchema },
  'PUT /workspace/secrets/:name': { summary: 'Set a workspace secret.' },
  'DELETE /workspace/secrets/:name': { summary: 'Delete a workspace secret.' },

  // ---- settings ------------------------------------------------------------------------
  'GET /config': { summary: 'The project\'s cezar settings (.ai/cezar/config.json) with defaults.', response: configResponseSchema },
  'PUT /config': { summary: 'Change the project\'s cezar settings.', response: setConfigResponseSchema },
  'GET /agent-config': { summary: 'The coding agents\' own config files for this project, by agent.', response: agentConfigListingSchema },
  'GET /agent-config/:id': { summary: 'One agent config file\'s content.', response: agentConfigFileContentSchema },
  'PUT /agent-config/:id': { summary: 'Write an agent config file.', response: agentConfigFileContentSchema },
  'GET /ui-state': { summary: 'The cockpit\'s saved per-project UI state.', notTool: 'browser' },
  'PUT /ui-state': { summary: 'Save the cockpit\'s per-project UI state.', notTool: 'browser' },
  'GET /launch-key': { summary: 'The key a bookmarklet uses to launch tasks here.', response: launchKeyResponseSchema },
  'POST /open-in': { summary: 'Open the project in a local app (editor, terminal).', response: openProjectInResponseSchema },
  'GET /open-targets': { summary: 'The local apps a project or task can be opened in.', response: openTargetsResponseSchema },
  'GET /models': { summary: 'The models each agent backend offers.', response: runnerModelCatalogResponseSchema },
  'GET /providers/status': { summary: 'Which agent backends are installed and signed in.', response: providerStatusResponseSchema },
  'PUT /providers/:provider/enabled': { summary: 'Turn an agent backend on or off.', response: providerStatusResponseSchema },
  'POST /providers/:provider/retry': { summary: 'Re-check an agent backend\'s sign-in.', response: providerStatusResponseSchema },
  'POST /providers/:provider/update': { summary: 'Update an agent backend\'s CLI.', response: providerUpdateResponseSchema },
  'POST /providers/connect': { summary: 'Start signing an agent backend in.', response: providerConnectResponseSchema },
  'GET /health': { summary: 'Whether the cockpit is up, and its version and capabilities.', response: healthResponseSchema },
  'GET /star-count': { summary: 'cezar\'s own GitHub star count.', response: starCountSchema },
  'GET /telemetry/consent': { summary: 'The telemetry consent answer.', response: telemetryConsentSchema },
  'PUT /telemetry/consent': { summary: 'Answer the telemetry consent question.', response: telemetryConsentSchema, notTool: 'browser' },
  'POST /telemetry/error': { summary: 'The cockpit\'s error beacon.', notTool: 'browser' },
  'POST /telemetry/event': { summary: 'The cockpit\'s event beacon.', notTool: 'browser' },
  'POST /telemetry/page': { summary: 'The cockpit\'s page-view beacon.', notTool: 'browser' },

  // ---- workspace (the user and the machine) ------------------------------------------------
  'GET /workspace/agent-profiles': { summary: 'The agent accounts on this machine and which one each backend uses.', response: agentProfilesResponseSchema },
  'POST /workspace/agent-profiles': { summary: 'Add an agent account.', response: agentProfileResponseSchema },
  'PATCH /workspace/agent-profiles/:id': { summary: 'Rename or change an agent account.', response: agentProfileResponseSchema },
  'DELETE /workspace/agent-profiles/:id': { summary: 'Remove an agent account.', response: removeAgentProfileResponseSchema },
  'GET /workspace/agent-profiles/:id/details': { summary: 'An agent account\'s home and files.', response: agentAccountDetailsResponseSchema },
  'POST /workspace/agent-profiles/:id/open': { summary: 'Open an agent account\'s file in a local app.', response: openAgentAccountFileResponseSchema },
  'GET /workspace/agent-profiles/:id/status': { summary: 'An agent account\'s sign-in status.', response: agentAccountStatusResponseSchema },
  'PUT /workspace/agent-profiles/selection': { summary: 'Choose which account each backend uses.', response: agentProfileSelectionsResponseSchema },
  'GET /workspace/automation-templates': { summary: 'Ready-made automations to start from.', response: automationTemplatesResponseSchema },
  'GET /workspace/branding-logo': { summary: 'The cockpit\'s custom logo.', notTool: 'binary' },
  'POST /workspace/branding-logo': { summary: 'Upload the cockpit\'s custom logo.', response: workspaceBrandingLogoResponseSchema, notTool: 'binary' },
  'DELETE /workspace/branding-logo': { summary: 'Remove the cockpit\'s custom logo.', response: workspaceBrandingLogoResponseSchema },
  'GET /workspace/config': { summary: 'Workspace-wide settings (concurrency, memory, branding).', response: workspaceConfigResponseSchema },
  'PUT /workspace/config': { summary: 'Change workspace-wide settings.', response: workspaceConfigResponseSchema },
  'GET /workspace/dashboard': { summary: 'The dashboard: tasks across every project.', response: dashboardSnapshotSchema },
  'GET /workspace/dashboard/automations': { summary: 'The dashboard\'s automation activity.', response: dashboardAutomationsSchema },
  'GET /workspace/dashboard/costs': { summary: 'Spend across projects and backends.', response: dashboardCostsSchema },
  'GET /workspace/dashboard/feed': { summary: 'The dashboard\'s activity feed.', response: dashboardFeedSchema },
  'GET /workspace/dashboard/insights': { summary: 'The dashboard\'s insights.', response: dashboardInsightsSchema },
  'GET /workspace/dashboard/overview': { summary: 'The dashboard\'s headline numbers.', response: dashboardOverviewSchema },
  'GET /workspace/dashboard/tasks': { summary: 'One page of the dashboard\'s task list.', response: dashboardTasksPageSchema },
  'GET /workspace/dashboard/telemetry': { summary: 'The dashboard\'s usage telemetry.', response: dashboardTelemetrySchema },
  'GET /workspace/events': { summary: 'The workspace\'s live event stream (SSE).', notTool: 'stream' },
  'GET /workspace/host-usage': { summary: 'This machine\'s CPU and memory use.', response: hostUsageSchema },
  'GET /workspace/runs-index': { summary: 'Every task across every project, in brief.', response: runsIndexResponseSchema },
  'GET /workspace/self-update': { summary: 'cezar\'s installed version and available updates.', response: selfUpdateStatusSchema },
  'POST /workspace/self-update/apply': { summary: 'Update cezar and restart it.', response: selfUpdateStatusSchema, destructive: true },
  'PUT /workspace/self-update/channel': { summary: 'Choose cezar\'s update channel.', response: selfUpdateStatusSchema },
  'GET /workspace/self-update/development': { summary: 'Development builds cezar can switch to.' },
  'POST /workspace/self-update/refresh': { summary: 'Check for cezar updates now.', response: selfUpdateStatusSchema },
  'DELETE /workspace/self-update/scheduled': { summary: 'Cancel a scheduled cezar update.', response: selfUpdateStatusSchema },
  'GET /workspace/skills-update': { summary: 'Whether the Open Mercato skills are up to date.', response: skillsUpdateStateSchema },
  'POST /workspace/skills-update/apply': { summary: 'Update the Open Mercato skills.', response: skillsUpdateStateSchema },
  'POST /workspace/skills-update/check': { summary: 'Check for Open Mercato skills updates.', response: skillsUpdateStateSchema },
  'GET /workspace/ui-state': { summary: 'The cockpit\'s saved workspace UI state.', notTool: 'browser' },
  'PUT /workspace/ui-state': { summary: 'Save the cockpit\'s workspace UI state.', notTool: 'browser' },
  'POST /workspace/uploads': { summary: 'Stage an attachment for a task prompt.', response: stagedUploadSchema },
  'DELETE /workspace/uploads/:uploadId': { summary: 'Drop a staged attachment.', response: deleteUploadResponseSchema },

  // ---- auth (sign-in is never a tool; tokens never reach it) ------------------------------
  'POST /auth/login': { summary: 'Sign in: password step.', notTool: 'auth' },
  'POST /auth/login/verify': { summary: 'Sign in: authenticator step.', notTool: 'auth' },
  'POST /auth/logout': { summary: 'Sign out.', notTool: 'auth' },
  'POST /auth/password': { summary: 'Change the password.', notTool: 'auth' },
  'POST /auth/recovery-codes': { summary: 'Regenerate recovery codes.', notTool: 'auth' },
  'GET /auth/session': { summary: 'Who is signed in.', notTool: 'auth' },
  'GET /auth/sessions': { summary: 'The signed-in devices.', notTool: 'auth' },
  'DELETE /auth/sessions/:id': { summary: 'Sign a device out.', notTool: 'auth' },
  'POST /auth/sessions/revoke-others': { summary: 'Sign every other device out.', notTool: 'auth' },
  'POST /auth/setup/begin': { summary: 'Create the owner account: password step.', notTool: 'auth' },
  'POST /auth/setup/complete': { summary: 'Create the owner account: authenticator step.', notTool: 'auth' },
} satisfies Record<string, RouteContract>;

export type RouteKey = keyof typeof routeContracts;

/** The entry for `METHOD /path`, or undefined — the catalog's one lookup. */
export function routeContractOf(method: string, path: string): RouteContract | undefined {
  return (routeContracts as Record<string, RouteContract>)[`${method} ${path}`];
}
