import { useQuery } from '@tanstack/react-query'
import { MessageSquareIcon, PlugZapIcon, TerminalIcon, XIcon } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { isLoopbackPageAddress, queryScope, type ApiRun } from '@open-mercato/cezar-api-client'
import { getRunTerminalUrls, getServices } from '@/api/client'
import { getProjectTerminalUrls, type CodeTree } from '@/api/code'
import { useProjectScope } from '@/api/project-scope-context'
import { queryKeys, useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { readDraft, writeDraft } from '@/routes/new-task-draft'
import { formatDesignNotesTask, messageWithDesignPicks, pickLabel } from '@/routes/task-thread/design-picks'
import { formatSource } from '@/routes/task-thread/design-source'
import { BrowserView, type DesignMark } from '@/routes/task-workspace/browser-view'
import { DesignNotePopup } from '@/routes/task-workspace/design-note-popup'
import { useDesignNotes, type NotePick } from '@/routes/task-workspace/design-notes'
import type { BrowserState } from '@/routes/task-workspace/layout-state'
import { PromptQueueDrawer } from '@/routes/task-workspace/prompt-queue-drawer'
import { RunAppPanel } from '@/routes/task-workspace/run-app'
import { useSourceRoots } from '@/routes/task-workspace/source-roots'

import { answers, appAddress, cockpitLocation, pageSuggestions } from './code-pages'
import type { CodeBrowser } from './code-state'
import { setPendingDesignStart, useProjectDesignDrafts } from './project-design-drafts'

/**
 * Open a page of the project's app in a Browser tab of the Code page — for anything rendered
 * inside it (the terminal's address strip and links, spec 2026-10-24-code-page-terminal §3.1–3.2).
 * Answers false, opening nothing, for an address a Browser tab may not show (§3 Scope): the
 * caller opens that one in a new window instead. `beside`: in a new group to the right.
 */
export type OpenBrowserTab = (url: string, options?: { beside?: boolean }) => boolean
export const OpenBrowserTabContext = createContext<OpenBrowserTab>(() => false)
export const useOpenBrowserTab = (): OpenBrowserTab => useContext(OpenBrowserTabContext)

/**
 * The addresses to suggest for a new page: what this checkout's processes printed. A task's tree
 * reads its terminals' detected addresses; the main checkout reads its services' and its project
 * terminals' (`GET /repo/terminal/urls`, terminal spec §4).
 */
export function useDetectedAddresses(tree: CodeTree): string[] {
  const terminal = useHealth().data?.capabilities?.terminal === true
  const runId = tree.kind === 'run' ? tree.runId : null
  const runUrls = useQuery({
    queryKey: ['code', 'addresses', queryScope(), runId],
    queryFn: () => getRunTerminalUrls(runId as string),
    enabled: terminal && runId !== null,
    staleTime: 5_000,
  })
  const services = useQuery({
    queryKey: queryKeys.services.list(),
    queryFn: ({ signal }) => getServices({ signal }),
    enabled: terminal && runId === null,
  })
  const projectUrls = useQuery({
    queryKey: ['code', 'addresses', queryScope(), 'project'],
    queryFn: () => getProjectTerminalUrls(),
    enabled: terminal && runId === null,
    staleTime: 5_000,
  })
  return useMemo(() => {
    const entries = runId !== null
      ? runUrls.data?.urls ?? []
      : [...(services.data?.services ?? []).flatMap((service) => service.urls ?? []), ...(projectUrls.data?.urls ?? [])]
    // Known to answer first, then not probed yet, then known to be down.
    const rank = (running: boolean | null) => (running === true ? 0 : running === null ? 1 : 2)
    const ordered = [...new Set([...entries].sort((a, b) => rank(a.running) - rank(b.running)).map((entry) => entry.url))]
    return pageSuggestions(ordered, cockpitLocation())
  }, [runId, runUrls.data, services.data, projectUrls.data])
}

/**
 * A browser in an editor tab (spec 2026-10-11-code-page): the app the project serves, beside its
 * code. Design Mode picks an element of the page and turns what the user says about it into work
 * for an agent — a message to the task the agent pane shows, or, with none chosen, notes that
 * collect until a NEW task is started from them (spec 2026-10-24-design-mode-third-cut §3.2).
 */
export function CodeBrowserTab({
  state, onChange, run, onStartTask, tree, focusAddress = 0, suggestions, onGateway, onShowTerminal, remembered, onRemember,
}: {
  state: CodeBrowser
  onChange: (state: CodeBrowser) => void
  /** The task the agent pane shows; notes go to it. `null`: notes collect for a new task. */
  run: ApiRun | null
  /** Start a task from one note's text. Resolves once the task exists. */
  onStartTask: (message: string) => Promise<void>
  /** The checkout the page shows — a task's tree offers that task's Run app on a dead address. */
  tree: CodeTree
  /** Bumped to put the cursor in the address bar (Ctrl/Cmd+T). */
  focusAddress?: number
  suggestions: readonly string[]
  onGateway: (origin: string | null) => void
  /** Open the Code page's terminal panel; absent where the terminal is not allowed. */
  onShowTerminal?: () => void
  /** What this tab knew about its address when it was last shown: a tab switched back to picks up
   *  there instead of probing again. Held by the workbench, keyed by tab id. */
  remembered?: PageProbe
  onRemember?: (probe: PageProbe) => void
}) {
  const health = useHealth()
  // Never probed before the cockpit is known to be local: on a hosted one the viewer's own
  // machine is not the app's.
  const local = health.data?.capabilities?.preview === true
  const terminal = health.data?.capabilities?.terminal === true
  // Only an address set from OUTSIDE the view is probed (a restored one, Retry) — never the user's
  // own navigation, which the view reports through `onChange`. The view is never unmounted for it.
  const [initial] = useState<PageProbe>(() => remembered ?? { own: null, seen: state.url, probe: state.url, down: null })
  const own = useRef<string | null>(initial.own)
  const [seen, setSeen] = useState(initial.seen)
  const [probe, setProbe] = useState<string | null>(initial.probe)
  if (state.url !== seen) {
    setSeen(state.url)
    setProbe(own.current === state.url ? null : state.url)
  }
  const [retry, setRetry] = useState(0)
  const [revived, setRevived] = useState(0)
  const [edit, setEdit] = useState(0)
  const revive = useCallback(() => setRevived((count) => count + 1), [])
  // A gateway origin is only true of a mounted view: switching away or closing the tab forgets it.
  const reportGateway = useRef(onGateway)
  reportGateway.current = onGateway
  useEffect(() => () => reportGateway.current(null), [])
  const listening = useListening(state.url, local && probe === state.url, retry, revive, initial.down)
  // An address found answering is settled: nothing asks it again, here or on a remount.
  useEffect(() => { if (listening === 'yes') setProbe(null) }, [listening])
  const remember = useRef(onRemember)
  remember.current = onRemember
  useEffect(() => { remember.current?.({ own: own.current, seen, probe, down: listening === 'no' ? state.url : null }) })
  const change = useCallback((next: CodeBrowser) => {
    own.current = next.url
    onChange(next)
  }, [onChange])
  // On a hosted cockpit a loopback address goes through the gateway: nothing is framed until
  // health says which kind this is.
  if (health.data === undefined && state.url !== '') return <p className="grid flex-1 place-items-center text-xs text-soft-foreground">Loading…</p>
  const view: ViewProps = { state, onChange: change, focusAddress: focusAddress + edit, suggestions, onGateway, reloadSignal: revived }
  return (
    <div data-slot="code-browser-page" className="relative flex min-h-0 flex-1 flex-col">
      {run ? <TaskBrowser key={run.id} {...view} run={run} /> : <NewTaskBrowser {...view} onStartTask={onStartTask} />}
      {/* A saved address nothing answers at any more (§3 Persistence): the address is kept, and
          the page comes back on its own once the app is up again. */}
      {listening === 'no' ? (
        <NothingListening
          url={state.url}
          onEdit={() => { setProbe(null); setEdit((count) => count + 1) }}
          onRetry={() => setRetry((count) => count + 1)}
          runApp={tree.kind === 'run' && terminal
            ? <RunAppPanel runId={tree.runId} projectId={queryScope()} onOpen={(url) => { setProbe(null); change({ url }); revive() }} {...(onShowTerminal ? { onShowTerminal } : {})} />
            : null}
          {...(onShowTerminal ? { onShowTerminal } : {})}
        />
      ) : listening === 'asking' ? (
        <p data-slot="code-browser-asking" className="absolute inset-0 z-20 grid place-items-center bg-background text-xs text-soft-foreground">Loading…</p>
      ) : null}
    </div>
  )
}

/** A Browser tab's knowledge of its address, kept across remounts (see `CodeBrowserTab`). */
export interface PageProbe {
  /** The last address the view itself navigated to. */
  own: string | null
  seen: string
  /** The address still to be asked whether anything answers there; `null`: settled. */
  probe: string | null
  /** An address last found down. */
  down: string | null
}

interface ViewProps {
  state: CodeBrowser
  onChange: (state: CodeBrowser) => void
  focusAddress: number
  suggestions: readonly string[]
  onGateway: (origin: string | null) => void
  reloadSignal: number
}

/** How often a dead saved address is asked again — one opaque request to a loopback port. */
const RELISTEN_MS = 3_000
/** A port that neither answers nor refuses in this long is left to the view's own load timeout. */
const LISTEN_TIMEOUT_MS = 2_500

/**
 * Whether anything answers at `url` — asked only for a loopback address on a LOCAL cockpit.
 * `retry` asks again at once; `onBack` fires when an address that was down answers again;
 * `knownDown` is an address already found down (a remount shows that while it asks again).
 * `'off'`: not asked at all.
 */
function useListening(url: string, enabled: boolean, retry: number, onBack: () => void, knownDown: string | null = null): 'off' | 'asking' | 'yes' | 'no' {
  const ask = enabled && url !== '' && isLoopbackPageAddress(url)
  const [answer, setAnswer] = useState<{ url: string; up: boolean } | null>(knownDown === null ? null : { url: knownDown, up: false })
  const back = useRef(onBack)
  back.current = onBack
  useEffect(() => {
    if (!ask) return
    let cancelled = false
    let down = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const probe = async () => {
      const controller = new AbortController()
      const giveUp = setTimeout(() => controller.abort(), LISTEN_TIMEOUT_MS)
      const up = await answers(url, controller.signal).then((ok) => ok || controller.signal.aborted)
      clearTimeout(giveUp)
      if (cancelled) return
      setAnswer((previous) => {
        if (up && (down || (previous?.url === url && !previous.up))) back.current()
        return { url, up }
      })
      down ||= !up
      if (!up) timer = setTimeout(() => void probe(), RELISTEN_MS)
    }
    void probe()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [ask, url, retry])
  if (!ask) return 'off'
  return answer?.url !== url ? 'asking' : answer.up ? 'yes' : 'no'
}

function NothingListening({ url, onEdit, onRetry, runApp, onShowTerminal }: { url: string; onEdit: () => void; onRetry: () => void; runApp: React.ReactNode; onShowTerminal?: () => void }) {
  return (
    <div data-slot="code-browser-dead" className="absolute inset-0 z-20 flex flex-col overflow-auto bg-background">
      <CenteredState
        icon={<PlugZapIcon />}
        tone="neutral"
        heading="h2"
        title="Nothing is listening"
        subtitle="This page was open here before, but nothing answers at its address now. Start the app and it comes back on its own."
        actions={(
          <div className="flex flex-wrap items-center justify-center gap-2">
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">{url}</code>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button>
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>Edit the address</Button>
            {onShowTerminal ? <Button type="button" variant="outline" size="sm" onClick={onShowTerminal}><TerminalIcon aria-hidden="true" />Open the terminal</Button> : null}
          </div>
        )}
      />
      {runApp}
    </div>
  )
}

const toBrowserState = (state: CodeBrowser): BrowserState => ({ tabs: [state.url], active: 0 })
const fromBrowserState = (state: BrowserState): CodeBrowser => ({ url: state.tabs[state.active] ?? state.tabs[0] ?? '' })

/** The Code page's rule for the address bar (§3 Scope), worded for the inline refusal. */
function checkAddress(url: string): { ok: true; url: string } | { ok: false; message: string } {
  const checked = appAddress(url, cockpitLocation())
  if (checked.ok) return checked
  return {
    ok: false,
    message: checked.reason === 'cockpit'
      ? 'That is this cockpit. A Browser tab shows the project’s own app.'
      : 'A Browser tab shows the project’s own app — a local address or its preview. For anything else, open it in your browser.',
  }
}

const EMPTY_SUBTITLE = 'Enter the address of the project’s app, e.g. localhost:3000.'

/** The props every Code browser hands `BrowserView`. */
function useViewProps({ state, onChange, focusAddress, suggestions, onGateway, reloadSignal }: ViewProps) {
  const change = useCallback((next: BrowserState) => onChange(fromBrowserState(next)), [onChange])
  return {
    singleTab: true,
    state: toBrowserState(state),
    onChange: change,
    checkAddress,
    suggestions,
    focusAddress,
    onGateway,
    emptySubtitle: EMPTY_SUBTITLE,
    reloadSignal,
  } as const
}

/** Notes for an existing task: the task workspace's own notes, receipts and all. */
function TaskBrowser({ run, ...props }: ViewProps & { run: ApiRun }) {
  const notes = useDesignNotes(run)
  const { addDraft, discard, note: noteFor, marks } = notes
  const sourceRoots = useSourceRoots(run)
  const escape = useCallback((mark: string) => { if (noteFor(mark)?.phase === 'draft') discard(mark) }, [discard, noteFor])
  const view = useViewProps(props)
  return (
    <BrowserView
      {...view}
      onPickElement={addDraft}
      designMarks={marks}
      onDesignEscape={escape}
      sourceRoots={sourceRoots}
      designToolbar={<PromptQueueDrawer run={run} notes={notes} />}
      renderDesignNote={({ mark, close }) => {
        const note = noteFor(mark)
        return note ? <DesignNotePopup note={note} run={run} notes={notes} onClose={close} /> : null
      }}
    />
  )
}

/** A note already started as a task of its own: framed and numbered until the page reloads. */
interface Started {
  key: string
  pick: NotePick
  text: string
  number: number
}

/** Notes with no task behind them yet: they collect, and starting a task is what consumes them. */
function NewTaskBrowser({ onStartTask, ...props }: ViewProps & { onStartTask: (message: string) => Promise<void> }) {
  const view = useViewProps(props)
  const { drafts, marks: draftMarks, unsaved, draft: draftFor, add, setText, discard, consume } = useProjectDesignDrafts()
  const { projectId } = useProjectScope()
  const navigate = useNavigate()
  const sourceRoots = useSourceRoots(null)
  const [started, setStarted] = useState<Started[]>([])
  const [busy, setBusy] = useState(false)
  const marks = useMemo<DesignMark[]>(
    () => [...draftMarks, ...started.map((note) => ({ key: note.key, n: note.number, label: pickLabel(note.pick), draft: false }))],
    [draftMarks, started],
  )

  /** §3.2: the `/new` composer, its text the notes in order; starting the task consumes them. */
  const startWithAll = () => {
    if (drafts.length === 0) return
    let text: string
    try {
      text = formatDesignNotesTask(drafts)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Too many notes for one task.', { tone: 'danger' })
      return
    }
    // The composer may hold unsent work: the notes join it rather than replace it, and only once.
    const current = readDraft(projectId)
    const kept = current.text.trim()
    const next = kept === '' ? text : kept.includes(text.trim()) ? current.text : `${kept}\n\n${text}`
    writeDraft({ ...current, text: next }, projectId)
    setPendingDesignStart(projectId, drafts.map((draft) => draft.key))
    navigate('/new?design=1')
  }

  /** One note alone, started at once with defaults, as before the third cut. */
  const startOne = async (key: string): Promise<boolean> => {
    const draft = draftFor(key)
    if (!draft || busy) return false
    setBusy(true)
    try {
      await onStartTask(messageWithDesignPicks(draft.text.trim(), [{ ...draft.pick, id: draft.key }]))
      consume([key])
      setStarted((all) => [...all, { key, pick: draft.pick, text: draft.text.trim(), number: all.length + 1 }])
      return true
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : 'Could not start the task.', { tone: 'danger' })
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <BrowserView
      {...view}
      onPickElement={add}
      designMarks={marks}
      onDesignEscape={discard}
      sourceRoots={sourceRoots}
      designToolbar={
        drafts.length > 0 ? (
          <>
            {unsaved ? (
              <span data-slot="design-drafts-unsaved" className="ml-1 text-xs text-destructive" title="The last save was refused — these notes are only in this tab">
                Not saved
              </span>
            ) : null}
            <Button type="button" data-slot="design-start-all" size="sm" className="ml-1" onClick={startWithAll} title="Open New task with every collected note as its text">
              Start task with {drafts.length} {drafts.length === 1 ? 'note' : 'notes'}
            </Button>
          </>
        ) : null
      }
      renderDesignNote={({ mark, close }) => {
        const done = started.find((each) => each.key === mark)
        if (done) {
          return (
            <div data-slot="design-note" data-phase="started" className="flex flex-col gap-2 p-2.5 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="flex h-[21px] shrink-0 items-center gap-1 rounded-md bg-primary pr-[7px] pl-1.5 text-xs leading-none font-bold text-primary-foreground">
                  <MessageSquareIcon aria-hidden="true" className="size-3" strokeWidth={2.5} />
                  {done.number}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground">{pickLabel(done.pick)}</span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Close" onClick={close}>
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
              <p className="text-soft-foreground">Started as a task of its own.</p>
            </div>
          )
        }
        const draft = draftFor(mark)
        if (!draft) return null
        const dismiss = () => { discard(draft.key); close() }
        const index = drafts.findIndex((each) => each.key === draft.key)
        return (
          <div data-slot="design-note" data-phase="new-task" className="flex flex-col gap-2 p-2.5 text-xs">
            <div className="flex items-center gap-1.5">
              <span data-slot="design-note-number" className="shrink-0 rounded-md border border-border px-1.5 text-[11px] font-semibold tabular-nums text-soft-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground" title={draft.pick.selector}>{pickLabel(draft.pick)}</span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Discard note" title="Discard this note and deselect the element (Esc)" onClick={dismiss}>
                <XIcon aria-hidden="true" />
              </Button>
            </div>
            {draft.pick.source ? (
              <p data-slot="design-note-source" className="-mt-1 truncate font-mono text-[11px] text-soft-foreground">{formatSource(draft.pick.source)}</p>
            ) : null}
            <Textarea
              value={draft.text}
              onChange={(event) => setText(draft.key, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); dismiss() }
                else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); close() }
              }}
              placeholder="What should change here?"
              aria-label="Note for a new task"
              autoFocus
              rows={3}
              className="min-h-16 resize-none text-[13px] md:text-[13px]"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-soft-foreground">Collected for a new task — pick more elements, then Start task.</span>
              <Button type="button" variant="outline" size="xs" disabled={busy || draft.text.trim() === ''} onClick={() => void startOne(draft.key).then((ok) => { if (ok) close() })}>
                Start task with this note
              </Button>
            </div>
          </div>
        )
      }}
    />
  )
}
