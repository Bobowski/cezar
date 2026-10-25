import { useQuery } from '@tanstack/react-query'

import type { PushSubscribeInput, WorkspacePushState } from '@open-mercato/cezar-api-client'
import { disableDevicePush } from '@/lib/push'
import { cez, unwrap } from './client'

/** Web Push (spec 2026-10-24-mobile-cockpit §4). Workspace-level: never project-scoped. */
export const pushQueryKeys = { state: ['workspace', 'push'] as const }

export async function fetchPushState(signal?: AbortSignal): Promise<WorkspacePushState> {
  return unwrap(await cez.api.v1.workspace.push.$get({}, { init: { signal } }), '/workspace/push')
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
