import type { KeyboardEvent } from 'react'

/**
 * Clickable rows wear the focus too (spec 2026-10-24-cockpit-polish §3.4 item 2): a list the
 * keyboard can walk shows where it is, and `Enter` opens what a click opens.
 */

/** A row that is itself the focus stop. */
export const ROW_FOCUS_CLASS = 'outline-none focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50'

/** A row whose own link carries the keyboard: the row lights up while the link has the focus. */
export const ROW_FOCUS_WITHIN_CLASS =
  'has-[a:focus-visible]:bg-muted/60 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-ring/50'

/** A clickable row with no link inside: a focus stop that opens on `Enter`, like its click. */
export function openOnEnter(open: () => void): { tabIndex: 0; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void } {
  return {
    tabIndex: 0,
    onKeyDown: (event) => {
      // Only the row's own key: an input or a button inside it keeps its Enter.
      if (event.key !== 'Enter' || event.target !== event.currentTarget) return
      event.preventDefault()
      open()
    },
  }
}
