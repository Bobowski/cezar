import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BotIcon, ColumnsIcon, EyeIcon, FilesIcon, GitBranchIcon, GitCompareArrowsIcon, GlobeIcon, Maximize2Icon, Minimize2Icon, PanelBottomIcon,
  SearchIcon, XIcon,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { queryScope, type ApiRun, type ChangedFile } from '@open-mercato/cezar-api-client'
import { ApiError, createRun } from '@/api/client'
import {
  codeFileRawUrl, getCodeChanges, getCodeFile, getCodeTree, getCodeWatch, saveCodeFile, treeKey, type CodeTree,
} from '@/api/code'
import { useHostTransport } from '@/api/host-usage'
import { queryKeys, useHealth, useRepo, useRuns } from '@/api/queries'
import { subscribeTopic } from '@/api/ws'
import type { CursorPosition, LineMark } from '@/components/code-mirror-editor'
import { ContextSidebar } from '@/components/context-sidebar'
import { Diff } from '@/components/diff'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SidebarContent, SidebarHeader, useSidebar } from '@/components/ui/sidebar'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'
import { cn } from '@/lib/utils'
import { isImagePath } from '@/routes/task-git/worktree-files'
import { Markdown } from '@/routes/task-thread/markdown'

import { AgentPane, DEFAULT_AGENT_WORKFLOW } from './code-agent'
import { CodeBrowserTab } from './code-browser'
import { ContextMenu, menuAt, type MenuItem, type MenuRequest } from './code-menu'
import { CommandPalette, FileDialog, QuickOpen, type CodeCommand, type FileAction } from './code-palette'
import { CodePanelView } from './code-panel'
import { Resizer } from './code-resizer'
import { ExplorerView, ScmView, SearchView } from './code-sidebar'
import {
  browserId, bufferFrom, clamp, closeOthers, closeTab, diffTab, focusedGroup, isBrowserTab, isDiffTab, isDirty, isFileTab, keepTab,
  languageOf, lineMarksFromPatch, loadDraft, loadLayout, openBrowser, openPaths, openTab, openToSide, pruneBrowsers, reconcile, resizeGroups,
  resolveConflict, retargetTab, saveDraft, saveLayout, stepTab, tabFile, tabLabel, updateGroup, updateGroups, type Buffer, type CodeBrowser,
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

const STATUS_LETTER: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C' }
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const KEY_NAMES: Record<string, [mac: string, other: string]> = { Mod: ['⌘', 'Ctrl'], Shift: ['⇧', 'Shift'], Alt: ['⌥', 'Alt'], Ctrl: ['⌃', 'Ctrl'] }
/** A shortcut as the menus print it. */
const keys = (...parts: string[]) => parts.map((part) => KEY_NAMES[part]?.[MAC ? 0 : 1] ?? part).join(MAC ? '' : '+')
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
 * main checkout. Keyed by checkout: tabs, buffers and panel belong to one tree.
 */
export function CodeRoute() {
  const params = useParams()
  const [search] = useSearchParams()
  const runId = search.get('tree')
  const tree = useMemo<CodeTree>(() => (runId ? { kind: 'run', runId } : { kind: 'main' }), [runId])
  const path = params['*'] !== undefined && params['*'] !== '' ? params['*'] : null
  return <CodeWorkbench key={`${queryScope()}:${treeKey(tree)}`} tree={tree} initialPath={path} />
}

function CodeWorkbench({ tree, initialPath }: { tree: CodeTree; initialPath: string | null }) {
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
    const stored = loadLayout(storage(), projectId, key)
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
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const [rendered, setRendered] = useState<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = useState<CursorPosition | null>(null)
  const [searchFocus, setSearchFocus] = useState(0)
  const [gotoLine, setGotoLine] = useState({ group: 0, nonce: 0 })
  const [find, setFind] = useState({ group: 0, nonce: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  const groupsRow = useRef<HTMLDivElement>(null)
  const shell = useSidebar()
  const filesRef = useRef(files)
  filesRef.current = files
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const group = focusedGroup(layout)
  const activeTab = group.active
  // The file the focused tab is about: itself, or the file a diff tab compares. A browser has none.
  const active = activeTab === null || isBrowserTab(activeTab) ? null : tabFile(activeTab)
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

  useEffect(() => saveLayout(storage(), projectId, key, pruneBrowsers(layout)), [layout, projectId, key])

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
    if (shell.isMobile) shell.setOpenMobile(true)
    else if (!shell.open) shell.setOpen(true)
  }
  const openBrowserTab = (url?: string) => setLayout((state) => openBrowser(state, Math.random().toString(36).slice(2, 10), url))
  const setBrowser = (id: string, next: CodeBrowser) => setLayout((state) => ({ ...state, browsers: { ...state.browsers, [id]: next } }))
  const toggleAgent = () => setLayout((state) => ({ ...state, agent: !state.agent }))

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

  /** Start a task and make it the one the agent pane shows. */
  const startTask = async (input: { task: string; workflow: string }) => {
    const created = await createRun({ workflow: input.workflow, task: input.task })
    const started = 'runs' in created ? created.runs[0] : created
    if (!started) throw new Error('The task was not created.')
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.list() })
    setLayout((state) => ({ ...state, agent: true, agentRun: started.id }))
  }
  // The task the pane shows: the one picked, else — in a task's own worktree — that task.
  const agentRunId = layout.agentRun ?? (tree.kind === 'run' ? tree.runId : null)
  const agentRun = agentRunId === null ? null : runs.data?.find((candidate) => candidate.id === agentRunId) ?? null
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
    { id: 'view.sidebar', title: 'View: Toggle Sidebar', shortcut: keys('Mod', 'B'), run: () => shell.toggleSidebar() },
    { id: 'view.panel', title: 'View: Toggle Panel', shortcut: keys('Mod', 'J'), disabled: !terminalAllowed, run: () => togglePanel(layout.panel === null ? 'terminal' : null) },
    { id: 'view.terminal', title: 'View: Toggle Terminal', shortcut: keys('Ctrl', '`'), disabled: !terminalAllowed, run: () => togglePanel(layout.panel === 'terminal' ? null : 'terminal') },
    { id: 'view.services', title: 'View: Show Services', disabled: !terminalAllowed || tree.kind !== 'main', run: () => togglePanel('services') },
    { id: 'view.wrap', title: 'View: Toggle Word Wrap', shortcut: keys('Alt', 'Z'), run: () => setLayout((state) => ({ ...state, wrap: !state.wrap })) },
    { id: 'view.split', title: 'View: Split Editor Right', shortcut: keys('Mod', '\\'), disabled: !activeTab, run: () => { if (activeTab) setLayout((state) => openToSide(state, activeTab)) } },
    { id: 'view.markdown', title: 'Markdown: Toggle Preview', shortcut: keys('Mod', 'Shift', 'V'), disabled: !active || !isMarkdown(active), run: () => { if (active) toggleRendered(active) } },
    { id: 'view.browser', title: 'Browser: Open in a New Tab', run: () => openBrowserTab() },
    { id: 'view.agent', title: 'Agent: Toggle Agent Pane', shortcut: keys('Mod', 'L'), run: toggleAgent },
    { id: 'view.agentNew', title: 'Agent: New Task', run: () => setLayout((state) => ({ ...state, agent: true, agentRun: null })) },
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

  const explorerMenu = (event: React.MouseEvent, target: { kind: 'file' | 'dir'; path: string }) => {
    const dir = target.kind === 'dir' ? target.path : dirOf(target.path)
    const items: MenuItem[] = []
    if (target.kind === 'file') {
      items.push({ label: 'Open', run: () => open(target.path) }, { label: 'Open to the Side', run: () => open(target.path, { side: true }) })
      if (changedByPath.has(target.path)) items.push({ label: 'Open Changes', run: () => open(diffTab(target.path)) })
      items.push('separator')
    }
    if (fileEdit) {
      items.push({ label: 'New File…', run: () => setDialog({ kind: 'create', dir }) }, { label: 'New Folder…', run: () => setDialog({ kind: 'folder', dir }) }, 'separator')
    }
    items.push({ label: 'Copy Path', run: () => copy(absolute(target.path)) }, { label: 'Copy Relative Path', run: () => copy(target.path) })
    if (fileEdit && target.kind === 'file') {
      items.push('separator', { label: 'Rename…', run: () => setDialog({ kind: 'rename', path: target.path }) }, { label: 'Delete', danger: true, run: () => setDialog({ kind: 'delete', path: target.path }) })
    }
    setMenu(menuAt(event, items))
  }

  const tabMenu = (event: React.MouseEvent, at: number, tab: string) => {
    const file = tabFile(tab)
    const onDisk = !isBrowserTab(tab)
    const items: MenuItem[] = [
      { label: 'Close', shortcut: keys('Alt', 'W'), run: () => close(at, tab) },
      { label: 'Close Others', run: () => closeMany(at, (each) => closeOthers(each, tab)) },
      { label: 'Close Saved', run: () => closeMany(at, (each) => ({ ...each, tabs: [] })) },
      'separator',
      { label: 'Split Right', shortcut: keys('Mod', '\\'), run: () => setLayout((state) => openToSide({ ...state, focused: at }, tab)) },
    ]
    if (changedByPath.has(file) && isFileTab(tab)) items.push({ label: 'Open Changes', run: () => open(diffTab(file)) })
    if (onDisk) items.push('separator', { label: 'Copy Path', run: () => copy(absolute(file)) }, { label: 'Copy Relative Path', run: () => copy(file) })
    setMenu(menuAt(event, items))
  }

  const switchTree = (value: string) => navigate(value === 'main' ? '/code' : `/code?tree=${encodeURIComponent(value)}`)
  const worktrees = checkoutRuns(runs.data)
  const dialogPath = dialog !== null && (dialog.kind === 'rename' || dialog.kind === 'delete') ? dialog.path : null
  const dialogFile = dialogPath !== null ? files[dialogPath] : undefined
  const buffer = current?.status === 'ready' ? current.buffer : null
  const recent = useMemo(() => [...new Set(layout.groups.flatMap((each) => each.tabs.filter((tab) => !isBrowserTab(tab.path)).map((tab) => tabFile(tab.path))))], [layout.groups])

  const VIEWS: Array<{ view: CodeSidebar; label: string; icon: typeof FilesIcon; badge?: number }> = [
    { view: 'explorer', label: 'Explorer', icon: FilesIcon },
    { view: 'search', label: 'Search', icon: SearchIcon },
    { view: 'scm', label: 'Source Control', icon: GitCompareArrowsIcon, badge: changed.length },
  ]

  /** What the sidebar holds: the checkout, the view switch, the view. One body, two homes. */
  const sidebarHead = (
    <div data-slot="code-sidebar-head" className="flex flex-col gap-2">
      <NativeSelect aria-label="Checkout" value={key} onChange={(event) => switchTree(event.target.value)} className="h-8 w-full text-[13px]">
        <NativeSelectOption value="main">Main checkout</NativeSelectOption>
        {tree.kind === 'run' && !worktrees.some((each) => each.id === tree.runId) ? <NativeSelectOption value={tree.runId}>Task {tree.runId.slice(0, 8)}</NativeSelectOption> : null}
        {worktrees.map((each) => <NativeSelectOption key={each.id} value={each.id}>{runTitle(each)}</NativeSelectOption>)}
      </NativeSelect>
      <div role="tablist" aria-label="Views" data-slot="code-views" className="flex items-center gap-1">
        {VIEWS.map(({ view, label, icon: Icon, badge }) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-label={label}
            aria-selected={layout.sidebar === view}
            title={label}
            onClick={() => setLayout((state) => ({ ...state, sidebar: view }))}
            className={cn('relative flex h-8 flex-1 items-center justify-center rounded-md', layout.sidebar === view ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            <Icon aria-hidden="true" className="size-4" />
            {badge ? <span data-slot="code-scm-count" className="absolute top-0.5 right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-muted px-0.5 text-[9px] font-semibold text-foreground tabular-nums">{badge > 99 ? '99+' : badge}</span> : null}
          </button>
        ))}
      </div>
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
      onContextMenu={explorerMenu}
      onNewFile={() => setDialog({ kind: 'create', dir: here })}
      onNewFolder={() => setDialog({ kind: 'folder', dir: here })}
      onRefresh={revalidate}
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

  /** Pixels dragged on the border after group `index`, as a share of the row. */
  const dragGroups = (index: number, pixels: number) => {
    const width = groupsRow.current?.getBoundingClientRect().width ?? 0
    if (width > 0) setLayout((state) => ({ ...state, sizes: resizeGroups(state.sizes, index, (pixels / width) * 100) }))
  }

  return (
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
        {fullscreen ? (
          <aside data-slot="code-sidebar" data-view={layout.sidebar} className="hidden w-72 shrink-0 flex-col border-r border-border md:flex">
            <div className="shrink-0 p-3">{sidebarHead}</div>
            <div className="min-h-0 flex-1">{sidebarView}</div>
          </aside>
        ) : null}

        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={groupsRow} data-slot="code-groups" className="flex min-h-0 flex-1">
            {layout.groups.map((each, at) => (
              <div key={at} className="flex min-w-0" style={{ flexBasis: 0, flexGrow: layout.sizes[at] ?? 1 }}>
                {at > 0 ? <Resizer axis="x" label={`Resize editor groups ${at} and ${at + 1}`} onDrag={(pixels) => dragGroups(at - 1, pixels)} /> : null}
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
                  agentRun={agentRun}
                  wrap={layout.wrap}
                  fileEdit={fileEdit}
                  rendered={rendered}
                  reveal={reveal?.group === at ? reveal : null}
                  gotoLine={gotoLine.group === at ? gotoLine.nonce : 0}
                  find={find.group === at ? find.nonce : 0}
                  onFocus={() => setLayout((state) => (state.focused === at || at >= state.groups.length ? state : { ...state, focused: at }))}
                  onActivate={(tab) => setLayout((state) => updateGroup({ ...state, focused: Math.min(at, state.groups.length - 1) }, at, (tabs) => ({ ...tabs, active: tab })))}
                  onKeep={(tab) => setLayout((state) => updateGroup(state, at, (tabs) => keepTab(tabs, tab)))}
                  onClose={(tab) => close(at, tab)}
                  onTabMenu={(event, tab) => tabMenu(event, at, tab)}
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
              </div>
            ))}
          </div>
          {layout.panel !== null && terminalAllowed ? (
            <>
              <Resizer axis="y" label="Resize panel" onDrag={(pixels) => setLayout((state) => ({ ...state, panelHeight: clamp(state.panelHeight - pixels, 120, 900) }))} />
              <CodePanelView tree={tree} panel={layout.panel} height={layout.panelHeight} onPanel={togglePanel} />
            </>
          ) : null}
        </main>

        {layout.agent ? (
          <>
            <Resizer axis="x" label="Resize agent pane" onDrag={(pixels) => setLayout((state) => ({ ...state, agentWidth: clamp(state.agentWidth - pixels, 280, 900) }))} />
            <div className="hidden shrink-0 lg:block" style={{ width: layout.agentWidth }}>
              <AgentPane
                runs={runs.data ?? []}
                run={agentRun}
                activeFile={active}
                onSelect={(runId) => setLayout((state) => ({ ...state, agentRun: runId }))}
                onStart={startTask}
                onClose={toggleAgent}
              />
            </div>
          </>
        ) : null}
      </div>

      <footer data-slot="code-status" className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-2 text-[11px] text-muted-foreground">
        {branch ? <span className="flex shrink-0 items-center gap-1" title="Branch"><GitBranchIcon aria-hidden="true" className="size-3" />{branch}</span> : null}
        <button type="button" className="shrink-0 hover:text-foreground" onClick={() => showSidebar('scm')}>{changed.length} change{changed.length === 1 ? '' : 's'}</button>
        <span data-slot="code-save-state" className="ml-auto truncate">
          {!fileEdit ? 'Read-only: file editing is off on this cockpit'
            : current?.status === 'ready' && !current.editable ? `Read-only: ${current.reason ?? 'this file cannot be edited'}`
              : buffer && isDirty(buffer) ? 'Unsaved changes' : buffer ? 'Saved' : ''}
        </span>
        {current?.status === 'ready' && cursor ? (
          <button type="button" data-slot="code-cursor" className="shrink-0 hover:text-foreground" title="Go to Line" onClick={askGotoLine}>
            Ln {cursor.line}, Col {cursor.column}{cursor.cursors > 1 ? ` (${cursor.cursors} cursors)` : cursor.selected > 0 ? ` (${cursor.selected} selected)` : ''}
          </button>
        ) : null}
        {layout.wrap ? <span className="shrink-0">Wrap</span> : null}
        {active ? <span data-slot="code-language" className="shrink-0">{languageOf(active)}</span> : null}
        <button type="button" aria-label="Open browser" title="Open a browser tab" className="shrink-0 hover:text-foreground" onClick={() => openBrowserTab()}><GlobeIcon aria-hidden="true" className="size-3.5" /></button>
        <button type="button" aria-label="Toggle panel" aria-pressed={layout.panel !== null} title={`Toggle panel (${keys('Mod', 'J')})`} disabled={!terminalAllowed} className="shrink-0 hover:text-foreground disabled:opacity-40" onClick={() => togglePanel(layout.panel === null ? 'terminal' : null)}><PanelBottomIcon aria-hidden="true" className="size-3.5" /></button>
        <button type="button" aria-label="Toggle agent" aria-pressed={layout.agent} title={`Toggle agent (${keys('Mod', 'L')})`} className="shrink-0 hover:text-foreground" onClick={toggleAgent}><BotIcon aria-hidden="true" className="size-3.5" /></button>
        <button type="button" aria-label="Toggle full screen" aria-pressed={fullscreen} title="Toggle full screen" className="shrink-0 hover:text-foreground" onClick={toggleFullscreen}>
          {fullscreen ? <Minimize2Icon aria-hidden="true" className="size-3.5" /> : <Maximize2Icon aria-hidden="true" className="size-3.5" />}
        </button>
      </footer>

      <ContextMenu request={menu} onClose={() => setMenu(null)} />
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
      <QuickOpen open={quickOpen} paths={paths} recent={recent} onClose={() => setQuickOpen(false)} onPick={(path) => open(path)} />
      <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)} />
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
  )
}

