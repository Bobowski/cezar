import { useQuery } from '@tanstack/react-query'
import { ChevronsDownUpIcon, FilePlusIcon, FolderPlusIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { queryScope, type ChangedFile, type CodeSearchMatch } from '@open-mercato/cezar-api-client'
import { searchCode, treeKey, type CodeTree } from '@/api/code'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { RepoFileBrowser } from '@/routes/repo-git/repo-files'

/**
 * The Code page's sidebar views (spec 2026-10-11-code-page): the explorer, search across files,
 * and source control — the three an editor's activity bar switches between.
 */

function ViewHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 px-3">
      <h2 className="mr-auto text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
      {children}
    </div>
  )
}

export function ExplorerView({
  paths, loading, error, selected, marks, canEdit, onSelect, onOpen, onContextMenu, onNewFile, onNewFolder, onRefresh,
}: {
  paths: readonly string[]
  loading: boolean
  error: string | null
  selected: string | null
  marks: ReadonlyMap<string, string>
  canEdit: boolean
  onSelect: (path: string) => void
  onOpen: (path: string) => void
  onContextMenu: (event: React.MouseEvent, target: { kind: 'file' | 'dir'; path: string }) => void
  onNewFile: () => void
  onNewFolder: () => void
  onRefresh: () => void
}) {
  const [collapse, setCollapse] = useState(0)
  return (
    <div data-slot="code-explorer" className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Explorer">
        {canEdit ? (
          <>
            <Button variant="ghost" size="icon-xs" aria-label="New File…" title="New File…" onClick={onNewFile}><FilePlusIcon aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="New Folder…" title="New Folder…" onClick={onNewFolder}><FolderPlusIcon aria-hidden="true" /></Button>
          </>
        ) : null}
        <Button variant="ghost" size="icon-xs" aria-label="Refresh Explorer" title="Refresh Explorer" onClick={onRefresh}><RefreshCwIcon aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon-xs" aria-label="Collapse Folders" title="Collapse Folders" onClick={() => setCollapse((value) => value + 1)}><ChevronsDownUpIcon aria-hidden="true" /></Button>
      </ViewHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading files…</p> : null}
        {error ? <p role="alert" className="px-2 py-1.5 text-xs text-danger">{error}</p> : null}
        {!loading && !error ? (
          <RepoFileBrowser
            paths={paths}
            selected={selected}
            marks={marks}
            collapseSignal={collapse}
            onSelect={onSelect}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
          />
        ) : null}
      </div>
    </div>
  )
}

