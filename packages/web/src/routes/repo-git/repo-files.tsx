import { ChevronRightIcon, FileIcon, FolderIcon, FolderTreeIcon, ImageIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ApiError } from '@/api/client'
import { useRepoTree } from '@/api/queries'
import { ContextSidebar } from '@/components/context-sidebar'
import { PageBody } from '@/components/page'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

import { FilePreview } from '../task-git/file-preview'
import { buildPathTree, type PathTreeDir } from '../task-git/file-tree'
import { isImagePath } from '../task-git/worktree-files'
import { matchPaths } from './match-paths'
import { RepoEmpty } from './repo-empty'
import { OpenSidebarButton, useCloseSidebarSheet } from './repo-sidebar'

/**
 * `/git/files` — the project repository's own file browser (spec
 * `.ai/specs/2026-10-05-repo-file-browser.md`, #1279): the tree from one `GET /repo/tree`, the
 * file through the same `FilePreview` the run Files tab uses, and a filter box over the index.
 *
 * Master–detail like the other Git sections: the filter and the tree live in the contextual
 * sidebar, the main area is the file. On a phone that sidebar is a sheet, so main offers a button
 * that opens it, and picking a file closes it again.
 *
 * The one structural difference from `/tasks/:id/files` is where the tree's shape comes from. A
 * worktree has no cheap whole-tree answer, so that tab fetches one listing per opened folder; a git
 * repository does, so this one takes the whole index in a single response. Expanding a folder then
 * costs nothing, and the filter is a pass over an array the browser already holds — which is why
 * search needs no endpoint of its own.
 *
 * Folders start CLOSED (a repository root fans out fast), except along the path to the selected
 * file, so `/git/files/packages/web/src/x.tsx` opens with its ancestors already expanded.
 */
export type RepoFileLeaf = { kind: 'file'; name: string; path: string }

/** Rendered matches cap (spec Q9): the one unbounded case is a filter matching thousands of paths,
 *  and a cap with an honest "N more" answers it without taking on a virtualizer. */
const MATCH_LIMIT = 200

