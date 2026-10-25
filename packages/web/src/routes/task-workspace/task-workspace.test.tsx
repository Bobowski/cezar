import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { rememberViewState, resetViewMemory } from '@/lib/view-memory'
import { ShellProviders } from '@/test/shell-providers'
import type { ApiRun, HealthResponse } from '@open-mercato/cezar-api-client'

import { reviveState, type ViewId, type WorkspaceState } from './layout-state'

// The terminal needs xterm and a PTY; this suite is about the layout, so the view stands in and
// says how it was mounted (a column fills, the drawer docks).
vi.mock('./terminal-drawer', () => ({
  TerminalDrawer: ({ runId, fill }: { runId: string; fill?: boolean }) => (
    <section data-testid="terminal" data-run={runId} data-fill={fill ? '' : undefined} />
  ),
}))
// The Graph column lazily pulls `@xyflow/react` and its layout engine; what matters here is that
// the column mounts and says which run it was handed.
vi.mock('../workflow-graph/task-graph', () => ({
  GraphView: ({ run, embedded }: { run: { id: string }; embedded?: boolean }) => (
    <div data-testid="graph-view" data-run={run.id} data-embedded={embedded ? '' : undefined} />
  ),
}))

const { TaskWorkspaceRoute, classifyReference } = await import('./task-workspace')

/**
 * The host's layout store, as the stub sees it (spec §5.3 — layouts belong to the cezar that owns
 * the task, so a test seeds them by answering `GET /layouts` and observes them by watching what
 * the cockpit PUTs back).
 */
let hostLayouts: Record<string, unknown> = {}
/** `~/.cezar/ui-state.json`: where layouts saved for every task live (`savedLayouts`). */
let hostUiState: Record<string, unknown> = {}

beforeEach(() => {
  localStorage.clear()
  hostLayouts = {}
  hostUiState = {}
  // The strip MEASURES how many cards fit and folds the rest into its `…` menu. jsdom lays nothing
  // out, so give it a wide row: these suites are about the cards, not about the fold.
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(2000)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  hostLayouts = {}
  hostUiState = {}
  resetViewMemory()
})

const RUN: ApiRun = {
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Do the thing',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status: 'review',
  createdAt: '2026-07-15T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  worktreePath: '/tmp/wt/r1',
  branch: 'cez/abc12345',
  baseBranch: 'main',
  seenAt: '2026-07-15T09:00:00.000Z',
  steps: [
    { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' },
  ],
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  checks: [],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: { localHandoff: true, terminal: true, preview: true, designMode: true, fileEdit: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, dispatch: false },
}


/** Seed what the host already has for a task. */
function seedLayouts(runId: string, value: unknown) {
  hostLayouts[runId] = value
}

/** What the cockpit last saved for a task, revived the way a reload would read it back. */
function savedLayouts(runId: string): WorkspaceState {
  return reviveState(hostLayouts[runId] ?? null)
}

/** Fetch stub in the house style: the run, health, and empty answers for everything the embedded
 *  views ask for, so a column renders its real empty state rather than a crash. */
function stubFetch(overrides: Record<string, () => Response> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === `/api/v1/runs/${RUN.id}`) return jsonResponse(RUN)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/history`)) {
        return jsonResponse({ events: [], olderCursor: null, newerCursor: null })
      }
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/events`)) return jsonResponse([])
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/drafts`)) return jsonResponse({ surfaces: {} })
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/changes`)) {
        return jsonResponse({ files: [], stat: { adds: 0, dels: 0, files: 0 } })
      }
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/commits`)) return jsonResponse({ commits: [] })
      if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/files`)) {
        return jsonResponse({ type: 'dir', path: '', entries: [] })
      }
      const layoutsMatch = /^\/api\/v1\/runs\/([^/]+)\/layouts$/.exec(path)
      if (layoutsMatch) {
        const runId = decodeURIComponent(layoutsMatch[1]!)
        if (method === 'GET') return jsonResponse({ layouts: hostLayouts[runId] ?? null })
        if (method === 'PUT') {
          hostLayouts[runId] = JSON.parse(String(init.body ?? '{}'))
          return jsonResponse({ layouts: hostLayouts[runId] })
        }
      }
      if (path === '/api/v1/workspace/ui-state') {
        if (method === 'PUT') hostUiState = { ...hostUiState, ...JSON.parse(String(init.body ?? '{}')) }
        return jsonResponse(hostUiState)
      }
      if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([RUN])
      if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(HEALTH.repo)
      return jsonResponse({ error: `unstubbed: ${path}` }, 404)
    }),
  )
}

/** What the app shell gives the route: the query cache, and the shell's own contexts — the split
 *  button's tooltip needs the provider the sidebar mounts. */
function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <ShellProviders>{children}</ShellProviders>
    </QueryClientProvider>
  )
}

function renderWorkspace(view?: ViewId) {
  const path = view === undefined ? '/tasks/:id' : `/tasks/:id/${view}`
  const entry = view === undefined ? '/tasks/r1' : `/tasks/r1/${view}`
  return render(
    <Providers>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={path} element={<TaskWorkspaceRoute view={view} />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  )
}

/** Buttons that drive the MemoryRouter's own history, so Back and Forward are real POPs. */
function HistoryProbe() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" aria-label="go-changes" onClick={() => void navigate('/tasks/r1/changes')} />
      <button type="button" aria-label="go-r2" onClick={() => void navigate('/tasks/r2')} />
      <button type="button" aria-label="back" onClick={() => void navigate(-1)} />
      <button type="button" aria-label="forward" onClick={() => void navigate(1)} />
    </>
  )
}

/** The fixed cards of a task with no workflow graph, left to right: one per view, always there. */
const FIXED = ['Chat', 'Changes', 'Commits', 'Code', 'Browser', 'Terminal']
/** The saved layouts a task is born with — one plain card per view, each drawn as its fixed card. */
const BORN = ['Chat', 'Changes', 'Commits', 'Code', 'Browser', 'Graph']

const cards = () => Array.from(document.querySelectorAll('[data-slot="layout-card"]'))
const cardNames = () => cards().map((card) => card.textContent?.replace(/\s+/g, ' ').trim())
/** The cards of layouts the user built — the ones that can be renamed and closed. */
const builtCards = () => cards().filter((card) => !card.hasAttribute('data-fixed'))
// The view tab that shows, else the built layout the Layout menu names.
const activeCard = () =>
  document.querySelector('[data-slot="layout-card"][data-active]')?.textContent?.replace(/\s+/g, ' ').trim() ??
  document.querySelector('[data-action="layouts"][data-active-layout]')?.getAttribute('aria-label')?.replace(/^Layout: /, '') ??
  undefined
// Kept layouts stay mounted, hidden: only the one on screen counts.
const columns = () =>
  Array.from(document.querySelectorAll('[data-slot="workspace-layout"][data-active] [data-slot="workspace-column"]'))
const columnViews = () => columns().map((column) => column.getAttribute('data-view'))
const dividers = () => Array.from(document.querySelectorAll('[data-slot="column-divider"]'))
const stage = () => document.querySelector('[data-slot="workspace-stage"]')
const savedNames = (runId: string) => savedLayouts(runId).layouts.map((layout) => layout.name)
const savedViews = (runId: string, name: string) =>
  savedLayouts(runId).layouts.find((layout) => layout.name === name)?.columns.map((column) => column.view)

/** The workspace is painted once the run resolves, and usable once the host has answered with
 *  this task's layouts — which is when a card first wears the active mark. */
