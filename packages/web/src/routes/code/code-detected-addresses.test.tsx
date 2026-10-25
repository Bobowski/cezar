import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

/** The main checkout's page suggestions: its services' addresses and its project terminals'
 *  (`GET /repo/terminal/urls`, browser-tabs spec as built). */

const api = vi.hoisted(() => ({
  getServices: vi.fn(async () => ({ services: [{ urls: [{ url: 'http://localhost:5173/', running: null }] }] })),
  getRunTerminalUrls: vi.fn(async () => ({ urls: [] })),
}))
vi.mock('@/api/client', () => api)
const code = vi.hoisted(() => ({
  getProjectTerminalUrls: vi.fn(async () => ({ urls: [{ url: 'http://localhost:4000/', running: true }, { url: 'http://localhost:5173/', running: null }] })),
}))
vi.mock('@/api/code', () => code)
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { terminal: true } } }), queryKeys: { services: { list: () => ['services'] } } }))

import { useDetectedAddresses } from './code-browser'

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
)

describe('useDetectedAddresses on the main checkout', () => {
  it('joins the project terminals’ addresses to the services’, running first, each once', async () => {
    const { result } = renderHook(() => useDetectedAddresses({ kind: 'main' }), { wrapper })
    await waitFor(() => expect(result.current).toEqual(['http://localhost:4000/', 'http://localhost:5173/']))
    expect(code.getProjectTerminalUrls).toHaveBeenCalled()
    expect(api.getRunTerminalUrls).not.toHaveBeenCalled()
  })
})
