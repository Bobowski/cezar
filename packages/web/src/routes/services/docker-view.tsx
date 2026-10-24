import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLineIcon, PlayIcon, ScrollTextIcon, SquareIcon, SquareTerminalIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'

import { DOCKER_COMPOSE_FILES_MISSING, type DockerContainer, type DockerImage, type DockerStack, type DockerVolume } from '@open-mercato/cezar-api-client'
import {
  dockerContainerAction, dockerStackAction, dockerStackDown, removeDockerContainer, removeDockerImage, removeDockerVolume,
} from '@/api/client'
import { createCodeTerminal, writeCodeTerminal } from '@/api/code'
import { queryKeys, useHealth } from '@/api/queries'
import { useDocker } from '@/api/services'
import { ContextSidebar } from '@/components/context-sidebar'
import { Page, PageBody } from '@/components/page'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import {
  SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar'
import { toast } from '@/components/ui/toaster'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useNavigate } from '@/lib/project-router'

import { DockerConfirm, type DockerConfirmRequest } from './docker-confirm'
import { DockerDiskView } from './docker-disk'
import { dockerExecCommand } from './docker-format'
import { DockerImagesView } from './docker-images'
import { DockerLogsSheet } from './docker-logs'
import { DockerVolumesView } from './docker-volumes'

const LOOSE = 'Standalone containers'
const stackLabel = (stack: Pick<DockerStack, 'name'>): string => stack.name || LOOSE
const runningOf = (stack: DockerStack): number => stack.containers.filter((container) => container.running).length

type DockerTab = 'containers' | 'images' | 'volumes' | 'disk'
const TABS: Array<{ value: DockerTab; label: string }> = [
  { value: 'containers', label: 'Containers' }, { value: 'images', label: 'Images' }, { value: 'volumes', label: 'Volumes' }, { value: 'disk', label: 'Disk' },
]

/** Whose a stack is, in the words the user would use. */
export function stackOwner(stack: Pick<DockerStack, 'mine' | 'project'>): string | null {
  if (stack.mine) return 'This project'
  return stack.project?.name ?? null
}

/** The red line every confirm about this stack carries: an active task is running in it. */
function taskWarnings(stack: DockerStack): string[] {
  return stack.task?.active ? [`task ${stack.task.title} is ${stack.task.status} in it`] : []
}

/** `compose down` for a stack compose can still name; with its volumes on the checkbox (spec §3.1). */
export function stackDown(stack: DockerStack, down: (volumes: boolean) => void): DockerConfirmRequest {
  return {
    title: `Down ${stack.name}?`,
    body: `docker compose -p ${stack.name} down — its containers and networks are removed${stack.project ? ` (${stackOwner(stack)})` : ''}.`,
    warnings: taskWarnings(stack),
    items: { label: 'Containers', names: stack.containers.map((c) => `${c.name}${c.running ? ' (running)' : ''}`) },
    ...(stack.volumes.length > 0 ? { option: { label: 'Also remove its volumes', names: stack.volumes } } : {}),
    confirmLabel: 'Down',
    onConfirm: down,
  }
}

/**
 * Down's fallback when compose cannot run: the stack's dir is there but its compose files are not
 * (`refusal` is the server's 409). Everything its compose label names goes, said so in full.
 */
export function stackDownByLabel(stack: DockerStack, refusal: string, down: (volumes: boolean) => void): DockerConfirmRequest {
  const dir = refusal.slice(DOCKER_COMPOSE_FILES_MISSING.length).split(';')[0]?.trim() || stack.dir
  return {
    title: `Remove ${stack.name} by its label?`,
    body: `Compose cannot take it down: its files are missing in ${dir}. Instead, everything labelled com.docker.compose.project=${stack.name} goes — each container below is force-removed and the stack's networks are removed${stack.project ? ` (${stackOwner(stack)})` : ''}.`,
    warnings: [...taskWarnings(stack), ...stack.containers.filter((c) => c.running).map((c) => `${c.name} is running`)],
    items: { label: 'Containers', names: stack.containers.map((c) => `${c.name}${c.running ? ' (running)' : ''}`) },
    ...(stack.volumes.length > 0 ? { option: { label: 'Also remove its labelled volumes', names: stack.volumes } } : {}),
    confirmLabel: 'Remove by label',
    onConfirm: down,
  }
}

