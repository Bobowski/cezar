import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FilePlusIcon, GlobeIcon, PanelBottomIcon, PencilIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { queryScope, type ApiRun } from '@open-mercato/cezar-api-client'
import { ApiError } from '@/api/client'
import {
  codeFileRawUrl, createCodeFile, deleteCodeFile, getCodeChanges, getCodeFile, getCodeTree, getCodeWatch, renameCodeFile, saveCodeFile,
  treeKey, type CodeTree,
} from '@/api/code'
import { useHostTransport } from '@/api/host-usage'
import { useHealth, useRuns } from '@/api/queries'
import { subscribeTopic } from '@/api/ws'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'
import { cn } from '@/lib/utils'
import { matchPaths } from '@/routes/repo-git/match-paths'
import { RepoFileBrowser } from '@/routes/repo-git/repo-files'
import { isImagePath } from '@/routes/task-git/worktree-files'
import { BrowserView } from '@/routes/task-workspace/browser-view'
import { emptyBrowserState, type BrowserState } from '@/routes/task-workspace/layout-state'

import { CodePanelView } from './code-panel'
import {
  bufferFrom, closeTab, isDirty, keepTab, loadDraft, loadLayout, openTab, reconcile, resolveConflict, retargetTab, saveDraft, saveLayout,
  stepTab, type Buffer, type CodeLayout, type CodePanel,
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
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
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

  const [layout, setLayout] = useState<CodeLayout>(() => {
    const stored = loadLayout(storage(), projectId, key)
    return initialPath ? { ...stored, ...openTab(stored, initialPath, true) } : stored
  })
  const [files, setFiles] = useState<Record<string, OpenFile>>({})
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'rename' | 'delete'; path: string } | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [discarding, setDiscarding] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const [searchFocus, setSearchFocus] = useState(0)
  const [browser, setBrowser] = useState<BrowserState>(emptyBrowserState)
  const filesRef = useRef(files)
  filesRef.current = files
  const active = layout.active
  const current = active ? files[active] : undefined

  const treeQuery = useQuery({ queryKey: ['code', 'tree', projectId, key], queryFn: ({ signal }) => getCodeTree(tree, { signal }) })
  const changes = useQuery({ queryKey: ['code', 'changes', projectId, key], queryFn: ({ signal }) => getCodeChanges(tree, { signal }) })
  const watch = useQuery({ queryKey: ['code', 'watch', projectId, key], queryFn: ({ signal }) => getCodeWatch(tree, { signal }), staleTime: Infinity })
  const marks = useMemo(
    () => new Map((changes.data?.files ?? []).map((file) => [file.path, STATUS_LETTER[file.status] ?? 'M'])),
    [changes.data],
  )
  const paths = treeQuery.data?.paths ?? []

  useEffect(() => saveLayout(storage(), projectId, key, layout), [layout, projectId, key])

  // The active file's path IS the page's address, replaced rather than pushed (as `/git/files`).
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

  useEffect(() => {
    if (active && files[active] === undefined) {
      setFile(active, { status: 'loading' })
      void load(active)
    }
  }, [active, files, load, setFile])

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

  const anyDirty = Object.values(files).some((file) => file.status === 'ready' && isDirty(file.buffer))
  useEffect(() => {
    if (!anyDirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])

  const edit = (path: string, text: string) => {
    setLayout((state) => ({ ...state, ...keepTab(state, path) }))
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
      setComparing(false)
      void queryClient.invalidateQueries({ queryKey: ['code', 'changes', projectId, key] })
    } catch (error) {
      // A refusal may be the other writer: re-read, which raises the banner if disk moved.
      if (error instanceof ApiError && error.status === 409) void load(path)
      toast((error as Error).message, { tone: 'danger' })
    }
  }, [key, load, projectId, queryClient, setFile, tree])

  const open = useCallback((path: string, line?: number, keep = true) => {
    setLayout((state) => ({ ...state, ...openTab(state, path, keep) }))
    if (line !== undefined) setReveal((previous) => ({ path, line, nonce: (previous?.nonce ?? 0) + 1 }))
  }, [])

  const close = (path: string, discard = false) => {
    const file = files[path]
    if (!discard && file?.status === 'ready' && isDirty(file.buffer)) return setDiscarding(path)
    setDiscarding(null)
    saveDraft(storage(), projectId, key, path, undefined)
    setFile(path, () => undefined)
    setLayout((state) => ({ ...state, ...closeTab(state, path) }))
  }

  const togglePanel = useCallback((panel: CodePanel | null) => setLayout((state) => ({ ...state, panel })), [])

  // Keyboard (spec §3). A browser tab cannot take Ctrl+W or Ctrl+Tab, hence the Alt forms.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      const letter = event.key.toLowerCase()
      if (mod && !event.shiftKey && letter === 's') {
        event.preventDefault()
        if (layout.active) void save(layout.active)
      } else if (mod && !event.shiftKey && letter === 'p') {
        event.preventDefault()
        setQuickOpen(true)
      } else if (mod && event.shiftKey && letter === 'f') {
        event.preventDefault()
        togglePanel('search')
        setSearchFocus((value) => value + 1)
      } else if (event.ctrlKey && event.key === '`') {
        event.preventDefault()
        togglePanel(layout.panel === null ? (terminalAllowed ? 'terminal' : 'search') : null)
      } else if (event.altKey && letter === 'w' && layout.active) {
        event.preventDefault()
        close(layout.active)
      } else if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.preventDefault()
        setLayout((state) => ({ ...state, ...stepTab(state, event.key === 'ArrowRight' ? 1 : -1) }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // No question asked: unsaved typing is a draft of THIS checkout and is there on the way back.
  const switchTree = (value: string) => {
    navigate(value === 'main' ? '/code' : `/code?tree=${encodeURIComponent(value)}`)
  }

  const afterFileOp = (from: string | null, to: string | null) => {
    if (from !== null) {
      saveDraft(storage(), projectId, key, from, undefined)
      setFile(from, () => undefined)
      setLayout((state) => ({ ...state, ...retargetTab(state, from, to) }))
    } else if (to !== null) {
      open(to)
    }
    revalidate()
  }

  const buffer = current?.status === 'ready' ? current.buffer : null
  const readOnly = !fileEdit || (current?.status === 'ready' && !current.editable)
  const worktrees = checkoutRuns(runs.data)
  const dialogFile = dialog !== null && dialog.kind !== 'create' ? files[dialog.path] : undefined

  return (
    <div data-route="code" data-tree={key} className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <NativeSelect aria-label="Checkout" value={key} onChange={(event) => switchTree(event.target.value)} className="h-8 max-w-64 text-[13px]">
          <NativeSelectOption value="main">Main checkout</NativeSelectOption>
          {tree.kind === 'run' && !worktrees.some((run) => run.id === tree.runId) ? <NativeSelectOption value={tree.runId}>Task {tree.runId.slice(0, 8)}</NativeSelectOption> : null}
          {worktrees.map((run) => <NativeSelectOption key={run.id} value={run.id}>{runTitle(run)}</NativeSelectOption>)}
        </NativeSelect>
        <Button variant="outline" size="sm" onClick={() => setQuickOpen(true)}><SearchIcon aria-hidden="true" /> Go to file</Button>
        {fileEdit ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="New file" onClick={() => setDialog({ kind: 'create' })}><FilePlusIcon aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Rename file" disabled={!active} onClick={() => active && setDialog({ kind: 'rename', path: active })}><PencilIcon aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Delete file" disabled={!active} onClick={() => active && setDialog({ kind: 'delete', path: active })}><Trash2Icon aria-hidden="true" /></Button>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {buffer && isDirty(buffer) && !readOnly ? <Button size="sm" onClick={() => active && void save(active)}>Save</Button> : null}
          <Button variant="ghost" size="icon-sm" aria-label="Toggle panel" aria-pressed={layout.panel !== null} onClick={() => togglePanel(layout.panel === null ? (terminalAllowed ? 'terminal' : 'search') : null)}><PanelBottomIcon aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Toggle preview" aria-pressed={layout.preview} onClick={() => setLayout((state) => ({ ...state, preview: !state.preview }))}><GlobeIcon aria-hidden="true" /></Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside data-slot="code-tree" className="hidden w-64 shrink-0 overflow-y-auto border-r border-border p-2 md:block">
          {treeQuery.isPending ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading files…</p> : null}
          {treeQuery.isError ? <p role="alert" className="px-2 py-1.5 text-xs text-danger">{treeQuery.error.message}</p> : null}
          {treeQuery.data ? (
            <RepoFileBrowser paths={paths} selected={active} marks={marks} onSelect={(path) => open(path, undefined, false)} onOpen={(path) => open(path)} />
          ) : null}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div role="tablist" aria-label="Open files" className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1.5 py-1">
            {layout.tabs.map((tab) => {
              const file = files[tab.path]
              const dirty = file?.status === 'ready' && isDirty(file.buffer)
              return (
                <div
                  key={tab.path}
                  role="tab"
                  aria-selected={tab.path === active}
                  data-dirty={dirty ? 'true' : undefined}
                  title={tab.path}
                  className={cn('group flex shrink-0 items-center gap-1 rounded-md py-1 pr-1 pl-2.5 text-xs', tab.path === active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  <button
                    type="button"
                    className={cn('max-w-48 truncate', tab.preview && 'italic')}
                    onClick={() => setLayout((state) => ({ ...state, active: tab.path }))}
                    onDoubleClick={() => setLayout((state) => ({ ...state, ...keepTab(state, tab.path) }))}
                  >
                    {tab.path.slice(tab.path.lastIndexOf('/') + 1)}
                  </button>
                  {dirty ? <span aria-label="Unsaved changes" className="size-1.5 rounded-full bg-foreground" /> : null}
                  <button type="button" aria-label={`Close ${tab.path}`} className="rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100" onClick={() => close(tab.path)}>
                    <XIcon aria-hidden="true" className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>

          {buffer?.conflict ? (
            <div role="alert" data-slot="code-conflict" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-danger/10 px-3 py-2 text-xs text-foreground">
              <span className="mr-auto">This file changed on disk while you were editing it.</span>
              <Button size="xs" variant="outline" onClick={() => setComparing((value) => !value)}>{comparing ? 'Hide comparison' : 'Compare'}</Button>
              <Button size="xs" variant="outline" onClick={() => { if (!active) return; setFile(active, (file) => (file?.status === 'ready' ? { ...file, buffer: resolveConflict(file.buffer, 'reload') } : file)); saveDraft(storage(), projectId, key, active, undefined); setComparing(false) }}>Reload from disk</Button>
              <Button size="xs" variant="outline" onClick={() => active && void save(active, true)}>Overwrite</Button>
            </div>
          ) : null}

          <div className="relative flex min-h-0 flex-1">
            {active === null ? (
              <p className="m-auto max-w-sm px-4 text-center text-sm text-pretty text-muted-foreground">
                Pick a file from the tree, or press {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+P to go to one by name.
              </p>
            ) : current === undefined || current.status === 'loading' ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : current.status === 'error' ? (
              <p role="alert" className="p-4 text-sm text-danger">{current.error}</p>
            ) : current.status === 'unsupported' ? (
              <p className="p-4 text-sm text-muted-foreground">{current.reason}</p>
            ) : current.status === 'image' ? (
              <div className="flex flex-1 items-center justify-center overflow-auto p-4"><img src={codeFileRawUrl(tree, active)} alt={active} className="max-h-full max-w-full" /></div>
            ) : (
              <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading the editor…</p>}>
                <CodeMirrorEditor
                  key={active}
                  path={active}
                  value={current.buffer.draft ?? current.buffer.content}
                  onChange={(text) => edit(active, text)}
                  readOnly={readOnly}
                  {...(reveal?.path === active ? { revealLine: { line: reveal.line, nonce: reveal.nonce } } : {})}
                  aria-label={`Editing ${active}`}
                  className="min-w-0 flex-1"
                />
                {comparing && current.buffer.conflict ? (
                  <div data-slot="code-compare" className="flex min-w-0 flex-1 flex-col border-l border-border">
                    <p className="shrink-0 border-b border-border px-3 py-1 text-xs text-muted-foreground">On disk now</p>
                    <CodeMirrorEditor key={`${active}:disk`} path={active} value={current.buffer.conflict.diskContent} readOnly aria-label={`${active} on disk`} className="min-h-0 flex-1" />
                  </div>
                ) : null}
              </Suspense>
            )}
          </div>

          <footer data-slot="code-status" className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
            <span className="truncate font-mono">{active ?? ''}</span>
            <span className="ml-auto shrink-0">
              {!fileEdit ? 'Read-only: file editing is off on this cockpit'
                : current?.status === 'ready' && !current.editable ? `Read-only: ${current.reason ?? 'this file cannot be edited'}`
                  : buffer && isDirty(buffer) ? 'Unsaved changes' : buffer ? 'Saved' : ''}
            </span>
          </footer>

          {layout.panel !== null ? (
            <CodePanelView tree={tree} panel={layout.panel} onPanel={togglePanel} onOpen={(path, line) => open(path, line)} terminalAllowed={terminalAllowed} searchFocus={searchFocus} />
          ) : null}
        </main>

        {layout.preview ? (
          <aside data-slot="code-preview" className="hidden w-[38%] min-w-80 shrink-0 flex-col border-l border-border lg:flex">
            <BrowserView state={browser} onChange={setBrowser} />
          </aside>
        ) : null}
      </div>

      <AlertDialog open={discarding !== null} onOpenChange={(next) => { if (!next) setDiscarding(null) }}>
        <AlertDialogContent data-slot="code-discard-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              <code className="font-mono text-xs text-foreground">{discarding}</code> has edits that were never saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => discarding !== null && close(discarding, true)}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <QuickOpen open={quickOpen} paths={paths} onClose={() => setQuickOpen(false)} onPick={(path) => { setQuickOpen(false); open(path) }} />
      <FileDialog
        tree={tree}
        action={dialog}
        dirty={dialogFile?.status === 'ready' && isDirty(dialogFile.buffer)}
        // No pending change means disk equals the committed version: a delete loses nothing.
        tracked={dialog !== null && dialog.kind !== 'create' && !marks.has(dialog.path)}
        onClose={() => setDialog(null)}
        onDone={afterFileOp}
      />
    </div>
  )
}

/** Ctrl/Cmd+P: a client-side match over the path index — the same matcher the tree's filter uses. */
function QuickOpen({ open, paths, onClose, onPick }: { open: boolean; paths: readonly string[]; onClose: () => void; onPick: (path: string) => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  useEffect(() => { if (open) { setQuery(''); setIndex(0) } }, [open])
  const results = useMemo(() => (query.trim() === '' ? [] : matchPaths(paths, query, 30).results), [paths, query])
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent data-slot="code-quick-open" className="top-[20%] translate-y-0 gap-2 p-3">
        <DialogHeader className="sr-only"><DialogTitle>Go to file</DialogTitle><DialogDescription>Type part of a path.</DialogDescription></DialogHeader>
        <Input
          autoFocus
          aria-label="Go to file"
          value={query}
          placeholder="Go to file…"
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(results.length - 1, value + 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)) }
            else if (event.key === 'Enter' && results[index]) { event.preventDefault(); onPick(results[index] as string) }
          }}
        />
        <ul role="listbox" aria-label="Matching files" className="max-h-80 overflow-y-auto text-[13px]">
          {results.map((path, at) => (
            <li key={path} role="option" aria-selected={at === index}>
              <button type="button" className={cn('w-full truncate rounded-md px-2 py-1 text-left font-mono', at === index ? 'bg-accent text-foreground' : 'text-muted-foreground')} onMouseEnter={() => setIndex(at)} onClick={() => onPick(path)}>
                {path}
              </button>
            </li>
          ))}
          {query.trim() !== '' && results.length === 0 ? <li className="px-2 py-1 text-xs text-muted-foreground">No file matches.</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/** Create, rename, delete — files only. The server's refusal is shown in its own words. */
function FileDialog({
  tree, action, dirty, tracked, onClose, onDone,
}: {
  tree: CodeTree
  action: { kind: 'create' } | { kind: 'rename' | 'delete'; path: string } | null
  /** The file has unsaved edits here. */
  dirty: boolean
  /** The file is clean in git: a delete is recoverable from history. */
  tracked: boolean
  onClose: () => void
  onDone: (from: string | null, to: string | null) => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const seed = action === null || action.kind === 'create' ? '' : action.path
  useEffect(() => { setValue(seed); setError(null) }, [seed, action?.kind])
  if (action === null) return null

  const run = async () => {
    const path = value.trim()
    setPending(true)
    setError(null)
    try {
      if (action.kind === 'create') {
        await createCodeFile(tree, path)
        onDone(null, path)
      } else if (action.kind === 'rename') {
        await renameCodeFile(tree, { from: action.path, to: path })
        onDone(action.path, path)
      } else {
        await deleteCodeFile(tree, action.path)
        onDone(action.path, null)
      }
      onClose()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setPending(false)
    }
  }
  const title = action.kind === 'create' ? 'New file' : action.kind === 'rename' ? 'Rename file' : 'Delete this file?'
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose() }}>
      <DialogContent data-slot="code-file-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {action.kind === 'delete'
              ? tracked ? 'It is removed from this checkout. Git still has the committed version.' : 'It is removed from this checkout. Changes that were never committed cannot be recovered from git.'
              : 'A path inside this checkout. Missing folders are created.'}
            {dirty ? ' Unsaved edits in the editor are discarded.' : ''}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void run() }} className="flex flex-col gap-3">
          {action.kind === 'delete' ? (
            <code className="block truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">{action.path}</code>
          ) : (
            <Input autoFocus aria-label="Path" value={value} onChange={(event) => setValue(event.target.value)} placeholder="src/new-file.ts" spellCheck={false} autoComplete="off" className="font-mono" />
          )}
          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
            <Button type="submit" variant={action.kind === 'delete' ? 'destructive' : 'primary'} disabled={pending || (action.kind !== 'delete' && (value.trim() === '' || value.trim() === seed))}>
              {action.kind === 'create' ? 'Create' : action.kind === 'rename' ? 'Rename' : 'Delete'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
