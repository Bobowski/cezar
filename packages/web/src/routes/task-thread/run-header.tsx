import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleStopIcon,
  CopyIcon,
  EllipsisIcon,
  FileTextIcon,
  GitBranchIcon,
  MailIcon,
  PencilIcon,
  PinIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { Fragment, memo, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { ApiError, archiveRun, cancelRun, deleteRun, openRunIn, openRunInCli } from '@/api/client'
import {
  queryKeys,
  useHealth,
  useMarkRunSeen,
  useMarkRunUnseen,
  useOpenTargets,
  usePatchRun,
  usePinRun,
  useProjectRepoBase,
  useReferenceProjectId,
  useProviderStatus,
  useRunHandoff,
  useRuns,
} from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { TitleEditInput, useTitleEditor, type TitleEditor } from '@/components/editable-title'
import { TOGGLE_ON_ICON_CLASS } from '@/components/pin-toggle'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceOverflow } from '@/components/reference-overflow'
import { ResolveConflictsButton } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { TabLink } from '@/components/tab-link'
import { forgetViewMemory } from '@/lib/view-memory'
import { forgetTask } from '@/routes/task-workspace/layout-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { OpenInMenu, type OpenInChoice } from '@/components/open-in-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DirectionalUsage } from '@/components/directional-usage'
import { ATTENTION_RANK, budgetStop, deriveAttention, type AttentionTone } from '@/lib/attention'
import { queuePositions, runTitle } from '@/lib/task-groups'
import { usableRunners } from '@/lib/provider-status'
import {
  formatCost,
  prNumber,
  taskIssueUrl,
  taskPrUrl,
  taskReferences,
  workflowLabel,
} from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { isHttpUrl } from '@/lib/utils'

import { Markdown } from './markdown'
import { cliTargetResumes, cliTargetRunner, finishTitle, resumeHint, runActionFlags } from './run-actions'
import { cn } from '@/lib/utils'
import { GIT_ACTION_ICONS, GitActions } from '../task-git/git-toolbar'
import { useRunGitStep, type RunGitStep } from '../task-git/run-git-step'
import { RunConfirmDialog, type RunConfirmKind } from './run-confirm-dialog'
import { useRunEngine } from './run-engine'
import { WorkflowSteps } from './step-rail'
import { useFinishRun } from './use-finish-run'
import { useDraft } from './thread-draft'

/**
 * The run header (spec §"Task thread" → Header): editable title + status pill, the meta line,
 * the Session | Changes | Files tabs with the action bar, the workflow step rail and the plan
 * mirror — the whole header region above the thread. It scrolls away on phones so the transcript
 * owns the small viewport, and stays sticky from `md` upward where there is room for persistent
 * run context.
 *
 * Two deliberate omissions, both seams rather than gaps:
 *  - **VS Code** (spec: `POST /api/runs/:id/open-in-editor`) — the endpoint does not exist yet;
 *    R5 adds it driver-detected. Faking the button against nothing would be dishonest.
 *  - **Hosted mode** (spec §"Deployment modes"): when R5's `capabilities.localHandoff` lands in
 *    `/api/health`, Terminal (and VS Code) must disappear entirely and the resume hint must drop
 *    its `cd`. Today's HealthResponse carries no such field, so Terminal renders per current
 *    (local-only) behavior — the gate goes in where the flags are read, `runActionFlags` callers.
 */
/** Which run-detail tab this header instance sits above — drives the active underline.
 *  A prop rather than a route match so the header stays testable with a bare render. */
export type RunTab = 'session' | 'changes' | 'commits' | 'files' | 'graph' | 'notes'

interface RunHeaderProps {
  run: ApiRun
  planTally?: { done: number; total: number }
  tab?: RunTab
  /** Fired the moment "Mark unread" is invoked, BEFORE the mutation — the Session tab uses it
   *  to suppress its auto-mark-read effect for the rest of the visit (#775). Optional because
   *  the three `task-git` tabs render this same header and run no such effect. */
  onMarkedUnread?: () => void
  /** The Session tab's engine picker for the next continuation. Kept out of the three Git tabs:
   *  they share this header but do not own the continuation draft or its pending selection. */
  continuationEngine?: ReactNode
  /** REPLACES the Session | Changes | Commits | Files row (spec `2026-10-07-task-workspace` §2:
   *  "Replace the current … tab strip with the saved-layout cards; do not show both strips").
   *  A slot rather than a flag so this file keeps knowing nothing about layouts, and so the four
   *  route tabs stay the default for every surface that still navigates by URL. The actions on
   *  the right of that row are unaffected — they belong to the run, not to the navigation. */
  tabs?: ReactNode
  /** Extra controls at the right end of the tab row — the workspace's terminal toggle. */
  trailing?: ReactNode
  /** The very last control on the strip, after the run's actions — the workspace's full view. */
  trailingEnd?: ReactNode
  /**
   * Which part of the header to draw.
   *  - `full` (default): the strip, then the title, facts and actions under it.
   *  - `strip`: only the layout strip, with the run's actions folded into its right end — what the
   *    workspace shows above every layout.
   *  - `overview`: no strip at all; just the title, actions and facts — the bar at the head of the
   *    workspace's fixed Chat layout.
   */
  mode?: 'full' | 'strip' | 'overview'
  /** In `strip` mode, leave the run's actions out — the bar below already shows them. */
  bareStrip?: boolean
}

// Every prop must participate: adding one without a comparator is a compile error.
const headerPropComparators = {
  run: (before, after) => before.run === after.run,
  tab: (before, after) => before.tab === after.tab,
  onMarkedUnread: (before, after) => before.onMarkedUnread === after.onMarkedUnread,
  continuationEngine: (before, after) => before.continuationEngine === after.continuationEngine,
  // The workspace memoizes the element it passes, so identity is a real comparison here.
  tabs: (before, after) => before.tabs === after.tabs,
  trailing: (before, after) => before.trailing === after.trailing,
  trailingEnd: (before, after) => before.trailingEnd === after.trailingEnd,
  mode: (before, after) => before.mode === after.mode,
  bareStrip: (before, after) => before.bareStrip === after.bareStrip,
  planTally: (before, after) => before.planTally?.done === after.planTally?.done &&
    before.planTally?.total === after.planTally?.total,
} satisfies Record<keyof RunHeaderProps, (before: RunHeaderProps, after: RunHeaderProps) => boolean>
const compareHeaderProps = Object.values(headerPropComparators)

export const RunHeader = memo(RunHeaderView, (before, after) =>
  compareHeaderProps.every((compare) => compare(before, after)),
)