async function ready() {
  await waitFor(() => expect(document.querySelector('[data-route="task-workspace"]')).not.toBeNull())
  await waitFor(() => expect(activeCard()).toBeDefined())
}

/** The strip's `+`: a new, EMPTY layout, whose stage is the tile picker for its first view. */
async function newLayout() {
  fireEvent.click(screen.getByRole('button', { name: 'New layout' }))
  await waitFor(() => expect(document.querySelector('[data-slot="view-tiles-stage"]')).not.toBeNull())
}

/** Pick a view's tile — in an empty layout, or in a window that was just split off. Found by the
 *  view id, which is the hook a copy change cannot move. */
async function pickTile(view: ViewId) {
  const tile = () => document.querySelector<HTMLElement>(`[data-slot="view-tiles-stage"] [data-view="${view}"]`)
  await waitFor(() => expect(tile()).not.toBeNull())
  fireEvent.click(tile()!)
}

/** Build a two-window layout the way a user does: `+`, a tile, split, another tile. */
async function buildPair(first: ViewId, second: ViewId) {
  await newLayout()
  await pickTile(first)
  await waitFor(() => expect(columnViews()).toEqual([first]))
  fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
  await pickTile(second)
  await waitFor(() => expect(columnViews()).toEqual([first, second]))
}

