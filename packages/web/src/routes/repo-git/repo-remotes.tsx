import { RefreshCwIcon } from 'lucide-react'

import { fetchRemote, useRepoGitAction, useRepoRemotes } from '@/api/repo-git'
import type { RepoRemotes } from '@open-mercato/cezar-api-client'
import { PageSection } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'

/** Why a remote is the PR target / the push default, in the words `resolveTaskRemotes` decides by. */
const PR_TARGET_REASON: Record<NonNullable<RepoRemotes['reasons']['prTarget']>, string> = {
  'gh-default': 'chosen with gh repo set-default',
  'fork-parent': 'the repository origin was forked from',
  origin: 'origin',
  'first-remote': 'the first configured remote',
}
const PUSH_REASON: Record<NonNullable<RepoRemotes['reasons']['pushDefault']>, string> = {
  'push-default': 'remote.pushDefault',
  origin: 'origin',
  'pr-target': 'the PR target',
}

/**
 * The Branches tab's Remotes block (spec 2026-10-24-git-view §3.4): every remote, its URL, which
 * one pull requests target and which one branches are pushed to — and why — plus Fetch per remote.
 * Adding or removing a remote stays in the terminal: it is a configuration decision.
 */
export function RemotesBlock() {
  const remotes = useRepoRemotes()
  const fetch = useRepoGitAction((name: string) => fetchRemote(name))
  const note = 'text-[13px] text-muted-foreground'
  const data = remotes.data
  return (
    <PageSection title="Remotes" description="Where branches come from and go to. Add or remove remotes in a terminal.">
      <div data-slot="repo-remotes" className="flex flex-col gap-3">
        {remotes.isPending ? (
          <p className={note}>Loading remotes…</p>
        ) : remotes.isError ? (
          <p className={note}>{remotes.error.message}</p>
        ) : !data?.remotes?.length ? (
          <p className={note}>No remote configured.</p>
        ) : (
          data.remotes.map((remote) => (
            <div key={remote.name} data-slot="remote-row" data-remote={remote.name} className="flex flex-col gap-1 rounded-lg border px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-[13px] font-medium">{remote.name}</span>
                {remote.name === data.prTarget ? (
                  <Badge variant="secondary" className="font-normal" title={data.reasons.prTarget ? PR_TARGET_REASON[data.reasons.prTarget] : undefined}>
                    PR target
                  </Badge>
                ) : null}
                {remote.name === data.pushDefault ? (
                  <Badge variant="outline" className="font-normal" title={data.reasons.pushDefault ? PUSH_REASON[data.reasons.pushDefault] : undefined}>
                    Push default
                  </Badge>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  data-action="fetch-remote"
                  disabled={fetch.isPending}
                  onClick={() =>
                    fetch.mutate(remote.name, {
                      onSuccess: (result) => toast(result.message),
                      onError: (error) => toast(error.message, { tone: 'danger' }),
                    })
                  }
                >
                  {fetch.isPending && fetch.variables === remote.name ? <Spinner /> : <RefreshCwIcon aria-hidden="true" />}
                  Fetch
                </Button>
              </div>
              {remote.url ? (
                <p className="truncate font-mono text-xs text-muted-foreground" title={remote.url}>
                  {remote.url}
                </p>
              ) : null}
              {remote.pushUrl ? (
                <p className="truncate font-mono text-xs text-muted-foreground" title={remote.pushUrl}>
                  push: {remote.pushUrl}
                </p>
              ) : null}
              <p className="text-xs text-soft-foreground">
                {remote.branches.length} branch{remote.branches.length === 1 ? '' : 'es'}
                {remote.name === data.prTarget && data.reasons.prTarget ? ` · PR target: ${PR_TARGET_REASON[data.reasons.prTarget]}` : ''}
                {remote.name === data.pushDefault && data.reasons.pushDefault ? ` · pushed to: ${PUSH_REASON[data.reasons.pushDefault]}` : ''}
              </p>
            </div>
          ))
        )}
      </div>
    </PageSection>
  )
}

/** Which remotes have a branch of this name (`origin/x`, `upstream/x`). */
export function remotesHaving(remotes: RepoRemotes | undefined, branch: string): string[] {
  return (remotes?.remotes ?? []).filter((remote) => remote.branches?.includes(branch)).map((remote) => remote.name)
}
