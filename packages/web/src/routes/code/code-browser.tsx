import { XIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { messageWithDesignPicks, pickLabel, type NewDesignPick } from '@/routes/task-thread/design-picks'
import { BrowserView, type DesignMark } from '@/routes/task-workspace/browser-view'
import { DesignNotePopup } from '@/routes/task-workspace/design-note-popup'
import { useDesignNotes } from '@/routes/task-workspace/design-notes'

import type { CodeBrowser } from './code-state'

/**
 * A browser in an editor tab (spec 2026-10-11-code-page): the app the project serves, beside its
 * code. Design Mode picks an element of the page and turns what the user says about it into work
 * for an agent — a message to the task the agent pane shows, or, with none chosen, a NEW task.
 */
export function CodeBrowserTab({
  state, onChange, run, onStartTask,
}: {
  state: CodeBrowser
  onChange: (state: CodeBrowser) => void
  /** The task the agent pane shows; notes go to it. `null`: each note starts a task of its own. */
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
  const escape = useCallback((mark: string) => { if (noteFor(mark)?.phase === 'draft') discard(mark) }, [discard, noteFor])
  return (
    <BrowserView
      singleTab
      state={state}
      onChange={onChange}
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
function NewTaskBrowser({ state, onChange, onStartTask }: { state: CodeBrowser; onChange: (state: CodeBrowser) => void; onStartTask: (message: string) => Promise<void> }) {
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
      singleTab
      state={state}
      onChange={onChange}
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
