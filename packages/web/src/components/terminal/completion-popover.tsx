import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

import type { CompletionView } from './completion'

/** Where the popover sits: under the cursor row, or above it when the cursor is low. */
export interface PopoverPlace {
  left: number
  /** Distance from the pane's top edge, or — `above` — from its bottom edge. */
  offset: number
  above: boolean
}

const SOURCE_LABEL = { command: 'command', history: 'history', path: 'path' } as const

/**
 * The completion list drawn over xterm (spec `.ai/specs/2026-10-24-code-page-terminal.md` §3.3).
 * The completing list never takes focus — the terminal keeps it and its keys drive the list; the
 * `Ctrl+R` history list has a filter to type into, and hands focus back when it closes.
 */
export function CompletionPopover({
  view,
  place,
  onAccept,
  onPickHistory,
  onFilter,
  onClose,
}: {
  view: NonNullable<CompletionView>
  place: PopoverPlace
  onAccept: (index: number) => void
  onPickHistory: (line: string) => void
  onFilter: (filter: string) => void
  onClose: () => void
}) {
  const style = place.above ? { left: place.left, bottom: place.offset } : { left: place.left, top: place.offset }
  return (
    <div
      data-slot="terminal-completion"
      data-mode={view.mode}
      style={style}
      className="absolute z-20 w-[min(28rem,calc(100%-1.5rem))] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
      // Clicking the list must not blur the terminal it completes for.
      onMouseDown={(event) => {
        if (view.mode === 'complete') event.preventDefault()
      }}
    >
      {view.mode === 'complete' ? (
        <ul role="listbox" aria-label="Completions" className="max-h-56 overflow-y-auto py-1">
          {view.items.map((item, index) => (
            <li
              key={`${item.source}:${item.line}`}
              role="option"
              aria-selected={index === view.selected}
              data-source={item.source}
              onClick={() => onAccept(index)}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-2 py-0.5 font-mono text-xs',
                index === view.selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">{item.line.slice(0, item.line.length - item.insert.length)}</span>
                {item.insert}
              </span>
              <span className="shrink-0 font-sans text-[10px] text-soft-foreground">{SOURCE_LABEL[item.source]}</span>
            </li>
          ))}
          <li aria-hidden="true" className="border-t border-border/70 px-2 pt-1 font-sans text-[10px] text-soft-foreground">
            Tab accepts · Esc hides · Ctrl+R history
          </li>
        </ul>
      ) : (
        <HistoryList view={view} onPick={onPickHistory} onFilter={onFilter} onClose={onClose} />
      )}
    </div>
  )
}

function HistoryList({
  view,
  onPick,
  onFilter,
  onClose,
}: {
  view: Extract<NonNullable<CompletionView>, { mode: 'history' }>
  onPick: (line: string) => void
  onFilter: (filter: string) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState(0)
  useEffect(() => setSelected(0), [view.filter])
  const count = view.items.length
  return (
    <div className="flex flex-col">
      <input
        autoFocus
        value={view.filter}
        onChange={(event) => onFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (count > 0) setSelected((current) => (current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            const line = view.items[selected]
            if (line !== undefined) onPick(line)
            else onClose()
          }
        }}
        onBlur={onClose}
        placeholder="Search this project's history"
        aria-label="Search terminal history"
        spellCheck={false}
        className="h-7 border-b border-border bg-transparent px-2 font-mono text-xs outline-none"
      />
      {count === 0 ? (
        <p className="px-2 py-1.5 text-xs text-soft-foreground">
          {view.filter === '' ? 'Nothing typed in this project’s terminals yet.' : 'No line matches.'}
        </p>
      ) : (
        <ul role="listbox" aria-label="Terminal history" className="max-h-56 overflow-y-auto py-1">
          {view.items.map((line, index) => (
            <li
              key={line}
              role="option"
              aria-selected={index === selected}
              // Before the input's blur closes the list.
              onMouseDown={(event) => {
                event.preventDefault()
                onPick(line)
              }}
              className={cn(
                'cursor-pointer truncate px-2 py-0.5 font-mono text-xs',
                index === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
              )}
            >
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