describe('the task workspace (main)', () => {
  const health = (terminal: boolean): HealthResponse => ({
    version: '0.0.0-test',
    projects: [],
    bootProject: 'default',
    repoRoot: '/repo',
    repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
    checks: [],
    defaultRunner: 'claude',
    forge: { kind: 'github', available: true },
    capabilities: {
      localHandoff: true,
      terminal,
      preview: true,
      fileEdit: true,
      designMode: true,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
      followups: false,
      singleProject: false,
      automations: false,
      dispatch: false,
    },
  })


  function stubFetch({ terminal = true }: { terminal?: boolean } = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const method = init.method ?? 'GET'
        if (method === 'GET' && path === `/api/v1/runs/${RUN.id}`) return jsonResponse(RUN)
        if (method === 'GET' && path === '/api/v1/health') return jsonResponse(health(terminal))
        if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/history`)) {
          return jsonResponse({ events: [], olderCursor: null, newerCursor: null })
        }
        if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/events`)) return jsonResponse([])
        if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/drafts`)) return jsonResponse({ surfaces: {} })
        if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/changes`)) {
          return jsonResponse({ files: [], stat: { adds: 0, dels: 0, files: 0 } })
        }
        if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/commits`)) return jsonResponse({ commits: [] })
        if (method === 'GET' && path.startsWith(`/api/v1/runs/${RUN.id}/files`)) {
          return jsonResponse({ type: 'dir', path: '', entries: [] })
        }
        const layouts = /^\/api\/v1\/runs\/([^/]+)\/layouts$/.exec(path)
        if (layouts) {
          const runId = decodeURIComponent(layouts[1]!)
          if (method === 'GET') return jsonResponse({ layouts: hostLayouts[runId] ?? null })
          if (method === 'PUT') {
            hostLayouts[runId] = JSON.parse(String(init.body ?? '{}'))
            return jsonResponse({ layouts: hostLayouts[runId] })
          }
        }
        if (path === '/api/v1/workspace/ui-state') {
          if (method === 'PUT') hostUiState = { ...hostUiState, ...JSON.parse(String(init.body ?? '{}')) }
          return jsonResponse(hostUiState)
        }
        if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([RUN])
        if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(health(terminal).repo)
        return jsonResponse({ error: `unstubbed: ${path}` }, 404)
      }),
    )
  }

  function renderWorkspace(view?: ViewId) {
    const path = view === undefined ? '/tasks/:id' : `/tasks/:id/${view}`
    const entry = view === undefined ? '/tasks/r1' : `/tasks/r1/${view}`
    return render(
      <QueryClientProvider client={createQueryClient()}>
        <ShellProviders>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path={path} element={<TaskWorkspaceRoute view={view} />} />
          </Routes>
        </MemoryRouter>
      </ShellProviders>
      </QueryClientProvider>,
    )
  }

  const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, ' ').trim()
  const cardNames = () => Array.from(document.querySelectorAll('[data-slot="layout-card"]')).map(text)
  // The view tab that shows, else the saved layout the Layout menu names.
  const activeCard = () =>
    text(document.querySelector('[data-slot="layout-card"][data-active]')) ??
    document.querySelector('[data-action="layouts"][data-active-layout]')?.getAttribute('data-active-layout') ??
    undefined
  const terminalTab = () => document.querySelector<HTMLElement>('[data-slot="layout-card"][data-fixed="terminal"]')

  const openLayoutMenu = () => fireEvent.keyDown(screen.getByRole('button', { name: /^Layout/ }), { key: 'Enter' })
  const columnViews = () =>
    Array.from(document.querySelectorAll('[data-slot="workspace-layout"][data-active] [data-slot="workspace-column"]')).map((column) => column.getAttribute('data-view'))

  async function ready() {
    await waitFor(() => expect(document.querySelector('[data-route="task-workspace"]')).not.toBeNull())
    await waitFor(() => expect(activeCard()).toBeDefined())
  }

  async function pickTile(view: ViewId) {
    const tile = () => document.querySelector<HTMLElement>(`[data-slot="view-tiles-stage"] [data-view="${view}"]`)
    await waitFor(() => expect(tile()).not.toBeNull())
    fireEvent.click(tile()!)
  }

  it('opens on Chat, with the layout strip in place of the route tabs', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    // Changes second; Terminal last, as a tab that toggles the drawer.
    expect(cardNames()).toEqual(['Chat', 'Changes', 'Commits', 'Code', 'Browser', 'Terminal'])
    expect(activeCard()).toBe('Chat')
    // One strip, never both: the old route links are gone from the header.
    expect(screen.queryByRole('link', { name: 'Changes' })).toBeNull()
    // Opening the task saves nothing: the host has never been written to.
    expect(hostLayouts.r1).toBeUndefined()
  })

  it('holding ⌘ prints each tab’s number on it; a quick ⌘ press or letting go hides them', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
    stubFetch()
    renderWorkspace()
    await ready()
    const hints = () => Array.from(document.querySelectorAll('[data-slot="tab-key-hint"]')).map(text)

    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    fireEvent.keyUp(window, { key: 'Meta' })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(hints()).toEqual([])

    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    // The six views, then Notes — saved layouts are not numbered.
    await waitFor(() => expect(hints()).toEqual(['1', '2', '3', '4', '5', '6', '7']))
    fireEvent.keyUp(window, { key: 'Meta' })
    await waitFor(() => expect(hints()).toEqual([]))
    vi.unstubAllGlobals()
  })

  it('shows no tab numbers while a palette or dialog has the keyboard — ⌘N would not switch', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
    stubFetch()
    renderWorkspace()
    await ready()
    const hints = () => document.querySelectorAll('[data-slot="tab-key-hint"]').length

    // Held while a dialog is already up: nothing.
    const dialog = document.body.appendChild(Object.assign(document.createElement('div'), { role: 'dialog' }))
    dialog.setAttribute('role', 'dialog')
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(hints()).toBe(0)
    fireEvent.keyUp(window, { key: 'Meta' })
    dialog.remove()

    // Held, hints up — then ⌘K opens a palette: they go.
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true })
    await waitFor(() => expect(hints()).toBeGreaterThan(0))
    document.body.appendChild(dialog)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await waitFor(() => expect(hints()).toBe(0))
    fireEvent.keyUp(window, { key: 'Meta' })
    dialog.remove()
    vi.unstubAllGlobals()
  })

  it('off a Mac, shows no tab numbers while the terminal has focus — Ctrl chords are the shell’s there', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'Linux x86_64' })
    stubFetch()
    renderWorkspace()
    await ready()
    const hints = () => document.querySelectorAll('[data-slot="tab-key-hint"]').length
    const term = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'xterm' }))
    const helper = term.appendChild(document.createElement('textarea'))
    helper.focus()

    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(hints()).toBe(0)
    fireEvent.keyUp(window, { key: 'Control' })

    term.remove()
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    await waitFor(() => expect(hints()).toBeGreaterThan(0))
    fireEvent.keyUp(window, { key: 'Control' })
    vi.unstubAllGlobals()
  })

  it('offers no Terminal anywhere when the cockpit allows no shell', async () => {
    stubFetch({ terminal: false })
    renderWorkspace()
    await ready()

    expect(cardNames()).not.toContain('Terminal')
    expect(screen.queryByRole('button', { name: /terminal/i })).toBeNull()
    // ⌥-click splits Chat into the working arrangement; its Split view opens the tile picker.
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))
    const splits = screen.getAllByRole('button', { name: 'Split view' })
    fireEvent.click(splits[splits.length - 1]!)
    await waitFor(() => expect(document.querySelector('[data-slot="view-tiles-stage"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="view-tiles-stage"] [data-view="terminal"]')).toBeNull()
    // The Preview needs no shell: it is offered either way.
    expect(document.querySelector('[data-slot="view-tiles-stage"] [data-view="browser"]')).not.toBeNull()
  })

  it('opens the Preview deep link on the real Preview, with its saved tabs and Design Mode', async () => {
    hostLayouts.r1 = {
      layouts: [
        {
          name: 'Browser',
          columns: [{ view: 'browser', width: 100, browser: { tabs: ['http://localhost:3000/', ''], active: 1 } }],
        },
      ],
      active: 'Chat',
    }
    stubFetch()
    renderWorkspace('browser')
    await ready()

    await waitFor(() => expect(activeCard()).toBe('Browser'))
    expect(columnViews()).toEqual(['browser'])
    expect(document.querySelectorAll('[data-slot="browser-tab"]')).toHaveLength(2)
    expect(document.querySelector('[data-slot="browser-design-toggle"]')).not.toBeNull()
  })

  it('puts a terminal beside the chat in a layout, saved on the host', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))
    const splits = screen.getAllByRole('button', { name: 'Split view' })
    fireEvent.click(splits[splits.length - 1]!)
    await pickTile('terminal')
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes', 'terminal']))

    const terminal = await screen.findByTestId('terminal')
    expect(terminal.dataset.fill).toBe('')
    expect(terminal.dataset.run).toBe('r1')
    expect(terminalTab()?.hasAttribute('data-on')).toBe(true)

    await waitFor(() => {
      const saved = reviveState(hostLayouts.r1 ?? null)
      const built = saved.layouts.find((layout) => layout.name === saved.active)
      expect(built?.columns.map((column) => column.view)).toEqual(['session', 'changes', 'terminal'])
    })
  })

  it('opens the Terminal tab as a view of its own, like Preview — a click never adds it to what shows', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(terminalTab()!)
    await waitFor(() => expect(activeCard()).toBe('Terminal'))
    expect(columnViews()).toEqual(['terminal'])
    expect((await screen.findByTestId('terminal')).dataset.fill).toBe('')

    // ⌥-click is the way to put it beside a view.
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="session"]')!)
    await waitFor(() => expect(activeCard()).toBe('Chat'))
    fireEvent.click(terminalTab()!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['session', 'terminal']))

    // A column's "Move to bottom" docks the same shells as the drawer.
    fireEvent.click(screen.getByRole('button', { name: 'Move to bottom' }))
    await waitFor(() => expect(columnViews()).not.toContain('terminal'))
    expect((await screen.findByTestId('terminal')).dataset.fill).toBeUndefined()
  })

  it('drops the Terminal tab beside the view it was opened from when the Terminal itself shows', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!)
    await waitFor(() => expect(activeCard()).toBe('Changes'))
    fireEvent.click(terminalTab()!)
    await waitFor(() => expect(activeCard()).toBe('Terminal'))

    const data = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() {
        return [...data.keys()]
      },
      effectAllowed: 'all',
      dropEffect: 'none',
    }
    fireEvent.dragStart(terminalTab()!, { dataTransfer })
    const right = await waitFor(() => {
      const zones = document.querySelectorAll('[data-slot="view-drop-zones"] [data-drop-zone="insert"]')
      expect(zones.length).toBe(2)
      return zones[1]!
    })
    fireEvent.dragOver(right, { dataTransfer })
    fireEvent.drop(right, { dataTransfer })
    await waitFor(() => expect(columnViews()).toEqual(['changes', 'terminal']))

    // ⌥-click from the Terminal does the same.
    fireEvent.click(terminalTab()!)
    await waitFor(() => expect(activeCard()).toBe('Terminal'))
    fireEvent.click(terminalTab()!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['changes', 'terminal']))
  })

  it('gives a lone view its bar — the split only: no name, no view switcher, no close', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    const header = await waitFor(() => document.querySelector<HTMLElement>('[data-slot="workspace-column-header"]')!)
    expect(header.textContent).not.toContain('Chat')
    expect(header.querySelector('[data-action="split-view"]')).not.toBeNull()
    expect(header.querySelector('[data-action="change-view"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close Chat' })).toBeNull()

    // Splitting the Chat tab builds the working arrangement; the Chat tab stays one view.
    fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
    await pickTile('files')
    await waitFor(() => expect(activeCard()).toBe('Custom'))
    expect(columnViews()).toEqual(['session', 'files'])
    expect(document.querySelectorAll('[data-action="change-view"]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Close Chat' })).not.toBeNull()
  })

  it('lets one window take the screen and give it back — the thread, F11 and Esc (cockpit-polish §3.3)', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
    await pickTile('changes')
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))
    const thread = () => columns()[0] as HTMLElement
    const diff = () => columns()[1] as HTMLElement
    expect(thread().getAttribute('data-fullscreen-region')).toBe('Chat')

    fireEvent.click(within(diff()).getByRole('button', { name: 'Full screen Changes' }))
    expect(diff().getAttribute('data-fullscreen')).toBe('true')
    expect(document.documentElement.dataset.cezFullscreen).toBe('Changes')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(diff().getAttribute('data-fullscreen')).toBeNull()

    // F11 goes to the window last clicked in, with nothing focused.
    fireEvent.pointerDown(within(thread()).getByRole('button', { name: 'Full screen Chat' }))
    fireEvent.keyDown(window, { key: 'F11' })
    expect(thread().getAttribute('data-fullscreen')).toBe('true')
    expect(diff().getAttribute('data-fullscreen')).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(thread().getAttribute('data-fullscreen')).toBeNull()
    expect(document.documentElement.dataset.cezFullscreen).toBeUndefined()
  })

  it('a window closed by dropping its bar on the card strip hands its key to nobody: the full screen stays put', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
    await pickTile('changes')
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))
    fireEvent.click(within(columns()[1] as HTMLElement).getByRole('button', { name: 'Full screen Changes' }))
    expect(columns()[1]!.getAttribute('data-fullscreen')).toBe('true')

    const data = new Map<string, string>([['text/cez-column', '0']])
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() {
        return [...data.keys()]
      },
      dropEffect: 'none',
    }
    const strip = document.querySelector('[data-slot="layout-cards"]') as HTMLElement
    fireEvent.dragOver(strip, { dataTransfer })
    fireEvent.drop(strip, { dataTransfer })
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    expect(columns()[0]!.getAttribute('data-fullscreen')).toBe('true')
    expect(document.documentElement.dataset.cezFullscreen).toBe('Changes')
  })

  it('docks the drawer under any layout, and the ` key toggles it', async () => {
    stubFetch()
    renderWorkspace('changes')
    await ready()
    await waitFor(() => expect(activeCard()).toBe('Changes'))
    expect(screen.queryByTestId('terminal')).toBeNull()

    fireEvent.keyDown(window, { key: '`' })
    const drawer = await screen.findByTestId('terminal')
    expect(drawer.dataset.fill).toBeUndefined()
    // The tab is lit while the drawer is up; the view that shows stays.
    expect(terminalTab()?.hasAttribute('data-on')).toBe(true)
    expect(activeCard()).toBe('Changes')
    fireEvent.keyDown(window, { key: '`' })
    await waitFor(() => expect(screen.queryByTestId('terminal')).toBeNull())
  })

  it('folds tabs until the row stops overflowing, so the Layout menu is never pushed out of the strip', async () => {
    // jsdom lays nothing out: a 300px row whose content is 100px per card plus its two buttons.
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(300)
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      if (this.getAttribute('data-slot') !== 'layout-cards') return 0
      return this.querySelectorAll('[data-slot="layout-card"]').length * 100 + 60
    })
    stubFetch()
    renderWorkspace()
    await ready()

    await waitFor(() => expect(cardNames().length).toBeLessThanOrEqual(2))
    expect(activeCard()).toBe('Chat')
    expect(screen.getByRole('button', { name: /more views/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /^Layout/ })).not.toBeNull()
  })

  it('opens /terminal as its own card', async () => {
    stubFetch()
    renderWorkspace('terminal')
    expect((await screen.findByTestId('terminal')).dataset.fill).toBe('')
    await waitFor(() => expect(activeCard()).toBe('Terminal'))
    expect(terminalTab()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps a left layout mounted, hidden, so going back to Changes does not rebuild it', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    const visible = () => document.querySelector('[data-slot="workspace-layout"][data-active]')
    const select = (view: ViewId) =>
      fireEvent.click(document.querySelector(`[data-slot="layout-card"][data-fixed="${view}"]`) as HTMLElement)

    select('changes')
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    const changes = visible()

    select('session')
    await waitFor(() => expect(columnViews()).toEqual(['session']))
    expect(changes?.isConnected).toBe(true)
    expect(changes?.hasAttribute('data-active')).toBe(false)

    select('changes')
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    expect(visible()).toBe(changes)
  })

  it('sends the \\ key to the layout on screen, never to a kept one hidden behind it', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    // ⌥-click builds a split layout, whose windows carry Split view buttons.
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!, { altKey: true })
    await waitFor(() => expect(columnViews()).toEqual(['session', 'changes']))

    fireEvent.click(document.querySelector<HTMLElement>('[data-slot="layout-card"][data-fixed="changes"]')!)
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    const hidden = () => document.querySelector('[data-slot="workspace-layout"]:not([data-active])')
    // The split layout is kept, hidden, with its Split view buttons still in the DOM.
    expect(hidden()?.querySelector('[data-action="split-view"]')).not.toBeNull()

    // The key splits the layout on screen — the hidden one sits later in the DOM, so a stage-wide
    // lookup would have pressed ITS last Split view instead.
    fireEvent.keyDown(document.body, { key: '\\' })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="workspace-layout"][data-active] [data-slot="view-tiles-stage"]')).not.toBeNull(),
    )
  })

  it('gives each task its own Changes view — the previous task\'s diff never renders under the next', async () => {
    // Both tasks open on Changes. A guard: one ChangesView reused across them would let its
    // deferred diff hand the second task's first render the first task's files.
    const onChanges = { layouts: [{ name: 'Chat', columns: [{ view: 'session', width: 100 }] }, { name: 'Changes', columns: [{ view: 'changes', width: 100 }] }], active: 'Changes' }
    hostLayouts = { r1: onChanges, r2: onChanges }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const run = /^\/api\/v1\/runs\/(r[12])(\/.*)?$/.exec(path)
        if (path === '/api/v1/health') return jsonResponse(health(true))
        if (path === '/api/v1/runs') return jsonResponse([RUN, { ...RUN, id: 'r2' }])
        if (path === '/api/v1/repo') return jsonResponse(health(true).repo)
        if (!run) return jsonResponse({ error: `unstubbed: ${path}` }, 404)
        const [, id, rest = ''] = run
        if (rest === '') return jsonResponse({ ...RUN, id })
        if (rest === '/layouts') return jsonResponse({ layouts: (init.method ?? 'GET') === 'GET' ? hostLayouts[id!] : JSON.parse(String(init.body)) })
        if (rest.startsWith('/drafts')) return jsonResponse({ surfaces: {} })
        if (rest.startsWith('/changes')) return jsonResponse({ files: [], stat: { adds: 0, dels: 0, files: 0 } })
        return jsonResponse([])
      }),
    )
    let navigate: (to: string) => void = () => {}
    function Navigator() {
      const go = useNavigate()
      navigate = (to) => void go(to)
      return null
    }
    render(
      <Providers>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Navigator />
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
          </Routes>
        </MemoryRouter>
      </Providers>,
    )
    const changesView = () => document.querySelector('[data-route="task-changes"]')
    await waitFor(() => expect(changesView()).not.toBeNull())
    const first = changesView()

    navigate('/tasks/r2')
    await waitFor(() => expect(document.querySelector('[data-route="task-workspace"]')?.getAttribute('data-run-id')).toBe('r2'))
    await waitFor(() => expect(changesView()).not.toBeNull())
    expect(changesView()).not.toBe(first)
  })

  it('never keeps a Preview layout once left — a hidden page would keep running', async () => {
    stubFetch()
    renderWorkspace()
    await ready()
    fireEvent.click(document.querySelector('[data-slot="layout-card"][data-fixed="browser"]') as HTMLElement)
    await waitFor(() => expect(columnViews()).toEqual(['browser']))
    const preview = document.querySelector('[data-slot="workspace-layout"][data-active]')

    fireEvent.click(document.querySelector('[data-slot="layout-card"][data-fixed="session"]') as HTMLElement)
    await waitFor(() => expect(columnViews()).toEqual(['session']))
    expect(preview?.isConnected).toBe(false)
  })

  it('splits the screen when a view tab is dropped beside the chat', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    const tab = document.querySelector('[data-slot="layout-card"][data-fixed="changes"]') as HTMLElement
    const data = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() {
        return [...data.keys()]
      },
      effectAllowed: 'all',
      dropEffect: 'none',
    }
    fireEvent.dragStart(tab, { dataTransfer })
    const zones = await waitFor(() => {
      const found = document.querySelectorAll('[data-slot="view-drop-zones"] [data-drop-zone="insert"]')
      expect(found.length).toBe(2)
      return found
    })
    fireEvent.dragOver(zones[1]!, { dataTransfer })
    fireEvent.drop(zones[1]!, { dataTransfer })

    // The fixed Chat card stays one view; the pair is the task's working arrangement, not a new layout.
    await waitFor(() => expect(activeCard()).toBe('Custom'))
    expect(document.querySelector('[data-slot="view-drop-zones"]')).toBeNull()
    await waitFor(() => {
      const saved = reviveState(hostLayouts.r1 ?? null)
      const built = saved.layouts.find((layout) => layout.name === 'Custom')
      expect(built?.columns.map((column) => column.view)).toEqual(['session', 'changes'])
    })
  })

  it('saves a layout only when the user names it, for every task, and opens it from the Layout menu', async () => {
    hostUiState = { savedLayouts: [{ name: 'Debug', columns: [{ view: 'files', width: 60 }, { view: 'terminal', width: 40 }] }] }
    stubFetch()
    renderWorkspace()
    await ready()

    // Splitting names nothing: the task's working arrangement, and still one saved layout.
    fireEvent.click(document.querySelector<HTMLElement>('[data-fixed="changes"]')!, { altKey: true })
    await waitFor(() => expect(activeCard()).toBe('Custom'))
    expect(hostUiState.savedLayouts).toHaveLength(1)

    openLayoutMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Save current view as layout/ }))
    const field = await screen.findByRole('textbox', { name: 'Layout name' })
    expect((field as HTMLInputElement).value).toBe('Chat + Changes')
    // A view tab's name is not a layout's.
    fireEvent.change(field, { target: { value: 'Changes' } })
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(field, { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(activeCard()).toBe('Review'))
    await waitFor(() =>
      expect(hostUiState.savedLayouts).toEqual([
        { name: 'Debug', columns: [{ view: 'files', width: 60 }, { view: 'terminal', width: 40 }] },
        { name: 'Review', columns: [{ view: 'session', width: 50 }, { view: 'changes', width: 50 }] },
      ]),
    )

    // A layout saved elsewhere opens here with its own arrangement.
    openLayoutMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Debug/ }))
    await waitFor(() => expect(activeCard()).toBe('Debug'))
    expect(columnViews()).toEqual(['files', 'terminal'])

    openLayoutMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete saved layout Review' }))
    await waitFor(() => expect(hostUiState.savedLayouts).toEqual([expect.objectContaining({ name: 'Debug' })]))

    // The menu stays open after a ×. The row's × is pointer-only; Delete on the focused row does
    // the same from the keyboard.
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: /Debug/ }), { key: 'Delete' })
    await waitFor(() => expect(hostUiState.savedLayouts).toEqual([]))
  })
})

