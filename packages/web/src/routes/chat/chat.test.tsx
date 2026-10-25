import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatProposal, RunRecord } from '@open-mercato/cezar-api-client'

import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { ShellProviders } from '@/test/shell-providers'
import { chatTasks, projectChats } from '@/lib/chat'
import { listCounts } from '@/lib/task-groups'
import { filterRunsByOrigin } from '@/lib/task-filters'
import { unreadDoneCount } from '@/lib/read-state'

import { ChatChanges, ChatRoute } from './chat'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

const run = (over: Partial<RunRecord>): RunRecord => ({
  id: 'r', title: 't', workflow: 'quick-task', task: 't', status: 'done', createdAt: '2026-10-24T10:00:00.000Z',
  tokensUsed: 0, archived: false, steps: [], ...over,
})

const OLD_CHAT = run({ id: 'c1', title: 'old chat', workflow: 'chat', kind: 'chat', worktree: false, createdAt: '2026-10-23T10:00:00.000Z' })
const NEW_CHAT = run({ id: 'c2', title: 'new chat', workflow: 'chat', kind: 'chat', worktree: false, createdAt: '2026-10-24T10:00:00.000Z', seenAt: '2026-10-24T09:00:00.000Z' })
const TASK = run({ id: 't1', title: 'add e2e', createdBy: 'chat:c2', status: 'review' })

/** Spec 2026-10-24-cockpit-chat §3: which runs are chats, which is pinned, what is theirs. */
describe('the chat on the client', () => {
  it('pins the newest unarchived chat and lists the rest under it', () => {
    const archived = run({ ...NEW_CHAT, id: 'c3', createdAt: '2026-10-25T10:00:00.000Z', archived: true })
    const { pinned, previous } = projectChats([TASK, OLD_CHAT, NEW_CHAT, archived])
    expect(pinned?.id).toBe('c2')
    expect(previous.map((chat) => chat.id)).toEqual(['c3', 'c1'])
    expect(chatTasks([TASK, OLD_CHAT], 'c2').map((task) => task.id)).toEqual(['t1'])
  })

  it('keeps chats out of every task list, count and badge', () => {
    expect(filterRunsByOrigin([TASK, NEW_CHAT], 'all').map((r) => r.id)).toEqual(['t1'])
    expect(filterRunsByOrigin([TASK, NEW_CHAT], 'regular').map((r) => r.id)).toEqual(['t1'])
    expect(listCounts([TASK, NEW_CHAT, OLD_CHAT]).active).toBe(1)
    const finished = { status: 'done' as const, finishedAt: '2026-10-24T11:00:00.000Z' }
    expect(unreadDoneCount([run({ ...OLD_CHAT, ...finished }), run({ id: 'd', ...finished })])).toBe(1)
  })

})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Sent { method: string; path: string; body?: unknown }

function stubFetch(routes: (method: string, path: string, body: unknown) => Response | undefined): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? 'GET'
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
    sent.push({ method, path, body })
    return routes(method, path, body) ?? json({ error: 'not found' }, 404)
  }))
  return sent
}

function renderAt(entry: string, element: React.ReactNode) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/chat/new" element={element} />
          <Route path="/changes" element={element} />
          <Route path="/chat/:id" element={<div data-slot="chat-probe" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('New chat', () => {
  it('sends the first message as a kind: chat run and opens it', async () => {
    const sent = stubFetch((method, path) => {
      if (method === 'GET' && path.endsWith('/runs')) return json([])
      if (method === 'POST' && path.endsWith('/runs')) return json(NEW_CHAT, 201)
      return undefined
    })
    renderAt('/chat/new', <ChatRoute fresh />)
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'make me an e2e workflow' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(document.querySelector('[data-slot="chat-probe"]')).not.toBeNull())
    expect(sent.find((r) => r.method === 'POST')?.body).toEqual({ kind: 'chat', task: 'make me an e2e workflow' })
  })
})

