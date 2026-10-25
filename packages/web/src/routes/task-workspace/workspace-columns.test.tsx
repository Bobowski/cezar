import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'

import type { ViewId, WorkspaceColumn } from './layout-state'
import { WorkspaceColumns, type ColumnActions } from './workspace-columns'

/** A window's full screen follows the window, not its slot (spec 2026-10-24-cockpit-polish §3.3). */

vi.mock('@/lib/use-desktop', () => ({ useIsDesktop: () => true }))

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.cezFullscreen
})

function Layout({ initial }: { initial: ViewId[] }) {
  const [columns, setColumns] = useState<WorkspaceColumn[]>(() => initial.map((view) => ({ view, width: 100 / initial.length })))
  const actions: ColumnActions = {
    addColumn: (view) => setColumns((all) => [...all, { view, width: 100 / (all.length + 1) }]),
    closeColumn: (index) => setColumns((all) => all.filter((_, at) => at !== index)),
    setColumnView: (index, view) => setColumns((all) => all.map((column, at) => (at === index ? { ...column, view } : column))),
    resizeColumns: () => {},
    moveColumn: (from, to) =>
      setColumns((all) => {
        const next = [...all]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved!)
        return next
      }),
  }
  return (
    <TooltipProvider>
      <WorkspaceColumns columns={columns} actions={actions} renderView={(view) => <p>{view} body</p>} />
    </TooltipProvider>
  )
}

const windowOf = (view: string) => document.querySelector<HTMLElement>(`[data-slot="workspace-column"][data-view="${view}"]`)!
const fullscreen = (view: string) => windowOf(view).getAttribute('data-fullscreen') === 'true'

describe('WorkspaceColumns', () => {
  it('a full-screen window stays full screen when a window before it closes', () => {
    render(<Layout initial={['session', 'changes']} />)
    // F11 with the focus in the Changes window.
    const inside = screen.getByText('changes body')
    inside.tabIndex = -1
    inside.focus()
    fireEvent.keyDown(window, { key: 'F11' })
    expect(fullscreen('changes')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Close Chat$/ }))
    expect(document.querySelectorAll('[data-slot="workspace-column"]')).toHaveLength(1)
    expect(fullscreen('changes')).toBe(true)
  })

  it('and when it moves', async () => {
    render(<Layout initial={['session', 'changes']} />)
    const inside = screen.getByText('session body')
    inside.tabIndex = -1
    inside.focus()
    fireEvent.keyDown(window, { key: 'F11' })
    expect(fullscreen('session')).toBe(true)
    // Radix opens its menu on a keyboard Enter in jsdom (no pointer capture there).
    fireEvent.keyDown(screen.getByRole('button', { name: 'Column menu Chat' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Move right/ }))
    const order = [...document.querySelectorAll('[data-slot="workspace-column"]')].map((node) => node.getAttribute('data-view'))
    expect(order).toEqual(['changes', 'session'])
    expect(fullscreen('session')).toBe(true)
    expect(fullscreen('changes')).toBe(false)
  })
})
