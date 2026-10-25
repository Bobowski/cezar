import { useQuery } from '@tanstack/react-query'

import type { PushSubscribeInput, WorkspacePushState } from '@open-mercato/cezar-api-client'
import { currentPushDeviceId, disableDevicePush } from '@/lib/push'
import { cez, unwrap } from './client'

/** Web Push (spec 2026-10-24-mobile-cockpit §4). Workspace-level: never project-scoped. */
export const pushQueryKeys = { state: ['workspace', 'push'] as const }

/** Names this browser's own subscription, so `subscribed`/`stale` answer for this device alone. */
export async function fetchPushState(signal?: AbortSignal): Promise<WorkspacePushState> {
  const device = await currentPushDeviceId()
  return unwrap(
    await cez.api.v1.workspace.push.$get({ query: device !== undefined ? { device } : {} }, { init: { signal } }),
    '/workspace/push',
  )
}

export async function subscribePush(subscription: PushSubscribeInput): Promise<WorkspacePushState> {
  return unwrap(await cez.api.v1.workspace.push.subscribe.$post({ json: subscription }), '/workspace/push/subscribe')
}

export async function unsubscribePush(endpoint?: string): Promise<WorkspacePushState> {
  return unwrap(
    await cez.api.v1.workspace.push.subscribe.$delete({ json: endpoint !== undefined ? { endpoint } : {} }),
    '/workspace/push/subscribe',
  )
}

/** One beat of a socket-less tab's presence (`components/push-presence.tsx`); `device` is this
 *  browser's subscription id, which keys the server's rate limit without sign-in. Never throws. */
export async function beatPushPresence(visible: boolean, tab: string, device?: string): Promise<void> {
  try {
    const json = { visible, tab, ...(device !== undefined ? { device } : {}) }
    await cez.api.v1.workspace.push.presence.$post({ json }, { init: { keepalive: !visible } })
  } catch {
    // A missed beat only means a push may arrive while the tab is open.
  }
}

/** Signing a device out ends its push (spec §5): the browser's subscription and the server row,
 *  while the session that owns the row still exists. Bounded, so sign-out never waits on it. */
export async function dropDevicePush(timeoutMs = 2_000): Promise<void> {
  const work = (async () => {
    const endpoint = await disableDevicePush()
    if (endpoint !== undefined) await unsubscribePush(endpoint).catch(() => undefined)
  })()
  await Promise.race([work.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, timeoutMs))])
}

export function usePushState(enabled = true) {
  return useQuery({ queryKey: pushQueryKeys.state, queryFn: ({ signal }) => fetchPushState(signal), enabled })
}
