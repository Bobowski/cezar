import { z } from 'zod';

/**
 * Backup and restore (`/api/v1/workspace/backup`, spec `.ai/specs/2026-10-23-backup-restore.md`).
 * Workspace-level and single-mount. A restore upload is the archive's raw bytes as the body
 * (streamed to disk server-side, never parsed in memory); what it needs beside them rides headers.
 */

/** `cezar-backup-<host>-<yyyymmddThhmmZ>[-n].tar.zst.age` — `.tar.gz.age` on a Node without zstd. */
export const BACKUP_ARCHIVE_NAME_RE = /^cezar-backup-[a-z0-9](?:[a-z0-9-]{0,62})-\d{8}T\d{4}Z(?:-\d{1,3})?\.tar\.(?:zst|gz)\.age$/;
export const backupArchiveNameSchema = z.string().max(128).regex(BACKUP_ARCHIVE_NAME_RE, 'not a cezar backup archive name');

/** An X25519 (`age1…`) or post-quantum hybrid (`age1pq1…`) recipient, as `age-keygen -y` prints it. */
export const AGE_RECIPIENT_RE = /^age1(?:pq1)?[02-9ac-hj-np-z]{20,4000}$/;
export const BACKUP_KEEP_DEFAULT = 14;
export const BACKUP_KEEP_MAX = 365;

export const backupArchiveSchema = z.object({
  name: z.string(),
  size: z.number().int().min(0),
  createdAt: z.string(),
  /** Uploaded to the remote target after it was written. */
  uploaded: z.boolean(),
});
export type BackupArchive = z.infer<typeof backupArchiveSchema>;

/** Who the archives are encrypted to. A passphrase is never stored: `passphrase` means "ask". */
export const backupRecipientStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('age'), recipient: z.string() }),
  z.object({ kind: z.literal('passphrase') }),
]);
export type BackupRecipientStatus = z.infer<typeof backupRecipientStatusSchema>;

/** The remote target as the cockpit may see it — the secret is never echoed, only `secretSet`. */
export const backupTargetStatusSchema = z.object({
  endpoint: z.string(),
  bucket: z.string(),
  prefix: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretSet: z.literal(true),
});
export type BackupTargetStatus = z.infer<typeof backupTargetStatusSchema>;

export const backupScheduleSchema = z.object({
  nightly: z.boolean(),
  keep: z.number().int().min(1).max(BACKUP_KEEP_MAX),
});
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;

export const backupScheduleStatusSchema = backupScheduleSchema.extend({
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastError: z.string().optional(),
});
export type BackupScheduleStatus = z.infer<typeof backupScheduleStatusSchema>;

export const backupJobKindSchema = z.enum(['backup', 'restore']);
export const backupJobStatusSchema = z.enum(['running', 'done', 'failed', 'restarting']);

/** The one in-flight or last-finished job. `restarting`: a restore is in place and the process
 *  is about to come back — poll health until it answers again. */
export const backupJobSchema = z.object({
  id: z.string(),
  kind: backupJobKindSchema,
  status: backupJobStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  log: z.array(z.string()),
  error: z.string().optional(),
  /** `backup`: the archive it wrote. */
  archive: z.string().optional(),
});
export type BackupJob = z.infer<typeof backupJobSchema>;