export function RepoFilesSection({
  header,
  selected,
  onSelect,
}: {
  /** The Git screen's sidebar header (title, branch, section switch). */
  header: ReactNode
  selected: string | null
  onSelect: (path: string | null) => void
}) {
  const tree = useRepoTree()

  // A 409 is the server's answer ("not a git repository"), not an outage.
  const refused = tree.isError && tree.error instanceof ApiError && tree.error.status === 409
  const paths = tree.data?.paths ?? []
  const browsable = tree.data !== undefined && paths.length > 0

  return (
    <section data-slot="repo-files" className="flex min-h-0 flex-1 flex-col">
      <ContextSidebar>
        {header}
        <SidebarContent>
          <SidebarGroup className="pt-0">
            <SidebarGroupLabel className="justify-between">
              Files
              {browsable ? <span className="font-mono tabular-nums">{paths.length.toLocaleString()}</span> : null}
            </SidebarGroupLabel>
            <SidebarGroupContent data-slot="repo-files-tree-pane">
              {tree.isPending ? (
                <p data-slot="repo-files-loading" className="px-2 py-1.5 text-xs text-muted-foreground">
                  Loading files…
                </p>
              ) : !browsable ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {tree.isError ? 'Files are unavailable.' : 'No files yet.'}
                </p>
              ) : (
                <>
                  {tree.data.truncated ? (
                    <p
                      data-slot="repo-files-truncated"
                      role="status"
                      className="mb-2 rounded-md bg-muted px-2 py-1.5 text-xs text-pretty text-muted-foreground"
                    >
                      Showing the first {paths.length.toLocaleString()} files; this repository has more. The
                      tree and the filter cover only what is loaded.
                    </p>
                  ) : null}
                  <SidebarFileBrowser paths={paths} selected={selected} onSelect={onSelect} />
                </>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </ContextSidebar>

      {tree.isPending ? null : tree.isError ? (
        <RepoEmpty
          icon={refused ? <FolderTreeIcon /> : <TriangleAlertIcon />}
          tone={refused ? 'neutral' : 'danger'}
          title={refused ? 'No files to browse' : 'Could not load the files'}
          description={tree.error.message}
        />
      ) : paths.length === 0 ? (
        <RepoEmpty
          icon={<FolderTreeIcon />}
          title="No files yet"
          description="Nothing is tracked in this repository. Files show up here once git knows about them."
        />
      ) : (
        <PageBody className="flex flex-col gap-3 pt-4 [--diff-sticky-top:0rem]">
          {/* The tree is the only way to pick a file, and on a phone it is behind the sheet. */}
          <OpenSidebarButton>Browse files</OpenSidebarButton>
          <FilePreview source={{ kind: 'repo' }} path={selected} />
        </PageBody>
      )}
    </section>
  )
}

/** The browser as the sidebar shows it: a pick also dismisses the phone sheet, which a file click
 *  (a URL replace, not a navigation the shell reacts to) would otherwise leave covering the file. */
function SidebarFileBrowser({
  paths,
  selected,
  onSelect,
}: {
  paths: readonly string[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  const closeSheet = useCloseSidebarSheet()
  return (
    <RepoFileBrowser
      paths={paths}
      selected={selected}
      onSelect={(path) => {
        onSelect(path)
        closeSheet()
      }}
    />
  )
}

/** The ancestors of `path` — `a/b/c.ts` → `['a', 'a/b']` — so a deep link opens expanded. */
export function ancestorsOf(path: string | null): string[] {
  if (path === null) return []
  const segments = path.split('/')
  // Every prefix, because compaction means a rendered row's `path` is the chain's DEEPEST segment
  // and the tree matches on whichever prefix it actually drew.
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/'))
}

/** One rendered row. A flat list on purpose: it is what makes roving `tabindex` and ↑/↓ a single
 *  index step instead of a tree walk, and `aria-level` carries the depth ARIA needs. */
type Row =
  | { kind: 'dir'; path: string; name: string; level: number; open: boolean }
  | { kind: 'file'; path: string; name: string; level: number; label: string }

/** The visible rows of `dir`, dirs before files, descending only into open folders. */
function flatten(dir: PathTreeDir<RepoFileLeaf>, open: ReadonlySet<string>, level: number): Row[] {
  const rows: Row[] = []
  for (const child of dir.dirs) {
    const isOpen = open.has(child.path)
    rows.push({ kind: 'dir', path: child.path, name: child.name, level, open: isOpen })
    if (isOpen) rows.push(...flatten(child, open, level + 1))
  }
  for (const file of dir.files) {
    rows.push({ kind: 'file', path: file.path, name: file.name, level, label: file.name })
  }
  return rows
}

export function RepoFileBrowser({
  paths,
  selected,
  onSelect,
  onOpen,
  marks,
}: {
  paths: readonly string[]
  selected: string | null
  onSelect: (path: string) => void
  /** A double click: the Code page keeps the tab instead of previewing it. */
  onOpen?: (path: string) => void
  /** A status letter per changed path (`M`, `A`, `D`, `U`), shown after the name. */
  marks?: ReadonlyMap<string, string>
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(ancestorsOf(selected)))
  const [active, setActive] = useState<string | null>(selected)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // A deep link (or an arrow-key walk into a closed folder) must reveal its target. Union rather
  // than replace: a folder the user opened themselves stays open across selections.
  useEffect(() => {
    const ancestors = ancestorsOf(selected)
    if (ancestors.length === 0) return
    setOpen((current) => {
      if (ancestors.every((path) => current.has(path))) return current
      const next = new Set(current)
      for (const path of ancestors) next.add(path)
      return next
    })
  }, [selected])

  const filtering = query.trim() !== ''
  const matches = useMemo(() => matchPaths(paths, query, MATCH_LIMIT), [paths, query])
  const root = useMemo(
    () => buildPathTree(paths, (path, name): RepoFileLeaf => ({ kind: 'file', name, path })),
    [paths],
  )

  // Filtering FLATTENS to full paths rather than filtering the hierarchy: a filtered tree hides the
  // match it just found behind collapsed ancestors, which is the mistake every file-finder learned
  // from.
  const rows: Row[] = useMemo(
    () =>
      filtering
        ? matches.results.map((path) => ({
            kind: 'file' as const,
            path,
            name: path.slice(path.lastIndexOf('/') + 1),
            level: 0,
            label: path,
          }))
        : flatten(root, open, 0),
    [filtering, matches.results, root, open],
  )

  // The roving-tabindex holder: the active row when it is still visible, else the first row.
  const activeRow = rows.find((row) => row.path === active) ?? rows[0]
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.path === activeRow?.path)
    const move = (to: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, to))]
      if (row) setActive(row.path)
    }
    const current = rows[index]
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(index - 1)
    } else if (event.key === 'ArrowRight' && current?.kind === 'dir') {
      event.preventDefault()
      if (current.open) move(index + 1)
      else toggle(current.path)
    } else if (event.key === 'ArrowLeft' && current !== undefined) {
      event.preventDefault()
      if (current.kind === 'dir' && current.open) {
        toggle(current.path)
      } else {
        // Up to the nearest shallower row — the parent, whatever its compacted name is.
        for (let i = index - 1; i >= 0; i -= 1) {
          const candidate = rows[i] as Row
          if (candidate.level < current.level) {
            setActive(candidate.path)
            break
          }
        }
      }
    } else if ((event.key === 'Enter' || event.key === ' ') && current !== undefined) {
      event.preventDefault()
      if (current.kind === 'file') onSelect(current.path)
      else toggle(current.path)
    }
  }

  return (
    <div
      data-slot="repo-files-browser"
      className="flex min-w-0 flex-col gap-2"
      // `/` is the filter's shortcut, but only when the user is not already typing somewhere.
      onKeyDown={(event) => {
        if (event.key !== '/' || event.target === inputRef.current) return
        event.preventDefault()
        inputRef.current?.focus()
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="repo-files-filter" className="sr-only">
          Filter repository files
        </label>
        <InputGroup className="bg-background shadow-none">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            id="repo-files-filter"
            ref={inputRef}
            data-slot="repo-files-filter"
            type="search"
            value={query}
            placeholder="Filter files…  (/)"
            aria-controls="repo-files-tree"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              setQuery('')
            }}
          />
        </InputGroup>
        {/* Polite, so the count lands after the typing rather than interrupting it. */}
        <p data-slot="repo-files-count" role="status" aria-live="polite" className="sr-only">
          {filtering ? `${matches.total} files match ${query.trim()}` : `${paths.length} files`}
        </p>
      </div>

      {filtering && matches.total === 0 ? (
        <p data-slot="repo-files-no-match" className="px-2 py-1.5 text-xs text-muted-foreground">
          No file matches <span className="font-mono">{query.trim()}</span>.
        </p>
      ) : (
        <div
          id="repo-files-tree"
          data-slot="repo-files-tree"
          data-filtering={filtering ? 'true' : undefined}
          role="tree"
          aria-label="Repository files"
          aria-activedescendant={activeRow ? rowId(activeRow.path) : undefined}
          onKeyDown={onKeyDown}
          className="min-w-0 text-[13px]"
        >
          {rows.map((row) =>
            row.kind === 'dir' ? (
              <DirRow
                key={row.path}
                row={row}
                focused={row.path === activeRow?.path}
                onToggle={() => {
                  setActive(row.path)
                  toggle(row.path)
                }}
              />
            ) : (
              <FileRow
                key={row.path}
                row={row}
                active={row.path === selected}
                focused={row.path === activeRow?.path}
                mark={marks?.get(row.path)}
                onOpen={onOpen ? () => onOpen(row.path) : undefined}
                onSelect={() => {
                  setActive(row.path)
                  onSelect(row.path)
                }}
              />
            ),
          )}
        </div>
      )}

      {filtering && matches.total > matches.results.length ? (
        <p data-slot="repo-files-more" className="px-2 py-1.5 text-xs text-muted-foreground">
          {(matches.total - matches.results.length).toLocaleString()} more — refine the filter.
        </p>
      ) : null}
    </div>
  )
}

