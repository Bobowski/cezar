import { useState } from 'react'

import type { SelfUpdateStatus, UpdateBranch, UpdateCommit } from '@open-mercato/cezar-api-client'
import { isUpdateBranchName, isUpdateRemote } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { offerWhenIdle, WhenIdleButton } from './self-update-when-idle'

/**
 * The `branch` channel (spec 2026-10-23 §3.7): which branch cezar follows, the commit it runs, the
 * tip of the last fetch and how far apart they are — plus the two things a code update cannot do
 * for itself, said plainly: a rebuild of the image when the pending commits touch `docker/`, and a
 * note when the branch was rewritten under the running build.
 */
export function BranchPanel({
  data,
  checking,
  onCheck,
  onApply,
  onSchedule,
  onEditBranch,
  applying,
}: {
  data: SelfUpdateStatus
  checking: boolean
  onCheck: () => void
  onApply: (target: string) => void
  onSchedule: (target: string) => void
  onEditBranch: () => void
  applying: boolean
}) {
  const branch = data.branch
  const jobBusy = data.job?.status === 'running' || data.job?.status === 'restarting'
  const target = data.updateAvailable
  if (!branch) return null
  return (
    <div
      data-slot="self-update-branch"
      className={cn(
        'flex min-w-0 flex-col gap-2.5 rounded-lg border px-4 py-3 text-[13px] shadow-xs',
        target ? 'border-transparent bg-primary/15' : 'border-border bg-card',
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 break-words">
          Following <span className="font-mono font-semibold">{branch.branch}</span>
          <div className="truncate font-mono text-xs text-muted-foreground" title={branch.remote}>
            {branch.remote}
          </div>
        </div>
        {data.channelEditable ? (
          <Button variant="ghost" size="sm" onClick={onEditBranch} disabled={jobBusy}>
            Change
          </Button>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Running</dt>
        <dd className="min-w-0 break-words">
          {branch.running ? <CommitLine commit={branch.running} /> : 'a build not made from this branch'}
        </dd>
        <dt className="text-muted-foreground">Tip</dt>
        <dd className="min-w-0 break-words">{branch.tip ? <CommitLine commit={branch.tip} /> : 'not fetched yet'}</dd>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-[12rem] flex-1">
          {branch.tip ? (
            branch.behind === 0 ? (
              <span>Up to date.</span>
            ) : (
              <span>
                <span className="font-semibold">
                  {branch.behind} commit{branch.behind === 1 ? '' : 's'} behind
                </span>
                {target ? <span className="text-muted-foreground"> · builds as {target}</span> : null}
              </span>
            )
          ) : (
            <span className="text-muted-foreground">Nothing fetched yet.</span>
          )}
          {branch.fetchedAt ? (
            <div className="text-xs text-muted-foreground">checked {new Date(branch.fetchedAt).toLocaleTimeString()}</div>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCheck} disabled={checking || jobBusy}>
            {checking ? 'Checking…' : 'Check'}
          </Button>
          {offerWhenIdle(data, target) ? (
            <WhenIdleButton
              doing={`builds ${target} now, switches to it`}
              onClick={() => onSchedule(target)}
              disabled={!data.canSelfUpdate || applying || jobBusy}
            />
          ) : null}
          {target ? (
            <Button size="sm" onClick={() => onApply(target)} disabled={!data.canSelfUpdate || applying || jobBusy}>
              Update
            </Button>
          ) : null}
        </div>
      </div>

      {branch.error ? (
        <p data-slot="self-update-branch-error" className="text-xs text-danger">
          The last fetch failed: {branch.error}
        </p>
      ) : null}
      {branch.touchesImage.length > 0 ? (
        <p data-slot="self-update-branch-image" className="rounded-md bg-pending/10 px-2.5 py-1.5 text-xs text-foreground">
          These commits also change <span className="font-mono">{branch.touchesImage.join(', ')}</span> — rebuild the
          image over ssh when convenient. The code update still applies.
        </p>
      ) : null}
      {branch.running && branch.tip && !branch.fastForward ? (
        <p data-slot="self-update-branch-rewritten" className="text-xs text-muted-foreground">
          The running build is not an ancestor of the tip: the branch was force-pushed or rebased since.
        </p>
      ) : null}
      {data.activeRuns > 0 && target ? (
        <p className="text-xs text-muted-foreground">
          The build starts at once; the switch waits until no task is running.
        </p>
      ) : null}
    </div>
  )
}

function CommitLine({ commit }: { commit: UpdateCommit }) {
  return (
    <>
      <span className="font-mono">{commit.sha.slice(0, 8)}</span> {commit.subject}{' '}
      <span className="text-muted-foreground">· {new Date(commit.at).toLocaleString()}</span>
    </>
  )
}

/** The remote and branch to follow — the trusted-operator write `PUT …/channel` accepts. */
export function BranchForm({
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: UpdateBranch | null
  busy: boolean
  onSubmit: (branch: UpdateBranch) => void
  onCancel: () => void
}) {
  const [remote, setRemote] = useState(initial?.remote ?? '')
  const [name, setName] = useState(initial?.branch ?? '')
  const valid = isUpdateRemote(remote.trim()) && isUpdateBranchName(name.trim())
  return (
    <form
      data-slot="self-update-branch-form"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 text-[13px]"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) onSubmit({ remote: remote.trim(), branch: name.trim() })
      }}
    >
      <div className="font-medium">Follow a branch</div>
      <p className="text-xs text-muted-foreground">
        cezar clones it, builds each update on this machine and switches when you click Update.
      </p>
      <Input
        aria-label="Remote"
        placeholder="https://github.com/open-mercato/cezar.git"
        value={remote}
        onChange={(event) => setRemote(event.target.value)}
        className="font-mono text-xs"
      />
      <Input
        aria-label="Branch"
        placeholder="main"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="font-mono text-xs"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>
          Follow
        </Button>
      </div>
    </form>
  )
}

/** Installed `branch` builds by commit, for a rollback by hand. */
export function BranchBuilds({
  data,
  onApply,
  applying,
}: {
  data: SelfUpdateStatus
  onApply: (id: string) => void
  applying: boolean
}) {
  const builds = data.installed.filter((entry) => entry.source === 'branch' || entry.source === 'image')
  const jobBusy = data.job?.status === 'running' || data.job?.status === 'restarting'
  if (builds.length === 0) return null
  return (
    <div data-slot="self-update-branch-builds" className="flex min-w-0 flex-col gap-1.5">
      <div className="text-[13.5px] font-medium">Builds on this machine</div>
      <ul className="flex min-w-0 flex-col gap-1">
        {builds.map((entry) => (
          <li key={entry.id} className="flex min-w-0 items-center justify-between gap-2 text-xs">
            <span className="min-w-0 break-words">
              <span className="font-mono">{entry.id}</span>
              {entry.commit ? <span className="text-muted-foreground"> · {entry.commit.subject || entry.commit.at.slice(0, 10)}</span> : null}
              {entry.source === 'image' ? <span className="text-muted-foreground"> · the image&apos;s own</span> : null}
            </span>
            {entry.active ? (
              <Badge variant="secondary">current</Badge>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Switch to ${entry.id}`}
                onClick={() => onApply(entry.id)}
                disabled={!data.canSelfUpdate || applying || jobBusy}
              >
                Switch
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
