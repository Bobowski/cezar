import { randomBytes } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import {
  BACKUP_ARCHIVE_NAME_RE,
  nextOccurrence,
  type BackupJob,
  type BackupStatus,
  type BackupTargetTestResponse,
  type SetBackupRecipientBody,
  type SetBackupTargetBody,
  type BackupSchedule,
} from '@open-mercato/cezar-contract';
import { agentStateLocations, backupsDir, cezarHomeDir, type AgentStateLocations } from '../paths.ts';
import { listProjects } from '../workspace/projects.ts';
import { suspendOrphanPrune, writeRestoreMarker } from '../restore-guard.ts';
import { availableCompression, compressor, encrypted, type EncryptTo } from './codec.ts';
import { archiveHost, archiveStamp, collectBackup, hostArchivePattern, newestArchiveFirst, type BackupManifest } from './collect.ts';
import { applyStaged, stageArchive, type CloneProject } from './restore.ts';
import { S3Client, type S3Target } from './s3.ts';
import { mutateBackupState, readBackupState, readBackupTarget, writeBackupTarget } from './state.ts';
import { tarStream } from './tar.ts';

/**
 * Backup and restore jobs (spec `2026-10-23-backup-restore.md` §4): ONE job at a time, like a
 * self-update, with a log the cockpit polls. Knows nothing about HTTP — the routes map
 * `BackupConflictError` to 409 and everything else to the job's own `failed`.
 */

const LOG_CAP = 300;
/** Local archives kept after a successful new one. */
const KEEP_LOCAL = 5;
/** Nightly is 03:00 in the server's zone; a busy workspace pushes it back by this much. */
const NIGHTLY = { type: 'daily', hour: 3, minute: 0 } as const;
const NIGHTLY_RETRY_MS = 10 * 60_000;
export const NIGHTLY_KEY = 'builtin:backup-nightly';

export class BackupConflictError extends Error {}

export interface BackupServiceOptions {
  version: string;
  /** The workspace's run counters — the `WorkspaceSemaphore` in production. */
  runs?: { idle(): boolean; holdAdmission?(): () => void };
  /** Brings the process back after a restore. Absent: the job asks for a restart instead. */
  restart?: () => void;
  /** In-memory caches over files a restore just replaced (the auth sessions). */
  afterRestore?: () => void;
  /** Stops a writer whose in-memory copy the restore replaces (the run stores' saves) until the
   *  returned release; taken once the archive is verified, before a file is placed. */
  holdWriters?: () => () => void;
  projects?: () => Promise<Array<{ id: string; root: string }>>;
  locations?: () => AgentStateLocations;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Test seam for passphrase encryption (age's default, 18, takes about a second). */
  scryptWorkFactor?: number;
  timeZone?: string;
  hostname?: string;
  clone?: CloneProject;
  /** Whether the automations scheduler that fires the nightly run is armed at all. */
  schedulerActive?: () => boolean;
  /** The nightly schedule changed — re-arm the scheduler. */
  onScheduleChange?: () => void;
}

export interface CreatedBackup {
  name: string;
  path: string;
  size: number;
  uploaded: boolean;
  manifest: BackupManifest;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BackupService {
  private job: BackupJob | null = null;
  private readonly restoreHooks: Array<() => void> = [];
  private readonly writerHolds: Array<() => () => void> = [];

  constructor(private readonly options: BackupServiceOptions) {
    if (options.afterRestore) this.restoreHooks.push(options.afterRestore);
    if (options.holdWriters) this.writerHolds.push(options.holdWriters);
  }

  /** Another writer to stop before a restore places files — the server adds its run stores. */
  onPlacing(hold: () => () => void): void {
    this.writerHolds.push(hold);
  }

  /** Another in-memory cache to drop after a restore — the app adds its auth service's. */
  onRestored(hook: () => void): void {
    this.restoreHooks.push(hook);
  }

  /** The server wires the scheduler in after construction (the CLI builds this service first). */
  attachScheduler(scheduler: { active: () => boolean; changed: () => void }): void {
    this.options.schedulerActive = scheduler.active;
    this.options.onScheduleChange = scheduler.changed;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private timeZone(): string {
    return this.options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  }

  private locations(): AgentStateLocations {
    return (this.options.locations ?? (() => agentStateLocations()))();
  }

  private async projects(): Promise<Array<{ id: string; root: string }>> {
    if (this.options.projects) return this.options.projects();
    const listed = await listProjects().catch(() => []);
    return listed.filter((project) => project.status !== 'missing').map(({ id, root }) => ({ id, root }));
  }

  private client(target: S3Target): S3Client {
    return new S3Client(target, { fetch: this.options.fetch, now: () => this.now() });
  }

  private busy(): boolean {
    return this.job?.status === 'running' || this.job?.status === 'restarting';
  }

  // ---- status ----------------------------------------------------------------

  listArchives(): BackupStatus['archives'] {
    const dir = backupsDir();
    const uploaded = readBackupState().uploaded;
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => BACKUP_ARCHIVE_NAME_RE.test(name));
    } catch {
      return [];
    }
    return names
      .flatMap((name) => {
        try {
          const info = statSync(join(dir, name));
          return info.isFile() ? [{ name, size: info.size, createdAt: info.mtime.toISOString(), uploaded: name in uploaded }] : [];
        } catch {
          return [];
        }
      })
      // The name's own timestamp decides, not the mtime: a copied-in archive keeps its place.
      .sort((a, b) => newestArchiveFirst(a.name, b.name));
  }

