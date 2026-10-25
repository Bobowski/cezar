import * as React from 'react'
import { createPortal } from 'react-dom'

/**
 * The contextual sidebar: the collapsible column inside the content panel that belongs to the
 * SCREEN you are on, not to the app. The icon rail says which area you are in; this says what
 * is in it — the task list on Tasks, the file tree on Git, the pull requests on GitHub, the
 * section list in Settings.
 *
 * A screen fills it by rendering `<ContextSidebar>` anywhere in its tree. The children are
 * portalled into the shell's sidebar, so they keep the screen's own React context (queries,
 * router, project scope) while living in the shell's chrome. A screen that renders none gets no
 * sidebar at all, and the top bar's toggle disappears with it.
 *
 * Compose the children from the shadcn sidebar parts — `SidebarHeader`, `SidebarContent`,
 * `SidebarGroup`, `SidebarGroupLabel`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`,
 * `SidebarMenuSub`, `SidebarInput`, `SidebarFooter` — they render correctly here.
 */

/**
 * A screen's own frame for the column (spec 2026-10-24-cockpit-polish §3.1): its width, a resize
 * handle, and a fold to icons instead of off-canvas — all of it the screen's state to keep. A
 * screen that passes none gets the shell's fixed 18rem column and its remembered open state.
 */
export interface ContextSidebarFrame {
  width: number
  onWidthChange: (width: number) => void
  minWidth: number
  maxWidth: number
  defaultWidth: number
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
}

type ContextSidebarValue = {
  /** Where the children are portalled. Null while the sidebar is not mounted (a closed sheet). */
  node: HTMLElement | null
  /** Called by every mounted `<ContextSidebar>`; the returned function unregisters it. */
  register: () => () => void
  /** Hands the shell a frame; the returned function takes it back. */
  setFrame?: (frame: ContextSidebarFrame) => () => void
}

export const ContextSidebarContext = React.createContext<ContextSidebarValue | null>(null)

export function ContextSidebar({ children, frame }: { children: React.ReactNode; frame?: ContextSidebarFrame }) {
  const context = React.useContext(ContextSidebarContext)
  const register = context?.register
  const setFrame = context?.setFrame
  React.useEffect(() => register?.(), [register])
  React.useEffect(() => (frame ? setFrame?.(frame) : undefined), [frame, setFrame])
  if (!context?.node) return null
  return createPortal(children, context.node)
}
