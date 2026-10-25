import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CornerUpLeftIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'

import type { ApiRun, ChangedFile } from '@open-mercato/cezar-api-client'
import { Diff } from '@/components/diff'
import type { DiffNewLineComment } from '@/components/diff/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { isHttpUrl } from '@/lib/utils'

import type { DiffComments } from '../task-thread/diff-comments'
import { runActionFlags } from '../task-thread/run-actions'
import { useFinishRun } from '../task-thread/use-finish-run'
import { useRunActions } from '../task-thread/use-run-actions'
import { useRunGitStep } from './run-git-step'

/**
 * Changes on a phone (spec 2026-10-24-mobile-cockpit §3.3): one file at a time — the file list,
 * then that file's unified diff full screen with the comment gutter (tap a line to comment),
 * Previous / Next file, and the review actions as a bottom bar. Approve and Discard confirm.
 */

/** Where `path` sits among `files`, and its neighbours. `index` is -1 for a path not in the list. */
export function phoneFilePager(files: readonly Pick<ChangedFile, 'path'>[], path: string | null) {
  const index = path === null ? -1 : files.findIndex((file) => file.path === path)
  return {
    index,
    previous: index > 0 ? files[index - 1]!.path : null,
    next: index >= 0 && index < files.length - 1 ? files[index + 1]!.path : null,
  }
}

const baseName = (path: string) => path.split('/').at(-1) ?? path
const dirName = (path: string) => path.split('/').slice(0, -1).join('/')

export function PhoneChanges({
  run,
  files,
  selected,
  onSelect,
  diffComments,
  addComment,
  commentCounts,
  loadFileText,
  imageSrc,
  onRequestChanges,
}: {
  run: ApiRun
  files: readonly ChangedFile[]
  selected: string | null
  onSelect: (path: string | null) => void
  diffComments: DiffComments
  addComment: (comment: DiffNewLineComment) => boolean
  commentCounts: ReadonlyMap<string, number>
  loadFileText: (path: string) => Promise<string | null>
  imageSrc: (path: string) => string
  /** Bring up the composer, which sends the line comments with whatever is typed. */
  onRequestChanges: () => void
}) {
  const pager = phoneFilePager(files, selected)
  const file = pager.index >= 0 ? files[pager.index]! : null

  if (file === null) {
    return (
      <div data-slot="phone-changes" className="flex min-h-full flex-col">
        <ul data-slot="phone-file-list" className="flex-1 divide-y divide-border">
          {files.map((entry) => {
            const count = commentCounts.get(entry.path) ?? 0
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  data-slot="phone-file"
                  onClick={() => onSelect(entry.path)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{baseName(entry.path)}</span>
                    {dirName(entry.path) ? (
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{dirName(entry.path)}</span>
                    ) : null}
                  </span>
                  {count > 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs text-violet" aria-label={`${count} comments`}>
                      <MessageSquareIcon aria-hidden="true" className="size-3.5" />
                      {count}
                    </span>
                  ) : null}
                  <span className="shrink-0 font-mono text-xs tabular-nums">
                    <span className="text-success">+{entry.adds}</span> <span className="text-danger">−{entry.dels}</span>
                  </span>
                  <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-soft-foreground" />
                </button>
              </li>
            )
          })}
        </ul>
        <PhoneReviewBar run={run} onRequestChanges={onRequestChanges} />
      </div>
    )
  }

  return (
    <div
      data-slot="phone-file-view"
      role="dialog"
      aria-label={file.path}
      className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        <Button type="button" variant="ghost" size="sm" data-slot="phone-file-back" onClick={() => onSelect(null)} className="gap-1">
          <ChevronLeftIcon aria-hidden="true" /> Files
        </Button>
        <span className="min-w-0 flex-1 truncate text-center font-mono text-xs text-foreground" title={file.path}>
          {baseName(file.path)}
        </span>
        <span data-slot="phone-file-position" className="shrink-0 px-2 text-xs text-muted-foreground tabular-nums">
          {pager.index + 1} of {files.length}
        </span>
      </header>
      <div data-slot="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 [--diff-sticky-top:0px]">
        <Diff
          key={`${run.id}:${file.path}`}
          files={[file]}
          mode="unified"
          wrap
          loadFileText={loadFileText}
          imageSrc={imageSrc}
          comments={diffComments.comments.filter((comment) => comment.path === file.path)}
          onAddComment={diffComments.ready ? addComment : undefined}
          onEditComment={diffComments.update}
          onRemoveComment={diffComments.remove}
          className="min-w-0"
        />
      </div>
      <nav aria-label="Files" className="flex shrink-0 items-center gap-2 border-t border-border/70 px-3 py-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="phone-file-previous"
          disabled={pager.previous === null}
          onClick={() => onSelect(pager.previous)}
          className="flex-1"
        >
          <ChevronLeftIcon aria-hidden="true" /> Previous file
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="phone-file-next"
          disabled={pager.next === null}
          onClick={() => onSelect(pager.next)}
          className="flex-1"
        >
          Next file <ChevronRightIcon aria-hidden="true" />
        </Button>
      </nav>
      <PhoneReviewBar run={run} onRequestChanges={() => { onSelect(null); onRequestChanges() }} />
    </div>
  )
}

