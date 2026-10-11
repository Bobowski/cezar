import { describe, expect, it } from 'vitest'

import type { ApiRun, TrackerAssociation, TrackerLink } from '@open-mercato/cezar-api-client'
import { hasActiveRun, runsByTicket, ticketActivity } from './tracker-links'

const association: TrackerAssociation = { kind: 'jira', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS' }
const link = (itemId: string, over: Partial<TrackerLink> = {}): TrackerLink => ({ provider: 'jira', sourceId: 'acme', scopeId: '100', itemId, origin: 'handoff', linkedAt: '2026-10-11T10:00:00.000Z', ...over })
const run = (id: string, status: ApiRun['status'], links: TrackerLink[] | undefined, createdAt = '2026-10-11T10:00:00.000Z') =>
  ({ id, status, createdAt, title: id, task: id, steps: [], ...(links ? { trackerLinks: links } : {}) }) as unknown as ApiRun

describe('runsByTicket', () => {
  it('groups linked runs by ticket, newest first, and ignores unlinked runs', () => {
    const byTicket = runsByTicket([
      run('old', 'done', [link('OPS-1')], '2026-10-10T10:00:00.000Z'),
      run('new', 'running', [link('OPS-1')], '2026-10-11T10:00:00.000Z'),
      run('other', 'review', [link('OPS-2')]),
      run('plain', 'running', undefined),
    ], association)
    expect(byTicket.get('OPS-1')!.map(r => r.id)).toEqual(['new', 'old'])
    expect(byTicket.get('OPS-2')!.map(r => r.id)).toEqual(['other'])
    expect(byTicket.size).toBe(2)
  })

  it('keeps a ticket across a scope or token change but not across sources or providers', () => {
    const byTicket = runsByTicket([
      run('moved', 'done', [link('OPS-1', { scopeId: '999' })]),
      run('elsewhere', 'done', [link('OPS-1', { sourceId: 'other-site' })]),
      run('linear', 'done', [link('OPS-1', { provider: 'linear' })]),
    ], association)
    expect(byTicket.get('OPS-1')!.map(r => r.id)).toEqual(['moved'])
  })

  it('returns an empty map for no runs', () => {
    expect(runsByTicket([], association).size).toBe(0)
  })
})

describe('ticketActivity', () => {
  it('says nothing for a ticket with no task', () => {
    expect(ticketActivity(undefined)).toBeNull()
    expect(ticketActivity([])).toBeNull()
    expect(hasActiveRun(undefined)).toBe(false)
  })

  it('leads with a working task, then one awaiting review, then the newest finished one', () => {
    expect(ticketActivity([run('a', 'done', []), run('b', 'waiting', [])])?.status).toBe('waiting')
    expect(ticketActivity([run('a', 'done', []), run('b', 'review', [])])?.status).toBe('review')
    expect(ticketActivity([run('a', 'failed', []), run('b', 'done', [])])).toEqual({ status: 'failed', label: '2 finished tasks' })
    expect(hasActiveRun([run('a', 'queued', [])])).toBe(true)
    expect(hasActiveRun([run('a', 'review', [])])).toBe(false)
  })
})
