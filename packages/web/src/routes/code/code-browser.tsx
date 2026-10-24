import { useQuery } from '@tanstack/react-query'
import { PlugZapIcon, TerminalIcon, XIcon } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { isLoopbackPageAddress, queryScope, type ApiRun } from '@open-mercato/cezar-api-client'
import { getRunTerminalUrls, getServices } from '@/api/client'
import type { CodeTree } from '@/api/code'
import { queryKeys, useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { messageWithDesignPicks, pickLabel, type NewDesignPick } from '@/routes/task-thread/design-picks'
import { BrowserView, type DesignMark } from '@/routes/task-workspace/browser-view'
import { DesignNotePopup } from '@/routes/task-workspace/design-note-popup'
import { useDesignNotes } from '@/routes/task-workspace/design-notes'
import type { BrowserState } from '@/routes/task-workspace/layout-state'
import { RunAppPanel } from '@/routes/task-workspace/run-app'

import { answers, appAddress, cockpitLocation, pageSuggestions } from './code-pages'
import type { CodeBrowser } from './code-state'

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
 * reads its terminals' detected addresses; the main checkout reads its services'. The project
 * terminal's own list (`GET /repo/terminal/urls`, terminal spec §4) joins here once it exists.
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
  return useMemo(() => {
    const entries = runId !== null ? runUrls.data?.urls ?? [] : (services.data?.services ?? []).flatMap((service) => service.urls ?? [])
    // Known to answer first, then not probed yet, then known to be down.
    const rank = (running: boolean | null) => (running === true ? 0 : running === null ? 1 : 2)
    const ordered = [...entries].sort((a, b) => rank(a.running) - rank(b.running)).map((entry) => entry.url)
    return pageSuggestions(ordered, cockpitLocation())
  }, [runId, runUrls.data, services.data])
}

/**
 * A browser in an editor tab (spec 2026-10-11-code-page): the app the project serves, beside its
 * code. Design Mode picks an element of the page and turns what the user says about it into work
 * for an agent — a message to the task the agent pane shows, or, with none chosen, a NEW task.
 */
export function CodeBrowserTab({
  state, onChange, run, onStartTask, tree, focusAddress = 0, suggestions, onGateway, onShowTerminal,
}: {
  state: CodeBrowser
  onChange: (state: CodeBrowser) => void
  /** The task the agent pane shows; notes go to it. `null`: each note starts a task of its own. */
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
}) {
  const health = useHealth()
  // Never probed before the cockpit is known to be local: on a hosted one the viewer's own
  // machine is not the app's.
  const local = health.data?.capabilities?.preview === true
  const terminal = health.data?.capabilities?.terminal === true
  const [shown, setShown] = useState(false)
  const listening = useListening(state.url, local && !shown, health.data !== undefined)
  const view: ViewProps = { state, onChange, focusAddress, suggestions, onGateway }
  // A saved address nothing answers at any more (§3 Persistence): the address is kept, and the
  // page comes back on its own once the app is up again.
  if (listening === 'no') {
    return (
      <NothingListening
        url={state.url}
        onEdit={() => setShown(true)}
        runApp={tree.kind === 'run' && terminal
          ? <RunAppPanel runId={tree.runId} projectId={queryScope()} onOpen={(url) => { onChange({ url }); setShown(true) }} {...(onShowTerminal ? { onShowTerminal } : {})} />
          : null}
        {...(onShowTerminal ? { onShowTerminal } : {})}
      />
    )
  }
  if (listening === 'asking') return <p className="grid flex-1 place-items-center text-xs text-soft-foreground">Loading…</p>
  return run ? <TaskBrowser key={run.id} {...view} run={run} /> : <NewTaskBrowser {...view} onStartTask={onStartTask} />
}

interface ViewProps {
  state: CodeBrowser
  onChange: (state: CodeBrowser) => void
  focusAddress: number
  suggestions: readonly string[]
  onGateway: (origin: string | null) => void
}

/** How often a dead saved address is asked again — one opaque request to a loopback port. */
const RELISTEN_MS = 3_000
/** A port that neither answers nor refuses in this long is left to the view's own load timeout. */
const LISTEN_TIMEOUT_MS = 2_500