  /** The nightly run's next instant, or null when it is off or cannot run. */
  nightlyDueAt(): number | null {
    const state = readBackupState();
    if (!state.nightly || state.recipient?.kind !== 'age' || !readBackupTarget()) return null;
    const after = Date.parse(state.lastNightlyAt ?? state.nightlySince ?? this.now().toISOString());
    return nextOccurrence(NIGHTLY, Number.isFinite(after) ? after : this.now().getTime(), this.timeZone());
  }

  status(): BackupStatus {
    const state = readBackupState();
    const target = readBackupTarget();
    const schedulerActive = this.options.schedulerActive?.() ?? true;
    const due = schedulerActive ? this.nightlyDueAt() : null;
    const lastError = state.nightly && !schedulerActive
      ? 'nightly backups run through the automations scheduler, which is off (CEZ_AUTOMATIONS=0)'
      : state.lastError;
    return {
      recipient: state.recipient ?? null,
      target: target
        ? { endpoint: target.endpoint, bucket: target.bucket, prefix: target.prefix, region: target.region, accessKeyId: target.accessKeyId, secretSet: true }
        : null,
      schedule: {
        nightly: state.nightly,
        keep: state.keep,
        lastRunAt: state.lastNightlyAt ?? null,
        nextRunAt: due === null ? null : new Date(due).toISOString(),
        ...(lastError ? { lastError } : {}),
      },
      archives: this.listArchives(),
      job: this.job,
      restartAvailable: this.options.restart !== undefined,
    };
  }

  jobById(id: string): BackupJob | null {
    return this.job && this.job.id === id ? this.job : null;
  }

  // ---- settings ----------------------------------------------------------------

  setRecipient(body: SetBackupRecipientBody): BackupStatus {
    mutateBackupState((state) => {
      state.recipient = 'recipient' in body ? { kind: 'age', recipient: body.recipient } : { kind: 'passphrase' };
      // A passphrase is never stored, so nothing can encrypt a nightly run with it.
      if (state.recipient.kind === 'passphrase') state.nightly = false;
    });
    this.options.onScheduleChange?.();
    return this.status();
  }

  setTarget(body: SetBackupTargetBody): BackupStatus {
    if (body === null) {
      writeBackupTarget(null);
      mutateBackupState((state) => {
        state.nightly = false;
      });
    } else {
      writeBackupTarget({
        endpoint: body.endpoint.replace(/\/+$/, ''),
        bucket: body.bucket,
        prefix: body.prefix ?? '',
        region: body.region || 'us-east-1',
        accessKeyId: body.accessKeyId,
        secretAccessKey: body.secretAccessKey,
      });
    }
    this.options.onScheduleChange?.();
    return this.status();
  }

