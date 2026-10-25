import { EditorView } from '@codemirror/view'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryScope, setApiScope, type ApiRun, type CodeSearchMatch, type HealthResponse, type WorktreeEntry } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { ShellWithSidebar } from '@/test/shell-with-sidebar'

import { checkoutRuns, CodeRoute } from './code'
import { groupMatches } from './code-sidebar'

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

const health = (fileEdit: boolean, terminal = false, preview = true): HealthResponse => ({
  version: '0.0.0-test', projects: [], bootProject: 'default', repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' }, checks: [], defaultRunner: 'claude',
  forge: { kind: 'github', available: false },
  capabilities: { localHandoff: true, terminal, preview, designMode: true, fileEdit, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
} as HealthResponse)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const entry = (path: string, content: string, hash: string): WorktreeEntry => ({ type: 'file', path, size: content.length, binary: false, tooLarge: false, content, hash, editable: true })

const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-zero\n+one\n'

interface Sent { method: string; path: string; body?: unknown }

const RUN = { id: 'run-1', task: 'Fix the header', title: 'Fix the header', status: 'done', archived: false, createdAt: '2026-10-12T10:00:00Z', worktreePath: '/w/run-1', workflow: 'quick-task' } as unknown as ApiRun

function setup(options: {
  fileEdit?: boolean; at?: string; disk?: { content: string; hash: string }; putStatus?: number; runs?: ApiRun[]
  /** What `GET /ui-state` answers; `terminal` turns the capability on; `dead`: addresses nothing listens at. */
  uiState?: unknown; terminal?: boolean; services?: unknown; dead?: string[]
  /** Held until it settles: the `GET` and the `PUT` of `/ui-state`. */
  uiStateRead?: Promise<void>; uiStateWrite?: Promise<void>
  /** A hosted cockpit, whose loopback pages go through the preview gateway. */
  hosted?: boolean
} = {}) {
  const disk = options.disk ?? { content: 'one\n', hash: 'h1' }
  const sent: Sent[] = []
  const state = { disk, putStatus: options.putStatus ?? 200 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? 'GET'
    sent.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    if (path === '/api/v1/health') return json(health(options.fileEdit ?? true, options.terminal ?? false, options.hosted !== true))
    if (options.dead?.includes(path)) throw new TypeError('Failed to fetch')
    if (method === 'GET' && path === '/api/v1/ui-state') { await options.uiStateRead; return json(options.uiState ?? {}) }
    if (method === 'PUT' && path === '/api/v1/ui-state') { await options.uiStateWrite; return json({ ...(options.uiState as object | undefined), ...(JSON.parse(String(init.body)) as object) }) }
    if (path === '/api/v1/services') return json(options.services ?? { available: false, reason: null, services: [], candidates: [], lastRunning: [], topic: 'services' })
    if (path === '/api/v1/repo/tree') return json({ paths: ['README.md', 'src/app.ts'], truncated: false })
    if (path === '/api/v1/repo/changes') return json({ files: [{ path: 'src/app.ts', status: 'modified', adds: 1, dels: 0, binary: false, patch: PATCH }], stat: { files: 1, adds: 1, dels: 0 } })
    if (path === '/api/v1/repo') return json({ info: { root: '/repo', branch: 'main' }, status: [], log: [], branches: ['main'], baseBranch: null })
    if (path === '/api/v1/repo/watch') return json({ topic: null })
    if (method === 'POST' && path === '/api/v1/preview/design-proxy') return json({ origin: 'http://127.0.0.1:47000' })
    if (method === 'POST' && path === '/api/v1/preview/gateway') return json({ origin: 'http://cockpit.test:47100', ticket: 't1', ticketParam: 'cez_ticket' })
    // Any project's list: a test that moves to another project still gets one back.
    if (method === 'GET' && /^\/api\/v1(\/p\/[^/]+)?\/runs$/.test(path)) return json(options.runs ?? [])
    if (method === 'POST' && path === '/api/v1/runs') return json({ ...RUN, id: 'new-run', task: (JSON.parse(String(init.body)) as { task: string }).task }, 201)
    if (path === '/api/v1/workflows') return json({ workflows: [], issues: [] })
    if (method === 'GET' && path.startsWith('/api/v1/repo/files?path=')) return json(entry('src/app.ts', state.disk.content, state.disk.hash))
    if (method === 'PUT' && path.startsWith('/api/v1/repo/files?path=')) {
      if (state.putStatus !== 200) return json({ error: 'file changed on disk since it was read' }, state.putStatus)
      return json({ path: 'src/app.ts', size: 4, hash: 'h2' })
    }
    return json({})
  }))
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[options.at ?? '/code/src/app.ts']}>
        <ShellWithSidebar>
          <Routes>
            <Route path="/code" element={<CodeRoute />} />
            <Route path="/code/*" element={<CodeRoute />} />
          </Routes>
        </ShellWithSidebar>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { sent, state, client }
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
    expect(document.querySelector('[data-slot="code-tab"]')?.getAttribute('data-dirty')).toBe('true')
    expect(sent.some((request) => request.method === 'PUT')).toBe(false)
    expect(window.localStorage.getItem(`cez:code:draft:${queryScope()}:main:src/app.ts`)).toContain('zero')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(status()).toContain('Saved'))
    expect(sent.find((request) => request.method === 'PUT')?.body).toEqual({ content: 'zero\none\n', baseHash: 'h1' })
    // The typing survived only as long as it was unsaved.
    expect(window.localStorage.getItem(`cez:code:draft:${queryScope()}:main:src/app.ts`)).toBeNull()
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
    expect(screen.queryByRole('button', { name: 'New File…' })).toBeNull()
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(sent.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('goes to a file by name with Ctrl/Cmd+P', async () => {
    setup({ at: '/code' })
    await screen.findByText(/Pick a file in the explorer/)
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

describe('Code page as an editor (VS Code-like)', () => {
  const groups = () => [...document.querySelectorAll('[data-slot="code-group"]')]
  const tabsOf = (index: number) => [...(groups()[index]?.querySelectorAll('[data-slot="code-tab"]') ?? [])].map((tab) => tab.textContent)
  /** Radix tabs activate on mouse DOWN, as a real tab strip does. */
  const pickTab = (name: string | RegExp) => fireEvent.mouseDown(screen.getByRole('tab', { name }))
  const menuItem = async (label: string) => waitFor(() => {
    const item = [...document.querySelectorAll('[data-slot="code-context-menu"] [role=menuitem]')].find((each) => each.textContent?.startsWith(label))
    expect(item, label).toBeTruthy()
    return item as HTMLElement
  })

  it('shows the branch, the cursor and the language in the status bar, and a change strip in the gutter', async () => {
    setup()
    const editor = await view()
    await waitFor(() => expect(document.querySelector('[data-slot="code-cursor"]')?.textContent).toBe('Ln 1, Col 1'))
    expect(document.querySelector('[data-slot="code-language"]')?.textContent).toBe('TypeScript')
    await waitFor(() => expect(status()).toContain('main'))
    act(() => editor.dispatch({ selection: { anchor: 0, head: 3 } }))
    expect(document.querySelector('[data-slot="code-cursor"]')?.textContent).toBe('Ln 1, Col 4 (3 selected)')
    // Line 1 replaced a deleted line, per the file's diff.
    await waitFor(() => expect((document.querySelector('.cm-change-mark') as HTMLElement | null)?.dataset.mark).toBe('mod'))
  })

  it('puts the explorer, search and source control in the screen\'s contextual sidebar', async () => {
    setup()
    await view()
    const body = document.querySelector('[data-slot="context-sidebar-body"]') as HTMLElement
    const head = () => body.querySelector('[data-slot="code-sidebar"]')
    expect(head()?.getAttribute('data-view')).toBe('explorer')
    expect(body.querySelector('[data-slot="code-explorer"]')).not.toBeNull()
    pickTab('Source Control')
    expect(head()?.getAttribute('data-view')).toBe('scm')
    await waitFor(() => expect(body.querySelector('[data-slot="code-scm-count"]')?.textContent).toBe('1'))
    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    expect(body.querySelector('[data-slot="code-search"]')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'e', metaKey: true, shiftKey: true })
    expect(head()?.getAttribute('data-view')).toBe('explorer')
  })

  it('opens a changed file\'s diff from Source Control, in a tab named after it', async () => {
    setup()
    await view()
    pickTab('Source Control')
    fireEvent.click(await screen.findByTitle('src/app.ts — Modified'))
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'app.ts (Working Tree)']))
    expect(document.querySelector('[data-slot="code-breadcrumbs"]')?.textContent).toContain('changes since the last commit')
  })

  it('splits the editor to the right, and closes the second group with its last tab', async () => {
    setup()
    await view()
    fireEvent.keyDown(window, { key: '\\', metaKey: true })
    await waitFor(() => expect(groups()).toHaveLength(2))
    expect(tabsOf(1)).toEqual(['app.ts'])
    expect(groups()[1]?.getAttribute('data-focused')).toBe('true')
    // One buffer behind both views: typing in one is the other's text too.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="code-mirror"]')).toHaveLength(2))
    const second = EditorView.findFromDOM(document.querySelectorAll('[data-slot="code-mirror"]')[1] as HTMLElement)!
    act(() => second.dispatch({ changes: { from: 0, insert: 'x' } }))
    await waitFor(() => expect(EditorView.findFromDOM(document.querySelectorAll('[data-slot="code-mirror"]')[0] as HTMLElement)!.state.sliceDoc()).toBe('xone\n'))
    fireEvent.click(groups()[1]!.querySelector('[aria-label="Close app.ts"]')!)
    await waitFor(() => expect(groups()).toHaveLength(1))
  })

  it('offers the explorer menu on a right click: open to the side, copy path, rename, delete', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', clipboard: { writeText } })
    setup({ at: '/code' })
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-file"][data-path="README.md"]')).not.toBeNull())
    fireEvent.contextMenu(document.querySelector('[data-slot="repo-files-file"][data-path="README.md"]')!)
    const labels = async () => waitFor(() => {
      const found = [...document.querySelectorAll('[data-slot="code-context-menu"] [role=menuitem]')].map((item) => item.textContent)
      expect(found.length).toBeGreaterThan(0)
      return found
    })
    expect(await labels()).toEqual(['Open', 'Open to the Side', 'New File…', 'New Folder…', 'Copy Path', 'Copy Relative Path', 'Rename…', 'Delete'])
    fireEvent.click(await menuItem('Copy Path'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/repo/README.md'))
    expect(document.querySelector('[data-slot="code-context-menu"]')).toBeNull()
    fireEvent.contextMenu(document.querySelector('[data-slot="repo-files-file"][data-path="README.md"]')!)
    fireEvent.click(await menuItem('Open to the Side'))
    await waitFor(() => expect(groups()).toHaveLength(2))
  })

  it('closes the other tabs from a tab\'s menu, keeping one with unsaved edits', async () => {
    window.localStorage.setItem(`cez:code:layout:${queryScope()}:main`, JSON.stringify({ groups: [{ tabs: [{ path: 'README.md', preview: false }, { path: 'src/app.ts', preview: false }, { path: 'src/b.ts', preview: false }], active: 'src/app.ts' }], focused: 0 }))
    setup()
    await type('dirty ')
    await waitFor(() => expect(status()).toContain('Unsaved changes'))
    pickTab(/README\.md/)
    await waitFor(() => expect(screen.getByRole('tab', { name: /README\.md/ }).getAttribute('aria-selected')).toBe('true'))
    fireEvent.contextMenu(screen.getByRole('tab', { name: /README\.md/ }).closest('[data-slot="code-tab"]')!)
    fireEvent.click(await menuItem('Close Others'))
    // `b.ts` goes; `app.ts` has unsaved edits and nothing asked, so it stays.
    await waitFor(() => expect(tabsOf(0)).toEqual(['README.md', 'app.ts']))
  })

  it('lists commands in the palette and runs the one picked', async () => {
    setup()
    await view()
    fireEvent.keyDown(window, { key: 'P', metaKey: true, shiftKey: true })
    const input = await waitFor(() => {
      const found = document.querySelector('[data-slot="code-command-palette"] input')
      expect(found).not.toBeNull()
      return found as HTMLInputElement
    })
    fireEvent.change(input, { target: { value: 'word wrap' } })
    expect([...document.querySelectorAll('[data-slot="code-command-palette"] [role=option]')].map((option) => option.textContent)).toEqual([expect.stringContaining('View: Toggle Word Wrap')])
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(status()).toContain('Wrap'))
  })

  it('renders a Markdown file as a document on request, and back', async () => {
    setup({ at: '/code/README.md' })
    await view()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Markdown Preview' }))
    await waitFor(() => expect(document.querySelector('[data-slot="code-markdown"]')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'v', metaKey: true, shiftKey: true })
    await waitFor(() => expect(document.querySelector('[data-slot="code-markdown"]')).toBeNull())
  })

  it('puts a draggable border between editor groups', async () => {
    setup()
    await view()
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
    fireEvent.keyDown(window, { key: '\\', metaKey: true })
    await waitFor(() => expect(groups()).toHaveLength(2))
    expect(screen.getByRole('separator', { name: 'Resize editor groups 1 and 2' })).toBeTruthy()
    // The library owns the drag; the page owns which panels exist.
    expect(document.querySelectorAll('[data-panel-id^="code-group-"]')).toHaveLength(2)
  })

  it('opens a browser as a tab beside the code, named after its address', async () => {
    setup()
    await view()
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }))
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'Browser']))
    expect(document.querySelector('[data-slot="code-browser"]')).not.toBeNull()
    // The file's editor is gone from this group while the browser tab is the active one.
    expect(document.querySelector('[data-slot="code-cursor"]')).toBeNull()
    pickTab(/app\.ts/)
    await view()
  })

  it('opens the agent as a tab, like a file, and starts a task from it with the last file as context', async () => {
    const { sent } = setup({ runs: [RUN] })
    await view()
    expect(document.querySelector('[data-slot="code-agent"]')).toBeNull()
    fireEvent.keyDown(window, { key: 'l', metaKey: true })
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'New task']))
    const pane = document.querySelector('[data-slot="code-group"] [data-slot="code-agent"]') as HTMLElement
    expect(pane).not.toBeNull()
    // A shadcn Select, not a native one (Radix keeps a hidden native twin for forms only).
    expect(pane.querySelector('select:not([aria-hidden])')).toBeNull()
    expect(pane.querySelector('[data-slot="select-trigger"][aria-label="Task"]')?.textContent).toContain('New task…')
    fireEvent.change(pane.querySelector('textarea')!, { target: { value: 'Rename the greeting' } })
    fireEvent.click(pane.querySelector('button[type=submit]')!)
    await waitFor(() => expect(sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body).toEqual({
      workflow: 'quick-task',
      task: 'Rename the greeting\n\nThe file open in my editor: src/app.ts',
    }))
  })

  it('names an agent tab after the task it shows, and does not open the same task twice', async () => {
    window.localStorage.setItem(`cez:code:layout:${queryScope()}:main`, JSON.stringify({
      groups: [{ tabs: [{ path: 'src/app.ts', preview: false }, { path: 'agent:g1', preview: false }], active: 'agent:g1' }], focused: 0, agents: { g1: 'run-1' },
    }))
    setup({ runs: [RUN], at: '/code' })
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'Fix the header']))
    expect(document.querySelector('[data-slot="code-sidebar"] [data-slot="select-trigger"][aria-label="Checkout"]')?.textContent).toContain('Main checkout')
  })

  it('goes full screen with its sidebar, and back', async () => {
    const request = vi.fn(async () => {})
    document.documentElement.requestFullscreen = request
    setup()
    await view()
    const body = document.querySelector('[data-slot="context-sidebar-body"]') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: 'Toggle full screen' }))
    expect(document.querySelector('[data-route="code"]')?.getAttribute('data-fullscreen')).toBe('true')
    expect(request).not.toHaveBeenCalled()
    // The shell is covered, so the explorer moves into the page.
    expect(body.querySelector('[data-slot="code-explorer"]')).toBeNull()
    expect(document.querySelector('[data-route="code"] [data-slot="code-explorer"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle full screen' }))
    expect(document.querySelector('[data-route="code"]')?.getAttribute('data-fullscreen')).toBeNull()
    expect(body.querySelector('[data-slot="code-explorer"]')).not.toBeNull()
  })

  it('F11 is the page’s full-screen region: in on the key, out on Esc (cockpit-polish §3.3)', async () => {
    document.documentElement.requestFullscreen = vi.fn(async () => {})
    setup()
    await view()
    fireEvent.keyDown(window, { key: 'F11' })
    expect(document.querySelector('[data-route="code"]')?.getAttribute('data-fullscreen')).toBe('true')
    expect(document.querySelector('[data-route="code"]')?.getAttribute('data-fullscreen-region')).toBe('Code')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[data-route="code"]')?.getAttribute('data-fullscreen')).toBeNull()
  })

  it('hides and shows its sidebar in full screen, where the shell\'s own is covered', async () => {
    document.documentElement.requestFullscreen = vi.fn(async () => {})
    setup()
    await view()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle full screen' }))
    const inline = () => document.querySelector('[data-route="code"] [data-slot="code-explorer"]')
    expect(inline()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(inline()).toBeNull()
    fireEvent.keyDown(window, { key: 'b', metaKey: true })
    expect(inline()).not.toBeNull()
    // Asking for a view brings a hidden sidebar back with it.
    fireEvent.keyDown(window, { key: 'b', metaKey: true })
    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    expect(document.querySelector('[data-route="code"] [data-slot="code-search"]')).not.toBeNull()
  })

  it('gives a browser tab no tab strip of its own: one tab, one page', async () => {
    setup()
    await view()
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }))
    await waitFor(() => expect(document.querySelector('[data-slot="code-browser"] [data-slot="browser-view"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="code-browser"] [data-slot="browser-tab"]')).toBeNull()
    // A second page is a second browser tab beside it.
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }))
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'Browser', 'Browser']))
  })

  const drag = (types: Record<string, string>) => ({ dataTransfer: { types: Object.keys(types), getData: (type: string) => types[type] ?? '', setData: vi.fn(), dropEffect: 'none', effectAllowed: 'all' } })

  it('moves a file dragged onto a folder, after asking', async () => {
    const { sent } = setup({ at: '/code' })
    const row = await waitFor(() => {
      const found = document.querySelector('[data-slot="repo-files-file"][data-path="README.md"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(row.getAttribute('draggable')).toBe('true')
    const folder = document.querySelector('[data-slot="repo-files-dir"][data-path="src"]') as HTMLElement
    const carried = drag({ 'application/x-cezar-file': 'README.md' })
    fireEvent.dragOver(folder, carried)
    expect(folder.getAttribute('data-drop-target')).toBe('true')
    fireEvent.drop(folder, carried)
    expect(sent.some((request) => request.method === 'POST')).toBe(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }))
    await waitFor(() => expect(sent.find((request) => request.path === '/api/v1/repo/files/rename')?.body).toEqual({ from: 'README.md', to: 'src/README.md' }))
  })

  it('opens a file dropped on an editor group, and moves a tab dropped from another group', async () => {
    setup()
    await view()
    fireEvent.keyDown(window, { key: '\\', metaKey: true })
    await waitFor(() => expect(groups()).toHaveLength(2))
    fireEvent.drop(groups()[0]!, drag({ 'application/x-cezar-file': 'README.md' }))
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'README.md']))
    fireEvent.drop(groups()[1]!, drag({ 'application/x-cezar-tab': JSON.stringify({ tab: 'README.md', from: 0 }) }))
    await waitFor(() => expect(tabsOf(1)).toEqual(['app.ts', 'README.md']))
    expect(tabsOf(0)).toEqual(['app.ts'])
  })
})

