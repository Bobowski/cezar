import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TrackerAssociation } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ShellWithSidebar } from '@/test/shell-with-sidebar'
import { TrackerRoute } from './tracker'

vi.mock('@/components/engine-pills', () => ({ EnginePills: () => null, engineRunBody: () => ({}), useResolvedEngine: () => ({ canRun: true }) }))

/** Spec 2026-10-11-tracker-ticket-context § Phase 5: Display, "Has task", the resizable panel, assignee and priority. */
const association: TrackerAssociation = { kind: 'jira', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS' }
const issue = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'issue', id, title: `Title ${id}`, author: 'Ada Author', createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
  labels: ['backend'], body: 'description', bodyTruncated: false, unsupportedContent: false, url: `https://acme.atlassian.net/browse/${id}`,
  status: 'To Do', statusId: 'todo', statusCategory: 'unstarted', ...extra,
})
const linkedRun = { id: 'run-1', title: 'Work', task: 'Work', status: 'running', createdAt: '2026-10-11T10:00:00.000Z', steps: [], trackerLinks: [{ provider: 'jira', sourceId: 'acme', scopeId: '100', itemId: 'OPS-2', origin: 'handoff', linkedAt: '2026-10-11T10:00:00.000Z' }] }

function mount(path = '/tracker') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.pathname.endsWith('/tracker/association')) return json({ association })
    if (url.pathname.endsWith('/tracker/OPS-1')) return json({ available: true, item: issue('OPS-1', { assignee: 'Grace Assignee', priority: 'High' }), comments: { available: true, items: [], truncated: false } })
    if (url.pathname.endsWith('/tracker')) return json({ available: true, truncated: false, items: [issue('OPS-1', { assignee: 'Grace Assignee', priority: 'High' }), issue('OPS-2')] })
    if (url.pathname.endsWith('/runs')) return json([linkedRun])
    if (url.pathname.endsWith('/workflows')) return json({ workflows: [] })
    return new Promise<never>(() => {})
  }))
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={createQueryClient()}>
        <ShellWithSidebar><Routes><Route path="/tracker/:id?" element={<TrackerRoute />} /></Routes></ShellWithSidebar>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}
const row = (id: string) => screen.getByText(`Title ${id}`).closest('a') as HTMLAnchorElement

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

describe('assignee and priority', () => {
  it('show on a row that has them and not on one that does not', async () => {
    mount()
    await screen.findByText('Title OPS-1')
    expect(row('OPS-1').querySelector('[data-slot="tracker-assignee"]')?.textContent).toBe('Grace Assignee')
    expect(row('OPS-1').querySelector('[data-slot="tracker-priority"]')?.textContent).toBe('High')
    expect(row('OPS-2').querySelector('[data-slot="tracker-assignee"]')?.textContent).toBe('—')
    expect(row('OPS-2').querySelector('[data-slot="tracker-priority"]')).toBeNull()
  })

  it('appear among the properties of the issue panel', async () => {
    mount('/tracker/OPS-1')
    const panel = await waitFor(() => { const element = document.querySelector('[data-slot="tracker-panel"]'); expect(element?.textContent).toContain('Assignee'); return element! })
    expect(panel.textContent).toContain('Grace Assignee')
    expect(panel.textContent).toContain('Priority')
  })
})

describe('the Display menu', () => {
  it('hides and restores a property, and remembers the choice in this browser', async () => {
    mount()
    await screen.findByText('Title OPS-1')
    expect(row('OPS-1').textContent).toContain('backend')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Display' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Labels' }))
    await waitFor(() => expect(row('OPS-1').textContent).not.toContain('backend'))
    expect(JSON.parse(window.localStorage.getItem('cezar.tracker.hidden')!)).toEqual(['labels'])
    // The menu stays open for a second choice.
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Assignee' }))
    await waitFor(() => expect(row('OPS-1').querySelector('[data-slot="tracker-assignee"]')).toBeNull())
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Labels' }))
    await waitFor(() => expect(row('OPS-1').textContent).toContain('backend'))
    // The key and the title are not optional.
    expect(row('OPS-1').textContent).toContain('OPS-1')
    expect(row('OPS-1').textContent).toContain('Title OPS-1')
  })

  it('starts from what was hidden last time, and ignores storage it cannot read', async () => {
    window.localStorage.setItem('cezar.tracker.hidden', JSON.stringify(['labels', 'something-from-the-future']))
    mount()
    await screen.findByText('Title OPS-1')
    expect(row('OPS-1').textContent).not.toContain('backend')
    cleanup()
    window.localStorage.setItem('cezar.tracker.hidden', '{not json')
    mount()
    await screen.findByText('Title OPS-1')
    expect(row('OPS-1').textContent).toContain('backend')
  })
})

describe('the "Has task" filter', () => {
  it('narrows the loaded issues to those with a task, and back', async () => {
    mount()
    await screen.findByText('Title OPS-1')
    await waitFor(() => expect(row('OPS-2').querySelector('[data-slot="tracker-activity"]')).toBeTruthy())
    const toggle = screen.getByRole('button', { name: 'Has task' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByText('Title OPS-1')).toBeNull())
    expect(screen.getByText('Title OPS-2')).toBeTruthy()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(await screen.findByText('Title OPS-1')).toBeTruthy()
  })
})

describe('the width of the issue panel', () => {
  const panel = () => document.querySelector('[data-slot="tracker-panel"]') as HTMLElement
  it('is resized from the keyboard, remembered, and reset by a double-click', async () => {
    mount('/tracker/OPS-1')
    const separator = await screen.findByRole('separator', { name: 'Resize the issue panel' })
    expect(panel().style.width).toBe('')
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    await waitFor(() => expect(panel().style.width).toMatch(/^\d+px$/))
    const wider = Number.parseInt(panel().style.width, 10)
    expect(wider).toBeGreaterThanOrEqual(360)
    expect(window.localStorage.getItem('cezar.tracker.panel')).toBe(String(wider))
    // Never narrower than its floor, however far the divider is pushed.
    for (let step = 0; step < 40; step++) fireEvent.keyDown(separator, { key: 'ArrowRight' })
    await waitFor(() => expect(Number.parseInt(panel().style.width, 10)).toBe(360))
    fireEvent.doubleClick(separator)
    await waitFor(() => expect(panel().style.width).toBe(''))
    expect(window.localStorage.getItem('cezar.tracker.panel')).toBeNull()
  })

  it('opens at the remembered width', async () => {
    window.localStorage.setItem('cezar.tracker.panel', '520')
    mount('/tracker/OPS-1')
    await screen.findByRole('separator', { name: 'Resize the issue panel' })
    expect(panel().style.width).toBe('520px')
  })
})
