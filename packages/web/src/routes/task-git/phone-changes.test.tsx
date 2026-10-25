import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, ChangesPayload } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { resetViewport, stubViewport } from '@/test/phone-viewport'

import { phoneFilePager } from './phone-changes'
import { __resetGitStepFlights } from './run-git-step'
import { TaskChangesRoute } from './task-changes'

/** Changes on a phone, at 375 px (spec 2026-10-24-mobile-cockpit §3.3, §8). */

const RUN: ApiRun = {
  id: 'r1',
  title: 'Do the thing',
  workflow: 'quick-task',
  task: 'Do it.',
  status: 'review',
  createdAt: '2026-10-24T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  worktreePath: '/tmp/wt/r1',
  branch: 'cez/abc12345',
  baseBranch: 'main',
  steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' }],
}

const CHANGES: ChangesPayload = {
  files: [
    { path: 'notes.md', status: 'added', adds: 2, dels: 0, binary: false, patch: 'diff --git a/notes.md b/notes.md\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n' },
    { path: 'src/util/a.ts', status: 'modified', adds: 1, dels: 1, binary: false, patch: 'diff --git a/src/util/a.ts b/src/util/a.ts\n--- a/src/util/a.ts\n+++ b/src/util/a.ts\n@@ -1,2 +1,2 @@\n context\n-gone\n+here\n' },
  ],
  stat: { adds: 3, dels: 1, files: 2 },
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch(run: ApiRun = RUN, config: Record<string, unknown> = {}) {
  const sent: Array<{ method: string; path: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? 'GET'
    sent.push({ method, path })
    if (method === 'GET' && path === '/api/v1/runs/r1') return json(run)
    if (method === 'GET' && path === '/api/v1/config') return json(config)
    if (method === 'GET' && path === '/api/v1/runs/r1/git/status') return json({ uncommitted: 2, unpushed: 0, behind: 0 })
    if (method === 'POST' && path === '/api/v1/runs/r1/land') return json({ outcome: 'landed', message: 'landed on main' })
    if (method === 'GET' && path === '/api/v1/runs/r1/changes') return json(CHANGES)
    if (method === 'POST' && path === '/api/v1/runs/r1/finish') return json({ ...RUN, status: 'done' })
    if (method === 'GET' && path === '/api/v1/runs') return json([])
    return json({})
  }))
  return sent
}

function renderRoute() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/r1/changes']}>
        <Routes>
          <Route path="/tasks/:id/changes" element={<TaskChangesRoute />} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => stubViewport())
afterEach(() => {
  __resetGitStepFlights()
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  resetViewport()
})

describe('phoneFilePager', () => {
  const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }]
  it('pages forward and back, and stops at both ends', () => {
    expect(phoneFilePager(files, 'a')).toEqual({ index: 0, previous: null, next: 'b' })
    expect(phoneFilePager(files, 'b')).toEqual({ index: 1, previous: 'a', next: 'c' })
    expect(phoneFilePager(files, 'c')).toEqual({ index: 2, previous: 'b', next: null })
    expect(phoneFilePager(files, null)).toEqual({ index: -1, previous: null, next: null })
    expect(phoneFilePager(files, 'gone')).toEqual({ index: -1, previous: null, next: null })
  })
})

describe('Changes at 375 px', () => {
  it('is a file list first — no tree, no all-files diff', async () => {
    stubFetch()
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-slot="phone-file"]')).toHaveLength(2))
    expect(document.querySelector('[data-slot="changes-tree-pane"]')).toBeNull()
    expect(document.querySelector('[data-slot="phone-file-view"]')).toBeNull()
  })

  it('opens one file full screen and pages with Next file / Previous file, back to the list', async () => {
    stubFetch()
    renderRoute()
    const first = await waitFor(() => {
      const rows = document.querySelectorAll<HTMLButtonElement>('[data-slot="phone-file"]')
      expect(rows).toHaveLength(2)
      return rows[0]!
    })
    fireEvent.click(first)
    const position = () => document.querySelector('[data-slot="phone-file-position"]')?.textContent
    expect(position()).toBe('1 of 2')
    expect(screen.getByRole('button', { name: /Previous file/ }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Next file/ }))
    expect(position()).toBe('2 of 2')
    expect(screen.getByRole('button', { name: /Next file/ }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Previous file/ }))
    expect(position()).toBe('1 of 2')
    fireEvent.click(document.querySelector('[data-slot="phone-file-back"]')!)
    expect(document.querySelector('[data-slot="phone-file-view"]')).toBeNull()
  })

  it('Approve asks first, then accepts the review', async () => {
    const sent = stubFetch()
    renderRoute()
    const approve = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-slot="phone-approve"]')
      expect(button).not.toBeNull()
      return button!
    })
    fireEvent.click(approve)
    expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/finish'))).toBe(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/finish')).toBe(true))
  })

  it('Discard asks first, and Not now leaves the task alone', async () => {
    const sent = stubFetch()
    renderRoute()
    const discard = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-slot="phone-discard"]')
      expect(button).not.toBeNull()
      return button!
    })
    fireEvent.click(discard)
    expect(await screen.findByText('Discard this task?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByText('Discard this task?')).toBeNull())
    expect(sent.some((r) => r.method === 'DELETE')).toBe(false)
  })

  it('Request changes brings up the composer the line comments ride with', async () => {
    stubFetch()
    renderRoute()
    const request = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-slot="phone-request-changes"]')
      expect(button).not.toBeNull()
      return button!
    })
    const composer = () => document.querySelector('textarea[aria-label]')
    expect(composer()).toBeNull()
    fireEvent.click(request)
    await waitFor(() => expect(composer()).not.toBeNull())
  })

  // An in-place trunk task in an auto-land project: the desktop's Commit to <base> step.
  const TRUNK: ApiRun = { ...RUN, status: 'waiting', worktree: false, worktreePath: undefined, branch: undefined }
  const AUTO_LAND = { landing: 'auto', landingBlocked: null, baseBranch: 'main' }
  const commitButton = () => document.querySelector<HTMLButtonElement>('[data-slot="phone-commit-base"]')
  const statusRead = (sent: Array<{ path: string }>) => sent.some((r) => r.path === '/api/v1/runs/r1/git/status')

  it('Commit to base is offered for an in-place trunk task resting in waiting, and lands it', async () => {
    const sent = stubFetch(TRUNK, AUTO_LAND)
    renderRoute()
    await waitFor(() => expect(commitButton()?.disabled).toBe(false))
    fireEvent.click(commitButton()!)
    await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/runs/r1/land')).toBe(true))
  })

  it('Commit to base stays off for a worktree task, which the server refuses to land', async () => {
    const sent = stubFetch(RUN, AUTO_LAND)
    renderRoute()
    await waitFor(() => expect(statusRead(sent)).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(commitButton()!.disabled).toBe(true)
  })

  it('Commit to base stays off for a trunk task while the agent is still working', async () => {
    const sent = stubFetch({ ...TRUNK, status: 'running' }, AUTO_LAND)
    renderRoute()
    await waitFor(() => expect(statusRead(sent)).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(commitButton()!.disabled).toBe(true)
  })
})
