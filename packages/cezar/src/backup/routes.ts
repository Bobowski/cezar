import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  BACKUP_IDENTITY_MAX,
  backupArchiveParamsSchema,
  backupScheduleSchema,
  createBackupBodySchema,
  setBackupRecipientBodySchema,
  setBackupTargetBodySchema,
  setupRestoreQuerySchema,
} from '@open-mercato/cezar-contract';
import { cookieFor, failure, HTTPS_REQUIRED, metaOf } from '../auth/routes.ts';
import type { AuthService } from '../auth/service.ts';
import { cezarHomeDir } from '../paths.ts';
import { jsonZodValidator, multipartZodValidator, paramZodValidator, queryZodValidator } from '../server/validators.ts';
import type { BackupService } from './service.ts';

/**
 * `/api/v1/workspace/backup/*` and `/api/v1/auth/setup/restore` (spec
 * `2026-10-23-backup-restore.md` §5). Workspace-level, single-mount. Everything under
 * `/workspace/backup` is a trusted-operator capability; the setup restore is gated by the
 * one-time setup code instead, and only while no owner can sign in.
 */

/** An archive upload is parsed in memory by the multipart reader, so it has a ceiling. */
export const BACKUP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const UPLOAD_PATHS = new Set(['/api/v1/workspace/backup/restore', '/api/v1/auth/setup/restore']);

/** The two upload routes ride their own body limit instead of the global 32 MiB one. */
export function isBackupUploadPath(pathname: string): boolean {
  return UPLOAD_PATHS.has(pathname);
}

/** The multipart half of a restore. A `File` lives here, not in the Node-free contract. */
export const backupRestoreUploadSchema = z.object({
  archive: z
    .instanceof(File, { message: 'choose a backup archive' })
    .refine((file) => file.size > 0 && file.size <= BACKUP_UPLOAD_MAX_BYTES, { message: 'the archive is empty or larger than 1 GiB' }),
  identity: z.string().min(1, 'paste the age identity or the passphrase').max(BACKUP_IDENTITY_MAX),
});

export const setupRestoreUploadSchema = backupRestoreUploadSchema.extend({ code: z.string().min(1).max(256) });

const NOT_TRUSTED = 'backup and restore are available to the owner on a cockpit that enforces sign-in, or on this machine';

/** Spool the upload to a private file under `CEZ_HOME` (never a `/tmp` shared with agents). */
async function spool(file: File): Promise<string> {
  const home = cezarHomeDir();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, `.restore-upload-${randomBytes(8).toString('hex')}.age`);
  try {
    await pipeline(Readable.fromWeb(file.stream() as unknown as WebReadableStream<Uint8Array>), createWriteStream(path, { mode: 0o600 }));
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return path;
}

function conflict(c: Context, error: unknown) {
  // A refusal (BackupConflictError) or a home that cannot be written: either way, nothing started.
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
}

export function backupRoutes(deps: { service: BackupService; trusted: () => boolean }) {
  const { service, trusted } = deps;
  const refuse = (c: Context) => c.json({ error: NOT_TRUSTED }, 409);
  return new Hono()
    .get('/workspace/backup', (c) => {
      if (!trusted()) return refuse(c);
      return c.json(service.status(), 200);
    })
    .put('/workspace/backup/recipient', jsonZodValidator(setBackupRecipientBodySchema), (c) => {
      if (!trusted()) return refuse(c);
      try {
        return c.json(service.setRecipient(c.req.valid('json')), 200);
      } catch (error) {
        return conflict(c, error);
      }
    })
    .put('/workspace/backup/target', jsonZodValidator(setBackupTargetBodySchema), (c) => {
      if (!trusted()) return refuse(c);
      try {
        return c.json(service.setTarget(c.req.valid('json')), 200);
      } catch (error) {
        return conflict(c, error);
      }
    })
    .post('/workspace/backup/target/test', async (c) => {
      if (!trusted()) return refuse(c);
      try {
        return c.json(await service.testTarget(), 200);
      } catch (error) {
        return conflict(c, error);
      }
    })
    .put('/workspace/backup/schedule', jsonZodValidator(backupScheduleSchema), (c) => {
      if (!trusted()) return refuse(c);
      try {
        return c.json(service.setSchedule(c.req.valid('json')), 200);
      } catch (error) {
        return conflict(c, error);
      }
    })
    .post('/workspace/backup', jsonZodValidator(createBackupBodySchema, { absent: {} }), (c) => {
      if (!trusted()) return refuse(c);
      try {
        service.startBackup({ passphrase: c.req.valid('json').passphrase });
        return c.json(service.status(), 200);
      } catch (error) {
        return conflict(c, error);
      }
    })
    .get('/workspace/backup/archives/:name', paramZodValidator(backupArchiveParamsSchema), (c) => {
      if (!trusted()) return refuse(c);
      const { name } = c.req.valid('param');
      const file = service.archiveFile(name);
      if (!file) return c.json({ error: 'no such archive' }, 404);
      const body = Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream<Uint8Array>;
      return c.body(body, 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(file.size),
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
    })
    .use('/workspace/backup/restore', bodyLimit({ maxSize: BACKUP_UPLOAD_MAX_BYTES + 1024 * 1024 }))
    .post('/workspace/backup/restore', multipartZodValidator(backupRestoreUploadSchema), async (c) => {
      if (!trusted()) return refuse(c);
      const { archive, identity } = c.req.valid('form');
      let path: string | undefined;
      try {
        path = await spool(archive);
        service.startRestore({ archive: path, identity, removeArchive: true });
        return c.json(service.status(), 200);
      } catch (error) {
        if (path) rmSync(path, { force: true });
        return conflict(c, error);
      }
    });
}

/** Restore from `/setup` on a fresh cockpit: the setup code is the whole gate (spec §4, §6). */
export function setupRestoreRoutes(deps: { service: BackupService; auth: AuthService; enforced: () => boolean }) {
  const { service, auth, enforced } = deps;
  return new Hono()
    .use('/auth/setup/restore', bodyLimit({ maxSize: BACKUP_UPLOAD_MAX_BYTES + 1024 * 1024 }))
    .post('/auth/setup/restore', multipartZodValidator(setupRestoreUploadSchema), async (c) => {
      c.header('cache-control', 'no-store');
      if (!enforced()) return c.json({ error: 'authentication is not enabled on this cockpit — restore from Settings → Backup' }, 409);
      if (!cookieFor(c)) return c.json({ error: HTTPS_REQUIRED }, 400);
      const { archive, identity, code } = c.req.valid('form');
      const gate = auth.checkSetupCode(code, metaOf(c));
      if (!gate.ok) return failure(c, gate);
      let path: string | undefined;
      try {
        path = await spool(archive);
        const job = service.startRestore({ archive: path, identity, removeArchive: true });
        return c.json({ job: job.id }, 200);
      } catch (error) {
        if (path) rmSync(path, { force: true });
        return conflict(c, error);
      }
    })
    // The job id came back only to whoever presented the setup code; it is the capability here.
    .get('/auth/setup/restore', queryZodValidator(setupRestoreQuerySchema), (c) => {
      c.header('cache-control', 'no-store');
      const job = service.jobById(c.req.valid('query').job);
      if (!job || job.kind !== 'restore') return c.json({ error: 'no such restore' }, 404);
      return c.json(job, 200);
    });
}
