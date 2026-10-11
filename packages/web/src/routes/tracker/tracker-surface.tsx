import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { CheckCircle2Icon, ChevronDownIcon, CircleDashedIcon, CircleDotIcon, CircleHelpIcon, CircleIcon, MinusIcon, SignalHighIcon, SignalIcon, SignalLowIcon, SignalMediumIcon, XCircleIcon, ZapIcon } from 'lucide-react'
import { useState, type DragEvent } from 'react'

import type { ApiRun, TrackerAssociation, TrackerItem, TrackerItemResponse, TrackerStatusCategory } from '@open-mercato/cezar-api-client'
import { getTrackerItem } from '@/api/client'
import { queryKeys, TRACKER_STALE_TIME } from '@/api/queries'
import { StatusDot } from '@/components/status-dot'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/toaster'
import { statusTone } from '@/lib/automation-format'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import type { TrackerGroup } from '@/lib/tracker-groups'
import { automationHint } from '@/lib/tracker-automations'
import { ALL_TRACKER_FIELDS, type TrackerDisplay } from './tracker-display'
import { TrackerMoveMenu, useTrackerTransitions, type TrackerMove } from './tracker-move'
import { initials, priorityLevel, ticketExcerpt, type PriorityLevel } from '@/lib/tracker-card'
import { ticketActivity } from '@/lib/tracker-links'
import { trackerLosses, trackerTaskPrompt } from '@/lib/tracker-task'
import { cn } from '@/lib/utils'

export type TrackerSurfaceProps = {
  groups: TrackerGroup[]
  association: TrackerAssociation
  scopePending: boolean
  activeId: string | null
  /** The project's tasks by linked ticket id (`runsByTicket`). */
  runs: ReadonlyMap<string, ApiRun[]>
  /** Which optional properties rows and cards show (the Display menu). Everything when omitted. */
  shown?: TrackerDisplay
}

const STATUS_ICONS: Record<TrackerStatusCategory, { icon: typeof CircleIcon; className: string }> = {
  backlog: { icon: CircleDashedIcon, className: 'text-muted-foreground' },
  unstarted: { icon: CircleIcon, className: 'text-muted-foreground' },
  started: { icon: CircleDotIcon, className: 'text-pending-strong' },
  done: { icon: CheckCircle2Icon, className: 'text-success' },
  canceled: { icon: XCircleIcon, className: 'text-muted-foreground' },
  other: { icon: CircleHelpIcon, className: 'text-muted-foreground' },
}

export function TrackerStatusIcon({ category, className }: { category: TrackerStatusCategory; className?: string }) {
  const { icon: Icon, className: tone } = STATUS_ICONS[category]
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0', tone, className)} />
}

export function LabelChip({ label }: { label: string }) {
  return <Badge variant="outline" className="max-w-40 px-1.5 py-0 font-normal text-muted-foreground"><span className="truncate">{label}</span></Badge>
}

export function trackerDetailReadyForDrag(
  queryClient: QueryClient,
  key: QueryKey,
  now = Date.now(),
): TrackerItemResponse & { available: true } | null {
  const state = queryClient.getQueryState<TrackerItemResponse>(key)
  if (
    state?.status !== 'success'
    || state.fetchStatus !== 'idle'
    || state.isInvalidated
    || state.dataUpdatedAt <= 0
    || now - state.dataUpdatedAt >= TRACKER_STALE_TIME
    || !state.data?.available
  ) return null
  return state.data
}

/** Marks a drag that started on a board card, so a column knows it may be a status change. */
export const TRACKER_MOVE_TYPE = 'application/x-cezar-tracker-item'

