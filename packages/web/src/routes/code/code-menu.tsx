import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

/** One row of a context menu, or a rule between groups of them. */
export type MenuItem =
  | { label: string; shortcut?: string; danger?: boolean; disabled?: boolean; run: () => void }
  | 'separator'

export interface MenuRequest {
  x: number
  y: number
  items: MenuItem[]
}

/** Where a right click asks for a menu. */
export const menuAt = (event: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]): MenuRequest => {
  event.preventDefault()
  return { x: event.clientX, y: event.clientY, items }
}

/**
 * A menu at the pointer (the explorer's and the tabs'). Radix's dropdown anchors to a trigger
 * element; a right click has a point, not a trigger — hence this. Arrow keys walk it, Enter
 * runs, Escape or a click anywhere else closes.
 */
export function ContextMenu({ request, onClose }: { request: MenuRequest | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  // Keep the menu on screen: flip it back inside when the click was near an edge.
  useLayoutEffect(() => {
    if (!request || !ref.current) return
    const { offsetWidth: width, offsetHeight: height } = ref.current
    setPosition({
      left: Math.max(4, Math.min(request.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(request.y, window.innerHeight - height - 4)),
    })
    ref.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [request])

  useEffect(() => {
    if (!request) return
    const dismiss = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, request])

  if (!request) return null
  const step = (delta: 1 | -1) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[(index + delta + buttons.length) % buttons.length]?.focus()
  }
  return (
    <div
      ref={ref}
      role="menu"
      data-slot="code-context-menu"
      style={position}
      className="fixed z-50 min-w-52 rounded-md border border-border bg-popover p-1 text-[13px] text-popover-foreground shadow-md"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') onClose()
        else if (event.key === 'ArrowDown') { event.preventDefault(); step(1) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1) }
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {request.items.map((item, index) =>
        item === 'separator' ? (
          <div key={`rule-${index}`} role="separator" className="my-1 h-px bg-border" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cn(
              'flex w-full items-center justify-between gap-6 rounded-sm px-2 py-1 text-left outline-none hover:bg-accent focus:bg-accent disabled:opacity-40',
              item.danger && 'text-danger',
            )}
            onClick={() => { onClose(); item.run() }}
          >
            <span>{item.label}</span>
            {item.shortcut ? <span className="font-mono text-[11px] text-soft-foreground">{item.shortcut}</span> : null}
          </button>
        ),
      )}
    </div>
  )
}
