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

describe('enableDevicePush after the server key rotated', () => {
  const OLD_KEY = 'BAEC_w'
  const NEW_KEY = 'BAMEBQ'
  function stubPushDevice(existing: { key: string | null } | null) {
    const unsubscribe = vi.fn(async () => true)
    const subscribe = vi.fn(async (options: PushSubscriptionOptionsInit) => ({
      endpoint: 'https://push.example.net/new',
      options,
      toJSON: () => ({ endpoint: 'https://push.example.net/new', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe,
    }))
    const current = existing === null ? null : {
      endpoint: 'https://push.example.net/old',
      options: { applicationServerKey: existing.key === null ? null : base64UrlToBytes(existing.key).buffer },
      toJSON: () => ({ endpoint: 'https://push.example.net/old', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe,
    }
    const registration = { pushManager: { getSubscription: vi.fn(async () => current), subscribe } }
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('PushManager', function PushManager() {})
    vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: 'granted' }))
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => registration, register: async () => registration, ready: Promise.resolve(registration) },
    })
    return { subscribe, unsubscribe }
  }
  afterEach(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  })

  it('drops a subscription made with an older key and subscribes again with the current one', async () => {
    const device = stubPushDevice({ key: OLD_KEY })
    const result = await enableDevicePush(NEW_KEY)
    expect(device.unsubscribe).toHaveBeenCalledOnce()
    expect(device.subscribe).toHaveBeenCalledOnce()
    expect([...new Uint8Array(device.subscribe.mock.calls[0]![0].applicationServerKey as Uint8Array)]).toEqual([...base64UrlToBytes(NEW_KEY)])
    expect(result).toEqual({ ok: true, subscription: { endpoint: 'https://push.example.net/new', keys: { p256dh: 'p', auth: 'a' } }, replacedEndpoint: 'https://push.example.net/old' })
  })

  it('keeps a subscription made with the current key', async () => {
    const device = stubPushDevice({ key: NEW_KEY })
    const result = await enableDevicePush(NEW_KEY)
    expect(device.unsubscribe).not.toHaveBeenCalled()
    expect(device.subscribe).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, subscription: { endpoint: 'https://push.example.net/old', keys: { p256dh: 'p', auth: 'a' } } })
  })

  it('re-subscribes when the browser does not say which key a subscription was made with', async () => {
    const device = stubPushDevice({ key: null })
    await enableDevicePush(NEW_KEY)
    expect(device.subscribe).toHaveBeenCalledOnce()
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
