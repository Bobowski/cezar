import { EditorView } from '@codemirror/view'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryScope, type ApiRun, type CodeSearchMatch, type HealthResponse, type WorktreeEntry } from '@open-mercato/cezar-api-client'
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

const health = (fileEdit: boolean): HealthResponse => ({
  version: '0.0.0-test', projects: [], bootProject: 'default', repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' }, checks: [], defaultRunner: 'claude',
  forge: { kind: 'github', available: false },
  capabilities: { localHandoff: true, terminal: false, preview: true, designMode: true, fileEdit, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
} as HealthResponse)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const entry = (path: string, content: string, hash: string): WorktreeEntry => ({ type: 'file', path, size: content.length, binary: false, tooLarge: false, content, hash, editable: true })

const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-zero\n+one\n'

interface Sent { method: string; path: string; body?: unknown }

const RUN = { id: 'run-1', task: 'Fix the header', title: 'Fix the header', status: 'done', archived: false, createdAt: '2026-10-12T10:00:00Z', worktreePath: '/w/run-1', workflow: 'quick-task' } as unknown as ApiRun

function setup(options: { fileEdit?: boolean; at?: string; disk?: { content: string; hash: string }; putStatus?: number; runs?: ApiRun[] } = {}) {
  const disk = options.disk ?? { content: 'one\n', hash: 'h1' }
  const sent: Sent[] = []
  const state = { disk, putStatus: options.putStatus ?? 200 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? 'GET'
    sent.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    if (path === '/api/v1/health') return json(health(options.fileEdit ?? true))
    if (path === '/api/v1/repo/tree') return json({ paths: ['README.md', 'src/app.ts'], truncated: false })
    if (path === '/api/v1/repo/changes') return json({ files: [{ path: 'src/app.ts', status: 'modified', adds: 1, dels: 0, binary: false, patch: PATCH }], stat: { files: 1, adds: 1, dels: 0 } })
    if (path === '/api/v1/repo') return json({ info: { root: '/repo', branch: 'main' }, status: [], log: [], branches: ['main'], baseBranch: null })
    if (path === '/api/v1/repo/watch') return json({ topic: null })
    if (method === 'GET' && path === '/api/v1/runs') return json(options.runs ?? [])
    if (method === 'POST' && path === '/api/v1/runs') return json({ ...RUN, id: 'new-run', task: (JSON.parse(String(init.body)) as { task: string }).task }, 201)
    if (path === '/api/v1/workflows') return json({ workflows: [], issues: [] })
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

  it('puts a draggable border between editor groups and beside the agent pane', async () => {
    setup()
    await view()
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
    fireEvent.keyDown(window, { key: '\\', metaKey: true })
    await waitFor(() => expect(groups()).toHaveLength(2))
    expect(screen.getByRole('separator', { name: 'Resize editor groups 1 and 2' })).toBeTruthy()
    // The library owns the drag; the page owns which panels exist.
    expect(document.querySelectorAll('[data-panel-id^="code-group-"]')).toHaveLength(2)
    fireEvent.keyDown(window, { key: 'l', metaKey: true })
    expect(await screen.findByRole('separator', { name: 'Resize agent pane' })).toBeTruthy()
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

  it('opens the agent pane, starts a task from it with the open file as context, and shows that task', async () => {
    const { sent } = setup({ runs: [RUN] })
    await view()
    expect(document.querySelector('[data-slot="code-agent"]')).toBeNull()
    fireEvent.keyDown(window, { key: 'l', metaKey: true })
    const pane = await waitFor(() => {
      const found = document.querySelector('[data-slot="code-agent"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    // Existing tasks are one pick away.
    await waitFor(() => expect([...pane.querySelectorAll('select[aria-label="Task"] option')].map((option) => option.textContent)).toEqual(['New task…', 'Fix the header']))
    fireEvent.change(pane.querySelector('textarea')!, { target: { value: 'Rename the greeting' } })
    fireEvent.click(pane.querySelector('button[type=submit]')!)
    await waitFor(() => expect(sent.find((request) => request.method === 'POST' && request.path === '/api/v1/runs')?.body).toEqual({
      workflow: 'quick-task',
      task: 'Rename the greeting\n\nThe file open in my editor: src/app.ts',
    }))
  })

  it('goes full screen with its sidebar, and back', async () => {
    const request = vi.fn(async () => {})
    document.documentElement.requestFullscreen = request
    setup()
    await view()
    const body = document.querySelector('[data-slot="context-sidebar-body"]') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: 'Toggle full screen' }))
    expect(document.querySelector('[data-route="code"]')?.getAttribute('data-fullscreen')).toBe('true')
    expect(request).toHaveBeenCalled()
    // The shell is covered, so the explorer moves into the page.
    expect(body.querySelector('[data-slot="code-explorer"]')).toBeNull()
    expect(document.querySelector('[data-route="code"] [data-slot="code-explorer"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle full screen' }))
    expect(document.querySelector('[data-route="code"]')?.getAttribute('data-fullscreen')).toBeNull()
    expect(body.querySelector('[data-slot="code-explorer"]')).not.toBeNull()
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
