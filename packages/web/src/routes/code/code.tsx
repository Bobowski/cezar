import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BotIcon, ColumnsIcon, EyeIcon, FilesIcon, GitBranchIcon, GitCompareArrowsIcon, GlobeIcon, Maximize2Icon, Minimize2Icon, PanelBottomIcon,
  PanelLeftIcon, SearchIcon, XIcon,
} from 'lucide-react'
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { queryScope, type ApiRun, type ChangedFile, type CodePage, type UiState } from '@open-mercato/cezar-api-client'
import { ApiError, createRun, putUiState } from '@/api/client'
import {
  codeFileRawUrl, getCodeChanges, getCodeFile, getCodeTree, getCodeWatch, renameCodeFile, saveCodeFile, treeKey, type CodeTree,
} from '@/api/code'
import { useHostTransport } from '@/api/host-usage'
import { queryKeys, useHealth, useRepo, useRuns, useUiState } from '@/api/queries'
import { subscribeTopic } from '@/api/ws'
import type { CursorPosition, LineMark } from '@/components/code-mirror-editor'
import { ContextSidebar } from '@/components/context-sidebar'
import { Diff } from '@/components/diff'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Kbd } from '@/components/ui/kbd'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RepoSyncChip } from '@/components/repo-sync-chip'
import { SidebarContent, SidebarHeader, useSidebar } from '@/components/ui/sidebar'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'
import { clientSurface } from '@/lib/telemetry'
import { cn } from '@/lib/utils'
import { FILE_DRAG_TYPE } from '@/routes/repo-git/repo-files'
import { isImagePath } from '@/routes/task-git/worktree-files'
import { Markdown } from '@/routes/task-thread/markdown'

import { AgentTab, DEFAULT_AGENT_WORKFLOW } from './code-agent'
import { CodeBrowserTab, OpenBrowserTabContext, useDetectedAddresses, type OpenBrowserTab } from './code-browser'
import { MenuItems, type MenuItem } from './code-menu'
import { CommandPalette, FileDialog, QuickOpen, type CodeCommand, type FileAction } from './code-palette'
import { appAddress, cockpitLocation, pageTitle } from './code-pages'
import { CodePanelView } from './code-panel'
import { ExplorerView, ScmView, SearchView, type ExplorerTarget } from './code-sidebar'
import {
  agentId, browserId, browserTabs, bufferFrom, closeOthers, closeTab, diffTab, focusBrowserTab, focusedGroup, isAgentTab, isBrowserTab, isDiffTab,
  isDirty, isFileTab, isToolTab, keepTab, languageOf, lineMarksFromPatch, loadDraft, loadLayout, markSaved, MIN_GROUP_SIZE, newTabId, openAgent, openBrowserTab,
  openPaths, openTab, openToSide, pagesOf, pruneTools, reconcile, resolveConflict, restorePages, retargetTab, saveDraft, saveLayout, savedPagesFor,
  stepTab, tabFile, tabLabel, updateGroup, updateGroups, withPages, type Buffer, type CodeBrowser,
  type CodeLayout, type CodePanel, type CodeSidebar, type TabsState,
} from './code-state'

const CodeMirrorEditor = lazy(() => import('@/components/code-mirror-editor'))

/** One open file as the page holds it. Only a text file has a `buffer`. */
type OpenFile =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'image' }
  | { status: 'unsupported'; reason: string }
  | { status: 'ready'; buffer: Buffer; editable: boolean; reason: string | null }

/** What a dragged editor tab carries: its path and the group it came from. */
const TAB_DRAG_TYPE = 'application/x-cezar-tab'
const STATUS_LETTER: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C' }
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const KEY_NAMES: Record<string, [mac: string, other: string]> = { Mod: ['⌘', 'Ctrl'], Shift: ['⇧', 'Shift'], Alt: ['⌥', 'Alt'], Ctrl: ['⌃', 'Ctrl'] }
/** A shortcut as the menus print it. */
const keys = (...parts: string[]) => parts.map((part) => KEY_NAMES[part]?.[MAC ? 0 : 1] ?? part).join(MAC ? '' : '+')
/** New page: Ctrl/Cmd+T reaches the page only in the desktop shell; a browser keeps it, so Alt+T. */
const newPageKeys = (beside: boolean) => keys(clientSurface() === 'desktop' ? 'Mod' : 'Alt', ...(beside ? ['Shift'] : []), 'T')
/** The Code page's bottom panel: a terminal there owns its own Alt keys (readline's Alt+T). */
const inPanel = (target: EventTarget | null) => target instanceof Element && target.closest('[data-slot="code-panel"]') !== null
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path)
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const storage = (): Storage | null => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** A task whose worktree can be opened here. */
export function checkoutRuns(runs: readonly ApiRun[] | undefined): ApiRun[] {
  return (runs ?? []).filter((run) => typeof run.worktreePath === 'string' && run.worktreePath !== '' && !run.archived)
}

/**
 * `/p/:projectId/code[/*]` — an editor for the project, with no task required (spec
 * `.ai/specs/2026-10-11-code-page.md`). `?tree=<runId>` selects a task's worktree; absent is the
 * main checkout. Keyed by checkout: tabs, buffers and panel belong to one tree. `?terminal=<id>`
 * opens the panel on that terminal session (Docker's Exec, spec 2026-10-23-docker-management §3.5).
 */
export function CodeRoute() {
  const params = useParams()
  const [search] = useSearchParams()
  const runId = search.get('tree')
  const terminal = search.get('terminal')
  const tree = useMemo<CodeTree>(() => (runId ? { kind: 'run', runId } : { kind: 'main' }), [runId])
  const path = params['*'] !== undefined && params['*'] !== '' ? params['*'] : null
  return <CodeWorkbench key={`${queryScope()}:${treeKey(tree)}`} tree={tree} initialPath={path} initialTerminal={terminal} />
}

