import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlayIcon, SquareIcon, TriangleAlertIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { DockerContainer, DockerStack } from '@open-mercato/cezar-api-client'
import { dockerContainerAction, dockerStackAction } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { useDocker } from '@/api/services'
import { ContextSidebar } from '@/components/context-sidebar'
import { PageBody } from '@/components/page'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar'
import { toast } from '@/components/ui/toaster'

const LOOSE = 'Standalone containers'
const stackLabel = (stack: Pick<DockerStack, 'name'>): string => stack.name || LOOSE
const runningOf = (stack: DockerStack): number => stack.containers.filter((container) => container.running).length

/** Whose a stack is, in the words the user would use. */
export function stackOwner(stack: Pick<DockerStack, 'mine' | 'project'>): string | null {
  if (stack.mine) return 'This project'
  return stack.project?.name ?? null
}

function ContainerRow({ container, busy, onAct }: { container: DockerContainer; busy: boolean; onAct: (action: 'start' | 'stop') => void }) {
  return (
    <li data-slot="docker-container" data-running={container.running} className="flex items-center gap-3 px-4 py-2">
      <StatusDot tone={container.running ? 'success' : 'neutral'} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{container.service ?? container.name}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{container.image} · {container.status}</p>
      </div>
      <p className="hidden shrink-0 font-mono text-xs text-foreground tabular-nums sm:block">
        {container.ports.map((port) => (port.host === port.container ? String(port.host) : `${port.host}→${port.container}`)).join('  ')}
      </p>
      <Button
        variant="ghost" size="icon-sm" disabled={busy}
        aria-label={`${container.running ? 'Stop' : 'Start'} ${container.name}`}
        onClick={() => onAct(container.running ? 'stop' : 'start')}
      >
        {container.running ? <SquareIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
      </Button>
    </li>
  )
}

/**
 * The Docker view of `/p/:projectId/services` (spec 2026-10-13-docker-view): every container on
 * the machine, grouped by compose project and named after the cezar project that owns it — so
 * "can I start this project?" is answered before the port collision, not by it.
 */
export function DockerView({ header }: { header: ReactNode }) {
  const state = useDocker()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const act = useMutation({
    mutationFn: (input: { kind: 'stack' | 'container'; id: string; action: 'start' | 'stop' }) =>
      input.kind === 'stack' ? dockerStackAction(input.id, input.action) : dockerContainerAction(input.id, input.action),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.docker.state() }),
  })

  const stacks = state.data?.stacks ?? []
  const conflicts = state.data?.conflicts ?? []
  const shown = stacks.filter((stack) => selected === null || stack.name === selected)
  const available = state.data?.available === true

  return (
    <>
      <ContextSidebar>
        {header}
        <SidebarContent>
          {state.isPending ? <p className="px-4 text-xs text-muted-foreground">Loading…</p> : null}
          {available && stacks.length > 0 ? (
            <SidebarGroup>
              <SidebarGroupLabel>On this machine</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu aria-label="Docker stacks">
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive={selected === null} onClick={() => setSelected(null)}>
                      <span className="text-[13px] font-medium">All containers</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {stacks.map((stack) => {
                    const up = runningOf(stack)
                    return (
                      <SidebarMenuItem key={stack.name}>
                        <SidebarMenuButton size="lg" className="h-auto py-1.5" isActive={selected === stack.name} onClick={() => setSelected(stack.name)}>
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
        {conflicts.length > 0 ? (
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
                      <Button variant="outline" size="xs" disabled={act.isPending} onClick={() => act.mutate({ kind: 'stack', id: conflict.stack, action: 'stop' })}>
                        Stop {conflict.stack}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {shown.map((stack) => {
          const up = runningOf(stack)
          const owner = stackOwner(stack)
          return (
            <Card key={stack.name} flush data-slot="docker-stack" data-stack={stack.name} className="overflow-hidden">
              <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0 space-y-0.5">
                  <h2 className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
                    <span className="truncate">{stackLabel(stack)}</span>
                    {owner ? <Badge variant={stack.mine ? 'default' : 'secondary'}>{owner}</Badge> : null}
                  </h2>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {up} of {stack.containers.length} running{stack.dir ? `  ·  ${stack.dir}` : ''}
                  </p>
                </div>
                {stack.name !== '' ? (
                  up > 0 ? (
                    <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ kind: 'stack', id: stack.name, action: 'stop' })}>
                      <SquareIcon aria-hidden="true" /> Stop stack
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ kind: 'stack', id: stack.name, action: 'start' })}>
                      <PlayIcon aria-hidden="true" /> Start stack
                    </Button>
                  )
                ) : null}
              </header>
              <ul className="divide-y divide-border">
                {stack.containers.map((container) => (
                  <ContainerRow
                    key={container.id} container={container} busy={act.isPending}
                    onAct={(action) => act.mutate({ kind: 'container', id: container.id, action })}
                  />
                ))}
              </ul>
            </Card>
          )
        })}
        {available && stacks.length === 0 ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyTitle>No containers</EmptyTitle>
              <EmptyDescription>Nothing is running in Docker on this machine, and nothing stopped is left over.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </PageBody>
    </>
  )
}
