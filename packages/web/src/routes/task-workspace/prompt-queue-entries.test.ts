import { describe, expect, it } from 'vitest'

import { formatDesignPicks } from '../task-thread/design-picks'

import type { DesignNote } from './design-notes'
import { joinPrompt, movedOrder, queueEntries, splitPrompt } from './prompt-queue-entries'

const pick = {
  url: 'http://localhost:5173/',
  selector: 'main > button.save',
  tag: 'button',
  text: 'Save',
  html: '<button class="save">Save</button>',
  styles: {},
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 100, height: 100 },
  components: ['SaveButton'],
  mark: 'k1-1',
}
const block = formatDesignPicks([{ ...pick, id: 'k1-1' }])

const note = (over: Partial<DesignNote>): DesignNote => ({ key: 'k1-1', pick, text: 'bigger', phase: 'queued', number: 1, ...over })

describe('the Queue drawer’s rows (spec 2026-10-24-design-mode-third-cut §3.1)', () => {
  it('splits a prompt into the user’s words and the element block, and joins it back', () => {
    expect(splitPrompt(`make it bigger\n\n${block}`)).toEqual({ words: 'make it bigger', block })
    expect(splitPrompt(block)).toEqual({ words: '', block })
    expect(splitPrompt('just text')).toEqual({ words: 'just text', block: '' })
    expect(joinPrompt('  smaller ', block)).toBe(`smaller\n\n${block}`)
    expect(joinPrompt('', block)).toBe(block)
    expect(joinPrompt('plain', '')).toBe('plain')
  })

  it('lists the queue in order — notes by their element, typed prompts as messages', () => {
    const rows = queueEntries(
      [
        { id: 'q1', text: 'a typed follow-up' },
        { id: 'q2', text: `bigger\n\n${block}` },
        { id: 'q3', text: `from another window\n\n${block}` },
      ],
      [note({ queueId: 'q2' })],
    )
    expect(rows.map((row) => [row.id, row.label, row.words, row.waiting])).toEqual([
      ['q1', 'Message', 'a typed follow-up', true],
      ['q2', 'SaveButton · button.save', 'bigger', true],
      // No note of this window names it: the element is read off its own block.
      ['q3', 'button.save', 'from another window', true],
    ])
    expect(rows[1]!.note?.key).toBe('k1-1')
    expect(rows[1]!.block).toBe(block)
  })

  it('lists notes already with the agent after the queue, read-only, in the order sent', () => {
    const rows = queueEntries(
      [{ id: 'q1', text: 'waiting' }],
      [
        note({ key: 'b', number: 2, phase: 'done', queueId: undefined }),
        note({ key: 'a', number: 1, phase: 'running', queueId: undefined }),
        note({ key: 'draft', number: undefined, phase: 'draft' }),
      ],
    )
    expect(rows.map((row) => [row.id, row.phase, row.waiting])).toEqual([
      ['q1', 'queued', true],
      ['note:a', 'running', false],
      ['note:b', 'done', false],
    ])
  })

  it('moves one entry up or down, and nowhere past an end', () => {
    expect(movedOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(movedOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(movedOrder(['a', 'b'], 'a', -1)).toBeNull()
    expect(movedOrder(['a', 'b'], 'b', 1)).toBeNull()
    expect(movedOrder(['a'], 'x', 1)).toBeNull()
  })
})