describe('the task workspace', () => {
  it('opens a clean visit on Chat, under the run header', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    // The familiar anchor is still there…
    expect(document.querySelector('[data-slot="run-header"]')).not.toBeNull()
    // …with the layout strip in place of the four route tabs, and never both (spec §2): one fixed
    // card per view, Chat first and showing.
    expect(cardNames()).toEqual(FIXED)
    expect(activeCard()).toBe('Chat')
    expect(screen.getByRole('button', { name: 'Chat', pressed: true })).not.toBeNull()
    expect(screen.queryByRole('link', { name: 'Changes' })).toBeNull()
    // A fixed card is a standing surface, not a saved layout: nothing to close or rename.
    expect(builtCards()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /^Close layout/ })).toBeNull()
    // Chat is the task's home: the task's bar, then the conversation in its one column — nothing
    // to divide.
    expect(stage()!.querySelector('[data-slot="run-bar"]')).not.toBeNull()
    expect(columnViews()).toEqual(['session'])
    expect(dividers()).toHaveLength(0)
  })

  it('shows the view of the fixed card that was picked, without minting a layout', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    await waitFor(() => expect(columnViews()).toEqual(['files']))
    expect(activeCard()).toBe('Code')
    expect(cardNames()).toEqual(FIXED)
    // A fixed card stays the one view it stands for: its bar offers the split only.
    expect(document.querySelector('[data-action="change-view"]')).toBeNull()
    await waitFor(() => expect(savedLayouts('r1').active).toBe('Code'))
    expect(savedNames('r1')).toEqual(BORN)
  })

  it('splits a window of a built layout and gives the pair a divider', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    await buildPair('session', 'changes')

    expect(dividers()).toHaveLength(1)
    // Two columns start at half width each (spec §5.2).
    expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['50%', '50%'])
  })

  it('resizes the pair either side of a divider with the keyboard', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [{ name: 'Pair', columns: [{ view: 'session', width: 50 }, { view: 'files', width: 50 }] }],
        active: 'Pair',
      })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(dividers()).toHaveLength(1))

    const divider = dividers()[0]!
    expect(divider.getAttribute('role')).toBe('separator')
    expect(divider.getAttribute('aria-orientation')).toBe('vertical')
    expect(divider.getAttribute('aria-valuenow')).toBe('50')

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['52%', '48%']),
    )
    // Shift takes a bigger bite, and the separator reports where it now sits.
    fireEvent.keyDown(dividers()[0]!, { key: 'ArrowLeft', shiftKey: true })
    await waitFor(() =>
      expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['42%', '58%']),
    )
    expect(dividers()[0]!.getAttribute('aria-valuenow')).toBe('42')
  })

  it('closes a column and divides the rest equally', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [
          {
            name: 'Trio',
            columns: [
              { view: 'session', width: 60 },
              { view: 'files', width: 20 },
              { view: 'commits', width: 20 },
            ],
          },
        ],
        active: 'Trio',
      })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(columnViews()).toHaveLength(3))

    fireEvent.click(screen.getByRole('button', { name: 'Close Code' }))
    await waitFor(() => expect(columnViews()).toEqual(['session', 'commits']))
    expect(columns().map((column) => (column as HTMLElement).style.width)).toEqual(['50%', '50%'])
  })

  it('creates a card from New layout and keeps the layout names unique', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    for (const expected of ['Layout 7', 'Layout 8']) {
      await newLayout()
      await waitFor(() => expect(activeCard()).toBe(expected))
    }

    // Numbered by position among the task's layouts, the six it was born with included.
    expect(cardNames()).toEqual(FIXED)
    await waitFor(() => expect(savedNames('r1')).toEqual([...BORN, 'Layout 7', 'Layout 8']))
  })

  it('persists a built workspace for the next visit', async () => {
    stubFetch()
    renderWorkspace()
    await ready()

    await buildPair('session', 'files')

    // The save is debounced (spec §5.3 — a divider drag must not be one write per pointermove),
    // so this waits for it rather than sampling the instant after the click.
    await waitFor(() => expect(savedViews('r1', 'Layout 7')).toEqual(['session', 'files']))
    expect(savedNames('r1')).toEqual([...BORN, 'Layout 7'])
    expect(savedLayouts('r1').active).toBe('Layout 7')
  })

  it('does not mint a card for every Back-and-Forward across a deep link', async () => {
    // Six presses used to leave `Changes 2, 3, 4` behind, saved on the host: Back cleared the hop,
    // so the Forward looked like a fresh arrival. §5.3 — "existing saved layouts remain
    // unchanged" — and §10's browser-history clause.
    //
    // The user split their Changes card, so the link has no plain card of that view to select and
    // must MINT one — which is the only case where a second arrival could mint another.
    stubFetch()
    seedLayouts('r1', {
      layouts: [
        { name: 'Chat', columns: [{ view: 'session', width: 100 }] },
        { name: 'Changes', columns: [{ view: 'changes', width: 50 }, { view: 'files', width: 50 }] },
      ],
      active: 'Chat',
    })
    render(
      <Providers>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
            <Route path="/tasks/:id/changes" element={<TaskWorkspaceRoute view="changes" />} />
          </Routes>
          <HistoryProbe />
        </MemoryRouter>
      </Providers>,
    )
    await ready()
    await waitFor(() => expect(cardNames()).toEqual(FIXED))
    expect(activeCard()).toBe('Chat')

    fireEvent.click(screen.getByRole('button', { name: 'go-changes' }))
    await waitFor(() => expect(cardNames()).toEqual(FIXED))
    await waitFor(() => expect(columnViews()).toEqual(['changes']))

    for (let round = 0; round < 3; round += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'back' }))
      // Back gives the selection up again: the canonical URL shows what was there before the hop.
      await waitFor(() => expect(activeCard()).toBe('Chat'))
      expect(columnViews()).toEqual(['session'])
      fireEvent.click(screen.getByRole('button', { name: 'forward' }))
      await waitFor(() => expect(columnViews()).toEqual(['changes']))
      expect(activeCard()).toBe('Changes 2')
    }

    // Still the one card the first hop made.
    expect(cardNames()).toEqual(FIXED)
    await waitFor(() => expect(savedLayouts('r1').active).toBe('Changes 2'))
    expect(savedNames('r1')).toEqual(['Chat', 'Changes', 'Changes 2'])
  })

  it('does not mint a card when a deep link is crossed back and forth on a fresh task', async () => {
    // The everyday case: the task still has the plain Changes card it was born with, so the link
    // selects it — there is nothing to mint, however many times the entry is revisited.
    stubFetch()
    render(
      <Providers>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
            <Route path="/tasks/:id/changes" element={<TaskWorkspaceRoute view="changes" />} />
          </Routes>
          <HistoryProbe />
        </MemoryRouter>
      </Providers>,
    )
    await ready()
    expect(activeCard()).toBe('Chat')

    fireEvent.click(screen.getByRole('button', { name: 'go-changes' }))
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    expect(activeCard()).toBe('Changes')

    for (let round = 0; round < 3; round += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'back' }))
      await waitFor(() => expect(activeCard()).toBe('Chat'))
      fireEvent.click(screen.getByRole('button', { name: 'forward' }))
      await waitFor(() => expect(activeCard()).toBe('Changes'))
    }

    expect(cardNames()).toEqual(FIXED)
    await waitFor(() => expect(savedLayouts('r1').active).toBe('Changes'))
    expect(savedNames('r1')).toEqual(BORN)
  })

  it('coalesces a divider drag into one save', async () => {
    // Spec §5.3 names high-frequency divider movement as the thing NOT to persist per event.
    // Without a debounce each `pointermove` was its own PUT, and each PUT an atomic file write
    // on the host.
    const puts: string[] = []
    stubFetch()
    const realFetch = globalThis.fetch as unknown as (...args: never[]) => Promise<Response>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if ((init.method ?? 'GET') === 'PUT' && String(input).endsWith('/layouts')) {
          puts.push(String(init.body ?? ''))
        }
        return realFetch(input as never, init as never)
      }),
    )
    renderWorkspace()
    await ready()

    await buildPair('session', 'changes')
    await waitFor(() => expect(savedViews('r1', 'Layout 7')).toEqual(['session', 'changes']))
    const afterBuild = puts.length

    const divider = dividers()[0]!
    for (let step = 0; step < 12; step += 1) {
      fireEvent.keyDown(divider, { key: 'ArrowRight' })
    }
    await waitFor(() =>
      expect(savedLayouts('r1').layouts.find((layout) => layout.name === 'Layout 7')!.columns[0]!.width).toBe(74),
    )

    // Twelve moves, one save — not twelve.
    expect(puts.length - afterBuild).toBe(1)
  })

  it('saves the last change even when you leave the task straight away', async () => {
    // The other half of the debounce. Cancelling the pending timer on the way out loses the
    // user's final change — build a split, leave, come back to the layout you had before it —
    // and the first attempt at a flush looked for a pending TIMER, which React's
    // declaration-order cleanup had already cleared. This pins the outcome, not the mechanism.
    stubFetch()
    const view = renderWorkspace()
    await ready()

    await buildPair('session', 'files')

    // Leave well inside the debounce window.
    view.unmount()

    await waitFor(() => expect(savedViews('r1', 'Layout 7')).toEqual(['session', 'files']))
  })

  it('opens a deep link on the card of its view and leaves the saved layouts alone', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [{ name: 'Chat', columns: [{ view: 'session', width: 100 }] }],
        active: 'Chat',
      })
    renderWorkspace('changes')
    await ready()

    await waitFor(() => expect(columnViews()).toEqual(['changes']))
    // The view the URL asked for is one of the fixed cards, so that is the card that lights up —
    // not a second, closable `Changes` drawn beside it.
    expect(activeCard()).toBe('Changes')
    expect(cardNames()).toEqual(FIXED)
    // Named after the view the URL asked for (spec §5.3, §11), not the `Layout N` counter…
    await waitFor(() => expect(savedNames('r1')).toEqual(['Chat', 'Changes']))
    expect(savedViews('r1', 'Changes')).toEqual(['changes'])
    // …and the layout that was already there is untouched (spec §5.3).
    expect(savedLayouts('r1').layouts[0]!.columns).toEqual([{ view: 'session', width: 100 }])
  })

  it('recovers a malformed saved workspace to the default cards without an error', async () => {
    stubFetch()
    seedLayouts('r1', '{ not json at all')
    renderWorkspace()
    await ready()

    expect(cardNames()).toEqual(FIXED)
    expect(activeCard()).toBe('Chat')
    expect(columnViews()).toEqual(['session'])
  })

  it('gives each column its own scroller, so the embedded views scroll inside it', async () => {
    stubFetch()
    seedLayouts('r1', {
        layouts: [{ name: 'Pair', columns: [{ view: 'files', width: 50 }, { view: 'commits', width: 50 }] }],
        active: 'Pair',
      })
    renderWorkspace()
    await ready()

    await waitFor(() => expect(columns()).toHaveLength(2))
    // `data-slot="main"` is load-bearing, not decoration: the thread, the diff and the commit list
    // all find their scroll container with `closest('[data-slot="main"]')`.
    for (const column of columns()) {
      const scroller = column.querySelector('[data-slot="main"]')
      expect(scroller).not.toBeNull()
      expect(scroller!.className).toContain('overflow-y-auto')
    }
  })

  it('splits columns only from lg up, so a tablet is not squeezed', async () => {
    // The shared `useIsDesktop` default is `md` (768px), which is the threshold for a different
    // question — whether a diff should wrap. At 768 a three-way split is ~250px a column, the
    // squeezing §5.2 asks not to do; it names "mobile/tablet" for one-at-a-time.
    stubFetch()
    const queries: string[] = []
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => {
        queries.push(query)
        return { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
      }),
    )
    seedLayouts('r1', {
      layouts: [{ name: 'Solo', columns: [{ view: 'files', width: 100 }] }],
      active: 'Solo',
    })
    renderWorkspace()
    await ready()

    await waitFor(() => expect(document.querySelector('[data-narrow]')).not.toBeNull())
    expect(queries).toContain('(min-width: 1024px)')
  })

  it('offers the split on a narrow viewport too', async () => {
    // A narrow screen shows one window at a time, with the SAME controls a window has on a wide
    // one — so a layout can still grow there, and the split lands you on the new window's tiles.
    stubFetch()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    seedLayouts('r1', {
      layouts: [{ name: 'Solo', columns: [{ view: 'files', width: 100 }] }],
      active: 'Solo',
    })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(document.querySelector('[data-narrow]')).not.toBeNull())

    const split = document.querySelector('[data-narrow] [data-action="split-view"]')
    expect(split).not.toBeNull()
    expect((split as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(split!)
    await waitFor(() => expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Code', 'New window']))
    expect(screen.getAllByRole('tab')[1]!.getAttribute('aria-selected')).toBe('true')
    await pickTile('commits')
    await waitFor(() => expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Code', 'Commits']))
  })

  it('shows one column at a time on a narrow viewport', async () => {
    stubFetch()
    // jsdom has no matchMedia, which `useIsDesktop` counts as desktop — stub the narrow answer.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    seedLayouts('r1', {
        layouts: [{ name: 'Pair', columns: [{ view: 'files', width: 50 }, { view: 'commits', width: 50 }] }],
        active: 'Pair',
      })
    renderWorkspace()
    await ready()

    await waitFor(() => expect(document.querySelector('[data-narrow]')).not.toBeNull())
    // Both columns are reachable as tabs, but only one is painted.
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Code', 'Commits'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelectorAll('[data-narrow] [data-slot="main"]')).toHaveLength(1)

    // The switcher is the shared Tabs primitive, which selects on the press rather than the click.
    fireEvent.mouseDown(tabs[1]!, { button: 0 })
    await waitFor(() => expect(screen.getAllByRole('tab')[1]!.getAttribute('aria-selected')).toBe('true'))
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('button', { name: 'Commits — change view' })).not.toBeNull()
  })

  it('reports the range a divider actually has, not the row-wide one', async () => {
    // `resizeColumns` clamps against the adjacent PAIR, so in a 33/33/33 layout either divider
    // moves within roughly [12, 55] — the hard-coded [12, 88] told a screen reader about
    // positions no divider in that layout can reach (spec §5.2, "position announcement").
    stubFetch()
    seedLayouts('r1', {
      layouts: [
        {
          name: 'Trzy',
          columns: [
            { view: 'session', width: 33.33 },
            { view: 'changes', width: 33.33 },
            { view: 'files', width: 33.34 },
          ],
        },
      ],
      active: 'Trzy',
    })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(dividers()).toHaveLength(2))

    for (const divider of dividers()) {
      // Each separator governs two thirds of the row: floor 12, ceiling 66.67 - 12.
      expect(divider.getAttribute('aria-valuemin')).toBe('12')
      expect(divider.getAttribute('aria-valuemax')).toBe('55')
    }
  })

  it('does not make the column header itself the drag grip', async () => {
    // An HTML5 drag starts from the nearest draggable ancestor, so a draggable HEADER swallowed
    // presses on its own menu trigger and close X — the X became unreliable on any two- or
    // three-column layout. The grip and the empty stretch of the bar drag the window instead;
    // the buttons never do.
    stubFetch()
    seedLayouts('r1', {
      layouts: [
        {
          name: 'Dwie',
          columns: [
            { view: 'session', width: 50 },
            { view: 'changes', width: 50 },
          ],
        },
      ],
      active: 'Dwie',
    })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(columns()).toHaveLength(2))

    const header = document.querySelector('[data-slot="workspace-column-header"]')!
    expect(header.getAttribute('draggable')).toBeNull()
    const grips = Array.from(header.querySelectorAll('[draggable="true"]'))
    expect(grips.length).toBeGreaterThan(0)
    expect(grips.some((grip) => grip.getAttribute('title') === 'Drag to reorder')).toBe(true)
    for (const grip of grips) {
      // No button is a grip, and no button sits inside one.
      expect(grip.closest('button')).toBeNull()
      expect(grip.querySelector('button')).toBeNull()
    }
    for (const button of Array.from(header.querySelectorAll('button'))) {
      expect(button.closest('[draggable="true"]')).toBeNull()
    }

    // And the close X still closes, which is the behaviour the grip was costing.
    fireEvent.click(screen.getByRole('button', { name: 'Close Chat' }))
    await waitFor(() => expect(columnViews()).toEqual(['changes']))
  })

  it('offers Graph as a view and mounts it embedded in a column', async () => {
    // Spec §5.1 (amended): the task's live workflow graph is a workspace view, so a layout can
    // hold it beside the conversation instead of it being a page of its own.
    stubFetch()
    renderWorkspace()
    await ready()

    await buildPair('session', 'graph')

    const graph = await screen.findByTestId('graph-view')
    // Embedded, so it drops its own RunHeader — the workspace already has one.
    expect(graph.getAttribute('data-embedded')).toBe('')
    expect(graph.getAttribute('data-run')).toBe('r1')
  })

  it('opens /tasks/:id/graph on its Graph card, like every other task URL', async () => {
    // Before this, the graph was a page of its own with the legacy tab strip, and nothing in the
    // workspace could reach it (§5.3 now covers all five task URLs).
    const withWorkflow = {
      ...RUN,
      workflowDef: { name: 'quick-task', steps: [], source: 'built-in' },
    }
    stubFetch({ 'GET /api/v1/runs/r1': () => jsonResponse(withWorkflow) })
    seedLayouts('r1', {
      layouts: [{ name: 'Chat', columns: [{ view: 'session', width: 100 }] }],
      active: 'Chat',
    })
    renderWorkspace('graph')
    await ready()

    await waitFor(() => expect(columnViews()).toEqual(['graph']))
    // A task with a workflow has a Graph tab, before Browser, and the link lights it.
    expect(cardNames()).toEqual(['Chat', 'Changes', 'Commits', 'Code', 'Graph', 'Browser', 'Terminal'])
    expect(activeCard()).toBe('Graph')
    const graph = await screen.findByTestId('graph-view')
    expect(graph.getAttribute('data-embedded')).toBe('')
    await waitFor(() => expect(savedNames('r1')).toEqual(['Chat', 'Graph']))
  })

  it('keeps two tasks apart when the route swaps run ids without remounting', async () => {
    stubFetch({ 'GET /api/v1/runs/r2': () => jsonResponse({ ...RUN, id: 'r2' }) })
    seedLayouts('r1', {
        layouts: [{ name: 'Tylko r1', columns: [{ view: 'files', width: 100 }] }],
        active: 'Tylko r1',
      })
    render(
      <Providers>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
          </Routes>
          <HistoryProbe />
        </MemoryRouter>
      </Providers>,
    )
    await ready()
    await waitFor(() => expect(cardNames()).toEqual(FIXED))
    expect(activeCard()).toBe('Tylko r1')

    // Same route element, another task: r2 has nothing saved, so it must open on its own default —
    // never r1's card (spec §5.3).
    fireEvent.click(screen.getByRole('button', { name: 'go-r2' }))
    await waitFor(() =>
      expect(document.querySelector('[data-route="task-workspace"]')?.getAttribute('data-run-id')).toBe('r2'),
    )
    await waitFor(() => expect(activeCard()).toBe('Chat'))
    expect(cardNames()).toEqual(FIXED)
    expect(savedNames('r2')).toEqual(BORN)
    // …and r1 still has what it had.
    expect(savedNames('r1')).toEqual(['Tylko r1'])
  })
})

