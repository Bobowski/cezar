import { describe, expect, it } from 'vitest'
import type { RunRecord } from '@open-mercato/cezar-api-client'

// Test-only reach into the service: its push gate must answer exactly what the browser
// notification's `wantsAttention` answers (spec 2026-10-24-mobile-cockpit §3.5).
import { pushLabelOf } from '../../../cezar/src/push/attention'
import { deriveAttention, wantsAttention } from './attention'

const base = { id: 'r1', title: 'Title', status: 'running' } as unknown as RunRecord
const variants: unknown[] = [
  { status: 'queued' },
  { status: 'running' },
  { status: 'running', activity: 'monitoring' },
  { status: 'waiting' },
  { status: 'review' },
  { status: 'done' },
  { status: 'failed' },
  { status: 'cancelled' },
  { status: 'failed', autoResumeAt: '2026-10-25T00:00:00Z' },
  { status: 'failed', awaitingAnswerSince: '2026-10-25T00:00:00Z' },
  { status: 'waiting', dispatch: { overBudget: true, budgetUsd: 2 } },
  { status: 'done', worktreeLifecycle: { worktreeId: 'w', generation: 1, needsAttention: true, phase: 'teardown' } },
  { status: 'done', worktreeLifecycle: { worktreeId: 'w', generation: 1, needsAttention: true, phase: 'setup' } },
  { status: 'review', worktreeLifecycle: { worktreeId: 'w', generation: 1, needsAttention: false, activeOperationId: 'op', phase: 'setup' } },
]

describe('the server push gate and the browser notification agree', () => {
  it.each(variants.map((variant) => [JSON.stringify(variant), variant]))('%s', (_name, variant) => {
    const run = { ...base, ...(variant as object) } as RunRecord
    const label = pushLabelOf(run)
    expect(label !== null).toBe(wantsAttention(run))
    if (label !== null) expect(label).toBe(deriveAttention(run).label)
  })
})
