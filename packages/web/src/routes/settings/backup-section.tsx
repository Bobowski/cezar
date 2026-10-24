import { DownloadIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import {
  AGE_RECIPIENT_RE,
  BACKUP_KEEP_DEFAULT,
  BACKUP_KEEP_MAX,
  type BackupJob,
  type BackupStatus,
} from '@open-mercato/cezar-api-client'
import {
  backupArchiveUrl,
  getBackupStatus,
  useBackupStatus,
  useRestoreBackupHere,
  useSetBackupRecipient,
  useSetBackupSchedule,
  useSetBackupTarget,
  useStartBackup,
  useTestBackupTarget,
} from '@/api/backup'
import { ApiError } from '@/api/client'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { DangerZone, SettingsError, SettingsField, SettingsGroup, SettingsLoading, SettingsNote, SettingsPane } from './settings-field'

/**
 * Settings → Backup (spec `2026-10-23-backup-restore.md` §4): who archives are encrypted to,
 * Backup now with a download, an optional S3-compatible target, the nightly opt-in, and Restore
 * here. Nothing is set by default and nothing leaves the machine until a target is.
 */

export function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function ageOf(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

const failed = (error: Error) => toast(error.message, { tone: 'danger' })

export function BackupSection() {
  const status = useBackupStatus()
  if (status.isPending) return <SettingsLoading data-slot="backup-settings-loading" label="Loading backup settings…" />
  if (status.isError) return <SettingsError title="Backup is not available here">{status.error.message}</SettingsError>
  return <BackupForm status={status.data} />
}

export function JobLog({ job }: { job: BackupJob }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [job.log.length])
  return (
    <div data-slot="backup-job" data-status={job.status} className="flex flex-col gap-1.5">
      <SettingsNote tone={job.status === 'failed' ? 'danger' : 'muted'}>
        {job.status === 'running'
          ? `${job.kind === 'backup' ? 'Backing up' : 'Restoring'}…`
          : job.status === 'failed'
            ? job.error ?? 'Failed'
            : job.status === 'restarting'
              ? 'Restored — restarting the cockpit…'
              : job.kind === 'backup'
                ? 'Backup finished'
                : 'Restore finished'}
      </SettingsNote>
      <pre
        ref={ref}
        className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
      >
        {job.log.join('\n')}
      </pre>
    </div>
  )
}

function RecipientGroup({ status }: { status: BackupStatus }) {
  const save = useSetBackupRecipient()
  const [key, setKey] = useState('')
  const trimmed = key.trim()
  const invalid = trimmed !== '' && !AGE_RECIPIENT_RE.test(trimmed)
  const current = status.recipient
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (trimmed === '' || invalid) return
    save.mutate({ recipient: trimmed }, { onSuccess: () => setKey(''), onError: failed })
  }
  return (
    <SettingsGroup
      title="Encryption"
      description="Archives are age files. The private key or passphrase never reaches this cockpit until you restore."
    >
      <SettingsField
        title="Recipient"
        htmlFor="backup-recipient"
        hint={
          current?.kind === 'age' ? (
            <>
              Encrypted to <code className="font-mono text-[12px] break-all text-foreground">{current.recipient}</code>
            </>
          ) : current?.kind === 'passphrase' ? (
            'A passphrase, asked for every backup — it is never stored, so nightly backups need a public key instead.'
          ) : (
            <>
              Paste the <code className="font-mono text-[12px]">age1…</code> public key that{' '}
              <code className="font-mono text-[12px]">age-keygen</code> printed on your own machine. Keep the private key there.
            </>
          )
        }
      >
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row" noValidate>
          <Input
            id="backup-recipient"
            data-slot="backup-recipient-input"
            className="font-mono text-xs"
            placeholder="age1…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid || undefined}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={trimmed === '' || invalid || save.isPending}>
            {current ? 'Replace' : 'Save'}
          </Button>
          {current?.kind !== 'passphrase' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-action="backup-use-passphrase"
              disabled={save.isPending}
              onClick={() => save.mutate({ passphrase: true }, { onError: failed })}
            >
              Use a passphrase
            </Button>
          ) : null}
        </form>
        {invalid ? <SettingsNote tone="danger">That is not an age public key — it starts with age1.</SettingsNote> : null}
      </SettingsField>
    </SettingsGroup>
  )
}

