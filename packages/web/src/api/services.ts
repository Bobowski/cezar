import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { getDocker, getDockerDisk, getDockerImages, getDockerVolumes, getServices } from './client'
import { useHostTransport } from './host-usage'
import { queryKeys } from './queries'
import { subscribeTopic } from './ws'

/** How often a cockpit without the socket bus re-reads the services while a view shows them. */
const POLL_MS = 3_000

/**
 * The project's services (spec 2026-10-11-project-services). State changes arrive as a bare
 * version counter on the project's topic and are answered with one re-read; where the bus is not
 * usable the same read is polled, and only by a view that asks for it (`live`) — the sidebar's
 * count must not turn an idle hosted cockpit into a poller.
 */
/** What the Services nav item wears: how many run, and whether one of them fell over. */
export interface ServicesBadge {
  running: number
  failed: boolean
}

/**
 * The nav badge for `projectId`, read by the shell — which sits above the routed scope and so
 * names its project explicitly. One read at load, then only the project's topic; never polled.
 */
export function useServicesBadge(projectId: string | null): ServicesBadge | null {
  const queryClient = useQueryClient()
  const transport = useHostTransport()
  const query = useQuery({
    queryKey: queryKeys.services.allFor(projectId ?? ''),
    queryFn: ({ signal }) => getServices({ signal }, projectId ?? ''),
    enabled: projectId !== null,
  })
  const topic = query.data?.topic
  useEffect(() => {
    if (transport !== 'local' || !topic || projectId === null) return
    return subscribeTopic(topic, () => void queryClient.invalidateQueries({ queryKey: queryKeys.services.allFor(projectId) }), () => {})
  }, [projectId, queryClient, topic, transport])
  if (!query.data) return null
  const services = query.data.services
  return {
    running: services.filter((service) => service.status === 'running').length,
    failed: services.some((service) => service.status === 'exited' && (service.reason !== null || (service.exitCode ?? 0) !== 0)),
  }
}

export function useServices({ live = false }: { live?: boolean } = {}) {
  const queryClient = useQueryClient()
  const transport = useHostTransport()
  const [refused, setRefused] = useState(false)
  const socket = transport === 'local' && !refused
  const query = useQuery({
    queryKey: queryKeys.services.list(),
    queryFn: ({ signal }) => getServices({ signal }),
    refetchInterval: live && transport !== undefined && !socket ? POLL_MS : false,
  })
  const topic = query.data?.topic
  useEffect(() => {
    if (!socket || !topic) return
    const key = queryKeys.services.list()
    return subscribeTopic(topic, () => void queryClient.invalidateQueries({ queryKey: key }), () => setRefused(true))
  }, [queryClient, socket, topic])
  return query
}

/**
 * The machine's containers (spec 2026-10-13-docker-view). The same shape as `useServices`: one
 * re-read per change on the bus, a poll where the bus is not usable — and only while mounted, so
 * the server stops asking Docker the moment the view is left.
 */
export function useDocker() {
  const queryClient = useQueryClient()
  const transport = useHostTransport()
  const [refused, setRefused] = useState(false)
  const socket = transport === 'local' && !refused
  const query = useQuery({
    queryKey: queryKeys.docker.state(),
    queryFn: ({ signal }) => getDocker({ signal }),
    refetchInterval: transport !== undefined && !socket ? POLL_MS : false,
  })
  const topic = query.data?.topic
  useEffect(() => {
    if (!socket || !topic) return
    const key = queryKeys.docker.state()
    return subscribeTopic(topic, () => void queryClient.invalidateQueries({ queryKey: key }), () => setRefused(true))
  }, [queryClient, socket, topic])
  return query
}

/*
 * Docker management's sub-views (spec 2026-10-23-docker-management). Each lives under the `docker`
 * state key, so the view's one `docker` subscription re-reads whichever is on screen; none polls.
 */
export function useDockerImages({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: queryKeys.docker.images(), queryFn: ({ signal }) => getDockerImages({ signal }), enabled })
}

export function useDockerVolumes({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: queryKeys.docker.volumes(), queryFn: ({ signal }) => getDockerVolumes({ signal }), enabled })
}

/** `projectId` for a reader outside the routed scope; the disk is the machine's either way. */
export function useDockerDisk({ enabled = true, projectId }: { enabled?: boolean; projectId?: string } = {}) {
  const scope = projectId ?? queryKeys.docker.state()[1]
  return useQuery({ queryKey: queryKeys.docker.diskFor(scope), queryFn: ({ signal }) => getDockerDisk({ signal }, scope), enabled })
}
