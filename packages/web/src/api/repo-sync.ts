import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { getRepoSync } from './client'
import { useHostTransport } from './host-usage'
import { queryKeys } from './queries'
import { subscribeTopic } from './ws'

/** The server fetches at most this often; a cockpit without the bus asks on the same beat. */
const POLL_MS = 5 * 60_000

/**
 * How far the main checkout is behind (or ahead of) its upstream. The server fetches origin only
 * while a view holds the project's `repo-sync` topic, and rings it when the upstream moved; where
 * the bus is not usable the mounted view asks for the fetch itself, on a slow poll.
 */
export function useRepoSync() {
  const queryClient = useQueryClient()
  const transport = useHostTransport()
  const [refused, setRefused] = useState(false)
  const socket = transport === 'local' && !refused
  const key = queryKeys.repoSync
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getRepoSync({ signal, refresh: transport !== undefined && !socket }),
    refetchInterval: transport !== undefined && !socket ? POLL_MS : false,
  })
  const topic = query.data?.topic
  const scope = key[0]
  useEffect(() => {
    if (!socket || !topic) return
    return subscribeTopic(topic, () => void queryClient.invalidateQueries({ queryKey: [scope, 'repo', 'sync'] }), () => setRefused(true))
  }, [queryClient, scope, socket, topic])
  return query
}
