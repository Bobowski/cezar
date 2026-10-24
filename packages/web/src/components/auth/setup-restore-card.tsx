import { ArchiveRestoreIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { BackupJob } from '@open-mercato/cezar-api-client'
import { fetchAuthSession } from '@/api/auth'
import { getSetupRestoreJob, restoreFromSetup } from '@/api/backup'
import { ApiError } from '@/api/client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { JobLog, RestoreForm } from '@/routes/settings/backup-section'
import { errorText } from './auth-frame'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `/setup`'s second card (spec `2026-10-23-backup-restore.md` §4): restore a backup into a fresh
 * cockpit instead of creating an owner. The setup code gates it; the job's id is the only handle
 * the page has until the restored owner can sign in.
 */
export function SetupRestoreCard({ setupCode, onDone }: { setupCode: string; onDone: () => void }) {
  const [job, setJob] = useState<BackupJob | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!jobId) return
    let stopped = false
    void (async () => {
      let last: BackupJob | null = null
      for (;;) {
        if (stopped) return
        try {
          last = await getSetupRestoreJob(jobId)
          setJob(last)
          if (last.status === 'failed') {
            setBusy(false)
            return
          }
          // `restarting`: keep asking until the job is gone — that is the fresh process answering.
          if (last.status === 'done') break
        } catch (cause) {
          // The process that ran the job is gone: it restarted into the restored state.
          if (cause instanceof ApiError && cause.status === 404 && last) break
          if (!(cause instanceof ApiError) || cause.status !== 0) {
            setError(errorText(cause))
            setBusy(false)
            return
          }
        }
        await sleep(1_000)
      }
      // Wait for a cockpit that answers again, then hand over to the sign-in screen.
      for (let attempt = 0; attempt < 180 && !stopped; attempt++) {
        const session = await fetchAuthSession()
        if (!session.unanswered) {
          if (session.setupRequired) {
            setNote('Restored. This backup holds no owner account — create one above.')
            setBusy(false)
            return
          }
          onDone()
          return
        }
        await sleep(1_000)
      }
    })()
    return () => {
      stopped = true
    }
  }, [jobId, onDone])

  return (
    <Card data-slot="setup-restore">
      <CardHeader>
        <CardTitle>
          <h2 className="flex items-center gap-2 text-base">
            <ArchiveRestoreIcon aria-hidden="true" className="size-4" />
            Restore from a backup
          </h2>
        </CardTitle>
        <CardDescription className="text-pretty">
          Moving to a new machine? Upload a cezar backup and its key. The owner account comes from the backup, and you sign in
          with it afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {setupCode.trim() === '' ? (
          <p className="text-xs text-muted-foreground">Paste the setup code above first — it is what lets this page restore.</p>
        ) : null}
        <RestoreForm
          busy={busy || setupCode.trim() === ''}
          submitLabel="Restore this cockpit"
          onRestore={(archive, identity) => {
            setBusy(true)
            setError(null)
            setNote(null)
            setJob(null)
            restoreFromSetup(archive, identity, setupCode.trim())
              .then(setJobId)
              .catch((cause: unknown) => {
                setError(errorText(cause))
                setBusy(false)
              })
          }}
        />
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        {note ? <p className="text-xs text-foreground">{note}</p> : null}
        {job ? <JobLog job={job} /> : null}
      </CardContent>
    </Card>
  )
}
