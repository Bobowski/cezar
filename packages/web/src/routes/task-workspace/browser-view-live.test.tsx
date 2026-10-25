import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserView, HMR_PROBE_DELAY_MS, RELOAD_SETTLE_MS, frameHmr } from './browser-view'

/**
 * Live preview (spec `.ai/specs/2026-10-24-cockpit-polish.md` §3.2): Auto-reload follows what the
 * preview gateway saw of the page's hot-reload socket, and a change in the checkout reloads the
 * page ONCE, after the changes settle.
 */

/** `preview: false` is a hosted cockpit (the gateway frames a loopback page); true, a local one. */
const cockpit = vi.hoisted(() => ({ preview: false }))
vi.mock('@/api/queries', () => ({
  useHealth: () => ({ data: { capabilities: { preview: cockpit.preview, designMode: false } } }),
}))
const openPreviewGateway = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ openDesignProxy: vi.fn(), openPreviewGateway }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

/** The checkout bell, driven by the test: the listener hands its `onCount` out. */
const bell = vi.hoisted(() => ({ count: 0, onCount: null as ((count: number) => void) | null, enabled: false }))
vi.mock('./checkout-changes', () => ({
  CheckoutChangesListener: ({ enabled, onCount }: { enabled: boolean; onCount: (count: number) => void }) => {
    bell.onCount = onCount
    bell.enabled = enabled
    return null
  },
}))
const ring = () =>
  act(() => {
    bell.count += 1
    bell.onCount?.(bell.count)
  })

const APP = 'http://localhost:4000/'
const GATEWAY = 'https://cezar.example.com:8501'
const frame = () => document.querySelector('iframe')
const toggle = () => document.querySelector<HTMLElement>('[data-slot="browser-auto-reload"]')

let hmr: string
const fetchSpy = vi.fn(async (url: string) => {
  void url
  return new Response(JSON.stringify({ hmr }), { status: 200, headers: { 'content-type': 'application/json' } })
})

async function loaded() {
  await waitFor(() => expect(frame()).not.toBeNull())
  act(() => {
    frame()!.dispatchEvent(new Event('load'))
  })
}

async function probed() {
  await act(async () => {
    vi.advanceTimersByTime(HMR_PROBE_DELAY_MS + 10)
  })
  await waitFor(() => expect(toggle()?.getAttribute('data-hmr')).toBe(hmr))
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  bell.count = 0
  bell.onCount = null
  hmr = 'none'
  cockpit.preview = false
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
  let ticket = 0
  openPreviewGateway.mockReset().mockImplementation(async () => ({ origin: GATEWAY, ticket: `T${(ticket += 1)}`, ticketParam: '__cez_preview' }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderLive() {
  render(<BrowserView state={{ tabs: [APP], active: 0 }} onChange={() => {}} liveTree={{ kind: 'run', runId: 'r1' }} />)
}

describe('Auto-reload', () => {
  it('is offered only for a page with a checkout behind it', async () => {
    render(<BrowserView state={{ tabs: [APP], active: 0 }} onChange={() => {}} />)
    await waitFor(() => expect(frame()).not.toBeNull())
    expect(toggle()).toBeNull()
  })

  it('asks the gateway 2 s after load, and is on for a page with no hot reload', async () => {
    renderLive()
    await loaded()
    // Nobody can tell yet: off, and nothing is listened for.
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    expect(fetchSpy).not.toHaveBeenCalled()
    await probed()
    expect(fetchSpy).toHaveBeenCalledWith(`${GATEWAY}/__cez_preview/hmr`, expect.objectContaining({ credentials: 'include' }))
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
    expect(bell.enabled).toBe(true)
  })

  it('reloads ONCE after a burst of changes settles', async () => {
    renderLive()
    await loaded()
    await probed()
    const before = openPreviewGateway.mock.calls.length
    ring()
    await act(async () => {
      vi.advanceTimersByTime(RELOAD_SETTLE_MS - 200)
    })
    ring()
    ring()
    await act(async () => {
      vi.advanceTimersByTime(RELOAD_SETTLE_MS - 200)
    })
    // Still within the quiet window of the last change: nothing yet.
    expect(openPreviewGateway.mock.calls.length).toBe(before)
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    // One reload = one fresh ticket.
    await waitFor(() => expect(openPreviewGateway.mock.calls.length).toBe(before + 1))
    await act(async () => {
      vi.advanceTimersByTime(RELOAD_SETTLE_MS * 3)
    })
    expect(openPreviewGateway.mock.calls.length).toBe(before + 1)
  })

  it('is off where hot reload came up, and a change then reloads nothing', async () => {
    hmr = 'connected'
    renderLive()
    await loaded()
    await probed()
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    const before = openPreviewGateway.mock.calls.length
    ring()
    await act(async () => {
      vi.advanceTimersByTime(RELOAD_SETTLE_MS * 2)
    })
    expect(openPreviewGateway.mock.calls.length).toBe(before)
    // The user's own switch wins over what was detected.
    fireEvent.click(toggle()!)
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('a blocked hot reload shows the server.hmr hint, and auto-reload covers for it', async () => {
    hmr = 'blocked'
    renderLive()
    await loaded()
    await probed()
    expect(screen.getByText(/server: \{ hmr:/).textContent).toContain('port: undefined')
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('Auto-reload on a local cockpit (the page framed directly)', () => {
  beforeEach(() => {
    cockpit.preview = true
  })

  /** A cross-origin page: the browser lets nobody read its document. */
  const crossOrigin = () =>
    Object.defineProperty(frame()!, 'contentWindow', {
      configurable: true,
      get: () => ({
        get document(): Document {
          throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError')
        },
      }),
    })

  it('a loopback page whose hot reload nobody can see starts with Auto-reload on — one click turns it off', async () => {
    renderLive()
    await waitFor(() => expect(frame()).not.toBeNull())
    crossOrigin()
    await loaded()
    expect(toggle()?.getAttribute('data-hmr')).toBe('unknown')
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
    expect(bell.enabled).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(HMR_PROBE_DELAY_MS + 10)
    })
    // No gateway to ask.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(openPreviewGateway).not.toHaveBeenCalled()
    fireEvent.click(toggle()!)
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    expect(bell.enabled).toBe(false)
  })

  it('reads a same-origin page’s own hot-reload client: Vite’s is off, none is on', async () => {
    renderLive()
    await waitFor(() => expect(frame()).not.toBeNull())
    const doc = frame()!.contentDocument!
    const client = doc.createElement('script')
    client.setAttribute('src', '/@vite/client')
    if (!doc.documentElement) doc.appendChild(doc.createElement('html'))
    doc.documentElement!.append(client)
    await loaded()
    expect(toggle()?.getAttribute('data-hmr')).toBe('connected')
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    client.remove()
    act(() => {
      frame()!.dispatchEvent(new Event('load'))
    })
    expect(toggle()?.getAttribute('data-hmr')).toBe('none')
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('reads Next’s development build as hot reload', () => {
    const fake = { contentWindow: { document: { querySelector: () => null }, __NEXT_DATA__: { buildId: 'development' } } }
    expect(frameHmr(fake as unknown as HTMLIFrameElement)).toBe('connected')
    expect(frameHmr(null)).toBeNull()
  })
})
