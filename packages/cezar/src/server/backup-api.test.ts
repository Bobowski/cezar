import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupJobSchema, backupStatusSchema, setupRestoreResponseSchema, type BackupStatus } from '@open-mercato/cezar-contract';
import { AuthService } from '../auth/service.ts';
import { issueSetupCode } from '../auth/store.ts';
import { TEST_IDENTITY, TEST_RECIPIENT } from '../backup/age-vector.testkit.ts';
import { BackupService } from '../backup/service.ts';
import type { AgentStateLocations } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** `/api/v1/workspace/backup/*` and `/api/v1/auth/setup/restore` (spec 2026-10-23-backup-restore §5). */
describe('the backup API', () => {
  let dir: string;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let backup: BackupService;
  const saved = { home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };
  const locations = (base: string): AgentStateLocations => ({
    claude: join(base, 'claude'), claudeState: null, codex: join(base, 'codex'), gh: join(base, 'gh'), ssh: join(base, 'ssh'), gitconfig: join(base, 'gitconfig'),
  });

  const json = (method: string, path: string, body?: unknown) =>
    apiRequest(app, path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const status = async (): Promise<BackupStatus> => backupStatusSchema.parse(await (await apiRequest(app, '/api/v1/workspace/backup')).json());
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      const job = (await status()).job;
      if (job && job.status !== 'running') return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('job did not settle');
  };

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_AUTH;
    dir = mkdtempSync(join(tmpdir(), 'cez-backup-api-'));
    process.env.CEZ_HOME = join(dir, 'home');
    repoRoot = join(dir, 'repo');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    backup = new BackupService({ version: 't', projects: async () => [], locations: () => locations(join(dir, 'agents')), hostname: 'box' });
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: 't', backup, auth: new AuthService({ scrypt: { N: 2 ** 10, r: 8, p: 1 } }) });
  });

  afterEach(async () => {
    store.flush();
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(dir);
  });

  it('says what each setting unlocks before anything is set', async () => {
    expect(await status()).toEqual({
      recipient: null,
      target: null,
      schedule: { nightly: false, keep: 14, lastRunAt: null, nextRunAt: null },
      archives: [],
      job: null,
      restartAvailable: false,
    });
    const res = await json('POST', '/api/v1/workspace/backup', {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/encrypted to first/);
  });

  it('validates the recipient, the target and the schedule', async () => {
    expect((await json('PUT', '/api/v1/workspace/backup/recipient', { recipient: 'ssh-ed25519 AAAA' })).status).toBe(400);
    expect((await json('PUT', '/api/v1/workspace/backup/recipient', { recipient: TEST_RECIPIENT })).status).toBe(200);
    expect((await json('PUT', '/api/v1/workspace/backup/target', { endpoint: 'ftp://x', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })).status).toBe(400);
    expect((await json('PUT', '/api/v1/workspace/backup/target', { endpoint: 'https://user:pw@x.example', bucket: 'bk', accessKeyId: 'k', secretAccessKey: 's' })).status).toBe(400);
    expect((await json('PUT', '/api/v1/workspace/backup/schedule', { nightly: true, keep: 14 })).status).toBe(409);
    const set = await json('PUT', '/api/v1/workspace/backup/target', {
      endpoint: 'https://acct.r2.cloudflarestorage.com/', bucket: 'cezar-backups', accessKeyId: 'AKID', secretAccessKey: 'the-secret-value',
    });
    expect(set.status).toBe(200);
    const text = await set.text();
    expect(text).not.toContain('the-secret-value');
    expect(backupStatusSchema.parse(JSON.parse(text)).target).toEqual({
      endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'cezar-backups', prefix: '', region: 'us-east-1', accessKeyId: 'AKID', secretSet: true,
    });
    expect(readFileSync(join(dir, 'home', 'backup-target.json'), 'utf8')).toContain('the-secret-value');
    expect((await json('PUT', '/api/v1/workspace/backup/schedule', { nightly: true, keep: 0 })).status).toBe(400);
    expect((await json('PUT', '/api/v1/workspace/backup/schedule', { nightly: true, keep: 7 })).status).toBe(200);
    expect((await status()).schedule).toMatchObject({ nightly: true, keep: 7, nextRunAt: expect.any(String) });
    expect((await json('PUT', '/api/v1/workspace/backup/target', null)).status).toBe(200);
    expect((await status())).toMatchObject({ target: null, schedule: { nightly: false } });
  });

  it('backs up, serves the archive as a download, and restores an upload', async () => {
    await json('PUT', '/api/v1/workspace/backup/recipient', { recipient: TEST_RECIPIENT });
    writeFileSync(join(dir, 'home', 'marker.json'), '{"before":true}');
    const started = await json('POST', '/api/v1/workspace/backup');
    expect(started.status).toBe(200);
    expect(backupStatusSchema.parse(await started.json()).job).toMatchObject({ kind: 'backup', status: 'running' });
    const job = await settle();
    expect(job.status, job.log.join('\n')).toBe('done');
    const [archive] = (await status()).archives;
    expect(archive!.name).toBe(job.archive);

    const download = await apiRequest(app, `/api/v1/workspace/backup/archives/${archive!.name}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${archive!.name}"`);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect(bytes.length).toBe(archive!.size);
    expect((await apiRequest(app, '/api/v1/workspace/backup/archives/..%2Fconfig.json')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/workspace/backup/archives/cezar-backup-box-20200101T0000Z.tar.zst.age')).status).toBe(404);

    writeFileSync(join(dir, 'home', 'marker.json'), '{"before":false}');
    const form = new FormData();
    form.set('archive', new File([bytes], archive!.name));
    form.set('identity', TEST_IDENTITY);
    const restored = await apiRequest(app, '/api/v1/workspace/backup/restore', { method: 'POST', body: form });
    expect(restored.status).toBe(200);
    const done = await settle();
    expect(done, done.log.join('\n')).toMatchObject({ kind: 'restore', status: 'done' });
    expect(readFileSync(join(dir, 'home', 'marker.json'), 'utf8')).toBe('{"before":true}');

    const missing = new FormData();
    missing.set('identity', TEST_IDENTITY);
    expect((await apiRequest(app, '/api/v1/workspace/backup/restore', { method: 'POST', body: missing })).status).toBe(400);
  }, 30_000);

  it('is refused on a hosted cockpit that does not enforce sign-in', async () => {
    process.env.CEZ_REMOTE = '1';
    process.env.CEZ_AUTH = '0';
    const res = await apiRequest(app, '/api/v1/workspace/backup', { headers: { host: 'agents.example.dev', 'x-forwarded-proto': 'https' } });
    expect(res.status).toBe(409);
  });

  it('restores from /setup only with the setup code, and the job id is what follows it', async () => {
    const bytes = await (async () => {
      await json('PUT', '/api/v1/workspace/backup/recipient', { recipient: TEST_RECIPIENT });
      await json('POST', '/api/v1/workspace/backup');
      const job = await settle();
      return readFileSync(join(dir, 'home', 'backups', job.archive!));
    })();
    const upload = (code: string) => {
      const form = new FormData();
      form.set('archive', new File([bytes], 'a.age'));
      form.set('identity', TEST_IDENTITY);
      form.set('code', code);
      return apiRequest(app, '/api/v1/auth/setup/restore', { method: 'POST', body: form });
    };
    // A local cockpit has no setup page; Settings → Backup is the way in.
    expect((await upload('anything')).status).toBe(409);

    process.env.CEZ_AUTH = '1';
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('no code');
    expect((await upload('guessed')).status).toBe(401);
    // Anonymous, but not unauthenticated by accident: everything else still answers 401.
    expect((await apiRequest(app, '/api/v1/workspace/backup')).status).toBe(401);
    const accepted = await upload(issued.setup.code);
    expect(accepted.status).toBe(200);
    const { job } = setupRestoreResponseSchema.parse(await accepted.json());
    let polled = backupJobSchema.parse(await (await apiRequest(app, `/api/v1/auth/setup/restore?job=${job}`)).json());
    for (let i = 0; i < 400 && polled.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      polled = backupJobSchema.parse(await (await apiRequest(app, `/api/v1/auth/setup/restore?job=${job}`)).json());
    }
    expect(polled, polled.log.join('\n')).toMatchObject({ kind: 'restore', status: 'done' });
    expect((await apiRequest(app, `/api/v1/auth/setup/restore?job=${'x'.repeat(22)}`)).status).toBe(404);
  }, 30_000);
});
