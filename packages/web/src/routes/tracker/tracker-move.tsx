import { useQuery, useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query'
import { ChevronDownIcon } from 'lucide-react'
import { useCallback, useState } from 'react'

import type { TrackerAssociation, TrackerItem, TrackerItemsResponse, TrackerTransitionTarget } from '@open-mercato/cezar-api-client'
import { ApiError, getTrackerTransitions, moveTrackerItem } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { TrackerStatusIcon } from './tracker-surface'

/** The status a ticket is being moved to; the three fields a row shows while the vendor answers. */
export type TrackerMoveTarget = Pick<TrackerTransitionTarget, 'statusId' | 'status' | 'statusCategory'>
export type TrackerMove = (item: TrackerItem, target: TrackerMoveTarget) => void

/** Where a ticket may go. Asked only on intent (a card picked up, a menu opened), never per row. */
export function useTrackerTransitions(association: TrackerAssociation, item: TrackerItem | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.tracker.transitions(association, item?.id ?? ''),
    queryFn: ({ signal }) => getTrackerTransitions(item!.id, association, { signal }),
    enabled: enabled && item !== null,
    staleTime: 30_000,
  })
}

/**
 * The tracker's one vendor write, as the cockpit sees it (spec 2026-10-11-tracker-ticket-context
 * § Phase 6): a person moves one ticket to another status. The row moves at once and returns to
 * its column if the vendor refuses; the request names the status the user saw, so a ticket
 * someone else moved first is reported instead of overwritten. Nothing here retries.
 */
export function useTrackerMove(association: TrackerAssociation, listKey: QueryKey): { pending: ReadonlyMap<string, TrackerMoveTarget>; move: TrackerMove } {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<ReadonlyMap<string, TrackerMoveTarget>>(() => new Map())
  const settle = (id: string) => setPending(previous => { const next = new Map(previous); next.delete(id); return next })
  const move = useCallback<TrackerMove>((item, target) => {
    if (item.statusId === target.statusId) return
    let started = false
    setPending(previous => {
      if (previous.has(item.id)) return previous
      started = true
      return new Map(previous).set(item.id, target)
    })
    // One move per ticket at a time: a second gesture while the first is in flight is ignored.
    queueMicrotask(() => { if (started) void run() })
    const refetch = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tracker.detail(association, item.id) })
      void queryClient.invalidateQueries({ queryKey: listKey })
    }
    async function run() {
      try {
        const result = await moveTrackerItem(item.id, association, target.statusId, item.statusId)
        if (!result.available) {
          toast(result.reason, { tone: 'danger' })
          // A refused write may have marked the connection read-only: let the next menu say so.
          void queryClient.invalidateQueries({ queryKey: queryKeys.tracker.transitions(association, item.id) })
          return
        }
        const { status, statusId, statusCategory, updatedAt } = result.item
        queryClient.setQueryData(queryKeys.tracker.detail(association, item.id), result)
        queryClient.setQueryData<InfiniteData<TrackerItemsResponse>>(listKey, data => data && {
          ...data,
          pages: data.pages.map(page => page.available
            ? { ...page, items: page.items.map(row => row.id === result.item.id ? { ...row, status, statusId, statusCategory, updatedAt } : row) }
            : page),
        })
        void queryClient.invalidateQueries({ queryKey: queryKeys.tracker.transitions(association, item.id) })
      } catch (error) {
        toast(error instanceof Error ? error.message : 'The status change failed.', { tone: 'danger' })
        // 409: someone moved it first. Whatever went wrong, show the ticket as it is now.
        if (!(error instanceof ApiError) || error.status !== 0) refetch()
      } finally {
        settle(item.id)
      }
    }
  }, [association, listKey, queryClient])
  return { pending, move }
}

/** A ticket as the surface shows it while its move is in flight. */
export function withPendingMoves(items: readonly TrackerItem[], pending: ReadonlyMap<string, TrackerMoveTarget>): TrackerItem[] {
  if (pending.size === 0) return items as TrackerItem[]
  return items.map(item => {
    const target = pending.get(item.id)
    return target ? { ...item, status: target.status, statusId: target.statusId, statusCategory: target.statusCategory } : item
  })
}

/** The keyboard and pointer-free way to change a status: the same move a drag between columns makes. */
export function TrackerMoveMenu({ association, item, move, disabled = false }: { association: TrackerAssociation; item: TrackerItem; move: TrackerMove; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const transitions = useTrackerTransitions(association, item, open)
  const data = transitions.data
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm" disabled={disabled} data-slot="tracker-move-trigger" aria-label={`Status: ${item.status}. Move to another status`} className="h-7 gap-1.5 px-2 font-normal">
        <TrackerStatusIcon category={item.statusCategory} className="size-3.5" />
        {item.status}
        <ChevronDownIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-64">
      <DropdownMenuLabel>Move to</DropdownMenuLabel>
      {transitions.isPending ? <DropdownMenuItem disabled>Checking where this issue can go…</DropdownMenuItem> : null}
      {transitions.isError ? <DropdownMenuItem disabled>{transitions.error.message}</DropdownMenuItem> : null}
      {data && !data.available ? <DropdownMenuItem disabled className="whitespace-normal">{data.reason}</DropdownMenuItem> : null}
      {data?.available && !data.writable ? <DropdownMenuItem disabled className="whitespace-normal">{data.reason ?? 'This connection cannot change a status.'}</DropdownMenuItem> : null}
      {data?.available && data.writable && data.targets.length === 0 ? <DropdownMenuItem disabled>No other status is available from here.</DropdownMenuItem> : null}
      {data?.available && data.writable ? data.targets.map(target => <DropdownMenuItem key={target.statusId} disabled={!target.available} title={target.reason} onSelect={() => move(item, target)} className="items-start gap-2">
        <TrackerStatusIcon category={target.statusCategory} className="mt-0.5" />
        <span className="flex min-w-0 flex-col">
          <span>{target.status}</span>
          {target.reason ? <span className="text-xs whitespace-normal text-muted-foreground">{target.reason}</span> : null}
        </span>
      </DropdownMenuItem>) : null}
    </DropdownMenuContent>
  </DropdownMenu>
}
