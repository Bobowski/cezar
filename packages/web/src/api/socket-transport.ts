import { useEffect, useSyncExternalStore } from 'react'

import { useSignedInUser } from './auth'
import { probeSocket } from './ws'

/**
 * Which transport this cockpit's live signals ride: the WebSocket bus (`local`) or HTTP reads
 * (`remote`). The names are historical — they used to mean "local cockpit" and "hosted cockpit",
 * because a hosted one sat behind Basic-Auth that a browser WebSocket cannot carry.
 *
 * With cezar's own sign-in (spec 2026-10-12-cockpit-authentication §7) the session cookie rides
 * the upgrade, so a signed-in hosted cockpit CAN have the socket — if its proxy passes upgrades.
 * That is not ours to know, so it is asked once (`probeSocket`) and the answer kept for the page:
 * until it is yes, and whenever it is no, every consumer stays on the HTTP path it already has.
 */
export type Transport = 'local' | 'remote'

let proven: boolean | undefined
let probing = false
const listeners = new Set<() => void>()

export function onSocketProbe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function socketProbeResult(): boolean | undefined {
  return proven
}

/** Ask once per page. Safe to call on every render path that might need the answer. */
export function startSocketProbe(): void {
  if (probing || proven !== undefined) return
  probing = true
  void probeSocket().then((ok) => {
    proven = ok
    probing = false
    for (const listener of [...listeners]) listener()
  })
}

/** Tests only. */
export function resetSocketProbe(): void {
  proven = undefined
  probing = false
}

type HealthLike = { capabilities?: { localHandoff?: boolean } } | undefined

/**
 * The decision, pure. `undefined` until health — the authenticated bootstrap — has answered, so
 * nothing opens a socket before the deployment mode is known.
 */
export function transportFor(health: HealthLike, signedIn: boolean, socketProven: boolean | undefined): Transport | undefined {
  if (health === undefined) return undefined
  if (health.capabilities?.localHandoff === true) return 'local'
  return signedIn && socketProven === true ? 'local' : 'remote'
}

/** Whether this cockpit should find out if its proxy passes WebSockets. */
export function wantsSocketProbe(health: HealthLike, signedIn: boolean): boolean {
  return health !== undefined && health.capabilities?.localHandoff !== true && signedIn
}

/** `transportFor` as a hook. Takes health rather than reading it: `queries.ts` imports this file. */
export function useTransportFor(health: HealthLike): Transport | undefined {
  const signedIn = useSignedInUser() !== null
  const socketProven = useSyncExternalStore(onSocketProbe, socketProbeResult, socketProbeResult)
  const probe = wantsSocketProbe(health, signedIn)
  useEffect(() => {
    if (probe) startSocketProbe()
  }, [probe])
  return transportFor(health, signedIn, socketProven)
}
