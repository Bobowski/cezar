/**
 * The browser half of Web Push (spec 2026-10-24-mobile-cockpit §3.5): the service worker, this
 * device's subscription and why push cannot work here. The server half lives in
 * `packages/cezar/src/push/`; the setting that calls this is Settings → Notifications.
 */

export const SERVICE_WORKER_URL = '/sw.js'

/** Why this device cannot get push, or `ok`. `insecure` is the browser's own rule: push and
 *  service workers exist only in a secure context. */
export type PushDeviceSupport = 'ok' | 'unsupported' | 'insecure'

export function pushDeviceSupport(): PushDeviceSupport {
  if (typeof window === 'undefined') return 'unsupported'
  if (window.isSecureContext === false) return 'insecure'
  const nav = navigator as Navigator & { serviceWorker?: unknown }
  if (!nav.serviceWorker || typeof (window as { PushManager?: unknown }).PushManager !== 'function') return 'unsupported'
  if (typeof (globalThis as { Notification?: unknown }).Notification !== 'function') return 'unsupported'
  return 'ok'
}

/** The VAPID key as `applicationServerKey` wants it. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Register the worker once per page — it caches the hashed bundles for an instant open and shows
 * pushes. Only in a built cockpit served from a secure context; a failure is silent (the cockpit
 * works the same without it).
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || pushDeviceSupport() === 'insecure') return
  const container = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker
  if (!container) return
  void container.register(SERVICE_WORKER_URL, { scope: '/' }).catch(() => undefined)
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const container = navigator.serviceWorker
  const existing = await container.getRegistration('/')
  if (!existing) await container.register(SERVICE_WORKER_URL, { scope: '/' })
  return container.ready
}

/** This device's current subscription, or null. Never throws. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (pushDeviceSupport() !== 'ok') return null
  try {
    const registration = await navigator.serviceWorker.getRegistration('/')
    return (await registration?.pushManager.getSubscription()) ?? null
  } catch {
    return null
  }
}

export type EnablePushResult =
  /** `replacedEndpoint`: a subscription made with an older key was dropped for this one. */
  | { ok: true; subscription: PushSubscriptionJSON; replacedEndpoint?: string }
  | { ok: false; reason: 'denied' | 'unsupported' | 'failed' }

/** Whether `subscription` was made with `key`; an unknown key counts as a different one. */
export function subscribedWithKey(subscription: Pick<PushSubscription, 'options'>, key: Uint8Array): boolean {
  const own = subscription.options?.applicationServerKey
  if (!own) return false
  const bytes = new Uint8Array(own)
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i])
}

/**
 * Ask for permission (here and only here), then subscribe this device with the server's key. A
 * subscription made with an older key (the server's VAPID pair was regenerated) is dropped and
 * made again: the push service refuses every message signed with the new key for it.
 */
export async function enableDevicePush(publicKey: string): Promise<EnablePushResult> {
  if (pushDeviceSupport() !== 'ok') return { ok: false, reason: 'unsupported' }
  try {
    const answer = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (answer !== 'granted') return { ok: false, reason: 'denied' }
    const registration = await readyRegistration()
    const key = base64UrlToBytes(publicKey)
    const existing = await registration.pushManager.getSubscription()
    if (existing && subscribedWithKey(existing, key)) return { ok: true, subscription: existing.toJSON() }
    if (existing) await existing.unsubscribe()
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    return { ok: true, subscription: subscription.toJSON(), ...(existing ? { replacedEndpoint: existing.endpoint } : {}) }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/** Drop this device's subscription in the browser; answers the endpoint it had. */
export async function disableDevicePush(): Promise<string | undefined> {
  const subscription = await currentPushSubscription()
  if (!subscription) return undefined
  const endpoint = subscription.endpoint
  try {
    await subscription.unsubscribe()
  } catch {
    // The server row goes anyway; the browser drops a subscription nobody answers.
  }
  return endpoint
}

/** The server's id for a subscription (`subscriptionIdOf` in packages/cezar/src/push/state.ts: the
 *  first 24 hex of the endpoint's sha-256) — how `GET /workspace/push?device=` names this browser. */
export async function pushSubscriptionId(endpoint: string): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)
  } catch {
    return undefined
  }
}

/** This browser's subscription id, or undefined when it holds none. Never throws. */
export async function currentPushDeviceId(): Promise<string | undefined> {
  const subscription = await currentPushSubscription()
  return subscription ? pushSubscriptionId(subscription.endpoint) : undefined
}
