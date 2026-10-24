import { FileDiffIcon, GitCompareIcon, MinusIcon, PlusIcon, TriangleAlertIcon, Undo2Icon, XIcon } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'

import { ApiError } from '@/api/client'
import { useRepoCompare, useRepoIndex } from '@/api/repo-git'
import type { RepoDiscard, RepoIndexChange, RepoIndexFile } from '@open-mercato/cezar-api-client'
import { ContextSidebar } from '@/components/context-sidebar'
import { canPreviewMarkdown, Diff, type DiffHandle, type DiffMode } from '@/components/diff'
import { PageBody, PageToolbar } from '@/components/page'
import { Button } from '@/components/ui/button'
import { SidebarContent, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel } from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'
import { useIsDesktop } from '@/lib/use-desktop'

import { ChangesTree } from '../task-git/changes-tree'
import { DiffViewToggles } from '../task-git/diff-controls'
import { buildFileTree } from '../task-git/file-tree'
import { AnimatedDiffStat } from '../task-git/git-toolbar'
import { RepoEmpty } from './repo-empty'
import { useCloseSidebarSheet } from './repo-sidebar'
import { CommitBox, DiscardDialog, IndexFileList, OperationBanner, StashMenu, useIndexChange } from './repo-staging'

/**
 * The repo view's Changes segment: the MAIN checkout's index, Source-Control style (spec
 * 2026-10-24-git-view §3.3). The sidebar lists Staged and Changes with per-file stage, unstage
 * and discard, and the commit box commits the index only; the main area renders both sides
 * through the same `<Diff>` facade the task Changes tab uses, each hunk carrying its own Stage /
 * Unstage / Discard. A merge, rebase or cherry-pick git stopped in shows its conflicts with Abort
 * and Continue. `?compare=<branch>` turns the segment into "what that branch brings in" (§3.2).
 *
 * Below `md` the same rule as the task tab applies: unified+wrap forced.
 */
export function RepoChangesSection({ header }: { header: ReactNode }) {
  const [params, setParams] = useSearchParams()
  const compare = params.get('compare')
  if (compare) return <CompareSection header={header} target={compare} onClose={() => setParams({}, { replace: true })} />
  return <IndexSection header={header} />
}

function useDiffView() {
  const desktop = useIsDesktop()
  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(false)
  const [preview, setPreview] = useState(false)
  return {
    desktop,
    mode,
    wrap,
    preview,
    setMode,
    setWrap,
    setPreview,
    effectiveMode: (desktop ? mode : 'unified') as DiffMode,
    effectiveWrap: desktop ? wrap : true,
  }
}

const onError = (error: Error) => toast(error.message, { tone: 'danger' })

