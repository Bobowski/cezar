import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import { useBrowserColumnShare } from './browser-share'
import type { WorkspaceColumn } from './layout-state'

/** A new Browser column's share, remembered per project from a drag (cockpit-polish §3.2). */

let puts: unknown[] = []
beforeEach(() => {
  puts = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/ui-state') {
        if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ browserColumn: { width: 50 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>
const row = (browser: number): WorkspaceColumn[] => [
  { view: 'session', width: 100 - browser },
  { view: 'browser', width: browser, browser: { tabs: [''], active: 0 } },
]

describe('useBrowserColumnShare', () => {
  it('reads the project’s share, and writes a dragged Browser width once the drag rests', async () => {
    const { result } = renderHook(() => useBrowserColumnShare(), { wrapper })
    await waitFor(() => expect(result.current.share).toBe(50))
    // A layout that merely holds a Browser is not a preference.
    act(() => result.current.observe(row(33.33)))
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(puts).toEqual([])
    act(() => {
      result.current.markResized()
      result.current.observe(row(40))
      result.current.observe(row(38.5))
    })
    await waitFor(() => expect(puts).toEqual([{ browserColumn: { width: 38.5 } }]))
  })
})
