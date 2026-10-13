import { useQuery } from '@tanstack/react-query'
import { CaseSensitiveIcon, ChevronsDownUpIcon, FilePlusIcon, FolderPlusIcon, FolderSearchIcon, RefreshCwIcon, RegexIcon, SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { queryScope, type ChangedFile, type CodeSearchMatch } from '@open-mercato/cezar-api-client'
import { searchCode, treeKey, type CodeTree } from '@/api/code'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import {
  SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub,
  SidebarMenuSubButton, SidebarMenuSubItem,
} from '@/components/ui/sidebar'
import { Toggle } from '@/components/ui/toggle'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { RepoFileBrowser } from '@/routes/repo-git/repo-files'

import { MenuItems, type MenuItem } from './code-menu'

/**
 * The Code page's sidebar views (spec 2026-10-11-code-page): the explorer, search across files,
 * and source control. Built from the shell's own sidebar parts, because that is where they
 * render — in the screen's contextual sidebar.
 */

/** What a right click in the explorer landed on; `null` is the empty space under the tree. */
export type ExplorerTarget = { kind: 'file' | 'dir'; path: string } | null

function HeaderAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <IconTooltip label={label}>
      <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>{children}</Button>
    </IconTooltip>
  )
}

export function ExplorerView({
  paths, loading, error, selected, marks, canEdit, onSelect, onOpen, menuFor, onNewFile, onNewFolder, onRefresh, onMoveFile,
}: {
  paths: readonly string[]
  loading: boolean
  error: string | null
  selected: string | null
  marks: ReadonlyMap<string, string>
  canEdit: boolean
  onSelect: (path: string) => void
  onOpen: (path: string) => void
  /** The menu for a right click on `target`. */
  menuFor: (target: ExplorerTarget) => MenuItem[]
  onNewFile: () => void
  onNewFolder: () => void
  onRefresh: () => void
  /** A file dragged onto a folder (`''` is the root). Absent where files cannot be edited. */
  onMoveFile?: (from: string, toDir: string) => void
}) {
  const [collapse, setCollapse] = useState(0)
  const [target, setTarget] = useState<ExplorerTarget>(null)
  return (
    <SidebarGroup data-slot="code-explorer" className="min-h-0 flex-1 pt-0">
      <SidebarGroupLabel className="justify-between pr-0">
        Explorer
        <span className="flex items-center gap-0.5">
          {canEdit ? (
            <>
              <HeaderAction label="New File…" onClick={onNewFile}><FilePlusIcon aria-hidden="true" /></HeaderAction>
              <HeaderAction label="New Folder…" onClick={onNewFolder}><FolderPlusIcon aria-hidden="true" /></HeaderAction>
            </>
          ) : null}
          <HeaderAction label="Refresh Explorer" onClick={onRefresh}><RefreshCwIcon aria-hidden="true" /></HeaderAction>
          <HeaderAction label="Collapse Folders" onClick={() => setCollapse((value) => value + 1)}><ChevronsDownUpIcon aria-hidden="true" /></HeaderAction>
        </span>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        {loading ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading files…</p> : null}
        {error ? <p role="alert" className="px-2 py-1.5 text-xs text-danger">{error}</p> : null}
        {!loading && !error ? (
          <ContextMenu>
            {/* A row records what was hit as its own event bubbles up; a click on the empty
                space reaches only the capture below and is a menu for the root. */}
            <ContextMenuTrigger asChild>
              <div data-slot="code-explorer-tree" className="min-h-24" onContextMenuCapture={() => setTarget(null)}>
                <RepoFileBrowser
                  paths={paths}
                  selected={selected}
                  marks={marks}
                  collapseSignal={collapse}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  onContextMenu={(_event, hit) => setTarget(hit)}
                  {...(onMoveFile ? { onMoveFile } : {})}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent data-slot="code-context-menu"><MenuItems items={menuFor(target)} /></ContextMenuContent>
          </ContextMenu>
        ) : null}
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/** Results grouped by file, in the order the server found them. */
export function groupMatches(matches: readonly CodeSearchMatch[]): Array<{ path: string; matches: CodeSearchMatch[] }> {
  const groups = new Map<string, CodeSearchMatch[]>()
  for (const match of matches) groups.set(match.path, [...(groups.get(match.path) ?? []), match])
  return [...groups].map(([path, found]) => ({ path, matches: found }))
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

export function SearchView({ tree, onOpen, focus }: { tree: CodeTree; onOpen: (path: string, line?: number) => void; focus: number }) {
  const [text, setText] = useState('')
  const [glob, setGlob] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [asked, setAsked] = useState<{ q: string; glob: string; regex: boolean; caseSensitive: boolean } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [focus])
  const result = useQuery({
    queryKey: ['code', 'search', queryScope(), treeKey(tree), asked],
    queryFn: ({ signal }) => searchCode(tree, asked?.q ?? '', { regex: asked?.regex ?? false, caseSensitive: asked?.caseSensitive ?? false, glob: asked?.glob ?? '' }, { signal }),
    enabled: asked !== null,
    staleTime: 0,
  })
  const groups = useMemo(() => groupMatches(result.data?.matches ?? []), [result.data])
  return (
    <SidebarGroup data-slot="code-search" className="min-h-0 flex-1 pt-0">
      <SidebarGroupLabel>Search</SidebarGroupLabel>
      <SidebarGroupContent className="flex flex-col gap-2">
        <form
          role="search"
          className="flex flex-col gap-1.5 px-2"
          onSubmit={(event) => { event.preventDefault(); if (text.trim() !== '') setAsked({ q: text, glob, regex, caseSensitive }) }}
        >
          {/* The explorer filter's shape, so the two sidebar views read as one. */}
          <InputGroup className="bg-background shadow-none">
            <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput ref={inputRef} aria-label="Search in files" value={text} onChange={(event) => setText(event.target.value)} placeholder="Search" spellCheck={false} autoComplete="off" />
            <InputGroupAddon align="inline-end" className="gap-0.5">
              <IconTooltip label="Match Case">
                <Toggle size="sm" className="size-6 min-w-6 px-0" aria-label="Match Case" pressed={caseSensitive} onPressedChange={setCaseSensitive}><CaseSensitiveIcon aria-hidden="true" /></Toggle>
              </IconTooltip>
              <IconTooltip label="Use Regular Expression">
                <Toggle size="sm" className="size-6 min-w-6 px-0" aria-label="Use Regular Expression" pressed={regex} onPressedChange={setRegex}><RegexIcon aria-hidden="true" /></Toggle>
              </IconTooltip>
            </InputGroupAddon>
          </InputGroup>
          <InputGroup className="bg-background shadow-none">
            <InputGroupAddon><FolderSearchIcon aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput aria-label="Files to include" value={glob} onChange={(event) => setGlob(event.target.value)} placeholder="Files to include" title="A glob, e.g. src/**/*.ts" spellCheck={false} autoComplete="off" />
          </InputGroup>
          <Button type="submit" size="sm" variant="secondary" disabled={text.trim() === ''}>Search</Button>
        </form>
        <div data-slot="code-search-results" className="px-2 text-xs">
          {result.isFetching ? <p className="text-muted-foreground">Searching…</p> : null}
          {result.isError ? <p role="alert" className="text-danger">{result.error.message}</p> : null}
          {result.data && !result.isFetching ? (
            <p role="status" className="text-muted-foreground">
              {result.data.matches.length === 0 ? 'No results.' : `${result.data.matches.length} result${result.data.matches.length === 1 ? '' : 's'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`}
              {result.data.truncated ? ' — more exist; narrow the search.' : ''}
            </p>
          ) : null}
        </div>
        <SidebarMenu>
          {groups.map((group) => (
            <SidebarMenuItem key={group.path}>
              <SidebarMenuButton size="sm" title={group.path} onClick={() => onOpen(group.path)}>
                <span className="truncate font-medium">{nameOf(group.path)}</span>
                <span className="min-w-0 truncate text-xs text-soft-foreground">{dirOf(group.path)}</span>
                <Badge variant="secondary" className="ml-auto px-1.5 text-[10px] tabular-nums">{group.matches.length}</Badge>
              </SidebarMenuButton>
              <SidebarMenuSub>
                {group.matches.map((match) => (
                  <SidebarMenuSubItem key={`${match.line}:${match.text}`}>
                    <SidebarMenuSubButton asChild size="sm">
                      <button type="button" className="w-full font-mono" onClick={() => onOpen(match.path, match.line)}>
                        <span className="min-w-0 truncate whitespace-pre">{match.text.trimStart()}</span>
                        <span className="ml-auto shrink-0 tabular-nums text-soft-foreground">{match.line}</span>
                      </button>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

const STATUS: Record<ChangedFile['status'], { letter: string; label: string; tone: string }> = {
  added: { letter: 'A', label: 'Added', tone: 'text-success' },
  modified: { letter: 'M', label: 'Modified', tone: 'text-pending-strong' },
  deleted: { letter: 'D', label: 'Deleted', tone: 'text-danger' },
  renamed: { letter: 'R', label: 'Renamed', tone: 'text-pending-strong' },
  copied: { letter: 'C', label: 'Copied', tone: 'text-pending-strong' },
}

/** Source control: what differs from the last commit. Committing stays on the Git page. */
export function ScmView({
  tree, files, loading, error, onOpenDiff, onOpenFile,
}: {
  tree: CodeTree
  files: readonly ChangedFile[]
  loading: boolean
  error: string | null
  onOpenDiff: (path: string) => void
  onOpenFile: (path: string) => void
}) {
  return (
    <SidebarGroup data-slot="code-scm" className="min-h-0 flex-1 pt-0">
      <SidebarGroupLabel className="justify-between">
        Source Control
        {files.length > 0 ? <span className="font-mono tabular-nums">{files.length}</span> : null}
      </SidebarGroupLabel>
      <SidebarGroupContent className="flex flex-col gap-2">
        {loading ? <p className="px-2 text-xs text-muted-foreground">Loading changes…</p> : null}
        {error ? <p role="alert" className="px-2 text-xs text-danger">{error}</p> : null}
        {!loading && !error && files.length === 0 ? <p className="px-2 text-xs text-muted-foreground">No changes since the last commit.</p> : null}
        <SidebarMenu aria-label="Changed files">
          {files.map((file) => (
            <SidebarMenuItem key={file.path} onDoubleClick={() => { if (file.status !== 'deleted') onOpenFile(file.path) }}>
              <SidebarMenuButton size="sm" title={`${file.path} — ${STATUS[file.status].label}`} onClick={() => onOpenDiff(file.path)}>
                <span className={cn('truncate', file.status === 'deleted' && 'line-through')}>{nameOf(file.path)}</span>
                <span className="min-w-0 truncate text-xs text-soft-foreground">{dirOf(file.path)}</span>
                <span className={cn('ml-auto w-3 shrink-0 text-center font-mono text-[11px]', STATUS[file.status].tone)} aria-label={STATUS[file.status].label}>{STATUS[file.status].letter}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        {!loading && !error ? (
          <Button variant="outline" size="sm" asChild className="mx-2">
            <Link to={tree.kind === 'main' ? '/git' : `/tasks/${tree.runId}/changes`}>Commit on the Git page</Link>
          </Button>
        ) : null}
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
