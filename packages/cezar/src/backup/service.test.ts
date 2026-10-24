import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../auth/service.ts';
import { issueSetupCode } from '../auth/store.ts';
import { base32Decode, hotp, totpStep } from '../auth/totp.ts';
import type { AgentStateLocations } from '../paths.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { TEST_IDENTITY, TEST_RECIPIENT } from './age-vector.testkit.ts';
import { fakeS3 } from './s3-fake.testkit.ts';
import { S3Client } from './s3.ts';
import { BackupConflictError, BackupService, NIGHTLY_KEY } from './service.ts';
import { readBackupState } from './state.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const META = { address: '203.0.113.7', label: 'test' };
const PASSWORD = 'a long enough password';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });

function locationsUnder(dir: string): AgentStateLocations {
  return {
    claude: join(dir, 'claude'),
    claudeState: null,
    codex: join(dir, 'codex'),
    gh: join(dir, 'gh'),
    ssh: join(dir, 'ssh'),
    gitconfig: join(dir, 'gitconfig'),
  };
}

async function waitForJob(service: BackupService): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const job = service.status().job;
    if (job && job.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not finish');
}

describe('BackupService', () => {
  let root: string;
  let saved: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-backup-service-'));
    saved = process.env.CEZ_HOME;
    process.env.CEZ_HOME = join(root, 'home');
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = saved;
    await removeTempDir(root);
  });

  it('asks for a recipient before it backs anything up, and a passphrase when that is the recipient', async () => {
    const service = new BackupService({ version: 'test', projects: async () => [], locations: () => locationsUnder(join(root, 'agents')) });
    expect(() => service.startBackup()).toThrow(BackupConflictError);
    service.setRecipient({ passphrase: true });
    expect(() => service.startBackup()).toThrow(/passphrase/);
    expect(service.status().recipient).toEqual({ kind: 'passphrase' });
    // The passphrase itself is never written down.
    expect(readFileSync(join(root, 'home', 'backup.json'), 'utf8')).not.toContain('correct');
  });

  it('restores a backup into an empty CEZ_HOME: the registry loads, the owner signs in, the files come back', async () => {
    // ---- the machine being backed up ------------------------------------------------
    const project = join(root, 'projects', 'fancy');
    mkdirSync(project, { recursive: true });
    git(project, 'init', '-q');
    writeFileSync(join(project, '.gitignore'), '.env\n.ai/cezar/\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'init');
    writeFileSync(join(project, '.env'), 'DATABASE_URL=postgres://x\n');
    mkdirSync(join(project, '.ai', 'cezar', 'workflows'), { recursive: true });
    writeFileSync(join(project, '.ai', 'cezar', 'workflows', 'ship.yaml'), 'steps: []\n');
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push({ id: 'fancy', root: project, addedAt: new Date().toISOString() } as (typeof config.projects)[number]);
    });

    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('no setup code');
    const auth = new AuthService({ scrypt: FAST });
    const begun = await auth.beginSetup({ code: issued.setup.code, username: 'mateusz', password: PASSWORD }, META);
    if (!begun.ok) throw new Error(begun.error);
    const secret = begun.secret;
    const done = auth.completeSetup({ ticket: begun.ticket, code: hotp(base32Decode(secret)!, totpStep(Date.now())) }, META);
    if (!done.ok) throw new Error(done.error);

    const agents = locationsUnder(join(root, 'agents'));
    mkdirSync(join(agents.claude), { recursive: true });
    writeFileSync(join(agents.claude, '.credentials.json'), '{"token":"claude"}');
    mkdirSync(agents.ssh, { recursive: true });
    writeFileSync(join(agents.ssh, 'id_ed25519'), 'PRIVATE');
    writeFileSync(agents.gitconfig, '[user]\n\tname = Mateusz\n');

    const service = new BackupService({ version: '0.17.0', projects: async () => [{ id: 'fancy', root: project }], locations: () => agents, hostname: 'vps' });
    service.setRecipient({ recipient: TEST_RECIPIENT });
    const created = await service.createBackup();
    expect(created.name).toMatch(/^cezar-backup-vps-\d{8}T\d{4}Z\.tar\.(zst|gz)\.age$/);
    expect(service.status().archives.map((archive) => archive.name)).toEqual([created.name]);
    const archive = join(root, 'laptop.age');
    writeFileSync(archive, readFileSync(created.path));

    // ---- a fresh container: empty volumes, no project on disk ----------------------
    process.env.CEZ_HOME = join(root, 'fresh-home');
    rmSync(project, { recursive: true, force: true });
    const freshAgents = locationsUnder(join(root, 'fresh-agents'));
    const cloned: string[] = [];
    let restarted = 0;
    let reloaded = 0;
    const fresh = new BackupService({
      version: '0.17.0',
      projects: async () => [],
      locations: () => freshAgents,
      clone: async (_remote, at) => {
        cloned.push(at);
        mkdirSync(at, { recursive: true });
        git(at, 'init', '-q');
      },
      restart: () => {
        restarted += 1;
      },
      afterRestore: () => {
        reloaded += 1;
      },
    });
    // A wrong key fails before anything is put in place.
    await expect(fresh.restore({ archive, identity: 'not the key' })).rejects.toThrow(/does not open the archive/);
    expect(existsSync(join(root, 'fresh-home', 'auth.json'))).toBe(false);

    const job = fresh.startRestore({ archive, identity: TEST_IDENTITY });
    await waitForJob(fresh);
    expect(fresh.jobById(job.id)?.status, fresh.jobById(job.id)?.log.join('\n')).toBe('restarting');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(restarted).toBe(1);
    expect(reloaded).toBe(1);

    const config = await loadWorkspaceConfig();
    expect(config.projects.map((entry) => entry.id)).toEqual(['fancy']);
    const restoredAuth = new AuthService({ scrypt: FAST });
    expect(restoredAuth.setupRequired()).toBe(false);
    const login = await restoredAuth.login({ username: 'mateusz', password: PASSWORD }, META);
    if (!login.ok) throw new Error(login.error);
    const verified = restoredAuth.verifyLogin({ ticket: login.ticket, code: hotp(base32Decode(secret)!, totpStep(Date.now() + 30_000)) }, META);
    expect(verified.ok).toBe(true);

    expect(readFileSync(join(freshAgents.claude, '.credentials.json'), 'utf8')).toBe('{"token":"claude"}');
    expect(readFileSync(join(freshAgents.ssh, 'id_ed25519'), 'utf8')).toBe('PRIVATE');
    expect(readFileSync(freshAgents.gitconfig, 'utf8')).toContain('Mateusz');
    // No remote recorded → nothing to clone from; the project is reported, not invented.
    expect(cloned).toEqual([]);
    expect(fresh.jobById(job.id)!.log.join('\n')).toContain('skipped fancy: not on disk and it has no remote to clone');
    // The staging dir is gone, and so is nothing it should not have touched.
    expect(readdirSync(join(root, 'fresh-home')).filter((name) => name.startsWith('.restore'))).toEqual([]);
  }, 30_000);

  it('clones a project that is not on disk from its recorded remote, then puts its files back', async () => {
    const upstream = join(root, 'upstream');
    mkdirSync(upstream);
    git(upstream, 'init', '-q');
    writeFileSync(join(upstream, 'README.md'), '# app');
    writeFileSync(join(upstream, '.gitignore'), '.env\n');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-q', '-m', 'init');
    const project = join(root, 'projects', 'app');
    git(root, 'clone', '-q', upstream, project);
    writeFileSync(join(project, '.env'), 'KEY=1\n');
    // The registry is what vouches for the root on the way back (a restore never trusts the manifest alone).
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push({ id: 'app', root: project, addedAt: new Date().toISOString() } as (typeof config.projects)[number]);
    });

    const agents = locationsUnder(join(root, 'agents'));
    const service = new BackupService({ version: 't', projects: async () => [{ id: 'app', root: project }], locations: () => agents, hostname: 'vps' });
    service.setRecipient({ recipient: TEST_RECIPIENT });
    const created = await service.createBackup();
    expect(created.manifest.projects[0]).toMatchObject({ id: 'app', remote: upstream });

    rmSync(project, { recursive: true, force: true });
    process.env.CEZ_HOME = join(root, 'fresh-home');
    const fresh = new BackupService({ version: 't', projects: async () => [], locations: () => locationsUnder(join(root, 'fresh-agents')) });
    await fresh.restore({ archive: created.path, identity: TEST_IDENTITY });
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('# app');
    expect(readFileSync(join(project, '.env'), 'utf8')).toBe('KEY=1\n');
  }, 30_000);

  it('keeps the five newest local archives', async () => {
    let clock = Date.UTC(2026, 9, 23, 3, 0);
    const service = new BackupService({
      version: 't',
      projects: async () => [],
      locations: () => locationsUnder(join(root, 'agents')),
      hostname: 'vps',
      now: () => new Date(clock),
    });
    service.setRecipient({ recipient: TEST_RECIPIENT });
    const names: string[] = [];
    for (let i = 0; i < 7; i++) {
      names.push((await service.createBackup()).name);
      clock += 60_000;
    }
    expect(service.status().archives.map((archive) => archive.name).sort()).toEqual(names.slice(2).sort());
  }, 30_000);

  it('uploads to the target, and a nightly run keeps N remote archives of this host', async () => {
    const fake = fakeS3('bk');
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = fake.server.address() as AddressInfo;
      fake.objects.set('c/cezar-backup-otherhost-20200101T0300Z.tar.zst.age', Buffer.from('not ours'));
      let clock = Date.UTC(2026, 9, 23, 3, 0);
      let idle = false;
      const service = new BackupService({
        version: 't',
        projects: async () => [],
        locations: () => locationsUnder(join(root, 'agents')),
        hostname: 'vps',
        now: () => new Date(clock),
        timeZone: 'UTC',
        runs: { idle: () => idle },
      });
      service.setRecipient({ recipient: TEST_RECIPIENT });
      expect(() => service.setSchedule({ nightly: true, keep: 2 })).toThrow(/remote target/);
      service.setTarget({ endpoint: `http://127.0.0.1:${port}`, bucket: 'bk', prefix: 'c', accessKeyId: 'key', secretAccessKey: 'secret' });
      expect(service.status().target).toEqual({ endpoint: `http://127.0.0.1:${port}`, bucket: 'bk', prefix: 'c', region: 'us-east-1', accessKeyId: 'key', secretSet: true });
      expect(JSON.stringify(service.status())).not.toContain('secret"');
      expect(await service.testTarget()).toEqual({ ok: true });

      const manual = await service.createBackup();
      expect(manual.uploaded).toBe(true);
      expect(service.status().archives[0]!.uploaded).toBe(true);

      expect(service.nightlyItem()).toBeNull();
      service.setSchedule({ nightly: true, keep: 2 });
      const item = service.nightlyItem()!;
      expect(item.key).toBe(NIGHTLY_KEY);
      expect(new Date(item.at).toISOString()).toBe('2026-10-24T03:00:00.000Z');
      expect(service.status().schedule.nextRunAt).toBe('2026-10-24T03:00:00.000Z');

      // Busy: thrown, so the scheduler tries again later; nothing recorded.
      await expect(item.fire()).rejects.toThrow(/idle/);
      expect(readBackupState().lastNightlyAt).toBeUndefined();
      idle = true;
      for (let night = 0; night < 3; night++) {
        clock = Date.UTC(2026, 9, 24 + night, 3, 0);
        await service.nightlyItem()!.fire();
      }
      expect(readBackupState().lastError).toBeUndefined();
      const keys = [...fake.objects.keys()].sort();
      expect(keys).toEqual([
        'c/cezar-backup-otherhost-20200101T0300Z.tar.zst.age',
        expect.stringMatching(/^c\/cezar-backup-vps-20261025T0300Z/),
        expect.stringMatching(/^c\/cezar-backup-vps-20261026T0300Z/),
      ]);
      expect(service.status().schedule.lastRunAt).toBe('2026-10-26T03:00:00.000Z');
      expect(service.status().schedule.nextRunAt).toBe('2026-10-27T03:00:00.000Z');

      // A passphrase recipient cannot run unattended: it switches nightly off.
      service.setRecipient({ passphrase: true });
      expect(service.status().schedule.nightly).toBe(false);
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  }, 30_000);

  it('says so when the scheduler that fires the nightly run is off', () => {
    const service = new BackupService({ version: 't', schedulerActive: () => false });
    service.setRecipient({ recipient: TEST_RECIPIENT });
    service.setTarget({ endpoint: 'http://127.0.0.1:9', bucket: 'bk', accessKeyId: 'k', secretAccessKey: 's' });
    service.setSchedule({ nightly: true, keep: 3 });
    expect(service.status().schedule).toMatchObject({ nightly: true, nextRunAt: null, lastError: expect.stringMatching(/CEZ_AUTOMATIONS=0/) });
  });

  it('runs one job at a time', async () => {
    const service = new BackupService({ version: 't', projects: async () => [], locations: () => locationsUnder(join(root, 'agents')) });
    service.setRecipient({ recipient: TEST_RECIPIENT });
    service.startBackup();
    expect(() => service.startBackup()).toThrow(/already running/);
    await waitForJob(service);
    expect(service.status().job?.status).toBe('done');
  });
});

describe('remote retention', () => {
  const name = (host: string, stamp: string, n?: number) => `c/cezar-backup-${host}-${stamp}${n ? `-${n}` : ''}.tar.zst.age`;

  async function pruned(keys: string[], host: string, keep: number): Promise<string[]> {
    const fake = fakeS3('bk');
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = fake.server.address() as AddressInfo;
      for (const key of keys) fake.objects.set(key, Buffer.from('x'));
      const client = new S3Client({ endpoint: `http://127.0.0.1:${port}`, bucket: 'bk', prefix: 'c', region: 'us-east-1', accessKeyId: 'key', secretAccessKey: 'secret' });
      await new BackupService({ version: 't' }).pruneRemote(client, host, keep, () => {});
      return [...fake.objects.keys()].sort();
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  }

  it('counts only this host: `web` never prunes `web-2`', async () => {
    const theirs = [name('web-2', '20261020T0300Z'), name('web-2', '20261021T0300Z')];
    const ours = [name('web', '20261022T0300Z'), name('web', '20261023T0300Z')];
    expect(await pruned([...theirs, ...ours], 'web', 1)).toEqual([...theirs, ours[1]!].sort());
  });
});
