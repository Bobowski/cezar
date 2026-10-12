import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { queryScope, type TerminalSession } from '@open-mercato/cezar-api-client'
import { serviceAction } from '@/api/client'
import {
  createCodeTerminal, getCodeTerminal, readCodeTerminal, resizeCodeTerminal, stopCodeTerminal, treeKey, writeCodeTerminal,
  type CodeTree,
} from '@/api/code'
import { queryKeys } from '@/api/queries'
import { useServices } from '@/api/services'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { ServiceLog, ServiceRow } from '@/routes/services/services'
import { TerminalPane, type TerminalIo } from '@/routes/task-workspace/terminal-pane'

import type { CodePanel } from './code-state'

/**
 * The Code page's bottom panel (spec 2026-10-11-code-page §3): a terminal in the checkout and
 * the project's services. Each tab mounts when first shown and stays mounted, so a build keeps
 * scrolling while the other is looked at. Search lives in the sidebar (`code-sidebar.tsx`).
 */
export function CodePanelView({
  tree, panel, onPanel,
}: {
  tree: CodeTree
  panel: CodePanel
  onPanel: (panel: CodePanel | null) => void
}) {
  const [seen, setSeen] = useState<ReadonlySet<CodePanel>>(new Set([panel]))
  useEffect(() => setSeen((current) => (current.has(panel) ? current : new Set([...current, panel]))), [panel])
  // Services are the project's and run the main checkout: a task's tree has none of its own.
  const tabs: CodePanel[] = tree.kind === 'main' ? ['terminal', 'services'] : ['terminal']
  const shown = tabs.includes(panel) ? panel : 'terminal'
  return (
    <section data-slot="code-panel" className="flex h-72 shrink-0 flex-col border-t border-border bg-card-2">
      <div role="tablist" aria-label="Panel" className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        {tabs.map((tab) => (
          <button
            key={tab}
            role="tab"
            type="button"
            aria-selected={shown === tab}
            onClick={() => onPanel(tab)}
            className={cn('rounded-md px-2.5 py-1 text-xs capitalize', shown === tab ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {tab}
          </button>
        ))}
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close panel" onClick={() => onPanel(null)}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {seen.has('terminal') && tabs.includes('terminal') ? <Layer active={shown === 'terminal'}><TerminalTab tree={tree} active={shown === 'terminal'} /></Layer> : null}
        {seen.has('services') && tabs.includes('services') ? <Layer active={shown === 'services'}><ServicesTab active={shown === 'services'} /></Layer> : null}
      </div>
    </section>
  )
}

function Layer({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div className={cn('absolute inset-0', active ? 'visible' : 'invisible pointer-events-none')}>{children}</div>
}

function TerminalTab({ tree, active }: { tree: CodeTree; active: boolean }) {
  const queryClient = useQueryClient()
  const key = ['code', 'terminal', queryScope(), treeKey(tree)] as const
  const state = useQuery({ queryKey: key, queryFn: () => getCodeTerminal(tree) })
  const [current, setCurrent] = useState<string | null>(null)
  const opened = useRef(false)
  const open = useMutation({
    mutationFn: () => createCodeTerminal(tree, {}),
    onSuccess: async (session) => { setCurrent(session.id); await queryClient.invalidateQueries({ queryKey: key }) },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const close = useMutation({
    mutationFn: (sessionId: string) => stopCodeTerminal(tree, sessionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })
  const sessions = state.data?.sessions ?? []
  // The first look at an empty panel opens a shell — a terminal tab with nothing in it is a click
  // the user has to make every time.
  useEffect(() => {
    if (!active || opened.current || !state.data?.available || sessions.length > 0) return
    opened.current = true
    open.mutate()
  }, [active, open, sessions.length, state.data?.available])
  const shown = sessions.find((session) => session.id === current) ?? sessions[0] ?? null

  if (state.data && !state.data.available) {
    return <p className="p-3 text-xs text-pretty text-muted-foreground">{state.data.reason ?? 'The terminal is unavailable here.'}</p>
  }
  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        {sessions.map((session) => <CheckoutTerminal key={session.id} tree={tree} session={session} active={active && shown?.id === session.id} />)}
      </div>
      <ul aria-label="Terminals" className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-l border-border p-1 text-xs">
        {sessions.map((session) => (
          <li key={session.id} className={cn('flex items-center gap-1 rounded-md px-1.5 py-1', shown?.id === session.id ? 'bg-accent text-foreground' : 'text-muted-foreground')}>
            <button type="button" className="min-w-0 flex-1 truncate text-left" title={session.label} onClick={() => setCurrent(session.id)}>{session.label}</button>
            <button type="button" aria-label={`Close ${session.label}`} onClick={() => close.mutate(session.id)}><XIcon aria-hidden="true" className="size-3" /></button>
          </li>
        ))}
        <li>
          <Button variant="ghost" size="xs" className="w-full justify-start" disabled={open.isPending} onClick={() => open.mutate()}>
            <PlusIcon aria-hidden="true" /> New terminal
          </Button>
        </li>
      </ul>
    </div>
  )
}

function CheckoutTerminal({ tree, session, active }: { tree: CodeTree; session: TerminalSession; active: boolean }) {
  const io = useMemo<TerminalIo>(() => ({
    read: (cursor) => readCodeTerminal(tree, session.id, cursor),
    write: (data) => writeCodeTerminal(tree, session.id, data),
    resize: (cols, rows) => resizeCodeTerminal(tree, session.id, cols, rows),
  }), [tree, session.id])
  return <TerminalPane runId="" io={io} session={session} active={active} />
}

function ServicesTab({ active }: { active: boolean }) {
  const queryClient = useQueryClient()
  const state = useServices({ live: active })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) => { const projectId = queryScope(); await serviceAction(id, action); return projectId },
    onSuccess: (projectId) => queryClient.invalidateQueries({ queryKey: queryKeys.services.allFor(projectId) }),
    onError: (error: Error) => { toast(error.message, { tone: 'danger' }); void queryClient.invalidateQueries({ queryKey: queryKeys.services.allFor(queryScope()) }) },
  })
  const services = state.data?.services ?? []
  const selected = services.find((service) => service.id === selectedId) ?? services.find((service) => service.status === 'running') ?? services[0] ?? null
  if (state.data && !state.data.available) return <p className="p-3 text-xs text-muted-foreground">{state.data.reason}</p>
  if (state.data && services.length === 0) {
    return <p className="p-3 text-xs text-pretty text-muted-foreground">No services are pinned. Pin the project’s commands on the Services page.</p>
  }
  return (
    <div className="flex h-full min-h-0">
      <ul aria-label="Pinned services" className="w-72 shrink-0 divide-y divide-border overflow-y-auto border-r border-border">
        {services.map((service) => (
          <ServiceRow
            key={service.id}
            service={service}
            selected={selected?.id === service.id}
            onSelect={() => setSelectedId(service.id)}
            busy={act.isPending}
            onAct={(action) => { setSelectedId(service.id); act.mutate({ id: service.id, action }) }}
          />
        ))}
      </ul>
      <div className="relative min-w-0 flex-1">
        {selected && (selected.status !== 'stopped' || selected.startedAt !== null) ? <ServiceLog service={selected} active={active} /> : null}
      </div>
    </div>
  )
}