/** `docker rm -f` of every container, for a stack compose does not know (its dir is gone, or none). */
export function stackRemove(stack: DockerStack, remove: () => void): DockerConfirmRequest {
  return {
    title: `Remove ${stack.containers.length === 1 ? 'its container' : `all ${stack.containers.length} containers`} of ${stackLabel(stack)}?`,
    body: `Each is force-removed${stackOwner(stack) ? ` (${stackOwner(stack)})` : ''}. Volumes stay; delete them on the Volumes tab.`,
    warnings: [...taskWarnings(stack), ...stack.containers.filter((c) => c.running).map((c) => `${c.name} is running`)],
    items: { label: 'Containers', names: stack.containers.map((c) => c.name) },
    confirmLabel: 'Remove',
    onConfirm: remove,
  }
}

export function containerRemove(container: DockerContainer, stack: DockerStack, remove: (force: boolean) => void): DockerConfirmRequest {
  return {
    title: `Remove ${container.name}?`,
    body: container.running ? 'It is running, so it is stopped and removed at once (rm -f).' : 'The stopped container is removed.',
    warnings: [...taskWarnings(stack), ...(container.running ? [`${container.name} is running`] : [])],
    confirmLabel: 'Remove container',
    onConfirm: () => remove(container.running),
  }
}

