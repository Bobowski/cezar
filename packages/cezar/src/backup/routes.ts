import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { Hono, type Context, type Next } from 'hono';
import {
  BACKUP_IDENTITY_HEADER,
  BACKUP_IDENTITY_MAX,
  BACKUP_UPLOAD_MAX_BYTES,
  backupArchiveParamsSchema,
  backupRestoreHeadersSchema,
  backupScheduleSchema,
  createBackupBodySchema,
  SETUP_CODE_HEADER,
  setBackupRecipientBodySchema,
  setBackupTargetBodySchema,
  setupRestoreHeadersSchema,
  setupRestoreQuerySchema,
  type BackupJob,
} from '@open-mercato/cezar-contract';
import { cookieFor, failure, HTTPS_REQUIRED, metaOf } from '../auth/routes.ts';
import type { AuthService } from '../auth/service.ts';
import { cezarHomeDir } from '../paths.ts';
import { headerZodValidator, jsonZodValidator, paramZodValidator, queryZodValidator } from '../server/validators.ts';
import type { BackupService } from './service.ts';

/**
 * `/api/v1/workspace/backup/*` and `/api/v1/auth/setup/restore` (spec
 * `2026-10-23-backup-restore.md` §5). Workspace-level, single-mount. Everything under
 * `/workspace/backup` is a trusted-operator capability; the setup restore is gated by the
 * one-time setup code instead, and only while no owner can sign in.
 *
 * A restore upload is the archive as the raw body. Every gate runs on headers before a byte of
 * it is read, and the body streams to a file under `CEZ_HOME`, capped while it streams.
 */

export { BACKUP_UPLOAD_MAX_BYTES };
const UPLOAD_PATHS = new Set(['/api/v1/workspace/backup/restore', '/api/v1/auth/setup/restore']);

/** The two upload routes cap their own bodies instead of riding the global 32 MiB limit. */
export function isBackupUploadPath(pathname: string): boolean {
  return UPLOAD_PATHS.has(pathname);
}

const NOT_TRUSTED = 'backup and restore are available to the owner on a cockpit that enforces sign-in, or on this machine';
const TOO_LARGE = 'the archive is larger than 1 GiB — restore it with `cezar backup restore <file>` on the host';

class UploadTooLargeError extends Error {}

/** The declared size of the body, or the refusal: an upload says how big it is, up front. */
function declaredLength(c: Context): number | Response {
  const raw = c.req.header('content-length')?.trim();
  if (raw === undefined || !/^\d{1,16}$/.test(raw)) return c.json({ error: 'send the archive with a Content-Length' }, 411);
  const length = Number(raw);
  if (length > BACKUP_UPLOAD_MAX_BYTES) return c.json({ error: TOO_LARGE }, 413);
  if (length === 0) return c.json({ error: 'choose a backup archive' }, 400);
  return length;
}

/** Stream the body to a private file under `CEZ_HOME` (never a `/tmp` shared with agents), exactly `length` bytes. */
async function spool(body: ReadableStream<Uint8Array> | null, length: number): Promise<string> {
  if (!body) throw new Error('choose a backup archive');
  const home = cezarHomeDir();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, `.restore-upload-${randomBytes(8).toString('hex')}.age`);
  let seen = 0;
  try {
    await pipeline(
      Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>),
      async function* capped(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          seen += chunk.length;
          if (seen > length) throw new UploadTooLargeError('the upload is longer than its Content-Length');
          yield chunk;
        }
      },
      createWriteStream(path, { mode: 0o600 }),
    );
    if (seen < length) throw new Error('the upload ended before the archive did');
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return path;
}

type Received = { ok: true; job: BackupJob } | { ok: false; status: 400 | 409 | 411 | 413; error: string };

/** Decode the identity, spool the body, start the restore; the temp file goes with the job. */
async function receive(c: Context, service: BackupService, encodedIdentity: string): Promise<Received> {
  const identity = Buffer.from(encodedIdentity, 'base64').toString('utf8');
  if (identity.length === 0 || identity.length > BACKUP_IDENTITY_MAX) return { ok: false, status: 400, error: 'paste the age identity or the passphrase' };
  const length = declaredLength(c);
  if (typeof length !== 'number') return { ok: false, status: 411, error: 'send the archive with a Content-Length' };
  let path: string;
  try {
    path = await spool(c.req.raw.body, length);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, status: error instanceof UploadTooLargeError ? 413 : 400, error: text };
  }
  try {
    return { ok: true, job: service.startRestore({ archive: path, identity, removeArchive: true }) };
  } catch (error) {
    // A refusal (BackupConflictError) or a home that cannot be written: either way, nothing started.
    rmSync(path, { force: true });
    return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
  }
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
    .post(
      '/workspace/backup/restore',
      // Headers only: the body is read after every gate passed (review 2026-10-24).
      async (c: Context, next: Next) => {
        if (!trusted()) return refuse(c);
        const length = declaredLength(c);
        return typeof length === 'number' ? next() : length;
      },
      headerZodValidator(backupRestoreHeadersSchema),
      async (c) => {
        const received = await receive(c, service, c.req.valid('header')[BACKUP_IDENTITY_HEADER]);
        if (!received.ok) return c.json({ error: received.error }, received.status);
        return c.json(service.status(), 200);
      },
    );
}

/** Restore from `/setup` on a fresh cockpit: the setup code is the whole gate (spec §4, §6). */
export function setupRestoreRoutes(deps: { service: BackupService; auth: AuthService; enforced: () => boolean }) {
  const { service, auth, enforced } = deps;
  return new Hono()
    .post(
      '/auth/setup/restore',
      // Cheapest first, all from headers: nothing here reads the body (review 2026-10-24).
      async (c: Context, next: Next) => {
        c.header('cache-control', 'no-store');
        if (!enforced()) return c.json({ error: 'authentication is not enabled on this cockpit — restore from Settings → Backup' }, 409);
        if (!cookieFor(c)) return c.json({ error: HTTPS_REQUIRED }, 400);
        // An owner exists: this is not a setup any more, whoever is asking.
        if (!auth.setupRequired()) return c.json({ error: 'not found' }, 404);
        const length = declaredLength(c);
        if (typeof length !== 'number') return length;
        const gate = auth.checkSetupCode(c.req.header(SETUP_CODE_HEADER) ?? c.req.query('code') ?? '', metaOf(c));
        if (!gate.ok) return failure(c, gate);
        return next();
      },
      headerZodValidator(setupRestoreHeadersSchema),
      async (c) => {
        const received = await receive(c, service, c.req.valid('header')[BACKUP_IDENTITY_HEADER]);
        if (!received.ok) return c.json({ error: received.error }, received.status);
        return c.json({ job: received.job.id }, 200);
      },
    )
    // The job id came back only to whoever presented the setup code; it is the capability here.
    .get('/auth/setup/restore', queryZodValidator(setupRestoreQuerySchema), (c) => {
      c.header('cache-control', 'no-store');
      const job = service.jobById(c.req.valid('query').job);
      if (!job || job.kind !== 'restore') return c.json({ error: 'no such restore' }, 404);
      return c.json(job, 200);
    });
}
