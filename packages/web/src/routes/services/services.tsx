import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, PlayIcon, PlusIcon, RotateCwIcon, SquareIcon, Trash2Icon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { queryScope, type Service, type ServiceCandidate } from '@open-mercato/cezar-api-client'
import {
  pinService, readServiceOutput, resizeService, serviceAction, servicesAction, unpinService, writeServiceInput,
} from '@/api/client'
import { queryKeys } from '@/api/queries'
import { useServices } from '@/api/services'
import { ContextSidebar } from '@/components/context-sidebar'
import { Page, PageBody } from '@/components/page'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuAction,
  SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { TerminalPane, type TerminalIo } from '@/routes/task-workspace/terminal-pane'

/** The sentence beside a service's name. `running` claims a live process and nothing more. */
export function serviceStateLabel(service: Pick<Service, 'status' | 'exitCode' | 'reason'>): string {
  if (service.status === 'running') return 'Running'
  if (service.status === 'stopped') return 'Stopped'
  if (service.reason) return `Could not start — ${service.reason}`
  return service.exitCode === null ? 'Exited' : `Exited with code ${service.exitCode}`
}

export function serviceTone(service: Pick<Service, 'status' | 'exitCode' | 'reason'>): StatusDotTone {
  if (service.status === 'running') return 'success'
  if (service.status === 'exited' && (service.reason !== null || (service.exitCode ?? 0) !== 0)) return 'danger'
  return 'neutral'
}

/**
 * One service's output. The screen is the task terminal's, over the service's own routes: a
 * running service is typed into (`r` to restart Vite); one that ended shows what it last said.
 */
export function ServiceLog({ service, active = true }: { service: Service; active?: boolean }) {
  const io = useMemo<TerminalIo>(() => ({
    read: (cursor) => readServiceOutput(service.id, cursor),
    write: (data) => writeServiceInput(service.id, data),
    resize: (cols, rows) => resizeService(service.id, cols, rows),
  }), [service.id])
  // A new start is a new session with its own cursor: remount, so the screen starts clean.
  const key = `${service.id}:${service.startedAt ?? 'never'}:${service.status}`
  return (
    <TerminalPane
      key={key}
      runId=""
      io={io}
      active={active}
      session={{ id: key, topic: service.topic, exitCode: service.status === 'running' ? null : service.exitCode ?? 0 }}
    />
  )
}

function useServiceMutations() {
  const queryClient = useQueryClient()
  const refresh = (projectId: string) => queryClient.invalidateQueries({ queryKey: queryKeys.services.allFor(projectId) })
  const run = <T,>(fn: (input: T) => Promise<unknown>) => ({
    mutationFn: async (input: T) => { const projectId = queryScope(); await fn(input); return projectId },
    onSuccess: (projectId: string) => refresh(projectId),
    // A refused start still changed the service's state (it is now `exited` with the reason).
    onError: (error: Error) => { toast(error.message, { tone: 'danger' }); void refresh(queryScope()) },
  })
  return {
    act: useMutation(run(({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) => serviceAction(id, action))),
    all: useMutation(run((action: 'start-all' | 'stop-all' | 'resume') => servicesAction(action))),
    pin: useMutation(run((input: { name: string; command: string; cwd: string }) => pinService(input))),
    unpin: useMutation(run((id: string) => unpinService(id))),
  }
}

export function ServiceRow({
  service, selected, onSelect, busy, onAct, onRemove,
}: {
  service: Service
  selected: boolean
  onSelect: () => void
  busy: boolean
  onAct: (action: 'start' | 'stop' | 'restart') => void
  onRemove?: () => void
}) {
  const running = service.status === 'running'
  const urls = service.urls.filter((entry) => entry.running !== false)
  return (
    <li
      data-slot="service-row"
      data-status={service.status}
      className={cn('flex items-start gap-3 px-4 py-3', selected && 'bg-accent/50')}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Button variant="ghost" onClick={onSelect} aria-pressed={selected} className="h-auto w-full flex-col items-start gap-0.5 p-0 text-left font-normal whitespace-normal hover:bg-transparent">
          <span className="flex w-full items-center gap-2">
            <StatusDot tone={serviceTone(service)} pulse={running} />
            <span className="truncate text-[13.5px] font-medium text-foreground">{service.name}</span>
          </span>
          <code className="block w-full truncate font-mono text-xs text-muted-foreground">
            {service.command}{service.cwd ? `  ·  ${service.cwd}` : ''}
          </code>
          <span className={cn('block text-xs text-pretty', serviceTone(service) === 'danger' ? 'text-danger' : 'text-muted-foreground')}>
            {serviceStateLabel(service)}
          </span>
        </Button>
        {urls.map((entry) => (
          <Button key={entry.url} variant="link" size="xs" asChild className="h-auto p-0 font-mono">
            <a href={entry.url} target="_blank" rel="noreferrer">{entry.url} <ExternalLinkIcon aria-hidden="true" /></a>
          </Button>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {running ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label={`Restart ${service.name}`} disabled={busy} onClick={() => onAct('restart')}>
              <RotateCwIcon aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Stop ${service.name}`} disabled={busy} onClick={() => onAct('stop')}>
              <SquareIcon aria-hidden="true" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="icon-sm" aria-label={`Start ${service.name}`} disabled={busy} onClick={() => onAct('start')}>
              <PlayIcon aria-hidden="true" />
            </Button>
            {onRemove ? (
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${service.name}`} disabled={busy} onClick={onRemove}>
                <Trash2Icon aria-hidden="true" />
              </Button>
            ) : null}
          </>
        )}
      </div>
    </li>
  )
}

