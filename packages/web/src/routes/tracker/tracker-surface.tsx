import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { CheckCircle2Icon, ChevronDownIcon, CircleDashedIcon, CircleDotIcon, CircleHelpIcon, CircleIcon, XCircleIcon } from 'lucide-react'
import type { DragEvent } from 'react'

import type { TrackerAssociation, TrackerItem, TrackerItemResponse, TrackerStatusCategory } from '@open-mercato/cezar-api-client'
import { getTrackerItem } from '@/api/client'
import { queryKeys, TRACKER_STALE_TIME } from '@/api/queries'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import type { TrackerGroup } from '@/lib/tracker-groups'
import { trackerLosses, trackerTaskPrompt } from '@/lib/tracker-task'
import { cn } from '@/lib/utils'

export type TrackerSurfaceProps = {
  groups: TrackerGroup[]
  association: TrackerAssociation
  scopePending: boolean
  activeId: string | null
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

/** What a row and a card share: preload the detail on intent, and drag it into the task composer. */
function useTrackerItemLink(association: TrackerAssociation, item: TrackerItem, scopePending: boolean) {
  const queryClient = useQueryClient()
  const key = queryKeys.tracker.detail(association, item.id)
  const preload = () => void queryClient.prefetchQuery({ queryKey: key, queryFn: ({ signal }) => getTrackerItem(item.id, { signal, association }), staleTime: TRACKER_STALE_TIME })
  const drag = (event: DragEvent) => {
    if (scopePending) { event.preventDefault(); return }
    const state = queryClient.getQueryState<TrackerItemResponse>(key)
    const detail = trackerDetailReadyForDrag(queryClient, key)
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
    if (trackerLosses(detail.item).length) {
      event.preventDefault()
      toast('Open this issue to acknowledge snapshot limitations before handoff.', { tone: 'danger' })
      return
    }
    event.dataTransfer.setData('text/plain', trackerTaskPrompt(detail.item))
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
export function TrackerList({ groups, association, scopePending, activeId, collapsed, onToggle, compact }: TrackerSurfaceProps & {
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
        {open ? <ul>{group.items.map(item => <li key={item.id}><TrackerRow item={item} association={association} scopePending={scopePending} active={activeId === item.id} compact={compact} /></li>)}</ul> : null}
      </section>
    })}
  </div>
}

function TrackerRow({ item, association, scopePending, active, compact }: { item: TrackerItem; association: TrackerAssociation; scopePending: boolean; active: boolean; compact: boolean }) {
  const link = useTrackerItemLink(association, item, scopePending)
  return <Link {...link} data-slot="tracker-row" aria-current={active ? 'page' : undefined} className={cn(
    'flex min-h-10 items-center gap-3 border-b border-border/60 px-4 py-2 text-[13px] font-normal outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
    active && 'bg-muted',
  )}>
    <span className="w-24 shrink-0 truncate text-xs text-muted-foreground tabular-nums">{item.id}</span>
    <span className="min-w-0 flex-1 truncate">{item.title}</span>
    {compact ? null : <>
      <Labels labels={item.labels} className="hidden shrink-0 lg:flex" />
      <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground md:block">{item.author}</span>
    </>}
    <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums" title={new Date(item.updatedAt).toLocaleString()}>{shortAge(item.updatedAt)}</span>
  </Link>
}

/** One column per loaded status. Read-only: a card drags into the task composer, not between columns. */
export function TrackerBoard({ groups, association, scopePending, activeId }: TrackerSurfaceProps) {
  return <div data-slot="tracker-board" className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto p-3">
    {groups.map(group => <section key={group.statusId} data-slot="tracker-column" aria-label={group.status} className="flex max-h-full w-72 shrink-0 flex-col rounded-lg bg-muted/40">
      <h2 className="flex items-center gap-2 px-3 py-2 text-[13px] font-medium">
        <TrackerStatusIcon category={group.category} />
        <span className="min-w-0 truncate">{group.status}</span>
        <span className="font-normal text-muted-foreground tabular-nums" title="Issues loaded in this status">{group.items.length}</span>
      </h2>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {group.items.map(item => <li key={item.id}><TrackerCard item={item} association={association} scopePending={scopePending} active={activeId === item.id} /></li>)}
      </ul>
    </section>)}
  </div>
}

function TrackerCard({ item, association, scopePending, active }: { item: TrackerItem; association: TrackerAssociation; scopePending: boolean; active: boolean }) {
  const link = useTrackerItemLink(association, item, scopePending)
  return <Link {...link} data-slot="tracker-row" aria-current={active ? 'page' : undefined} className={cn(
    'flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5 text-[13px] font-normal shadow-xs outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/50',
    active && 'border-foreground/30',
  )}>
    <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
      <span className="truncate">{item.id}</span>
      <span className="shrink-0" title={new Date(item.updatedAt).toLocaleString()}>{shortAge(item.updatedAt)}</span>
    </span>
    <span className="line-clamp-3 leading-snug text-pretty">{item.title}</span>
    <Labels labels={item.labels} className="flex-wrap" />
  </Link>
}
