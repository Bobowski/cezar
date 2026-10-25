import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { PushPresence, presenceChannel } from './push-presence'

/** The visible-tab half of the push gate (spec 2026-10-24-mobile-cockpit §3.5). */

const HEALTH = {
  version: '0.0.0',
  repoRoot: '/srv/cezar',
  repo: { root: '/srv/cezar', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  capabilities: { localHandoff: false, followups: false, singleProject: false, automations: false },
}

let beats: Array<{ visible: boolean; tab: string }> = []
let sockets = 0

function serve(health: unknown) {
  beats = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    if (url === '/api/v1/health') return new Response(JSON.stringify(health), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === '/api/v1/workspace/push/presence' && init.method === 'POST') {
      beats.push(JSON.parse(String(init.body)) as { visible: boolean; tab: string })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Promise<never>(() => {})
  }))
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  sockets = 0
  vi.stubGlobal('WebSocket', class {
    readyState = 0
    constructor() {
      sockets += 1
    }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'visibilityState')
})

function renderPresence(beatMs = 40) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <PushPresence beatMs={beatMs} />
    </QueryClientProvider>,
  )
}

describe('presenceChannel', () => {
  it('holds the topic over the socket when there is one, beats over HTTP when there is not, and stays silent locally or hidden', () => {
    expect(presenceChannel({ hosted: true, transport: 'local', visible: true })).toBe('socket')
    expect(presenceChannel({ hosted: true, transport: 'remote', visible: true })).toBe('beat')
    expect(presenceChannel({ hosted: true, transport: 'remote', visible: false })).toBeNull()
    expect(presenceChannel({ hosted: false, transport: 'local', visible: true })).toBeNull()
    expect(presenceChannel({ hosted: true, transport: undefined, visible: true })).toBeNull()
  })
})

describe('PushPresence on a hosted cockpit without sign-in (CEZ_AUTH=0)', () => {
  it('beats over HTTP while visible, repeats the beat, and ends it when the page hides — no socket', async () => {
    serve(HEALTH)
    setVisibility('visible')
    renderPresence()
    await waitFor(() => expect(beats.length).toBeGreaterThanOrEqual(2))
    expect(beats.every((beat) => beat.visible)).toBe(true)
    expect(new Set(beats.map((beat) => beat.tab)).size).toBe(1)
    act(() => setVisibility('hidden'))
    await waitFor(() => expect(beats.at(-1)?.visible).toBe(false))
    const count = beats.length
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(beats).toHaveLength(count)
    expect(sockets).toBe(0)
  })

  it('a local cockpit beats nothing', async () => {
    serve({ ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: true } })
    setVisibility('visible')
    renderPresence()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(beats).toEqual([])
  })
})