/** What a row and a card share: preload the detail on intent, and drag it into the task composer. */
function useTrackerItemLink(association: TrackerAssociation, item: TrackerItem, scopePending: boolean, onBoard = false) {
  const queryClient = useQueryClient()
  const key = queryKeys.tracker.detail(association, item.id)
  const preload = () => void queryClient.prefetchQuery({ queryKey: key, queryFn: ({ signal }) => getTrackerItem(item.id, { signal, association }), staleTime: TRACKER_STALE_TIME })
  const drag = (event: DragEvent) => {
    if (scopePending) { event.preventDefault(); return }
    const state = queryClient.getQueryState<TrackerItemResponse>(key)
    const detail = trackerDetailReadyForDrag(queryClient, key)
    if (onBoard) {
      // A card may be dropped on another column (a status change) or on the task composer. The
      // first needs only the ticket id; the second gets the prompt when the detail is in hand and
      // lossless, and nothing otherwise — the composer then simply has no text to take.
      event.dataTransfer.setData(TRACKER_MOVE_TYPE, item.id)
      if (detail && !trackerLosses(detail.item, detail.comments).length) event.dataTransfer.setData('text/plain', trackerTaskPrompt(detail.item, detail.comments))
      else preload()
      event.dataTransfer.effectAllowed = 'copyMove'
      return
    }
    if (!detail) {
      event.preventDefault()
      preload()
      toast(
        state?.status === 'error'
          ? 'Full issue detail failed to load. Open the issue to retry.'
          : 'Loading fresh issue detail. Drag again when it is ready.',
        state?.status === 'error' ? { tone: 'danger' } : undefined,
      )
      return
    }
    if (trackerLosses(detail.item, detail.comments).length) {
      event.preventDefault()
      toast('Open this issue to acknowledge snapshot limitations before handoff.', { tone: 'danger' })
      return
    }
    event.dataTransfer.setData('text/plain', trackerTaskPrompt(detail.item, detail.comments))
    event.dataTransfer.effectAllowed = 'copy'
  }
  return {
    to: `/tracker/${encodeURIComponent(item.id)}`,
    draggable: true,
    onMouseEnter: preload,
    onFocus: preload,
    onDragStart: drag,
    title: 'Drag into the composer to prefill a task',
  }
}

/** The dot that says an agent is, or was, on this ticket. Nothing for a ticket with no task. */
export function TicketActivity({ runs, className }: { runs: readonly ApiRun[] | undefined; className?: string }) {
  const activity = ticketActivity(runs)
  if (!activity) return null
  return <span data-slot="tracker-activity" data-status={activity.status} role="img" aria-label={activity.label} title={activity.label} className={cn('inline-flex shrink-0 items-center', className)}>
    <StatusDot tone={statusTone(activity.status)} />
  </span>
}

/** How many label chips a row or card shows before folding the rest into "+n". */
const SHOWN_LABELS = 2

function Labels({ labels, className }: { labels: string[]; className?: string }) {
  if (labels.length === 0) return null
  const hidden = labels.length - SHOWN_LABELS
  return <span className={cn('flex min-w-0 items-center gap-1', className)}>
    {labels.slice(0, SHOWN_LABELS).map(label => <LabelChip key={label} label={label} />)}
    {hidden > 0 ? <span title={labels.slice(SHOWN_LABELS).join(', ')} className="text-xs text-muted-foreground tabular-nums">+{hidden}</span> : null}
  </span>
}

/** Full-width rows under one collapsible heading per loaded status. */
export function TrackerList({ groups, association, scopePending, activeId, runs, shown = ALL_TRACKER_FIELDS, collapsed, onToggle, compact }: TrackerSurfaceProps & {
  collapsed: ReadonlySet<string>
  onToggle: (statusId: string) => void
  /** The detail panel is open beside the list: keep the key and title, drop the rest. */
  compact: boolean
}) {
  return <div data-slot="tracker-rows">
    {groups.map(group => {
      const open = !collapsed.has(group.statusId)
      return <section key={group.statusId} data-slot="tracker-group" aria-label={group.status}>
        <h2 className="sticky top-0 z-10 border-b border-border bg-muted/70 backdrop-blur">
          <button type="button" aria-expanded={open} onClick={() => onToggle(group.statusId)} className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronDownIcon aria-hidden="true" className={cn('size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none', !open && '-rotate-90')} />
            <TrackerStatusIcon category={group.category} />
            <span>{group.status}</span>
            <span className="font-normal text-muted-foreground tabular-nums" title="Issues loaded in this status">{group.items.length}</span>
          </button>
        </h2>
        {open ? <ul>{group.items.map(item => <li key={item.id}><TrackerRow item={item} shown={shown} runs={runs.get(item.id)} association={association} scopePending={scopePending} active={activeId === item.id} compact={compact} /></li>)}</ul> : null}
      </section>
    })}
  </div>
}

