import { ArchiveIcon, ArchiveRestoreIcon, FileWarningIcon, MinusIcon, PlusIcon, Undo2Icon } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import {
  changeIndex,
  commitIndex,
  popStash,
  pushStash,
  runOperation,
  useRepoGitAction,
  useRepoStashes,
  type IndexStep,
} from '@/api/repo-git'
import type { RepoIndex, RepoIndexChange, RepoIndexFile } from '@open-mercato/cezar-api-client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { useAnnounce } from './branch-actions'
import { useCloseSidebarSheet } from './repo-sidebar'

const onError = (error: Error) => toast(error.message, { tone: 'danger' })

/** Stage / unstage / discard, files or one hunk. Discard always goes through `confirmDiscard`. */
export function useIndexChange() {
  return useRepoGitAction(({ step, change }: { step: IndexStep; change: RepoIndexChange }) => changeIndex(step, change))
}

const STATUS_LETTER: Record<RepoIndexFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
}

/** One side of the index as the sidebar lists it, VS Code style: a row per file with its actions. */
export function IndexFileList({
  side,
  files,
  selected,
  onSelect,
  onDiscard,
}: {
  side: 'staged' | 'unstaged'
  files: RepoIndexFile[]
  selected: string | null
  onSelect: (path: string) => void
  onDiscard: (change: RepoIndexChange, label: string) => void
}) {
  const closeSheet = useCloseSidebarSheet()
  const change = useIndexChange()
  return (
    <SidebarMenu data-slot={`index-${side}`}>
      {files.map((file) => {
        const name = file.path.split('/').pop() ?? file.path
        const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, '')
        return (
          <SidebarMenuItem key={file.path} data-slot="index-file" data-path={file.path} className="group/index">
            <SidebarMenuButton
              isActive={selected === `${side}:${file.path}`}
              title={file.path}
              className="pr-14"
              onClick={() => {
                closeSheet()
                onSelect(file.path)
              }}
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                {name}
                {dir ? <span className="ml-1.5 text-xs text-muted-foreground">{dir}</span> : null}
              </span>
              <span
                className={cn(
                  'shrink-0 font-mono text-[11px]',
                  file.status === 'deleted' ? 'text-danger' : file.status === 'added' ? 'text-success' : 'text-muted-foreground',
                )}
              >
                {file.untracked ? 'U' : STATUS_LETTER[file.status]}
              </span>
            </SidebarMenuButton>
            {side === 'unstaged' ? (
              <>
                <SidebarMenuAction
                  showOnHover
                  className="right-7"
                  aria-label={`Discard changes to ${file.path}`}
                  data-action="discard-file"
                  onClick={() => onDiscard({ paths: [file.path] }, file.path)}
                >
                  <Undo2Icon aria-hidden="true" />
                </SidebarMenuAction>
                <SidebarMenuAction
                  showOnHover
                  aria-label={`Stage ${file.path}`}
                  data-action="stage-file"
                  disabled={change.isPending}
                  onClick={() => change.mutate({ step: 'stage', change: { paths: [file.path] } }, { onError })}
                >
                  <PlusIcon aria-hidden="true" />
                </SidebarMenuAction>
              </>
            ) : (
              <SidebarMenuAction
                showOnHover
                aria-label={`Unstage ${file.path}`}
                data-action="unstage-file"
                disabled={change.isPending}
                onClick={() => change.mutate({ step: 'unstage', change: { paths: [file.path] } }, { onError })}
              >
                <MinusIcon aria-hidden="true" />
              </SidebarMenuAction>
            )}
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}

/** "Discard … ?" — the one destructive index action, always confirmed. */
export function DiscardDialog({
  pending,
  onClose,
}: {
  pending: { change: RepoIndexChange; label: string } | null
  onClose: () => void
}) {
  const change = useIndexChange()
  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent data-slot="discard-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard these changes?</AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.change.hunk ? 'This change' : 'The unstaged changes'} to <span className="font-mono">{pending?.label}</span>{' '}
            are thrown away. An untracked file is deleted. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep them</AlertDialogCancel>
          <AlertDialogAction
            data-action="confirm-discard"
            className="bg-danger text-danger-foreground hover:bg-danger/90"
            disabled={change.isPending}
            onClick={() => {
              if (pending) change.mutate({ step: 'discard', change: pending.change }, { onError })
              onClose()
            }}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Commit the index (never the unstaged rest); Amend rewrites the last commit while no remote has it. */
export function CommitBox({ index }: { index: RepoIndex }) {
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const commit = useRepoGitAction(() => commitIndex({ message, ...(amend ? { amend: true } : {}) }))
  const nothingStaged = index.staged.length === 0 && !amend && !index.operation
  const submit = (event: FormEvent) => {
    event.preventDefault()
    commit.mutate(undefined, {
      onSuccess: (result) => {
        toast(result.message)
        setMessage('')
        setAmend(false)
      },
      onError,
    })
  }
  const amendRefused = !index.hasHead ? 'Nothing to amend yet' : index.headPushed ? 'The last commit is already on a remote' : null
  return (
    <form data-slot="commit-box" onSubmit={submit} className="flex flex-col gap-2 px-2 pb-2">
      <Textarea
        aria-label="Commit message"
        placeholder={index.branch ? `Message (commit to ${index.branch})` : 'Commit message'}
        value={message}
        rows={2}
        className="min-h-14 resize-y text-[13px]"
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event)
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          data-action="commit-index"
          className="flex-1"
          disabled={commit.isPending || nothingStaged || (!amend && !message.trim())}
        >
          {amend ? 'Amend last commit' : `Commit${index.staged.length ? ` ${index.staged.length} staged` : ''}`}
        </Button>
        <span className="flex items-center gap-1.5" title={amendRefused ?? 'Rewrite the last commit with the staged changes'}>
          <Checkbox id="commit-amend" checked={amend} disabled={amendRefused !== null} onCheckedChange={(value) => setAmend(value === true)} />
          <Label htmlFor="commit-amend" className="text-xs font-normal text-muted-foreground">
            Amend
          </Label>
        </span>
      </div>
    </form>
  )
}

/** A merge, rebase or cherry-pick git stopped in: the conflicted files (open with the markers in
 *  the editor) and Abort / Continue. Nothing is resolved for the user. */
export function OperationBanner({ index }: { index: RepoIndex }) {
  const announce = useAnnounce()
  const step = useRepoGitAction((which: 'abort' | 'continue') => runOperation(which))
  const op = index.operation
  if (!op) return null
  const verb = op.kind === 'cherry-pick' ? 'Cherry-pick' : op.kind[0]!.toUpperCase() + op.kind.slice(1)
  return (
    <Alert data-slot="repo-operation" data-operation={op.kind} className="border-conflict/50">
      <FileWarningIcon aria-hidden="true" />
      <AlertTitle>
        {verb} in progress{op.onto ? <span className="font-mono font-normal text-muted-foreground"> · {op.onto}</span> : null}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {index.conflicted.length ? (
          <>
            <span>Resolve the conflicts, stage the files, then Continue.</span>
            <ul data-slot="conflicted-files" className="flex flex-col gap-0.5">
              {index.conflicted.map((path) => (
                <li key={path}>
                  <Link to={`/code/${path.split('/').map(encodeURIComponent).join('/')}`} className="font-mono text-[12.5px] text-foreground underline-offset-2 hover:underline">
                    {path}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <span>No conflicts left — Continue to finish.</span>
        )}
        <span className="flex gap-2">
          <Button
            size="sm"
            data-action="continue-operation"
            disabled={step.isPending || index.conflicted.length > 0}
            onClick={() => step.mutate('continue', { onSuccess: announce, onError })}
          >
            Continue
          </Button>
          <Button size="sm" variant="outline" data-action="abort-operation" disabled={step.isPending} onClick={() => step.mutate('abort', { onSuccess: announce, onError })}>
            Abort
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  )
}

/** Stash the working tree, and the stash list with Pop. */
export function StashMenu() {
  const stashes = useRepoStashes()
  const announce = useAnnounce()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [untracked, setUntracked] = useState(false)
  const push = useRepoGitAction(() => pushStash({ ...(message.trim() ? { message: message.trim() } : {}), includeUntracked: untracked }))
  const pop = useRepoGitAction((n: number) => popStash(n))
  const list = stashes.data?.stashes ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" data-action="stash-menu">
          <ArchiveIcon aria-hidden="true" />
          Stash{list.length ? ` · ${list.length}` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" data-slot="stash-menu">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            push.mutate(undefined, {
              onSuccess: (result) => {
                toast(result.message)
                setMessage('')
              },
              onError,
            })
          }}
        >
          <Input aria-label="Stash message" placeholder="Stash message (optional)" value={message} onChange={(event) => setMessage(event.target.value)} />
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Checkbox id="stash-untracked" checked={untracked} onCheckedChange={(value) => setUntracked(value === true)} />
              <Label htmlFor="stash-untracked" className="text-xs font-normal">
                Include untracked files
              </Label>
            </span>
            <Button type="submit" size="sm" data-action="stash-push" disabled={push.isPending}>
              Stash
            </Button>
          </div>
        </form>
        {list.length ? (
          <ul data-slot="stash-list" className="-mx-2 mt-3 flex max-h-64 flex-col overflow-y-auto border-t pt-2">
            {list.map((entry) => (
              <li key={entry.index} data-stash={entry.index} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]" title={entry.message}>
                    {entry.message}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    stash@{'{'}
                    {entry.index}
                    {'}'} · {entry.when}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  data-action="stash-pop"
                  disabled={pop.isPending}
                  onClick={() => pop.mutate(entry.index, { onSuccess: announce, onError })}
                >
                  <ArchiveRestoreIcon aria-hidden="true" />
                  Pop
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">No stashes.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
