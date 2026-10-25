import { CherryIcon, GitBranchIcon, GitCommitHorizontalIcon, MoreHorizontalIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { Virtualizer } from 'virtua'

import { cherryPickCommit, useRepoGitAction, useRepoGraph } from '@/api/repo-git'
import type { RepoGraphCommit, RepoGraphFilter, RepoGraphRef } from '@open-mercato/cezar-api-client'

import { PageBody, PageTitle, PageToolbar } from '@/components/page'
import { ROW_FOCUS_WITHIN_CLASS } from '@/lib/row-focus'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from '@/components/ui/toaster'
import { Link, useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { BranchActionsMenu, useAnnounce } from './branch-actions'
import { assignLanes, type LaneEdge, type LaneRow } from './graph-lanes'
import { RepoEmpty } from './repo-empty'
import { RepoContextSidebar, useCloseSidebarSheet, withParam } from './repo-sidebar'

const ROW_HEIGHT = 30
const LANE_WIDTH = 14
const VIRTUALIZE_AT = 150
/** Lane colors, from the design tokens — never raw hex (design-guardian). */
const PALETTE = [
  'var(--primary)',
  'var(--violet)',
  'var(--info)',
  'var(--success)',
  'var(--conflict)',
  'var(--syn-key)',
  'var(--term-cyan)',
  'var(--danger)',
]
const laneColor = (index: number) => PALETTE[index % PALETTE.length] as string

const FILTERS: { value: RepoGraphFilter; label: string }[] = [
  { value: 'all', label: 'All remotes' },
  { value: 'mine', label: 'Mine' },
  { value: 'tasks', label: 'Tasks' },
]

/**
 * The Git page's Graph tab (spec 2026-10-24-git-view §3.1): `git log --graph` as lanes over HEAD,
 * every local branch, every remote's branches and the task branches (labelled with their task),
 * newest first. A commit opens `/git/commits/:sha`; a label opens the branch's actions. Merged
 * task branches are faded, and every visible branch's fork point from the base is marked.
 */
export function RepoGraphSection({ header }: { header: ReactNode }) {
  const [filter, setFilter] = useState<RepoGraphFilter>('all')
  const [search, setSearch] = useState('')
  const graph = useRepoGraph(filter)
  const pages = graph.data?.pages ?? []
  const first = pages[0]
  const commits = useMemo(() => pages.flatMap((page) => page.commits), [pages])
  const refs = first?.refs ?? []
  const rows = useMemo(() => assignLanes(commits), [commits])
  const width = rows.reduce((max, row) => Math.max(max, row.width), 1)

  const labels = useMemo(() => {
    const byCommit = new Map<string, RepoGraphRef[]>()
    for (const ref of refs) byCommit.set(ref.commit, [...(byCommit.get(ref.commit) ?? []), ref])
    return byCommit
  }, [refs])
  /** sha → the branches that forked from the base there. */
  const forks = useMemo(() => {
    const at = new Map<string, string[]>()
    for (const ref of refs) if (ref.mergeBase && !ref.merged) at.set(ref.mergeBase, [...(at.get(ref.mergeBase) ?? []), ref.name])
    return at
  }, [refs])

  const needle = search.trim().toLowerCase()
  const matches = (commit: RepoGraphCommit) =>
    !needle || commit.subject.toLowerCase().includes(needle) || commit.sha.startsWith(needle)
  const matchCount = needle ? commits.filter(matches).length : commits.length

  // `?ref=<sha>` (cockpit-polish §3.1): the revealed commit survives a refresh and a shared link.
  const [params, setParams] = useSearchParams()
  const focused = params.get('ref')
  const rowEls = useRef(new Map<string, HTMLElement>())
  const arrivedAt = useRef(focused)
  const loaded = commits.length > 0
  useEffect(() => {
    const sha = arrivedAt.current
    if (sha === null || !loaded) return
    arrivedAt.current = null
    rowEls.current.get(sha)?.scrollIntoView?.({ block: 'center' })
  }, [loaded])
  const reveal = (sha: string) => {
    setParams((current) => withParam(current, 'ref', sha), { replace: true })
    rowEls.current.get(sha)?.scrollIntoView({ block: 'center' })
  }

  const lists = {
    local: refs.filter((ref) => ref.kind === 'local' && !ref.isTask),
    tasks: refs.filter((ref) => ref.isTask),
    remote: refs.filter((ref) => ref.kind === 'remote' && !ref.isTask),
  }

  return (
    <section data-slot="repo-graph" className="flex min-h-0 flex-1 flex-col">
      <RepoContextSidebar tab="graph">
        {header}
        <SidebarContent>
          {(
            [
              ['Branches', lists.local],
              ['Tasks', lists.tasks],
              ['Remote', lists.remote],
            ] as const
          ).map(([title, list]) =>
            list.length ? (
              <SidebarGroup key={title} className="pt-0">
                <SidebarGroupLabel>
                  {title} · {list.length}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <RefMenu refs={list} onPick={(ref) => reveal(ref.commit)} />
                </SidebarGroupContent>
              </SidebarGroup>
            ) : null,
          )}
        </SidebarContent>
      </RepoContextSidebar>

      <PageToolbar data-slot="repo-graph-toolbar" className="gap-x-3 pt-4">
        <PageTitle>Graph</PageTitle>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={filter}
          onValueChange={(value) => value && setFilter(value as RepoGraphFilter)}
          aria-label="Which branches"
        >
          {FILTERS.map((entry) => (
            <ToggleGroupItem key={entry.value} value={entry.value} data-filter={entry.value} className="px-2.5 text-xs">
              {entry.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <InputGroup className="w-full md:ml-auto md:w-64">
          <InputGroupAddon>
            <GitCommitHorizontalIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search commits"
            placeholder="Search subjects and shas…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </InputGroup>
        {needle ? (
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {matchCount} of {commits.length}
          </span>
        ) : null}
      </PageToolbar>

      {graph.isPending ? (
        <PageBody className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
          <Spinner />
          Loading the graph…
        </PageBody>
      ) : graph.isError ? (
        <RepoEmpty icon={<TriangleAlertIcon />} tone="danger" title="Could not load the graph" description={graph.error.message} />
      ) : commits.length === 0 ? (
        <RepoEmpty icon={<GitBranchIcon />} title="No commits yet" description="Commit something and it shows up here." />
      ) : (
        <PageBody className="px-0 md:px-0">
          <GraphRows
            commits={commits}
            rows={rows}
            width={width}
            labels={labels}
            forks={forks}
            head={first?.head ?? null}
            focused={focused}
            matches={matches}
            rowEls={rowEls.current}
          />
          {graph.hasNextPage ? (
            <div className="flex justify-center py-3">
              <Button variant="outline" size="sm" disabled={graph.isFetchingNextPage} onClick={() => void graph.fetchNextPage()}>
                {graph.isFetchingNextPage ? <Spinner /> : null}
                Load older commits
              </Button>
            </div>
          ) : null}
        </PageBody>
      )}
    </section>
  )
}

function RefMenu({ refs, onPick }: { refs: RepoGraphRef[]; onPick: (ref: RepoGraphRef) => void }) {
  const closeSheet = useCloseSidebarSheet()
  return (
    <SidebarMenu>
      {refs.map((ref) => (
        <SidebarMenuItem key={ref.name}>
          <SidebarMenuButton
            title={ref.task ? `${ref.name} — ${ref.task.title}` : ref.name}
            className={cn(ref.merged && 'opacity-55')}
            onClick={() => {
              closeSheet()
              onPick(ref)
            }}
          >
            <GitBranchIcon aria-hidden="true" className="text-muted-foreground" />
            <span className={cn('min-w-0 flex-1 truncate font-mono text-[12.5px]', ref.current && 'font-semibold')}>
              {ref.task?.title ?? ref.name}
            </span>
            {ref.current ? <span className="shrink-0 text-xs text-muted-foreground">HEAD</span> : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}

function GraphRows({
  commits,
  rows,
  width,
  labels,
  forks,
  head,
  focused,
  matches,
  rowEls,
}: {
  commits: RepoGraphCommit[]
  rows: LaneRow[]
  width: number
  labels: Map<string, RepoGraphRef[]>
  forks: Map<string, string[]>
  head: string | null
  focused: string | null
  matches: (commit: RepoGraphCommit) => boolean
  rowEls: Map<string, HTMLElement>
}) {
  const virtual = commits.length > VIRTUALIZE_AT
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollElRef = useRef<HTMLElement | null>(null)
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    if (!virtual) return
    const container = containerRef.current
    const scroller = scrollElRef.current
    if (!container || !scroller) return
    setStartMargin(
      Math.max(0, Math.round(container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)),
    )
  }, [virtual])
  const laneWidth = Math.min(width, 12) * LANE_WIDTH + 6

  const items = commits.map((commit, index) => (
    <GraphRow
      key={commit.sha}
      commit={commit}
      row={rows[index] as LaneRow}
      laneWidth={laneWidth}
      labels={labels.get(commit.sha) ?? []}
      forkOf={forks.get(commit.sha)}
      isHead={commit.sha === head}
      focused={focused === commit.sha}
      dim={!matches(commit)}
      register={(el) => {
        if (el) rowEls.set(commit.sha, el)
        else rowEls.delete(commit.sha)
      }}
    />
  ))
  return (
    <div
      ref={(el) => {
        containerRef.current = el
        if (el) scrollElRef.current = el.closest<HTMLElement>('[data-slot="main"]')
      }}
      data-slot="graph-rows"
      role="list"
      aria-label="Commit graph"
      className="flex flex-col"
    >
      {virtual ? (
        <Virtualizer scrollRef={scrollElRef} startMargin={startMargin} itemSize={ROW_HEIGHT}>
          {items}
        </Virtualizer>
      ) : (
        items
      )}
    </div>
  )
}

function GraphRow({
  commit,
  row,
  laneWidth,
  labels,
  forkOf,
  isHead,
  focused,
  dim,
  register,
}: {
  commit: RepoGraphCommit
  row: LaneRow
  laneWidth: number
  labels: RepoGraphRef[]
  forkOf: string[] | undefined
  isHead: boolean
  focused: boolean
  dim: boolean
  register: (el: HTMLElement | null) => void
}) {
  const navigate = useNavigate()
  const announce = useAnnounce()
  const pick = useRepoGitAction((sha: string) => cherryPickCommit(sha))
  const allMerged = labels.length > 0 && labels.every((ref) => ref.merged)
  return (
    <div
      ref={register}
      role="listitem"
      data-slot="graph-row"
      data-sha={commit.sha}
      data-state={focused ? 'selected' : undefined}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        'group flex min-w-0 items-center gap-2 pr-2 hover:bg-muted/50 md:pr-4',
        ROW_FOCUS_WITHIN_CLASS,
        focused && 'bg-muted',
        dim && 'opacity-35',
      )}
    >
      <LaneCell row={row} width={laneWidth} isHead={isHead} fork={forkOf} faded={allMerged} />
      <span className="flex min-w-0 shrink-0 items-center gap-1">
        {labels.map((ref) => (
          <RefLabel key={ref.name} ref_={ref} />
        ))}
      </span>
      <Link
        to={`/git/commits/${commit.sha}`}
        data-slot="graph-commit"
        title={commit.subject}
        className="min-w-0 flex-1 truncate text-[13px] text-foreground hover:underline"
      >
        {commit.subject}
      </Link>
      {forkOf ? (
        <span data-slot="graph-fork" title={`Fork point of ${forkOf.join(', ')}`} className="hidden shrink-0 text-xs text-muted-foreground lg:inline">
          fork of {forkOf.length === 1 ? forkOf[0] : `${forkOf.length} branches`}
        </span>
      ) : null}
      <span className="hidden shrink-0 truncate text-xs text-muted-foreground md:inline md:max-w-32">{commit.author}</span>
      <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">{commit.when}</span>
      <span className="shrink-0 font-mono text-[11px] text-soft-foreground">{commit.sha.slice(0, 7)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${commit.sha.slice(0, 7)}`} className="opacity-60 group-hover:opacity-100">
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="font-mono text-xs font-normal text-muted-foreground">{commit.sha.slice(0, 12)}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => navigate(`/git/commits/${commit.sha}`)}>
            <GitCommitHorizontalIcon aria-hidden="true" />
            Open commit
          </DropdownMenuItem>
          <DropdownMenuItem
            data-action="cherry-pick"
            disabled={pick.isPending}
            onSelect={() => pick.mutate(commit.sha, { onSuccess: announce, onError: (error) => toast(error.message, { tone: 'danger' }) })}
          >
            <CherryIcon aria-hidden="true" />
            Cherry-pick onto current
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(commit.sha).then(() => toast('Copied the sha'))}>
            Copy sha
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function RefLabel({ ref_: ref }: { ref_: RepoGraphRef }) {
  const text = ref.task ? `${ref.branch} · ${ref.task.title}` : ref.name
  return (
    <BranchActionsMenu
      align="start"
      target={{ name: ref.name, kind: ref.kind, current: ref.current, isTask: ref.isTask }}
      trigger={
        <button
          type="button"
          data-slot="graph-ref"
          data-ref={ref.name}
          data-merged={ref.merged || undefined}
          title={ref.task ? `${ref.name} — ${ref.task.title} (${ref.task.status})` : ref.name}
          className={cn(
            'max-w-48 truncate rounded-sm border px-1.5 py-px font-mono text-[11px] leading-4',
            ref.current
              ? 'border-primary/60 bg-primary/15 text-foreground'
              : ref.kind === 'remote'
                ? 'border-border text-muted-foreground'
                : ref.isTask
                  ? 'border-violet/50 bg-violet/10 text-foreground'
                  : 'border-border bg-muted text-foreground',
            ref.merged && 'opacity-50',
          )}
        >
          {ref.current ? 'HEAD → ' : ''}
          {text}
        </button>
      }
    />
  )
}

/** One row's slice of the lanes: straight lines for lanes passing through, curves where a lane
 *  ends in or leaves this node, the node itself (ringed at HEAD, a diamond at a fork point). */
function LaneCell({
  row,
  width,
  isHead,
  fork,
  faded,
}: {
  row: LaneRow
  width: number
  isHead: boolean
  fork: string[] | undefined
  faded: boolean
}) {
  const x = (col: number) => Math.min(col, 11) * LANE_WIDTH + LANE_WIDTH / 2 + 2
  const mid = ROW_HEIGHT / 2
  const path = (edge: LaneEdge) => {
    const [y1, y2] = edge.half === 'top' ? [0, mid] : [mid, ROW_HEIGHT]
    const [x1, x2] = [x(edge.from), x(edge.to)]
    if (x1 === x2) return `M${x1} ${y1}V${y2}`
    const bend = (y2 - y1) / 2
    return `M${x1} ${y1}C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`
  }
  const cx = x(row.col)
  const color = laneColor(row.color)
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      className={cn('shrink-0', faded && 'opacity-50')}
    >
      {row.edges.map((edge, index) => (
        <path key={index} d={path(edge)} fill="none" stroke={laneColor(edge.color)} strokeWidth={1.75} strokeLinecap="round" />
      ))}
      {fork ? (
        <rect x={cx - 5} y={mid - 5} width={10} height={10} transform={`rotate(45 ${cx} ${mid})`} fill="var(--background)" stroke={color} strokeWidth={2} />
      ) : (
        <circle cx={cx} cy={mid} r={isHead ? 5 : 3.5} fill={isHead ? 'var(--background)' : color} stroke={color} strokeWidth={isHead ? 2.5 : 1} />
      )}
    </svg>
  )
}
