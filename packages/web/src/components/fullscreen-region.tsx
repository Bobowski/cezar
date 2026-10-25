import { Maximize2Icon, Minimize2Icon } from 'lucide-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { cn } from '@/lib/utils'

/**
 * Full screen for one region of a screen (spec `.ai/specs/2026-10-24-cockpit-polish.md` §3.3):
 * the task thread, a diff, the Browser column, the terminal drawer, Docker/Services, the Code
 * page. The region is PINNED over the window rather than moved — an iframe that changes parent
 * reloads, and a thread or a diff that remounts loses its place — and keeps its own toolbar;
 * the shell's chrome is simply covered. A layout state only: the browser's Fullscreen API would
 * take `Esc` for itself, before an open dialog, a shell or an editor could have it.
 *
 * Entering: the region's control, or `F11` (`Ctrl+Cmd+F` on macOS) with the focus in it — or,
 * on a screen with one region, anywhere. Leaving: `Esc` (after a dialog, a shell or an editor
 * declined it), the control, or `F11` again. Never persisted: a reload returns to the layout.
 */

export interface FullscreenControl {
  active: boolean
  toggle: () => void
  /** What the region is, for the control's label. */
  label: string
}

const FullscreenContext = React.createContext<FullscreenControl | null>(null)

/** The nearest region's control, or null outside one. */
export function useFullscreenRegion(): FullscreenControl | null {
  return React.useContext(FullscreenContext)
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** The shortcut as the controls print it. */
export const FULLSCREEN_SHORTCUT = MAC ? '⌃⌘F' : 'F11'

/** True for the key that toggles full screen: `F11`, or `Ctrl+Cmd+F` on macOS. */
export function isFullscreenKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>): boolean {
  return event.key === 'F11' || (event.ctrlKey && event.metaKey && event.key.toLowerCase() === 'f')
}

interface Region {
  element: () => HTMLElement | null
  active: () => boolean
  set: (active: boolean) => void
}

const regions = new Set<Region>()
/** The region the pointer last went down in — the focus of a click that focuses nothing. */
let touched: Region | null = null

/** Where Esc belongs to the program, not to the page: a shell, an editor. */
const OWNS_ESCAPE = '.xterm, .cm-editor'
/** An open dialog, menu or listbox owns Esc too. */
const OPEN_OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

/** The innermost region holding `node`. */
function regionOf(node: Node | null): Region | null {
  if (!node) return null
  let found: Region | null = null
  for (const region of regions) {
    const element = region.element()
    if (!element?.contains(node)) continue
    if (!found || found.element()?.contains(element)) found = region
  }
  return found
}

/** The region `F11` means: the one in full screen, the focused one, the touched one, the only one. */
function targetRegion(): Region | null {
  for (const region of regions) if (region.active()) return region
  const focused = document.activeElement && document.activeElement !== document.body ? regionOf(document.activeElement) : null
  if (focused) return focused
  if (touched && regions.has(touched)) return touched
  return regions.size === 1 ? ([...regions][0] ?? null) : null
}

/** Esc events a shell or an editor saw and declined: they leave full screen after all. */
const declined = new WeakSet<KeyboardEvent>()

/**
 * For a program that owns Esc (a shell, an editor) and did not want this one: when `node` is in
 * the region holding the window, marks the event so it leaves full screen, and answers true —
 * the caller then keeps the key from the program.
 */
export function declineEscape(event: KeyboardEvent, node: Node | null): boolean {
  const active = [...regions].find((region) => region.active())
  if (!active || !node || !active.element()?.contains(node)) return false
  declined.add(event)
  return true
}

function onKeyDown(event: KeyboardEvent) {
  if (isFullscreenKey(event)) {
    const region = targetRegion()
    // No region to give it to: the browser's own full screen, as everywhere else.
    if (!region) return
    event.preventDefault()
    region.set(!region.active())
    return
  }
  if (event.key !== 'Escape' || event.defaultPrevented) return
  const active = [...regions].find((region) => region.active())
  if (!active) return
  if (document.querySelector(OPEN_OVERLAY)) return
  if (!declined.has(event) && event.target instanceof Element && event.target.closest(OWNS_ESCAPE)) return
  active.set(false)
}

