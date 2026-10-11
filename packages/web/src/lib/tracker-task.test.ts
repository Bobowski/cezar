import { describe, expect, it } from 'vitest'
import { extractTaskRefs } from '../../../cezar/src/runs/task-refs'

import type { TrackerComments, TrackerItem } from '@open-mercato/cezar-api-client'

import { TRACKER_TASK_LIMIT, trackerRunBody, trackerTaskPrompt } from './tracker-task'

const item: TrackerItem = {
  kind: 'issue',
  id: 'OPS-42',
  title: 'Repair the deployment',
  author: 'Ada',
  createdAt: '2026-09-18T10:00:00.000Z',
  updatedAt: '2026-09-19T10:00:00.000Z',
  labels: ['backend'],
  body: 'Full vendor description',
  bodyTruncated: false,
  unsupportedContent: false,
  url: 'https://example.atlassian.net/browse/OPS-42',
  status: 'In Progress', statusId: 'status-1', statusCategory: 'started',
}

const none: TrackerComments = { available: true, items: [], truncated: false }

describe('tracker handoff', () => {
  it('keeps full detail and puts the custom instruction last', () => {
    const longBody = 'x'.repeat(9_000)
    const prompt = trackerTaskPrompt(
      { ...item, body: longBody },
      none,
      { skills: ['review'], supplemental: 'A private log excerpt', instruction: 'Run the focused test.' },
    )

    expect(prompt).toContain(longBody)
    expect(prompt).toContain(item.url)
    expect(prompt).toContain('A private log excerpt')
    expect(prompt.endsWith('Run the focused test.')).toBe(true)
  })

  it('makes snapshot loss explicit and requires acknowledgement', () => {
    const lossy = { ...item, bodyTruncated: true, unsupportedContent: true }

    expect(() => trackerRunBody(lossy, none, null, [], {}, { acknowledgeLoss: false })).toThrow(
      /acknowledge/i,
    )
    const body = trackerRunBody(lossy, none, null, [], {}, {
      acknowledgeLoss: true,
      supplemental: 'Missing acceptance criteria copied from Jira.',
    })
    expect(body.task).toContain('description was truncated')
    expect(body.task).toContain('unsupported content')
    expect(body.task).toContain('Missing acceptance criteria copied from Jira.')
  })

  it('names the ticket for the server to link on every launch shape, and only when a scope is given', () => {
    const link = { tracker: { itemId: 'OPS-42', expectedScope: 'scope-1' } }
    expect(trackerRunBody(item, none, 'ship', [], {}, { expectedScope: 'scope-1' })).toMatchObject(link)
    expect(trackerRunBody(item, none, null, ['review'], {}, { expectedScope: 'scope-1' })).toMatchObject(link)
    expect(trackerRunBody(item, none, null, [], {}, { expectedScope: 'scope-1' })).toMatchObject(link)
    expect('tracker' in trackerRunBody(item, none, null, [], {}, {})).toBe(false)
  })

  it('states that an empty vendor description is empty', () => {
    expect(trackerTaskPrompt({ ...item, body: '   ' }, none)).toContain('No description was provided')
  })

  it('preserves workflow, skill-chain, quick-task, and engine fields', () => {
    const engine = { runner: 'codex' as const, model: 'gpt-6', agentProfile: 'work' }
    expect(trackerRunBody(item, none, 'ship', ['review'], engine, {}).workflow).toBe('ship')
    expect(trackerRunBody(item, none, null, ['review'], engine, {})).toMatchObject({
      runner: 'codex', model: 'gpt-6', agentProfile: 'work', steps: [{ skill: 'review' }],
    })
    expect(trackerRunBody(item, none, null, [], engine, {}).workflow).toBe('quick-task')
  })

  it('rejects the final task instead of truncating it past the server limit', () => {
    expect(() => trackerTaskPrompt({ ...item, body: 'x'.repeat(TRACKER_TASK_LIMIT) }, none)).toThrow(
      /100,000/,
    )
  })

  it('rejects more than eight skill-chain steps instead of silently dropping selections', () => {
    expect(() => trackerRunBody(item, none, null, Array.from({ length: 9 }, (_, index) => `skill-${index}`), {}, {}))
      .toThrow(/at most 8/i)
  })
})

// Exercise the actual downstream parser, not just the prompt's wording.
it.each(['123', 'OPS-123'])('does not invent a GitHub reference for tracker ID %s', id => {
  expect(extractTaskRefs(trackerTaskPrompt({ ...item, id }, none))).toEqual({})
})
