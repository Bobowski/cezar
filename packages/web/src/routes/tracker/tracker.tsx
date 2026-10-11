import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, ArrowLeftIcon, CheckIcon, Columns3Icon, ExternalLinkIcon, ListIcon, MoreHorizontalIcon, PlayIcon, RefreshCwIcon, SettingsIcon, TicketIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'

import type { TrackerAssociation, TrackerItem } from '@open-mercato/cezar-api-client'
import { IssueBrowserEmpty } from '@/components/issue-browser-layout'
import { Page } from '@/components/page'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'
import { TRACKER_PROVIDERS } from '@/lib/tracker-providers'
import { useTrackerWatch } from '@/api/tracker-watch'
import { useProjectScope } from '@/api/project-scope-context'
import { queryKeys, TrackerRefreshError, useSkills, useTrackerConnection, useTrackerAssociation, useTrackerItem, useTrackerItems, useWorkflows } from '@/api/queries'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useSidebar } from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { groupByStatus } from '@/lib/tracker-groups'
import { trackerLosses } from '@/lib/tracker-task'
import { Markdown } from '../task-thread/markdown'
import { TrackerHandoff, type TrackerHandoffSelection, type TrackerDraftCache } from './tracker-handoff'
import { TrackerLabelFilter } from './tracker-label-filter'
import { LabelChip, TrackerBoard, TrackerList, TrackerStatusIcon } from './tracker-surface'

export { trackerDetailReadyForDrag } from './tracker-surface'

const emptySelection = (): TrackerHandoffSelection => ({ workflow: null, selectedSkills: [], engine: { runner: null, model: null, account: null } })

export function TrackerRoute() {
  const { id } = useParams()
  const { projectId } = useProjectScope()
  const association = useTrackerAssociation()
  const connection = useTrackerConnection()
  const associationKey = `${projectId ?? 'default'}:${association.data?.association ? trackerAssociationKey(association.data.association) : 'none'}`
  // Retain drafts across connection request failures, but never across project/source changes.
  const drafts = useMemo<TrackerDraftCache>(() => new Map(), [associationKey])
  const [savedSelection, setSavedSelection] = useState<{ key: string; value: TrackerHandoffSelection } | null>(null)
  const selection = savedSelection?.key === associationKey ? savedSelection.value : emptySelection()
  const setSelection: React.Dispatch<React.SetStateAction<TrackerHandoffSelection>> = update => setSavedSelection(previous => {
    const current = previous?.key === associationKey ? previous.value : emptySelection()
    return { key: associationKey, value: typeof update === 'function' ? update(current) : update }
  })
  if (association.isPending) return <TrackerFrame><PageState text="Loading tracker…" loading /></TrackerFrame>
  if (association.isError) return <TrackerFrame>
    <IssueBrowserEmpty
      icon={<AlertTriangleIcon />}
      tone="danger"
      title="Could not load the tracker"
      description={association.error.message}
      actions={<Button asChild variant="outline"><Link to="/settings/tracker">Open tracker settings</Link></Button>}
    />
  </TrackerFrame>
  if (!association.data.association) return <SetupState />
  // Connection-bound scopes survive disconnect so Settings can display their selection.
  // They must not mount a browser/watch without the corresponding credentials.
  if (association.data.association.connectionId) {
    if (connection.isPending) return <TrackerFrame><PageState text="Loading tracker…" loading /></TrackerFrame>
    if (connection.isError) return <TrackerFrame role="alert">
      <IssueBrowserEmpty
        icon={<AlertTriangleIcon />}
        tone="danger"
        title="Could not verify the tracker connection."
        description="The connection check did not answer. Your tracker settings are unchanged."
        actions={<Button variant="outline" onClick={() => void connection.refetch()}><RefreshCwIcon aria-hidden="true" />Retry connection</Button>}
      />
    </TrackerFrame>
    if (!connection.data.demo && (
      connection.data.connection?.id !== association.data.association.connectionId
      || connection.data.connection?.kind !== association.data.association.kind
    )) return <SetupState />
  }
  return <TrackerBrowse scopePending={association.isFetching || (!!association.data.association.connectionId && connection.isFetching)} key={associationKey} association={association.data.association} selectedId={id} drafts={drafts} selection={selection} setSelection={setSelection} />
}

