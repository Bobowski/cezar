import { Trash2Icon } from 'lucide-react'
import { Fragment } from 'react'

import type { DockerVolume } from '@open-mercato/cezar-api-client'
import { useDockerVolumes } from '@/api/services'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemSeparator, ItemTitle } from '@/components/ui/item'

import type { DockerConfirmRequest } from './docker-confirm'
import { formatBytes } from './docker-format'

/** A volume with data and no container: the orphaned task database this view exists for. */
export const isOrphanedData = (volume: DockerVolume): boolean => (volume.sizeBytes ?? 0) > 0 && volume.usedBy.length === 0

/**
 * The confirm for one volume. Docker refuses a volume any container still mounts, stopped or not,
 * so with users the server removes those containers first (`force`) — and the confirm says so.
 * The one typed confirm the cockpit keeps (spec §3.3): data in a volume no container owns has no undo.
 */
export function volumeRemoval(volume: DockerVolume, remove: (force: boolean) => void): DockerConfirmRequest {
  const users = volume.usedBy.length
  return {
    title: `Delete volume ${volume.name}?`,
    body: users > 0
      ? `Docker will not delete a volume a container still mounts, so ${users === 1 ? 'the container below is' : `the ${users} containers below are`} removed first (rm -f), then the volume. Its data is gone for good.`
      : `${formatBytes(volume.sizeBytes)} of data${volume.stack ? ` from stack ${volume.stack}` : ''}. It is gone for good.`,
    warnings: volume.usedBy.filter((user) => user.running).map((user) => `${user.name} is running with it mounted and is removed`),
    items: { label: 'Removed with it', names: volume.usedBy.map((user) => `${user.name}${user.running ? ' (running)' : ''}`) },
    ...(isOrphanedData(volume) ? { typeToConfirm: volume.name } : {}),
    confirmLabel: users > 0 ? 'Remove containers and volume' : 'Delete volume',
    onConfirm: () => remove(users > 0),
  }
}

/** `docker volume ls`, sized by `docker system df -v` (spec 2026-10-23-docker-management §3.3). */
export function DockerVolumesView({ busy, onConfirm, onRemove }: {
  busy: boolean
  onConfirm: (request: DockerConfirmRequest) => void
  onRemove: (volume: DockerVolume, force: boolean) => void
}) {
  const state = useDockerVolumes()
  const volumes = state.data?.volumes ?? []
  if (state.data && !state.data.available) {
    return <p role="note" className="text-sm text-pretty text-muted-foreground">{state.data.reason ?? 'Docker is unavailable on this cockpit.'}</p>
  }
  return (
    <div data-slot="docker-volumes" className="grid gap-3">
      {state.isError ? <p role="alert" className="text-sm text-danger">{state.error.message}</p> : null}
      {state.data && volumes.length === 0 ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyTitle>No volumes</EmptyTitle>
            <EmptyDescription>Docker holds no volumes on this machine.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {volumes.length > 0 ? (
        <Card flush className="overflow-hidden">
          <CardContent className="px-0">
            <ItemGroup>
              {volumes.map((volume, index) => (
                <Fragment key={volume.name}>
                  {index > 0 ? <ItemSeparator /> : null}
                  <Item size="sm" data-slot="docker-volume" data-volume={volume.name} className="flex-nowrap rounded-none">
                    <ItemContent className="min-w-0 gap-0.5">
                      <ItemTitle className="max-w-full">
                        <span className="truncate font-mono text-xs">{volume.name}</span>
                        {volume.mine ? <Badge>This project</Badge> : volume.project ? <Badge variant="secondary">{volume.project.name}</Badge> : null}
                        {isOrphanedData(volume) ? <Badge variant="secondary">no container</Badge> : null}
                      </ItemTitle>
                      <ItemDescription className="truncate text-xs">
                        {formatBytes(volume.sizeBytes)} · {volume.driver}{volume.stack ? ` · stack ${volume.stack}` : ''}
                        {volume.usedBy.length > 0 ? ` · mounted by ${volume.usedBy.map((user) => user.name).join(', ')}` : ''}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        variant="ghost" size="icon-sm" disabled={busy} aria-label={`Delete ${volume.name}`}
                        onClick={() => onConfirm(volumeRemoval(volume, (force) => onRemove(volume, force)))}
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </ItemActions>
                  </Item>
                </Fragment>
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