function RunHeaderView({
  run,
  planTally,
  tab = 'session',
  onMarkedUnread,
  continuationEngine,
  tabs,
  trailing,
  trailingEnd,
  mode = 'full',
  bareStrip = false,
}: RunHeaderProps) {
  const attention = deriveAttention(run)
  const budget = budgetStop(run)
  const hint = resumeHint(run)
  const [notesOpen, setNotesOpen] = useState(false)
  const actions = useRunActions(run, onMarkedUnread)

  // The queue position a parked run shows in its pill ("queued #2"). Reads the shared runs-list
  // query — already warm from the sidebar quick-list — because position is a property of the
  // whole queue, not of this record.
  const queuePosition = useRuns(
    useMemo(
      () => (runs: ApiRun[]) =>
        run.status === 'queued' ? queuePositions(runs).get(run.id) : undefined,
      [run.id, run.status],
    ),
  ).data
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)
  const refs = useRunReferences(run)

  // The same pieces, arranged three ways (see `mode`).
  const status = (
    <>
          <Badge variant="outline" data-slot="run-status" className="gap-1.5 font-medium text-muted-foreground">
            <StatusDot tone={attention.tone} pulse={attention.pulse} />
            {attention.label}
            {queuePosition !== undefined ? ` #${queuePosition}` : ''}
          </Badge>
          {budget ? (
            <span data-slot="budget-stop" className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
              Spent {formatCost(budget.spent) || '$0.00'} of {formatCost(budget.ceiling) || '$0.00'}
            </span>
          ) : null}
    </>
  )
  // A component, not a fragment: it owns the git step's status poll, so a header that draws no
  // actions (the workspace's bare strip) does not ask for one.
  const actionButtons = (
    <RunActionButtons run={run} actions={actions} hint={hint} onOpenNotes={() => setNotesOpen(true)} />
  )
  const facts = (
    <>
      <MetaRow
        run={run}
        references={refs.references}
        hint={hint}
        planTally={planTally}
        continuationEngine={continuationEngine}
        showTokens={metricVisibility.tokens}
        showCost={metricVisibility.cost}
        // `capabilities?.` like `usageMetricVisibility` above it: this header is rendered
        // against minimal health payloads (a `{defaultRunner}`-only answer is pinned by its
        // own test), so every capability read here tolerates an absent object. Absent stays
        // fail-closed — the chip degrades to text rather than linking into a disabled view.
        automationsAvailable={health.data?.capabilities?.automations === true}
      />
      {/* "This run wakes itself up at 14:20" is status, not metadata — it stays on the page. */}
      <MonitoringSchedule run={run} />
      {/* Who ordered this task, and what it dispatched, are what the run IS doing right now. */}
      <DispatchParentLine run={run} />
      <DispatchChildrenLine run={run} />

    </>
  )
  const overlays = (
    <>
      <NotesSheet runId={run.id} open={notesOpen} onOpenChange={setNotesOpen} />
      <RunConfirmDialog
        run={run}
        confirming={actions.confirming}
        onOpenChange={(open) => !open && actions.setConfirming(null)}
        onConfirm={(kind) => (kind === 'delete' ? actions.delete.mutate() : actions.cancel.mutate())}
      />
    </>
  )

  if (mode === 'overview') {
    // The task's own bar — title, state, actions, then the facts — as the head of the fixed Chat
    // layout. No strip: the workspace draws that once, above every layout.
    return (
      <ReferenceStatusProvider projectId={refs.projectId} requests={refs.requests}>
      <div data-slot="run-bar" className="shrink-0 border-b border-border bg-background px-4 pt-3 pb-3 sm:px-6 md:pt-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <EditableTitle run={run} />
            {status}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {actionButtons}
            {trailingEnd}
          </div>
        </div>
        {facts}
        {overlays}
      </div>
      </ReferenceStatusProvider>
    )
  }

  return (
    // Around the whole header, not just the meta row: the git step reads the PR's forge status.
    <ReferenceStatusProvider projectId={refs.projectId} requests={refs.requests}>
    <header
      data-slot="run-header"
      data-mode={mode}
      className={cn(
        'relative z-20 shrink-0 border-b border-border bg-background px-4 pt-1.5 sm:px-6 md:sticky md:top-0',
        mode === 'full' && 'pb-3',
      )}
    >
      {/* The layout strip leads the header: it is what you switch between, and everything below
          it — the title, the facts, the actions — is about the task whichever layout is up. It
          bleeds to the header's edges so its rule reads as the strip's own. */}
      <div
        data-slot="run-tabs"
        // A container: what the right side carries answers to the STRIP's width, not the window's —
        // the same window is a wide strip with the sidebar closed and a narrow one with it open.
        className={cn('@container/strip -mx-4 flex items-end gap-2 px-4 sm:-mx-6 sm:px-6', mode === 'full' && 'border-b border-border')}
      >
        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-clip">
          {/* `tabs` is the workspace's saved-layout strip, which REPLACES this row (spec
              `2026-10-07-task-workspace` §5.2: "do not show both strips"). The fallback is what
              every other consumer of this header still gets — including the Graph tab, which
              belongs to the route strip rather than to the workspace's layout cards. */}
          {tabs ?? (
            <>
              <TabLink to={`/tasks/${run.id}`} active={tab === 'session'}>
                Chat
              </TabLink>
              <TabLink to={`/tasks/${run.id}/changes`} active={tab === 'changes'}>
                Changes
              </TabLink>
              <TabLink to={`/tasks/${run.id}/commits`} active={tab === 'commits'}>
                Commits
              </TabLink>
              <TabLink to={`/tasks/${run.id}/files`} active={tab === 'files'}>
                Code
              </TabLink>
              {/* The live workflow graph — every run with a definition: a step list opens as its graph. */}
              {run.workflowDef ? (
                <TabLink to={`/tasks/${run.id}/graph`} active={tab === 'graph'}>
                  Graph
                </TabLink>
              ) : null}
              {/* The handoff journal as a deep-linkable tab (#1337); the workspace's layout strip
                  has no route tabs, so "More" keeps opening it in a sheet as well. */}
              <TabLink to={`/tasks/${run.id}/notes`} active={tab === 'notes'}>
                Notes
              </TabLink>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 pb-1">
          <WorkflowSteps runId={run.id} steps={run.steps} className="hidden max-w-80 sm:flex @max-7xl/strip:[&_[data-slot=step-name]]:hidden @max-3xl/strip:hidden" />
          {trailing}
          {/* In the strip there is no title row to carry them, so the run's actions sit here. */}
          {mode === 'strip' && !bareStrip ? actionButtons : null}
          {trailingEnd}
        </div>
      </div>
      {mode === 'full' ? (
        <>
          <div className="flex min-w-0 items-center gap-3 pt-3 md:pt-4">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <EditableTitle run={run} />
              {status}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">{actionButtons}</div>
          </div>
          {facts}
        </>
      ) : null}
      {run.steps.length > 0 ? (
        // Phone width: the stepper gets its own row instead of squeezing the tabs.
        <div className="-mx-2 border-t border-border py-1 sm:hidden">
          <WorkflowSteps runId={run.id} steps={run.steps} className="w-full" />
        </div>
      ) : null}

      {overlays}
    </header>
    </ReferenceStatusProvider>
  )
}

/** The run's buttons and its "More" menu, from one `useRunGitStep` — the git button and the
 *  menu's first item are the same step, the same mutation, the same commit dialog (#1337). */
function RunActionButtons({
  run,
  actions,
  hint,
  onOpenNotes,
}: {
  run: ApiRun
  actions: RunActions
  hint?: string
  onOpenNotes: () => void
}) {
  const flags = runActionFlags(run)
  const git = useRunGitStep(run)
  // ONE primary action, picked by what the run's state calls for. Continue is not among them:
  // it is the composer's send, which carries the prompt and the engine picks (#1337).
  const primary: 'finish' | 'stop' | null = flags.finish ? 'finish' : flags.cancel ? 'stop' : null
  return (
    <>
      <div data-slot="run-actions" className="hidden items-center gap-1.5 md:flex @max-4xl/strip:hidden">
        <OpenInMenuForRun run={run} canResume={flags.terminal} onResume={() => actions.terminal.mutate()} />
        {/* The run's one next git step (Commit, Push, Create PR, Update branch, …), or nothing. */}
        <GitActions action={git.action} onAction={git.onAction} />
        {primary === 'finish' ? (
          <Button variant="default" size="sm" title={finishTitle(run.status)} onClick={() => actions.finish.mutate()}>
            <CheckIcon aria-hidden="true" />
            Finish
          </Button>
        ) : primary === 'stop' ? (
          <Button variant="outline" size="sm" onClick={() => actions.setConfirming('cancel')}>
            <CircleStopIcon aria-hidden="true" />
            Stop
          </Button>
        ) : null}
      </div>
      <MoreMenu
        run={run}
        actions={actions}
        git={git}
        hint={hint}
        onOpenNotes={onOpenNotes}
      />
      {/* Outside the menu: a dialog mounted in a dropdown's content closes with it. */}
      {git.dialogs}
    </>
  )
}

/**
 * "Open in…" session takeover (#open-in): resume the session in a real terminal, open the run's
 * worktree in a local editor / Finder / terminal / agent CLI, or copy its path.
 *
 * The menu itself is the shared `OpenInMenu` (components/open-in-menu.tsx); what lives here is
 * everything run-SPECIFIC — the resume item, which agent handoffs are currently usable, the
 * `(resume)` labelling, and the copy-path row. Renders when the session can be resumed OR the
 * machine offers worktree targets (both empty in hosted mode → nothing to show).
 */
function OpenInMenuForRun({
  run,
  canResume,
  onResume,
}: {
  run: ApiRun
  canResume: boolean
  onResume: () => void
}) {
  const targets = useOpenTargets()
  const providers = useProviderStatus()
  const open = useMutation({
    mutationFn: (target: string) => openRunIn(run.id, target),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const availableRunners = usableRunners(providers.data)
  // The action routes remain authoritative for a stale browser. Once the complete status has
  // arrived, hide only unavailable *agent* handoffs; editors, Finder, and file tools stay
  // available because they do not launch a provider.
  const agentAvailable = (runner: ApiRun['runner']) =>
    !providers.isSuccess || availableRunners.includes(runner ?? 'claude')
  const canResumeHere = canResume && agentAvailable(run.runner)
  const choices: OpenInChoice[] = run.worktreePath
    ? (targets.data?.targets ?? [])
        .filter((target) => {
          const runner = cliTargetRunner(target.id)
          return runner === undefined || agentAvailable(runner)
        })
        // Agent-CLI targets (#402): the one matching this run's own runner resumes THIS run's
        // session when one exists — label that explicitly so it reads as different from just
        // opening the editor/file-manager entries. Every other CLI (wrong backend, or no session
        // yet) still opens, just starts clean — no silent cross-backend resume attempt.
        .map((target) => {
          const resumes = cliTargetResumes(run, target.id)
          return {
            target,
            ...(resumes ? { suffix: ' (resume)', title: "Resume this run's session" } : {}),
          }
        })
    : []
  if (!canResumeHere && choices.length === 0) return null

  const copyPath = () => {
    const path = run.worktreePath
    if (!path) return
    void navigator.clipboard
      .writeText(path)
      .then(() => toast('Worktree path copied'))
      .catch(() => toast(`Path: ${path}`))
  }

  return (
    <OpenInMenu
      choices={choices}
      onPick={(target) => open.mutate(target)}
      title="Resume in a terminal, or open the worktree locally"
      triggerVariant="outline"
      leading={
        canResumeHere ? (
          <DropdownMenuItem data-target="terminal-resume" onSelect={onResume}>
            <SquareTerminalIcon aria-hidden="true" />
            Terminal (resume session)
          </DropdownMenuItem>
        ) : null
      }
      trailing={
        run.worktreePath ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={copyPath}>
              <CopyIcon aria-hidden="true" />
              Copy worktree path
            </DropdownMenuItem>
          </>
        ) : null
      }
    />
  )
}

/** The mutations + confirm state, bundled so the desktop bar and the mobile kebab drive the
 *  exact same behavior. Every failure surfaces the server's own words as a danger toast. */
function useRunActions(run: ApiRun, onMarkedUnread?: () => void) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState<RunConfirmKind | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const onError = (error: Error) => {
    // Every 409 here says the same thing: the record these buttons were drawn from is not the run
    // the server has (Continue on a run that is running again, Cancel on one that just finished).
    // Refetch it, so the bar redraws to the truth instead of offering the same refused action —
    // the composer's rule (deliver-prompt.ts) and the thread's healer (run-reconcile.ts), applied
    // to the actions. `useSendMessage` in queries.ts has always done exactly this.
    if (error instanceof ApiError && error.status === 409) void invalidate()
    toast(error.message, { tone: 'danger' })
  }

  // Shared with the review panel's ✓ Accept (use-finish-run.ts) — the review-accept semantics
  // must be ONE implementation, not two buttons that happen to agree today.
  const finish = useFinishRun(run.id)
  const archive = useMutation({
    mutationFn: () => archiveRun(run.id, !run.archived),
    onSuccess: invalidate,
    onError,
  })
  // Pin/unpin (#935) — the shared hook rather than a local mutation, because the sidebar and the
  // Tasks table drive the same action and the cache rule belongs in one place. Toggling off the
  // record, exactly like archive above.
  const pinMutation = usePinRun()
  const pin = {
    isPending: pinMutation.isPending,
    mutate: () => pinMutation.mutate({ id: run.id, pinned: !run.pinned }, { onError }),
  }
  // Mark unread (#775) drives the shared optimistic hook rather than a local mutation: the
  // cache choreography (clear `seenAt`, guarded rollback) belongs next to its read twin in
  // queries.ts, and no `invalidate` is wanted here — an invalidation would refetch the list
  // and reinstate the receipt before the server's own answer lands.
  const markUnreadMutation = useMarkRunUnseen()
  const markUnread = {
    isPending: markUnreadMutation.isPending,
    mutate: () => {
      // Before the mutation, so the Session tab's suppression is in place by the time the
      // optimistic write re-renders the thread and re-evaluates its auto-mark-read effect.
      onMarkedUnread?.()
      markUnreadMutation.mutate(run.id, { onError })
    },
  }
  // Mark read — the twin of the above, through the same optimistic hook the thread's own
  // auto-read uses, so a click here and opening the task stamp the receipt identically.
  const markReadMutation = useMarkRunSeen()
  const markRead = {
    isPending: markReadMutation.isPending,
    mutate: () => markReadMutation.mutate(run.id, { onError }),
  }
  const cancel = useMutation({ mutationFn: () => cancelRun(run.id), onSuccess: invalidate, onError })
  const deleteMutation = useMutation({
    mutationFn: () => deleteRun(run.id),
    onSuccess: () => {
      invalidate()
      // The task is gone for good, so its browser-local state goes with it (spec
      // `2026-10-07-task-workspace` §5.3). The server drops the shells, their process trees and
      // the addresses they printed; the layouts and the drawer live in localStorage, which no
      // server route can reach — and a task id is never reused, so leaving them would be a leak
      // nothing ever cleans up.
      forgetTask(run.id)
      forgetViewMemory(`${run.id}:`)
      // The run is gone — so is this page. Home is the only honest destination.
      void navigate('/')
    },
    onError,
  })
  const terminal = useMutation({
    mutationFn: () => openRunInCli(run.id),
    onError: (error: Error) => {
      // The legacy 409 fallback: no terminal emulator → the server sends the manual command;
      // put it on the clipboard so "no terminal" still ends with the user one paste away.
      if (error instanceof ApiError && error.command) {
        void copyToClipboard(error.command, 'No terminal found — command copied to clipboard.')
        return
      }
      onError(error)
    },
  })

  return {
    finish,
    archive,
    pin,
    markUnread,
    markRead,
    cancel,
    delete: deleteMutation,
    terminal,
    confirming,
    setConfirming,
  }
}

type RunActions = ReturnType<typeof useRunActions>

async function copyToClipboard(text: string, doneMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(doneMessage)
  } catch {
    // No clipboard access (permissions, http) — show the command itself; it is the payload.
    toast(`Run manually: ${text}`)
  }
}

