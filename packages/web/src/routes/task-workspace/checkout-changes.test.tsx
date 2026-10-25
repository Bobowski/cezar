import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STAMP_POLL_MS, useCheckoutChanges } from './checkout-changes'

/** The Preview's change signal (spec 2026-10-24-cockpit-polish §3.2): the bell, or two stamps. */

const transport = vi.hoisted(() => ({ value: 'local' as 'local' | 'remote' }))
vi.mock('@/api/host-usage', () => ({ useHostTransport: () => transport.value }))

const getCodeWatch = vi.hoisted(() => vi.fn())
vi.mock('@/api/code', () => ({ getCodeWatch, treeKey: (tree: { kind: string; runId?: string }) => (tree.kind === 'run' ? tree.runId : 'main') }))

const topics = vi.hoisted(() => ({ listener: null as ((data: unknown) => void) | null, subscribed: 0 }))
vi.mock('@/api/ws', () => ({
  subscribeTopic: (_topic: string, listener: (data: unknown) => void) => {
    topics.listener = listener
    topics.subscribed += 1
    return () => {
      topics.listener = null
      topics.subscribed -= 1
    }
  },
}))

const TREE = { kind: 'run' as const, runId: 'r1' }
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
)

beforeEach(() => {
  transport.value = 'local'
  topics.listener = null
  topics.subscribed = 0
  getCodeWatch.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useCheckoutChanges', () => {
  it('rides the bell: the snapshot is the baseline, a higher version is a change', async () => {
    getCodeWatch.mockResolvedValue({ topic: 'code:p:r1' })
    const { result } = renderHook(() => useCheckoutChanges(TREE, true), { wrapper })
    await waitFor(() => expect(topics.listener).not.toBeNull())
    act(() => topics.listener!({ version: 4 }))
    expect(result.current).toBe(0)
    act(() => topics.listener!({ version: 4 }))
    act(() => topics.listener!({ version: 5 }))
    expect(result.current).toBe(1)
  })

  it('listens to nothing while disabled', async () => {
    getCodeWatch.mockResolvedValue({ topic: 'code:p:r1' })
    renderHook(() => useCheckoutChanges(TREE, false), { wrapper })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getCodeWatch).not.toHaveBeenCalled()
    expect(topics.subscribed).toBe(0)
  })

  it('without the socket, compares stamps — the first look is the baseline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    transport.value = 'remote'
    const stamps = ['aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']
    getCodeWatch.mockImplementation(async () => ({ topic: null, stamp: stamps.shift() ?? 'bbbbbbbbbbbbbbbb' }))
    const { result } = renderHook(() => useCheckoutChanges(TREE, true), { wrapper })
    await waitFor(() => expect(getCodeWatch).toHaveBeenCalledTimes(1))
    expect(getCodeWatch).toHaveBeenLastCalledWith(TREE, undefined, true)
    await act(async () => {
      vi.advanceTimersByTime(STAMP_POLL_MS)
    })
    expect(result.current).toBe(0)
    await act(async () => {
      vi.advanceTimersByTime(STAMP_POLL_MS)
    })
    await waitFor(() => expect(result.current).toBe(1))
    expect(topics.subscribed).toBe(0)
  })
})
