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
  | { ok: true; subscription: PushSubscriptionJSON }
  | { ok: false; reason: 'denied' | 'unsupported' | 'failed' }

/** Ask for permission (here and only here), then subscribe this device with the server's key. */
export async function enableDevicePush(publicKey: string): Promise<EnablePushResult> {
  if (pushDeviceSupport() !== 'ok') return { ok: false, reason: 'unsupported' }
  try {
    const answer = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (answer !== 'granted') return { ok: false, reason: 'denied' }
    const registration = await readyRegistration()
    const existing = await registration.pushManager.getSubscription()
    const subscription = existing ?? (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    }))
    return { ok: true, subscription: subscription.toJSON() }
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
