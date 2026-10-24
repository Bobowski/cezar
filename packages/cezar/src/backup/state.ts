import { readFileSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { AGE_RECIPIENT_RE, BACKUP_KEEP_DEFAULT, BACKUP_KEEP_MAX } from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, backupStatePath, backupTargetPath } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import type { S3Target } from './s3.ts';

/**
 * `backup.json` (recipient, schedule, what was uploaded) and `backup-target.json` (the remote,
 * `0600`, with its secret) — spec `2026-10-23-backup-restore.md` §7. New state only: both are
 * optional, every key has a default, and an unreadable file reads as "nothing set".
 */

const stateSchema = z
  .object({
    version: z.literal(1).catch(1),
    recipient: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('age'), recipient: z.string().regex(AGE_RECIPIENT_RE) }),
        z.object({ kind: z.literal('passphrase') }),
      ])
      .optional()
      .catch(undefined),
    nightly: z.boolean().catch(false).default(false),
    keep: z.number().int().min(1).max(BACKUP_KEEP_MAX).catch(BACKUP_KEEP_DEFAULT).default(BACKUP_KEEP_DEFAULT),
    /** When nightly was switched on — the first night is counted from here. */
    nightlySince: z.string().max(64).optional().catch(undefined),
    lastNightlyAt: z.string().max(64).optional().catch(undefined),
    lastError: z.string().max(2000).optional().catch(undefined),
    /** Archive name → when it reached the remote target. */
    uploaded: z.record(z.string(), z.string()).catch(() => ({})).default(() => ({})),
  })
  .passthrough();
export type BackupState = z.infer<typeof stateSchema>;

const targetSchema = z.object({
  endpoint: z.string().min(1),
  bucket: z.string().min(1),
  prefix: z.string().catch(''),
  region: z.string().catch('us-east-1'),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function readBackupState(path: string = backupStatePath()): BackupState {
  const parsed = stateSchema.safeParse(readJson(path) ?? {});
  return parsed.success ? parsed.data : stateSchema.parse({});
}

/** Read-modify-write; a read-only home throws, and the route answers with that. */
export function mutateBackupState(mutator: (state: BackupState) => void, path: string = backupStatePath()): BackupState {
  assertCezarHomeWriteIsSandboxed(path);
  const state = readBackupState(path);
  mutator(state);
  atomicWriteJsonSync(path, state);
  return state;
}

export function readBackupTarget(path: string = backupTargetPath()): S3Target | null {
  const parsed = targetSchema.safeParse(readJson(path));
  return parsed.success ? { ...parsed.data, region: parsed.data.region || 'us-east-1' } : null;
}

export function writeBackupTarget(target: S3Target | null, path: string = backupTargetPath()): void {
  assertCezarHomeWriteIsSandboxed(path);
  if (target === null) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteJsonSync(path, target);
}
