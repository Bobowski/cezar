import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { trackerReadScope, type TrackerAssociation } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ShellWithSidebar } from '@/test/shell-with-sidebar'
import { TRACKER_MOVE_TYPE } from './tracker-surface'
import { TrackerRoute } from './tracker'

vi.mock('@/components/engine-pills', () => ({ EnginePills: () => null, engineRunBody: () => ({}), useResolvedEngine: () => ({ canRun: true }) }))

/** Spec 2026-10-11-tracker-ticket-context § Phase 6: a card moved to another column changes the ticket's status. */
const association: TrackerAssociation = { kind: 'jira', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS' }
const STATUS = {
  todo: { status: 'To Do', statusId: 'todo', statusCategory: 'unstarted' },
  review: { status: 'In Review', statusId: 'review', statusCategory: 'started' },
  done: { status: 'Done', statusId: 'done', statusCategory: 'done' },
} as const
const issue = (id: string, status: keyof typeof STATUS) => ({
  kind: 'issue', id, title: `Title ${id}`, author: 'Ada', createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
  labels: [], body: 'description', bodyTruncated: false, unsupportedContent: false, url: `https://acme.atlassian.net/browse/${id}`, ...STATUS[status],
})
const noComments = { available: true, items: [], truncated: false }

type Answer = { status?: number; body: unknown }
function mount(options: { path?: string; transition?: () => Answer; transitions?: unknown; automations?: unknown[] } = {}) {
  const posts: unknown[] = []
  const state: Record<string, keyof typeof STATUS> = { 'OPS-1': 'todo', 'OPS-2': 'review', 'OPS-3': 'done' }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.pathname.endsWith('/tracker/association')) return json({ association })
    // Automations are consulted only when the server says they are on.
    if (url.pathname.endsWith('/health') && options.automations) return json({ ok: true, capabilities: { automations: true } })
    if (url.pathname.endsWith('/automations') && options.automations) return json({ available: true, scheduler: { state: 'idle' }, timeZone: 'UTC', stats: {}, automations: options.automations })
    if (url.pathname.endsWith('/transitions')) return json(options.transitions ?? { available: true, currentStatusId: 'todo', writable: true, targets: [
      { ...STATUS.review, available: true },
      { ...STATUS.done, available: false, reason: 'This move requires fields to be filled in. Complete it in Jira.' },
    ] })
    if (url.pathname.endsWith('/transition') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { toStatusId: keyof typeof STATUS }
      posts.push(body)
      if (options.transition) { const answer = options.transition(); return json(answer.body, answer.status ?? 200) }
      if (!(body.toStatusId in STATUS)) return json({ available: true, item: { ...issue('OPS-1', 'todo'), status: 'QA', statusId: body.toStatusId, statusCategory: 'started' }, comments: noComments })
      state['OPS-1'] = body.toStatusId
      return json({ available: true, item: issue('OPS-1', body.toStatusId), comments: noComments })
    }
    if (url.pathname.endsWith('/tracker/OPS-1')) return json({ available: true, item: issue('OPS-1', state['OPS-1']!), comments: noComments })
    if (url.pathname.endsWith('/tracker')) return json({ available: true, items: Object.entries(state).map(([id, status]) => issue(id, status)), truncated: false })
    if (url.pathname.endsWith('/workflows')) return json({ workflows: [] })
    return new Promise<never>(() => {})
  }))
  render(
    <MemoryRouter initialEntries={[options.path ?? '/tracker']}>
      <QueryClientProvider client={createQueryClient()}>
        <ShellWithSidebar><Routes><Route path="/tracker/:id?" element={<TrackerRoute />} /></Routes></ShellWithSidebar>
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return posts
}
const column = (name: string) => document.querySelector(`[data-slot="tracker-column"][aria-label="${name}"]`) as HTMLElement
const transfer = () => ({ setData: vi.fn(), types: [TRACKER_MOVE_TYPE], effectAllowed: 'none', dropEffect: 'none' })
/** Pick the card up and wait until the cockpit knows where it may go. */
async function pickUp(id: string, into: string) {
  const card = (await screen.findByText(`Title ${id}`)).closest('a') as HTMLAnchorElement
  const dataTransfer = transfer()
  fireEvent.dragStart(card, { dataTransfer })
  await waitFor(() => expect(column(into).getAttribute('data-drop')).toMatch(/allowed|refused/))
  return { card, dataTransfer }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  window.localStorage.setItem('cezar.tracker.view', 'board')
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

describe('moving a card between board columns', () => {
  it('asks the vendor for exactly the move the user made and shows the card in its new column', async () => {
    const posts = mount()
    const { dataTransfer } = await pickUp('OPS-1', 'In Review')
    // A status-change drag is marked as such, whether or not the ticket's detail was loaded.
    expect(dataTransfer.setData).toHaveBeenCalledWith(TRACKER_MOVE_TYPE, 'OPS-1')
    await waitFor(() => expect(column('In Review').getAttribute('data-drop')).toBe('allowed'))
    fireEvent.dragOver(column('In Review'), { dataTransfer })
    fireEvent.drop(column('In Review'), { dataTransfer })
    await waitFor(() => expect(posts).toEqual([{ expectedScope: trackerReadScope(association), toStatusId: 'review', expectedStatusId: 'todo' }]))
    await waitFor(() => expect(within(column('In Review')).getByText('Title OPS-1')).toBeTruthy())
    expect(document.querySelector('[data-slot="tracker-column"][aria-label="To Do"]')).toBeNull()
  })

  it('writes nothing when the card is dropped on a column the tracker will not take it to', async () => {
    const posts = mount()
    const { dataTransfer } = await pickUp('OPS-1', 'Done')
    await waitFor(() => expect(column('Done').getAttribute('data-drop')).toBe('refused'))
    expect(column('Done').getAttribute('title')).toContain('Complete it in Jira')
    fireEvent.dragOver(column('Done'), { dataTransfer })
    fireEvent.drop(column('Done'), { dataTransfer })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(posts).toEqual([])
    expect(within(column('To Do')).getByText('Title OPS-1')).toBeTruthy()
  })

  it('writes nothing when the card is dropped back on its own column', async () => {
    const posts = mount()
    const { dataTransfer } = await pickUp('OPS-1', 'In Review')
    fireEvent.drop(column('To Do'), { dataTransfer })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(posts).toEqual([])
  })

  it('puts the card back when the vendor refuses, and sends the write once', async () => {
    const posts = mount({ transition: () => ({ body: { available: false, code: 'unauthorized', reason: 'This tracker token is read-only.' } }) })
    const { dataTransfer } = await pickUp('OPS-1', 'In Review')
    await waitFor(() => expect(column('In Review').getAttribute('data-drop')).toBe('allowed'))
    fireEvent.drop(column('In Review'), { dataTransfer })
    await waitFor(() => expect(posts).toHaveLength(1))
    await waitFor(() => expect(within(column('To Do')).getByText('Title OPS-1')).toBeTruthy())
    expect(within(column('In Review')).queryByText('Title OPS-1')).toBeNull()
    expect(posts).toHaveLength(1)
  })

  it('refuses every column for a connection that cannot write', async () => {
    const posts = mount({ transitions: { available: true, currentStatusId: 'todo', writable: false, reason: 'This tracker token is read-only.', targets: [{ ...STATUS.review, available: true }] } })
    const { dataTransfer } = await pickUp('OPS-1', 'In Review')
    await waitFor(() => expect(column('In Review').getAttribute('data-drop')).toBe('refused'))
    fireEvent.drop(column('In Review'), { dataTransfer })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(posts).toEqual([])
  })

  it('shows the ticket where it now is after someone else moved it first', async () => {
    const posts = mount({ transition: () => ({ status: 409, body: { error: 'This issue was moved by someone else. Nothing was changed.', item: issue('OPS-1', 'done'), comments: noComments } }) })
    const { dataTransfer } = await pickUp('OPS-1', 'In Review')
    await waitFor(() => expect(column('In Review').getAttribute('data-drop')).toBe('allowed'))
    fireEvent.drop(column('In Review'), { dataTransfer })
    await waitFor(() => expect(posts).toHaveLength(1))
    // Not left in the column the user aimed for: the optimistic move is undone.
    await waitFor(() => expect(within(column('In Review')).queryByText('Title OPS-1')).toBeNull())
  })
})

describe('what the board shows while a card is in hand', () => {
  const qa = { status: 'QA', statusId: 'qa', statusCategory: 'started', available: true }

  it('adds a column for a reachable status that holds no loaded ticket, and moves the card there', async () => {
    const posts = mount({ transitions: { available: true, currentStatusId: 'todo', writable: true, targets: [{ ...STATUS.review, available: true }, qa] } })
    expect(column('QA')).toBeNull()
    const { card, dataTransfer } = await pickUp('OPS-1', 'In Review')
    await waitFor(() => expect(column('QA')).toBeTruthy())
    expect(column('QA').getAttribute('data-ghost')).toBe('')
    expect(column('QA').getAttribute('data-drop')).toBe('allowed')
    // Appended, so no existing column moves under the pointer.
    const columns = [...document.querySelectorAll('[data-slot="tracker-column"]')].map(element => element.getAttribute('aria-label'))
    expect(columns.at(-1)).toBe('QA')
    fireEvent.dragOver(column('QA'), { dataTransfer })
    fireEvent.drop(column('QA'), { dataTransfer })
    await waitFor(() => expect(posts).toEqual([{ expectedScope: trackerReadScope(association), toStatusId: 'qa', expectedStatusId: 'todo' }]))
    fireEvent.dragEnd(card)
  })

  it('shows no extra column when nothing is being dragged', async () => {
    mount({ transitions: { available: true, currentStatusId: 'todo', writable: true, targets: [qa] } })
    const { card } = await pickUp('OPS-1', 'In Review')
    await waitFor(() => expect(column('QA')).toBeTruthy())
    fireEvent.dragEnd(card)
    await waitFor(() => expect(column('QA')).toBeNull())
  })

  it('says which enabled automation a move into a column would start', async () => {
    const trigger = (targetStatusIds: string[]) => ({ events: ['issue.status_changed'], targetStatusIds, association })
    mount({ automations: [
      { id: 'a1', revision: 1, name: 'Review bot', enabled: true, kind: 'tracker', task: { prompt: 'x' }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', trackerTrigger: trigger(['review']) },
      { id: 'a2', revision: 1, name: 'Paused bot', enabled: false, kind: 'tracker', task: { prompt: 'x' }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', trackerTrigger: trigger(['review']) },
    ] })
    await pickUp('OPS-1', 'In Review')
    const hint = await waitFor(() => { const element = column('In Review').querySelector('[data-slot="tracker-column-automation"]'); expect(element).toBeTruthy(); return element! })
    expect(hint.textContent).toBe('Starts automation: Review bot')
    // Not on the column the card came from, nor on one that refuses it.
    expect(column('To Do').querySelector('[data-slot="tracker-column-automation"]')).toBeNull()
    expect(column('Done').querySelector('[data-slot="tracker-column-automation"]')).toBeNull()
  })
})

describe('moving a ticket without a pointer', () => {
  it('offers the move from a menu on the card itself', async () => {
    const posts = mount()
    await screen.findByText('Title OPS-1')
    const trigger = screen.getByRole('button', { name: 'Move OPS-1 to another status' })
    // Beside the card's link, never inside it.
    expect(trigger.closest('a')).toBeNull()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /In Review/ }))
    await waitFor(() => expect(posts).toEqual([{ expectedScope: trackerReadScope(association), toStatusId: 'review', expectedStatusId: 'todo' }]))
    await waitFor(() => expect(within(column('In Review')).getByText('Title OPS-1')).toBeTruthy())
  })

  it('offers the same move from the issue panel\'s status menu', async () => {
    const posts = mount({ path: '/tracker/OPS-1' })
    const trigger = await screen.findByRole('button', { name: /Status: To Do\. Move to another status/ })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const target = await screen.findByRole('menuitem', { name: /In Review/ })
    // A move the tracker needs more input for is shown, explained and not selectable.
    const blocked = screen.getByRole('menuitem', { name: /Done/ })
    expect(blocked.getAttribute('aria-disabled') ?? blocked.getAttribute('data-disabled')).not.toBeNull()
    expect(blocked.textContent).toContain('Complete it in Jira')
    fireEvent.click(target)
    await waitFor(() => expect(posts).toEqual([{ expectedScope: trackerReadScope(association), toStatusId: 'review', expectedStatusId: 'todo' }]))
    expect(await screen.findByRole('button', { name: /Status: In Review\./ })).toBeTruthy()
  })
})