function trackerAssociationKey(association: TrackerAssociation): string {
  return `${association.kind}:${association.source.id}:${association.source.webUrl}:${association.externalId}:${association.connectionId ?? 'legacy'}`
}

/** A tracker screen with no list to show: one centred state. */
function TrackerFrame({ children, ...props }: React.ComponentProps<typeof Page>) {
  return <Page width="full" data-route="tracker" {...props}>{children}</Page>
}

function SetupState() {
  return <TrackerFrame>
    <IssueBrowserEmpty
      slot="tracker-setup"
      icon={<TicketIcon />}
      title="Connect an issue tracker"
      description="Choose a project or team from your issue tracker in project settings. Its issues then show up here, ready to hand to an agent."
      actions={<Button asChild variant="primary"><Link to="/settings/tracker"><SettingsIcon aria-hidden="true" />Open tracker settings</Link></Button>}
    />
  </TrackerFrame>
}

type TrackerView = 'list' | 'board'
const VIEW_STORAGE_KEY = 'cezar.tracker.view'

/** List or board: a per-viewer convenience, remembered in this browser and never required. */
function useTrackerView(): [TrackerView, (next: TrackerView) => void] {
  const [view, setView] = useState<TrackerView>(() => {
    try { return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'board' ? 'board' : 'list' } catch { return 'list' }
  })
  return [view, (next) => {
    setView(next)
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, next) } catch { /* private mode: keep it for this visit */ }
  }]
}

