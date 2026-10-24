import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  apiPath,
  type BackupJob,
  type BackupSchedule,
  type BackupStatus,
  type BackupTargetTestResponse,
  type SetBackupRecipientBody,
  type SetBackupTargetBody,
} from '@open-mercato/cezar-api-client'
import { cez, unwrap } from './client'

/**
 * Settings → Backup and the `/setup` restore card (spec `2026-10-23-backup-restore.md` §4).
 * Workspace-level: these keys are never project-scoped.
 */
export const backupQueryKeys = {
  status: ['workspace', 'backup'] as const,
}

export async function getBackupStatus(signal?: AbortSignal): Promise<BackupStatus> {
  return unwrap(await cez.api.v1.workspace.backup.$get({}, { init: { signal } }), '/workspace/backup')
}

export async function setBackupRecipient(body: SetBackupRecipientBody): Promise<BackupStatus> {
  return unwrap(await cez.api.v1.workspace.backup.recipient.$put({ json: body }), '/workspace/backup/recipient')
}

export async function setBackupTarget(body: SetBackupTargetBody): Promise<BackupStatus> {
  return unwrap(await cez.api.v1.workspace.backup.target.$put({ json: body }), '/workspace/backup/target')
}

export async function testBackupTarget(): Promise<BackupTargetTestResponse> {
  return unwrap(await cez.api.v1.workspace.backup.target.test.$post({}), '/workspace/backup/target/test')
}

export async function setBackupSchedule(body: BackupSchedule): Promise<BackupStatus> {
  return unwrap(await cez.api.v1.workspace.backup.schedule.$put({ json: body }), '/workspace/backup/schedule')
}

export async function startBackup(passphrase?: string): Promise<BackupStatus> {
  return unwrap(
    await cez.api.v1.workspace.backup.$post({ json: passphrase ? { passphrase } : {} }),
    '/workspace/backup',
  )
}

/** The route's `File` is typed from `node:buffer` (the server's); in the browser it is the DOM's.
 *  Same class at runtime, two declarations at compile time. */
type ServerFile = Parameters<typeof cez.api.v1.workspace.backup.restore.$post>[0]['form']['archive']
const asServerFile = (file: File) => file as unknown as ServerFile

export async function restoreBackupHere(archive: File, identity: string): Promise<BackupStatus> {
  return unwrap(await cez.api.v1.workspace.backup.restore.$post({ form: { archive: asServerFile(archive), identity } }), '/workspace/backup/restore')
}

/** The download link — a plain navigation, so the browser streams the file to disk. */
export function backupArchiveUrl(name: string): string {
  return apiPath(`/workspace/backup/archives/${encodeURIComponent(name)}`)
}

/** `/setup`: the setup code is the gate; the answer's job id is the only handle on the job. */
export async function restoreFromSetup(archive: File, identity: string, code: string): Promise<string> {
  const res = await cez.api.v1.auth.setup.restore.$post({ form: { archive: asServerFile(archive), identity, code } })
  return (await unwrap(res, '/auth/setup/restore')).job
}

export async function getSetupRestoreJob(job: string): Promise<BackupJob> {
  return unwrap(await cez.api.v1.auth.setup.restore.$get({ query: { job } }), '/auth/setup/restore')
}

/** Polls while a job runs so the log follows it; idle otherwise. */
export function useBackupStatus() {
  return useQuery({
    queryKey: backupQueryKeys.status,
    queryFn: ({ signal }) => getBackupStatus(signal),
    refetchInterval: (query) => (query.state.data?.job?.status === 'running' ? 1_000 : false),
  })
}

/** Every mutation answers the whole status, which replaces the cached one. */
function useStatusMutation<T>(mutationFn: (input: T) => Promise<BackupStatus>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (status) => queryClient.setQueryData(backupQueryKeys.status, status),
  })
}

export const useSetBackupRecipient = () => useStatusMutation(setBackupRecipient)
export const useSetBackupTarget = () => useStatusMutation(setBackupTarget)
export const useSetBackupSchedule = () => useStatusMutation(setBackupSchedule)
export const useStartBackup = () => useStatusMutation((passphrase: string | undefined) => startBackup(passphrase))
export const useRestoreBackupHere = () =>
  useStatusMutation(({ archive, identity }: { archive: File; identity: string }) => restoreBackupHere(archive, identity))

export function useTestBackupTarget() {
  return useMutation({ mutationFn: () => testBackupTarget() })
}