/**
 * The editable title (#389): a plain h1 with a pencil that only appears on hover (mockup
 * `.pencil-btn`), flipping into an inline input. Enter/blur commit through `usePatchRun`
 * (the server stores it as both `title` and `titleSummary`), Escape abandons the draft.
 * The rename machine itself is shared with the Tasks table (`components/editable-title.tsx`).
 */
function EditableTitle({ run }: { run: ApiRun }) {
  const patch = usePatchRun(run.id)
  const title = runTitle(run)
  const draft = useDraft(run.id, 'title')
  const editor = useTitleEditor(title, (next) =>
    patch.mutate({ title: next }, { onError: (error) => toast(error.message, { tone: 'danger' }) }),
  )
  const drafted: TitleEditor = {
    ...editor,
    setDraft: (value) => {
      editor.setDraft(value)
      draft.setText(value)
    },
    commit: () => {
      editor.commit()
      draft.clear()
    },
    cancel: () => {
      editor.cancel()
      draft.clear()
    },
  }

  const begin = useRef(editor.beginWith)
  begin.current = editor.beginWith
  const editing = editor.editing
  useEffect(() => {
    if (editing || !draft.ready || !draft.hasDraft) return
    begin.current(draft.text)
  }, [draft.hasDraft, draft.ready, draft.text, editing])

  if (editor.editing) {
    return <TitleEditInput editor={drafted} className="flex-1 text-lg font-semibold" />
  }

  return (
    <span className="group flex min-w-0 items-center gap-1">
      <h1 className="min-w-0 truncate text-lg leading-7 font-semibold text-foreground" title={run.task}>
        {title}
      </h1>
      <Button
        type="button"
        aria-label="Rename task"
        onClick={editor.begin}
        variant="ghost" size="icon-xs" className="size-[22px] text-soft-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-ring/50"
      >
        <PencilIcon className="size-3.5" aria-hidden="true" />
      </Button>
    </span>
  )
}