function BackupsGroup({ status }: { status: BackupStatus }) {
  const start = useStartBackup()
  const [passphrase, setPassphrase] = useState('')
  const job = status.job
  const running = job?.status === 'running'
  const needsPassphrase = status.recipient?.kind === 'passphrase'
  return (
    <SettingsGroup
      title="Backups"
      description="cezar's state, the agents' and git's logins, and each project's untracked .env and .ai/cezar files. Never the repositories — those come back from a clone."
    >
      <SettingsField
        title="Back up now"
        hint={status.recipient ? 'The five newest archives are kept on this machine.' : 'Set a recipient above first.'}
        control={
          <Button
            type="button"
            size="sm"
            data-action="backup-now"
            disabled={!status.recipient || running || start.isPending || (needsPassphrase && passphrase === '')}
            onClick={() => start.mutate(needsPassphrase ? passphrase : undefined, { onSuccess: () => setPassphrase(''), onError: failed })}
          >
            {running && job?.kind === 'backup' ? <Spinner aria-hidden="true" /> : null}
            Back up now
          </Button>
        }
      >
        {needsPassphrase ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="backup-passphrase" className="text-xs">Passphrase</Label>
            <Input
              id="backup-passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </div>
        ) : null}
        {job?.kind === 'backup' ? <JobLog job={job} /> : null}
      </SettingsField>
      {status.archives.length === 0 ? (
        <SettingsField title="No archives yet" hint="An archive appears here as soon as a backup finishes." />
      ) : (
        status.archives.map((archive) => (
          <SettingsField
            key={archive.name}
            title={<span className="font-mono text-[12.5px] break-all">{archive.name}</span>}
            hint={
              <>
                {humanBytes(archive.size)} · {ageOf(archive.createdAt)}
                {archive.uploaded ? (
                  <Badge variant="secondary" className="ml-2 align-middle">uploaded</Badge>
                ) : null}
              </>
            }
            control={
              <Button asChild size="sm" variant="outline">
                <a href={backupArchiveUrl(archive.name)} download={archive.name} data-action="backup-download">
                  <DownloadIcon aria-hidden="true" />
                  Download
                </a>
              </Button>
            }
          />
        ))
      )}
    </SettingsGroup>
  )
}

