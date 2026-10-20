import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDownIcon, LoaderCircleIcon } from 'lucide-react'

import { pullRepo } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { useRepoSync } from '@/api/repo-sync'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'

const commits = (count: number) => `${count} commit${count === 1 ? '' : 's'}`

/**
 * "The main checkout is behind origin", wherever that checkout is on screen: the Git page, the
 * Code page and the composer. Renders nothing while it is up to date. Behind only: one click
 * fast-forwards it. Diverged: says so, and leaves the merge to the user.
 */
export function RepoSyncChip() {
  const queryClient = useQueryClient()
  const sync = useRepoSync().data
  const pull = useMutation({
    mutationFn: pullRepo,
    onSuccess: (result) => {
      // `repo` prefix-matches the sync read, the diff and the tree; `code` is the Code page's own.
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
      void queryClient.invalidateQueries({ queryKey: ['code'] })
      toast(result.updated > 0 ? `Pulled ${commits(result.updated)} from ${result.sync.upstream}.` : 'Already up to date.')
    },
    onError: (error: Error) => toast(`Could not pull: ${error.message}`, { tone: 'danger' }),
  })
  if (!sync?.upstream || !sync.behind) return null
  if ((sync.ahead ?? 0) > 0) {
    return (
      <span
        data-slot="repo-sync-chip"
        data-state="diverged"
        title={`${sync.branch} and ${sync.upstream} have diverged: ${commits(sync.ahead ?? 0)} only here, ${commits(sync.behind)} only on origin. Merge or rebase by hand.`}
        className="shrink-0 rounded-sm border border-border px-1.5 py-px font-mono text-[11px] text-pending-strong"
      >
        ↓{sync.behind} ↑{sync.ahead}
      </span>
    )
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-slot="repo-sync-chip"
      data-state="behind"
      disabled={pull.isPending}
      title={`${sync.branch} is ${commits(sync.behind)} behind ${sync.upstream}. Pull fast-forwards the main checkout.`}
      aria-label={`Pull ${commits(sync.behind)} from ${sync.upstream}`}
      onClick={() => pull.mutate()}
      className="shrink-0 gap-1 font-mono text-[11px] text-pending-strong"
    >
      {pull.isPending ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : <ArrowDownIcon aria-hidden="true" />}
      {sync.behind}
    </Button>
  )
}
