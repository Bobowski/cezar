import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NewDesignPick } from '@/routes/task-thread/design-picks'

const api = vi.hoisted(() => ({
  getRepoDesignDrafts: vi.fn(),
  putRepoDesignDrafts: vi.fn(),
}))
vi.mock('@/api/client', () => api)
const scope = vi.hoisted(() => ({ projectId: 'a' as string | null }))
vi.mock('@/api/project-scope-context', () => ({ useProjectScope: () => ({ projectId: scope.projectId }) }))
const toaster = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('@/components/ui/toaster', () => toaster)

import { resetProjectDesignDrafts, useProjectDesignDrafts } from './project-design-drafts'

const pick = (mark: string): NewDesignPick => ({
  url: 'http://localhost:5173/',
  selector: `main > .${mark}`,
  tag: 'button',
  text: '',
  html: '<button></button>',
  styles: {},
  rect: { x: 0, y: 0, width: 1, height: 1 },
  viewport: { width: 1, height: 1 },
  components: [],
  mark,
})

beforeEach(() => {
  vi.useRealTimers()
  resetProjectDesignDrafts()
  scope.projectId = 'a'
  api.getRepoDesignDrafts.mockReset().mockResolvedValue({ picks: [] })
  api.putRepoDesignDrafts.mockReset().mockResolvedValue({ picks: [] })
  toaster.toast.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('project design drafts', () => {
  it('a debounced save lands on the project it was made in, even after switching projects', async () => {
    const { result, rerender } = renderHook(() => useProjectDesignDrafts())
    await waitFor(() => expect(result.current.drafts).toEqual([]))
    act(() => { result.current.add(pick('k-1')) })
    await waitFor(() => expect(api.putRepoDesignDrafts).toHaveBeenCalledTimes(1))

    vi.useFakeTimers()
    act(() => { result.current.setText('k-1', 'A note for project a') })
    // Switch to project b inside the 500 ms debounce.
    scope.projectId = 'b'
    rerender()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    vi.useRealTimers()

    await waitFor(() => expect(api.putRepoDesignDrafts.mock.calls.some(([input]) => input.picks[0]?.note === 'A note for project a')).toBe(true))
    for (const [input, projectId] of api.putRepoDesignDrafts.mock.calls) {
      if (input.picks.some((each: { note: string }) => each.note === 'A note for project a')) expect(projectId).toBe('a')
      else expect(projectId).not.toBe('b')
    }
    expect(api.getRepoDesignDrafts.mock.calls.map(([projectId]) => projectId)).toEqual(['a', 'b'])
  })

  it('a refused save says why, keeps the notes and marks them unsaved until a save lands', async () => {
    const { result } = renderHook(() => useProjectDesignDrafts())
    await waitFor(() => expect(result.current.drafts).toEqual([]))
    api.putRepoDesignDrafts.mockRejectedValue(new Error('a note is at most 100000 characters'))
    act(() => { result.current.add(pick('k-1')) })

    await waitFor(() => expect(result.current.unsaved).toBe(true))
    expect(toaster.toast).toHaveBeenCalledTimes(1)
    expect(toaster.toast.mock.calls[0]?.[0]).toContain('a note is at most 100000 characters')
    expect(toaster.toast.mock.calls[0]?.[1]).toEqual({ tone: 'danger' })
    expect(result.current.drafts.map((draft) => draft.key)).toEqual(['k-1'])

    api.putRepoDesignDrafts.mockResolvedValue({ picks: [] })
    act(() => { result.current.setText('k-1', 'shorter') })
    await waitFor(() => expect(result.current.unsaved).toBe(false))
    expect(toaster.toast).toHaveBeenCalledTimes(1)
  })
})