function IndexSection({ header }: { header: ReactNode }) {
  const index = useRepoIndex()
  const view = useDiffView()
  const change = useIndexChange()
  const [selected, setSelected] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState<{ change: RepoDiscard; label: string } | null>(null)
  const stagedRef = useRef<DiffHandle | null>(null)
  const unstagedRef = useRef<DiffHandle | null>(null)

  // A 409 is the server's answer ("not a git repository"), not an outage.
  const refused = index.isError && index.error instanceof ApiError && index.error.status === 409
  const staged = index.data?.staged ?? []
  const unstaged = index.data?.unstaged ?? []
  const all = useMemo(() => [...staged, ...unstaged], [staged, unstaged])
  const hasMarkdown = useMemo(() => all.some(canPreviewMarkdown), [all])
  const stat = useMemo(
    () => ({ adds: sum(all, 'adds'), dels: sum(all, 'dels'), files: new Set(all.map((file) => file.path)).size }),
    [all],
  )
  const conflicted = index.data?.conflicted ?? []
  const clean = staged.length === 0 && unstaged.length === 0 && conflicted.length === 0

  const select = (side: 'staged' | 'unstaged') => (path: string) => {
    setSelected(`${side}:${path}`)
    ;(side === 'staged' ? stagedRef : unstagedRef).current?.scrollToPath(path)
  }
  const discard = (pending: RepoDiscard, label: string) => setDiscarding({ change: pending, label })
  const run = (step: 'stage' | 'unstage', body: RepoIndexChange) => change.mutate({ step, change: body }, { onError })

  const stagedHunk = (path: string, hunk: string) => (
    <Button variant="ghost" size="xs" data-action="unstage-hunk" disabled={change.isPending} onClick={() => run('unstage', { path, hunk })}>
      <MinusIcon aria-hidden="true" />
      Unstage
    </Button>
  )
  const unstagedHunk = (path: string, hunk: string) => (
    <>
      <Button variant="ghost" size="xs" data-action="discard-hunk" onClick={() => discard({ path, hunk }, path)}>
        <Undo2Icon aria-hidden="true" />
        Discard
      </Button>
      <Button variant="ghost" size="xs" data-action="stage-hunk" disabled={change.isPending} onClick={() => run('stage', { path, hunk })}>
        <PlusIcon aria-hidden="true" />
        Stage
      </Button>
    </>
  )

  return (
    <section data-slot="repo-changes" className="flex min-h-0 flex-1 flex-col">
      <ContextSidebar>
        {header}
        <SidebarContent>
          {index.data ? (
            <SidebarGroup className="pt-0">
              <CommitBox index={index.data} />
            </SidebarGroup>
          ) : null}
          {conflicted.length ? (
            <SidebarGroup className="pt-0" data-slot="index-conflicted">
              <SidebarGroupLabel className="justify-between text-conflict">
                Merge conflicts
                <span className="font-mono tabular-nums">{conflicted.length}</span>
              </SidebarGroupLabel>
            </SidebarGroup>
          ) : null}
          {staged.length ? (
            <SidebarGroup className="pt-0">
              <SidebarGroupLabel>Staged changes · {staged.length}</SidebarGroupLabel>
              <SidebarGroupAction
                title="Unstage all"
                aria-label="Unstage all"
                data-action="unstage-all"
                onClick={() => run('unstage', { paths: staged.map((file) => file.path) })}
              >
                <MinusIcon aria-hidden="true" />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <IndexFileList side="staged" files={staged} selected={selected} onSelect={select('staged')} onDiscard={discard} />
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
          <SidebarGroup className="pt-0">
            <SidebarGroupLabel className="justify-between">
              Changes
              {unstaged.length > 0 ? <span className="mr-6 font-mono tabular-nums">{unstaged.length}</span> : null}
            </SidebarGroupLabel>
            {unstaged.length ? (
              <SidebarGroupAction
                title="Stage all"
                aria-label="Stage all"
                data-action="stage-all"
                onClick={() => run('stage', { paths: unstaged.map((file) => file.path) })}
              >
                <PlusIcon aria-hidden="true" />
              </SidebarGroupAction>
            ) : null}
            <SidebarGroupContent data-slot="changes-tree-pane">
              {index.isPending ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading changes…</p>
              ) : unstaged.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {index.isError ? 'Changes are unavailable.' : staged.length ? 'Everything is staged.' : 'Working tree clean.'}
                </p>
              ) : (
                <IndexFileList side="unstaged" files={unstaged} selected={selected} onSelect={select('unstaged')} onDiscard={discard} />
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </ContextSidebar>

      <PageToolbar data-slot="repo-changes-toolbar" className="gap-x-3 pt-4">
        <h1 className="text-[15px] font-semibold text-foreground">Uncommitted changes</h1>
        {index.data ? <AnimatedDiffStat stat={stat} /> : null}
        <span className="ml-auto flex items-center gap-2">
          {index.data ? <StashMenu /> : null}
          {/* Same rule as the task toolbar: toggles exist ≥md only — phones force unified+wrap. */}
          <span className="hidden items-center gap-1 md:flex">
            <DiffViewToggles
              mode={view.mode}
              wrap={view.wrap}
              preview={view.preview}
              onModeChange={view.setMode}
              onWrapChange={view.setWrap}
              onPreviewChange={hasMarkdown ? view.setPreview : undefined}
            />
          </span>
        </span>
      </PageToolbar>

      {index.isPending ? (
        <PageBody data-slot="changes-loading" className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
          <Spinner />
          Loading changes…
        </PageBody>
      ) : index.isError ? (
        <RepoEmpty
          icon={refused ? <FileDiffIcon /> : <TriangleAlertIcon />}
          tone={refused ? 'neutral' : 'danger'}
          title={refused ? 'No changes to show' : 'Could not load the changes'}
          description={index.error.message}
        />
      ) : clean && !index.data.operation ? (
        <RepoEmpty
          icon={<FileDiffIcon />}
          title="Working tree clean"
          description="No uncommitted changes in the main working tree. Edits show up here as they happen."
        />
      ) : (
        <PageBody className="flex flex-col gap-6 [--diff-sticky-top:0rem]">
          <OperationBanner index={index.data} />
          {staged.length ? (
            <div data-slot="staged-diff" className="flex flex-col gap-2">
              <h2 className="text-[13px] font-medium text-muted-foreground">Staged</h2>
              <Diff
                files={staged}
                viewRef={stagedRef}
                mode={view.effectiveMode}
                wrap={view.effectiveWrap}
                preview={view.desktop && hasMarkdown && view.preview}
                hunkActions={stagedHunk}
                className="min-w-0"
              />
            </div>
          ) : null}
          {unstaged.length ? (
            <div data-slot="unstaged-diff" className="flex flex-col gap-2">
              {staged.length ? <h2 className="text-[13px] font-medium text-muted-foreground">Changes</h2> : null}
              <Diff
                files={unstaged}
                viewRef={unstagedRef}
                mode={view.effectiveMode}
                wrap={view.effectiveWrap}
                preview={view.desktop && hasMarkdown && view.preview}
                hunkActions={unstagedHunk}
                className="min-w-0"
              />
            </div>
          ) : null}
        </PageBody>
      )}
      <DiscardDialog pending={discarding} onClose={() => setDiscarding(null)} />
    </section>
  )
}

function sum(files: RepoIndexFile[], key: 'adds' | 'dels'): number {
  return files.reduce((total, file) => total + file[key], 0)
}

/** "Compare with current": what `target` brings in over the checked-out branch, from their
 *  merge-base against the freshest copy of the current branch. */
function CompareSection({ header, target, onClose }: { header: ReactNode; target: string; onClose: () => void }) {
  const compare = useRepoCompare(target)
  const view = useDiffView()
  const [selected, setSelected] = useState<string | null>(null)
  const diffRef = useRef<DiffHandle | null>(null)
  const files = compare.data?.files ?? []
  const tree = useMemo(() => buildFileTree(files), [files])
  const hasMarkdown = useMemo(() => files.some(canPreviewMarkdown), [files])
  return (
    <section data-slot="repo-compare" className="flex min-h-0 flex-1 flex-col">
      <ContextSidebar>
        {header}
        <SidebarContent>
          <SidebarGroup className="pt-0">
            <SidebarGroupLabel className="justify-between">
              {target}
              {files.length > 0 ? <span className="font-mono tabular-nums">{files.length}</span> : null}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              {files.length ? (
                <CompareTree
                  tree={tree}
                  selected={selected}
                  onSelect={(path) => {
                    setSelected(path)
                    diffRef.current?.scrollToPath(path)
                  }}
                />
              ) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{compare.isPending ? 'Comparing…' : 'Nothing to bring in.'}</p>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </ContextSidebar>
      <PageToolbar data-slot="repo-compare-toolbar" className="gap-x-3 pt-4">
        <GitCompareIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <h1 className="min-w-0 truncate text-[15px] font-semibold text-foreground">
          <span className="font-mono">{target}</span>
          {compare.data ? (
            <span className="font-normal text-muted-foreground">
              {' '}
              vs <span className="font-mono">{compare.data.against}</span> · from {compare.data.mergeBase.slice(0, 8)}
            </span>
          ) : null}
        </h1>
        {compare.data ? <AnimatedDiffStat stat={compare.data.stat} /> : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1 md:flex">
            <DiffViewToggles
              mode={view.mode}
              wrap={view.wrap}
              preview={view.preview}
              onModeChange={view.setMode}
              onWrapChange={view.setWrap}
              onPreviewChange={hasMarkdown ? view.setPreview : undefined}
            />
          </span>
          <Button variant="outline" size="sm" data-action="close-compare" onClick={onClose}>
            <XIcon aria-hidden="true" />
            Close
          </Button>
        </span>
      </PageToolbar>
      {compare.isPending ? (
        <PageBody className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
          <Spinner />
          Comparing…
        </PageBody>
      ) : compare.isError ? (
        <RepoEmpty icon={<TriangleAlertIcon />} tone="danger" title="Could not compare" description={compare.error.message} />
      ) : files.length === 0 ? (
        <RepoEmpty icon={<GitCompareIcon />} title="Nothing to bring in" description={`${target} has no changes the current branch lacks.`} />
      ) : (
        <PageBody className="[--diff-sticky-top:0rem]">
          <Diff
            files={files}
            viewRef={diffRef}
            mode={view.effectiveMode}
            wrap={view.effectiveWrap}
            preview={view.desktop && hasMarkdown && view.preview}
            className="min-w-0"
          />
        </PageBody>
      )}
    </section>
  )
}

function CompareTree({ tree, selected, onSelect }: { tree: ReturnType<typeof buildFileTree>; selected: string | null; onSelect: (path: string) => void }) {
  const closeSheet = useCloseSidebarSheet()
  return (
    <ChangesTree
      root={tree}
      selected={selected}
      onSelect={(path) => {
        closeSheet()
        onSelect(path)
      }}
    />
  )
}