function TrackerBrowse({ scopePending, association, selectedId, drafts, selection, setSelection }: { scopePending: boolean; association: TrackerAssociation; selectedId?: string; drafts: TrackerDraftCache; selection: TrackerHandoffSelection; setSelection: React.Dispatch<React.SetStateAction<TrackerHandoffSelection>> }) {
  const queryClient = useQueryClient()
  // Desktop keeps the issue surface beside the open issue; a phone shows one pane at a time, so
  // a phone reading an issue holds no list demand.
  const { isMobile } = useSidebar()
  const detailId = selectedId ?? null
  const listVisible = !isMobile || detailId === null
  const [view, setView] = useTrackerView()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<'active' | 'all'>('active')
  const [stateExplicit, setStateExplicit] = useState(false)
  const [labels, setLabels] = useState<string[]>([])
  const result = useTrackerItems(association, { state, labels, query }, listVisible)
  const watch = useTrackerWatch({ association, state, labels, query }, result.queryKey, listVisible)
  const pages = result.data?.pages ?? []
  const failure = pages.find((page) => !page.available)
  const items = useMemo(() => pages.flatMap((page) => page.available ? page.items : []), [pages])
  const groups = useMemo(() => groupByStatus(items), [items])

  const provider = TRACKER_PROVIDERS[association.kind].label
  // Mirrors GitHub's refresh (`github.tsx`'s `openThreadRef` cascade): a manual refresh must also
  // reach the item on screen, not just the list — otherwise "refresh" is theatre for whoever is
  // currently reading an issue. The detail query always revalidates the vendor server-side
  // (`withSource(..., true, ...)` in jira.ts/linear.ts's `getItem`), so invalidating is enough.
  const refresh = async () => {
    await (watch.ready ? watch.refresh() : result.restart())
    if (detailId) void queryClient.invalidateQueries({ queryKey: queryKeys.tracker.detail(association, detailId) })
  }
  const busy = watch.checking || result.isFetching
  const syncedLabel = watch.checkedAt ? `Synced ${shortAge(watch.checkedAt)} ago` : null
  // Loaded, not total: the surface shows the pages fetched so far, never the vendor's backlog.
  const countLabel = `${items.length}${result.hasNextPage ? '+' : ''} loaded`
  const toggleGroup = (statusId: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (!next.delete(statusId)) next.add(statusId)
    return next
  })

  const toolbar = <header data-slot="tracker-header" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
    <div className="mr-auto min-w-0">
      <h1 className="text-[15px] leading-5 font-semibold text-foreground">{provider}</h1>
      <p className="truncate text-xs text-muted-foreground tabular-nums" title={association.externalName}>{association.externalName} · {countLabel}</p>
    </div>
    <ToggleGroup type="single" variant="outline" size="sm" spacing={0} aria-label="View" value={view} onValueChange={(next) => { if (next === 'list' || next === 'board') setView(next) }}>
      <ToggleGroupItem value="list" aria-label="List view"><ListIcon aria-hidden="true" />List</ToggleGroupItem>
      <ToggleGroupItem value="board" aria-label="Board view"><Columns3Icon aria-hidden="true" />Board</ToggleGroupItem>
    </ToggleGroup>
    <Tabs value={state} onValueChange={(next) => { setState(next === 'all' ? 'all' : 'active'); setStateExplicit(true) }}>
      <TabsList aria-label="Issue state">
        <TabsTrigger value="active">Active</TabsTrigger>
        <TabsTrigger value="all">All states</TabsTrigger>
      </TabsList>
    </Tabs>
    <form className="flex min-w-0 items-center gap-1.5" onSubmit={(event) => {
      event.preventDefault()
      const next = queryDraft.trim()
      const nextState = stateExplicit ? state : next ? 'all' : 'active'
      if (next === query && nextState === state) void refresh()
      else { setQuery(next); setState(nextState) }
    }}>
      <Input type="search" aria-label="Search tracker" title="Press Enter to search" maxLength={256} value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="Search issues…" className="h-8 w-56 min-w-0" />
      <Button type="submit" className="sr-only h-px p-0" disabled={result.isFetching}>Search</Button>
      <TrackerLabelFilter options={items.flatMap(item => item.labels)} selected={labels} onChange={setLabels} />
    </form>
    <div className="flex items-center">
      <Button variant="ghost" size="icon-sm" aria-label="Refresh" title={syncedLabel ? `${syncedLabel} — refresh from ${provider}` : `Refresh from ${provider}`} disabled={busy} onClick={() => void refresh()}>
        <RefreshCwIcon aria-hidden="true" className={cn(busy && 'motion-safe:animate-spin')} />
      </Button>
      <Button asChild variant="ghost" size="icon-sm">
        <Link to="/settings/tracker" aria-label="Connection settings" title="Connection settings"><SettingsIcon aria-hidden="true" /></Link>
      </Button>
    </div>
  </header>

  const notices = <>
    {watch.error ? <p role="status" className="px-4 py-2 text-[13px] text-danger">{watch.error} The displayed list may be outdated.</p> : null}
    {watch.hasChanges ? <div className="m-3 flex flex-wrap items-center gap-3 rounded-lg bg-muted/60 px-3 py-2.5 text-[13px]"><p className="text-pretty">New changes are available. Your loaded pages have been preserved.</p><Button size="sm" variant="outline" onClick={() => void watch.applyChanges()}>Show changes</Button></div> : null}
    {result.isPending && listVisible ? <PageState text="Loading issues…" loading /> : null}
    {result.isError ? <div className="px-4"><Failure reason={result.error.message} generation={result.errorUpdatedAt} retryAfterSeconds={result.error instanceof TrackerRefreshError && result.error.failure.code === 'rate_limited' ? result.error.failure.retryAfterSeconds : undefined} retry={() => void result.restart()} /></div> : null}
    {failure && !failure.available ? <div className="px-4"><Failure reason={failure.reason} generation={result.dataUpdatedAt} retryAfterSeconds={failure.code === 'rate_limited' ? failure.retryAfterSeconds : undefined} retry={() => void result.restart()} /></div> : null}
    {!result.isPending && !result.isError && !failure && items.length === 0 ? <PageState text={query.trim() ? 'No issues match this search.' : 'No issues in this view.'} /> : null}
  </>
  const loadMore = result.hasNextPage
    ? <div className="shrink-0 p-3"><Button className="w-full" variant="outline" size="sm" onClick={() => void result.fetchNextPage()} disabled={result.isFetchingNextPage}>Load more</Button></div>
    : null
  const surfaceProps = { groups, association, scopePending, activeId: detailId }

  return <Page width="full" data-route="tracker" className="h-full">
    {listVisible ? toolbar : null}
    <div className="flex min-h-0 flex-1">
      {listVisible ? <section data-slot="tracker-list" aria-label="Issues" className={cn('flex min-h-0 min-w-0 flex-1 flex-col', view === 'list' && 'overflow-y-auto')}>
        {notices}
        {view === 'board'
          ? <TrackerBoard {...surfaceProps} />
          : <TrackerList {...surfaceProps} collapsed={collapsed} onToggle={toggleGroup} compact={detailId !== null} />}
        {loadMore}
      </section> : null}
      {detailId ? <aside data-slot="tracker-panel" aria-label="Issue" className={cn('@container min-h-0 min-w-0 overflow-y-auto bg-background', isMobile ? 'flex-1' : 'w-[min(64rem,66%)] shrink-0 border-l border-border')}>
        <TrackerDetail scopePending={scopePending} key={`${trackerAssociationKey(association)}:${detailId}`} association={association} id={detailId} drafts={drafts} selection={selection} onSelectionChange={setSelection} />
      </aside> : null}
    </div>
  </Page>
}

