import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupJobSchema, backupStatusSchema, setupRestoreResponseSchema, type BackupStatus } from '@open-mercato/cezar-contract';
import { AuthService } from '../auth/service.ts';
import { issueSetupCode } from '../auth/store.ts';
import { base32Decode, hotp, totpStep } from '../auth/totp.ts';
import { setupRestoreRoutes } from '../backup/routes.ts';
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
    const restored = await apiRequest(app, '/api/v1/workspace/backup/restore', {
      method: 'POST',
      headers: { 'x-cezar-backup-identity': Buffer.from(TEST_IDENTITY).toString('base64'), 'content-length': String(bytes.length) },
      body: bytes,
    });
    expect(restored.status).toBe(200);
    const done = await settle();
    expect(done, done.log.join('\n')).toMatchObject({ kind: 'restore', status: 'done' });
    expect(readFileSync(join(dir, 'home', 'marker.json'), 'utf8')).toBe('{"before":true}');

    // No identity header: refused, and nothing was spooled.
    const missing = await apiRequest(app, '/api/v1/workspace/backup/restore', { method: 'POST', headers: { 'content-length': String(bytes.length) }, body: bytes });
    expect(missing.status).toBe(400);
    expect(readdirSync(join(dir, 'home')).filter((name) => name.startsWith('.restore-upload'))).toEqual([]);
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
    const upload = (code: string) =>
      apiRequest(app, '/api/v1/auth/setup/restore', {
        method: 'POST',
        headers: {
          'x-cezar-backup-identity': Buffer.from(TEST_IDENTITY).toString('base64'),
          'x-cezar-setup-code': code,
          'content-length': String(bytes.length),
        },
        body: bytes,
      });
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

/** The upload gates run on headers alone (review of 2026-10-24): nothing is read before they pass. */
describe('a restore upload, before its body', () => {
  let dir: string;
  let app: Hono;
  let auth: AuthService;
  let store: RunStore;
  const saved = { home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };
  const SETUP_PATH = '/api/v1/auth/setup/restore';

  /** A body that counts every read; `highWaterMark: 0` so nothing is pulled until someone reads. */
  const watchedBody = (bytes = 64) => {
    const seen = { pulls: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        seen.pulls += 1;
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }, { highWaterMark: 0 });
    return { body, seen };
  };
  const post = (target: Hono, path: string, headers: Record<string, string>, body: ReadableStream<Uint8Array>) =>
    apiRequest(target, path, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
  const identity = { 'x-cezar-backup-identity': Buffer.from(TEST_IDENTITY).toString('base64') };

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_AUTH = '1';
    dir = mkdtempSync(join(tmpdir(), 'cez-backup-gate-'));
    process.env.CEZ_HOME = join(dir, 'home');
    const repoRoot = join(dir, 'repo');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    auth = new AuthService({ scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    const backup = new BackupService({ version: 't', projects: async () => [], hostname: 'box' });
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: 't', backup, auth });
  });

  afterEach(async () => {
    store.flush();
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(dir);
  });

  it('answers 401 for a missing or wrong setup code without reading a byte', async () => {
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('no code');
    for (const code of [undefined, 'guessed']) {
      const { body, seen } = watchedBody();
      const res = await post(app, SETUP_PATH, { ...identity, 'content-length': '64', ...(code ? { 'x-cezar-setup-code': code } : {}) }, body);
      expect(res.status).toBe(401);
      expect(seen.pulls).toBe(0);
    }
  });

  it('answers 413 for an oversized Content-Length, and 411 for none, without reading a byte', async () => {
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('no code');
    const code = { 'x-cezar-setup-code': issued.setup.code };
    const big = watchedBody();
    const res = await post(app, SETUP_PATH, { ...identity, ...code, 'content-length': String(2 * 1024 ** 3) }, big.body);
    expect(res.status).toBe(413);
    expect(big.seen.pulls).toBe(0);
    const none = watchedBody();
    expect((await post(app, SETUP_PATH, { ...identity, ...code }, none.body)).status).toBe(411);
    expect(none.seen.pulls).toBe(0);
  });

  it('stops a body that runs past its Content-Length while streaming, and leaves no upload behind', async () => {
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('no code');
    const { body } = watchedBody(4096);
    const res = await post(app, SETUP_PATH, { ...identity, 'x-cezar-setup-code': issued.setup.code, 'content-length': '100' }, body);
    expect(res.status).toBe(413);
    expect(readdirSync(join(dir, 'home')).filter((name) => name.startsWith('.restore-upload'))).toEqual([]);
  });

  it('is not public once an owner exists: 401 from the guard, 404 from the route itself', async () => {
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('no code');
    const begun = await auth.beginSetup({ code: issued.setup.code, username: 'owner', password: 'a long enough password' }, { address: '127.0.0.1', label: 't' });
    if (!begun.ok) throw new Error(begun.error);
    const done = auth.completeSetup({ ticket: begun.ticket, code: hotp(base32Decode(begun.secret)!, totpStep(Date.now())) }, { address: '127.0.0.1', label: 't' });
    if (!done.ok) throw new Error(done.error);
    const guarded = watchedBody();
    expect((await post(app, SETUP_PATH, { ...identity, 'x-cezar-setup-code': issued.setup.code, 'content-length': '64' }, guarded.body)).status).toBe(401);
    expect(guarded.seen.pulls).toBe(0);

    // A signed-in caller passes the guard; the route still refuses before the body.
    const routes = new Hono().route('/api/v1', setupRestoreRoutes({ service: new BackupService({ version: 't' }), auth, enforced: () => true }));
    const direct = watchedBody();
    expect((await post(routes, SETUP_PATH, { ...identity, 'x-cezar-setup-code': issued.setup.code, 'content-length': '64' }, direct.body)).status).toBe(404);
    expect(direct.seen.pulls).toBe(0);
  });

  it('refuses a Settings restore from an untrusted caller before its body', async () => {
    process.env.CEZ_REMOTE = '1';
    process.env.CEZ_AUTH = '0';
    const { body, seen } = watchedBody();
    const res = await post(app, '/api/v1/workspace/backup/restore', { ...identity, 'content-length': '64', host: 'agents.example.dev', 'x-forwarded-proto': 'https' }, body);
    expect(res.status).toBe(409);
    expect(seen.pulls).toBe(0);
  });
});