function onPointerDown(event: PointerEvent) {
  touched = regionOf(event.target instanceof Node ? event.target : null)
}

/** Focus that lands outside every region ends the touched fallback: `F11` is the browser's again. */
function onFocusIn(event: FocusEvent) {
  const target = event.target instanceof Node ? event.target : null
  if (target && target !== document.body && !regionOf(target)) touched = null
}

function register(region: Region): () => void {
  if (regions.size === 0) {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('focusin', onFocusIn, true)
  }
  regions.add(region)
  return () => {
    regions.delete(region)
    if (touched === region) touched = null
    if (regions.size > 0) return
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('focusin', onFocusIn, true)
  }
}

type FullscreenRegionProps = Omit<React.ComponentProps<'div'>, 'ref'> & {
  /** What the region is ("Browser", "Terminal") — the control's label and `data-fullscreen-region`. */
  label: string
  /** Controlled: the host owns the state (the Code page lays itself out differently in it). */
  active?: boolean
  onActiveChange?: (active: boolean) => void
  as?: 'div' | 'section'
}

export function FullscreenRegion({ label, active: activeProp, onActiveChange, as = 'div', className, style, children, ...props }: FullscreenRegionProps) {
  const [own, setOwn] = React.useState(false)
  const active = activeProp ?? own
  const ref = React.useRef<HTMLElement | null>(null)
  const latest = React.useRef({ active, onActiveChange })
  latest.current = { active, onActiveChange }

  const set = React.useCallback((next: boolean) => {
    if (next === latest.current.active) return
    // One region at a time: entering this one leaves any other.
    if (next) for (const region of regions) if (region.active() && region.element() !== ref.current) region.set(false)
    latest.current.active = next
    if (latest.current.onActiveChange) latest.current.onActiveChange(next)
    else setOwn(next)
  }, [])

  React.useEffect(
    () => register({ element: () => ref.current, active: () => latest.current.active, set }),
    [set],
  )
  // Marks the document while a region holds the window, for the shell and the e2e suite.
  React.useEffect(() => {
    if (!active) return
    document.documentElement.dataset.cezFullscreen = label
    return () => {
      if (document.documentElement.dataset.cezFullscreen === label) delete document.documentElement.dataset.cezFullscreen
    }
  }, [active, label])

  const control = React.useMemo<FullscreenControl>(() => ({ active, toggle: () => set(!latest.current.active), label }), [active, label, set])
  const Tag = as
  return (
    <FullscreenContext.Provider value={control}>
      <Tag
        ref={(node: HTMLElement | null) => {
          ref.current = node
        }}
        data-fullscreen-region={label}
        data-fullscreen={active ? 'true' : undefined}
        // A column's share of the row (`width: 40%`) would beat `inset-0`; in full screen it goes.
        style={active && style ? { ...style, width: undefined, height: undefined } : style}
        // In the window the region is its own scroller: the shell's `main` is covered with it.
        className={cn(className, active && 'fixed inset-0 z-50 overflow-y-auto bg-background')}
        {...props}
      >
        {children}
      </Tag>
    </FullscreenContext.Provider>
  )
}

/**
 * The region's control, for the strip it already has. Renders nothing outside a region, so a
 * strip shared with places that have none can carry it unconditionally.
 */
export function FullscreenToggle({ className }: { className?: string }) {
  const region = useFullscreenRegion()
  if (!region) return null
  const label = region.active ? `Exit full screen (Esc)` : `Full screen — ${region.label} (${FULLSCREEN_SHORTCUT})`
  return (
    <IconTooltip label={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-action="fullscreen-region"
        aria-label={region.active ? 'Exit full screen' : `Full screen ${region.label}`}
        aria-pressed={region.active}
        onClick={region.toggle}
        className={cn('text-soft-foreground hover:text-foreground', className)}
      >
        {region.active ? <Minimize2Icon aria-hidden="true" className="size-3.5" /> : <Maximize2Icon aria-hidden="true" className="size-3.5" />}
      </Button>
    </IconTooltip>
  )
}