function TrackerDetail({ scopePending, association, id, selection, onSelectionChange, drafts }: { scopePending: boolean; drafts: TrackerDraftCache; association: TrackerAssociation; id: string; selection: TrackerHandoffSelection; onSelectionChange: React.Dispatch<React.SetStateAction<TrackerHandoffSelection>> }) {
  const detail = useTrackerItem(association, id)
  const workflows = useWorkflows()
  const skills = useSkills()
  const [lastItem, setLastItem] = useState<TrackerItem | null>(null)
  useEffect(() => {
    if (detail.data?.available) setLastItem(detail.data.item)
  }, [detail.data])
  const [queuedRunId, setQueuedRunId] = useState<string | null>(null)
  const failure = detail.isError
    ? <Failure reason={detail.error.message} generation={detail.errorUpdatedAt} retry={() => void detail.refetch()} />
    : detail.data && !detail.data.available
      ? <Failure reason={detail.data.reason} generation={detail.dataUpdatedAt} retryAfterSeconds={detail.data.code === 'rate_limited' ? detail.data.retryAfterSeconds : undefined} retry={() => void detail.refetch()} />
      : null
  // Keep the composer's context through a failed refresh; retained context is never launchable.
  const item = detail.data?.available ? detail.data.item : lastItem
  if (!item) return <div className="px-4 pt-4 md:px-6"><DetailNav />{detail.isPending ? <PageState text="Loading full issue detail…" loading /> : failure}</div>
  const providerLabel = TRACKER_PROVIDERS[association.kind].label
  const losses = trackerLosses(item)
  // The composer sits in the panel, not behind a dialog: this only brings it into view.
  const focusComposer = () => {
    const instruction = document.getElementById('tracker-instruction')
    instruction?.scrollIntoView?.({ block: 'center' })
    instruction?.focus({ preventScroll: true })
  }
  return (
    <article data-slot="tracker-detail-inner" className="min-w-0 px-4 pt-4 pb-12 md:px-6">
      <DetailNav />
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <Badge variant="secondary" className="gap-1.5 font-medium"><TrackerStatusIcon category={item.statusCategory} className="size-3.5" />{item.status}</Badge>
            <span>Issue <span className="tabular-nums">{item.id}</span></span>
          </div>
          <h1 className="text-[20px] leading-7 font-semibold text-pretty">{item.title}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {queuedRunId ? (
            <Button asChild variant="outline">
              <Link to={`/tasks/${queuedRunId}`}><CheckIcon aria-hidden="true" className="text-success" />Queued — view task</Link>
            </Button>
          ) : null}
          <Button variant="outline" data-action="tracker-hand-open" onClick={focusComposer}>
            <PlayIcon aria-hidden="true" />
            Hand to agent
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions for this issue"><MoreHorizontalIcon aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem asChild>
                <a href={item.url} target="_blank" rel="noopener noreferrer"><ExternalLinkIcon aria-hidden="true" />Open on {providerLabel}</a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void detail.refetch()}><RefreshCwIcon aria-hidden="true" />Refresh issue</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(item.url).then(() => toast('Link copied'))}>Copy link</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {/* One column in a narrow panel; description beside properties and the composer in a wide one. */}
      <div className="mt-5 grid gap-x-8 gap-y-6 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:items-start">
        <div className="min-w-0">
          {failure}
          {losses.length ? (
            <Alert className="mb-5">
              <AlertTriangleIcon className="text-pending-strong" />
              <AlertTitle>This snapshot is incomplete.</AlertTitle>
              <AlertDescription>Review the limitations in the handoff panel.</AlertDescription>
            </Alert>
          ) : null}
          <section data-slot="tracker-body" className="text-sm leading-relaxed"><Markdown>{item.body.trim() || '*No description was provided.*'}</Markdown></section>
        </div>
        <div className="flex min-w-0 flex-col gap-6 border-t border-border pt-6 @3xl:sticky @3xl:top-4 @3xl:border-t-0 @3xl:pt-0">
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{item.status}</dd>
            <dt className="text-muted-foreground">Author</dt>
            <dd>{item.author}</dd>
            <dt className="text-muted-foreground">Opened</dt>
            <dd title={new Date(item.createdAt).toLocaleString()}>{shortAge(item.createdAt)} ago</dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd title={new Date(item.updatedAt).toLocaleString()}>{shortAge(item.updatedAt)} ago</dd>
            {item.labels.length > 0 ? <>
              <dt className="text-muted-foreground">Labels</dt>
              <dd className="flex flex-wrap gap-1">{item.labels.map(label => <LabelChip key={label} label={label} />)}</dd>
            </> : null}
          </dl>
          <section aria-labelledby="tracker-hand-title" className="border-t border-border pt-5">
            <h2 id="tracker-hand-title" className="mb-3 text-[13px] font-semibold">Hand to agent</h2>
            <TrackerHandoff scopePending={scopePending} key={`${trackerAssociationKey(association)}:${item.id}`} item={item} detailUnavailable={detail.isError || !detail.data?.available} drafts={drafts} selection={selection} onSelectionChange={onSelectionChange} workflows={workflows.data?.workflows ?? []} skills={skills.data ?? []} onQueued={setQueuedRunId} />
          </section>
        </div>
      </div>
    </article>
  )
}

