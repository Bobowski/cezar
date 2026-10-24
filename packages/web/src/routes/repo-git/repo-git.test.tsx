import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type {
  ChangesPayload,
  GithubData,
  HealthResponse,
  RepoCommitPayload,
  RepoGraph,
  RepoIndex,
  RepoRemotes,
  RepoResponse,
  RepoSync,
  RepoTree,
  WorktreeEntry,
} from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { ShellWithSidebar } from '@/test/shell-with-sidebar'

import { RepoGitRoute } from './repo-git'

beforeEach(() => {
  // Radix menus, popovers and the Select in jsdom: floating-ui wants a ResizeObserver, and the
  // Select scrolls its chosen item into view on open.
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const REPO: RepoResponse = {
  info: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  status: [],
  log: [
    { hash: 'abc1234', subject: 'feat: add the thing', author: 'Ada', when: '2 hours ago' },
    { hash: 'def5678', subject: 'fix: stop the bug', author: 'Linus', when: '3 days ago' },
  ],
  branches: ['feature', 'main'],
  checkedOutElsewhere: {},
  baseBranch: null,
}

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

const CHANGES: ChangesPayload = {
  files: [
    {
      path: 'notes.md',
      status: 'added',
      adds: 2,
      dels: 0,
      binary: false,
      patch: 'diff --git a/notes.md b/notes.md\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    },
    {
      path: 'src/util/a.ts',
      status: 'modified',
      adds: 3,
      dels: 1,
      binary: false,
      patch:
        'diff --git a/src/util/a.ts b/src/util/a.ts\n--- a/src/util/a.ts\n+++ b/src/util/a.ts\n@@ -1,2 +1,4 @@\n context\n-gone\n+one\n+two\n+three\n',
    },
  ],
  stat: { adds: 5, dels: 1, files: 2 },
}

/** The Changes tab's index (spec 2026-10-24-git-view §3.3): nothing staged, both files unstaged. */
const INDEX: RepoIndex = {
  branch: 'main',
  staged: [],
  unstaged: CHANGES.files,
  conflicted: [],
  operation: null,
  headPushed: false,
  hasHead: true,
}

const REMOTES: RepoRemotes = {
  remotes: [
    { name: 'origin', url: 'git@github.com:acme/demo.git', pushUrl: null, branches: ['main', 'feature'] },
    { name: 'upstream', url: 'https://github.com/canon/demo.git', pushUrl: null, branches: ['main'] },
  ],
  prTarget: 'upstream',
  pushDefault: 'origin',
  reasons: { prTarget: 'fork-parent', pushDefault: 'origin' },
}

/** main and a task branch forked from its root, and a merged task branch at the root. */
const GRAPH: RepoGraph = {
  commits: [
    { sha: 'c'.repeat(40), parents: ['a'.repeat(40)], subject: 'feat: on main', author: 'Ada', when: '1 hour ago' },
    { sha: 'b'.repeat(40), parents: ['a'.repeat(40)], subject: 'task: the work', author: 'cezar', when: '2 hours ago' },
    { sha: 'a'.repeat(40), parents: [], subject: 'root', author: 'Ada', when: '3 days ago' },
  ],
  refs: [
    { name: 'main', kind: 'local', remote: null, branch: 'main', commit: 'c'.repeat(40), current: true, base: true, isTask: false, task: null, merged: false, mergeBase: null },
    {
      name: 'cez/1a2b3c4d', kind: 'local', remote: null, branch: 'cez/1a2b3c4d', commit: 'b'.repeat(40), current: false, base: false,
      isTask: true, task: { runId: 'r1', title: 'Fix the login', status: 'review' }, merged: false, mergeBase: 'a'.repeat(40),
    },
    {
      name: 'cez/done0000', kind: 'local', remote: null, branch: 'cez/done0000', commit: 'a'.repeat(40), current: false, base: false,
      isTask: true, task: null, merged: true, mergeBase: 'a'.repeat(40),
    },
  ],
  head: 'c'.repeat(40),
  base: 'main',
  next: null,
}

/** The repository path index behind the Files sub-tab (#1279) — a compactable chain, a sibling
 *  folder, a root dotfile and a markdown file, which is every tree case the tests need. */
const TREE: RepoTree = {
  paths: [
    '.gitignore',
    'README.md',
    'docs/guide.md',
    'packages/web/src/app.tsx',
    'packages/web/src/lib/x.ts',
  ],
  truncated: false,
}

const COMMIT: RepoCommitPayload = {
  sha: 'abc1234def5678abc1234def5678abc1234def56',
  subject: 'feat: add the thing',
  author: 'Ada',
  when: '2 hours ago',
  files: [CHANGES.files[0]!],
  stat: { adds: 2, dels: 0, files: 1 },
}

const GITHUB: GithubData = {
  available: true,
  repo: 'acme/demo',
  issues: [],
  prs: [
    {
      kind: 'pr',
      number: 7,
      title: 'Improve everything',
      author: 'ada',
      createdAt: '2026-07-15T08:00:00.000Z',
      labels: [],
      body: '',
      url: 'https://github.com/acme/demo/pull/7',
      comments: 0,
      checks: 'passing',
    },
  ],
}

/** One local commit to push, one teammate commit to pull (spec 2026-10-19-repo-git-sync). */
const SYNC: RepoSync = {
  branch: 'main',
  upstream: 'origin/main',
  topic: null,
  ahead: 1,
  behind: 1,
  outgoing: ['abc1234'],
  incoming: [{ hash: '9990000', subject: 'feat: teammate work', author: 'Grace', when: '5 minutes ago' }],
  pushRemote: 'origin',
  lastFetchedAt: '2026-10-19T10:00:00.000Z',
  branches: [
    { name: 'feature', upstream: null, ahead: null, behind: null, gone: false },
    { name: 'main', upstream: 'origin/main', ahead: 1, behind: 1, gone: false },
  ],
}

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (task-changes.test.tsx): records requests, serves the repo
 *  fixtures, and lets a test override specific `METHOD path` keys. */
function stubFetch(overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(REPO)
      if (method === 'GET' && path === '/api/v1/repo/changes') return jsonResponse(CHANGES)
      if (method === 'GET' && path === '/api/v1/repo/status') return jsonResponse(INDEX)
      if (method === 'GET' && path === '/api/v1/repo/remotes') return jsonResponse(REMOTES)
      if (method === 'GET' && path === '/api/v1/repo/stash') return jsonResponse({ stashes: [] })
      if (method === 'GET' && path.startsWith('/api/v1/repo/graph')) return jsonResponse(GRAPH)
      if (method === 'GET' && path === '/api/v1/repo/sync') return jsonResponse(SYNC)
      if (method === 'GET' && path === '/api/v1/repo/tree') return jsonResponse(TREE)
      if (method === 'GET' && path === '/api/v1/repo/commit/abc1234?structured=1') return jsonResponse(COMMIT)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/github?limit=20') return jsonResponse(GITHUB)
      return jsonResponse({})
    }),
  )
  return sent
}