function CodeWorkbench({ tree, initialPath, initialTerminal = null }: { tree: CodeTree; initialPath: string | null; initialTerminal?: string | null }) {
  const projectId = queryScope()
  const key = treeKey(tree)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const transport = useHostTransport()
  const capabilities = useHealth().data?.capabilities
  const fileEdit = capabilities?.fileEdit === true
  const terminalAllowed = capabilities?.terminal === true
  const runs = useRuns()
  const repo = useRepo()

  const [layout, setLayout] = useState<CodeLayout>(() => {
    const loaded = loadLayout(storage(), projectId, key)
    const stored = initialTerminal ? { ...loaded, panel: 'terminal' as const } : loaded
    return initialPath ? updateGroup(stored, stored.focused, (group) => openTab(group, initialPath, true)) : stored
  })
  const [files, setFiles] = useState<Record<string, OpenFile>>({})
  // Asks aimed at ONE group's editor. Tied to the group that was focused when asked, so moving
  // focus later does not replay them in the other group.
  const [reveal, setReveal] = useState<{ group: number; path: string; line: number; nonce: number } | null>(null)
  const [dialog, setDialog] = useState<FileAction | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [palette, setPalette] = useState(false)
  const [discarding, setDiscarding] = useState<{ group: number; path: string } | null>(null)
  const [rendered, setRendered] = useState<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = useState<CursorPosition | null>(null)
  const [searchFocus, setSearchFocus] = useState(0)
  const [gotoLine, setGotoLine] = useState({ group: 0, nonce: 0 })
  const [find, setFind] = useState({ group: 0, nonce: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  // Full screen draws the sidebar itself, so hiding it is the page's to do as well.
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [moving, setMoving] = useState<{ from: string; to: string } | null>(null)
  const shell = useSidebar()
  const filesRef = useRef(files)
  filesRef.current = files
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const group = focusedGroup(layout)
  const activeTab = group.active
  // The file the focused tab is about: itself, or the file a diff tab compares. A browser has none.
  const active = activeTab === null || isToolTab(activeTab) ? null : tabFile(activeTab)
  const current = active !== null && activeTab !== null && isFileTab(activeTab) ? files[active] : undefined

  const treeQuery = useQuery({ queryKey: ['code', 'tree', projectId, key], queryFn: ({ signal }) => getCodeTree(tree, { signal }) })
  const changes = useQuery({ queryKey: ['code', 'changes', projectId, key], queryFn: ({ signal }) => getCodeChanges(tree, { signal }) })
  const watch = useQuery({ queryKey: ['code', 'watch', projectId, key], queryFn: ({ signal }) => getCodeWatch(tree, { signal }), staleTime: Infinity })
  const changed = useMemo(() => changes.data?.files ?? [], [changes.data])
  const changedByPath = useMemo(() => new Map(changed.map((file) => [file.path, file])), [changed])
  const marks = useMemo(() => new Map(changed.map((file) => [file.path, STATUS_LETTER[file.status] ?? 'M'])), [changed])
  const lineMarks = useMemo(
    () => new Map(changed.filter((file) => !file.binary && file.patch !== '').map((file) => [file.path, lineMarksFromPatch(file.patch)] as const)),
    [changed],
  )
  const paths = treeQuery.data?.paths ?? []
  const run = tree.kind === 'run' ? runs.data?.find((candidate) => candidate.id === tree.runId) : undefined
  const root = tree.kind === 'main' ? repo.data?.info?.root : run?.worktreePath
  const branch = tree.kind === 'main' ? repo.data?.info?.branch : run?.branch

  useEffect(() => saveLayout(storage(), projectId, key, pruneTools(layout)), [layout, projectId, key])

  // The pages also live on the server, per project (spec 2026-10-24-code-page-browser-tabs §3):
  // folded in once its answer arrives, and written back only after that — never over an answer
  // this page has not read. A failed read leaves the pages to this browser alone.
  const uiState = useUiState()
  const [pagesRestored, setPagesRestored] = useState(false)
  useEffect(() => {
    if (pagesRestored || !uiState.isSuccess) return
    setLayout((state) => restorePages(state, savedPagesFor(uiState.data.codePages, key)))
    setPagesRestored(true)
  }, [key, pagesRestored, uiState.data, uiState.isSuccess])
  const pagesJson = JSON.stringify(pagesOf(layout))
  useEffect(() => {
    if (!pagesRestored) return
    const timer = setTimeout(() => {
      const cached = queryClient.getQueryData<UiState>(queryKeys.uiState)
      const saved = savedPagesFor(cached?.codePages, key)
      // A checkout never saved and still without pages is not worth a slot on the server.
      if (JSON.stringify(saved ?? []) === pagesJson) return
      const codePages = withPages(cached?.codePages, key, JSON.parse(pagesJson) as CodePage[])
      queryClient.setQueryData<UiState>(queryKeys.uiState, (prev) => ({ ...prev, codePages }))
      // Layout is state: a failed write costs another device the latest pages, nothing more.
      putUiState({ codePages }).then((merged) => {
        queryClient.setQueryData(queryKeys.uiState, merged)
        // Only a page the server's answer names is held; until then its list cannot close it.
        setLayout((state) => markSaved(state, savedPagesFor(merged.codePages, key) ?? []))
      }, () => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [key, pagesJson, pagesRestored, queryClient])

  // The focused file's path IS the page's address, replaced rather than pushed (as `/git/files`).
  useEffect(() => {
    const query = tree.kind === 'run' ? `?tree=${encodeURIComponent(tree.runId)}` : ''
    navigate(`${active ? `/code/${encodePath(active)}` : '/code'}${query}`, { replace: true })
  }, [active, navigate, tree])

  const setFile = useCallback((path: string, next: OpenFile | ((file: OpenFile | undefined) => OpenFile | undefined)) => {
    setFiles((all) => {
      const value = typeof next === 'function' ? next(all[path]) : next
      if (value === all[path]) return all
      if (value === undefined) {
        const { [path]: _gone, ...rest } = all
        return rest
      }
      return { ...all, [path]: value }
    })
  }, [])

  /** Read `path` from disk and fold it into what the page holds. */
  const load = useCallback(async (path: string) => {
    try {
      const entry = await getCodeFile(tree, path)
      if (entry.type !== 'file') return setFile(path, { status: 'unsupported', reason: 'This is a directory.' })
      if (isImagePath(path)) return setFile(path, { status: 'image' })
      if (entry.binary || entry.tooLarge || entry.content === undefined || entry.hash === undefined) {
        return setFile(path, { status: 'unsupported', reason: entry.editableReason ?? (entry.tooLarge ? 'This file is too large to open here.' : 'This file is not text.') })
      }
      const disk = { content: entry.content, hash: entry.hash }
      setFile(path, (file) => ({
        status: 'ready',
        buffer: file?.status === 'ready' ? reconcile(file.buffer, disk) : bufferFrom(disk, loadDraft(storage(), projectId, key, path)),
        editable: entry.editable,
        reason: entry.editableReason ?? null,
      }))
    } catch (error) {
      // A file that is open and merely failed to RE-read keeps its buffer.
      setFile(path, (file) => (file?.status === 'ready' ? file : { status: 'error', error: (error as Error).message }))
    }
  }, [key, projectId, setFile, tree])

  // Every group's active file is loaded; a diff tab reads the changes, not the file.
  useEffect(() => {
    for (const each of layout.groups) {
      if (each.active === null || !isFileTab(each.active) || files[each.active] !== undefined) continue
      setFile(each.active, { status: 'loading' })
      void load(each.active)
    }
  }, [files, layout.groups, load, setFile])

  /** Disk may have moved: re-read what is open, and what the tree and its marks are built from. */
  const revalidate = useCallback(() => {
    for (const [path, file] of Object.entries(filesRef.current)) if (file.status === 'ready') void load(path)
    void queryClient.invalidateQueries({ queryKey: ['code', 'tree', projectId, key] })
    void queryClient.invalidateQueries({ queryKey: ['code', 'changes', projectId, key] })
  }, [key, load, projectId, queryClient])

  const topic = watch.data?.topic ?? null
  useEffect(() => {
    if (transport !== 'local' || !topic) return
    return subscribeTopic(topic, revalidate, () => {})
  }, [revalidate, topic, transport])
  // The floor wherever there is no bell: look again when the window is looked at again.
  useEffect(() => {
    window.addEventListener('focus', revalidate)
    return () => window.removeEventListener('focus', revalidate)
  }, [revalidate])

  const dirtyPaths = Object.entries(files).filter(([, file]) => file.status === 'ready' && isDirty(file.buffer)).map(([path]) => path)
  const anyDirty = dirtyPaths.length > 0
  useEffect(() => {
    if (!anyDirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])

  const edit = (at: number, path: string, text: string) => {
    setLayout((state) => updateGroup(state, at, (each) => keepTab(each, path)))
    setFile(path, (file) => {
      if (file?.status !== 'ready') return file
      const buffer = { ...file.buffer, draft: text === file.buffer.content ? null : text }
      saveDraft(storage(), projectId, key, path, buffer)
      return { ...file, buffer }
    })
  }

  const save = useCallback(async (path: string, overwrite = false) => {
    const file = filesRef.current[path]
    if (file?.status !== 'ready' || !isDirty(file.buffer)) return
    const buffer = overwrite ? resolveConflict(file.buffer, 'overwrite') : file.buffer
    const text = buffer.draft as string
    try {
      const saved = await saveCodeFile(tree, path, text, buffer.hash)
      setFile(path, (latest) => {
        if (latest?.status !== 'ready') return latest
        // Typing went on while the save was in flight: the new text is the disk's, the rest stays a draft.
        const draft = latest.buffer.draft !== null && latest.buffer.draft !== text ? latest.buffer.draft : null
        const next: Buffer = { content: text, hash: saved.hash, draft, conflict: null }
        saveDraft(storage(), projectId, key, path, next)
        return { ...latest, buffer: next }
      })
      void queryClient.invalidateQueries({ queryKey: ['code', 'changes', projectId, key] })
    } catch (error) {
      // A refusal may be the other writer: re-read, which raises the banner if disk moved.
      if (error instanceof ApiError && error.status === 409) void load(path)
      toast((error as Error).message, { tone: 'danger' })
    }
  }, [key, load, projectId, queryClient, setFile, tree])

  const open = useCallback((path: string, options: { line?: number; keep?: boolean; side?: boolean } = {}) => {
    setLayout((state) => (options.side ? openToSide(state, path) : updateGroup(state, state.focused, (each) => openTab(each, path, options.keep ?? true))))
    if (options.line !== undefined) setReveal((previous) => ({ group: options.side ? -1 : layoutRef.current.focused, path, line: options.line as number, nonce: (previous?.nonce ?? 0) + 1 }))
  }, [])

  /** Forget a file no tab shows any more. */
  const dropIfClosed = (next: CodeLayout, tab: string) => {
    if (!isFileTab(tab) || openPaths(next).includes(tab)) return
    saveDraft(storage(), projectId, key, tab, undefined)
    setFile(tab, () => undefined)
  }

  const close = (at: number, tab: string, discard = false) => {
    const file = files[tab]
    const elsewhere = layout.groups.some((each, index) => index !== at && each.tabs.some((other) => other.path === tab))
    if (!discard && !elsewhere && isFileTab(tab) && file?.status === 'ready' && isDirty(file.buffer)) return setDiscarding({ group: at, path: tab })
    setDiscarding(null)
    const next = updateGroup(layout, at, (each) => closeTab(each, tab))
    dropIfClosed(next, tab)
    setLayout(next)
  }

  /** Close several tabs of one group. Unsaved ones stay: this never asks, so it never discards. */
  const closeMany = (at: number, wantedOf: (each: TabsState) => TabsState) => {
    const target = layout.groups[at]
    if (!target) return
    const wanted = wantedOf(target)
    const tabs = target.tabs.filter((tab) => wanted.tabs.some((other) => other.path === tab.path) || dirtyPaths.includes(tab.path))
    const activeNext = tabs.some((tab) => tab.path === wanted.active) ? wanted.active : tabs[0]?.path ?? null
    const next = updateGroup(layout, at, () => ({ tabs, active: activeNext }))
    for (const tab of target.tabs) if (!tabs.some((other) => other.path === tab.path)) dropIfClosed(next, tab.path)
    setLayout(next)
  }

  const togglePanel = useCallback((panel: CodePanel | null) => setLayout((state) => ({ ...state, panel })), [])
  /** Show a sidebar view — and the contextual sidebar itself, if the shell has it folded away. */
  const showSidebar = (view: CodeSidebar) => {
    setLayout((state) => ({ ...state, sidebar: view }))
    setSidebarHidden(false)
    if (shell.isMobile) shell.setOpenMobile(true)
    else if (!shell.open) shell.setOpen(true)
  }
  const toggleSidebar = () => (fullscreen ? setSidebarHidden((hidden) => !hidden) : shell.toggleSidebar())
  /** Where Ctrl/Cmd+T last asked for the cursor: that tab's address bar. */
  const [addressFocus, setAddressFocus] = useState<{ id: string; nonce: number } | null>(null)
  const [gateways, setGateways] = useState<Record<string, string>>({})
  /** A new page — blank, with the cursor in its address bar — here or beside (spec §3). */
  const newPage = (beside = false) => {
    const id = newTabId()
    setLayout((state) => openBrowserTab(state, '', { beside, id }))
    setAddressFocus((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }))
  }
  const openPage: OpenBrowserTab = useCallback((url, options = {}) => {
    const checked = appAddress(url, cockpitLocation())
    if (!checked.ok) return false
    setLayout((state) => openBrowserTab(state, checked.url, { beside: options.beside ?? false }))
    return true
  }, [])
  const setBrowser = (id: string, next: CodeBrowser) => setLayout((state) => ({ ...state, browsers: { ...state.browsers, [id]: next } }))
  const setGateway = useCallback((id: string, origin: string | null) => setGateways((all) => {
    if ((all[id] ?? null) === origin) return all
    const { [id]: _gone, ...rest } = all
    return origin === null ? rest : { ...rest, [id]: origin }
  }), [])
  const detected = useDetectedAddresses(tree)
  const newId = newTabId
  /** An agent tab for `runId` (`null`: a new task) — the one already showing it, if there is one. */
  const openAgentTab = (runId: string | null, side = false) => setLayout((state) => openAgent(state, newId(), runId, side))

  // Full screen: the page takes the window, and the window takes the display where the browser
  // allows it. Leaving either way (the button, or the browser's own Esc) leaves both.
  const toggleFullscreen = () => {
    const next = !fullscreen
    setFullscreen(next)
    if (next) void document.documentElement.requestFullscreen?.().catch(() => {})
    else if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {})
  }
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFullscreen(false) }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const created = async (input: { task: string; workflow: string }): Promise<string> => {
    const answer = await createRun({ workflow: input.workflow, task: input.task })
    const started = 'runs' in answer ? answer.runs[0] : answer
    if (!started) throw new Error('The task was not created.')
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.list() })
    return started.id
  }
  /** Start a task from somewhere that is not an agent tab (a Design Mode note): it opens beside. */
  const startTask = async (input: { task: string; workflow: string }) => openAgentTab(await created(input), true)
  /** Start a task from an agent tab's own form: that tab becomes the task's. */
  const startTaskIn = async (id: string, input: { task: string; workflow: string }) => {
    const runId = await created(input)
    setLayout((state) => ({ ...state, agents: { ...state.agents, [id]: runId } }))
  }
  // Where a browser tab's Design Mode notes go: the task of an open agent tab (the first one that
  // has a task), else — in a task's own worktree — that task, else a new task per note.
  const agentRunId = layout.groups.flatMap((each) => each.tabs).map((tab) => (isAgentTab(tab.path) ? layout.agents[agentId(tab.path)] : null)).find((id) => id != null)
    ?? (tree.kind === 'run' ? tree.runId : null)
  const agentRun = agentRunId === null ? null : runs.data?.find((candidate) => candidate.id === agentRunId) ?? null
  const agentTitles = useMemo(() => {
    const titles: Record<string, string> = {}
    for (const [id, runId] of Object.entries(layout.agents)) {
      const shown = runId === null ? undefined : runs.data?.find((candidate) => candidate.id === runId)
      if (shown) titles[id] = runTitle(shown)
    }
    return titles
  }, [layout.agents, runs.data])
  // The file an agent tab offers as context: the last one focused, since the agent tab itself has none.
  const lastFile = useRef<string | null>(null)
  if (active !== null) lastFile.current = active
  const toggleRendered = (path: string) => setRendered((set) => {
    const next = new Set(set)
    if (!next.delete(path)) next.add(path)
    return next
  })
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Could not copy', { tone: 'danger' })) }
  const absolute = (path: string) => (root ? `${root}/${path}` : path)

  const afterFileOp = (from: string | null, to: string | null) => {
    if (from !== null) {
      saveDraft(storage(), projectId, key, from, undefined)
      setFile(from, () => undefined)
      setLayout((state) => updateGroups(updateGroups(state, (each) => retargetTab(each, from, to)), (each) => retargetTab(each, diffTab(from), null)))
    } else if (to !== null) {
      open(to)
    }
    revalidate()
  }

  const askGotoLine = () => setGotoLine((value) => ({ group: layoutRef.current.focused, nonce: value.nonce + 1 }))
  const here = active ? dirOf(active) : ''
  const commands: CodeCommand[] = [
    { id: 'file.new', title: 'File: New File…', disabled: !fileEdit, run: () => setDialog({ kind: 'create', dir: here }) },
    { id: 'file.newFolder', title: 'File: New Folder…', disabled: !fileEdit, run: () => setDialog({ kind: 'folder', dir: here }) },
    { id: 'file.save', title: 'File: Save', shortcut: keys('Mod', 'S'), disabled: !active, run: () => { if (active) void save(active) } },
    { id: 'file.saveAll', title: 'File: Save All', disabled: !anyDirty, run: () => { for (const path of dirtyPaths) void save(path) } },
    { id: 'file.rename', title: 'File: Rename…', disabled: !fileEdit || !active, run: () => { if (active) setDialog({ kind: 'rename', path: active }) } },
    { id: 'file.delete', title: 'File: Delete', disabled: !fileEdit || !active, run: () => { if (active) setDialog({ kind: 'delete', path: active }) } },
    { id: 'file.copyPath', title: 'File: Copy Path of Active File', disabled: !active, run: () => { if (active) copy(absolute(active)) } },
    { id: 'file.copyRelative', title: 'File: Copy Relative Path of Active File', disabled: !active, run: () => { if (active) copy(active) } },
    { id: 'go.file', title: 'Go to File…', shortcut: keys('Mod', 'P'), run: () => setQuickOpen(true) },
    { id: 'go.line', title: 'Go to Line…', shortcut: keys('Ctrl', 'G'), disabled: current?.status !== 'ready', run: () => askGotoLine() },
    { id: 'edit.find', title: 'Find in File', shortcut: keys('Mod', 'F'), disabled: current?.status !== 'ready', run: () => setFind((value) => ({ group: layoutRef.current.focused, nonce: value.nonce + 1 })) },
    { id: 'search.files', title: 'Search: Find in Files', shortcut: keys('Mod', 'Shift', 'F'), run: () => { showSidebar('search'); setSearchFocus((value) => value + 1) } },
    { id: 'view.explorer', title: 'View: Show Explorer', shortcut: keys('Mod', 'Shift', 'E'), run: () => showSidebar('explorer') },
    { id: 'view.scm', title: 'View: Show Source Control', shortcut: keys('Ctrl', 'Shift', 'G'), run: () => showSidebar('scm') },
    { id: 'view.sidebar', title: 'View: Toggle Sidebar', shortcut: keys('Mod', 'B'), run: toggleSidebar },
    { id: 'view.panel', title: 'View: Toggle Panel', shortcut: keys('Mod', 'J'), disabled: !terminalAllowed, run: () => togglePanel(layout.panel === null ? 'terminal' : null) },
    { id: 'view.terminal', title: 'View: Toggle Terminal', shortcut: keys('Ctrl', '`'), disabled: !terminalAllowed, run: () => togglePanel(layout.panel === 'terminal' ? null : 'terminal') },
    { id: 'view.services', title: 'View: Show Services', disabled: !terminalAllowed || tree.kind !== 'main', run: () => togglePanel('services') },
    { id: 'view.wrap', title: 'View: Toggle Word Wrap', shortcut: keys('Alt', 'Z'), run: () => setLayout((state) => ({ ...state, wrap: !state.wrap })) },
    { id: 'view.split', title: 'View: Split Editor Right', shortcut: keys('Mod', '\\'), disabled: !activeTab, run: () => { if (activeTab) setLayout((state) => openToSide(state, activeTab)) } },
    { id: 'view.markdown', title: 'Markdown: Toggle Preview', shortcut: keys('Mod', 'Shift', 'V'), disabled: !active || !isMarkdown(active), run: () => { if (active) toggleRendered(active) } },
    { id: 'view.browser', title: 'Browser: New Page', shortcut: newPageKeys(false), run: () => newPage() },
    { id: 'view.browserSide', title: 'Browser: New Page to the Side', shortcut: newPageKeys(true), run: () => newPage(true) },
    { id: 'view.agent', title: 'Agent: Open Agent', shortcut: keys('Mod', 'L'), run: () => openAgentTab(tree.kind === 'run' ? tree.runId : null) },
    { id: 'view.agentSide', title: 'Agent: Open Agent to the Side', run: () => openAgentTab(tree.kind === 'run' ? tree.runId : null, true) },
    { id: 'view.agentNew', title: 'Agent: New Task', run: () => openAgentTab(null) },
    { id: 'view.fullscreen', title: 'View: Toggle Full Screen', shortcut: MAC ? keys('Ctrl', 'Mod', 'F') : 'F11', run: toggleFullscreen },
    { id: 'view.diff', title: 'Source Control: Open Changes of Active File', disabled: !active || !changedByPath.has(active), run: () => { if (active) open(diffTab(active)) } },
    { id: 'tabs.close', title: 'View: Close Editor', shortcut: keys('Alt', 'W'), disabled: !activeTab, run: () => { if (activeTab) close(layout.focused, activeTab) } },
    { id: 'tabs.closeOthers', title: 'View: Close Other Editors', disabled: !activeTab, run: () => { if (activeTab) closeMany(layout.focused, (each) => closeOthers(each, activeTab)) } },
    { id: 'tabs.closeSaved', title: 'View: Close Saved Editors', run: () => closeMany(layout.focused, (each) => ({ ...each, tabs: [] })) },
    { id: 'explorer.refresh', title: 'Explorer: Refresh', run: revalidate },
  ]

  // Keyboard, as an editor's users expect it. A browser tab cannot take Ctrl+W or Ctrl+Tab, hence
  // the Alt forms for closing and stepping.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      const letter = event.key.toLowerCase()
      const plain = mod && !event.shiftKey && !event.altKey
      const hit = (id: string) => {
        event.preventDefault()
        commands.find((each) => each.id === id && !each.disabled)?.run()
      }
      if (event.key === 'F1' || (mod && event.shiftKey && letter === 'p')) {
        event.preventDefault()
        setPalette(true)
      } else if (plain && letter === 's') hit('file.save')
      else if (plain && letter === 'p') hit('go.file')
      else if (plain && letter === 'b') hit('view.sidebar')
      else if (plain && letter === 'j') hit('view.panel')
      else if (plain && letter === 'l') hit('view.agent')
      // A browser keeps Ctrl+T for itself (the desktop shell hands it over); Alt+T always arrives,
      // except in the terminal panel, whose shell reads it.
      else if ((plain && letter === 't') || (event.altKey && !mod && !event.shiftKey && event.code === 'KeyT' && !inPanel(event.target))) hit('view.browser')
      else if ((mod && event.shiftKey && !event.altKey && letter === 't') || (event.altKey && !mod && event.shiftKey && event.code === 'KeyT' && !inPanel(event.target))) hit('view.browserSide')
      else if (event.key === 'F11' || (event.ctrlKey && event.metaKey && letter === 'f')) hit('view.fullscreen')
      else if (plain && event.key === '\\') hit('view.split')
      else if (mod && event.shiftKey && letter === 'f') hit('search.files')
      else if (mod && event.shiftKey && letter === 'e') hit('view.explorer')
      else if (mod && event.shiftKey && letter === 'v') hit('view.markdown')
      else if (event.ctrlKey && event.shiftKey && letter === 'g') hit('view.scm')
      else if (event.ctrlKey && !event.shiftKey && event.key === '`') hit('view.terminal')
      else if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey && letter === 'g') hit('go.line')
      else if (event.altKey && !mod && letter === 'z') hit('view.wrap')
      else if (event.altKey && !mod && letter === 'w') hit('tabs.close')
      else if (event.altKey && !mod && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.preventDefault()
        setLayout((state) => updateGroup(state, state.focused, (each) => stepTab(each, event.key === 'ArrowRight' ? 1 : -1)))
      } else if (plain && /^[1-4]$/.test(event.key) && layout.groups.length > Number(event.key) - 1) {
        event.preventDefault()
        setLayout((state) => ({ ...state, focused: Number(event.key) - 1 }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** A file dropped on a folder: ask, because a move rewrites imports nobody is looking at. */
  const askMove = (from: string, toDir: string) => {
    const to = toDir === '' ? from.slice(from.lastIndexOf('/') + 1) : `${toDir}/${from.slice(from.lastIndexOf('/') + 1)}`
    if (to !== from) setMoving({ from, to })
  }
  const move = async () => {
    if (!moving) return
    const { from, to } = moving
    setMoving(null)
    try {
      await renameCodeFile(tree, { from, to })
      afterFileOp(from, to)
    } catch (error) {
      toast((error as Error).message, { tone: 'danger' })
    }
  }
  /** A tab dragged onto a group moves there; a file dragged from the explorer opens there. */
  const dropOnGroup = (at: number, drop: { file: string } | { tab: string; from: number }) => {
    if ('file' in drop) return setLayout((state) => updateGroup({ ...state, focused: Math.min(at, state.groups.length - 1) }, at, (each) => openTab(each, drop.file, true)))
    if (drop.from === at) return
    setLayout((state) => {
      const opened = updateGroup({ ...state, focused: at }, at, (each) => openTab(each, drop.tab, true))
      const closed = updateGroup(opened, drop.from, (each) => closeTab(each, drop.tab))
      // The source group may have closed and shifted the target one place left.
      return { ...closed, focused: closed.groups.length < opened.groups.length && drop.from < at ? at - 1 : Math.min(at, closed.groups.length - 1) }
    })
  }

  /** The explorer's menu for a right click on `target` (`null`: the space under the tree). */
  const explorerItems = (target: ExplorerTarget): MenuItem[] => {
    const dir = target === null ? '' : target.kind === 'dir' ? target.path : dirOf(target.path)
    const items: MenuItem[] = []
    if (target?.kind === 'file') {
      items.push({ label: 'Open', run: () => open(target.path) }, { label: 'Open to the Side', run: () => open(target.path, { side: true }) })
      if (changedByPath.has(target.path)) items.push({ label: 'Open Changes', run: () => open(diffTab(target.path)) })
      items.push('separator')
    }
    if (fileEdit) {
      items.push({ label: 'New File…', run: () => setDialog({ kind: 'create', dir }) }, { label: 'New Folder…', run: () => setDialog({ kind: 'folder', dir }) })
    }
    if (target !== null) {
      if (fileEdit) items.push('separator')
      items.push({ label: 'Copy Path', run: () => copy(absolute(target.path)) }, { label: 'Copy Relative Path', run: () => copy(target.path) })
    }
    if (fileEdit && target?.kind === 'file') {
      items.push('separator', { label: 'Rename…', run: () => setDialog({ kind: 'rename', path: target.path }) }, { label: 'Delete', danger: true, run: () => setDialog({ kind: 'delete', path: target.path }) })
    }
    if (items.length === 0) items.push({ label: 'Refresh Explorer', run: revalidate })
    return items
  }

  const tabItems = (at: number, tab: string): MenuItem[] => {
    const file = tabFile(tab)
    const items: MenuItem[] = [
      { label: 'Close', shortcut: keys('Alt', 'W'), run: () => close(at, tab) },
      { label: 'Close Others', run: () => closeMany(at, (each) => closeOthers(each, tab)) },
      { label: 'Close Saved', run: () => closeMany(at, (each) => ({ ...each, tabs: [] })) },
      'separator',
      { label: 'Split Right', shortcut: keys('Mod', '\\'), run: () => setLayout((state) => openToSide({ ...state, focused: at }, tab)) },
    ]
    if (changedByPath.has(file) && isFileTab(tab)) items.push({ label: 'Open Changes', run: () => open(diffTab(file)) })
    if (!isToolTab(tab)) items.push('separator', { label: 'Copy Path', run: () => copy(absolute(file)) }, { label: 'Copy Relative Path', run: () => copy(file) })
    return items
  }

  const switchTree = (value: string) => navigate(value === 'main' ? '/code' : `/code?tree=${encodeURIComponent(value)}`)
  const worktrees = checkoutRuns(runs.data)
  const dialogPath = dialog !== null && (dialog.kind === 'rename' || dialog.kind === 'delete') ? dialog.path : null
  const dialogFile = dialogPath !== null ? files[dialogPath] : undefined
  const buffer = current?.status === 'ready' ? current.buffer : null
  // The palette's pages (spec §3): the open ones by title, and every detected address to open.
  const pageGroups = [
    {
      heading: 'Pages',
      items: browserTabs(layout).map((page) => ({
        id: `page:${page.id}`,
        title: pageTitle(page.url, gateways[page.id]) + (layout.groups.length > 1 ? ` · group ${page.group + 1}` : ''),
        run: () => setLayout((state) => focusBrowserTab(state, page.id)),
      })),
    },
    { heading: 'Open page', items: detected.map((url) => ({ id: `open:${url}`, title: pageTitle(url), run: () => { openPage(url) } })) },
  ]
  const recent = useMemo(() => [...new Set(layout.groups.flatMap((each) => each.tabs.filter((tab) => !isToolTab(tab.path)).map((tab) => tabFile(tab.path))))], [layout.groups])

  const VIEWS: Array<{ view: CodeSidebar; label: string; icon: typeof FilesIcon; badge?: number }> = [
    { view: 'explorer', label: 'Explorer', icon: FilesIcon },
    { view: 'search', label: 'Search', icon: SearchIcon },
    { view: 'scm', label: 'Source Control', icon: GitCompareArrowsIcon, badge: changed.length },
  ]

  /** What the sidebar holds: the checkout, the view switch, the view. One body, two homes. */
  const sidebarHead = (
    <div data-slot="code-sidebar-head" className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Select value={key} onValueChange={switchTree}>
          <SelectTrigger size="sm" aria-label="Checkout" className="min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="main">Main checkout</SelectItem>
            {tree.kind === 'run' && !worktrees.some((each) => each.id === tree.runId) ? <SelectItem value={tree.runId}>Task {tree.runId.slice(0, 8)}</SelectItem> : null}
            {worktrees.map((each) => <SelectItem key={each.id} value={each.id}>{runTitle(each)}</SelectItem>)}
          </SelectContent>
        </Select>
        {tree.kind === 'main' ? <RepoSyncChip /> : null}
      </div>
      <Tabs value={layout.sidebar} onValueChange={(view) => setLayout((state) => ({ ...state, sidebar: view as CodeSidebar }))}>
        <TabsList aria-label="Views" data-slot="code-views" className="w-full">
          {VIEWS.map(({ view, label, icon: Icon, badge }) => (
            <TabsTrigger key={view} value={view} aria-label={label} title={label} className="relative min-w-0 flex-1">
              <Icon aria-hidden="true" />
              {badge ? <span data-slot="code-scm-count" className="font-mono text-[11px] tabular-nums">{badge > 99 ? '99+' : badge}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )
  const sidebarView = layout.sidebar === 'explorer' ? (
    <ExplorerView
      paths={paths}
      loading={treeQuery.isPending}
      error={treeQuery.isError ? treeQuery.error.message : null}
      selected={active}
      marks={marks}
      canEdit={fileEdit}
      onSelect={(path) => open(path, { keep: false })}
      onOpen={(path) => open(path)}
      menuFor={explorerItems}
      onNewFile={() => setDialog({ kind: 'create', dir: here })}
      onNewFolder={() => setDialog({ kind: 'folder', dir: here })}
      onRefresh={revalidate}
      {...(fileEdit ? { onMoveFile: askMove } : {})}
    />
  ) : layout.sidebar === 'search' ? (
    <SearchView tree={tree} focus={searchFocus} onOpen={(path, line) => open(path, { line })} />
  ) : (
    <ScmView
      tree={tree}
      files={changed}
      loading={changes.isPending}
      error={changes.isError ? changes.error.message : null}
      onOpenDiff={(path) => open(diffTab(path))}
      onOpenFile={(path) => open(path)}
    />
  )

  return (
    <OpenBrowserTabContext.Provider value={openPage}>
    <div
      data-route="code"
      data-tree={key}
      data-fullscreen={fullscreen ? 'true' : undefined}
      className={cn('flex h-full min-h-0 flex-col bg-background', fullscreen && 'fixed inset-0 z-40')}
    >
      {/* The explorer, search and source control are this SCREEN's list, so they live in the
          shell's contextual sidebar. In full screen the shell is covered, and they come along. */}
      {fullscreen ? null : (
        <ContextSidebar>
          <SidebarHeader data-slot="code-sidebar" data-view={layout.sidebar} className="gap-2 p-3">{sidebarHead}</SidebarHeader>
          <SidebarContent>{sidebarView}</SidebarContent>
        </ContextSidebar>
      )}

      <div className="flex min-h-0 flex-1">
        {fullscreen && !sidebarHidden ? (
          <aside data-slot="code-sidebar" data-view={layout.sidebar} className="hidden w-72 shrink-0 flex-col border-r border-border md:flex">
            <div className="shrink-0 p-3">{sidebarHead}</div>
            <div className="min-h-0 flex-1">{sidebarView}</div>
          </aside>
        ) : null}

        <ResizablePanelGroup direction="vertical" className="min-w-0 flex-1" onLayout={(sizes) => { if (layout.panel !== null && sizes[1] !== undefined) setLayout((state) => (state.panelSize === sizes[1] ? state : { ...state, panelSize: sizes[1] as number })) }}>
              <ResizablePanel id="code-editors" order={1} minSize={20} className="flex min-h-0">
                <ResizablePanelGroup
                  direction="horizontal"
                  data-slot="code-groups"
                  onLayout={(sizes) => setLayout((state) => (sizes.length !== state.groups.length || sizes.every((size, at) => size === state.sizes[at]) ? state : { ...state, sizes }))}
                >
                  {layout.groups.map((each, at) => (
                    <Fragment key={at}>
                      {at > 0 ? <ResizableHandle aria-label={`Resize editor groups ${at} and ${at + 1}`} /> : null}
                      <ResizablePanel id={`code-group-${at}`} order={at + 1} defaultSize={layout.sizes[at] ?? 100 / layout.groups.length} minSize={MIN_GROUP_SIZE} className="flex min-w-0">
                        <EditorGroup
                          index={at}
                          group={each}
                          focused={at === layout.focused}
                          split={layout.groups.length > 1}
                          tree={tree}
                          files={files}
                          changed={changedByPath}
                          lineMarks={lineMarks}
                          browsers={layout.browsers}
                          gateways={gateways}
                          addressFocus={addressFocus}
                          suggestions={detected}
                          onGateway={setGateway}
                          onShowTerminal={terminalAllowed ? () => togglePanel('terminal') : undefined}
                          agentRun={agentRun}
                          agents={layout.agents}
                          agentTitles={agentTitles}
                          runs={runs.data ?? []}
                          lastFile={lastFile.current}
                          onAgentSelect={(id, runId) => setLayout((state) => ({ ...state, agents: { ...state.agents, [id]: runId } }))}
                          onAgentStart={startTaskIn}
                          wrap={layout.wrap}
                          fileEdit={fileEdit}
                          rendered={rendered}
                          reveal={reveal?.group === at ? reveal : null}
                          gotoLine={gotoLine.group === at ? gotoLine.nonce : 0}
                          find={find.group === at ? find.nonce : 0}
                          menuFor={(tab) => tabItems(at, tab)}
                          onDrop={(drop) => dropOnGroup(at, drop)}
                          onFocus={() => setLayout((state) => (state.focused === at || at >= state.groups.length ? state : { ...state, focused: at }))}
                          onActivate={(tab) => setLayout((state) => updateGroup({ ...state, focused: Math.min(at, state.groups.length - 1) }, at, (tabs) => ({ ...tabs, active: tab })))}
                          onKeep={(tab) => setLayout((state) => updateGroup(state, at, (tabs) => keepTab(tabs, tab)))}
                          onClose={(tab) => close(at, tab)}
                          onEdit={(path, text) => edit(at, path, text)}
                          onCursor={(position) => { if (at === layoutRef.current.focused) setCursor(position) }}
                          onSave={(path, overwrite) => void save(path, overwrite)}
                          onReload={(path) => {
                            setFile(path, (file) => (file?.status === 'ready' ? { ...file, buffer: resolveConflict(file.buffer, 'reload') } : file))
                            saveDraft(storage(), projectId, key, path, undefined)
                          }}
                          onToggleRendered={toggleRendered}
                          onSplit={(tab) => setLayout((state) => openToSide({ ...state, focused: at }, tab))}
                          onBrowser={setBrowser}
                          onStartTask={(message) => startTask({ task: message, workflow: DEFAULT_AGENT_WORKFLOW })}
                          loadFileText={async (path) => {
                            try {
                              const entry = await getCodeFile(tree, path)
                              return entry.type === 'file' ? entry.content ?? null : null
                            } catch {
                              return null
                            }
                          }}
                        />
                      </ResizablePanel>
                    </Fragment>
                  ))}
                </ResizablePanelGroup>
              </ResizablePanel>
              {layout.panel !== null && terminalAllowed ? (
                <>
                  <ResizableHandle aria-label="Resize panel" />
                  <ResizablePanel id="code-panel" order={2} defaultSize={layout.panelSize} minSize={10} className="min-h-0">
                    <CodePanelView tree={tree} panel={layout.panel} onPanel={togglePanel} initialTerminal={initialTerminal} />
                  </ResizablePanel>
                </>
              ) : null}
        </ResizablePanelGroup>
      </div>

      <footer data-slot="code-status" className="flex h-7 shrink-0 items-center gap-1 border-t border-border px-2 text-[11px] text-muted-foreground">
        <IconTooltip label={`Toggle sidebar (${keys('Mod', 'B')})`} side="top">
          <Button variant="ghost" size="icon-xs" aria-label="Toggle sidebar" onClick={toggleSidebar}><PanelLeftIcon aria-hidden="true" /></Button>
        </IconTooltip>
        {branch ? <span className="flex shrink-0 items-center gap-1 px-1" title="Branch"><GitBranchIcon aria-hidden="true" className="size-3" />{branch}</span> : null}
        <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[11px] font-normal" onClick={() => showSidebar('scm')}>{changed.length} change{changed.length === 1 ? '' : 's'}</Button>
        <span data-slot="code-save-state" className="ml-auto truncate px-1">
          {!fileEdit ? 'Read-only: file editing is off on this cockpit'
            : current?.status === 'ready' && !current.editable ? `Read-only: ${current.reason ?? 'this file cannot be edited'}`
              : buffer && isDirty(buffer) ? 'Unsaved changes' : buffer ? 'Saved' : ''}
        </span>
        {current?.status === 'ready' && cursor ? (
          <Button variant="ghost" size="xs" data-slot="code-cursor" className="h-5 shrink-0 px-1.5 text-[11px] font-normal" title="Go to Line" onClick={askGotoLine}>
            Ln {cursor.line}, Col {cursor.column}{cursor.cursors > 1 ? ` (${cursor.cursors} cursors)` : cursor.selected > 0 ? ` (${cursor.selected} selected)` : ''}
          </Button>
        ) : null}
        {layout.wrap ? <span className="shrink-0 px-1">Wrap</span> : null}
        {active ? <span data-slot="code-language" className="shrink-0 px-1">{languageOf(active)}</span> : null}
        <IconTooltip label={`Open a page of the app (${newPageKeys(false)})`} side="top">
          <Button variant="ghost" size="icon-xs" aria-label="Open browser" onClick={() => newPage()}><GlobeIcon aria-hidden="true" /></Button>
        </IconTooltip>
        <IconTooltip label={`Toggle panel (${keys('Mod', 'J')})`} side="top">
          <Button variant="ghost" size="icon-xs" aria-label="Toggle panel" aria-pressed={layout.panel !== null} disabled={!terminalAllowed} onClick={() => togglePanel(layout.panel === null ? 'terminal' : null)}><PanelBottomIcon aria-hidden="true" /></Button>
        </IconTooltip>
        <IconTooltip label={`Open an agent tab (${keys('Mod', 'L')})`} side="top">
          <Button variant="ghost" size="icon-xs" aria-label="Open agent" onClick={() => openAgentTab(tree.kind === 'run' ? tree.runId : null)}><BotIcon aria-hidden="true" /></Button>
        </IconTooltip>
        <IconTooltip label="Toggle full screen" side="top">
          <Button variant="ghost" size="icon-xs" aria-label="Toggle full screen" aria-pressed={fullscreen} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize2Icon aria-hidden="true" /> : <Maximize2Icon aria-hidden="true" />}
          </Button>
        </IconTooltip>
      </footer>

      <AlertDialog open={discarding !== null} onOpenChange={(next) => { if (!next) setDiscarding(null) }}>
        <AlertDialogContent data-slot="code-discard-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              <code className="font-mono text-xs text-foreground">{discarding?.path}</code> has edits that were never saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (discarding !== null) close(discarding.group, discarding.path, true) }}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={moving !== null} onOpenChange={(next) => { if (!next) setMoving(null) }}>
        <AlertDialogContent data-slot="code-move-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Move this file?</AlertDialogTitle>
            <AlertDialogDescription>
              <code className="font-mono text-xs text-foreground">{moving?.from}</code> becomes <code className="font-mono text-xs text-foreground">{moving?.to}</code>. Nothing that imports it is rewritten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void move()}>Move</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <QuickOpen open={quickOpen} paths={paths} recent={recent} onClose={() => setQuickOpen(false)} onPick={(path) => open(path)} />
      <CommandPalette open={palette} commands={commands} groups={pageGroups} onClose={() => setPalette(false)} />
      <FileDialog
        tree={tree}
        action={dialog}
        dirty={dialogFile?.status === 'ready' && isDirty(dialogFile.buffer)}
        // No pending change means disk equals the committed version: a delete loses nothing.
        clean={dialogPath !== null && !marks.has(dialogPath)}
        onClose={() => setDialog(null)}
        onDone={afterFileOp}
      />
    </div>
    </OpenBrowserTabContext.Provider>
  )
}

/** One editor group: its tab strip, the path of the active file, and whatever that file is. */
function EditorGroup({
  index, group, focused, split, tree, files, changed, lineMarks, browsers, gateways, addressFocus, suggestions, onGateway, onShowTerminal, agentRun,
  agents, agentTitles, runs, lastFile, onAgentSelect,
  onAgentStart, wrap, fileEdit, rendered, reveal, gotoLine, find,
  menuFor, onDrop, onFocus, onActivate, onKeep, onClose, onEdit, onCursor, onSave, onReload, onToggleRendered, onSplit, onBrowser, onStartTask,
  loadFileText,
}: {
  index: number
  group: TabsState
  focused: boolean
  split: boolean
  tree: CodeTree
  files: Record<string, OpenFile>
  changed: ReadonlyMap<string, ChangedFile>
  lineMarks: ReadonlyMap<string, ReadonlyMap<number, LineMark>>
  browsers: Record<string, CodeBrowser>
  /** The preview-gateway origin each Browser tab is framed through (hosted), by tab id. */
  gateways: Record<string, string>
  /** The Browser tab whose address bar Ctrl/Cmd+T asked for, and the ask's count. */
  addressFocus: { id: string; nonce: number } | null
  suggestions: readonly string[]
  onGateway: (id: string, origin: string | null) => void
  onShowTerminal: (() => void) | undefined
  /** The task the agent pane shows — where a browser tab's Design Mode notes go. */
  agentRun: ApiRun | null
  /** Agent tabs: the task each shows, its title, and what picking or starting one does. */
  agents: Record<string, string | null>
  agentTitles: Record<string, string>
  runs: readonly ApiRun[]
  lastFile: string | null
  onAgentSelect: (id: string, runId: string | null) => void
  onAgentStart: (id: string, input: { task: string; workflow: string }) => Promise<void>
  wrap: boolean
  fileEdit: boolean
  rendered: ReadonlySet<string>
  reveal: { path: string; line: number; nonce: number } | null
  gotoLine: number
  find: number
  /** The context menu of one of this group's tabs. */
  menuFor: (tab: string) => MenuItem[]
  /** A file from the explorer, or a tab from a group, let go over this group. */
  onDrop: (drop: { file: string } | { tab: string; from: number }) => void
  onFocus: () => void
  onActivate: (tab: string) => void
  onKeep: (tab: string) => void
  onClose: (tab: string) => void
  onEdit: (path: string, text: string) => void
  onCursor: (position: CursorPosition) => void
  onSave: (path: string, overwrite: boolean) => void
  onReload: (path: string) => void
  onToggleRendered: (path: string) => void
  onSplit: (tab: string) => void
  onBrowser: (id: string, state: CodeBrowser) => void
  onStartTask: (message: string) => Promise<void>
  loadFileText: (path: string) => Promise<string | null>
}) {
  const [comparing, setComparing] = useState(false)
  const tab = group.active
  const browser = tab !== null && isBrowserTab(tab)
  const agent = tab !== null && isAgentTab(tab)
  const path = tab === null || browser || agent ? null : tabFile(tab)
  const diff = tab !== null && isDiffTab(tab)
  const file = path !== null && !diff ? files[path] : undefined
  const buffer = file?.status === 'ready' ? file.buffer : null
  const conflicted = buffer?.conflict != null
  const readOnly = !fileEdit || (file?.status === 'ready' && !file.editable)
  const marksOfFile = path !== null ? lineMarks.get(path) : undefined
  useEffect(() => { if (!conflicted) setComparing(false) }, [conflicted])
  const [over, setOver] = useState(false)
  const carries = (event: React.DragEvent) => event.dataTransfer.types.includes(FILE_DRAG_TYPE) || event.dataTransfer.types.includes(TAB_DRAG_TYPE)

  return (
    <section
      data-slot="code-group"
      data-group={index}
      data-focused={focused ? 'true' : undefined}
      data-drop-target={over ? 'true' : undefined}
      onPointerDownCapture={onFocus}
      onDragOver={(event) => {
        if (!carries(event)) return
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false) }}
      onDrop={(event) => {
        setOver(false)
        const moved = event.dataTransfer.getData(TAB_DRAG_TYPE)
        const dropped = event.dataTransfer.getData(FILE_DRAG_TYPE)
        if (!moved && !dropped) return
        event.preventDefault()
        if (moved) {
          try {
            const parsed = JSON.parse(moved) as { tab?: unknown; from?: unknown }
            if (typeof parsed.tab === 'string' && typeof parsed.from === 'number') onDrop({ tab: parsed.tab, from: parsed.from })
          } catch {
            // Not ours.
          }
        } else {
          onDrop({ file: dropped })
        }
      }}
      className={cn('flex min-w-0 flex-1 flex-col', over && 'ring-2 ring-ring ring-inset')}
    >
      <Tabs value={tab ?? ''} onValueChange={onActivate} className="shrink-0 gap-0">
        <TabsList
          variant="line"
          aria-label={split ? `Open files, group ${index + 1}` : 'Open files'}
          className={cn('h-9 w-full justify-start gap-0.5 overflow-x-auto border-b border-border px-1.5', split && focused && 'border-b-foreground/40')}
        >
          {group.tabs.map((each) => {
            const opened = files[each.path]
            const dirty = isFileTab(each.path) && opened?.status === 'ready' && isDirty(opened.buffer)
            const label = tabLabel(each.path, browsers, agentTitles, gateways)
            return (
              <ContextMenu key={each.path}>
                <ContextMenuTrigger asChild>
                  <div
                    data-slot="code-tab"
                    data-active={each.path === tab ? 'true' : undefined}
                    data-dirty={dirty ? 'true' : undefined}
                    title={isBrowserTab(each.path) ? browsers[browserId(each.path)]?.url || 'Browser' : isAgentTab(each.path) ? 'Agent' : tabFile(each.path)}
                    onAuxClick={(event) => { if (event.button === 1) onClose(each.path) }}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify({ tab: each.path, from: index }))
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    className={cn('flex shrink-0 items-center rounded-md pr-0.5', each.path === tab ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
                  >
                    <TabsTrigger value={each.path} onDoubleClick={() => onKeep(each.path)} className={cn('h-7 max-w-56 flex-none gap-1.5 px-2 text-xs after:hidden data-[state=active]:bg-transparent data-[state=active]:shadow-none', each.preview && 'italic')}>
                      <span className="truncate">{label}</span>
                      {dirty ? <span aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-foreground" /> : null}
                    </TabsTrigger>
                    <Button variant="ghost" size="icon-xs" aria-label={`Close ${label}`} className="size-5 opacity-60 hover:opacity-100" onClick={() => onClose(each.path)}>
                      <XIcon aria-hidden="true" />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent data-slot="code-context-menu"><MenuItems items={menuFor(each.path)} /></ContextMenuContent>
              </ContextMenu>
            )
          })}
        </TabsList>
      </Tabs>

      {path !== null && tab !== null ? (
        <div data-slot="code-breadcrumbs" className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-3">
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap gap-1 font-mono text-[11px] sm:gap-1">
              {path.split('/').map((segment, at, all) => (
                <Fragment key={`${at}:${segment}`}>
                  {at > 0 ? <BreadcrumbSeparator className="[&>svg]:size-3" /> : null}
                  <BreadcrumbItem className="min-w-0">
                    {at === all.length - 1 ? <BreadcrumbPage className="truncate">{segment}</BreadcrumbPage> : <span className="truncate">{segment}</span>}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          {diff ? <span className="shrink-0 text-[11px] text-muted-foreground">· changes since the last commit</span> : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {!diff && isMarkdown(path) ? (
              <IconTooltip label="Toggle Markdown Preview">
                <Button variant="ghost" size="icon-xs" aria-label="Toggle Markdown Preview" aria-pressed={rendered.has(path)} onClick={() => onToggleRendered(path)}><EyeIcon aria-hidden="true" /></Button>
              </IconTooltip>
            ) : null}
            <IconTooltip label="Split Editor Right">
              <Button variant="ghost" size="icon-xs" aria-label="Split Editor Right" onClick={() => onSplit(tab)}><ColumnsIcon aria-hidden="true" /></Button>
            </IconTooltip>
            {buffer && isDirty(buffer) && !readOnly ? <Button size="xs" onClick={() => onSave(path, false)}>Save</Button> : null}
          </span>
        </div>
      ) : null}

      {conflicted && path !== null ? (
        <Alert variant="destructive" data-slot="code-conflict" className="shrink-0 rounded-none border-x-0 border-t-0 py-2">
          <AlertDescription className="flex flex-wrap items-center gap-2 text-xs text-foreground">
            <span className="mr-auto">This file changed on disk while you were editing it.</span>
            <Button size="xs" variant="outline" onClick={() => setComparing((value) => !value)}>{comparing ? 'Hide comparison' : 'Compare'}</Button>
            <Button size="xs" variant="outline" onClick={() => onReload(path)}>Reload from disk</Button>
            <Button size="xs" variant="outline" onClick={() => onSave(path, true)}>Overwrite</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        {tab !== null && browser ? (
          <div data-slot="code-browser" className="flex min-w-0 flex-1 flex-col">
            <CodeBrowserTab
              key={tab}
              state={browsers[browserId(tab)] ?? { url: '' }}
              onChange={(state) => onBrowser(browserId(tab), state)}
              run={agentRun}
              onStartTask={onStartTask}
              tree={tree}
              focusAddress={addressFocus?.id === browserId(tab) ? addressFocus.nonce : 0}
              suggestions={suggestions}
              onGateway={(origin) => onGateway(browserId(tab), origin)}
              {...(onShowTerminal ? { onShowTerminal } : {})}
            />
          </div>
        ) : tab !== null && agent ? (
          <AgentTab
            runs={runs}
            run={runs.find((candidate) => candidate.id === agents[agentId(tab)]) ?? null}
            activeFile={lastFile}
            onSelect={(runId) => onAgentSelect(agentId(tab), runId)}
            onStart={(input) => onAgentStart(agentId(tab), input)}
          />
        ) : path === null || tab === null ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyTitle>No file open</EmptyTitle>
              <EmptyDescription>
                Pick a file in the explorer, or press <Kbd>{keys('Mod', 'P')}</Kbd> to go to one by name. <Kbd>{keys('Mod', 'Shift', 'P')}</Kbd> lists every command.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : diff ? (
          changed.has(path) ? (
            <div data-slot="code-diff" className="min-w-0 flex-1 overflow-auto p-3 [--diff-sticky-top:0rem]">
              <Diff files={[changed.get(path) as ChangedFile]} wrap={wrap} loadFileText={loadFileText} imageSrc={(target) => codeFileRawUrl(tree, target)} className="min-w-0" />
            </div>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">No changes since the last commit.</p>
          )
        ) : file === undefined || file.status === 'loading' ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : file.status === 'error' ? (
          <p role="alert" className="p-4 text-sm text-danger">{file.error}</p>
        ) : file.status === 'unsupported' ? (
          <p className="p-4 text-sm text-muted-foreground">{file.reason}</p>
        ) : file.status === 'image' ? (
          <div className="flex flex-1 items-center justify-center overflow-auto p-4"><img src={codeFileRawUrl(tree, path)} alt={path} className="max-h-full max-w-full" /></div>
        ) : rendered.has(path) ? (
          <div data-slot="code-markdown" className="min-w-0 flex-1 overflow-auto px-6 py-4"><Markdown>{file.buffer.draft ?? file.buffer.content}</Markdown></div>
        ) : (
          <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading the editor…</p>}>
            <CodeMirrorEditor
              key={path}
              path={path}
              value={file.buffer.draft ?? file.buffer.content}
              onChange={(text) => onEdit(path, text)}
              onCursor={onCursor}
              onFocus={onFocus}
              readOnly={readOnly}
              wrap={wrap}
              findRequest={find}
              gotoLineRequest={gotoLine}
              {...(marksOfFile ? { lineMarks: marksOfFile } : {})}
              {...(reveal?.path === path ? { revealLine: { line: reveal.line, nonce: reveal.nonce } } : {})}
              aria-label={`Editing ${path}`}
              className="min-w-0 flex-1"
            />
            {comparing && file.buffer.conflict ? (
              <div data-slot="code-compare" className="flex min-w-0 flex-1 flex-col border-l border-border">
                <p className="shrink-0 border-b border-border px-3 py-1 text-xs text-muted-foreground">On disk now</p>
                <CodeMirrorEditor key={`${path}:disk`} path={path} value={file.buffer.conflict.diskContent} readOnly wrap={wrap} aria-label={`${path} on disk`} className="min-h-0 flex-1" />
              </div>
            ) : null}
          </Suspense>
        )}
      </div>
    </section>
  )
}
