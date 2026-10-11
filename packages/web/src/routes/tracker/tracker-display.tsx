import { SlidersHorizontalIcon } from 'lucide-react'
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** The optional properties a row or a card can show. The key and the title are always shown. */
export const TRACKER_DISPLAY_FIELDS = [
  { id: 'description', label: 'Description' },
  { id: 'labels', label: 'Labels' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'priority', label: 'Priority' },
  { id: 'author', label: 'Author' },
  { id: 'updated', label: 'Updated' },
] as const
export type TrackerDisplayField = (typeof TRACKER_DISPLAY_FIELDS)[number]['id']
export type TrackerDisplay = ReadonlySet<TrackerDisplayField>

export const ALL_TRACKER_FIELDS: TrackerDisplay = new Set(TRACKER_DISPLAY_FIELDS.map(field => field.id))

const HIDDEN_KEY = 'cezar.tracker.hidden'
const PANEL_KEY = 'cezar.tracker.panel'

/** A per-viewer convenience kept in this browser; storage that is missing or refuses is ignored. */
function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function writeStored(key: string, value: string | null): void {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value) } catch { /* this visit only */ }
}

/** Which properties rows and cards show. Stored as what is HIDDEN, so a field added later shows by default. */
export function useTrackerDisplay(): { shown: TrackerDisplay; toggle: (field: TrackerDisplayField) => void } {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(readStored(HIDDEN_KEY) ?? '[]')
      return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [])
    } catch { return new Set() }
  })
  const toggle = useCallback((field: TrackerDisplayField) => setHidden(previous => {
    const next = new Set(previous)
    if (!next.delete(field)) next.add(field)
    writeStored(HIDDEN_KEY, JSON.stringify([...next]))
    return next
  }), [])
  return { shown: new Set(TRACKER_DISPLAY_FIELDS.map(field => field.id).filter(id => !hidden.has(id))), toggle }
}

export function TrackerDisplayMenu({ shown, toggle }: { shown: TrackerDisplay; toggle: (field: TrackerDisplayField) => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm" data-slot="tracker-display-trigger" className="h-8 gap-1.5 font-normal"><SlidersHorizontalIcon aria-hidden="true" />Display</Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-48">
      <DropdownMenuLabel>Show on issues</DropdownMenuLabel>
      {TRACKER_DISPLAY_FIELDS.map(field => <DropdownMenuCheckboxItem key={field.id} checked={shown.has(field.id)} onCheckedChange={() => toggle(field.id)} onSelect={(event) => event.preventDefault()}>
        {field.label}
      </DropdownMenuCheckboxItem>)}
    </DropdownMenuContent>
  </DropdownMenu>
}

const PANEL_MIN = 360
/** What the issue surface keeps beside an open panel, however wide the panel is dragged. */
const SURFACE_MIN = 280
const KEY_STEP = 32

/**
 * The issue panel's width: its stylesheet default until the viewer drags the divider, then a
 * remembered pixel width clamped to the room there is. Pointer and keyboard both resize.
 */
export function useTrackerPanelWidth() {
  const container = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(() => {
    const stored = Number(readStored(PANEL_KEY))
    return Number.isFinite(stored) && stored >= PANEL_MIN ? stored : null
  })
  const clamp = (value: number): number => {
    const room = (container.current?.getBoundingClientRect().width ?? Infinity) - SURFACE_MIN
    return Math.round(Math.max(PANEL_MIN, Math.min(value, Math.max(PANEL_MIN, room))))
  }
  const apply = (value: number) => { const next = clamp(value); setWidth(next); writeStored(PANEL_KEY, String(next)) }
  const current = (handle: HTMLElement): number => width ?? (handle.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().width ?? PANEL_MIN
  const separator = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-label': 'Resize the issue panel',
    'aria-valuemin': PANEL_MIN,
    ...(width !== null ? { 'aria-valuenow': width } : {}),
    tabIndex: 0,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return
      const right = container.current?.getBoundingClientRect().right
      if (right !== undefined) apply(right - event.clientX)
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => event.currentTarget.releasePointerCapture?.(event.pointerId),
    onDoubleClick: () => { setWidth(null); writeStored(PANEL_KEY, null) },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      // The panel is on the right: the divider moving left makes it wider.
      apply(current(event.currentTarget) + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP))
    },
  }
  return { container, width, separator }
}
