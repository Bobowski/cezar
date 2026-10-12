import { afterEach, describe, expect, it, vi } from 'vitest'

import { onSocketProbe, resetSocketProbe, socketProbeResult, startSocketProbe, transportFor, wantsSocketProbe } from './socket-transport'
import { probeSocket } from './ws'

const LOCAL = { capabilities: { localHandoff: true } }
const HOSTED = { capabilities: { localHandoff: false } }

/** A WebSocket that does whatever the test tells it to after construction. */
function stubSocket(outcome: 'open' | 'close' | 'never') {
  const made: Array<{ url: string; closed: boolean }> = []
  class FakeSocket {
    private handlers = new Map<string, () => void>()
    readonly record: { url: string; closed: boolean }
    constructor(url: string) {
      this.record = { url, closed: false }
      made.push(this.record)
      if (outcome !== 'never') queueMicrotask(() => this.handlers.get(outcome)?.())
    }
    addEventListener(type: string, handler: () => void) {
      this.handlers.set(type, handler)
    }
    close() {
      this.record.closed = true
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket)
  return made
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetSocketProbe()
})

describe('transportFor', () => {
  it('waits for health, and a local cockpit always has the socket', () => {
    expect(transportFor(undefined, true, true)).toBeUndefined()
    expect(transportFor(LOCAL, false, undefined)).toBe('local')
  })

  it('a hosted cockpit gets the socket only when signed in AND the proxy is proven to pass it', () => {
    expect(transportFor(HOSTED, true, true)).toBe('local')
    expect(transportFor(HOSTED, true, undefined)).toBe('remote') // not known yet: HTTP meanwhile
    expect(transportFor(HOSTED, true, false)).toBe('remote') // the proxy does not upgrade
    expect(transportFor(HOSTED, false, true)).toBe('remote') // Basic-Auth front: cannot carry it
  })

  it('only a signed-in hosted cockpit needs to ask', () => {
    expect(wantsSocketProbe(HOSTED, true)).toBe(true)
    expect(wantsSocketProbe(HOSTED, false)).toBe(false)
    expect(wantsSocketProbe(LOCAL, true)).toBe(false)
    expect(wantsSocketProbe(undefined, true)).toBe(false)
  })
})

describe('probeSocket', () => {
  it('answers yes when the handshake completes, and closes the socket it opened', async () => {
    const made = stubSocket('open')
    expect(await probeSocket()).toBe(true)
    expect(made).toHaveLength(1)
    expect(made[0]!.url).toMatch(/^ws:\/\/[^/]+\/api\/v1\/ws$/)
    expect(made[0]!.closed).toBe(true)
  })

  it('answers no when the proxy refuses the upgrade', async () => {
    stubSocket('close')
    expect(await probeSocket()).toBe(false)
  })

  it('answers no rather than wait forever on a handshake that never finishes', async () => {
    vi.useFakeTimers()
    stubSocket('never')
    const answer = probeSocket(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await answer).toBe(false)
  })

  it('answers no where there is no WebSocket at all', async () => {
    vi.stubGlobal('WebSocket', undefined)
    expect(await probeSocket()).toBe(false)
  })
})

describe('startSocketProbe', () => {
  it('asks once per page, however many consumers want the answer, and tells them when it lands', async () => {
    const made = stubSocket('open')
    const heard = vi.fn()
    onSocketProbe(heard)
    startSocketProbe()
    startSocketProbe()
    expect(socketProbeResult()).toBeUndefined()
    await vi.waitFor(() => expect(socketProbeResult()).toBe(true))
    startSocketProbe()
    expect(made).toHaveLength(1)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('a refusal is remembered — no reconnect loop against a proxy that will never upgrade', async () => {
    const made = stubSocket('close')
    startSocketProbe()
    await vi.waitFor(() => expect(socketProbeResult()).toBe(false))
    startSocketProbe()
    expect(made).toHaveLength(1)
  })
})