/** Copyable task branch with confirmation kept local so hovering it does not re-render MetaRow. */
function CopyBranchChip({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (dismissTimer.current !== null) clearTimeout(dismissTimer.current)
    },
    [],
  )

  const copy = () => {
    if (!navigator.clipboard) {
      toast(`Branch: ${branch}`)
      return
    }
    void navigator.clipboard
      .writeText(branch)
      .then(() => {
        setCopied(true)
        setTooltipOpen(true)
        if (dismissTimer.current !== null) clearTimeout(dismissTimer.current)
        dismissTimer.current = setTimeout(() => {
          dismissTimer.current = null
          setTooltipOpen(false)
        }, 1_500)
      })
      .catch(() => toast(`Branch: ${branch}`))
  }

  return (
    <TooltipProvider>
      <Tooltip
          open={tooltipOpen}
          onOpenChange={(open) => {
            if (open && dismissTimer.current === null) setCopied(false)
            setTooltipOpen(open)
          }}
        >
          <TooltipTrigger asChild>
            <Button
              type="button"
              data-slot="branch-chip"
              variant="ghost" size="xs" className="h-auto max-w-56 shrink cursor-copy justify-start px-1 py-0.5 font-mono font-normal focus-visible:ring-ring/50"
              aria-label={`Copy branch name ${branch}`}
              onClick={copy}
            >
              <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{branch}</span>
              <span className="sr-only" role="status">
                {copied ? 'Branch name copied' : ''}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copied ? 'Copied' : 'Copy branch name'}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** workflow · branch chip · ± on the left; tokens · cost · agent icon on the right (mockup
 *  `.meta-row`, #416). Each part renders only when the record carries it — absence is absence,
 *  not a placeholder. Runner and model no longer sit in the loose dot-list (#416): they read as
 *  a status for the *active* session, so they move into the agent badge next to the token
 *  count, revealed on hover/focus rather than always-on text. */
function MetaRow({
  run,
  references,
  hint,
  planTally,
  showTokens,
  showCost,
  automationsAvailable,
  continuationEngine,
}: {
  run: ApiRun
  /** The header's resolved references (`useRunReferences`) — its PR chips are painted here. */
  references: ReturnType<typeof taskReferences>
  /** The take-over command, when the engine has let go of the session. */
  hint?: string
  planTally?: { done: number; total: number }
  showTokens: boolean
  showCost: boolean
  continuationEngine?: ReactNode
  /** `capabilities.automations` (#801). A run launched while automations were on keeps its
   *  `run.automation` provenance forever, so the chip must survive the flag going off — as
   *  plain text, because the route it used to link to is disabled. */
  automationsAvailable: boolean
}) {
  // #526: the issue chip may be synthesized from the CEZ:ISSUE marker, and the only repository
  // such a link may name is the one on screen — never the transcript's.
  const repoBase = useProjectRepoBase()
  // A dispatched child carries no ticket link of its own: it shows its root's, read from the run
  // list the cockpit already holds. Derived on every render, never stored on the child.
  const rootRunId = run.trackerLinks?.length ? undefined : run.dispatch?.rootRunId
  const inheritedLinks = useRuns(
    useMemo(
      () => (runs: ApiRun[]) => (rootRunId && rootRunId !== run.id ? runs.find((entry) => entry.id === rootRunId)?.trackerLinks : undefined),
      [rootRunId, run.id],
    ),
  ).data
  // `workflowLabel` so an inline chain shows its first step's name, not the bare "(planned)"
  // placeholder — which reads like a status next to the live status pill.
  const parts: ReactNode[] = [
    <span key="workflow" className="font-medium text-foreground">
      {workflowLabel(run)}
    </span>,
  ]
  const branch = run.branch
  if (branch) {
    parts.push(<CopyBranchChip key="branch" branch={branch} />)
  }
  // EVERY PR the task points at: the strongest on the row, all of them behind a `+N` — the same
  // cell the global Tasks table paints (see `prChipNodes`).
  parts.push(...prChipNodes(run, references))
  const issueUrl = taskIssueUrl(run, repoBase)
  if (issueUrl && isHttpUrl(issueUrl)) {
    const number = prNumber(issueUrl)
    parts.push(
      <ReferenceChip
        key="issue"
        reference={{ kind: 'Issue', ...(number ? { number: Number(number) } : {}), url: issueUrl }}
        taskTitle={runTitle(run)}
        className="h-5"
      />,
    )
  }
  if (run.diffStat) parts.push(<DiffStatLabel key="diff" stat={run.diffStat} />)
  // The tracker ticket this task works on: structured provenance, never parsed from the prompt.
  const inherited = !run.trackerLinks?.length && !!inheritedLinks?.length
  for (const link of run.trackerLinks?.length ? run.trackerLinks : inheritedLinks ?? []) {
    const status = link.latest?.status ?? link.snapshot?.status
    const label = status ? `${link.itemId} · ${status}` : link.itemId
    const when = link.latest ? (link.snapshot && link.snapshot.status !== link.latest.status ? `moved here from "${link.snapshot.status}", its status when this task started` : 'status after the last move made in cezar') : "status as of this task's start"
    const title = [link.title, inherited ? 'the ticket of the task that dispatched this one' : undefined, link.title ? when : undefined].filter(Boolean).join(' — ') || undefined
    parts.push(link.url && isHttpUrl(link.url)
      ? <a key={`tracker:${link.itemId}`} data-slot="tracker-origin" data-inherited={inherited ? '' : undefined} href={link.url} target="_blank" rel="noopener noreferrer" title={title} className="underline-offset-2 hover:text-foreground hover:underline">{label}</a>
      : <span key={`tracker:${link.itemId}`} data-slot="tracker-origin" title={title}>{label}</span>)
  }
  if (run.automation) {
    // Provenance is history and is always shown; only the LINK is gated. Following it with the
    // capability off would land on the disabled `/automations` state, which says nothing about
    // this task.
    parts.push(
      automationsAvailable ? (
        <Link
          key="automation"
          to={`/automations/${encodeURIComponent(run.automation.automationId)}/log`}
          className="underline-offset-2 hover:text-foreground hover:underline"
        >
          Automation
        </Link>
      ) : (
        <span
          key="automation"
          data-slot="automation-origin"
          title="Automations are off on this server (CEZ_AUTOMATIONS)"
        >
          Automation
        </span>
      ),
    )
  }

  if (planTally) {
    // The plan dock's compact mirror (spec: "mirrored as a compact progress line in the run
    // header"). Desktop only since #764: on a phone the dock it mirrors is itself on screen.
    parts.push(
      <span key="plan" data-slot="plan-mirror" className="hidden tabular-nums md:inline">
        Plan {planTally.done}/{planTally.total}
      </span>,
    )
  }

  return (
      <div
        data-slot="run-meta"
        className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground"
      >
        {/* Index keys: two references may carry the same number (the PR a task opened and the
            PR it is about), so the parts' own keys are not unique. */}
        {parts.map((part, index) => (
          <Fragment key={index}>{part}</Fragment>
        ))}
        <RunDetails
          run={run}
          hint={hint}
          showTokens={showTokens}
          showCost={showCost}
          continuationEngine={continuationEngine}
        />
      </div>
  )
}

/** The task's references, resolved once for the whole header so every chip and the git step are
 *  answered by the same status batch. */
function useRunReferences(run: ApiRun) {
  // #526: a chip may be synthesized from a CEZ:PR / CEZ:ISSUE marker, and the only repository
  // such a link may name is the one on screen — never the transcript's.
  const repoBase = useProjectRepoBase()
  // A handful of references at most — but through the same seam as the Tasks table, which is what
  // keeps the header's chip and the table's chip answering identically for the same PR.
  const projectId = useReferenceProjectId()
  const references = useMemo(() => taskReferences(run, repoBase), [run, repoBase])
  const requests = useMemo(
    () =>
      projectId === undefined
        ? []
        : references.map((reference) => ({
            projectId,
            kind: reference.kind,
            number: reference.number,
          })),
    [references, projectId],
  )
  return { projectId, references, requests }
}

/** The task's pull-request chips for the meta row: the strongest PR, the rest behind `+N`. */
function prChipNodes(run: ApiRun, references: ReturnType<typeof taskReferences>): ReactNode[] {
  // A reference with no URL still gets its chip, exactly as All tasks paints it: a number-only
  // reference is what a `CEZ:PR` declaration looks like before any link is scraped, and the two
  // pages read their repository from DIFFERENT places (this one from health's remote, All tasks
  // from the project registry's `repoUrl`) — so "no URL here" never means "nothing to show".
  // `ReferenceChip` degrades such a chip to inert text on its own.
  const prReferences: { kind: 'PR' | 'Issue'; number?: number; url?: string }[] = references.filter(
    (reference) => reference.kind === 'PR',
  )
  // The one PR `taskReferences` cannot express: a forge URL whose last segment is not a number
  // (`taskPrUrl`'s own tolerance — an unrecognized forge still gets a working link, just without
  // a number cezar would be inventing). Gated on that URL not being listed already, NOT on there
  // being no PRs at all: a forge whose PR URLs do not end in a number (#847's GitLab adapter)
  // would otherwise have a `prNumber` chip standing in front of a link that never rendered.
  const prUrl = taskPrUrl(run)
  if (prUrl && isHttpUrl(prUrl) && !prReferences.some((reference) => reference.url === prUrl)) {
    prReferences.push({ kind: 'PR', url: prUrl })
  }
  const [first] = prReferences
  if (!first) return []
  return [
    <span key="pr" data-slot="run-pr-refs" className="flex flex-nowrap items-center gap-1">
      <ReferenceChip
        reference={first}
        taskTitle={runTitle(run)}
        className="h-5 shrink-0"
        // Shown only on a chip that IS conflicting — the chip decides that, being the thing that
        // knows — and mounted only while its panel is open. The same component the Tasks table
        // hands its chips, so both send the same prompt on the same seam.
        conflictAction={<ResolveConflictsButton run={run} prNumber={first.number} />}
      />
      {prReferences.length > 1 ? (
        <ReferenceOverflow references={prReferences} taskTitle={runTitle(run)} hidden={prReferences.length - 1} />
      ) : null}
    </span>,
  ]
}

/**
 * "Dispatched by <parent>" — one row linking a dispatched task back to the task that ordered it
 * (spec `.ai/specs/2026-09-10-dispatch.md`).
 *
 * Provenance, so it renders whether or not `capabilities.dispatch` is still on: a run created by
 * a dispatch keeps its `dispatch.parentRunId` forever, and hiding the line on a server that later
 * turned the flag off would leave a thread that cannot explain who ordered it. The parent's TITLE
 * comes from the run list this page already holds; a parent outside that list (another project,
 * or pruned) still gets its link, labelled by its id.
 */
function DispatchParentLine({ run }: { run: ApiRun }) {
  const runs = useRuns()
  const parentRunId = run.dispatch?.parentRunId
  if (parentRunId === undefined) return null
  const parent = (runs.data ?? []).find((candidate) => candidate.id === parentRunId)
  const attention = parent ? deriveAttention(parent) : null
  return (
    <div
      data-slot="dispatch-parent-line"
      className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-[13px] text-muted-foreground"
    >
      <span className="shrink-0 text-soft-foreground">Dispatched by</span>
      <Link
        to={`/tasks/${parentRunId}`}
        data-slot="dispatch-parent"
        data-run-id={parentRunId}
        className="inline-flex min-w-0 items-center gap-1.5 truncate hover:text-foreground"
      >
        {attention ? <StatusDot tone={attention.tone} pulse={attention.pulse} /> : null}
        <span className="truncate">{parent ? runTitle(parent) : parentRunId}</span>
      </Link>
    </div>
  )
}

/** Above this many dispatched children the Subtasks list starts COLLAPSED. Four chips is roughly
 *  the one row the line was drawn as; a gauntlet parent with a hundred of them wrapped into a wall
 *  that owned the viewport and pushed the transcript off screen — the very thing the original
 *  "deliberately one row" note meant to prevent — so past that row the reader opts in instead. */
const SUBTASKS_OPEN_BY_DEFAULT_MAX = 4

/** Which runs the reader has opened (or closed) the Subtasks list for. Module-level and run-keyed
 *  for exactly the reasons `detailsOpenByRun` above is: a Session → Changes hop remounts this
 *  header and plain `useState` would forget the choice, while run A → run B does NOT remount and
 *  `useState` would carry A's choice into B. Session-lifetime only; nothing persisted. */
const subtasksOpenByRun = new Map<string, boolean>()

/**
 * "Subtasks — <child> · <child> …" — the tasks this one dispatched, behind a disclosure.
 *
 * Derived from the run list this page already holds rather than fetched: a child's link is its
 * id and its dot is its status, both of which `useRuns()` carries and keeps live over the run
 * stream. Nothing renders for a run that dispatched nothing — which is every run on a server
 * that never turned dispatch on.
 *
 * Bounded three ways, because a dispatching parent's child count is unbounded:
 *  - past `SUBTASKS_OPEN_BY_DEFAULT_MAX` the list starts closed, and the summary row carries the
 *    count plus a per-status tally, so a collapsed list still answers "how is the fan-out going";
 *  - open, it scrolls at `max-h-28` (~5 wrapped rows) instead of growing without limit;
 *  - closed, the links leave the DOM rather than hiding visually — same reasoning as the phone
 *    meta disclosure above, no invisible-but-focusable links in the tab order.
 */
function DispatchChildrenLine({ run }: { run: ApiRun }) {
  const runs = useRuns()
  const [, bumpSubtasks] = useReducer((n: number) => n + 1, 0)
  const listId = useId()
  const children = (runs.data ?? []).filter(
    (candidate) => candidate.dispatch?.parentRunId === run.id,
  )
  if (children.length === 0) return null
  const open = subtasksOpenByRun.get(run.id) ?? children.length <= SUBTASKS_OPEN_BY_DEFAULT_MAX
  const toggle = () => {
    subtasksOpenByRun.set(run.id, !open)
    bumpSubtasks()
  }
  return (
    <div data-slot="dispatch-children" className="mt-1 min-w-0 text-[13px] text-muted-foreground">
      <button
        type="button"
        data-slot="dispatch-children-toggle"
        aria-controls={listId}
        aria-expanded={open}
        onClick={toggle}
        className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden hover:text-foreground"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn('size-3 shrink-0 transition-transform', !open && '-rotate-90')}
        />
        <span className="shrink-0">Subtasks</span>
        <span data-slot="dispatch-children-count" className="shrink-0 tabular-nums">
          {children.length}
        </span>
        <SubtaskTally subtasks={children} />
      </button>
      {open ? (
        <div
          id={listId}
          data-slot="dispatch-children-list"
          className="mt-0.5 flex max-h-28 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 overflow-y-auto overscroll-contain pl-[1.125rem]"
        >
          {children.map((child) => {
            const attention = deriveAttention(child)
            return (
              <Link
                key={child.id}
                to={`/tasks/${child.id}`}
                data-slot="dispatch-child"
                data-run-id={child.id}
                title={`${runTitle(child)} — ${attention.label}`}
                className="inline-flex max-w-52 items-center gap-1.5 truncate hover:text-foreground"
              >
                <StatusDot tone={attention.tone} pulse={attention.pulse} />
                <span className="truncate">{runTitle(child)}</span>
              </Link>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/**
 * "3 running · 1 needs you · 20 done" — the children's statuses, counted, in attention order.
 *
 * What makes the collapsed state honest: the point of the row is the fan-out's health, and a bare
 * "Subtasks 100" hides precisely the child that stopped to ask something. Ordered by the canonical
 * `ATTENTION_RANK` (and grouped by `deriveAttention`'s own label) so the rung that wants a human
 * is read first, never buried behind the done pile.
 */
function SubtaskTally({ subtasks }: { subtasks: ApiRun[] }) {
  const byLabel = new Map<string, { tone: AttentionTone; pulse: boolean; rank: number; count: number }>()
  for (const child of subtasks) {
    const attention = deriveAttention(child)
    const seen = byLabel.get(attention.label)
    if (seen) {
      seen.count += 1
      continue
    }
    byLabel.set(attention.label, {
      tone: attention.tone,
      pulse: attention.pulse,
      rank: ATTENTION_RANK[attention.bucket],
      count: 1,
    })
  }
  const tally = [...byLabel.entries()].sort(([, a], [, b]) => a.rank - b.rank || b.count - a.count)
  return (
    <span data-slot="dispatch-children-tally" className="flex min-w-0 items-center gap-2 overflow-hidden">
      {tally.map(([label, group]) => (
        <span key={label} className="inline-flex shrink-0 items-center gap-1">
          <StatusDot tone={group.tone} pulse={group.pulse} />
          <span className="tabular-nums">{group.count}</span>
          <span>{label}</span>
        </span>
      ))}
    </span>
  )
}

function MonitoringSchedule({ run }: { run: ApiRun }) {
  if (run.status !== 'running' || run.activity !== 'monitoring') return null
  if (run.monitoringWakeCapReached) {
    return (
      <p data-slot="monitoring-schedule" role="status" className="mt-1 text-xs text-muted-foreground">
        Automatic checks paused — 40/40 reached
      </p>
    )
  }
  const wakeAt = run.monitoringWakeAt ? new Date(run.monitoringWakeAt) : null
  const validWakeAt = wakeAt && Number.isFinite(wakeAt.getTime()) ? wakeAt : null
  if (!validWakeAt) {
    return (
      <p data-slot="monitoring-schedule" role="status" className="mt-1 text-xs text-muted-foreground">
        Parked — no automatic check scheduled
      </p>
    )
  }
  const label = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(validWakeAt)
  return (
    <p data-slot="monitoring-schedule" role="status" className="mt-1 text-xs text-muted-foreground">
      Next automatic check{' '}
      <time dateTime={run.monitoringWakeAt} className="font-medium text-foreground">
        {label}
      </time>
    </p>
  )
}

/** "Details" — everything about HOW this run executes that a reader rarely needs at a glance:
 *  runner, account, model and canonical model identity (#416, #546), tokens and cost, the
 *  worktree path and the take-over command. One quiet trigger in the meta line, a labelled
 *  definition grid behind it.
 *
 *  This is the production reader for `RunRecord.modelIdentity` (#546): it answers a question only
 *  a user debugging "which provider actually served this?" asks. */
function RunDetails({
  run,
  hint,
  showTokens,
  showCost,
  continuationEngine,
  inline = false,
}: {
  run: ApiRun
  hint?: string
  showTokens: boolean
  showCost: boolean
  continuationEngine?: ReactNode
  /** Draw the list in place instead of behind the popover (the Overview layout). */
  inline?: boolean
}) {
  // One resolution with the composer's engine pills (run-engine.tsx), so the two cannot disagree.
  const { runner, account, model, identity, summary } = useRunEngine(run)
  const hasTokens = showTokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)
  const list = (
    <>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-[13px]">
      <DetailRow label="Workflow">{workflowLabel(run)}</DetailRow>
      <DetailRow label="Runner">{runner}</DetailRow>
      {/* Omitted, not guessed, when no step recorded one: a run from before accounts existed
          cannot be said to have used the discovered account — nothing wrote that down. */}
      {account ? (
        <DetailRow label="Account" slot="agent-badge-account">
          {account}
        </DetailRow>
      ) : null}
      <DetailRow label="Model">{model}</DetailRow>
      {identity ? (
        <DetailRow label="Identity" slot="agent-badge-identity" mono>
          {identity}
        </DetailRow>
      ) : null}
      {hasTokens ? (
        <DetailRow label="Tokens">
          <DirectionalUsage inputTokens={run.inputTokens} outputTokens={run.outputTokens} />
        </DetailRow>
      ) : null}
      {showCost && run.costUsd ? (
        <DetailRow label="Cost">
          <span className="tabular-nums">{formatCost(run.costUsd)}</span>
        </DetailRow>
      ) : null}
      {run.branch ? (
        <DetailRow label="Branch" mono>
          {run.branch}
        </DetailRow>
      ) : null}
      {run.worktreePath ? (
        <DetailRow label="Worktree" mono>
          <CopyValue
            value={run.worktreePath}
            label="Copy worktree path"
            done="Worktree path copied"
          />
        </DetailRow>
      ) : null}
      {hint ? (
        <DetailRow label="Take over" mono>
          <CopyValue
            slot="resume-hint"
            value={hint}
            label="Copy the take-over command"
            done="Command copied to clipboard."
          />
        </DetailRow>
      ) : null}
    </dl>
    {continuationEngine ? (
      <div className="mt-3 border-t border-border pt-3">
        <p className="mb-1.5 text-xs text-muted-foreground">Next continuation</p>
        <div data-slot="agent-badge-engine-picker">{continuationEngine}</div>
      </div>
    ) : null}
    </>
  )
  if (inline) return <div data-slot="run-details">{list}</div>
  return (
    <Popover>
      <PopoverTrigger
        data-slot="agent-badge"
        title={summary}
        aria-label={`Details — agent: ${runner}, ${account ? `account ${account}, ` : ''}model ${model}`}
        className="group inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[state=open]:bg-muted data-[state=open]:text-foreground"
      >
        <BotIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span data-slot="agent-badge-summary" className="hidden lg:inline">
          {runner}
        </span>
        <span className="lg:hidden">Details</span>
        <ChevronDownIcon aria-hidden="true" className="size-3.5 text-soft-foreground transition-transform group-data-[state=open]:rotate-180" />
      </PopoverTrigger>
      <PopoverContent align="start" data-slot="run-details" className="w-[min(24rem,calc(100vw-2rem))] p-4">
        <p className="mb-3 text-[13px] font-semibold text-foreground">Run details</p>
        {list}
      </PopoverContent>
    </Popover>
  )
}

function DetailRow({
  label,
  slot,
  mono = false,
  children,
}: {
  label: string
  slot?: string
  mono?: boolean
  children: ReactNode
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-slot={slot} className={mono ? 'min-w-0 font-mono text-xs break-all text-foreground' : 'min-w-0 text-foreground'}>
        {children}
      </dd>
    </>
  )
}

/** A long mono value with a copy button beside it — the worktree path, the take-over command. */
function CopyValue({ value, label, done, slot }: { value: string; label: string; done: string; slot?: string }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <span className="line-clamp-3 min-w-0 flex-1 break-all">{value}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        data-slot={slot}
        aria-label={label}
        title={label}
        className="-my-0.5 shrink-0 text-muted-foreground"
        onClick={() => void copyToClipboard(value, done)}
      >
        <CopyIcon aria-hidden="true" />
      </Button>
    </span>
  )
}

/** "More": every action that is not the run's one primary button — and those too, since the
 *  button row hides under `md` and whenever the strip runs out of room. Destructive items last. */
function MoreMenu({
  run,
  actions,
  git,
  hint,
  onOpenNotes,
}: {
  run: ApiRun
  actions: RunActions
  git: RunGitStep
  hint?: string
  onOpenNotes: () => void
}) {
  const flags = runActionFlags(run)
  const worktreePath = run.worktreePath
  const step = git.action
  const unread = flags.markRead
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions">
          <EllipsisIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-slot="run-actions-menu" className="min-w-52">
        {step ? (
          // The git step leads, with its alternatives (Create PR → Create draft PR) — the same
          // step the bar's git button paints, for the widths that drop the bar.
          <>
            {[step, ...(step.alternatives ?? [])].map((choice) => (
              <DropdownMenuItem
                key={choice.id}
                data-action={choice.id}
                disabled={!choice.enabled}
                title={choice.reason}
                onSelect={() => git.onAction(choice.id)}
              >
                {GIT_ACTION_ICONS[choice.id]}
                {choice.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {flags.finish ? (
          // Always here, not only on a phone: the strip drops its action buttons whenever it runs
          // out of room, at any window size, and this menu is where they are found then.
          <DropdownMenuItem onSelect={() => actions.finish.mutate()}>
            <CheckIcon aria-hidden="true" /> Finish
          </DropdownMenuItem>
        ) : null}
        {flags.terminal ? (
          <DropdownMenuItem onSelect={() => actions.terminal.mutate()}>
            <SquareTerminalIcon aria-hidden="true" /> Resume in terminal
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem title="Handoff notes — what the agent did and what's left" onSelect={onOpenNotes}>
          <FileTextIcon aria-hidden="true" /> Notes
        </DropdownMenuItem>
        {/* The state toggles — read, pinned, archived: one icon each, ON in the shared violet-filled
            pattern (`TOGGLE_ON_ICON_CLASS`) with `aria-pressed`, so the icon says WHAT and its
            colour says WHETHER. Read/unread flips rather than vanishing once the task is unread. */}
        {flags.markRead || flags.markUnread ? (
          <DropdownMenuItem
            data-slot="unread-toggle"
            aria-pressed={unread}
            title={unread ? 'Unread — mark it read' : 'Put this task back in the unread list'}
            disabled={actions.markRead.isPending || actions.markUnread.isPending}
            onSelect={() => (unread ? actions.markRead.mutate() : actions.markUnread.mutate())}
          >
            <MailIcon aria-hidden="true" className={cn(unread && TOGGLE_ON_ICON_CLASS)} />
            {unread ? 'Mark read' : 'Mark unread'}
          </DropdownMenuItem>
        ) : null}
        {flags.pin ? (
          <DropdownMenuItem
            data-slot="pin-run"
            aria-pressed={Boolean(run.pinned)}
            title={
              run.pinned
                ? 'Unpin from the top of this project’s task list'
                : 'Pin to the top of this project’s task list'
            }
            disabled={actions.pin.isPending}
            onSelect={() => actions.pin.mutate()}
          >
            <PinIcon aria-hidden="true" className={cn(run.pinned && TOGGLE_ON_ICON_CLASS)} />
            {run.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
        ) : null}
        {flags.archive ? (
          <DropdownMenuItem
            data-slot="archive-run"
            aria-pressed={Boolean(run.archived)}
            onSelect={() => actions.archive.mutate()}
          >
            <ArchiveIcon aria-hidden="true" className={cn(run.archived && TOGGLE_ON_ICON_CLASS)} />
            {run.archived ? 'Unarchive' : 'Archive'}
          </DropdownMenuItem>
        ) : null}
        {hint || worktreePath ? <DropdownMenuSeparator /> : null}
        {hint ? (
          <DropdownMenuItem
            title={hint}
            onSelect={() => void copyToClipboard(hint, 'Command copied to clipboard.')}
          >
            <SquareTerminalIcon aria-hidden="true" /> Copy take-over command
          </DropdownMenuItem>
        ) : null}
        {worktreePath ? (
          <DropdownMenuItem
            title={worktreePath}
            onSelect={() => void copyToClipboard(worktreePath, 'Worktree path copied')}
          >
            <CopyIcon aria-hidden="true" /> Copy worktree path
          </DropdownMenuItem>
        ) : null}
        {flags.cancel || flags.deleteRun ? <DropdownMenuSeparator /> : null}
        {flags.cancel ? (
          // Unconditional, like Finish and Continue above: the bar hides on the strip's container
          // width, so a window-breakpoint hide here left Stop in neither place.
          <DropdownMenuItem variant="destructive" onSelect={() => actions.setConfirming('cancel')}>
            <CircleStopIcon aria-hidden="true" /> Stop
          </DropdownMenuItem>
        ) : null}
        {flags.deleteRun ? (
          <DropdownMenuItem variant="destructive" onSelect={() => actions.setConfirming('delete')}>
            <Trash2Icon aria-hidden="true" /> Delete
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The handoff journal (spec 007) as rendered markdown, in a side sheet — fetched only while open. */
function NotesSheet({
  runId,
  open,
  onOpenChange,
}: {
  runId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Notes</SheetTitle>
          <SheetDescription>Handoff notes — what the agent did and what is left.</SheetDescription>
        </SheetHeader>
        {open ? <NotesBody runId={runId} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function NotesBody({ runId }: { runId: string }) {
  const handoff = useRunHandoff(runId)
  return (
    <div data-slot="notes-panel" className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
      {handoff.isPending ? (
        <p className="text-[13px] text-muted-foreground">Loading notes…</p>
      ) : handoff.isError ? (
        <p className="text-[13px] text-danger">{handoff.error.message}</p>
      ) : handoff.data.trim().length > 0 ? (
        <Markdown>{handoff.data}</Markdown>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          No notes yet — the handoff file is seeded when the task starts.
        </p>
      )}
    </div>
  )
}
