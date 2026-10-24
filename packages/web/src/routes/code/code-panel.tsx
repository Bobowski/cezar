import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { queryScope, type TerminalSession } from '@open-mercato/cezar-api-client'
import { serviceAction } from '@/api/client'
import {
  createCodeTerminal, getCodeTerminal, getProjectTerminalHistory, readCodeTerminal, resizeCodeTerminal, stopCodeTerminal, treeKey,
  writeCodeTerminal, type CodeTree,
} from '@/api/code'
import { queryKeys } from '@/api/queries'
import { useServices } from '@/api/services'
import { DetectedUrlsStrip } from '@/components/terminal/detected-urls-strip'
import { DiscoveredCommandsStrip } from '@/components/terminal/discovered-commands'
import { terminalCommands, type TerminalScope } from '@/components/terminal/scope'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { ServiceLog, ServiceRow } from '@/routes/services/services'
import { TerminalPane, type TerminalCompletion, type TerminalIo } from '@/routes/task-workspace/terminal-pane'

import type { CodePanel } from './code-state'

/**
 * The Code page's bottom panel (spec 2026-10-11-code-page §3): a terminal in the checkout and
 * the project's services. Each tab mounts when first shown and stays mounted, so a build keeps
 * scrolling while the other is looked at. Search lives in the sidebar (`code-sidebar.tsx`).
 */
export function CodePanelView({
  tree, panel, onPanel, initialTerminal = null, paths = [], onOpenBrowser,
}: {
  tree: CodeTree
  panel: CodePanel
  onPanel: (panel: CodePanel | null) => void
  /** The session to show first — one Docker's Exec opened (spec 2026-10-23-docker-management §3.5). */
  initialTerminal?: string | null
  /** The checkout's paths, for path completion (spec 2026-10-24-code-page-terminal §3.3). */
  paths?: readonly string[]
  /** Opens an address in a Browser editor tab (spec 2026-10-24-code-page-terminal §3.1–§3.2). */
  onOpenBrowser?: (url: string) => void
}) {
  const [seen, setSeen] = useState<ReadonlySet<CodePanel>>(new Set([panel]))
  useEffect(() => setSeen((current) => (current.has(panel) ? current : new Set([...current, panel]))), [panel])
  // Services are the project's and run the main checkout: a task's tree has none of its own.
  const tabs: CodePanel[] = tree.kind === 'main' ? ['terminal', 'services'] : ['terminal']
  const shown = tabs.includes(panel) ? panel : 'terminal'
  return (
    <Tabs data-slot="code-panel" value={shown} onValueChange={(value) => onPanel(value as CodePanel)} className="h-full gap-0 bg-card-2">
      <div className="flex shrink-0 items-center border-b border-border px-2 py-1">
        <TabsList aria-label="Panel" className="h-7">
          {tabs.map((tab) => <TabsTrigger key={tab} value={tab} className="px-2.5 text-xs capitalize">{tab}</TabsTrigger>)}
        </TabsList>
        <IconTooltip label="Close panel">
          <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close panel" onClick={() => onPanel(null)}>
            <XIcon aria-hidden="true" />
          </Button>
        </IconTooltip>
      </div>
      {/* Mounted once shown and kept: a build keeps scrolling while the other tab is looked at. */}
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (seen.has(tab) ? (
          <TabsContent key={tab} value={tab} forceMount className="absolute inset-0 data-[state=inactive]:invisible data-[state=inactive]:pointer-events-none">
            {tab === 'terminal' ? (
              <TerminalTab tree={tree} active={shown === 'terminal'} initial={initialTerminal} paths={paths} onOpenBrowser={onOpenBrowser} />
            ) : <ServicesTab active={shown === 'services'} />}
          </TabsContent>
        ) : null))}
      </div>
    </Tabs>
  )
}

