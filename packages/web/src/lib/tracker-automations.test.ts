import { describe, expect, it } from 'vitest'

import type { AutomationsResponse, TrackerAssociation } from '@open-mercato/cezar-api-client'
import { ANY_STATUS, automationHint, automationsByTargetStatus } from './tracker-automations'

const association: TrackerAssociation = { kind: 'jira', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS' }
type Entry = AutomationsResponse['automations'][number]
const automation = (name: string, over: Record<string, unknown> = {}, trigger: Record<string, unknown> = {}): Entry => ({
  id: name, revision: 1, name, enabled: true, kind: 'tracker', task: { prompt: 'x' }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  trackerTrigger: { events: ['issue.status_changed'], targetStatusIds: ['review'], association, ...trigger },
  ...over,
}) as unknown as Entry

describe('automationsByTargetStatus', () => {
  it('maps a target status to the enabled automations a move into it fires', () => {
    const byStatus = automationsByTargetStatus([automation('Review bot'), automation('QA bot', {}, { targetStatusIds: ['review', 'done'] })], association)
    expect(byStatus.get('review')).toEqual(['Review bot', 'QA bot'])
    expect(byStatus.get('done')).toEqual(['QA bot'])
    expect(automationHint(byStatus, 'review')).toBe('Starts automations: Review bot, QA bot')
    expect(automationHint(byStatus, 'done')).toBe('Starts automation: QA bot')
    expect(automationHint(byStatus, 'todo')).toBeNull()
  })

  it('counts an automation with no target statuses for every status', () => {
    const byStatus = automationsByTargetStatus([automation('Any move', {}, { targetStatusIds: undefined })], association)
    expect(byStatus.get(ANY_STATUS)).toEqual(['Any move'])
    expect(automationHint(byStatus, 'whatever')).toBe('Starts automation: Any move')
  })

  it('ignores paused automations, other events, other kinds and other scopes', () => {
    const byStatus = automationsByTargetStatus([
      automation('Paused', { enabled: false }),
      automation('On create', {}, { events: ['issue.opened'] }),
      automation('GitHub', { kind: 'github', trackerTrigger: undefined }),
      automation('Other project', {}, { association: { ...association, externalId: '200' } }),
      automation('Other site', {}, { association: { ...association, source: { id: 'other', webUrl: 'https://other.atlassian.net' } } }),
      automation('Linear', {}, { association: { ...association, kind: 'linear' } }),
    ], association)
    expect(byStatus.size).toBe(0)
  })

  it('is empty for no definitions', () => {
    expect(automationsByTargetStatus(undefined, association).size).toBe(0)
    expect(automationHint(new Map(), 'review')).toBeNull()
  })
})