describe('a file named in the chat, with unsaved edits in the Code window', () => {
  const KEY = 'r1:Chat + Code:1:files'

  /** Click an inline-code span of the conversation, the way a path in an answer is clicked. The
   *  handler is delegated on the span the markdown renders, so a span is all it takes. */
  async function clickPath(path: string) {
    const thread = await waitFor(() => {
      const found = document.querySelector('[data-view="session"] div.contents')
      expect(found).not.toBeNull()
      return found!
    }, { timeout: 5000 })
    const code = document.createElement('code')
    code.setAttribute('data-streamdown', 'inline-code')
    code.textContent = path
    thread.appendChild(code)
    fireEvent.click(code)
  }

  const fetched = (path: string) =>
    vi.mocked(fetch).mock.calls.some(([input]) => decodeURIComponent(String(input)).includes(`files?path=${path}`))

  it('asks before dropping them, and keeps them when the answer is no', async () => {
    stubFetch()
    seedLayouts('r1', {
      layouts: [{ name: 'Chat + Code', columns: [{ view: 'session', width: 50 }, { view: 'files', width: 50 }] }],
      active: 'Chat + Code',
    })
    // File A is open in the Code window with an edit that was never saved.
    rememberViewState(KEY, 'src/a.ts')
    rememberViewState(`${KEY}:edit`, { path: 'src/a.ts', draft: 'UNSAVED WORK', baseHash: 'h', baseContent: 'on disk' })
    renderWorkspace()
    await ready()
    await waitFor(() => expect(fetched('src/a.ts')).toBe(true))

    await clickPath('src/b.ts')
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Discard unsaved changes?')
    expect(fetched('src/b.ts')).toBe(false)

    // No: the edit and the selection stand.
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(fetched('src/b.ts')).toBe(false)

    // Yes: only now does the window move to the file that was clicked.
    await clickPath('src/b.ts')
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(fetched('src/b.ts')).toBe(true))
  })

  it('opens the file straight away when nothing is unsaved', async () => {
    stubFetch()
    seedLayouts('r1', {
      layouts: [{ name: 'Chat + Code', columns: [{ view: 'session', width: 50 }, { view: 'files', width: 50 }] }],
      active: 'Chat + Code',
    })
    rememberViewState(KEY, 'src/a.ts')
    renderWorkspace()
    await ready()

    await clickPath('src/b.ts')
    await waitFor(() => expect(fetched('src/b.ts')).toBe(true))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('the read receipt across tasks (#775, main #1337)', () => {
  it('going to another task and back marks a task read again after Mark unread', async () => {
    // /tasks/A → /tasks/B → /tasks/A reuses this route element, so a suppression that only reset
    // on remount survived the round trip and the task stayed unread however often it was reopened.
    let current: ApiRun = { ...RUN, status: 'done', finishedAt: '2026-07-15T08:30:00.000Z' }
    let reads = 0
    stubFetch({
      'GET /api/v1/runs/r1': () => jsonResponse(current),
      'POST /api/v1/runs/r1/unread': () => {
        const { seenAt: _cleared, ...rest } = current
        current = rest as ApiRun
        return jsonResponse(current)
      },
      'POST /api/v1/runs/r1/read': () => {
        reads += 1
        current = { ...current, seenAt: '2026-07-15T10:00:00.000Z' }
        return jsonResponse(current)
      },
      // The neighbour is already read, so it never posts a receipt of its own.
      'GET /api/v1/runs/r2': () => jsonResponse({ ...RUN, id: 'r2' }),
    })
    render(
      <Providers>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskWorkspaceRoute />} />
          </Routes>
          <HistoryProbe />
        </MemoryRouter>
      </Providers>,
    )
    await ready()

    const markUnread = await waitFor(() => {
      if (screen.queryByRole('menu') === null) {
        fireEvent.pointerDown(screen.getAllByRole('button', { name: 'More actions' })[0]!)
      }
      return screen.getByRole('menuitem', { name: 'Mark unread' })
    })
    fireEvent.click(markUnread)
    await waitFor(() => expect(current.seenAt).toBeUndefined())
    // Still on the task: the suppression holds for this visit.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'go-r2' }))
    await waitFor(() =>
      expect(document.querySelector('[data-route="task-workspace"]')?.getAttribute('data-run-id')).toBe('r2'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'back' }))
    await waitFor(() => expect(reads).toBe(1))
    expect(current.seenAt).toBe('2026-07-15T10:00:00.000Z')
  })
})

describe('a failed read of the saved layouts, through the route', () => {
  it('says so, writes nothing over the host copy, and applies the deep link once the host answers', async () => {
    const mine = {
      layouts: [
        { name: 'Chat', columns: [{ view: 'session', width: 100 }] },
        { name: 'Moje', columns: [{ view: 'session', width: 50 }, { view: 'files', width: 50 }] },
      ],
      active: 'Moje',
    }
    seedLayouts('r1', mine)
    let reads = 0
    stubFetch({
      // A proxy answering for a cezar that is restarting, once.
      'GET /api/v1/runs/r1/layouts': () => {
        reads += 1
        return reads === 1 ? jsonResponse({ error: 'bad gateway' }, 502) : jsonResponse({ layouts: hostLayouts.r1 })
      },
    })
    // The deep link changes state by itself as soon as the workspace is ready — no click needed.
    renderWorkspace('changes')
    await waitFor(() => expect(document.querySelector('[data-slot="layouts-unloaded"]')).not.toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(hostLayouts.r1).toEqual(mine)

    await waitFor(() => expect(document.querySelector('[data-slot="layouts-unloaded"]')).toBeNull(), { timeout: 6000 })
    await waitFor(() => expect(activeCard()).toBe('Changes'))
    await waitFor(() => expect(savedNames('r1')).toEqual(['Chat', 'Moje', 'Changes']))
  })

  it('leaves the card picked during the outage alone when the host says the task was never opened', async () => {
    let reads = 0
    stubFetch({
      'GET /api/v1/runs/r1/layouts': () => {
        reads += 1
        return reads === 1 ? jsonResponse({ error: 'bad gateway' }, 502) : jsonResponse({ layouts: null })
      },
    })
    renderWorkspace('changes')
    await waitFor(() => expect(document.querySelector('[data-slot="layouts-unloaded"]')).not.toBeNull())
    await waitFor(() => expect(activeCard()).toBe('Changes'))
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    await waitFor(() => expect(activeCard()).toBe('Chat'))

    await waitFor(() => expect(document.querySelector('[data-slot="layouts-unloaded"]')).toBeNull(), { timeout: 6000 })
    // Nothing replaced the stand-in, so the deep link has no reason to be applied again.
    await waitFor(() => expect(savedLayouts('r1').active).toBeDefined(), { timeout: 3000 })
    expect(activeCard()).toBe('Chat')
    expect(savedLayouts('r1').active).toBe('Chat')
  })
})

describe('classifyReference', () => {
  it('claims task paths and commit shas, and leaves prose alone', () => {
    expect(classifyReference('src/app.ts:12')).toEqual({ view: 'files', value: 'src/app.ts' })
    expect(classifyReference('/tmp/wt/r1/src/a.ts', '/tmp/wt/r1')).toEqual({ view: 'files', value: 'src/a.ts' })
    expect(classifyReference('3f7eaf02')).toEqual({ view: 'commits', value: '3f7eaf02' })
    expect(classifyReference('/etc/passwd')).toBeNull()
    expect(classifyReference('e.g')).toBeNull()
  })
})
