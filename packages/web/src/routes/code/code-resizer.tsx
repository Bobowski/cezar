import { useRef } from 'react'

import { cn } from '@/lib/utils'

/**
 * A draggable border between two panes (spec 2026-10-11-code-page): editor groups, the bottom
 * panel, the agent pane. Reports movement in PIXELS since the last report; the owner decides
 * what a pixel means. Arrow keys move it too, so a width is reachable without a mouse.
 */
export function Resizer({
  axis, label, onDrag, className,
}: {
  /** `x`: a vertical bar dragged sideways. `y`: a horizontal bar dragged up and down. */
  axis: 'x' | 'y'
  label: string
  /** Positive is rightwards or downwards. */
  onDrag: (delta: number) => void
  className?: string
}) {
  const last = useRef<number | null>(null)
  const at = (event: React.PointerEvent) => (axis === 'x' ? event.clientX : event.clientY)
  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      title="Drag to resize — arrow keys adjust precisely"
      data-slot="code-resizer"
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        last.current = at(event)
      }}
      onPointerMove={(event) => {
        if (last.current === null) return
        const now = at(event)
        if (now !== last.current) onDrag(now - last.current)
        last.current = now
      }}
      onPointerUp={(event) => {
        last.current = null
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }}
      onPointerCancel={() => { last.current = null }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 12
        const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
        const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
        if (event.key !== back && event.key !== forward) return
        event.preventDefault()
        event.stopPropagation()
        onDrag(event.key === forward ? step : -step)
      }}
      className={cn(
        'relative z-10 shrink-0 touch-none bg-border transition-colors hover:bg-violet/60 focus-visible:bg-violet focus-visible:outline-none',
        // A one-pixel line with a wider grab area either side of it.
        axis === 'x' ? 'w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-1 before:w-[9px]' : 'h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-1 before:h-[9px]',
        className,
      )}
    />
  )
}