function ContainerRow({ container, busy, execAllowed, onAct, onRemove, onLogs, onExec }: {
  container: DockerContainer
  busy: boolean
  execAllowed: boolean
  onAct: (action: 'start' | 'stop') => void
  onRemove: () => void
  onLogs: () => void
  onExec: () => void
}) {
  return (
    <Item size="sm" data-slot="docker-container" data-running={container.running} className="flex-nowrap rounded-none">
      <ItemMedia>
        <StatusDot tone={container.running ? 'success' : 'neutral'} />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="max-w-full"><span className="truncate">{container.service ?? container.name}</span></ItemTitle>
        <ItemDescription className="truncate font-mono text-xs">{container.image} · {container.status}</ItemDescription>
      </ItemContent>
      <ItemContent className="hidden font-mono text-xs tabular-nums sm:flex">
        {container.ports.map((port) => (port.host === port.container ? String(port.host) : `${port.host}→${port.container}`)).join('  ')}
      </ItemContent>
      <ItemActions className="gap-0.5">
        <Button variant="ghost" size="icon-sm" aria-label={`Logs of ${container.name}`} onClick={onLogs}>
          <ScrollTextIcon aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={!container.running || !execAllowed} aria-label={`Exec into ${container.name}`} onClick={onExec}>
          <SquareTerminalIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost" size="icon-sm" disabled={busy}
          aria-label={`${container.running ? 'Stop' : 'Start'} ${container.name}`}
          onClick={() => onAct(container.running ? 'stop' : 'start')}
        >
          {container.running ? <SquareIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Remove ${container.name}`} onClick={onRemove}>
          <Trash2Icon aria-hidden="true" />
        </Button>
      </ItemActions>
    </Item>
  )
}

type DockerMutation =
  | { kind: 'stack' | 'container'; id: string; action: 'start' | 'stop' }
  | { kind: 'down'; id: string; volumes: boolean; byLabel?: boolean }
  | { kind: 'rm'; ids: string[]; force: boolean }
  | { kind: 'image'; id: string; force: boolean; users: string[] }
  | { kind: 'volume'; id: string; force: boolean; users: string[] }

async function runMutation(input: DockerMutation): Promise<void> {
  switch (input.kind) {
    case 'stack': return dockerStackAction(input.id, input.action)
    case 'container': return dockerContainerAction(input.id, input.action)
    case 'down': return dockerStackDown(input.id, input.volumes, input.byLabel === true)
    case 'rm': for (const id of input.ids) await removeDockerContainer(id, input.force); return
    case 'image': return removeDockerImage(input.id, input.force, input.users)
    case 'volume': return removeDockerVolume(input.id, input.force, input.users)
  }
}

/**
 * The Docker view of `/p/:projectId/docker` (specs 2026-10-13-docker-view and
 * 2026-10-23-docker-management): every container, image and volume on the machine, named after
 * the cezar project that owns it, and the disk they take — with removal as far as Docker
 * Desktop's, behind a confirm that names what is in use.
 */
export function DockerView({ header }: { header: ReactNode }) {
  const state = useDocker()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const terminalAllowed = useHealth().data?.capabilities?.terminal === true
  const [search, setSearch] = useSearchParams()
  const tab: DockerTab = TABS.some((entry) => entry.value === search.get('tab')) ? search.get('tab') as DockerTab : 'containers'
  const setTab = (next: DockerTab) => setSearch((current) => {
    const params = new URLSearchParams(current)
    if (next === 'containers') params.delete('tab')
    else params.set('tab', next)
    return params
  }, { replace: true })
  const [selected, setSelected] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<DockerConfirmRequest | null>(null)
  const [logs, setLogs] = useState<DockerContainer | null>(null)
  const act = useMutation({
    mutationFn: runMutation,
    onError: (error: Error, input) => {
      // A live dir without its compose files: offer removal by label instead of a dead-end toast.
      const stack = input.kind === 'down' && !input.byLabel && error.message.startsWith(DOCKER_COMPOSE_FILES_MISSING)
        ? state.data?.stacks.find((entry) => entry.name === input.id)
        : undefined
      if (stack) setConfirm(stackDownByLabel(stack, error.message, (volumes) => act.mutate({ kind: 'down', id: stack.name, volumes, byLabel: true })))
      else toast(error.message, { tone: 'danger' })
    },
    // The state key is every sub-view's prefix: one invalidation re-reads whichever is shown.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.docker.state() }),
  })
  // Exec is the cockpit terminal with the command typed in — the terminal's own gate (spec §3.5).
  const exec = useMutation({
    mutationFn: async (container: DockerContainer) => {
      const session = await createCodeTerminal({ kind: 'main' }, {})
      await writeCodeTerminal({ kind: 'main' }, session.id, `${dockerExecCommand(container.id)}\r`)
      return session.id
    },
    onSuccess: (sessionId) => navigate(`/code?terminal=${encodeURIComponent(sessionId)}`),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const stacks = state.data?.stacks ?? []
  const conflicts = state.data?.conflicts ?? []
  const shown = stacks.filter((stack) => selected === null || stack.name === selected)
  const available = state.data?.available === true
  const busy = act.isPending

  return (
    <>
      <ContextSidebar>
        {header}
        <SidebarContent>
          {state.isPending ? (
            <div className="grid gap-2 px-4" aria-hidden="true">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : null}
          {available && stacks.length > 0 ? (
            <SidebarGroup>
              <SidebarGroupLabel>On this machine</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu aria-label="Docker stacks">
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive={selected === null} onClick={() => { setSelected(null); setTab('containers') }}>
                      <span className="text-[13px] font-medium">All containers</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {stacks.map((stack) => {
                    const up = runningOf(stack)
                    return (
                      <SidebarMenuItem key={stack.name}>
                        <SidebarMenuButton size="lg" className="h-auto py-1.5" isActive={selected === stack.name} onClick={() => { setSelected(stack.name); setTab('containers') }}>
                          <StatusDot tone={up > 0 ? 'success' : 'neutral'} />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-[13px] font-medium text-foreground">{stackLabel(stack)}</span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {up} of {stack.containers.length} running{stackOwner(stack) ? ` · ${stackOwner(stack)}` : ''}
                            </span>
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </SidebarContent>
      </ContextSidebar>

      <PageBody className="flex min-h-0 flex-col gap-3 pt-4">
        {state.isError ? <p role="alert" className="text-sm text-danger">{state.error.message}</p> : null}
        {state.data && !available ? (
          <p role="note" data-slot="docker-unavailable" className="text-sm text-pretty text-muted-foreground">
            {state.data.reason ?? 'Docker is unavailable on this cockpit.'}
          </p>
        ) : null}
        {available ? (
          <ToggleGroup type="single" variant="outline" size="sm" aria-label="Docker objects" data-slot="docker-tabs" value={tab} onValueChange={(next) => { if (next) setTab(next as DockerTab) }}>
            {TABS.map((entry) => <ToggleGroupItem key={entry.value} value={entry.value}>{entry.label}</ToggleGroupItem>)}
          </ToggleGroup>
        ) : null}
        {available && tab === 'images' ? (
          <DockerImagesView busy={busy} onConfirm={setConfirm} onRemove={(image: DockerImage, force) => act.mutate({ kind: 'image', id: image.id, force, users: image.usedBy.map((user) => user.id) })} />
        ) : null}
        {available && tab === 'volumes' ? (
          <DockerVolumesView busy={busy} onConfirm={setConfirm} onRemove={(volume: DockerVolume, force) => act.mutate({ kind: 'volume', id: volume.name, force, users: volume.usedBy.map((user) => user.id) })} />
        ) : null}
        {available && tab === 'disk' ? <DockerDiskView /> : null}
        {tab === 'containers' && conflicts.length > 0 ? (
          <Alert variant="destructive" data-slot="docker-conflicts">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>{conflicts.length === 1 ? 'A port this project needs is taken' : `${conflicts.length} ports this project needs are taken`}</AlertTitle>
            <AlertDescription>
              <ul className="space-y-1">
                {conflicts.map((conflict) => (
                  <li key={conflict.port} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>
                      <span className="font-mono">{conflict.port}</span> — <span className="font-mono">{conflict.service}</span> in {conflict.file} publishes it,
                      and <span className="font-mono">{conflict.container}</span> holds it.
                    </span>
                    {conflict.stack ? (
                      <Button variant="outline" size="xs" disabled={busy} onClick={() => act.mutate({ kind: 'stack', id: conflict.stack, action: 'stop' })}>
                        Stop {conflict.stack}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {tab === 'containers' ? shown.map((stack) => {
          const up = runningOf(stack)
          const owner = stackOwner(stack)
          // Compose can name a stack whose dir is there (or cannot be judged); one whose dir is gone, or none, is rm -f.
          const composeKnows = stack.name !== '' && stack.dirState !== 'gone'
          return (
            <Card key={stack.name} flush data-slot="docker-stack" data-stack={stack.name} className="overflow-hidden">
              <CardHeader className="border-b border-border px-4 py-3 [.border-b]:pb-3">
                <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate">{stackLabel(stack)}</span>
                  {owner ? <Badge variant={stack.mine ? 'default' : 'secondary'}>{owner}</Badge> : null}
                  {stack.task ? <Badge variant={stack.task.active ? 'default' : 'secondary'}>task {stack.task.title}</Badge> : null}
                  {stack.dirState === 'gone' ? <Badge variant="secondary">dir gone</Badge> : null}
                </CardTitle>
                <CardDescription className="truncate font-mono text-xs">
                  {up} of {stack.containers.length} running{stack.dir ? `  ·  ${stack.dir}` : ''}
                </CardDescription>
                <CardAction className="flex gap-1.5">
                  {stack.name !== '' ? (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => act.mutate({ kind: 'stack', id: stack.name, action: up > 0 ? 'stop' : 'start' })}>
                      {up > 0 ? <><SquareIcon aria-hidden="true" /> Stop stack</> : <><PlayIcon aria-hidden="true" /> Start stack</>}
                    </Button>
                  ) : null}
                  {composeKnows ? (
                    <Button variant="outline" size="sm" disabled={busy} aria-label={`Down ${stack.name}`}
                      onClick={() => setConfirm(stackDown(stack, (volumes) => act.mutate({ kind: 'down', id: stack.name, volumes })))}>
                      <ArrowDownToLineIcon aria-hidden="true" /> Down
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled={busy} aria-label={`Remove ${stackLabel(stack)}`}
                      onClick={() => setConfirm(stackRemove(stack, () => act.mutate({ kind: 'rm', ids: stack.containers.map((c) => c.id), force: true })))}>
                      <Trash2Icon aria-hidden="true" /> Remove
                    </Button>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="px-0">
                <ItemGroup>
                  {stack.containers.map((container, index) => (
                    <Fragment key={container.id}>
                      {index > 0 ? <ItemSeparator /> : null}
                      <ContainerRow
                        container={container} busy={busy} execAllowed={terminalAllowed && !exec.isPending}
                        onAct={(action) => act.mutate({ kind: 'container', id: container.id, action })}
                        onRemove={() => setConfirm(containerRemove(container, stack, (force) => act.mutate({ kind: 'rm', ids: [container.id], force })))}
                        onLogs={() => setLogs(container)}
                        onExec={() => exec.mutate(container)}
                      />
                    </Fragment>
                  ))}
                </ItemGroup>
              </CardContent>
            </Card>
          )
        }) : null}
        {tab === 'containers' && available && stacks.length === 0 ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyTitle>No containers</EmptyTitle>
              <EmptyDescription>Nothing is running in Docker on this machine, and nothing stopped is left over.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </PageBody>
      <DockerConfirm request={confirm} onClose={() => setConfirm(null)} />
      <DockerLogsSheet container={logs} onClose={() => setLogs(null)} />
    </>
  )
}

/** `/p/:projectId/docker` — the machine's containers as a page of its own. */
export function DockerRoute() {
  const header = (
    <SidebarHeader data-slot="docker-header" className="gap-3 p-3">
      <h2 className="px-1 text-[15px] font-semibold text-foreground">Docker</h2>
    </SidebarHeader>
  )
  return <Page width="full" data-route="docker" className="h-full"><DockerView header={header} /></Page>
}
