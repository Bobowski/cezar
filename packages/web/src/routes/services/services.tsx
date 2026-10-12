import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, PlayIcon, PlusIcon, RotateCwIcon, SquareIcon, Trash2Icon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { queryScope, type Service, type ServiceCandidate } from '@open-mercato/cezar-api-client'
import {
  pinService, readServiceOutput, resizeService, serviceAction, servicesAction, unpinService, writeServiceInput,
} from '@/api/client'
import { queryKeys } from '@/api/queries'
import { useServices } from '@/api/services'
import { Page, PageBody, PageHeader } from '@/components/page'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
    <section className="flex flex-col gap-2" aria-label="Suggested services">
      <h2 className="text-[13px] font-semibold text-foreground">From this repository</h2>
      {shown.length > 0 ? (
        <Card flush>
          <ul className="divide-y divide-border">
            {shown.map((candidate) => (
              <li key={`${candidate.cwd}\n${candidate.command}`} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate text-[13px] text-foreground">{candidate.name}</span>
                  <code className="block truncate font-mono text-xs text-muted-foreground" title={candidate.detail ?? undefined}>
                    {candidate.command}  ·  {candidate.source}
                  </code>
                  {candidate.unavailable ? <span className="block text-xs text-danger">{candidate.unavailable}</span> : null}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Pin ${candidate.name}`}
                  disabled={busy || candidate.unavailable !== null}
                  onClick={() => onPin(candidate)}
                >
                  <PlusIcon aria-hidden="true" /> Pin
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {candidates.length > primary.length ? (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll((value) => !value)}>
          {all ? 'Show long-running scripts only' : `Show all scripts (${candidates.length})`}
        </Button>
      ) : null}
    </section>
  )
}

function AddCommand({ busy, onAdd }: { busy: boolean; onAdd: (input: { name: string; command: string; cwd: string }) => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  return (
    <form
      className="flex flex-col gap-2"
      aria-label="Add a command"
      onSubmit={(event) => {
        event.preventDefault()
        if (command.trim() === '') return
        onAdd({ name: name.trim() || command.trim().split(/\s+/).slice(0, 2).join(' '), command: command.trim(), cwd: cwd.trim().replace(/^\/+|\/+$/g, '') })
        setName(''); setCommand(''); setCwd('')
      }}
    >
      <h2 className="text-[13px] font-semibold text-foreground">Add a command</h2>
      <Input aria-label="Command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="stripe listen --forward-to localhost:9000/hooks" spellCheck={false} autoComplete="off" className="font-mono" />
      <div className="flex gap-2">
        <Input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name (optional)" autoComplete="off" />
        <Input aria-label="Directory" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Directory (repo root)" spellCheck={false} autoComplete="off" className="font-mono" />
        <Button type="submit" variant="outline" disabled={busy || command.trim() === ''}>Add</Button>
      </div>
    </form>
  )
}

/** `/p/:projectId/services` — the project's stack: what is pinned, what runs, what it prints. */
export function ServicesRoute() {
  const state = useServices({ live: true })
  const { act, all, pin, unpin } = useServiceMutations()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const busy = act.isPending || all.isPending || pin.isPending || unpin.isPending

  const services = state.data?.services ?? []
  const selected = services.find((service) => service.id === selectedId) ?? services[0] ?? null
  const anyRunning = services.some((service) => service.status === 'running')
  const resumable = state.data?.lastRunning.length ?? 0

  return (
    <Page width="wide" data-route="services">
      <PageHeader
        title="Services"
        description="The long-running commands that make up this project’s stack. They run the main checkout’s code and stop when cezar does."
        actions={services.length > 0 ? (
          <>
            <Button variant="outline" disabled={busy || !anyRunning} onClick={() => all.mutate('stop-all')}>Stop all</Button>
            <Button disabled={busy || services.every((service) => service.status === 'running')} onClick={() => all.mutate('start-all')}>Start all</Button>
          </>
        ) : undefined}
      />
      <PageBody className="flex flex-col gap-6">
        {state.isPending ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {state.isError ? <p role="alert" className="text-sm text-danger">{state.error.message}</p> : null}
        {state.data && !state.data.available ? (
          <p role="note" data-slot="services-unavailable" className="text-sm text-pretty text-muted-foreground">
            {state.data.reason ?? 'Services are unavailable on this cockpit.'}
          </p>
        ) : null}
        {state.data?.available ? (
          <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-6">
              {resumable > 0 ? (
                <Card data-slot="services-resume" className="flex flex-row items-center justify-between gap-3 px-4 py-3">
                  <span className="text-[13px] text-foreground">
                    {resumable} {resumable === 1 ? 'service was' : 'services were'} running when cezar last stopped.
                  </span>
                  <Button size="sm" disabled={busy} onClick={() => all.mutate('resume')}>Resume</Button>
                </Card>
              ) : null}
              {services.length > 0 ? (
                <Card flush>
                  <ul className="divide-y divide-border" aria-label="Pinned services">
                    {services.map((service) => (
                      <ServiceRow
                        key={service.id}
                        service={service}
                        selected={selected?.id === service.id}
                        onSelect={() => setSelectedId(service.id)}
                        busy={busy}
                        onAct={(action) => { setSelectedId(service.id); act.mutate({ id: service.id, action }) }}
                        onRemove={() => unpin.mutate(service.id)}
                      />
                    ))}
                  </ul>
                </Card>
              ) : (
                <p className="text-sm text-pretty text-muted-foreground">
                  Nothing is pinned yet. Pin the commands you start every time you work on this project.
                </p>
              )}
              <Candidates
                candidates={state.data.candidates}
                busy={busy}
                onPin={(candidate) => pin.mutate({ name: candidate.name, command: candidate.command, cwd: candidate.cwd })}
              />
              <AddCommand busy={busy} onAdd={(input) => pin.mutate(input)} />
            </div>
            <Card flush data-slot="service-log" className="relative min-h-[26rem] overflow-hidden bg-card-2 lg:min-h-[32rem]">
              {selected ? (
                selected.status === 'stopped' && selected.startedAt === null ? (
                  <p className="p-4 text-sm text-muted-foreground">{selected.name} has not been started.</p>
                ) : (
                  <ServiceLog service={selected} />
                )
              ) : (
                <p className="p-4 text-sm text-muted-foreground">Select a service to see its output.</p>
              )}
            </Card>
          </div>
        ) : null}
      </PageBody>
    </Page>
  )
}
