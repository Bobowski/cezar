import { EditorView } from '@codemirror/view'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, CodeSearchMatch, HealthResponse, WorktreeEntry } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { checkoutRuns, CodeRoute } from './code'
import { groupMatches } from './code-panel'

beforeEach(() => {
  window.localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

const health = (fileEdit: boolean): HealthResponse => ({
  version: '0.0.0-test', projects: [], bootProject: 'default', repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' }, checks: [], defaultRunner: 'claude',
  forge: { kind: 'github', available: false },
  capabilities: { localHandoff: true, terminal: false, preview: true, designMode: true, fileEdit, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
} as HealthResponse)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const entry = (path: string, content: string, hash: string): WorktreeEntry => ({ type: 'file', path, size: content.length, binary: false, tooLarge: false, content, hash, editable: true })

interface Sent { method: string; path: string; body?: unknown }

function setup(options: { fileEdit?: boolean; at?: string; disk?: { content: string; hash: string }; putStatus?: number } = {}) {
  const disk = options.disk ?? { content: 'one\n', hash: 'h1' }
  const sent: Sent[] = []
  const state = { disk, putStatus: options.putStatus ?? 200 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? 'GET'
    sent.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    if (path === '/api/v1/health') return json(health(options.fileEdit ?? true))
    if (path === '/api/v1/repo/tree') return json({ paths: ['README.md', 'src/app.ts'], truncated: false })
    if (path === '/api/v1/repo/changes') return json({ files: [{ path: 'src/app.ts', status: 'modified', adds: 1, dels: 0, binary: false, patch: '' }], stat: { files: 1, adds: 1, dels: 0 } })
    if (path === '/api/v1/repo/watch') return json({ topic: null })
    if (path === '/api/v1/runs') return json([])
    if (method === 'GET' && path.startsWith('/api/v1/repo/files?path=')) return json(entry('src/app.ts', state.disk.content, state.disk.hash))
    if (method === 'PUT' && path.startsWith('/api/v1/repo/files?path=')) {
      if (state.putStatus !== 200) return json({ error: 'file changed on disk since it was read' }, state.putStatus)
      return json({ path: 'src/app.ts', size: 4, hash: 'h2' })
    }
    return json({})
  }))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[options.at ?? '/code/src/app.ts']}>
        <Routes>
          <Route path="/code" element={<CodeRoute />} />
          <Route path="/code/*" element={<CodeRoute />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { sent, state }
}

const view = async () => {
  await waitFor(() => expect(document.querySelector('[data-slot="code-mirror"]')).not.toBeNull())
  return EditorView.findFromDOM(document.querySelector('[data-slot="code-mirror"]') as HTMLElement)!
}
const type = async (text: string) => { const editor = await view(); act(() => editor.dispatch({ changes: { from: 0, insert: text } })) }
const status = () => document.querySelector('[data-slot="code-status"]')?.textContent ?? ''

describe('Code page (spec 2026-10-11-code-page)', () => {
  it('opens the file the URL names, marks changed files in the tree, and is clean', async () => {
    setup()
    expect((await view()).state.sliceDoc()).toBe('one\n')
    expect(screen.getByRole('tab', { name: /app\.ts/ }).getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(status()).toContain('Saved'))
    // The path to the open file is expanded, so its row — and its mark — is already there.
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-file"][data-path="src/app.ts"] [data-slot="repo-files-mark"]')?.textContent).toBe('M'))
  })

  it('saves on Ctrl/Cmd+S with the hash the file was read with, and nothing before that', async () => {
    const { sent } = setup()
    await type('zero\n')
    await waitFor(() => expect(status()).toContain('Unsaved changes'))
    expect(screen.getByRole('tab', { name: /app\.ts/ }).getAttribute('data-dirty')).toBe('true')
    expect(sent.some((request) => request.method === 'PUT')).toBe(false)
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(status()).toContain('Saved'))
    expect(sent.find((request) => request.method === 'PUT')?.body).toEqual({ content: 'zero\none\n', baseHash: 'h1' })
    // The typing survived only as long as it was unsaved.
    expect(window.localStorage.getItem('cez:code:draft::main:src/app.ts')).toBeNull()
  })

  it('a refused save re-reads disk and raises the banner; Reload drops the edits', async () => {
    const { state } = setup({ putStatus: 409 })
    await type('mine ')
    state.disk = { content: 'theirs\n', hash: 'h9' }
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    const banner = await screen.findByText('This file changed on disk while you were editing it.')
    expect(banner).toBeTruthy()
    expect((await view()).state.sliceDoc()).toBe('mine one\n')
    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }))
    await waitFor(() => expect(document.querySelector('[data-slot="code-conflict"]')).toBeNull())
    expect((await view()).state.sliceDoc()).toBe('theirs\n')
  })

  it('Overwrite saves the edits against the version now on disk', async () => {
    const { sent, state } = setup({ putStatus: 409 })
    await type('mine ')
    state.disk = { content: 'theirs\n', hash: 'h9' }
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await screen.findByText('This file changed on disk while you were editing it.')
    state.putStatus = 200
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))
    await waitFor(() => expect(sent.filter((request) => request.method === 'PUT').at(-1)?.body).toEqual({ content: 'mine one\n', baseHash: 'h9' }))
    await waitFor(() => expect(document.querySelector('[data-slot="code-conflict"]')).toBeNull())
  })

  it('keeps unsaved typing across a reload of the page', async () => {
    setup()
    await type('draft ')
    await waitFor(() => expect(status()).toContain('Unsaved changes'))
    cleanup()
    setup()
    expect((await view()).state.sliceDoc()).toBe('draft one\n')
    await waitFor(() => expect(status()).toContain('Unsaved changes'))
  })

  it('opens read-only, with the reason, where file editing is off', async () => {
    const { sent } = setup({ fileEdit: false })
    await view()
    await waitFor(() => expect(status()).toContain('Read-only: file editing is off on this cockpit'))
    expect(screen.queryByRole('button', { name: 'New file' })).toBeNull()
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(sent.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('goes to a file by name with Ctrl/Cmd+P', async () => {
    setup({ at: '/code' })
    await screen.findByText(/Pick a file from the tree/)
    fireEvent.keyDown(window, { key: 'p', metaKey: true })
    const input = await waitFor(() => {
      const found = document.querySelector('[data-slot="code-quick-open"] input')
      expect(found).not.toBeNull()
      return found as HTMLInputElement
    })
    fireEvent.change(input, { target: { value: 'app' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((await view()).state.sliceDoc()).toBe('one\n')
  })

  it('offers only tasks that still have a worktree, and groups search results by file', () => {
    const runs = [{ id: 'a', worktreePath: '/w/a', archived: false }, { id: 'b', archived: false }, { id: 'c', worktreePath: '/w/c', archived: true }] as ApiRun[]
    expect(checkoutRuns(runs).map((run) => run.id)).toEqual(['a'])
    expect(checkoutRuns(undefined)).toEqual([])
    const matches: CodeSearchMatch[] = [{ path: 'a.ts', line: 1, text: 'x' }, { path: 'b.ts', line: 2, text: 'x' }, { path: 'a.ts', line: 9, text: 'x' }]
    expect(groupMatches(matches)).toEqual([{ path: 'a.ts', matches: [matches[0], matches[2]] }, { path: 'b.ts', matches: [matches[1]] }])
  })
})
