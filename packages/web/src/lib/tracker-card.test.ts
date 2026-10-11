import { describe, expect, it } from 'vitest'

import { initials, priorityLevel, ticketExcerpt } from './tracker-card'

describe('ticketExcerpt', () => {
  it('takes the first line that says something, without its markdown', () => {
    expect(ticketExcerpt('## Goal\n\nShip it.')).toBe('Goal')
    expect(ticketExcerpt('\n\n- **Preserve** existing `behavior`.\n- More')).toBe('Preserve existing behavior.')
    expect(ticketExcerpt('> See [the spec](https://example.com/spec) first')).toBe('See the spec first')
    expect(ticketExcerpt('1. First step')).toBe('First step')
    expect(ticketExcerpt('![diagram](https://example.com/a.png)\nReal text')).toBe('Real text')
  })

  it('skips rules and table dividers', () => {
    expect(ticketExcerpt('---\n| --- | --- |\nActual sentence')).toBe('Actual sentence')
  })

  it('cuts a long line with an ellipsis and is empty for an empty description', () => {
    const cut = ticketExcerpt('word '.repeat(100), 40)
    expect(cut.length).toBeLessThanOrEqual(40)
    expect(cut.endsWith('…')).toBe(true)
    expect(ticketExcerpt('')).toBe('')
    expect(ticketExcerpt('   \n\n ')).toBe('')
  })
})

describe('priorityLevel', () => {
  it('places both vendors\' default names', () => {
    expect(['Urgent', 'Highest', 'blocker'].map(priorityLevel)).toEqual(['urgent', 'urgent', 'urgent'])
    expect(priorityLevel('High')).toBe('high')
    expect(priorityLevel(' medium ')).toBe('medium')
    expect(['Low', 'Lowest', 'Trivial'].map(priorityLevel)).toEqual(['low', 'low', 'low'])
  })

  it('implies no urgency for a name it does not know', () => {
    expect(priorityLevel('P2 - soonish')).toBe('other')
  })
})

describe('initials', () => {
  it('uses the first and last word', () => {
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(initials('Grace Brewster Hopper')).toBe('GH')
    expect(initials('grace')).toBe('G')
    expect(initials('  ')).toBe('?')
  })
})
