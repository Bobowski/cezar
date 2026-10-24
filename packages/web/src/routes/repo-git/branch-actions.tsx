import {
  ArrowLeftRightIcon,
  ArrowUpIcon,
  GitCompareIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'

import {
  deleteBranch,
  pushBranchTo,
  renameBranch,
  runBranchAction,
  useRepoGitAction,
  useRepoRemotes,
  type BranchAction,
} from '@/api/repo-git'
import type { RepoGitActionResponse } from '@open-mercato/cezar-api-client'
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'

export interface BranchTarget {
  /** As the graph or the list names it: `main`, `origin/main`. */
  name: string
  kind: 'local' | 'remote'
  current: boolean
  /** A task owns it: renaming would orphan the run record's name. */
  isTask?: boolean
}

/** What every action's answer does in the cockpit: a toast, and a stopped merge sends the user to
 *  Changes, where the conflicts and Abort / Continue live. */
export function useAnnounce() {
  const navigate = useNavigate()
  return (result: RepoGitActionResponse) => {
    if (result.conflicts.length > 0) {
      toast(result.message, { tone: 'danger' })
      navigate('/git')
      return
    }
    toast(result.message)
  }
}

const onError = (error: Error) => toast(error.message, { tone: 'danger' })

/**
 * The branch actions of spec 2026-10-24-git-view §3.2 on one branch, as a dropdown around
 * `trigger`: Checkout, Merge into current, Rebase current onto, Compare with current, Rename,
 * Push to a named remote, Delete (local, and on its remote behind a second confirm).
 */
export function BranchActionsMenu({
  target,
  trigger,
  children,
  align = 'end',
  hideCheckout = false,
}: {
  target: BranchTarget
  trigger: ReactNode
  /** The Branches tab keeps its own Switch (`POST /repo/branch`) in `children`. */
  hideCheckout?: boolean
  /** Extra items above the separator (the Branches tab's base-branch picker, Copy name). */
  children?: ReactNode
  align?: 'start' | 'end'
}) {
  const navigate = useNavigate()
  const announce = useAnnounce()
  const remotes = useRepoRemotes()
  const action = useRepoGitAction((step: BranchAction) => runBranchAction(target.name, step))
  const push = useRepoGitAction((remote: string) => pushBranchTo(target.name, remote))
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const run = (step: BranchAction) => action.mutate(step, { onSuccess: announce, onError })
  const local = target.kind === 'local'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} data-slot="branch-actions" className="min-w-56">
          <DropdownMenuLabel className="truncate font-mono text-xs font-normal text-muted-foreground">{target.name}</DropdownMenuLabel>
          {hideCheckout ? null : (
            <DropdownMenuItem data-action="checkout-branch" disabled={target.current || action.isPending} onSelect={() => run('checkout')}>
              <ArrowLeftRightIcon aria-hidden="true" />
              Checkout
            </DropdownMenuItem>
          )}
          <DropdownMenuItem data-action="merge-branch" disabled={target.current || action.isPending} onSelect={() => run('merge')}>
            <GitMergeIcon aria-hidden="true" />
            Merge into current
          </DropdownMenuItem>
          <DropdownMenuItem data-action="rebase-onto" disabled={target.current || action.isPending} onSelect={() => run('rebase')}>
            <GitPullRequestArrowIcon aria-hidden="true" />
            Rebase current onto this
          </DropdownMenuItem>
          <DropdownMenuItem
            data-action="compare-branch"
            disabled={target.current}
            onSelect={() => navigate(`/git?compare=${encodeURIComponent(target.name)}`)}
          >
            <GitCompareIcon aria-hidden="true" />
            Compare with current
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {local ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-action="push-branch" disabled={!remotes.data?.remotes?.length}>
                <ArrowUpIcon aria-hidden="true" />
                Push to…
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {(remotes.data?.remotes ?? []).map((remote) => (
                  <DropdownMenuItem
                    key={remote.name}
                    data-remote={remote.name}
                    disabled={push.isPending}
                    onSelect={() => push.mutate(remote.name, { onSuccess: announce, onError })}
                  >
                    <span className="font-mono text-[12.5px]">{remote.name}</span>
                    {remote.name === remotes.data?.pushDefault ? (
                      <span className="ml-auto text-xs text-muted-foreground">push default</span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {local ? (
            <DropdownMenuItem data-action="rename-branch" disabled={target.isTask} onSelect={() => setRenaming(true)}>
              <PencilIcon aria-hidden="true" />
              Rename…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            data-action="delete-branch"
            disabled={target.current}
            className="text-danger focus:text-danger"
            onSelect={() => setDeleting(true)}
          >
            <Trash2Icon aria-hidden="true" />
            Delete…
          </DropdownMenuItem>
          {children ? (
            <>
              <DropdownMenuSeparator />
              {children}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming ? <RenameDialog name={target.name} onClose={() => setRenaming(false)} /> : null}
      {deleting ? <DeleteDialog target={target} onClose={() => setDeleting(false)} /> : null}
    </>
  )
}

function RenameDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const announce = useAnnounce()
  const [to, setTo] = useState(name)
  const rename = useRepoGitAction((next: string) => renameBranch(name, next))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = to.trim()
    if (!next || next === name) return
    rename.mutate(next, {
      onSuccess: (result) => {
        announce(result)
        onClose()
      },
      onError,
    })
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" data-slot="branch-rename">
          <DialogHeader>
            <DialogTitle>Rename branch</DialogTitle>
            <DialogDescription>
              Renames <span className="font-mono">{name}</span> locally. Its copy on a remote keeps the old name.
            </DialogDescription>
          </DialogHeader>
          <Input aria-label="New branch name" className="font-mono" value={to} onChange={(event) => setTo(event.target.value)} autoFocus />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!to.trim() || to.trim() === name || rename.isPending}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Local delete, with "also on the remote" as a second, explicit confirm; a remote-tracking
 *  branch can only be deleted on its remote. "Delete anyway" is offered once git says unmerged. */
function DeleteDialog({ target, onClose }: { target: BranchTarget; onClose: () => void }) {
  const announce = useAnnounce()
  const remoteOnly = target.kind === 'remote'
  const [alsoRemote, setAlsoRemote] = useState(false)
  const [confirmRemote, setConfirmRemote] = useState(false)
  const [unmerged, setUnmerged] = useState(false)
  const remove = useRepoGitAction((options: { remote: boolean; force: boolean }) => deleteBranch(target.name, options))
  const wantsRemote = remoteOnly || alsoRemote
  const go = (force: boolean) =>
    remove.mutate(
      { remote: wantsRemote, force },
      {
        onSuccess: (result) => {
          announce(result)
          onClose()
        },
        onError: (error) => {
          if (/not fully merged/.test(error.message)) setUnmerged(true)
          else onError(error)
        },
      },
    )
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent data-slot="branch-delete">
        <AlertDialogHeader>
          <AlertDialogTitle>{remoteOnly ? 'Delete the branch on its remote?' : 'Delete branch?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {remoteOnly ? (
              <>
                <span className="font-mono">{target.name}</span> is deleted on the remote for everyone. This is not undone by a
                fetch.
              </>
            ) : unmerged ? (
              <>
                <span className="font-mono">{target.name}</span> has commits no other branch has. Deleting it anyway loses them.
              </>
            ) : (
              <>
                Deletes <span className="font-mono">{target.name}</span> in this checkout.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!remoteOnly ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Checkbox id="delete-remote-too" checked={alsoRemote} onCheckedChange={(value) => setAlsoRemote(value === true)} />
              <Label htmlFor="delete-remote-too">Also delete it on its remote</Label>
            </div>
            {alsoRemote ? (
              <div className="flex items-center gap-2 pl-6">
                <Checkbox
                  id="delete-remote-confirm"
                  checked={confirmRemote}
                  onCheckedChange={(value) => setConfirmRemote(value === true)}
                />
                <Label htmlFor="delete-remote-confirm" className="text-danger">
                  Yes — delete it on the remote for everyone
                </Label>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Checkbox id="delete-remote-confirm" checked={confirmRemote} onCheckedChange={(value) => setConfirmRemote(value === true)} />
            <Label htmlFor="delete-remote-confirm" className="text-danger">
              Yes — delete it on the remote for everyone
            </Label>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            data-action="confirm-delete-branch"
            disabled={remove.isPending || (wantsRemote && !confirmRemote)}
            className="bg-danger text-danger-foreground hover:bg-danger/90"
            onClick={(event) => {
              event.preventDefault()
              go(unmerged)
            }}
          >
            {unmerged ? 'Delete anyway' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