/** Cold-load the repo view at a URL, with the same route map routes.tsx registers — inside a
 *  shell with a mounted contextual sidebar, which is where the section switch and each section's
 *  list (the changed-files tree, the commit log, the branches) live. */
function renderAt(entry: string) {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <ShellWithSidebar>
        <Routes>
          <Route path="/git" element={<RepoGitRoute tab="changes" />} />
          <Route path="/git/graph" element={<RepoGitRoute tab="graph" />} />
          <Route path="/git/commits" element={<RepoGitRoute tab="commits" />} />
          <Route path="/git/commits/:sha" element={<RepoGitRoute tab="commits" />} />
          <Route path="/git/branches" element={<RepoGitRoute tab="branches" />} />
          <Route path="/git/files" element={<RepoGitRoute tab="files" />} />
          <Route path="/git/files/*" element={<RepoGitRoute tab="files" />} />
        </Routes>
        </ShellWithSidebar>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const sidebar = () => document.querySelector<HTMLElement>('[data-slot="context-sidebar-body"]')!
/** The titles of the empty/error states on screen (shadcn `Empty`: a title, not a heading). */
const emptyTitles = () =>
  [...document.querySelectorAll('[data-slot="centered-state"] [data-slot="empty-title"]')].map((el) => el.textContent)

// ---- changes ----------------------------------------------------------------------------------

describe('the repo view Changes segment', () => {
  it('renders the header, the segment tabs and the working-tree diff from /api/v1/repo/status', async () => {
    stubFetch()
    renderAt('/git')

    await waitFor(() => expect(document.querySelector('[data-slot="repo-header"]')).not.toBeNull())
    // The header — title, checked-out branch, section switch — leads the contextual sidebar; the
    // page's own heading names the section.
    expect(sidebar().querySelector('[data-slot="repo-header"]')).not.toBeNull()
    expect(within(sidebar()).getByRole('heading', { level: 2 }).textContent).toBe('Git')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Uncommitted changes')
    expect(document.querySelector('[data-slot="branch-chip"]')?.textContent).toContain('main')

    const tabs = [...document.querySelectorAll('[data-slot="repo-tabs"] a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    }))
    expect(tabs).toEqual([
      { text: 'Changes', href: '/git', current: 'page' },
      { text: 'Graph', href: '/git/graph', current: null },
      { text: 'Commits', href: '/git/commits', current: null },
      { text: 'Branches', href: '/git/branches', current: null },
      { text: 'Files', href: '/git/files', current: null },
    ])

    // The unstaged side, one row per file with its directory, Source-Control style.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="index-file"]')).toHaveLength(2))
    expect(document.querySelector('[data-slot="index-file"][data-path="src/util/a.ts"]')?.textContent).toContain('src/util')
    // …in a scroller of its own, so a long list never drags the diff down with it. That used
    // to be a bounded pane beside the diff; it is the sidebar's content area now, which scrolls
    // independently of main by construction.
    await waitFor(() => expect(document.querySelector('[data-slot="changes-tree-pane"]')).not.toBeNull())
    const pane = document.querySelector('[data-slot="changes-tree-pane"]') as HTMLElement
    expect(sidebar().contains(pane)).toBe(true)
    expect(pane.querySelector('[data-slot="index-unstaged"]')).not.toBeNull()
    const scroller = pane.closest('[data-slot="sidebar-content"]') as HTMLElement
    expect(scroller.className).toContain('overflow-auto')
    expect(scroller.className).toContain('min-h-0')
    expect(scroller.contains(document.querySelector('[data-slot="diff"]'))).toBe(false)
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(2))
    expect(document.querySelector('[data-slot="changes-stat"]')?.textContent).toContain('+5')
    // The view toggles are the shared control, wired to the facade's mode.
    fireEvent.click(document.querySelector('[data-slot="diff-mode-toggle"] [data-mode="split"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('split'),
    )
  })

  it('the preview toggle renders an added Markdown file from its patch', async () => {
    stubFetch()
    renderAt('/git')
    const toggle = await waitFor(() => {
      const element = document.querySelector('[data-slot="repo-changes-toolbar"] [data-slot="markdown-preview-toggle"]')
      expect(element).not.toBeNull()
      return element!
    })
    fireEvent.click(toggle)
    // No file loader in the repo view: the added file's patch IS the whole document.
    const preview = await waitFor(() => {
      const element = document.querySelector('[data-slot="diff-markdown-preview"]')
      expect(element).not.toBeNull()
      return element!
    })
    expect(preview.textContent).toContain('one')
    expect(preview.textContent).not.toContain('Showing the changed sections only')
  })

  it('a clean tree renders the honest empty state', async () => {
    stubFetch({
      'GET /api/v1/repo/status': () => jsonResponse({ ...INDEX, unstaged: [] }),
    })
    renderAt('/git')
    await waitFor(() =>
      expect(emptyTitles()).toContain('Working tree clean'),
    )
  })

  it('a 409 from /index renders the server reason, not an error explosion', async () => {
    stubFetch({
      'GET /api/v1/repo/status': () => jsonResponse({ error: 'not a git repository' }, 409),
    })
    renderAt('/git')
    await waitFor(() =>
      expect(emptyTitles()).toContain('No changes to show'),
    )
    expect(document.querySelector('[data-slot="repo-changes"]')?.textContent).toContain('not a git repository')
  })

  it('below md the diff forces unified even when the toggle says split', async () => {
    // A non-desktop matchMedia: the forced-mobile rule must win over the local toggle state.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    stubFetch()
    renderAt('/git')
    await waitFor(() => expect(document.querySelector('[data-slot="diff"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="diff-mode-toggle"] [data-mode="split"]')!)
    // Still unified: phones render one readable column, wrap on.
    expect(document.querySelector('[data-slot="diff"]')?.getAttribute('data-mode')).toBe('unified')
  })

  it('outside a git repository the whole view degrades honestly', async () => {
    stubFetch({
      'GET /api/v1/repo': () =>
        jsonResponse({ info: null, status: [], log: [], branches: [], checkedOutElsewhere: {}, baseBranch: null }),
    })
    renderAt('/git')
    await waitFor(() =>
      expect(emptyTitles()).toEqual(['Not a git repository']),
    )
    expect(document.querySelector('[data-slot="repo-tabs"]')).toBeNull()
  })
})

// ---- staging (spec 2026-10-24-git-view §3.3) ------------------------------------------------

const posted = (sent: SentRequest[], path: string) => sent.filter((request) => request.method === 'POST' && request.path === path)

describe('the repo view Changes segment — staging', () => {
  it('stages a file from its row and a hunk from its header', async () => {
    const sent = stubFetch({ 'POST /api/v1/repo/stage': () => jsonResponse(INDEX) })
    renderAt('/git')
    const row = await waitFor(() => {
      const element = document.querySelector('[data-slot="index-file"][data-path="notes.md"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    fireEvent.click(row.querySelector('[data-action="stage-file"]')!)
    await waitFor(() => expect(posted(sent, '/api/v1/repo/stage')).toHaveLength(1))
    expect(posted(sent, '/api/v1/repo/stage')[0]!.body).toEqual({ paths: ['notes.md'] })

    const hunkButton = await waitFor(() => {
      const element = document.querySelector('[data-slot="diff-hunk-actions"] [data-action="stage-hunk"]')
      expect(element).not.toBeNull()
      return element!
    })
    fireEvent.click(hunkButton)
    await waitFor(() => expect(posted(sent, '/api/v1/repo/stage')).toHaveLength(2))
    expect(posted(sent, '/api/v1/repo/stage')[1]!.body).toEqual({ path: 'notes.md', hunk: '@@ -0,0 +1,2 @@' })
  })

  it('discards only after the confirm', async () => {
    const sent = stubFetch({ 'POST /api/v1/repo/discard': () => jsonResponse(INDEX) })
    renderAt('/git')
    const row = await waitFor(() => {
      const element = document.querySelector('[data-slot="index-file"][data-path="src/util/a.ts"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    fireEvent.click(row.querySelector('[data-action="discard-file"]')!)
    const confirm = await waitFor(() => {
      const element = document.querySelector('[data-action="confirm-discard"]')
      expect(element).not.toBeNull()
      return element!
    })
    expect(posted(sent, '/api/v1/repo/discard')).toHaveLength(0)
    fireEvent.click(confirm)
    await waitFor(() => expect(posted(sent, '/api/v1/repo/discard')).toHaveLength(1))
    expect(posted(sent, '/api/v1/repo/discard')[0]!.body).toEqual({ paths: ['src/util/a.ts'] })
  })

  it('commits the staged side with the typed message; nothing staged, nothing to commit', async () => {
    const staged: RepoIndex = { ...INDEX, staged: [CHANGES.files[1]!], unstaged: [CHANGES.files[0]!] }
    const sent = stubFetch({
      'GET /api/v1/repo/status': () => jsonResponse(staged),
      'POST /api/v1/repo/commit': () => jsonResponse({ message: 'committed abcdef12', sha: 'abcdef12' }),
    })
    renderAt('/git')
    const box = await waitFor(() => {
      const element = document.querySelector('[data-slot="commit-box"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(document.querySelector('[data-slot="index-staged"] [data-path="src/util/a.ts"]')).not.toBeNull()
    const button = box.querySelector<HTMLButtonElement>('[data-action="commit-index"]')!
    expect(button.disabled).toBe(true)
    fireEvent.change(within(box).getByLabelText('Commit message'), { target: { value: 'fix: the util' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(posted(sent, '/api/v1/repo/commit')).toHaveLength(1))
    expect(posted(sent, '/api/v1/repo/commit')[0]!.body).toEqual({ message: 'fix: the util' })
    await waitFor(() => expect(document.body.textContent).toContain('committed abcdef12'))
  })

  it('a stopped merge lists its conflicts, holds Continue, and aborts', async () => {
    const stopped: RepoIndex = { ...INDEX, unstaged: [], conflicted: ['src/util/a.ts'], operation: { kind: 'merge', onto: 'abc1234' } }
    const sent = stubFetch({
      'GET /api/v1/repo/status': () => jsonResponse(stopped),
      'POST /api/v1/repo/merge/abort': () => jsonResponse({ message: 'merge aborted', conflicts: [] }),
    })
    renderAt('/git')
    const banner = await waitFor(() => {
      const element = document.querySelector('[data-slot="repo-operation"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(banner.getAttribute('data-operation')).toBe('merge')
    expect(banner.querySelector('[data-slot="conflicted-files"] a')?.getAttribute('href')).toBe('/code/src/util/a.ts')
    expect(banner.querySelector<HTMLButtonElement>('[data-action="continue-operation"]')!.disabled).toBe(true)
    fireEvent.click(banner.querySelector('[data-action="abort-operation"]')!)
    await waitFor(() => expect(posted(sent, '/api/v1/repo/merge/abort')).toHaveLength(1))
  })

  it('?compare= shows what the branch brings in from the merge-base', async () => {
    stubFetch({
      'GET /api/v1/repo/compare?ref=feature': () =>
        jsonResponse({ ref: 'feature', against: 'origin/main', mergeBase: 'f'.repeat(40), files: [CHANGES.files[0]], stat: { adds: 2, dels: 0, files: 1 } }),
    })
    renderAt('/git?compare=feature')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-compare-toolbar"]')?.textContent).toContain('vs origin/main'))
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(1))
  })
})

// ---- graph (spec 2026-10-24-git-view §3.1) ----------------------------------------------------

describe('the repo view Graph segment', () => {
  it('draws the rows with task labels, a faded merged branch and the fork point', async () => {
    const sent = stubFetch()
    renderAt('/git/graph')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="graph-row"]')).toHaveLength(3))
    const task = document.querySelector('[data-slot="graph-ref"][data-ref="cez/1a2b3c4d"]')
    expect(task?.textContent).toContain('Fix the login')
    expect(document.querySelector('[data-slot="graph-ref"][data-ref="cez/done0000"]')?.getAttribute('data-merged')).toBe('true')
    expect(document.querySelector('[data-slot="graph-ref"][data-ref="main"]')?.textContent).toContain('HEAD')
    // The root is where the unmerged task forked from main.
    expect(document.querySelector(`[data-slot="graph-row"][data-sha="${'a'.repeat(40)}"] [data-slot="graph-fork"]`)?.textContent).toContain('cez/1a2b3c4d')
    expect(document.querySelector('[data-slot="graph-commit"]')?.getAttribute('href')).toBe(`/git/commits/${'c'.repeat(40)}`)
    expect(sent.some((request) => request.path.startsWith('/api/v1/repo/graph?') && request.path.includes('filter=all'))).toBe(true)

    fireEvent.click(document.querySelector('[data-filter="tasks"]')!)
    await waitFor(() => expect(sent.some((request) => request.path.includes('filter=tasks'))).toBe(true))
  })

  it('search dims commits whose subject and sha do not match', async () => {
    stubFetch()
    renderAt('/git/graph')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="graph-row"]')).toHaveLength(3))
    fireEvent.change(screen.getByLabelText('Search commits'), { target: { value: 'task' } })
    const dimmed = [...document.querySelectorAll('[data-slot="graph-row"]')].filter((row) => row.className.includes('opacity-35'))
    expect(dimmed).toHaveLength(2)
  })
})

// ---- commits ----------------------------------------------------------------------------------

describe('the repo view Commits segment', () => {
  it('lists the recent commits from /api/v1/repo, each row deep-linking to its diff', async () => {
    stubFetch()
    renderAt('/git/commits')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-commits"]')).not.toBeNull())

    // The log is the sidebar's list. (Main repeats it for phones, where the sidebar is a closed
    // sheet, so the rows are counted where a desktop user reads them.)
    const log = document.querySelector('[data-slot="repo-commits"]') as HTMLElement
    expect(sidebar().contains(log)).toBe(true)
    expect(document.querySelector('[data-slot="commit-pick"]')?.textContent).toContain('Pick a commit')
    const rows = [...log.querySelectorAll('[data-slot="commit-row"]')].map((row) => ({
      href: row.getAttribute('href'),
      text: row.textContent,
    }))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.href).toBe('/git/commits/abc1234')
    expect(rows[0]?.text).toContain('abc1234')
    expect(rows[0]?.text).toContain('feat: add the thing')
    expect(rows[0]?.text).toContain('Ada')
    expect(rows[1]?.href).toBe('/git/commits/def5678')
  })

  it('clicking a commit routes to /git/commits/:sha and renders the structured diff', async () => {
    stubFetch()
    renderAt('/git/commits')
    await waitFor(() => expect(document.querySelector('[data-slot="commit-row"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="commit-row"][data-sha="abc1234"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="commit-meta"]')).not.toBeNull())

    // The commit's metadata and its full sha, from ?structured=1.
    const meta = document.querySelector('[data-slot="commit-meta"]')
    expect(meta?.textContent).toContain('feat: add the thing')
    expect(meta?.textContent).toContain('Ada')
    expect(meta?.textContent).toContain(COMMIT.sha)
    // The same <Diff> facade renders the commit's file.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="diff-file"][data-path="notes.md"]')).not.toBeNull(),
    )
    // And the way back is a link, not a dead end.
    expect(document.querySelector('[data-slot="commit-back"]')?.getAttribute('href')).toBe('/git/commits')
  })

  it('an unknown sha is a neutral "Commit not found" with the server reason', async () => {
    stubFetch({
      'GET /api/v1/repo/commit/nope999?structured=1': () =>
        jsonResponse({ error: 'unknown commit: nope999' }, 409),
    })
    renderAt('/git/commits/nope999')
    await waitFor(() =>
      expect(emptyTitles()).toContain('Commit not found'),
    )
    expect(document.querySelector('[data-slot="repo-commit"]')?.textContent).toContain('unknown commit: nope999')
  })

  it('a merge commit (zero files) says so instead of faking a diff', async () => {
    stubFetch({
      'GET /api/v1/repo/commit/abc1234?structured=1': () =>
        jsonResponse({ ...COMMIT, files: [], stat: { adds: 0, dels: 0, files: 0 } }),
    })
    renderAt('/git/commits/abc1234')
    await waitFor(() =>
      expect(emptyTitles()).toContain('No file changes'),
    )
  })
})

// ---- branches ----------------------------------------------------------------------------------

describe('the repo view Branches segment', () => {
  /** A branch's actions sit behind its row's "…" menu (Radix opens it on pointerDown). */
  async function openBranchActions(branch: string) {
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())
    fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for ${branch}` }))
    await screen.findByRole('menu')
    return document.querySelector<HTMLElement>('[data-action="switch-branch"]')!
  }
  async function closeMenu() {
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }
  /** Open the "New branch" popover and hand back its name field. */
  async function openCreate() {
    fireEvent.click(await screen.findByRole('button', { name: 'New branch' }))
    return (await screen.findByLabelText('New branch name')) as HTMLInputElement
  }
  const basePicker = () => screen.findByRole('combobox', { name: 'Agents’ base branch' })

  it('lists branches with the checkout marked current and the rest switchable', async () => {
    stubFetch()
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())

    const current = document.querySelector('[data-slot="branch-row"][data-branch="main"]')
    expect(current?.querySelector('[data-slot="branch-current"]')).not.toBeNull()
    const other = document.querySelector('[data-slot="branch-row"][data-branch="feature"]')
    expect(other?.querySelector('[data-slot="branch-current"]')).toBeNull()

    // Every row carries the same actions menu; "Switch" is disabled on the checkout itself.
    const onCurrent = await openBranchActions('main')
    expect(onCurrent.textContent).toBe('Switch to this branch')
    expect(onCurrent.getAttribute('aria-disabled')).toBe('true')
    await closeMenu()
    const onOther = await openBranchActions('feature')
    expect(onOther.getAttribute('aria-disabled')).not.toBe('true')
    await closeMenu()

    // The sidebar's list marks the checkout too.
    const menu = sidebar().querySelector('[data-slot="repo-branch-menu"]') as HTMLElement
    expect([...menu.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['feature', 'mainCurrent'])
  })

  it('offers no Switch for a branch another worktree holds (telemetry da5ca728)', async () => {
    stubFetch({
      'GET /api/v1/repo': () => jsonResponse({ ...REPO, checkedOutElsewhere: { feature: '/elsewhere' } }),
    })
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="branch-elsewhere"]')).not.toBeNull())
    const row = document.querySelector('[data-slot="branch-row"][data-branch="feature"]')
    expect(row?.querySelector('[data-action="switch-branch"]')).toBeNull()
    expect(row?.querySelector('[data-slot="branch-elsewhere"]')?.getAttribute('title')).toContain('/elsewhere')
  })

  it('Switch POSTs /api/v1/repo/branch and toasts the outcome', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branch': () => jsonResponse({ branch: 'feature', created: false }),
    })
    const client = renderAt('/git/branches')

    fireEvent.click(await openBranchActions('feature'))
    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/repo/branch')
      expect(post?.body).toEqual({ name: 'feature' })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Switched to feature'))
    await waitFor(() => expect(document.querySelector('[data-slot="branch-chip"]')?.textContent).toBe('feature'))
    await waitFor(() => expect(client.getQueryData<HealthResponse>(queryKeys.health)?.repo?.branch).toBe('feature'))
  })

  it('shows how far the checkout is behind origin and pulls on click', async () => {
    const behind = { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 3, fetchedAt: null, topic: null }
    const sync = () => jsonResponse(behind)
    const sent = stubFetch({
      'GET /api/v1/repo/sync': sync,
      'GET /api/v1/repo/sync?refresh=1': sync,
      'POST /api/v1/repo/pull': () => jsonResponse({ updated: 3, sync: { ...behind, behind: 0 } }),
    })
    renderAt('/git')

    const chip = await waitFor(() => within(sidebar()).getByRole('button', { name: 'Pull 3 commits from origin/main' }))
    expect(chip.textContent).toBe('3')
    fireEvent.click(chip)
    await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/repo/pull')).toBe(true))
    await waitFor(() => expect(document.body.textContent).toContain('Pulled 3 commits from origin/main.'))
  })

  it('a diverged checkout is reported, not pulled', async () => {
    const sync = () => jsonResponse({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, fetchedAt: null, topic: null })
    stubFetch({ 'GET /api/v1/repo/sync': sync, 'GET /api/v1/repo/sync?refresh=1': sync })
    renderAt('/git')

    const chip = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="repo-sync-chip"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(chip.dataset.state).toBe('diverged')
    expect(chip.tagName).toBe('SPAN')
    expect(chip.title).toContain('diverged')
  })

  it('filters branch rows without narrowing the base-branch picker', async () => {
    stubFetch()
    renderAt('/git/branches')
    // The filter is the sidebar's; the toolbar repeats it for phones, and both are one state.
    const filter = await waitFor(() => within(sidebar()).getByLabelText('Filter branches'))
    const picker = await basePicker()

    fireEvent.change(filter, { target: { value: 'FEAT' } })
    expect(document.querySelector('[data-slot="branch-row"][data-branch="feature"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="branch-row"][data-branch="main"]')).toBeNull()
    expect(screen.getAllByLabelText<HTMLInputElement>('Filter branches').map((input) => input.value)).toEqual(['FEAT', 'FEAT'])
    expect([...sidebar().querySelectorAll('[data-slot="repo-branch-menu"] li')].map((li) => li.textContent)).toEqual(['feature'])
    // A shadcn Select: its options exist only while it is open (keyboard — jsdom has no pointer).
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Follow checked-out branch (default)',
      'feature',
      'main',
    ])
    fireEvent.keyDown(listbox, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

    fireEvent.change(filter, { target: { value: 'missing' } })
    expect(document.querySelector('[data-slot="branch-empty"]')?.textContent).toContain(
      'No branches match “missing”.',
    )
  })

  it('a switch 409 surfaces git’s own reason as a danger toast', async () => {
    stubFetch({
      'POST /api/v1/repo/branch': () =>
        jsonResponse({ error: 'Your local changes to the following files would be overwritten by checkout' }, 409),
    })
    renderAt('/git/branches')

    fireEvent.click(await openBranchActions('feature'))
    const refusal = await screen.findByText(/Your local changes to the following files/)
    // The danger toast, in git's own words.
    expect(refusal.closest('[data-sonner-toast]')?.getAttribute('data-type')).toBe('error')
  })

  it('the create form POSTs the new name and clears on success', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branch': () => jsonResponse({ branch: 'fresh-idea', created: true }),
    })
    renderAt('/git/branches')
    const input = await openCreate()

    // Empty name → the button stays disabled; nothing fires.
    expect((document.querySelector('[data-action="create-branch"]') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'fresh-idea' } })
    fireEvent.click(document.querySelector('[data-action="create-branch"]')!)
    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/repo/branch')
      expect(post?.body).toEqual({ name: 'fresh-idea' })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Created and switched to fresh-idea'))
    // Success closes the popover, and the field is empty the next time it opens.
    await waitFor(() => expect(document.querySelector('[data-slot="branch-create"]')).toBeNull())
    expect((await openCreate()).value).toBe('')
  })

  it('the base-branch picker PUTs /api/v1/config with the chosen branch (and null to clear)', async () => {
    // A config route that remembers what it was told, so the repo refetch each write triggers
    // reads the new base back — the picker is controlled by the payload, not by the click.
    let baseBranch: string | null = null
    const sent: SentRequest[] = stubFetch({
      'PUT /api/v1/config': () => {
        baseBranch = (sent.at(-1)?.body as { baseBranch: string | null }).baseBranch
        return jsonResponse({ baseBranch, defaultRunner: 'claude' })
      },
      'GET /api/v1/repo': () => jsonResponse({ ...REPO, baseBranch }),
    })
    renderAt('/git/branches')
    const picker = await basePicker()
    // baseBranch: null = follow checked-out branch
    expect(picker.textContent).toContain('Follow checked-out branch (default)')

    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }))
    const puts = () => sent.filter((r) => r.method === 'PUT' && r.path === '/api/v1/config')
    await waitFor(() => expect(puts().map((put) => put.body)).toEqual([{ baseBranch: 'feature' }]))
    await waitFor(() => expect(document.body.textContent).toContain('Agents now branch from feature'))

    // …and "follow the checked-out branch" clears it with an explicit null.
    await waitFor(() => expect(picker.textContent).toContain('feature'))
    expect(document.querySelector('[data-branch="feature"] [data-slot="branch-base"]')).not.toBeNull()
    fireEvent.keyDown(await basePicker(), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Follow checked-out branch (default)' }))
    await waitFor(() => expect(puts().map((put) => put.body)).toEqual([{ baseBranch: 'feature' }, { baseBranch: null }]))
    await waitFor(() => expect(document.body.textContent).toContain('Agents now fork from the checked-out branch'))
  })

  it('forge available: the PR rows render with links and checks badges', async () => {
    stubFetch()
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-prs"]')).not.toBeNull())

    await waitFor(() => expect(document.querySelector('[data-slot="pr-row"]')).not.toBeNull())
    const link = document.querySelector('[data-slot="pr-row"] a')
    expect(link?.getAttribute('href')).toBe('https://github.com/acme/demo/pull/7')
    expect(link?.textContent).toContain('#7')
    expect(link?.textContent).toContain('Improve everything')
    const badge = document.querySelector('[data-slot="pr-checks"]')
    expect(badge?.getAttribute('data-checks')).toBe('passing')
  })

  it('no forge driver: the PR section does not render and /api/v1/github is never fetched', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => jsonResponse({ ...HEALTH, forge: null }),
    })
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())
    // Give the health query time to settle, then assert the honest absence.
    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/health')).toBe(true))
    expect(document.querySelector('[data-slot="repo-prs"]')).toBeNull()
    expect(sent.some((r) => r.path.startsWith('/api/v1/github'))).toBe(false)
  })

  it('forge detected but unreachable: the section renders the reason instead of rows', async () => {
    stubFetch({
      'GET /api/v1/health': () =>
        jsonResponse({ ...HEALTH, forge: { kind: 'github', available: false, reason: 'gh not logged in' } }),
    })
    renderAt('/git/branches')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-branch-list"]')).not.toBeNull())
    // available:false gates the section off entirely — PR links would all be dead ends.
    expect(document.querySelector('[data-slot="repo-prs"]')).toBeNull()
  })
})

// ---- files (#1279) -----------------------------------------------------------------------------

/** One file entry from `GET /api/v1/repo/files`. */
const fileEntry = (path: string, content: string): WorktreeEntry => ({
  type: 'file',
  path,
  size: content.length,
  binary: false,
  tooLarge: false,
  content,
  editable: false,
  editableReason: 'the repository browser is read-only — edit files from a task',
})

const filePath = (path: string) => `/api/v1/repo/files?path=${encodeURIComponent(path)}`

describe('the repo view Branches segment — actions and remotes (spec 2026-10-24-git-view)', () => {
  it('the Remotes block names the PR target, the push default and why', async () => {
    stubFetch()
    renderAt('/git/branches')
    const block = await waitFor(() => {
      const element = document.querySelector('[data-slot="repo-remotes"]')
      expect(element?.querySelectorAll('[data-slot="remote-row"]')).toHaveLength(2)
      return element as HTMLElement
    })
    const upstream = block.querySelector('[data-remote="upstream"]')!
    expect(upstream.textContent).toContain('PR target')
    expect(upstream.textContent).toContain('the repository origin was forked from')
    expect(block.querySelector('[data-remote="origin"]')!.textContent).toContain('Push default')
    // Each branch row says which remotes have it.
    await waitFor(() =>
      expect([...document.querySelectorAll('[data-branch="main"] [data-slot="branch-on-remote"]')].map((el) => el.textContent)).toEqual([
        'origin/',
        'upstream/',
      ]),
    )
  })

  it('merges into current from the row menu', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/branch/feature/merge': () => jsonResponse({ message: 'merged feature into main', conflicts: [] }),
    })
    renderAt('/git/branches')
    const row = await waitFor(() => {
      const element = document.querySelector('[data-slot="branch-row"][data-branch="feature"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    fireEvent.pointerDown(within(row).getByRole('button', { name: 'Actions for feature' }))
    await screen.findByRole('menu')
    fireEvent.click(document.querySelector('[data-action="merge-branch"]')!)
    await waitFor(() => expect(posted(sent, '/api/v1/repo/branch/feature/merge')).toHaveLength(1))
    await waitFor(() => expect(document.body.textContent).toContain('merged feature into main'))
  })
})

describe('the repo view Files segment', () => {
  it('builds the tree from one /api/v1/repo/tree read, folders closed, chains compacted', async () => {
    const sent = stubFetch()
    renderAt('/git/files')

    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())
    // The filter and the tree are the contextual sidebar; main holds only the file.
    expect(sidebar().contains(document.querySelector('[data-slot="repo-files-tree"]'))).toBe(true)
    expect(sidebar().contains(document.querySelector('[data-slot="repo-files-filter"]'))).toBe(true)
    expect(sidebar().contains(document.querySelector('[data-slot="file-preview"]'))).toBe(false)

    const dirs =[...document.querySelectorAll('[data-slot="repo-files-dir"]')].map((el) => ({
      path: el.getAttribute('data-path'),
      text: el.textContent,
      state: el.getAttribute('data-state'),
    }))
    // `packages/web/src` is a single-child chain — one row, not three indent levels.
    expect(dirs).toEqual([
      { path: 'docs', text: 'docs', state: 'closed' },
      { path: 'packages/web/src', text: 'packages/web/src', state: 'closed' },
    ])
    // Root files render; nothing inside a closed folder does.
    expect([...document.querySelectorAll('[data-slot="repo-files-file"]')].map((el) => el.getAttribute('data-path')))
      .toEqual(['.gitignore', 'README.md'])

    // ONE tree request backs the whole view — no per-folder fetch.
    expect(sent.filter((r) => r.path === '/api/v1/repo/tree')).toHaveLength(1)
    expect(document.querySelector('[data-slot="repo-files-truncated"]')).toBeNull()
  })

  // Guard (spec 2026-10-11-code-page §6): the main checkout is writable from the Code page, and
  // `/repo/files` now says a file is editable — this viewer still offers no way to save one.
  it('stays a viewer: no Edit affordance even for a file the server calls editable', async () => {
    const sent = stubFetch({
      [`GET ${filePath('README.md')}`]: () => jsonResponse({ ...fileEntry('README.md', 'hello\n'), editable: true, editableReason: undefined, hash: 'h1' }),
    })
    renderAt('/git/files/README.md')
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview"]')?.textContent).toContain('hello'))
    expect(screen.queryByRole('button', { name: /^(Edit|Save)$/ })).toBeNull()
    expect(sent.some((request) => request.method !== 'GET')).toBe(false)
  })

  it('expanding a folder costs no request and reveals its children', async () => {
    const sent = stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())
    const before = sent.length

    fireEvent.click(document.querySelector('[data-slot="repo-files-dir"][data-path="docs"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="repo-files-file"][data-path="docs/guide.md"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-slot="repo-files-dir"][data-path="docs"]')?.getAttribute('data-state')).toBe('open')
    expect(sent.length).toBe(before)
  })

  it('selecting a file puts it in the URL and previews its highlighted content', async () => {
    stubFetch({
      [`GET ${filePath('README.md')}`]: () => jsonResponse(fileEntry('README.md', 'const x = 1\n')),
    })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="repo-files-file"][data-path="README.md"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-head"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="file-preview-head"]')?.textContent).toContain('README.md')
  })

  it('a deep link selects the file and expands its ancestors', async () => {
    stubFetch({
      [`GET ${filePath('packages/web/src/lib/x.ts')}`]: () =>
        jsonResponse(fileEntry('packages/web/src/lib/x.ts', 'export const x = 1\n')),
    })
    renderAt('/git/files/packages/web/src/lib/x.ts')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="repo-files-file"][data-path="packages/web/src/lib/x.ts"]')).not.toBeNull(),
    )
    const chain = document.querySelector('[data-slot="repo-files-dir"][data-path="packages/web/src"]')
    expect(chain?.getAttribute('data-state')).toBe('open')
    expect(document.querySelector('[data-slot="repo-files-dir"][data-path="packages/web/src/lib"]')?.getAttribute('data-state'))
      .toBe('open')
    expect(
      document.querySelector('[data-slot="repo-files-file"][data-path="packages/web/src/lib/x.ts"]')
        ?.getAttribute('aria-current'),
    ).toBe('true')
    // The closed sibling stays closed — only the selection's ancestors open.
    expect(document.querySelector('[data-slot="repo-files-dir"][data-path="docs"]')?.getAttribute('data-state')).toBe('closed')
  })

  it("the server's 409 for a non-indexed path is shown as an answer, not an outage", async () => {
    stubFetch({
      [`GET ${filePath('README.md')}`]: () =>
        jsonResponse({ error: 'path is not in the repository index: README.md' }, 409),
    })
    renderAt('/git/files/README.md')
    await waitFor(() => expect(screen.getByText('Cannot preview this file')).not.toBeNull())
    expect(screen.getByText('path is not in the repository index: README.md')).not.toBeNull()
  })

  it('renders a .md file as markdown by default, with a toggle to the source', async () => {
    stubFetch({
      [`GET ${filePath('docs/guide.md')}`]: () =>
        jsonResponse(fileEntry('docs/guide.md', '# Heading\n\n- one\n- two\n')),
    })
    renderAt('/git/files/docs/guide.md')

    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-markdown"]')).not.toBeNull())
    // Real elements, not the raw text: the heading and the list are parsed.
    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).not.toBeNull()
    expect(document.querySelectorAll('[data-slot="file-preview-markdown"] li')).toHaveLength(2)

    fireEvent.click(document.querySelector('[data-slot="markdown-view-toggle"] [data-mode="source"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-code"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="file-preview-code"]')?.textContent).toContain('# Heading')

    // …and back, so the toggle is a real two-way control.
    fireEvent.click(document.querySelector('[data-slot="markdown-view-toggle"] [data-mode="rendered"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-markdown"]')).not.toBeNull())
  })

  it('a non-markdown file gets no view toggle at all', async () => {
    stubFetch({
      [`GET ${filePath('packages/web/src/app.tsx')}`]: () =>
        jsonResponse(fileEntry('packages/web/src/app.tsx', 'export const App = () => null\n')),
    })
    renderAt('/git/files/packages/web/src/app.tsx')
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-code"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="markdown-view-toggle"]')).toBeNull()
  })

  it('a truncated index says so above the tree', async () => {
    stubFetch({
      'GET /api/v1/repo/tree': () => jsonResponse({ paths: TREE.paths, truncated: true }),
    })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-truncated"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="repo-files-truncated"]')?.textContent).toContain('has more')
  })

  it('an empty index is an honest empty state, not a blank pane', async () => {
    stubFetch({ 'GET /api/v1/repo/tree': () => jsonResponse({ paths: [], truncated: false }) })
    renderAt('/git/files')
    await waitFor(() => expect(screen.getByText('No files yet')).not.toBeNull())
    expect(document.querySelector('[data-slot="repo-files-tree"]')).toBeNull()
  })

  it('a 409 from /repo/tree is the view-level answer, same stance as the Changes tab', async () => {
    stubFetch({
      'GET /api/v1/repo/tree': () => jsonResponse({ error: 'not a git repository' }, 409),
    })
    renderAt('/git/files')
    await waitFor(() => expect(screen.getByText('No files to browse')).not.toBeNull())
  })
})

// ---- the filter box and keyboard access (#1279 Phase 2) ----------------------------------------

const filterInput = () => document.querySelector('[data-slot="repo-files-filter"]') as HTMLInputElement
const rowPaths = () =>
  [...document.querySelectorAll('[data-slot="repo-files-file"], [data-slot="repo-files-dir"]')].map((el) =>
    el.getAttribute('data-path'),
  )

describe('the repo Files filter', () => {
  it('flattens to full paths as you type, and Escape restores the tree', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-filter"]')).not.toBeNull())

    // A subsequence spanning three directories — the case that justifies subsequence matching.
    fireEvent.change(filterInput(), { target: { value: 'weblibx' } })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="repo-files-tree"]')?.getAttribute('data-filtering')).toBe('true'),
    )
    // A result list of FULL paths — not a filtered hierarchy that hides the match behind a
    // collapsed ancestor — and no folder rows at all.
    expect(rowPaths()).toEqual(['packages/web/src/lib/x.ts'])
    expect(document.querySelector('[data-slot="repo-files-file"]')?.textContent).toBe('packages/web/src/lib/x.ts')

    fireEvent.keyDown(filterInput(), { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-dir"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="repo-files-tree"]')?.getAttribute('data-filtering')).toBeNull()
  })

  it('selecting a filtered result opens the file', async () => {
    stubFetch({
      [`GET ${filePath('docs/guide.md')}`]: () => jsonResponse(fileEntry('docs/guide.md', '# G\n')),
    })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-filter"]')).not.toBeNull())

    fireEvent.change(filterInput(), { target: { value: 'guide' } })
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-file"][data-path="docs/guide.md"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-slot="repo-files-file"][data-path="docs/guide.md"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-head"]')?.textContent).toContain('docs/guide.md'))
  })

  it('caps the rendered matches and says how many more there are', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `src/file-${String(i).padStart(3, '0')}.ts`)
    stubFetch({ 'GET /api/v1/repo/tree': () => jsonResponse({ paths: many, truncated: false }) })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-filter"]')).not.toBeNull())

    fireEvent.change(filterInput(), { target: { value: 'file' } })
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-more"]')).not.toBeNull())
    expect(document.querySelectorAll('[data-slot="repo-files-file"]')).toHaveLength(200)
    expect(document.querySelector('[data-slot="repo-files-more"]')?.textContent).toContain('50 more')
  })

  it('no match says so, naming the query, instead of an empty pane', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-filter"]')).not.toBeNull())

    fireEvent.change(filterInput(), { target: { value: 'zzzzzzz' } })
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-no-match"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="repo-files-no-match"]')?.textContent).toContain('zzzzzzz')
    expect(document.querySelector('[data-slot="repo-files-tree"]')).toBeNull()
  })

  it('announces the result count in a polite live region', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-count"]')).not.toBeNull())
    const count = document.querySelector('[data-slot="repo-files-count"]')!
    expect(count.getAttribute('aria-live')).toBe('polite')
    expect(count.textContent).toBe('5 files')

    fireEvent.change(filterInput(), { target: { value: 'md' } })
    await waitFor(() => expect(count.textContent).toContain('match md'))
  })

  it('`/` focuses the filter from the tree, and does not hijack typing inside it', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())

    fireEvent.keyDown(document.querySelector('[data-slot="repo-files-tree"]')!, { key: '/' })
    await waitFor(() => expect(document.activeElement).toBe(filterInput()))
    // Already inside the input, `/` is just a character — the handler must not preventDefault it.
    expect(fireEvent.keyDown(filterInput(), { key: '/' })).toBe(true)
  })
})

describe('the repo Files tree keyboard access', () => {
  const tree = () => document.querySelector('[data-slot="repo-files-tree"]')!

  it('is a role=tree of treeitems with levels, aria-expanded and a roving tabindex', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())

    expect(tree().getAttribute('role')).toBe('tree')
    expect(tree().getAttribute('aria-label')).toBe('Repository files')
    const dir = document.querySelector('[data-slot="repo-files-dir"][data-path="docs"]')!
    expect(dir.getAttribute('role')).toBe('treeitem')
    expect(dir.getAttribute('aria-expanded')).toBe('false')
    expect(dir.getAttribute('aria-level')).toBe('1')
    // Exactly one row is tabbable — the rest are reachable by arrow key.
    const tabbable = [...document.querySelectorAll('[role="treeitem"]')].filter((el) => el.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tree().getAttribute('aria-activedescendant')).toBe(tabbable[0]!.getAttribute('id'))
  })

  it('↓/↑ move the active row, →/← expand and collapse, Enter opens a file', async () => {
    stubFetch({
      [`GET ${filePath('.gitignore')}`]: () => jsonResponse(fileEntry('.gitignore', 'node_modules\n')),
    })
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())
    const activePath = () =>
      document.querySelector('[role="treeitem"][tabindex="0"]')?.getAttribute('data-path')

    // Rows: docs, packages/web/src, .gitignore, README.md.
    expect(activePath()).toBe('docs')
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    await waitFor(() => expect(activePath()).toBe('packages/web/src'))
    fireEvent.keyDown(tree(), { key: 'ArrowUp' })
    await waitFor(() => expect(activePath()).toBe('docs'))

    // → opens the folder, → again steps into it, ← comes back out to the parent.
    fireEvent.keyDown(tree(), { key: 'ArrowRight' })
    await waitFor(() => expect(document.querySelector('[data-path="docs"]')?.getAttribute('data-state')).toBe('open'))
    fireEvent.keyDown(tree(), { key: 'ArrowRight' })
    await waitFor(() => expect(activePath()).toBe('docs/guide.md'))
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' })
    await waitFor(() => expect(activePath()).toBe('docs'))
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' })
    await waitFor(() => expect(document.querySelector('[data-path="docs"]')?.getAttribute('data-state')).toBe('closed'))

    // Enter on a file selects it.
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    await waitFor(() => expect(activePath()).toBe('.gitignore'))
    fireEvent.keyDown(tree(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('[data-slot="file-preview-head"]')?.textContent).toContain('.gitignore'))
  })

  it('↑ at the top and ↓ at the bottom stay put rather than wrapping or crashing', async () => {
    stubFetch()
    renderAt('/git/files')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-files-tree"]')).not.toBeNull())
    const activePath = () =>
      document.querySelector('[role="treeitem"][tabindex="0"]')?.getAttribute('data-path')

    fireEvent.keyDown(tree(), { key: 'ArrowUp' })
    await waitFor(() => expect(activePath()).toBe('docs'))
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    await waitFor(() => expect(activePath()).toBe('README.md'))
  })
})

// ---- sync (spec 2026-10-19-repo-git-sync) ------------------------------------------------------

describe('the repo view sync strip', () => {
  it('names the upstream and shows ↑ahead ↓behind in the header', async () => {
    stubFetch()
    renderAt('/git')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-upstream"]')?.textContent).toBe('→ origin/main'))
    expect(document.querySelector('[data-sync="ahead"]')?.textContent).toBe('↑1')
    expect(document.querySelector('[data-sync="behind"]')?.textContent).toBe('↓1')
  })

  it('Commits lists incoming commits first and marks the local one', async () => {
    stubFetch()
    renderAt('/git/commits')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-incoming"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="repo-incoming"]')?.textContent).toContain('feat: teammate work')
    const local = document.querySelector('[data-slot="repo-commits"] [data-sha="abc1234"] [data-slot="commit-sync"]')
    expect(local?.getAttribute('data-sync')).toBe('outgoing')
    expect(document.querySelector('[data-slot="repo-commits"] [data-sha="def5678"] [data-slot="commit-sync"]')).toBeNull()
  })

  it('Pull POSTs /api/v1/repo/pull, toasts the outcome and adopts the returned status', async () => {
    const sent = stubFetch({
      'POST /api/v1/repo/pull': () =>
        jsonResponse({ message: 'pulled 1 commit', sync: { ...SYNC, behind: 0, incoming: [] } }),
    })
    renderAt('/git')
    await waitFor(() => expect(document.querySelector('[data-action="repo-pull"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="repo-pull"]')!)
    await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/repo/pull')).toBe(true))
    await waitFor(() => expect(document.body.textContent).toContain('pulled 1 commit'))
    await waitFor(() => expect(document.querySelector('[data-sync="behind"]')).toBeNull())
  })

  it('a refused pull shows git\'s reason as a danger toast', async () => {
    stubFetch({
      'POST /api/v1/repo/pull': () => jsonResponse({ error: 'origin/main has diverged' }, 409),
    })
    renderAt('/git')
    await waitFor(() => expect(document.querySelector('[data-action="repo-pull"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="repo-pull"]')!)
    await waitFor(() => expect(document.body.textContent).toContain('origin/main has diverged'))
  })

  it('an unpublished branch offers Publish instead of Pull/Push', async () => {
    stubFetch({
      'GET /api/v1/repo/sync': () =>
        jsonResponse({ ...SYNC, branch: 'feature', upstream: null, ahead: null, behind: null, incoming: [] }),
    })
    renderAt('/git')
    await waitFor(() => expect(document.querySelector('[data-slot="repo-upstream"]')?.textContent).toBe('not published'))
    expect(document.querySelector('[data-action="repo-push"]')?.textContent).toContain('Publish branch')
    expect(document.querySelector('[data-action="repo-pull"]')).toBeNull()
  })

  it('branch rows carry their tracking state', async () => {
    stubFetch()
    renderAt('/git/branches')
    await waitFor(() =>
      expect(document.querySelector('[data-branch="feature"] [data-slot="branch-tracking"]')?.textContent).toBe('local only'),
    )
    expect(document.querySelector('[data-branch="main"] [data-sync="ahead"]')?.textContent).toBe('↑1')
  })
})
