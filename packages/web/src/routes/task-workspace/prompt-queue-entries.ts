import { DESIGN_HEADING, pickLabel } from '../task-thread/design-picks'

import type { DesignNote, NotePhase } from './design-notes'

/**
 * The Queue drawer's rows (spec `.ai/specs/2026-10-24-design-mode-third-cut.md` §3.1): every
 * prompt waiting in the run's queue, in order — design notes and typed messages alike — and
 * after them the notes already with the agent, read-only. Pure, so the order and the labels are
 * testable without a session.
 */

export interface QueueEntry {
  /** The queue entry's id; a note already delivered has none and is keyed by its note. */
  id: string
  /** Waiting in the queue: editable, movable, removable. */
  waiting: boolean
  phase: Exclude<NotePhase, 'draft'>
  /** The element's name, or "Message" for a prompt with none. */
  label: string
  /** What the user wrote — for a note, without the element block the agent also receives. */
  words: string
  /** The element block a waiting prompt carries after the words, kept as is by an edit. */
  block: string
  /** The design note behind it, when this window sent it. */
  note?: DesignNote
}

/** A prompt split into the user's words and the element block that rides after them. */
export function splitPrompt(text: string): { words: string; block: string } {
  const at = text.startsWith(DESIGN_HEADING) ? 0 : text.indexOf(`\n\n${DESIGN_HEADING}`)
  if (at === -1) return { words: text, block: '' }
  return { words: text.slice(0, at), block: text.slice(at === 0 ? 0 : at + 2) }
}

/** The words edited, the element block untouched. */
export function joinPrompt(words: string, block: string): string {
  const trimmed = words.trim()
  if (block === '') return trimmed
  return trimmed === '' ? block : `${trimmed}\n\n${block}`
}

/** A queued prompt's element, read off its own block when no note of this window names it. */
function blockLabel(block: string): string {
  const selector = /^- `([^`\n]{1,400})`/m.exec(block)?.[1]
  return selector ? (selector.split(' > ').at(-1) ?? selector) : 'Message'
}

export function queueEntries(
  queue: readonly { id: string; text: string }[] | undefined,
  notes: readonly DesignNote[],
): QueueEntry[] {
  const byQueueId = new Map(notes.filter((note) => note.queueId !== undefined).map((note) => [note.queueId!, note]))
  const waiting = (queue ?? []).map((entry): QueueEntry => {
    const note = byQueueId.get(entry.id)
    const { words, block } = splitPrompt(entry.text)
    return {
      id: entry.id,
      waiting: true,
      phase: 'queued',
      label: note ? pickLabel(note.pick) : blockLabel(block),
      words,
      block,
      ...(note ? { note } : {}),
    }
  })
  const delivered = notes
    .filter((note) => note.phase === 'running' || note.phase === 'asking' || note.phase === 'done')
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
    .map((note): QueueEntry => ({
      id: `note:${note.key}`,
      waiting: false,
      phase: note.phase as QueueEntry['phase'],
      label: pickLabel(note.pick),
      words: note.text,
      block: '',
      note,
    }))
  return [...waiting, ...delivered]
}

/** The queue's ids with `id` moved one place up (`-1`) or down (`+1`); null at an end. */
export function movedOrder(ids: readonly string[], id: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from === -1 || to < 0 || to >= ids.length) return null
  const next = [...ids]
  next[from] = ids[to]!
  next[to] = id
  return next
}