function Candidates({ candidates, busy, onPin }: { candidates: ServiceCandidate[]; busy: boolean; onPin: (candidate: ServiceCandidate) => void }) {
  const [all, setAll] = useState(false)
  const primary = candidates.filter((candidate) => candidate.primary)
  const shown = all ? candidates : primary
  if (candidates.length === 0) return null
  return (
    <SidebarGroup data-slot="services-candidates">
      <SidebarGroupLabel>From this repository</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu aria-label="Suggested services">
          {shown.map((candidate) => (
            <SidebarMenuItem key={`${candidate.cwd}\n${candidate.command}`}>
              <SidebarMenuButton
                size="lg"
                className="h-auto py-1.5"
                title={candidate.detail ?? candidate.command}
                aria-label={`Pin ${candidate.name}`}
                disabled={busy || candidate.unavailable !== null}
                onClick={() => onPin(candidate)}
              >
                <PlusIcon aria-hidden="true" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] text-foreground">{candidate.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{candidate.command} · {candidate.source}</span>
                  {candidate.unavailable ? <span className="truncate text-[11px] text-danger">{candidate.unavailable}</span> : null}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        {candidates.length > primary.length ? (
          <Button variant="ghost" size="sm" className="mt-1 w-full justify-start" onClick={() => setAll((value) => !value)}>
            {all ? 'Show long-running scripts only' : `Show all scripts (${candidates.length})`}
          </Button>
        ) : null}
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function AddCommand({ busy, onAdd }: { busy: boolean; onAdd: (input: { name: string; command: string; cwd: string }) => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Add a command</SidebarGroupLabel>
      <SidebarGroupContent>
        <form
          className="flex flex-col gap-1.5 px-2"
          aria-label="Add a command"
          onSubmit={(event) => {
            event.preventDefault()
            if (command.trim() === '') return
            onAdd({ name: name.trim() || command.trim().split(/\s+/).slice(0, 2).join(' '), command: command.trim(), cwd: cwd.trim().replace(/^\/+|\/+$/g, '') })
            setName(''); setCommand(''); setCwd('')
          }}
        >
          <SidebarInput aria-label="Command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="stripe listen --forward-to …" spellCheck={false} autoComplete="off" className="font-mono text-xs" />
          <SidebarInput aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name (optional)" autoComplete="off" className="text-xs" />
          <SidebarInput aria-label="Directory" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Directory (repo root)" spellCheck={false} autoComplete="off" className="font-mono text-xs" />
          <Button type="submit" variant="outline" size="sm" disabled={busy || command.trim() === ''}>Add</Button>
        </form>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/**
 * `/p/:projectId/services` — the project's stack. What is pinned, what the repository suggests
 * and the form to add a command are this screen's LIST, so they live in the contextual sidebar;
 * the main area is the selected service and what it prints.
 */
export function ServicesRoute() {
  const state = useServices({ live: true })
  const { act, all, pin, unpin } = useServiceMutations()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const busy = act.isPending || all.isPending || pin.isPending || unpin.isPending

  const services = state.data?.services ?? []
  const selected = services.find((service) => service.id === selectedId) ?? services[0] ?? null
  const anyRunning = services.some((service) => service.status === 'running')
  const resumable = state.data?.lastRunning.length ?? 0
  const available = state.data?.available === true
  const running = selected?.status === 'running'
  const urls = selected?.urls.filter((entry) => entry.running !== false) ?? []

  return (
    <Page width="full" data-route="services" className="h-full">
      <ContextSidebar>
        <SidebarHeader data-slot="services-header" className="gap-3 p-3">
          <h2 className="px-1 text-[15px] font-semibold text-foreground">Services</h2>
          {available && services.length > 0 ? (
            <div className="flex gap-2">
              <Button size="sm" className="flex-1" disabled={busy || services.every((service) => service.status === 'running')} onClick={() => all.mutate('start-all')}>Start all</Button>
              <Button size="sm" variant="outline" className="flex-1" disabled={busy || !anyRunning} onClick={() => all.mutate('stop-all')}>Stop all</Button>
            </div>
          ) : null}
        </SidebarHeader>
        <SidebarContent>
          {state.isPending ? <p className="px-4 text-xs text-muted-foreground">Loading…</p> : null}
          {available ? (
            <>
              {resumable > 0 ? (
                <SidebarGroup data-slot="services-resume">
                  <SidebarGroupContent className="flex flex-col gap-2 px-2">
                    <p className="text-xs text-pretty text-foreground">
                      {resumable} {resumable === 1 ? 'service was' : 'services were'} running when cezar last stopped.
                    </p>
                    <Button size="sm" disabled={busy} onClick={() => all.mutate('resume')}>Resume</Button>
                  </SidebarGroupContent>
                </SidebarGroup>
              ) : null}
              <SidebarGroup>
                <SidebarGroupLabel className="justify-between">
                  Pinned
                  {services.length > 0 ? <span className="font-mono tabular-nums">{services.length}</span> : null}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  {services.length === 0 ? (
                    <p className="px-2 text-xs text-pretty text-muted-foreground">Nothing is pinned yet. Pin the commands you start every time you work on this project.</p>
                  ) : null}
                  <SidebarMenu aria-label="Pinned services">
                    {services.map((service) => {
                      const up = service.status === 'running'
                      return (
                        <SidebarMenuItem key={service.id} data-slot="service-row" data-status={service.status}>
                          <SidebarMenuButton size="lg" className="h-auto py-1.5" isActive={selected?.id === service.id} onClick={() => setSelectedId(service.id)}>
                            <StatusDot tone={serviceTone(service)} pulse={up} />
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-[13px] font-medium text-foreground">{service.name}</span>
                              <span className={cn('truncate text-[11px]', serviceTone(service) === 'danger' ? 'text-danger' : 'text-muted-foreground')}>{serviceStateLabel(service)}</span>
                            </span>
                          </SidebarMenuButton>
                          <SidebarMenuAction
                            aria-label={`${up ? 'Stop' : 'Start'} ${service.name}`}
                            title={up ? 'Stop' : 'Start'}
                            disabled={busy}
                            onClick={() => { setSelectedId(service.id); act.mutate({ id: service.id, action: up ? 'stop' : 'start' }) }}
                          >
                            {up ? <SquareIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
                          </SidebarMenuAction>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
              <Candidates candidates={state.data?.candidates ?? []} busy={busy} onPin={(candidate) => pin.mutate({ name: candidate.name, command: candidate.command, cwd: candidate.cwd })} />
              <AddCommand busy={busy} onAdd={(input) => pin.mutate(input)} />
            </>
          ) : null}
        </SidebarContent>
      </ContextSidebar>

      <PageBody className="flex min-h-0 flex-col gap-3 pt-4">
        {state.isError ? <p role="alert" className="text-sm text-danger">{state.error.message}</p> : null}
        {state.data && !state.data.available ? (
          <p role="note" data-slot="services-unavailable" className="text-sm text-pretty text-muted-foreground">
            {state.data.reason ?? 'Services are unavailable on this cockpit.'}
          </p>
        ) : null}
        {available && selected ? (
          <>
            <header data-slot="service-detail" className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <h1 className="flex items-center gap-2 text-[17px] font-semibold text-foreground">
                  <StatusDot tone={serviceTone(selected)} pulse={running} />
                  <span className="truncate">{selected.name}</span>
                </h1>
                <code className="block truncate font-mono text-xs text-muted-foreground">{selected.command}{selected.cwd ? `  ·  ${selected.cwd}` : ''}</code>
                <p className={cn('text-xs text-pretty', serviceTone(selected) === 'danger' ? 'text-danger' : 'text-muted-foreground')}>{serviceStateLabel(selected)}</p>
                {urls.map((entry) => (
                  <Button key={entry.url} variant="link" size="xs" asChild className="h-auto p-0 font-mono">
                    <a href={entry.url} target="_blank" rel="noreferrer">{entry.url} <ExternalLinkIcon aria-hidden="true" /></a>
                  </Button>
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {running ? (
                  <>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => act.mutate({ id: selected.id, action: 'restart' })}><RotateCwIcon aria-hidden="true" /> Restart</Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => act.mutate({ id: selected.id, action: 'stop' })}><SquareIcon aria-hidden="true" /> Stop</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => act.mutate({ id: selected.id, action: 'start' })}><PlayIcon aria-hidden="true" /> Start</Button>
                    <Button variant="outline" size="sm" aria-label={`Remove ${selected.name}`} disabled={busy} onClick={() => unpin.mutate(selected.id)}><Trash2Icon aria-hidden="true" /> Remove</Button>
                  </>
                )}
              </div>
            </header>
            <Card flush data-slot="service-log" className="relative min-h-[24rem] flex-1 overflow-hidden bg-card-2">
              {selected.status === 'stopped' && selected.startedAt === null ? (
                <p className="p-4 text-sm text-muted-foreground">{selected.name} has not been started.</p>
              ) : (
                <ServiceLog service={selected} />
              )}
            </Card>
          </>
        ) : null}
        {available && !selected ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyTitle>No services yet</EmptyTitle>
              <EmptyDescription>Pin a command from the list beside this, or add your own. Its output shows here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </PageBody>
    </Page>
  )
}
