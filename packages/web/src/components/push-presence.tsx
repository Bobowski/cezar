import { useEffect, useState } from 'react'

import { useHealth } from '@/api/queries'
import { useTransportFor, type Transport } from '@/api/socket-transport'
import { subscribeTopic } from '@/api/ws'

/** The topic a visible tab holds; the server's push gate reads who holds it (`push/routes.ts`). */
export const PRESENCE_TOPIC = 'presence'

/** Hold `presence` only on a hosted cockpit (the only one that pushes), over the socket, while
 *  this page is visible — so a phone with its screen locked still gets the push. */
export function wantsPresence(input: { hosted: boolean; transport: Transport | undefined; visible: boolean }): boolean {
  return input.hosted && input.transport === 'local' && input.visible
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * Tells the server a cockpit tab of this account is on screen, so push stays quiet while you are
 * looking (spec 2026-10-24-mobile-cockpit §3.5 — the same rule the browser notification follows).
 * Mounted once at the root. Renders nothing.
 */
export function PushPresence() {
  const health = useHealth().data
  const transport = useTransportFor(health)
  const hosted = health !== undefined && health.capabilities?.localHandoff !== true
  const [visible, setVisible] = useState(pageVisible)

  useEffect(() => {
    const onChange = () => setVisible(pageVisible())
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  const hold = wantsPresence({ hosted, transport, visible })
  useEffect(() => {
    if (!hold) return
    return subscribeTopic(PRESENCE_TOPIC, () => undefined)
  }, [hold])

  return null
}