function Failure({ reason, retry, retryAfterSeconds = 0, generation }: { reason: string; retry: () => void; retryAfterSeconds?: number; generation: number }) {
  const [cooldown, setCooldown] = useState(retryAfterSeconds)
  useEffect(() => setCooldown(retryAfterSeconds), [reason, retryAfterSeconds, generation])
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1_000)
    return () => window.clearInterval(timer)
  }, [cooldown > 0])
  return <Alert variant="destructive" className="mt-5">
    <AlertTriangleIcon />
    <AlertTitle>{reason}</AlertTitle>
    <AlertDescription>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={cooldown > 0} onClick={retry}><RefreshCwIcon aria-hidden="true" />{cooldown > 0 ? `Retry in ${cooldown}s` : 'Retry'}</Button>
        <Button asChild variant="ghost" size="sm"><Link to="/settings/tracker">Tracker settings</Link></Button>
      </div>
    </AlertDescription>
  </Alert>
}

function PageState({ text, danger = false, loading = false }: { text: string; danger?: boolean; loading?: boolean }) {
  return <div className={cn('flex items-center justify-center gap-2 p-8 text-center text-[13px]', danger ? 'text-danger' : 'text-muted-foreground')}>{loading ? <Spinner /> : null}{text}</div>
}

/** Leaves the open issue: "back to the list" on a phone, a close button beside the surface. */
function DetailNav() {
  return <div className="mb-3 flex items-center">
    <Button asChild variant="ghost" size="sm" className="-ml-2.5 md:hidden"><Link to="/tracker"><ArrowLeftIcon aria-hidden="true" />Back to the list</Link></Button>
    <Button asChild variant="ghost" size="icon-sm" className="ml-auto hidden md:inline-flex"><Link to="/tracker" aria-label="Close issue" title="Close issue"><XIcon aria-hidden="true" /></Link></Button>
  </div>
}