type Confirm = 'approve' | 'discard' | null

/** Approve, Request changes, Commit to base, Open draft PR, Discard — the review gate's exits. */
export function PhoneReviewBar({ run, onRequestChanges }: { run: ApiRun; onRequestChanges: () => void }) {
  const [confirm, setConfirm] = useState<Confirm>(null)
  const finish = useFinishRun(run.id)
  const actions = useRunActions(run, { surface: 'task_view' })
  const git = useRunGitStep(run)
  const flags = runActionFlags(run)
  const inReview = run.status === 'review'
  const prOpen = isHttpUrl(run.pullRequestUrl)
  const busy = git.pending !== null
  // The desktop's own trunk step (isTrunkTask → trunkGitActionPolicy): an in-place task in an
  // auto-land project with something to land, the agent not mid-turn. Anything else 409s.
  const canLand = git.action?.id === 'land' && git.action.enabled

  return (
    <div
      data-slot="phone-review-bar"
      className="sticky bottom-0 z-10 grid shrink-0 grid-cols-3 gap-1.5 border-t border-border/70 bg-background px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
    >
      <Button type="button" size="sm" variant="primary" data-slot="phone-approve" disabled={!inReview || finish.isPending} onClick={() => setConfirm('approve')}>
        <CheckIcon aria-hidden="true" /> Approve
      </Button>
      <Button type="button" size="sm" variant="outline" data-slot="phone-request-changes" onClick={onRequestChanges}>
        <CornerUpLeftIcon aria-hidden="true" /> Request changes
      </Button>
      <Button type="button" size="sm" variant="outline" data-slot="phone-commit-base" disabled={!canLand || busy} title={git.action?.id === 'land' ? git.action.reason : undefined} onClick={() => git.onAction('land')}>
        <GitMergeIcon aria-hidden="true" /> Commit to base
      </Button>
      {prOpen ? (
        <Button asChild size="sm" variant="outline" className="col-span-2">
          <a data-slot="phone-pr-link" href={run.pullRequestUrl} target="_blank" rel="noopener noreferrer">
            <GitPullRequestIcon aria-hidden="true" /> Open PR ↗
          </a>
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-slot="phone-draft-pr"
          disabled={!run.worktreePath || busy}
          onClick={() => git.onAction('create-draft-pr')}
          className="col-span-2"
        >
          <GitPullRequestIcon aria-hidden="true" /> Open draft PR
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-slot="phone-discard"
        disabled={!flags.deleteRun || actions.delete.isPending}
        onClick={() => setConfirm('discard')}
        className="text-danger"
      >
        <Trash2Icon aria-hidden="true" /> Discard
      </Button>
      {git.dialogs}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === 'discard' ? 'Discard this task?' : 'Approve these changes?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'discard'
                ? 'The task, its worktree and every change in it are deleted. This cannot be undone.'
                : 'The review is accepted and the task finishes. Nothing merges on its own.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction
              data-slot="phone-confirm"
              className={confirm === 'discard' ? 'bg-danger text-danger-foreground hover:brightness-[0.96]' : undefined}
              onClick={() => {
                if (confirm === 'discard') actions.delete.mutate()
                else finish.mutate()
                setConfirm(null)
              }}
            >
              {confirm === 'discard' ? 'Discard' : 'Approve'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