describe('Browser tabs as pages (spec 2026-10-24-code-page-browser-tabs)', () => {
  const groups = () => [...document.querySelectorAll('[data-slot="code-group"]')]
  const tabsOf = (index: number) => [...(groups()[index]?.querySelectorAll('[data-slot="code-tab"]') ?? [])].map((tab) => tab.textContent)
  const address = () => document.querySelector('[data-slot="code-browser"] input[aria-label="Address"]') as HTMLInputElement | null
  const SAVED = { codePages: [{ tree: 'main', pages: [{ id: 'b1', url: 'http://localhost:3000/admin', group: 0 }, { id: 'b2', url: 'http://localhost:3000/', group: 1 }] }] }

  it('opens a page on Ctrl/Cmd+T with the cursor in its address bar, and one beside on Ctrl/Cmd+Shift+T', async () => {
    setup()
    await view()
    fireEvent.keyDown(window, { key: 't', ctrlKey: true })
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'Browser']))
    await waitFor(() => expect(document.activeElement).toBe(address()))
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(groups()).toHaveLength(2))
    expect(tabsOf(1)).toEqual(['Browser'])
    await waitFor(() => expect(document.activeElement).toBe(groups()[1]?.querySelector('input[aria-label="Address"]')))
  })

  it('shows the shortcut that works where it runs: Alt+T in a browser, Ctrl+T in the desktop shell', async () => {
    const shortcuts = async () => {
      fireEvent.keyDown(window, { key: 'F1' })
      await waitFor(() => expect(document.querySelector('[data-slot="code-command-palette"]')).not.toBeNull())
      const options = [...document.querySelectorAll('[role=option]')].map((option) => option.textContent ?? '')
      return [options.find((text) => text.startsWith('Browser: New Page to the Side')), options.find((text) => text.startsWith('Browser: New Page') && !text.includes('Side'))]
    }
    setup()
    await view()
    expect(await shortcuts()).toEqual(['Browser: New Page to the SideAlt+Shift+T', 'Browser: New PageAlt+T'])
    cleanup()
    vi.stubGlobal('__CEZ_DESKTOP__', true)
    setup()
    await view()
    expect(await shortcuts()).toEqual(['Browser: New Page to the SideCtrl+Shift+T', 'Browser: New PageCtrl+T'])
  })

  it('leaves Alt+T to the terminal panel while it has focus', async () => {
    setup({ terminal: true })
    await view()
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true })
    const panel = await waitFor(() => { const found = document.querySelector('[data-slot="code-panel"]'); expect(found).not.toBeNull(); return found as HTMLElement })
    const inside = panel.querySelector('button') as HTMLElement
    fireEvent.keyDown(inside, { key: '†', code: 'KeyT', altKey: true })
    fireEvent.keyDown(inside, { key: 'T', code: 'KeyT', altKey: true, shiftKey: true })
    expect(tabsOf(0)).toEqual(['app.ts'])
    expect(groups()).toHaveLength(1)
    // Anywhere else on the page it opens one.
    fireEvent.keyDown(window, { key: '†', code: 'KeyT', altKey: true })
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'Browser']))
  })

  it('refuses an address that is not the project\'s app, inline, with a way to open it in the browser', async () => {
    setup()
    await view()
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }))
    const input = await waitFor(() => { expect(address()).not.toBeNull(); return address() as HTMLInputElement })
    fireEvent.change(input, { target: { value: 'https://example.com/docs' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    const refusal = await waitFor(() => { const found = document.querySelector('[data-slot="browser-refused-address"]'); expect(found).not.toBeNull(); return found as HTMLElement })
    expect(refusal.textContent).toContain('open it in your browser')
    expect(refusal.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs')
    expect(refusal.querySelector('a')?.getAttribute('rel')).toContain('noopener')
    expect([...refusal.querySelectorAll('button')].map((button) => button.textContent)).toContain('Copy address')
    expect(document.querySelector('[data-slot="code-browser"] iframe')).toBeNull()
    // A local address is taken.
    fireEvent.change(input, { target: { value: 'localhost:5173/admin' } })
    expect(document.querySelector('[data-slot="browser-refused-address"]')).toBeNull()
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(document.querySelector('[data-slot="code-browser"] iframe')?.getAttribute('src')).toBe('http://localhost:5173/admin'))
    // jsdom's own origin is the cockpit here: framing it in itself is refused too.
    fireEvent.change(input, { target: { value: window.location.origin } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(document.querySelector('[data-slot="browser-refused-address"]')?.textContent).toContain('That is this cockpit'))
  })

  it('brings the saved pages back on reload, side by side, and writes a closed one back', async () => {
    const { sent } = setup({ at: '/code', uiState: SAVED })
    await waitFor(() => expect(tabsOf(0)).toEqual(['localhost:3000/admin']))
    expect(tabsOf(1)).toEqual(['localhost:3000'])
    await waitFor(() => expect(document.querySelector('[data-slot="code-browser"] iframe')?.getAttribute('src')).toBe('http://localhost:3000/admin'))
    expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Close localhost:3000' }))
    await waitFor(() => expect(sent.find((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')?.body).toEqual({
      codePages: [{ tree: 'main', pages: [{ id: 'b1', url: 'http://localhost:3000/admin', group: 0 }] }],
    }))
  })

  it('writes the pages\' answer to the project they were saved for, after a move to another one', async () => {
    let answer = () => {}
    const { sent, client } = setup({ at: '/code', uiState: SAVED, uiStateWrite: new Promise<void>((resolve) => { answer = resolve }) })
    await waitFor(() => expect(tabsOf(1)).toEqual(['localhost:3000']))
    fireEvent.click(screen.getByRole('button', { name: 'Close localhost:3000' }))
    await waitFor(() => expect(sent.some((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')).toBe(true))
    const written = queryScope()
    setApiScope('elsewhere')
    try {
      await act(async () => { answer() })
      await waitFor(() => expect(client.getQueryData([written, 'ui-state'])).toMatchObject({ codePages: [{ tree: 'main', pages: [{ id: 'b1' }] }] }))
      expect((client.getQueryData(['elsewhere', 'ui-state']) as { codePages?: unknown } | undefined)?.codePages).toBeUndefined()
    } finally {
      setApiScope(null)
    }
  })

  it('forgets a page\'s gateway origin once its view is no longer shown', async () => {
    window.localStorage.setItem(`cez:code:layout:${queryScope()}:main`, JSON.stringify({
      groups: [{ tabs: [{ path: 'src/app.ts', preview: false }, { path: 'browser:b1', preview: false }], active: 'browser:b1' }],
      focused: 0,
      browsers: { b1: { url: 'http://localhost:3000/admin' } },
    }))
    setup({ at: '/code', hosted: true })
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'localhost:3000/admin → :47100']))
    fireEvent.mouseDown(screen.getByRole('tab', { name: /app\.ts/ }))
    await waitFor(() => expect(tabsOf(0)).toEqual(['app.ts', 'localhost:3000/admin']))
  })

  it('switching back to a page found answering neither asks again nor shows "Loading…"', async () => {
    window.localStorage.setItem(`cez:code:layout:${queryScope()}:main`, JSON.stringify({
      groups: [{ tabs: [{ path: 'src/app.ts', preview: false }, { path: 'browser:b1', preview: false }], active: 'browser:b1' }],
      focused: 0,
      browsers: { b1: { url: 'http://localhost:3000/admin' } },
    }))
    const { sent } = setup({ at: '/code' })
    const probes = () => sent.filter((request) => request.path === 'http://localhost:3000/admin').length
    await waitFor(() => expect(probes()).toBe(1))
    await waitFor(() => expect(document.querySelector('[data-slot="code-browser-asking"]')).toBeNull())
    fireEvent.mouseDown(screen.getByRole('tab', { name: /app\.ts/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="code-browser"]')).toBeNull())
    fireEvent.mouseDown(screen.getByRole('tab', { name: /localhost:3000/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="code-browser"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="code-browser-asking"]')).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(probes()).toBe(1)
  })

  it('sends the write it is holding when the page goes, rather than dropping it with its timer', async () => {
    const { sent } = setup({ at: '/code', uiState: SAVED })
    await waitFor(() => expect(tabsOf(1)).toEqual(['localhost:3000']))
    fireEvent.click(screen.getByRole('button', { name: 'Close localhost:3000' }))
    cleanup()
    await waitFor(() => expect(sent.find((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')?.body).toEqual({
      codePages: [{ tree: 'main', pages: [{ id: 'b1', url: 'http://localhost:3000/admin', group: 0 }] }],
    }))
  })

  it('keeps a page closed before the server\'s list arrived closed, and writes the close back', async () => {
    window.localStorage.setItem(`cez:code:layout:${queryScope()}:main`, JSON.stringify({
      groups: [{ tabs: [{ path: 'browser:b1', preview: false }, { path: 'browser:b2', preview: false }], active: 'browser:b2' }],
      focused: 0,
      browsers: { b1: { url: 'http://localhost:3000/admin' }, b2: { url: 'http://localhost:3000/' } },
      onServer: ['b1', 'b2'],
    }))
    let read = () => {}
    const { sent } = setup({ at: '/code', uiState: SAVED, uiStateRead: new Promise<void>((resolve) => { read = resolve }) })
    await waitFor(() => expect(tabsOf(0)).toEqual(['localhost:3000/admin', 'localhost:3000']))
    fireEvent.click(screen.getByRole('button', { name: 'Close localhost:3000' }))
    await waitFor(() => expect(tabsOf(0)).toEqual(['localhost:3000/admin']))
    await act(async () => { read() })
    await waitFor(() => expect(sent.find((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')?.body).toEqual({
      codePages: [{ tree: 'main', pages: [{ id: 'b1', url: 'http://localhost:3000/admin', group: 0 }] }],
    }))
    expect(groups()).toHaveLength(1)
    expect(tabsOf(0)).toEqual(['localhost:3000/admin'])
  })

  it('merges the server\'s pages: one opened here and not saved yet stays and is written, one closed elsewhere closes', async () => {
    window.localStorage.setItem(`cez:code:layout:${queryScope()}:main`, JSON.stringify({
      groups: [{ tabs: [{ path: 'browser:b1', preview: false }, { path: 'browser:b2', preview: false }, { path: 'browser:b5', preview: false }], active: 'browser:b1' }],
      focused: 0,
      browsers: { b1: { url: 'http://localhost:3000/admin' }, b2: { url: 'http://localhost:4000/' }, b5: { url: 'http://localhost:5000/x' } },
      onServer: ['b1', 'b2'],
    }))
    const { sent } = setup({ at: '/code', uiState: { codePages: [{ tree: 'main', pages: [{ id: 'b1', url: 'http://localhost:3000/admin', group: 0 }] }] } })
    await waitFor(() => expect(tabsOf(0)).toEqual(['localhost:3000/admin', 'localhost:5000/x']))
    await waitFor(() => expect(sent.find((request) => request.method === 'PUT' && request.path === '/api/v1/ui-state')?.body).toEqual({
      codePages: [{ tree: 'main', pages: [{ id: 'b1', url: 'http://localhost:3000/admin', group: 0 }, { id: 'b5', url: 'http://localhost:5000/x', group: 0 }] }],
    }))
    // The round-trip answered: b5 is now known to be on the server.
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(`cez:code:layout:${queryScope()}:main`) ?? '{}').onServer).toEqual(['b1', 'b5']))
  })

  it('lists the open pages and the detected addresses in the palette', async () => {
    const services = {
      available: true, reason: null, candidates: [], lastRunning: [], topic: 'services',
      services: [{ id: 's1', name: 'web', command: 'npm run dev', cwd: '', status: 'running', exitCode: null, reason: null, startedAt: null, topic: null,
        urls: [{ url: 'http://localhost:5173/', lastSeenAt: '2026-10-24T10:00:00Z', running: true }, { url: 'https://example.com/', lastSeenAt: '2026-10-24T10:00:00Z', running: true }] }],
    }
    setup({ at: '/code', uiState: SAVED, terminal: true, services })
    await waitFor(() => expect(tabsOf(1)).toEqual(['localhost:3000']))
    fireEvent.keyDown(window, { key: 'F1' })
    await waitFor(() => expect(document.querySelector('[data-slot="code-command-palette"]')).not.toBeNull())
    const heading = (name: string) => [...document.querySelectorAll('[cmdk-group]')].find((group) => group.querySelector('[cmdk-group-heading]')?.textContent === name)
    await waitFor(() => expect(heading('Open page')).toBeTruthy())
    expect([...heading('Pages')!.querySelectorAll('[role=option]')].map((option) => option.textContent)).toEqual(['localhost:3000/admin · group 1', 'localhost:3000 · group 2'])
    expect([...heading('Open page')!.querySelectorAll('[role=option]')].map((option) => option.textContent)).toEqual(['localhost:5173'])
    fireEvent.click(heading('Open page')!.querySelector('[role=option]')!)
    await waitFor(() => expect(tabsOf(0)).toEqual(['localhost:3000/admin', 'localhost:5173']))
  })

  it('navigating inside a page on a local cockpit keeps the view: no probe, history and Design Mode survive', async () => {
    const { sent } = setup()
    await view()
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }))
    const go = async (url: string) => {
      const input = await waitFor(() => { expect(address()).not.toBeNull(); return address() as HTMLInputElement })
      fireEvent.change(input, { target: { value: url } })
      fireEvent.submit(input.closest('form') as HTMLFormElement)
      const frame = await waitFor(() => {
        const found = document.querySelector('[data-slot="code-browser"] iframe')
        expect(found?.getAttribute('src')).toContain(new URL(url).pathname)
        return found as HTMLIFrameElement
      })
      fireEvent.load(frame)
      await waitFor(() => expect(tabsOf(0)).toContain(`localhost:5173${new URL(url).pathname}`))
    }
    await go('http://localhost:5173/a')
    const shown = document.querySelector('[data-slot="browser-view"]')
    fireEvent.click(document.querySelector('[data-slot="browser-design-toggle"]') as HTMLElement)
    await waitFor(() => expect(document.querySelector('[data-slot="browser-design-toggle"]')?.getAttribute('aria-pressed')).toBe('true'))
    await go('http://localhost:5173/b')
    expect(document.querySelector('[data-slot="browser-view"]')).toBe(shown)
    expect(document.querySelector('[data-slot="browser-design-toggle"]')?.getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false)
    // The user's own navigation is never probed.
    expect(sent.some((request) => request.path.startsWith('http://localhost:5173'))).toBe(false)
  })

  it('shows "Nothing is listening" for a saved address that no longer answers, keeping the address', async () => {
    setup({ at: '/code', uiState: { codePages: [{ tree: 'main', pages: [{ id: 'b1', url: 'http://localhost:3000/admin', group: 0 }] }] }, dead: ['http://localhost:3000/admin'] })
    const dead = await waitFor(() => { const found = document.querySelector('[data-slot="code-browser-dead"]'); expect(found).not.toBeNull(); return found as HTMLElement })
    expect(dead.textContent).toContain('Nothing is listening')
    expect(dead.textContent).toContain('http://localhost:3000/admin')
    expect(tabsOf(0)).toEqual(['localhost:3000/admin'])
    fireEvent.click(screen.getByRole('button', { name: 'Edit the address' }))
    await waitFor(() => expect(address()?.value).toBe('http://localhost:3000/admin'))
  })

  it('lays "Nothing is listening" over the mounted view, and Try again brings the page back in it', async () => {
    const dead = ['http://localhost:3000/admin']
    setup({ at: '/code', uiState: { codePages: [{ tree: 'main', pages: [{ id: 'b1', url: 'http://localhost:3000/admin', group: 0 }] }] }, dead })
    await waitFor(() => expect(document.querySelector('[data-slot="code-browser-dead"]')).not.toBeNull())
    const shown = document.querySelector('[data-slot="browser-view"]')
    expect(shown).not.toBeNull()
    dead.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(document.querySelector('[data-slot="code-browser-dead"]')).toBeNull())
    expect(document.querySelector('[data-slot="browser-view"]')).toBe(shown)
    expect(document.querySelector('[data-slot="code-browser"] iframe')?.getAttribute('src')).toBe('http://localhost:3000/admin')
  })

  it('asks a dead saved address again every 3 s, and reloads the page in place once it answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const dead = ['http://localhost:3000/admin']
      const { sent } = setup({ at: '/code', uiState: { codePages: [{ tree: 'main', pages: [{ id: 'b1', url: 'http://localhost:3000/admin', group: 0 }] }] }, dead })
      const asked = () => sent.filter((request) => request.path === 'http://localhost:3000/admin').length
      const frame = () => document.querySelector('[data-slot="code-browser"] iframe')
      await waitFor(() => expect(document.querySelector('[data-slot="code-browser-dead"]')).not.toBeNull())
      const shown = document.querySelector('[data-slot="browser-view"]')
      const before = frame()
      const first = asked()
      // Still down: asked again on its own, and still says so.
      await act(() => vi.advanceTimersByTimeAsync(3_000))
      await waitFor(() => expect(asked()).toBe(first + 1))
      expect(document.querySelector('[data-slot="code-browser-dead"]')).not.toBeNull()
      expect(frame()).toBe(before)
      // The app is up: the next ask finds it, and the page reloads in the same view.
      dead.length = 0
      await act(() => vi.advanceTimersByTimeAsync(3_000))
      await waitFor(() => expect(document.querySelector('[data-slot="code-browser-dead"]')).toBeNull())
      expect(asked()).toBe(first + 2)
      expect(document.querySelector('[data-slot="browser-view"]')).toBe(shown)
      await waitFor(() => expect(frame()).not.toBe(before))
      expect(frame()?.getAttribute('src')).toBe('http://localhost:3000/admin')
    } finally {
      vi.useRealTimers()
    }
  })
})