/** `GET /api/v1/workspace/backup` (and every mutation on the family). */
export const backupStatusSchema = z.object({
  recipient: backupRecipientStatusSchema.nullable(),
  target: backupTargetStatusSchema.nullable(),
  schedule: backupScheduleStatusSchema,
  archives: z.array(backupArchiveSchema),
  job: backupJobSchema.nullable(),
  /** Whether a restore can bring the process back by itself; otherwise it asks for a restart. */
  restartAvailable: z.boolean(),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const setBackupRecipientBodySchema = z.union([
  z.object({ recipient: z.string().trim().regex(AGE_RECIPIENT_RE, 'paste the age1… public key age-keygen printed') }).strict(),
  z.object({ passphrase: z.literal(true) }).strict(),
]);
export type SetBackupRecipientBody = z.infer<typeof setBackupRecipientBodySchema>;

/** `http(s)://host[:port][/path]` — no credentials in the authority (this package has no `URL`). */
const httpUrl = z
  .string()
  .trim()
  .max(512)
  .regex(/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[^\s@?#]*)?$/, 'an http(s):// endpoint, without credentials in it');

export const setBackupTargetBodySchema = z
  .object({
    endpoint: httpUrl,
    bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'an S3 bucket name'),
    prefix: z.string().trim().max(256).regex(/^[A-Za-z0-9!_.*'()/-]*$/, 'letters, digits and / - _ . only').optional(),
    region: z.string().trim().max(64).regex(/^[a-z0-9-]*$/, 'a region id such as us-east-1 or auto').optional(),
    accessKeyId: z.string().trim().min(1).max(256),
    secretAccessKey: z.string().min(1).max(1024),
  })
  .strict()
  .nullable();
export type SetBackupTargetBody = z.infer<typeof setBackupTargetBodySchema>;

/** `POST /api/v1/workspace/backup/target/test` — a HEAD on the bucket. */
export const backupTargetTestResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type BackupTargetTestResponse = z.infer<typeof backupTargetTestResponseSchema>;

/** `POST /api/v1/workspace/backup`: a passphrase only when the recipient is one. */
export const createBackupBodySchema = z.object({ passphrase: z.string().min(1).max(1024).optional() }).strict();
export type CreateBackupBody = z.infer<typeof createBackupBodySchema>;

export const backupArchiveParamsSchema = z.object({ name: backupArchiveNameSchema });

/** The text half of a restore upload: an `AGE-SECRET-KEY-1…` identity or the passphrase. */
export const BACKUP_IDENTITY_MAX = 8192;

/** An upload's archive is at most this big; a larger one restores with the CLI. */
export const BACKUP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

/** The identity, base64 of its UTF-8 (a passphrase may be anything a header cannot carry). */
export const BACKUP_IDENTITY_HEADER = 'x-cezar-backup-identity';
/** `/setup`'s one-time code, read before a byte of the body. */
export const SETUP_CODE_HEADER = 'x-cezar-setup-code';

const base64Identity = z
  .string()
  .min(1, 'paste the age identity or the passphrase')
  .max(Math.ceil(BACKUP_IDENTITY_MAX / 3) * 4, 'the identity is too long')
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'the identity header is not base64');

/** `POST /api/v1/workspace/backup/restore`: the archive as the body, the identity as a header. */
export const backupRestoreHeadersSchema = z.object({ [BACKUP_IDENTITY_HEADER]: base64Identity });
export type BackupRestoreHeaders = z.infer<typeof backupRestoreHeadersSchema>;

const setupCode = z.string().min(1).max(256);

/** `POST /api/v1/auth/setup/restore`: the same, plus the setup code — in this header or as
 *  `?code=` (`setupRestoreUploadQuerySchema`); the route's gate wants one of the two. */
export const setupRestoreHeadersSchema = backupRestoreHeadersSchema.extend({ [SETUP_CODE_HEADER]: setupCode.optional() });
export type SetupRestoreHeaders = z.infer<typeof setupRestoreHeadersSchema>;
export const setupRestoreUploadQuerySchema = z.object({ code: setupCode.optional() });
export type SetupRestoreUploadQuery = z.infer<typeof setupRestoreUploadQuerySchema>;

/** `POST /api/v1/auth/setup/restore` answers the job's id: knowing it is what lets the page,
 *  which has no session yet, follow the job (`GET /api/v1/auth/setup/restore?job=…`). */
export const setupRestoreResponseSchema = z.object({ job: z.string() });
export type SetupRestoreResponse = z.infer<typeof setupRestoreResponseSchema>;
export const setupRestoreQuerySchema = z.object({ job: z.string().min(16).max(64) });

export const backupErrorSchema = z.object({ error: z.string() });
export type BackupError = z.infer<typeof backupErrorSchema>;