function TerminalTab({
  tree, active, initial, paths, onOpenBrowser,
}: {
  tree: CodeTree
  active: boolean
  initial: string | null
  paths: readonly string[]
  onOpenBrowser?: (url: string) => void
}) {
  const queryClient = useQueryClient()
  const key = ['code', 'terminal', queryScope(), treeKey(tree)] as const
  const state = useQuery({ queryKey: key, queryFn: () => getCodeTerminal(tree) })
  const scope = useMemo<TerminalScope>(() => (tree.kind === 'main' ? { kind: 'project' } : { kind: 'run', runId: tree.runId }), [tree])
  // The completion's sources (spec 2026-10-24-code-page-terminal §3.3): read once the terminal is
  // looked at, and the history again after each line the user submits.
  const available = state.data?.available === true
  const commands = useQuery({
    queryKey: ['code', 'terminal-commands', queryScope(), treeKey(tree)],
    queryFn: () => terminalCommands(scope),
    enabled: active && available,
    staleTime: 60_000,
  })
  const historyKey = ['code', 'terminal-history', queryScope()] as const
  const history = useQuery({ queryKey: historyKey, queryFn: getProjectTerminalHistory, enabled: active && available })
  const historyRefresh = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (historyRefresh.current) clearTimeout(historyRefresh.current) }, [])
  const completion = useMemo<TerminalCompletion>(() => ({
    commands: (commands.data?.commands ?? []).map((entry) => entry.command),
    history: history.data?.lines ?? [],
    paths,
    // The server decides whether a line is kept, once the shell had it; ask a moment later.
    onSubmitted: () => {
      if (historyRefresh.current) clearTimeout(historyRefresh.current)
      historyRefresh.current = setTimeout(() => void queryClient.invalidateQueries({ queryKey: historyKey }), 800)
    },
    // The process table's word on the shell (`busy`); `null`, a host that cannot say, is not a
    // prompt. `workdir` is where it is now, relative to where it opened — the tree's root.
    atPrompt: async (sessionId) => {
      const fresh = await queryClient.fetchQuery({ queryKey: key, queryFn: () => getCodeTerminal(tree), staleTime: 0 })
      const session = fresh.sessions.find((entry) => entry.id === sessionId)
      return { atPrompt: session?.busy === false, dir: session?.workdir }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [commands.data, history.data, paths, queryClient, tree])
  // A picked command runs in a NEW terminal (task-workspace spec §6), never the one in view.
  const runCommand = (command: string) => {
    void createCodeTerminal(tree, {})
      .then(async (session) => {
        setCurrent(session.id)
        await queryClient.invalidateQueries({ queryKey: key })
        await writeCodeTerminal(tree, session.id, `${command}\r`)
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
  }
  const [current, setCurrent] = useState<string | null>(initial)
  // A session handed in from outside is already open: no empty-panel shell on top of it.
  const opened = useRef(initial !== null)
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
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Nothing opens on its own: the strip lists, the user clicks (§3.1). */}
        {state.data ? <DetectedUrlsStrip scope={scope} onOpen={onOpenBrowser} /> : null}
        <div className="relative min-h-0 flex-1">
          {sessions.map((session) => (
            <CheckoutTerminal
              key={session.id}
              tree={tree}
              session={session}
              active={active && shown?.id === session.id}
              completion={completion}
              onOpenBrowser={onOpenBrowser}
            />
          ))}
        </div>
      </div>
      <ul aria-label="Terminals" className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-l border-border p-1">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={shown?.id === session.id}
              title={session.label}
              className={cn('min-w-0 flex-1 justify-start', shown?.id === session.id && 'bg-accent text-foreground')}
              onClick={() => setCurrent(session.id)}
            >
              <span className="truncate">{session.label}</span>
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label={`Close ${session.label}`} onClick={() => close.mutate(session.id)}><XIcon aria-hidden="true" /></Button>
          </li>
        ))}
        <li>
          <Button variant="ghost" size="xs" className="w-full justify-start" disabled={open.isPending} onClick={() => open.mutate()}>
            <PlusIcon aria-hidden="true" /> New terminal
          </Button>
        </li>
        <li>
          <DiscoveredCommandsStrip scope={scope} onRun={runCommand} />
        </li>
      </ul>
    </div>
  )
}

function CheckoutTerminal({
  tree, session, active, completion, onOpenBrowser,
}: {
  tree: CodeTree
  session: TerminalSession
  active: boolean
  completion: TerminalCompletion
  onOpenBrowser?: (url: string) => void
}) {
  const io = useMemo<TerminalIo>(() => ({
    read: (cursor) => readCodeTerminal(tree, session.id, cursor),
    write: (data) => writeCodeTerminal(tree, session.id, data),
    resize: (cols, rows) => resizeCodeTerminal(tree, session.id, cols, rows),
  }), [tree, session.id])
  return <TerminalPane runId="" io={io} session={session} active={active} completion={completion} onOpenBrowser={onOpenBrowser} />
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