/** Results grouped by file, in the order the server found them. */
export function groupMatches(matches: readonly CodeSearchMatch[]): Array<{ path: string; matches: CodeSearchMatch[] }> {
  const groups = new Map<string, CodeSearchMatch[]>()
  for (const match of matches) groups.set(match.path, [...(groups.get(match.path) ?? []), match])
  return [...groups].map(([path, found]) => ({ path, matches: found }))
}

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
  const toggle = (on: boolean) => cn('rounded-md px-1.5 py-1 font-mono text-xs', on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')
  return (
    <div data-slot="code-search" className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Search" />
      <form
        role="search"
        className="flex shrink-0 flex-col gap-1.5 px-3 pb-2"
        onSubmit={(event) => { event.preventDefault(); if (text.trim() !== '') setAsked({ q: text, glob, regex, caseSensitive }) }}
      >
        <div className="flex items-center gap-1">
          <Input ref={inputRef} aria-label="Search in files" value={text} onChange={(event) => setText(event.target.value)} placeholder="Search" spellCheck={false} autoComplete="off" className="h-8 min-w-0 flex-1 font-mono text-xs" />
          <button type="button" aria-pressed={caseSensitive} title="Match Case" className={toggle(caseSensitive)} onClick={() => setCaseSensitive((value) => !value)}>Aa</button>
          <button type="button" aria-pressed={regex} title="Use Regular Expression" className={toggle(regex)} onClick={() => setRegex((value) => !value)}>.*</button>
        </div>
        <Input aria-label="Files to include" value={glob} onChange={(event) => setGlob(event.target.value)} placeholder="files to include, e.g. src/**/*.ts" spellCheck={false} autoComplete="off" className="h-8 font-mono text-xs" />
        <button type="submit" className="sr-only">Search</button>
      </form>
      <div data-slot="code-search-results" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-xs">
        {result.isFetching ? <p className="px-1 text-muted-foreground">Searching…</p> : null}
        {result.isError ? <p role="alert" className="px-1 text-danger">{result.error.message}</p> : null}
        {result.data && !result.isFetching ? (
          <p role="status" className="px-1 pb-1 text-muted-foreground">
            {result.data.matches.length === 0 ? 'No results.' : `${result.data.matches.length} result${result.data.matches.length === 1 ? '' : 's'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`}
            {result.data.truncated ? ' — more exist; narrow the search.' : ''}
          </p>
        ) : null}
        {groups.map((group) => (
          <div key={group.path} className="pb-1">
            <button type="button" className="w-full truncate rounded-md px-1 py-0.5 text-left font-medium text-foreground hover:bg-accent" title={group.path} onClick={() => onOpen(group.path)}>
              {group.path.slice(group.path.lastIndexOf('/') + 1)}
              <span className="pl-1.5 font-normal text-soft-foreground">{group.path.slice(0, Math.max(0, group.path.lastIndexOf('/')))}</span>
            </button>
            {group.matches.map((match) => (
              <button
                key={`${match.line}:${match.text}`}
                type="button"
                className="flex w-full gap-2 rounded-md px-1 py-0.5 pl-3 text-left font-mono text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onOpen(match.path, match.line)}
              >
                <span className="min-w-0 truncate whitespace-pre">{match.text.trimStart()}</span>
                <span className="ml-auto shrink-0 tabular-nums text-soft-foreground">{match.line}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
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
    <div data-slot="code-scm" className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Source Control" />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[13px]">
        {loading ? <p className="px-1 text-xs text-muted-foreground">Loading changes…</p> : null}
        {error ? <p role="alert" className="px-1 text-xs text-danger">{error}</p> : null}
        {!loading && !error ? (
          <>
            <p className="flex items-center justify-between px-1 pb-1 text-xs text-muted-foreground">
              <span>Changes{files.length > 0 ? ` (${files.length})` : ''}</span>
              <Link to={tree.kind === 'main' ? '/git' : `/tasks/${tree.runId}/changes`} className="underline-offset-2 hover:text-foreground hover:underline">
                Commit on the Git page
              </Link>
            </p>
            {files.length === 0 ? <p className="px-1 text-xs text-muted-foreground">No changes since the last commit.</p> : null}
            <ul aria-label="Changed files">
              {files.map((file) => (
                <li key={file.path} className="group flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-accent">
                  <button type="button" className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left" title={`${file.path} — ${STATUS[file.status].label}`} onClick={() => onOpenDiff(file.path)}>
                    <span className={cn('truncate', file.status === 'deleted' && 'line-through')}>{file.path.slice(file.path.lastIndexOf('/') + 1)}</span>
                    <span className="min-w-0 truncate text-xs text-soft-foreground">{file.path.slice(0, Math.max(0, file.path.lastIndexOf('/')))}</span>
                  </button>
                  {file.status !== 'deleted' ? (
                    <button type="button" className="hidden shrink-0 text-xs text-muted-foreground hover:text-foreground group-hover:block" onClick={() => onOpenFile(file.path)}>Open file</button>
                  ) : null}
                  <span className={cn('w-3 shrink-0 text-center font-mono text-[11px]', STATUS[file.status].tone)} aria-label={STATUS[file.status].label}>{STATUS[file.status].letter}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  )
}
