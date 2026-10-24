import { ArrowDownIcon, ArrowUpIcon, ListOrderedIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { editQueuedRunPrompt, removeQueuedRunPrompt, reorderRunPromptQueue } from '@/api/client'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'

import type { DesignNotes } from './design-notes'
import { joinPrompt, movedOrder, queueEntries, type QueueEntry } from './prompt-queue-entries'

/**
 * The Queue chip and its drawer (spec `.ai/specs/2026-10-24-design-mode-third-cut.md` §3.1): what
 * is waiting for this task's agent, in order, each still the user's to reword, move or take back
 * — the queue routes of design-mode §8 plus `PUT …/prompt-queue { order }`. Nothing about sending
 * changes; a note already with the agent is listed read-only with its status.
 */

const STATUS: Record<QueueEntry['phase'], { label: string; tone: 'neutral' | 'pending' | 'success' | 'violet'; pulse?: boolean }> = {
  queued: { label: 'In queue', tone: 'neutral' },
  running: { label: 'In progress', tone: 'pending', pulse: true },
  asking: { label: 'Waiting for your answer', tone: 'violet' },
  done: { label: 'Done', tone: 'success' },
}

export function PromptQueueDrawer({ run, notes }: { run: ApiRun; notes: Pick<DesignNotes, 'notes' | 'saveQueued' | 'withdraw'> }) {
  const entries = queueEntries(run.promptQueue, notes.notes)
  const waiting = entries.filter((entry) => entry.waiting)
  const [editing, setEditing] = useState<{ id: string; words: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const attempt = async (action: () => Promise<unknown>, fallback: string): Promise<boolean> => {
    setBusy(true)
    try {
      await action()
      return true
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : fallback, { tone: 'danger' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = async (entry: QueueEntry, words: string) => {
    const saved = await attempt(
      () => (entry.note ? notes.saveQueued(entry.note.key, words) : editQueuedRunPrompt(run.id, entry.id, joinPrompt(words, entry.block))),
      'Could not save the prompt.',
    )
    if (saved) setEditing(null)
  }
  const remove = (entry: QueueEntry) =>
    void attempt(() => (entry.note ? notes.withdraw(entry.note.key) : removeQueuedRunPrompt(run.id, entry.id)), 'Could not remove the prompt.')
  const move = (entry: QueueEntry, delta: -1 | 1) => {
    const order = movedOrder(waiting.map((each) => each.id), entry.id, delta)
    // A 409 means the queue moved under this window (a release, another tab); the run's next
    // update redraws it, and the user tries again on what is really there.
    if (order) void attempt(() => reorderRunPromptQueue(run.id, order), 'Could not reorder the queue.')
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          data-slot="design-queue-chip"
          variant="outline"
          size="sm"
          title="Prompts waiting for the agent"
          aria-label={`Queue, ${waiting.length} waiting`}
          className="ml-1"
        >
          <ListOrderedIcon aria-hidden="true" className="size-3.5" />
          Queue
          <span data-slot="design-queue-count" className="rounded bg-muted px-1 text-[11px] tabular-nums">
            {waiting.length}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" data-slot="design-queue-drawer" className="flex max-h-[70vh] w-[min(420px,calc(100vw-24px))] flex-col gap-2 overflow-y-auto p-2.5 text-xs">
        <p className="font-medium text-foreground">Queue</p>
        {entries.length === 0 ? (
          <p className="text-soft-foreground">Nothing is waiting. A note sent while the agent works lines up here.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {entries.map((entry, index) => {
              const status = STATUS[entry.phase]
              const isEditing = editing?.id === entry.id
              return (
                <li key={entry.id} data-slot="design-queue-entry" data-waiting={entry.waiting ? '' : undefined} className="flex flex-col gap-1 rounded-md border border-border p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground">{entry.label}</span>
                    <span className="flex shrink-0 items-center gap-1 text-soft-foreground">
                      <StatusDot tone={status.tone} pulse={status.pulse ?? false} />
                      {status.label}
                    </span>
                  </div>
                  {isEditing ? (
                    <Textarea
                      value={editing.words}
                      onChange={(event) => setEditing({ id: entry.id, words: event.target.value.slice(0, 20_000) })}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') { event.preventDefault(); setEditing(null) }
                        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(entry, editing.words) }
                      }}
                      aria-label="Prompt text"
                      autoFocus
                      rows={3}
                      className="min-h-16 resize-none text-[13px] md:text-[13px]"
                    />
                  ) : (
                    <p data-slot="design-queue-text" className="line-clamp-3 break-words whitespace-pre-wrap text-foreground">
                      {entry.words.trim() || (entry.block ? 'Selected elements only' : '')}
                    </p>
                  )}
                  {entry.waiting ? (
                    <div className="flex items-center justify-end gap-0.5">
                      {isEditing ? (
                        <>
                          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
                          <Button
                            type="button"
                            size="xs"
                            disabled={busy || (editing.words.trim() === '' && entry.block === '') || editing.words.trim() === entry.words.trim()}
                            onClick={() => void save(entry, editing.words)}
                          >
                            Save
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label="Edit" title="Edit" disabled={busy} onClick={() => setEditing({ id: entry.id, words: entry.words })}>
                            <PencilIcon aria-hidden="true" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label="Move up" title="Move up" disabled={busy || index === 0} onClick={() => move(entry, -1)}>
                            <ArrowUpIcon aria-hidden="true" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label="Move down" title="Move down" disabled={busy || index === waiting.length - 1} onClick={() => move(entry, 1)}>
                            <ArrowDownIcon aria-hidden="true" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove" title="Remove from the queue" disabled={busy} onClick={() => remove(entry)}>
                            <Trash2Icon aria-hidden="true" />
                          </Button>
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}
      </PopoverContent>
    </Popover>
  )
}