function TargetGroup({ status }: { status: BackupStatus }) {
  const save = useSetBackupTarget()
  const test = useTestBackupTarget()
  const target = status.target
  const [form, setForm] = useState({
    endpoint: target?.endpoint ?? '',
    bucket: target?.bucket ?? '',
    prefix: target?.prefix ?? '',
    region: target?.region ?? '',
    accessKeyId: target?.accessKeyId ?? '',
    secretAccessKey: '',
  })
  const field = (name: keyof typeof form) => ({
    id: `backup-target-${name}`,
    value: form[name],
    onChange: (event: { target: { value: string } }) => setForm((previous) => ({ ...previous, [name]: event.target.value })),
  })
  const ready = form.endpoint.trim() !== '' && form.bucket.trim() !== '' && form.accessKeyId.trim() !== '' && form.secretAccessKey !== ''
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    save.mutate(
      {
        endpoint: form.endpoint.trim(),
        bucket: form.bucket.trim(),
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey: form.secretAccessKey,
        ...(form.prefix.trim() ? { prefix: form.prefix.trim() } : {}),
        ...(form.region.trim() ? { region: form.region.trim() } : {}),
      },
      {
        onSuccess: () => {
          setForm((previous) => ({ ...previous, secretAccessKey: '' }))
          toast('Remote target saved')
        },
        onError: failed,
      },
    )
  }
  const labelled = (name: keyof typeof form, label: string, extra: Record<string, string> = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`backup-target-${name}`} className="text-xs">{label}</Label>
      <Input autoComplete="off" spellCheck={false} {...field(name)} {...extra} />
    </div>
  )
  return (
    <SettingsGroup
      title="Remote target"
      description="Optional. An S3-compatible bucket — Cloudflare R2, Backblaze B2, MinIO, AWS — that every archive is uploaded to after it is written."
    >
      <SettingsField
        title={target ? `${target.bucket} at ${new URL(target.endpoint).host}` : 'No remote target'}
        hint={target ? 'The secret is stored on this machine only (0600) and never shown again.' : 'Without one, archives stay on this machine until you download them.'}
        control={
          target ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-action="backup-target-test"
                disabled={test.isPending}
                onClick={() =>
                  test.mutate(undefined, {
                    onSuccess: (result) =>
                      result.ok
                        ? toast('The bucket answered')
                        : toast(`The bucket did not answer: ${result.error ?? 'unknown error'}`, { tone: 'danger' }),
                    onError: failed,
                  })
                }
              >
                {test.isPending ? <Spinner aria-hidden="true" /> : null}
                Test
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null, { onError: failed })}>
                Remove
              </Button>
            </>
          ) : null
        }
      >
        <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2" noValidate>
          {labelled('endpoint', 'Endpoint', { placeholder: 'https://<account>.r2.cloudflarestorage.com' })}
          {labelled('bucket', 'Bucket')}
          {labelled('prefix', 'Prefix (optional)', { placeholder: 'cezar/' })}
          {labelled('region', 'Region (optional)', { placeholder: 'us-east-1' })}
          {labelled('accessKeyId', 'Access key id')}
          {labelled('secretAccessKey', target ? 'Secret (enter again to save changes)' : 'Secret access key', { type: 'password' })}
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" disabled={!ready || save.isPending}>
              {target ? 'Save changes' : 'Save target'}
            </Button>
          </div>
        </form>
      </SettingsField>
    </SettingsGroup>
  )
}

function NightlyGroup({ status }: { status: BackupStatus }) {
  const save = useSetBackupSchedule()
  const [keep, setKeep] = useState(String(status.schedule.keep || BACKUP_KEEP_DEFAULT))
  const keepNumber = Number(keep)
  const keepValid = Number.isInteger(keepNumber) && keepNumber >= 1 && keepNumber <= BACKUP_KEEP_MAX
  const { schedule } = status
  const ageRecipient = status.recipient?.kind === 'age'
  return (
    <SettingsGroup title="Nightly" description="Off by default. Runs at 03:00 on this machine's clock, once no task is running.">
      <SettingsField
        title="Back up every night"
        htmlFor="backup-nightly"
        hint={
          !ageRecipient
            ? 'Needs an age1… recipient — a passphrase is never stored, so nothing could encrypt a run nobody attends.'
            : schedule.nightly && schedule.nextRunAt
              ? `Next run ${new Date(schedule.nextRunAt).toLocaleString()}${schedule.lastRunAt ? ` · last ${ageOf(schedule.lastRunAt)}` : ''}`
              : 'Keeps the newest archives of this machine in the bucket and deletes older ones.'
        }
        control={
          <Switch
            id="backup-nightly"
            data-slot="backup-nightly"
            checked={schedule.nightly}
            disabled={save.isPending || !ageRecipient || !keepValid}
            onCheckedChange={(checked) => save.mutate({ nightly: checked, keep: keepNumber }, { onError: failed })}
          />
        }
      >
        {schedule.lastError ? <SettingsNote tone="danger">{schedule.lastError}</SettingsNote> : null}
      </SettingsField>
      <SettingsField
        title="Remote archives to keep"
        htmlFor="backup-keep"
        hint={`1–${BACKUP_KEEP_MAX}. Only this machine's archives are counted and pruned.`}
        control={
          <>
            <Input
              id="backup-keep"
              type="number"
              min={1}
              max={BACKUP_KEEP_MAX}
              className="w-20"
              aria-invalid={!keepValid || undefined}
              value={keep}
              onChange={(event) => setKeep(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!keepValid || keepNumber === schedule.keep || save.isPending}
              onClick={() => save.mutate({ nightly: schedule.nightly, keep: keepNumber }, { onError: failed })}
            >
              Save
            </Button>
          </>
        }
      />
    </SettingsGroup>
  )
}

/** After a restore restarts the process: wait for a FRESH one (no job in memory), then reload into
 *  it. A 401 means the restored sessions do not include this one — the reload shows sign-in. */
async function waitForRestart(): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    try {
      if ((await getBackupStatus()).job === null) break
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) break
    }
  }
  window.location.reload()
}