  async testTarget(): Promise<BackupTargetTestResponse> {
    const target = readBackupTarget();
    if (!target) throw new BackupConflictError('no remote target is set');
    try {
      await this.client(target).headBucket();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  setSchedule(schedule: BackupSchedule): BackupStatus {
    if (schedule.nightly) {
      if (!readBackupTarget()) throw new BackupConflictError('nightly backups need a remote target first');
      if (readBackupState().recipient?.kind !== 'age') {
        throw new BackupConflictError('nightly backups need an age1… recipient — a passphrase is never stored, so nothing could encrypt them');
      }
    }
    mutateBackupState((state) => {
      if (schedule.nightly && !state.nightly) state.nightlySince = this.now().toISOString();
      state.nightly = schedule.nightly;
      state.keep = schedule.keep;
      if (!schedule.nightly) state.lastError = undefined;
    });
    this.options.onScheduleChange?.();
    return this.status();
  }

  archiveFile(name: string): { path: string; size: number } | null {
    if (!BACKUP_ARCHIVE_NAME_RE.test(name)) return null;
    const path = join(backupsDir(), name);
    try {
      const info = statSync(path);
      return info.isFile() ? { path, size: info.size } : null;
    } catch {
      return null;
    }
  }

  // ---- jobs ----------------------------------------------------------------

  private begin(kind: BackupJob['kind']): { job: BackupJob; log: (line: string) => void } {
    if (this.busy()) throw new BackupConflictError(`a ${this.job!.kind} is already running`);
    const job: BackupJob = {
      id: randomBytes(16).toString('base64url'),
      kind,
      status: 'running',
      startedAt: this.now().toISOString(),
      finishedAt: null,
      log: [],
    };
    this.job = job;
    const log = (line: string) => {
      job.log.push(line);
      if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
    };
    return { job, log };
  }

  private finish(job: BackupJob, log: (line: string) => void, error?: unknown): void {
    job.finishedAt = this.now().toISOString();
    if (error === undefined) {
      if (job.status === 'running') job.status = 'done';
      return;
    }
    job.status = 'failed';
    job.error = message(error);
    log(`failed: ${job.error}`);
  }

  private encryptTo(passphrase: string | undefined): EncryptTo {
    const recipient = readBackupState().recipient;
    if (!recipient) throw new BackupConflictError('set who the archive is encrypted to first — an age1… public key or a passphrase');
    if (recipient.kind === 'age') return recipient;
    if (!passphrase) throw new BackupConflictError('this cockpit encrypts backups with a passphrase — enter it to start one');
    return { kind: 'passphrase', passphrase };
  }

  /** Start a backup in the background. Refusals (no recipient, busy) throw before it starts. */
  startBackup(input: { passphrase?: string; trigger?: 'manual' | 'nightly' } = {}): BackupJob {
    const to = this.encryptTo(input.passphrase);
    const { job, log } = this.begin('backup');
    void this.writeBackup(to, log, input.trigger ?? 'manual', job).then(
      () => this.finish(job, log),
      (error: unknown) => this.finish(job, log, error),
    );
    return job;
  }

  /** The whole backup, awaited — what the CLI runs. */
  async createBackup(input: { passphrase?: string; log?: (line: string) => void } = {}): Promise<CreatedBackup> {
    const to = this.encryptTo(input.passphrase);
    const { job, log } = this.begin('backup');
    const both = (line: string) => {
      log(line);
      input.log?.(line);
    };
    try {
      const created = await this.writeBackup(to, both, 'manual', job);
      this.finish(job, both);
      return created;
    } catch (error) {
      this.finish(job, both, error);
      throw error;
    }
  }

  private archiveName(host: string, now: Date, extension: string): string {
    const base = `cezar-backup-${host}-${archiveStamp(now)}`;
    for (let n = 1; n < 1000; n++) {
      const name = `${base}${n === 1 ? '' : `-${n}`}.tar.${extension}.age`;
      if (!existsSync(join(backupsDir(), name))) return name;
    }
    throw new Error('too many archives this minute');
  }

  private async writeBackup(to: EncryptTo, log: (line: string) => void, trigger: 'manual' | 'nightly', job: BackupJob): Promise<CreatedBackup> {
    const now = this.now();
    const host = archiveHost(this.options.hostname);
    const compression = availableCompression();
    if (compression === 'gzip') log(`this Node (${process.versions.node}) has no zstd — compressing with gzip`);
    const dir = backupsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = this.archiveName(host, now, compression === 'zstd' ? 'zst' : 'gz');
    job.archive = name;
    log(`collecting ${name}`);
    const { manifest, entries } = await collectBackup({
      cezarHome: cezarHomeDir(),
      locations: this.locations(),
      projects: await this.projects(),
      cezarVersion: this.options.version,
      compression,
      host,
      now,
      log,
    });
    const path = join(dir, name);
    const partial = join(dir, `.${name}.${process.pid}.partial`);
    try {
      const compressed = compressor(compression);
      pipeline(Readable.from(tarStream(entries)), compressed, (error) => {
        if (error) compressed.destroy(error);
      });
      const sealed = await encrypted(compressed, to, { scryptWorkFactor: this.options.scryptWorkFactor });
      await pipelineAsync(sealed, createWriteStream(partial, { mode: 0o600 }));
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      throw error;
    }
    const size = statSync(path).size;
    log(`wrote ${name} (${size} bytes, ${manifest.sizes.files} files)`);
    this.pruneLocal(name, log);

    const target = readBackupTarget();
    let uploaded = false;
    if (target) {
      log(`uploading to ${target.bucket}…`);
      const client = this.client(target);
      try {
        await client.putFile(name, path, size);
      } catch (error) {
        throw new Error(`the archive was written here, but the upload failed — ${message(error)}`);
      }
      mutateBackupState((state) => {
        state.uploaded[name] = this.now().toISOString();
      });
      uploaded = true;
      log('uploaded');
      if (trigger === 'nightly') await this.pruneRemote(client, host, readBackupState().keep, log);
    }
    return { name, path, size, uploaded, manifest };
  }

  private pruneLocal(keepName: string, log: (line: string) => void): void {
    const stale = this.listArchives().filter((archive) => archive.name !== keepName).slice(KEEP_LOCAL - 1);
    if (stale.length === 0) return;
    for (const archive of stale) rmSync(join(backupsDir(), archive.name), { force: true });
    mutateBackupState((state) => {
      for (const archive of stale) delete state.uploaded[archive.name];
    });
    log(`removed ${stale.length} older local archive(s)`);
  }

  /** Keep the newest `keep` of THIS host's archives under the prefix; names sort by time. */
  async pruneRemote(client: S3Client, host: string, keep: number, log: (line: string) => void): Promise<void> {
    const ours = hostArchivePattern(host);
    const objects = (await client.list(client.keyFor(`cezar-backup-${host}-`)))
      .filter((object) => ours.test(object.key.split('/').pop() ?? ''))
      .sort((a, b) => newestArchiveFirst(a.key, b.key));
    const stale = objects.slice(keep);
    for (const object of stale) await client.delete(object.key);
    if (stale.length > 0) log(`removed ${stale.length} older remote archive(s)`);
  }

  // ---- restore ----------------------------------------------------------------

  /**
   * Why a restore cannot start now, or null. It replaces the state a running or queued task
   * writes, so it waits for an idle workspace rather than racing one (review 2026-10-24).
   */
  restoreRefusal(): string | null {
    if (this.busy()) return `a ${this.job!.kind} is already running`;
    if (this.options.runs && !this.options.runs.idle()) {
      return 'tasks are running or queued — restore once they have finished (or stop them): a restore replaces the state they write';
    }
    return null;
  }

  /**
   * Start a restore in the background. `removeArchive`: the upload's temp file, gone afterwards.
   * `stillAllowed`: a gate the caller checked before a long upload, asked again now and once more
   * before the first file is placed (the `/setup` restore: no owner may have appeared meanwhile).
   */
  startRestore(input: { archive: string; identity: string; removeArchive?: boolean; stillAllowed?: () => string | null }): BackupJob {
    const refusal = this.restoreRefusal() ?? input.stillAllowed?.() ?? null;
    if (refusal) throw new BackupConflictError(refusal);
    const { job, log } = this.begin('restore');
    void this.restoreInto(input.archive, input.identity, log, job, { stillAllowed: input.stillAllowed }).then(
      () => this.finish(job, log),
      (error: unknown) => this.finish(job, log, error),
    ).finally(() => {
      if (input.removeArchive) rmSync(input.archive, { force: true });
    });
    return job;
  }

  /** The whole restore, awaited — what the CLI runs (no restart: there is no server). */
  async restore(input: { archive: string; identity: string; log?: (line: string) => void }): Promise<BackupManifest> {
    const { job, log } = this.begin('restore');
    const both = (line: string) => {
      log(line);
      input.log?.(line);
    };
    try {
      const manifest = await this.restoreInto(input.archive, input.identity, both, job, { restart: false });
      this.finish(job, both);
      return manifest;
    } catch (error) {
      this.finish(job, both, error);
      throw error;
    }
  }

  private async restoreInto(
    archive: string,
    identity: string,
    log: (line: string) => void,
    job: BackupJob,
    options: { restart?: boolean; stillAllowed?: () => string | null } = {},
  ): Promise<BackupManifest> {
    const home = cezarHomeDir();
    const staging = join(home, `.restore-${job.id}`);
    // Held from the first step, not just around the copy: nothing starts while the archive is read.
    const release = this.options.runs?.holdAdmission?.();
    if (release) log('holding new runs until the restore is in place');
    let writers: Array<() => void> = [];
    const releaseWriters = () => {
      for (const done of writers) done();
      writers = [];
    };
    try {
      log('decrypting and unpacking the archive');
      const manifest = await stageArchive(archive, identity, staging);
      log(
        `archive from ${manifest.host}, ${manifest.createdAt} (cezar ${manifest.cezarVersion}): ` +
          `${manifest.projects.length} project(s), ${manifest.sizes.files} files`,
      );
      const refusal = options.stillAllowed?.();
      if (refusal) throw new BackupConflictError(`nothing was restored: ${refusal}`);
      writers = this.writerHolds.map((hold) => hold());
      await applyStaged({ staging, manifest, cezarHome: home, locations: this.locations(), clone: this.options.clone, log });
      // Neither this process nor the next boot may prune a worktree the restored index lacks (§10).
      suspendOrphanPrune();
      writeRestoreMarker({ archive: basename(archive) });
      for (const hook of this.restoreHooks) hook();
      if (options.restart === false) {
        release?.();
        releaseWriters();
      } else if (this.options.restart) {
        // Both holds stay until the process goes: its shutdown flush must not win over the
        // restored runs.json, and a run started now could not be recorded.
        job.status = 'restarting';
        log('restarting…');
        // Let the poll that observes `restarting` get its answer before the listener goes.
        setTimeout(this.options.restart, 750).unref?.();
      } else {
        log('restored — restart cezar to load everything it brought back; new runs wait until then');
      }
      return manifest;
    } catch (error) {
      release?.();
      releaseWriters();
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---- nightly ----------------------------------------------------------------

  /** The scheduler's built-in item for the nightly run (absent when it is off). */
  nightlyItem(): { key: string; at: number; retryAfterMs: number; fire: () => Promise<void> } | null {
    const at = this.nightlyDueAt();
    if (at === null) return null;
    return { key: NIGHTLY_KEY, at, retryAfterMs: NIGHTLY_RETRY_MS, fire: () => this.fireNightly() };
  }

  /** Throws only to be retried later (a busy workspace or job); a failed backup is recorded. */
  async fireNightly(): Promise<void> {
    if (this.busy()) throw new Error('a backup job is already running');
    if (this.options.runs && !this.options.runs.idle()) throw new Error('waiting for the workspace to be idle');
    const ranAt = this.now().toISOString();
    mutateBackupState((state) => {
      state.lastNightlyAt = ranAt;
    });
    let failure: string | undefined;
    try {
      const to = this.encryptTo(undefined);
      const { job, log } = this.begin('backup');
      try {
        await this.writeBackup(to, log, 'nightly', job);
        this.finish(job, log);
      } catch (error) {
        this.finish(job, log, error);
        failure = message(error);
      }
    } catch (error) {
      failure = message(error);
    }
    mutateBackupState((state) => {
      state.lastError = failure;
    });
  }
}

/** Copy an archive out (`cezar backup create --out`). */
export function copyArchiveTo(path: string, out: string): void {
  copyFileSync(path, out);
}
