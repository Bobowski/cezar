import { describe, expect, it } from 'vitest'

import type { TrackerItem } from '@open-mercato/cezar-api-client'
import { groupByStatus } from './tracker-groups'

const item = (id: string, statusId: string, status: string, statusCategory: TrackerItem['statusCategory']): TrackerItem => ({
  kind: 'issue', id, title: id, author: 'Ada', createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
  labels: [], body: '', bodyTruncated: false, unsupportedContent: false, url: `https://acme.atlassian.net/browse/${id}`,
  status, statusId, statusCategory,
})

describe('groupByStatus', () => {
  it('orders groups by workflow category, then by first appearance, keeping item order', () => {
    const groups = groupByStatus([
      item('A-1', 'done', 'Done', 'done'),
      item('A-2', 'review', 'In Review', 'started'),
      item('A-3', 'todo', 'To Do', 'unstarted'),
      item('A-4', 'progress', 'In Progress', 'started'),
      item('A-5', 'review', 'In Review', 'started'),
      item('A-6', 'odd', 'Parked', 'other'),
    ])
    expect(groups.map(group => group.status)).toEqual(['To Do', 'In Review', 'In Progress', 'Done', 'Parked'])
    expect(groups[1]!.items.map(row => row.id)).toEqual(['A-2', 'A-5'])
  })

  it('keeps two statuses with one display name apart by vendor id', () => {
    const groups = groupByStatus([item('A-1', '1', 'Open', 'unstarted'), item('A-2', '2', 'Open', 'unstarted')])
    expect(groups.map(group => group.statusId)).toEqual(['1', '2'])
  })

  it('returns no groups for no loaded items', () => {
    expect(groupByStatus([])).toEqual([])
  })
})