export function RestoreForm({
  busy,
  onRestore,
  submitLabel = 'Restore',
}: {
  busy: boolean
  onRestore: (archive: File, identity: string) => void
  submitLabel?: string
}) {
  const [archive, setArchive] = useState<File | null>(null)
  const [identity, setIdentity] = useState('')
  const [confirming, setConfirming] = useState(false)
  const ready = archive !== null && identity.trim() !== ''
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (ready && !busy) setConfirming(true)
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="backup-restore-archive" className="text-xs">Archive (.age)</Label>
        <Input
          id="backup-restore-archive"
          type="file"
          accept=".age"
          onChange={(event) => setArchive(event.target.files?.[0] ?? null)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="backup-restore-identity" className="text-xs">Age identity or passphrase</Label>
        <Textarea
          id="backup-restore-identity"
          className="font-mono text-xs"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          placeholder="AGE-SECRET-KEY-1…"
          value={identity}
          onChange={(event) => setIdentity(event.target.value)}
        />
        <SettingsNote>Used for this restore and dropped — it is never logged or stored.</SettingsNote>
      </div>
      <div>
        <Button type="submit" size="sm" variant="destructive" data-action="backup-restore" disabled={!ready || busy}>
          {busy ? <Spinner aria-hidden="true" /> : null}
          {submitLabel}
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace this cockpit with the backup?</AlertDialogTitle>
            <AlertDialogDescription>
              The owner account, the agents' and git's logins, the project registry, every task's history and the projects'
              untracked files are replaced by the archive's. New tasks wait until it is done, and the cockpit restarts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-action="backup-confirm-restore"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (archive) onRestore(archive, identity)
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  )
}

function RestoreGroup({ status }: { status: BackupStatus }) {
  const restore = useRestoreBackupHere()
  const job = status.job?.kind === 'restore' ? status.job : null
  const restarting = job?.status === 'restarting'
  useEffect(() => {
    if (restarting) void waitForRestart()
  }, [restarting])
  return (
    <DangerZone title="Restore here" description="Bring a backup into this cockpit — on a rebuilt machine, Restore from the /setup page does the same before any account exists.">
      <SettingsField
        title="Restore from an archive"
        hint={status.restartAvailable ? 'Projects the archive lists that are not on disk are cloned from their remote first.' : 'This cockpit cannot restart itself: restart cezar once the restore finishes.'}
      >
        <RestoreForm
          busy={restore.isPending || status.job?.status === 'running' || restarting}
          onRestore={(archive, identity) => restore.mutate({ archive, identity }, { onError: failed })}
        />
        {job ? <JobLog job={job} /> : null}
      </SettingsField>
    </DangerZone>
  )
}

function BackupForm({ status }: { status: BackupStatus }) {
  return (
    <SettingsPane data-slot="backup-settings-section">
      <RecipientGroup status={status} />
      <BackupsGroup status={status} />
      <TargetGroup status={status} />
      {status.target ? <NightlyGroup status={status} /> : null}
      <RestoreGroup status={status} />
    </SettingsPane>
  )
}
