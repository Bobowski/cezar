import { Trash2Icon } from 'lucide-react'
import { Fragment, useState } from 'react'

import type { DockerImage } from '@open-mercato/cezar-api-client'
import { useDockerImages } from '@/api/services'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemSeparator, ItemTitle } from '@/components/ui/item'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import type { DockerConfirmRequest } from './docker-confirm'
import { formatBytes } from './docker-format'

type ImageFilter = 'unused' | 'dangling' | 'all'
const FILTERS: Record<ImageFilter, (image: DockerImage) => boolean> = {
  unused: (image) => image.usedBy.length === 0,
  dangling: (image) => image.dangling,
  all: () => true,
}

const imageName = (image: DockerImage): string => image.tags[0] ?? `<none> ${image.id.slice(0, 12)}`

/**
 * The confirm for one image, saying what the server does: always `image rm -f` (every tag goes),
 * and Docker refuses that while a container runs from it, so `force` stops those first.
 */
export function imageRemoval(image: DockerImage, remove: (force: boolean) => void): DockerConfirmRequest {
  const running = image.usedBy.filter((user) => user.running)
  const tags = image.tags.length > 1 ? ` All ${image.tags.length} of its tags go with it.` : ''
  const body = running.length > 0
    ? `${running.length === 1 ? 'A container runs' : `${running.length} containers run`} from it: ${running.length === 1 ? 'it is' : 'they are'} stopped first, then the image is removed (rm -f). Its containers stay, stopped, but cannot be recreated from it.${tags}`
    : image.usedBy.length > 0
      ? `It is removed with -f: the stopped containers that use it stay, but cannot be recreated from it.${tags}`
      : `${formatBytes(image.sizeBytes)} on disk. Nothing uses it.${tags}`
  return {
    title: `Remove ${imageName(image)}?`,
    body,
    warnings: running.map((user) => `${user.name} is running from it and is stopped first`),
    items: { label: 'Used by', names: image.usedBy.map((user) => `${user.name}${user.running ? ' (running)' : ''}`) },
    confirmLabel: running.length > 0 ? 'Stop and remove image' : 'Remove image',
    onConfirm: () => remove(running.length > 0),
  }
}

/** `docker image ls`, with who uses each image (spec 2026-10-23-docker-management §3.2). */
export function DockerImagesView({ busy, onConfirm, onRemove }: {
  busy: boolean
  onConfirm: (request: DockerConfirmRequest) => void
  onRemove: (image: DockerImage, force: boolean) => void
}) {
  const state = useDockerImages()
  const [filter, setFilter] = useState<ImageFilter>('all')
  const images = (state.data?.images ?? []).filter(FILTERS[filter])
  if (state.data && !state.data.available) {
    return <p role="note" className="text-sm text-pretty text-muted-foreground">{state.data.reason ?? 'Docker is unavailable on this cockpit.'}</p>
  }
  return (
    <div data-slot="docker-images" className="grid gap-3">
      <ToggleGroup type="single" variant="outline" size="sm" aria-label="Which images" value={filter} onValueChange={(next) => { if (next) setFilter(next as ImageFilter) }}>
        <ToggleGroupItem value="unused">Unused</ToggleGroupItem>
        <ToggleGroupItem value="dangling">Dangling</ToggleGroupItem>
        <ToggleGroupItem value="all">All</ToggleGroupItem>
      </ToggleGroup>
      {state.isError ? <p role="alert" className="text-sm text-danger">{state.error.message}</p> : null}
      {state.data && images.length === 0 ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyTitle>No images</EmptyTitle>
            <EmptyDescription>{filter === 'all' ? 'Docker holds no images on this machine.' : `No ${filter} images.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {images.length > 0 ? (
        <Card flush className="overflow-hidden">
          <CardContent className="px-0">
            <ItemGroup>
              {images.map((image, index) => (
                <Fragment key={image.id}>
                  {index > 0 ? <ItemSeparator /> : null}
                  <Item size="sm" data-slot="docker-image" data-image={image.id} className="flex-nowrap rounded-none">
                    <ItemContent className="min-w-0 gap-0.5">
                      <ItemTitle className="max-w-full">
                        <span className="truncate font-mono text-xs">{imageName(image)}</span>
                        {image.dangling ? <Badge variant="secondary">dangling</Badge> : null}
                      </ItemTitle>
                      <ItemDescription className="truncate text-xs">
                        {image.id.slice(0, 12)} · {formatBytes(image.sizeBytes)} · {image.created || 'created —'}
                        {image.tags.length > 1 ? ` · also ${image.tags.slice(1).join(', ')}` : ''}
                      </ItemDescription>
                      <ItemDescription className="truncate text-xs">
                        {image.usedBy.length > 0 ? `Used by ${image.usedBy.map((user) => user.name).join(', ')}` : 'Unused'}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        variant="ghost" size="icon-sm" disabled={busy} aria-label={`Remove ${imageName(image)}`}
                        onClick={() => onConfirm(imageRemoval(image, (force) => onRemove(image, force)))}
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