/** Whether anything answers at `url` — asked only for a loopback address on a LOCAL cockpit. */
function useListening(url: string, enabled: boolean, known: boolean): 'asking' | 'yes' | 'no' {
  const ask = enabled && url !== '' && isLoopbackPageAddress(url)
  const [answer, setAnswer] = useState<{ url: string; up: boolean } | null>(null)
  useEffect(() => {
    if (!ask) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const probe = async () => {
      const controller = new AbortController()
      const giveUp = setTimeout(() => controller.abort(), LISTEN_TIMEOUT_MS)
      const up = await answers(url, controller.signal).then((ok) => ok || controller.signal.aborted)
      clearTimeout(giveUp)
      if (cancelled) return
      setAnswer({ url, up })
      if (!up) timer = setTimeout(() => void probe(), RELISTEN_MS)
    }
    void probe()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [ask, url])
  if (!known && url !== '') return 'asking'
  if (!ask) return 'yes'
  return answer?.url !== url ? 'asking' : answer.up ? 'yes' : 'no'
}

function NothingListening({ url, onEdit, runApp, onShowTerminal }: { url: string; onEdit: () => void; runApp: React.ReactNode; onShowTerminal?: () => void }) {
  return (
    <div data-slot="code-browser-dead" className="flex min-h-0 flex-1 flex-col overflow-auto">
      <CenteredState
        icon={<PlugZapIcon />}
        tone="neutral"
        heading="h2"
        title="Nothing is listening"
        subtitle="This page was open here before, but nothing answers at its address now. Start the app and it comes back on its own."
        actions={(
          <div className="flex flex-wrap items-center justify-center gap-2">
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">{url}</code>
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
function useViewProps({ state, onChange, focusAddress, suggestions, onGateway }: ViewProps) {
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
  } as const
}

/** Notes for an existing task: the task workspace's own notes, receipts and all. */
function TaskBrowser({ run, ...props }: ViewProps & { run: ApiRun }) {
  const notes = useDesignNotes(run)
  const { addDraft, discard, note: noteFor, marks } = notes
  const escape = useCallback((mark: string) => { if (noteFor(mark)?.phase === 'draft') discard(mark) }, [discard, noteFor])
  const view = useViewProps(props)
  return (
    <BrowserView
      {...view}
      onPickElement={addDraft}
      designMarks={marks}
      onDesignEscape={escape}
      renderDesignNote={({ mark, close }) => {
        const note = noteFor(mark)
        return note ? <DesignNotePopup note={note} run={run} notes={notes} onClose={close} /> : null
      }}
    />
  )
}

interface Draft {
  key: string
  pick: NewDesignPick & { mark: string }
  text: string
}

const pathOf = (url: string): string | undefined => {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

/** Notes with no task behind them yet: sending one is what creates the task. */
function NewTaskBrowser({ onStartTask, ...props }: ViewProps & { onStartTask: (message: string) => Promise<void> }) {
  const view = useViewProps(props)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [busy, setBusy] = useState(false)
  const marks = useMemo<DesignMark[]>(
    () => drafts.map((draft) => ({ key: draft.key, selector: draft.pick.selector, path: pathOf(draft.pick.url), label: pickLabel(draft.pick), draft: true })),
    [drafts],
  )
  const discard = useCallback((key: string) => setDrafts((all) => all.filter((draft) => draft.key !== key)), [])
  const add = useCallback((pick: NewDesignPick): boolean => {
    const mark = pick.mark
    if (mark === undefined) return false
    setDrafts((all) => (all.some((draft) => draft.key === mark) ? all : [...all, { key: mark, pick: { ...pick, mark }, text: '' }]))
    return true
  }, [])

  return (
    <BrowserView
      {...view}
      onPickElement={add}
      designMarks={marks}
      onDesignEscape={discard}
      renderDesignNote={({ mark, close }) => {
        const draft = drafts.find((each) => each.key === mark)
        if (!draft) return null
        const dismiss = () => { discard(draft.key); close() }
        const send = async () => {
          if (draft.text.trim() === '' || busy) return
          setBusy(true)
          try {
            await onStartTask(messageWithDesignPicks(draft.text.trim(), [{ ...draft.pick, id: draft.key }]))
            dismiss()
          } catch (error) {
            toast(error instanceof Error && error.message ? error.message : 'Could not start the task.', { tone: 'danger' })
          } finally {
            setBusy(false)
          }
        }
        return (
          <div data-slot="design-note" data-phase="new-task" className="flex flex-col gap-2 p-2.5 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground" title={draft.pick.selector}>{pickLabel(draft.pick)}</span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Discard note" title="Discard this note and deselect the element (Esc)" onClick={dismiss}>
                <XIcon aria-hidden="true" />
              </Button>
            </div>
            <Textarea
              value={draft.text}
              onChange={(event) => setDrafts((all) => all.map((each) => (each.key === draft.key ? { ...each, text: event.target.value.slice(0, 20_000) } : each)))}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); dismiss() }
                else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() }
              }}
              placeholder="What should change here?"
              aria-label="Task for an agent"
              autoFocus
              rows={3}
              className="min-h-16 resize-none text-[13px] md:text-[13px]"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-soft-foreground">Starts a new task with this element attached.</span>
              <Button type="button" size="xs" disabled={busy || draft.text.trim() === ''} onClick={() => void send()}>Start task</Button>
            </div>
          </div>
        )
      }}
    />
  )
}