/** One editor group: its tab strip, the path of the active file, and whatever that file is. */
function EditorGroup({
  index, group, focused, split, tree, files, changed, lineMarks, browsers, agentRun, wrap, fileEdit, rendered, reveal, gotoLine, find,
  onFocus, onActivate, onKeep, onClose, onTabMenu, onEdit, onCursor, onSave, onReload, onToggleRendered, onSplit, onBrowser, onStartTask,
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
  /** The task the agent pane shows — where a browser tab's Design Mode notes go. */
  agentRun: ApiRun | null
  wrap: boolean
  fileEdit: boolean
  rendered: ReadonlySet<string>
  reveal: { path: string; line: number; nonce: number } | null
  gotoLine: number
  find: number
  onFocus: () => void
  onActivate: (tab: string) => void
  onKeep: (tab: string) => void
  onClose: (tab: string) => void
  onTabMenu: (event: React.MouseEvent, tab: string) => void
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
  const path = tab === null || browser ? null : tabFile(tab)
  const diff = tab !== null && isDiffTab(tab)
  const file = path !== null && !diff ? files[path] : undefined
  const buffer = file?.status === 'ready' ? file.buffer : null
  const conflicted = buffer?.conflict != null
  const readOnly = !fileEdit || (file?.status === 'ready' && !file.editable)
  const marksOfFile = path !== null ? lineMarks.get(path) : undefined
  useEffect(() => { if (!conflicted) setComparing(false) }, [conflicted])

  return (
    <section
      data-slot="code-group"
      data-group={index}
      data-focused={focused ? 'true' : undefined}
      onPointerDownCapture={onFocus}
      className="flex min-w-0 flex-1 flex-col"
    >
      <div
        role="tablist"
        aria-label={split ? `Open files, group ${index + 1}` : 'Open files'}
        className={cn('flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1.5', split && focused && 'border-b-foreground/40')}
      >
        {group.tabs.map((each) => {
          const opened = files[each.path]
          const dirty = isFileTab(each.path) && opened?.status === 'ready' && isDirty(opened.buffer)
          return (
            <div
              key={each.path}
              role="tab"
              aria-selected={each.path === tab}
              data-dirty={dirty ? 'true' : undefined}
              title={isBrowserTab(each.path) ? 'Browser' : tabFile(each.path)}
              onContextMenu={(event) => onTabMenu(event, each.path)}
              onAuxClick={(event) => { if (event.button === 1) onClose(each.path) }}
              className={cn('group flex shrink-0 items-center gap-1 rounded-md py-1 pr-1 pl-2.5 text-xs', each.path === tab ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              <button type="button" className={cn('max-w-56 truncate', each.preview && 'italic')} onClick={() => onActivate(each.path)} onDoubleClick={() => onKeep(each.path)}>
                {tabLabel(each.path, browsers)}
              </button>
              {dirty ? <span aria-label="Unsaved changes" className="size-1.5 rounded-full bg-foreground" /> : null}
              <button type="button" aria-label={`Close ${tabLabel(each.path, browsers)}`} className="rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100" onClick={() => onClose(each.path)}>
                <XIcon aria-hidden="true" className="size-3" />
              </button>
            </div>
          )
        })}
      </div>

      {path !== null && tab !== null ? (
        <div data-slot="code-breadcrumbs" className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-3 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate font-mono">{path.split('/').join('  ›  ')}{diff ? '  ·  changes since the last commit' : ''}</span>
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {!diff && isMarkdown(path) ? (
              <Button variant="ghost" size="icon-xs" aria-label="Toggle Markdown Preview" aria-pressed={rendered.has(path)} title="Toggle Markdown Preview" onClick={() => onToggleRendered(path)}><EyeIcon aria-hidden="true" /></Button>
            ) : null}
            <Button variant="ghost" size="icon-xs" aria-label="Split Editor Right" title="Split Editor Right" onClick={() => onSplit(tab)}><ColumnsIcon aria-hidden="true" /></Button>
            {buffer && isDirty(buffer) && !readOnly ? <Button size="xs" onClick={() => onSave(path, false)}>Save</Button> : null}
          </span>
        </div>
      ) : null}

      {conflicted && path !== null ? (
        <div role="alert" data-slot="code-conflict" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-danger/10 px-3 py-2 text-xs text-foreground">
          <span className="mr-auto">This file changed on disk while you were editing it.</span>
          <Button size="xs" variant="outline" onClick={() => setComparing((value) => !value)}>{comparing ? 'Hide comparison' : 'Compare'}</Button>
          <Button size="xs" variant="outline" onClick={() => onReload(path)}>Reload from disk</Button>
          <Button size="xs" variant="outline" onClick={() => onSave(path, true)}>Overwrite</Button>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        {tab !== null && browser ? (
          <div data-slot="code-browser" className="flex min-w-0 flex-1 flex-col">
            <CodeBrowserTab
              state={browsers[browserId(tab)] ?? { tabs: [''], active: 0 }}
              onChange={(state) => onBrowser(browserId(tab), state)}
              run={agentRun}
              onStartTask={onStartTask}
            />
          </div>
        ) : path === null || tab === null ? (
          <p className="m-auto max-w-sm px-4 text-center text-sm text-pretty text-muted-foreground">
            Pick a file in the explorer, or press {keys('Mod', 'P')} to go to one by name. {keys('Mod', 'Shift', 'P')} lists every command.
          </p>
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
