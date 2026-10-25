import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArchiveIcon, ArchiveRestoreIcon, ExternalLinkIcon, MessageSquareIcon, MoreVerticalIcon } from 'lucide-react'
import * as React from 'react'
import type { RunRecord } from '@open-mercato/cezar-api-client'

import { archiveRun } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { taskReferences } from '@/lib/tasks-table'
import { runTitle } from '@/lib/task-groups'
import { runActionFlags } from '@/routes/task-thread/run-actions'

/**
 * A task row on a phone (spec 2026-10-24-mobile-cockpit §3.2): swipe right opens the thread,
 * a long press opens the row menu — Continue, Archive, Open PR — which also has a visible ⋮,
 * because nothing on a phone may be reachable by a gesture alone.
 */

/** How far a finger must travel right, mostly horizontally, to count as a swipe. */
export const SWIPE_MIN_PX = 64
/** How long a finger must rest, without travelling, to count as a long press. */
export const LONG_PRESS_MS = 500
const STILL_PX = 10

export type RowGesture = 'swipe-right' | 'long-press' | null

/** Pure: what a touch from `start` to `end` that lasted `ms` was. */
export function classifyRowGesture(start: { x: number; y: number }, end: { x: number; y: number }, ms: number): RowGesture {
  const dx = end.x - start.x
  const dy = Math.abs(end.y - start.y)
  if (dx >= SWIPE_MIN_PX && dy < dx / 2) return 'swipe-right'
  if (ms >= LONG_PRESS_MS && Math.abs(dx) < STILL_PX && dy < STILL_PX) return 'long-press'
  return null
}

/** Touch handlers for a row; the long press fires while the finger is still down. */
export function useRowGestures({ onSwipeRight, onLongPress }: { onSwipeRight: () => void; onLongPress: () => void }) {
  const start = React.useRef<{ x: number; y: number; at: number } | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fired = React.useRef(false)
  React.useEffect(() => () => clearTimeout(timer.current), [])

  return React.useMemo(() => ({
    onTouchStart: (event: React.TouchEvent) => {
      const touch = event.touches[0]
      if (!touch || event.touches.length > 1) return
      start.current = { x: touch.clientX, y: touch.clientY, at: Date.now() }
      fired.current = false
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        fired.current = true
        onLongPress()
      }, LONG_PRESS_MS)
    },
    onTouchMove: (event: React.TouchEvent) => {
      const touch = event.touches[0]
      if (!touch || !start.current) return
      if (Math.abs(touch.clientX - start.current.x) >= STILL_PX || Math.abs(touch.clientY - start.current.y) >= STILL_PX) {
        clearTimeout(timer.current)
      }
    },
    onTouchEnd: (event: React.TouchEvent) => {
      clearTimeout(timer.current)
      const origin = start.current
      start.current = null
      const touch = event.changedTouches[0]
      if (!origin || !touch || fired.current) return
      const gesture = classifyRowGesture(origin, { x: touch.clientX, y: touch.clientY }, Date.now() - origin.at)
      if (gesture === 'swipe-right') onSwipeRight()
    },
    /** A long press must not also click the row. */
    consumeClick: () => {
      const was = fired.current
      fired.current = false
      return was
    },
  }), [onLongPress, onSwipeRight])
}

/** The phone row menu: the three things a phone does with a task without opening it. */
export function PhoneTaskMenu({
  run,
  open,
  onOpenChange,
  onContinue,
}: {
  run: RunRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onContinue: () => void
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-slot="phone-task-menu"
          aria-label={`Actions for ${runTitle(run)}`}
          onClick={(event) => event.stopPropagation()}
          className="-mt-1 -mr-1.5 size-8 shrink-0 text-soft-foreground"
        >
          <MoreVerticalIcon aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44" onClick={(event) => event.stopPropagation()}>
        <PhoneTaskMenuItems run={run} onContinue={onContinue} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Mounted only while the menu is open, so a list of cards mounts no mutation per row. */
function PhoneTaskMenuItems({ run, onContinue }: { run: RunRecord; onContinue: () => void }) {
  const queryClient = useQueryClient()
  const flags = runActionFlags(run)
  const pr = taskReferences(run).find((reference) => reference.kind === 'PR' && reference.url)
  const { mutate: archive } = useMutation({
    mutationFn: () => archiveRun(run.id, !run.archived),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  return (
    <>
        <DropdownMenuItem onSelect={onContinue}>
          <MessageSquareIcon aria-hidden="true" /> Continue
        </DropdownMenuItem>
        {flags.archive ? (
          <DropdownMenuItem onSelect={() => archive()}>
            {run.archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
            {run.archived ? 'Unarchive' : 'Archive'}
          </DropdownMenuItem>
        ) : null}
        {pr?.url ? (
          <DropdownMenuItem asChild>
            <a href={pr.url} target="_blank" rel="noreferrer">
              <ExternalLinkIcon aria-hidden="true" /> Open PR #{pr.number}
            </a>
          </DropdownMenuItem>
        ) : null}
    </>
  )
}