/** Stable per-path row id, for `aria-activedescendant`. */
const rowId = (path: string) => `repo-file-row-${path}`

/** Indent by depth; the filtered list is flat, so its rows sit at level 0. */
const indent = (level: number, base: number) => ({ paddingLeft: `${base + level * 14}px` })

function DirRow({
  row,
  focused,
  onToggle,
}: {
  row: Extract<Row, { kind: 'dir' }>
  focused: boolean
  onToggle: () => void
}) {
  return (
    <div
      id={rowId(row.path)}
      role="treeitem"
      aria-expanded={row.open}
      aria-level={row.level + 1}
      data-slot="repo-files-dir"
      data-path={row.path}
      data-state={row.open ? 'open' : 'closed'}
      tabIndex={focused ? 0 : -1}
      onClick={onToggle}
      className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus:bg-muted focus:outline-none"
      style={indent(row.level, 6)}
    >
      <ChevronRightIcon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0 transition-transform', row.open && 'rotate-90')}
      />
      <FolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate font-medium">{row.name}</span>
    </div>
  )
}

function FileRow({
  row,
  active,
  focused,
  onSelect,
  onOpen,
  mark,
}: {
  row: Extract<Row, { kind: 'file' }>
  active: boolean
  focused: boolean
  onSelect: () => void
  onOpen?: () => void
  mark?: string
}) {
  const Icon = isImagePath(row.path) ? ImageIcon : FileIcon
  return (
    <div
      id={rowId(row.path)}
      role="treeitem"
      aria-level={row.level + 1}
      aria-selected={active}
      aria-current={active ? 'true' : undefined}
      data-slot="repo-files-file"
      data-path={row.path}
      tabIndex={focused ? 0 : -1}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        'flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-sidebar-accent focus:outline-none',
        active ? 'bg-sidebar-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
      style={indent(row.level, 24)}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {/* The filtered list shows the FULL path; the tree shows the leaf name. */}
      <span className="min-w-0 truncate" title={row.label}>
        {row.label}
      </span>
      {mark ? (
        <span data-slot="repo-files-mark" className="ml-auto shrink-0 pl-1 font-mono text-[11px] text-pending-strong" title="Changed">
          {mark}
        </span>
      ) : null}
    </div>
  )
}
