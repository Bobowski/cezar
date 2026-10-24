import { MessageSquareIcon, XIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { useProjectScope } from '@/api/project-scope-context'
import type { ApiRun } from '@open-mercato/cezar-api-client'
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
import { PromptQueueDrawer } from '@/routes/task-workspace/prompt-queue-drawer'
import { useSourceRoots } from '@/routes/task-workspace/source-roots'

import type { CodeBrowser } from './code-state'
import { setPendingDesignStart, useProjectDesignDrafts } from './project-design-drafts'

/**
 * A browser in an editor tab (spec 2026-10-11-code-page): the app the project serves, beside its
 * code. Design Mode picks an element of the page and turns what the user says about it into work
 * for an agent — a message to the task the agent pane shows, or, with none chosen, notes that
 * collect until a NEW task is started from them (spec 2026-10-24-design-mode-third-cut §3.2).
 */
export function CodeBrowserTab({
  state, onChange, run, onStartTask,
}: {
  state: CodeBrowser
  onChange: (state: CodeBrowser) => void
  /** The task the agent pane shows; notes go to it. `null`: notes collect for a new task. */
  run: ApiRun | null
  /** Start a task from one note's text. Resolves once the task exists. */
  onStartTask: (message: string) => Promise<void>
}) {
  return run ? <TaskBrowser key={run.id} state={state} onChange={onChange} run={run} /> : <NewTaskBrowser state={state} onChange={onChange} onStartTask={onStartTask} />
}

/** Notes for an existing task: the task workspace's own notes, receipts and all. */
function TaskBrowser({ state, onChange, run }: { state: CodeBrowser; onChange: (state: CodeBrowser) => void; run: ApiRun }) {
  const notes = useDesignNotes(run)
  const { addDraft, discard, note: noteFor, marks } = notes
  const sourceRoots = useSourceRoots(run)
  const escape = useCallback((mark: string) => { if (noteFor(mark)?.phase === 'draft') discard(mark) }, [discard, noteFor])
  return (
    <BrowserView
      singleTab
      state={state}
      onChange={onChange}
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
function NewTaskBrowser({ state, onChange, onStartTask }: { state: CodeBrowser; onChange: (state: CodeBrowser) => void; onStartTask: (message: string) => Promise<void> }) {
  const { drafts, marks: draftMarks, draft: draftFor, add, setText, discard, consume } = useProjectDesignDrafts()
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
      singleTab
      state={state}
      onChange={onChange}
      onPickElement={add}
      designMarks={marks}
      onDesignEscape={discard}
      sourceRoots={sourceRoots}
      designToolbar={
        drafts.length > 0 ? (
          <Button type="button" data-slot="design-start-all" size="sm" className="ml-1" onClick={startWithAll} title="Open New task with every collected note as its text">
            Start task with {drafts.length} {drafts.length === 1 ? 'note' : 'notes'}
          </Button>
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
