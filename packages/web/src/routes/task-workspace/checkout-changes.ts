import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { queryScope } from '@open-mercato/cezar-api-client'
import { getCodeWatch, treeKey, type CodeTree } from '@/api/code'
import { useHostTransport } from '@/api/host-usage'
import { subscribeTopic } from '@/api/ws'

/** How often a cockpit without the socket compares stamps, while the page is visible. */
export const STAMP_POLL_MS = 3_000

/**
 * A counter that moves when the checkout changes on disk (spec 2026-10-24-cockpit-polish §3.2) —
 * the Preview's auto-reload signal. Rides the checkout's bell (`/repo/watch`'s topic, the Code
 * page's own) where the socket is usable; elsewhere — a remote cockpit, a host with no hub — it
 * compares `?stamp=1` digests. Only while `enabled`: nothing listens for a page nobody reloads.
 * It says THAT something changed, never what.
 */
export function useCheckoutChanges(tree: CodeTree | null, enabled: boolean): number {
  const transport = useHostTransport()
  const [count, setCount] = useState(0)
  const projectId = queryScope()
  const key = tree ? treeKey(tree) : null
  const socket = transport === 'local'
  const watch = useQuery({
    queryKey: ['code', 'watch', projectId, key],
    queryFn: ({ signal }) => getCodeWatch(tree as CodeTree, { signal }),
    enabled: enabled && tree !== null && socket,
    staleTime: Infinity,
    retry: false,
  })
  const topic = socket ? (watch.data?.topic ?? null) : null
  const learning = socket && watch.isPending

  useEffect(() => {
    if (!enabled || topic === null) return
    // Every subscribe answers with a snapshot of the counter: the first is the baseline.
    let seen: number | null = null
    return subscribeTopic(topic, (data) => {
      const version = typeof data === 'object' && data !== null ? (data as { version?: unknown }).version : undefined
      if (typeof version !== 'number') return
      if (seen !== null && version > seen) setCount((value) => value + 1)
      seen = seen === null ? version : Math.max(seen, version)
    })
  }, [enabled, topic])

  useEffect(() => {
    if (!enabled || tree === null || topic !== null || learning) return
    let stopped = false
    let last: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const look = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const stamp = (await getCodeWatch(tree, undefined, true)).stamp ?? null
          if (!stopped && stamp !== null) {
            if (last !== null && stamp !== last) setCount((value) => value + 1)
            last = stamp
          }
        } catch {
          // A missed look is the next look's to make.
        }
      }
      if (!stopped) timer = setTimeout(() => void look(), STAMP_POLL_MS)
    }
    void look()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // `tree` is identified by `key`; a new object for the same checkout is the same poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, learning, topic])

  return count
}

/**
 * The hook as a renderless child, so a view that only sometimes has a checkout (the Browser: a
 * task's column yes, the Code page's tab no) mounts the query machinery only when it does.
 */
export function CheckoutChangesListener({
  tree,
  enabled,
  onCount,
}: {
  tree: CodeTree
  enabled: boolean
  onCount: (count: number) => void
}): null {
  const count = useCheckoutChanges(tree, enabled)
  const report = useRef(onCount)
  report.current = onCount
  useEffect(() => report.current(count), [count])
  return null
}
