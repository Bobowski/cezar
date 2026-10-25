import { useEffect, useRef, useState } from 'react'

import { beatPushPresence } from '@/api/push'
import { useHealth } from '@/api/queries'
import { useTransportFor, type Transport } from '@/api/socket-transport'
import { subscribeTopic } from '@/api/ws'
import { currentPushDeviceId } from '@/lib/push'

/** The topic a visible tab holds; the server's push gate reads who holds it (`push/routes.ts`). */
export const PRESENCE_TOPIC = 'presence'

/** How often a socket-less tab beats; the server holds a beat for 45 s (`push/presence.ts`). */
export const PRESENCE_BEAT_MS = 30_000

/** How this tab tells the server it is on screen: the `presence` topic over the socket, an HTTP
 *  beat where there is none (hosted without sign-in), or not at all — a local cockpit never
 *  pushes, and a hidden page must let the push through. */
export function presenceChannel(input: { hosted: boolean; transport: Transport | undefined; visible: boolean }): 'socket' | 'beat' | null {
  if (!input.hosted || !input.visible || input.transport === undefined) return null
  return input.transport === 'local' ? 'socket' : 'beat'
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

const newTabId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)

/**
 * Tells the server a cockpit tab of this account is on screen, so push stays quiet while you are
 * looking (spec 2026-10-24-mobile-cockpit §3.5 — the same rule the browser notification follows).
 * Mounted once at the root. Renders nothing.
 */
export function PushPresence({ beatMs = PRESENCE_BEAT_MS }: { beatMs?: number } = {}) {
  const health = useHealth().data
  const transport = useTransportFor(health)
  const hosted = health !== undefined && health.capabilities?.localHandoff !== true
  const [visible, setVisible] = useState(pageVisible)
  const [tab] = useState(newTabId)
  // The hide beat cannot wait on the service worker, so it reuses the last visible beat's id.
  const device = useRef<string | undefined>(undefined)

  useEffect(() => {
    const onChange = () => setVisible(pageVisible())
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  const channel = presenceChannel({ hosted, transport, visible })
  useEffect(() => {
    if (channel === 'socket') return subscribeTopic(PRESENCE_TOPIC, () => undefined)
    if (channel !== 'beat') return
    const beat = () => void currentPushDeviceId().then((id) => {
      device.current = id
      return beatPushPresence(true, tab, id)
    })
    beat()
    const timer = setInterval(beat, beatMs)
    return () => {
      clearInterval(timer)
      void beatPushPresence(false, tab, device.current)
    }
  }, [channel, tab, beatMs])

  return null
}