describe('a chat thread', () => {
  it('opens the pinned chat at /chat, with its tasks as chips and its notes in the transcript', async () => {
    stubFetch((method, path) => {
      // As the server answers: `/runs` is tasks, the chats come from `?kind=chat`.
      if (method === 'GET' && path.endsWith('/runs')) return json([TASK])
      if (method === 'GET' && path.endsWith('/runs?kind=chat')) return json([OLD_CHAT, NEW_CHAT])
      if (method === 'GET' && path.endsWith('/runs/c2')) return json(NEW_CHAT)
      if (method === 'GET' && path.includes('/runs/c2/history-context')) return json({ contextEvents: [], asOfSeq: 2 })
      if (method === 'GET' && path.includes('/runs/c2/history')) {
        return json({
          events: [
            { seq: 1, ts: '2026-10-24T10:00:00.000Z', type: 'user-message', text: 'add an e2e workflow' },
            { seq: 2, ts: '2026-10-24T10:01:00.000Z', type: 'note', message: 'task t1 "add e2e" reached review', taskId: 't1' },
          ],
          itemCount: 2, liveCursor: 'c', asOfSeq: 2, hasOlder: false,
        })
      }
      return undefined
    })
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/chat']}>
          <ShellProviders>
            <Routes>
              <Route path="/chat" element={<ChatRoute />} />
            </Routes>
          </ShellProviders>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'new chat' })).toBeTruthy()
    const chip = document.querySelector('[data-slot="chat-task-chip"]')
    expect(chip?.textContent).toContain('add e2e')
    expect(chip?.getAttribute('href')).toBe('/tasks/t1')
    expect(await screen.findByText('add an e2e workflow')).toBeTruthy()
  })
})

describe('the chat\'s Changes', () => {
  const proposal = (path: string, over: Partial<ChatProposal> = {}): ChatProposal => ({ path, status: 'added', diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,1 @@\n+name: e2e\n`, ...over })

  function stubProposals(proposals: ChatProposal[]): Sent[] {
    return stubFetch((method, path) => {
      if (method === 'GET' && path.endsWith('/repo/proposals/c2')) return json({ proposals })
      if (method === 'POST' && path.endsWith('/repo/proposals/c2/apply')) return json({ applied: proposals.map((p) => p.path), sha: 'abcdef1234567' })
      if (method === 'POST' && path.endsWith('/repo/proposals/c2/discard')) return json({ discarded: proposals.map((p) => p.path) })
      return undefined
    })
  }

  it('shows each proposal as a diff against the live file, and Apply & commit is the owner\'s one click', async () => {
    const sent = stubProposals([proposal('.ai/cezar/workflows/e2e.yaml'), proposal('.ai/cezar/mcp.json', { status: 'unchanged' })])
    renderAt('/changes', <ChatChanges chatId="c2" />)
    expect(await screen.findByText('.ai/cezar/workflows/e2e.yaml')).toBeTruthy()
    expect(screen.queryByText('.ai/cezar/mcp.json')).toBeNull()
    expect(document.querySelector('[data-slot="chat-change-diff"]')?.textContent).toContain('+name: e2e')
    fireEvent.click(screen.getByRole('button', { name: 'Apply & commit' }))
    await waitFor(() => expect(sent.some((r) => r.path.endsWith('/repo/proposals/c2/apply'))).toBe(true))
    expect(sent.find((r) => r.path.endsWith('/apply'))?.body).toEqual({})
  })

  it('discards only after a confirm', async () => {
    const sent = stubProposals([proposal('.ai/cezar/workflows/e2e.yaml')])
    renderAt('/changes', <ChatChanges chatId="c2" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(sent.some((r) => r.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1 proposal' }))
    await waitFor(() => expect(sent.some((r) => r.path.endsWith('/repo/proposals/c2/discard'))).toBe(true))
  })

  it('says so when the chat proposes nothing', async () => {
    stubProposals([])
    renderAt('/changes', <ChatChanges chatId="c2" />)
    expect(await screen.findByText('The chat proposes nothing right now.')).toBeTruthy()
  })
})
