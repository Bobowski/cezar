import { afterEach, describe, expect, it, vi } from 'vitest'

import { wantsPresence } from '@/components/push-presence'
import { base64UrlToBytes, enableDevicePush, pushDeviceSupport } from './push'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('base64UrlToBytes', () => {
  it('decodes the unpadded base64url a VAPID key is', () => {
    expect([...base64UrlToBytes('BAEC_w')]).toEqual([4, 1, 2, 255])
  })
})

describe('pushDeviceSupport', () => {
  it('is unsupported in a browser without service workers or PushManager (jsdom)', () => {
    expect(pushDeviceSupport()).toBe('unsupported')
  })

  it('is insecure over plain http to another host', () => {
    vi.stubGlobal('isSecureContext', false)
    expect(pushDeviceSupport()).toBe('insecure')
  })
})

describe('enableDevicePush', () => {
  it('never prompts where push cannot work', async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: 'default', requestPermission }))
    expect(await enableDevicePush('BAEC')).toEqual({ ok: false, reason: 'unsupported' })
    expect(requestPermission).not.toHaveBeenCalled()
  })
})

describe('wantsPresence — the visible-tab half of the push gate', () => {
  it('holds the topic only on a hosted cockpit, over the socket, while visible', () => {
    expect(wantsPresence({ hosted: true, transport: 'local', visible: true })).toBe(true)
    expect(wantsPresence({ hosted: true, transport: 'local', visible: false })).toBe(false)
    expect(wantsPresence({ hosted: false, transport: 'local', visible: true })).toBe(false)
    expect(wantsPresence({ hosted: true, transport: 'remote', visible: true })).toBe(false)
    expect(wantsPresence({ hosted: true, transport: undefined, visible: true })).toBe(false)
  })
})