function TrackerRow({ item, shown, runs, association, scopePending, active, compact }: { item: TrackerItem; shown: TrackerDisplay; runs: readonly ApiRun[] | undefined; association: TrackerAssociation; scopePending: boolean; active: boolean; compact: boolean }) {
  const link = useTrackerItemLink(association, item, scopePending)
  return <Link {...link} data-slot="tracker-row" aria-current={active ? 'page' : undefined} className={cn(
    'flex min-h-10 items-center gap-3 border-b border-border/60 px-4 py-2 text-[13px] font-normal outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
    active && 'bg-muted',
  )}>
    <span className="w-24 shrink-0 truncate text-xs text-muted-foreground tabular-nums">{item.id}</span>
    <span className="flex min-w-0 flex-1 items-center gap-2"><span className="truncate">{item.title}</span><TicketActivity runs={runs} /></span>
    {compact ? null : <>
      {shown.has('labels') ? <Labels labels={item.labels} className="hidden shrink-0 lg:flex" /> : null}
      {shown.has('priority') ? (item.priority
        ? <span className="hidden w-24 shrink-0 lg:block"><PriorityBadge priority={item.priority} /></span>
        : <span aria-hidden="true" className="hidden w-24 shrink-0 lg:block" />) : null}
      {shown.has('assignee') ? <span data-slot="tracker-assignee" className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground md:block" title={item.assignee ? `Assigned to ${item.assignee}` : 'Unassigned'}>{item.assignee ?? '—'}</span> : null}
      {shown.has('author') ? <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground xl:block" title={`Opened by ${item.author}`}>{item.author}</span> : null}
    </>}
    {shown.has('updated') ? <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums" title={new Date(item.updatedAt).toLocaleString()}>{shortAge(item.updatedAt)}</span> : null}
  </Link>
}

/** A column's tint and its heading pill. Colour says where the status sits in the workflow. */
type ColumnTone = 'neutral' | 'pending' | 'violet' | 'success'
const COLUMN_TONES: Record<ColumnTone, { column: string; pill: string }> = {
  neutral: { column: 'bg-muted/40', pill: 'text-foreground' },
  pending: { column: 'bg-pending/[0.07]', pill: 'bg-pending/20 text-pending-strong' },
  violet: { column: 'bg-violet/[0.08]', pill: 'bg-violet/20 text-violet' },
  success: { column: 'bg-success/[0.07]', pill: 'bg-success/20 text-success' },
}
/**
 * Not started is neutral, done is green. Work in progress is amber for the first such status and
 * violet for the ones after it, so "In Progress" and "In Review" read as two stages — the same
 * amber-then-violet a running and a to-review task use elsewhere in the cockpit.
 */
function columnTones(groups: readonly TrackerGroup[]): Map<string, ColumnTone> {
  const tones = new Map<string, ColumnTone>()
  let started = 0
  for (const group of groups) {
    tones.set(group.statusId, group.category === 'done' ? 'success' : group.category === 'started' ? (started++ === 0 ? 'pending' : 'violet') : 'neutral')
  }
  return tones
}

/**
 * One column per loaded status. A card dragged to another column changes the ticket's status at
 * the vendor (`move`); dragged into the task composer it still prefills a task. Only columns for
 * statuses with loaded tickets exist, so a target with no column is reached from the issue
 * panel's "Move to" menu instead.
 */
export function TrackerBoard({ groups, association, scopePending, activeId, runs, shown = ALL_TRACKER_FIELDS, move, moving, automations }: TrackerSurfaceProps & {
  move: TrackerMove
  /** Ticket ids whose move is in flight: their menu waits. */
  moving: ReadonlyMap<string, unknown>
  /** Enabled automations by the target status that fires them. */
  automations: ReadonlyMap<string, string[]>
}) {
  const [dragging, setDragging] = useState<TrackerItem | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const transitions = useTrackerTransitions(association, dragging, dragging !== null)
  const allowed = transitions.data?.available ? transitions.data : null
  // Why a column refuses the card in hand, or null when it may take it. While the answer is on
  // its way a column accepts the drop: the server decides, and a refusal returns the card.
  const refusal = (statusId: string): string | null => {
    if (!dragging || dragging.statusId === statusId) return null
    if (transitions.data && !transitions.data.available) return transitions.data.reason
    if (!allowed) return null
    if (!allowed.writable) return allowed.reason ?? 'This connection cannot change a status.'
    const target = allowed.targets.find(candidate => candidate.statusId === statusId)
    if (!target) return 'This issue cannot be moved here from its current status.'
    return target.available ? null : target.reason ?? 'This move cannot be made from cezar.'
  }
  const end = () => { setDragging(null); setOver(null) }
  // A status the card in hand may reach but that holds no loaded ticket has no column of its own.
  // While dragging it gets one, appended so nothing under the pointer shifts.
  const ghosts: TrackerGroup[] = dragging && allowed?.writable
    ? allowed.targets.filter(target => !groups.some(group => group.statusId === target.statusId)).map(target => ({ statusId: target.statusId, status: target.status, category: target.statusCategory, items: [] }))
    : []
  const columns = [...groups, ...ghosts]
  const tones = columnTones(columns)
  return <div data-slot="tracker-board" className="flex min-h-0 flex-1 items-stretch gap-4 overflow-x-auto p-4" onDragEnd={end}>
    {columns.map(group => {
      const tone = COLUMN_TONES[tones.get(group.statusId) ?? 'neutral']
      const reason = refusal(group.statusId)
      const target = dragging !== null && dragging.statusId !== group.statusId
      const starts = target && !reason ? automationHint(automations, group.statusId) : null
      return <section key={group.statusId} data-slot="tracker-column" data-tone={tones.get(group.statusId)} data-ghost={group.items.length === 0 ? '' : undefined} data-drop={!target ? undefined : reason ? 'refused' : 'allowed'} aria-label={group.status} title={target && reason ? reason : undefined}
        onDragOver={(event) => {
          if (!target || reason || !event.dataTransfer.types.includes(TRACKER_MOVE_TYPE)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          if (over !== group.statusId) setOver(group.statusId)
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(current => current === group.statusId ? null : current) }}
        onDrop={(event) => {
          if (!target || !dragging) return
          event.preventDefault()
          const item = dragging
          end()
          if (reason) { toast(reason, { tone: 'danger' }); return }
          move(item, { statusId: group.statusId, status: group.status, statusCategory: group.category })
        }}
        className={cn(
          'flex min-h-0 max-w-[26rem] min-w-72 flex-1 basis-0 flex-col rounded-xl transition-[opacity,box-shadow] motion-reduce:transition-none',
          tone.column,
          target && reason && 'opacity-40',
          target && !reason && 'ring-1 ring-border',
          over === group.statusId && target && !reason && 'ring-2 ring-ring/60',
        )}>
      <h2 className="flex items-center gap-2 px-3 pt-3 pb-2 text-[13px] font-medium">
        <span className={cn('inline-flex min-w-0 items-center gap-1.5 rounded-md py-0.5', tone.pill, tone.pill.includes('bg-') && 'px-2')}>
          <TrackerStatusIcon category={group.category} className={cn('size-3.5', tone.pill.includes('bg-') && 'text-current')} />
          <span className="truncate">{group.status}</span>
        </span>
        <span className="font-normal text-muted-foreground tabular-nums" title="Issues loaded in this status">{group.items.length}</span>
      </h2>
      {starts ? <p data-slot="tracker-column-automation" className="flex items-start gap-1.5 px-3 pb-2 text-xs text-muted-foreground"><ZapIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />{starts}</p> : null}
      {group.items.length === 0 ? <p className="px-3 pb-3 text-xs text-muted-foreground">{reason ?? 'No loaded issues. Drop here to move.'}</p> : null}
      <ul className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-2.5">
        {group.items.map(item => <li key={item.id}><TrackerCard item={item} shown={shown} runs={runs.get(item.id)} association={association} scopePending={scopePending} active={activeId === item.id} onPickUp={setDragging} move={move} moving={moving.has(item.id)} automations={automations} /></li>)}
      </ul>
    </section>
    })}
  </div>
}

const PRIORITY_STYLE: Record<PriorityLevel, { icon: typeof SignalIcon; className: string }> = {
  urgent: { icon: SignalIcon, className: 'bg-danger/15 text-danger' },
  high: { icon: SignalHighIcon, className: 'bg-pending/20 text-pending-strong' },
  medium: { icon: SignalMediumIcon, className: 'bg-pending/10 text-pending-strong' },
  low: { icon: SignalLowIcon, className: 'bg-muted text-muted-foreground' },
  other: { icon: MinusIcon, className: 'bg-muted text-muted-foreground' },
}

/** The vendor's own priority name, toned by how urgent a known name is. */
export function PriorityBadge({ priority }: { priority: string }) {
  const { icon: Icon, className } = PRIORITY_STYLE[priorityLevel(priority)]
  return <span data-slot="tracker-priority" title={`Priority: ${priority}`} className={cn('inline-flex max-w-28 shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium', className)}>
    <Icon aria-hidden="true" className="size-3 shrink-0" />
    <span className="truncate">{priority}</span>
  </span>
}

function TrackerCard({ item, shown, runs, association, scopePending, active, onPickUp, move, moving, automations }: { item: TrackerItem; shown: TrackerDisplay; onPickUp: (item: TrackerItem) => void; move: TrackerMove; moving: boolean; automations: ReadonlyMap<string, string[]>; runs: readonly ApiRun[] | undefined; association: TrackerAssociation; scopePending: boolean; active: boolean }) {
  const link = useTrackerItemLink(association, item, scopePending, true)
  const pickUp = (event: DragEvent) => { link.onDragStart(event); if (!event.defaultPrevented) onPickUp(item) }
  const excerpt = shown.has('description') ? ticketExcerpt(item.body) : ''
  const assignee = shown.has('assignee') ? item.assignee : undefined
  const priority = shown.has('priority') ? item.priority : undefined
  const labels = shown.has('labels') ? item.labels : []
  // The menu sits beside the link, not inside it: a button nested in an anchor is not valid, and
  // it is how a status is changed without dragging. It shows on hover and whenever it has focus.
  return <div data-slot="tracker-card" className="group/card relative">
    <Link {...link} onDragStart={pickUp} title="Drag to another column to change its status, or into the composer to prefill a task" data-slot="tracker-row" aria-current={active ? 'page' : undefined} className={cn(
      'flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-[13px] font-normal shadow-xs outline-none transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none',
      active && 'border-foreground/40 ring-1 ring-foreground/15',
    )}>
      <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{item.id}</span><TicketActivity runs={runs} /></span>
        {shown.has('updated') ? <span className="shrink-0 transition-opacity group-focus-within/card:opacity-0 group-hover/card:opacity-0 motion-reduce:transition-none" title={new Date(item.updatedAt).toLocaleString()}>{shortAge(item.updatedAt)}</span> : null}
      </span>
      <span className="line-clamp-2 text-sm leading-snug font-medium text-pretty text-foreground">{item.title}</span>
      {excerpt ? <span data-slot="tracker-excerpt" className="truncate text-xs text-muted-foreground">{excerpt}</span> : null}
      {assignee || priority || labels.length ? <span className="mt-1 flex min-w-0 items-center gap-2">
        {assignee ? <Avatar data-slot="tracker-assignee" title={`Assigned to ${assignee}`} className="size-5 shrink-0"><AvatarFallback className="text-[10px] font-medium">{initials(assignee)}</AvatarFallback></Avatar> : null}
        {priority ? <PriorityBadge priority={priority} /> : null}
        <Labels labels={labels} className="ml-auto justify-end" />
      </span> : null}
    </Link>
    <div className="absolute top-2 right-2 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-[[data-state=open]]:opacity-100 motion-reduce:transition-none">
      <TrackerMoveMenu compact association={association} item={item} move={move} disabled={scopePending || moving} automations={automations} />
    </div>
  </div>
}
