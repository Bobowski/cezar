import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { versionEntry, writeManifest } from '../self-update/layout.ts';
import { RegistryCache } from '../self-update/registry.ts';
import { SelfUpdateService } from '../self-update/service.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `/api/v1/workspace/self-update` (self-update PoC). The load-bearing security property: a
 * HOSTED cockpit (`CEZ_REMOTE`) may only apply a version that is forward IN TIME. Installing a
 * published package cannot inject code, but installing an older one can — every hosted guard
 * (the `/api/*` request-origin check #426, the `localHandoff` 409 on agent-config writes that
 * closes the hooks RCE path) lives in the running version, so moving back to a release that
 * predates them re-opens exactly what they close. A local cockpit keeps the whole picker.
 *
 * The registry is stubbed: the unit gate stays hermetic (no npmjs.org round trip), and the
 * stubbed publish dates encode the trap that semver order alone misses — cezar's nightlies are
 * `<next-version>-nightly.<date>.<run>`, so `0.13.0-nightly.20260901.3` OUTRANKS the running
 * `0.12.1` while having been published nineteen days before it.
 */
describe('the self-update API', () => {
  const RUNNING = '0.12.1';
  const registryDocument = {
    'dist-tags': { latest: '0.13.0', nightly: '0.13.0-nightly.20260901.3' },
    versions: {
      '0.11.1': {},
      '0.12.0': {},
      '0.12.1': {},
      '0.13.0-nightly.20260901.3': {},
      '0.13.0': {},
    },
    time: {
      '0.11.1': '2026-08-01T00:00:00.000Z',
      '0.12.0': '2026-09-01T00:00:00.000Z',
      '0.12.1': '2026-09-20T00:00:00.000Z',
      // Published BEFORE the running 0.12.1, yet semver-newer than it. The trap.
      '0.13.0-nightly.20260901.3': '2026-09-01T03:00:00.000Z',
      '0.13.0': '2026-09-27T00:00:00.000Z',
    },
  };

  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let app: Hono;
  let selfUpdate: SelfUpdateService;
  const prevRemote = process.env.CEZ_REMOTE;
  const prevHome = process.env.CEZ_HOME;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-selfupdate-'));
    home = mkdtempSync(join(tmpdir(), 'cez-selfupdate-home-'));
    process.env.CEZ_HOME = home;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const stubFetch = (async () =>
      new Response(JSON.stringify(registryDocument), { status: 200 })) as unknown as typeof fetch;
    selfUpdate = new SelfUpdateService({
      pkgName: '@open-mercato/cezar',
      version: RUNNING,
      entry: join(home, 'somewhere', 'dist', 'index.js'),
      restart: () => {},
      // No background branch fetch: the unit gate never reaches a remote.
      env: { ...process.env, CEZ_HOME: home, CEZ_SELF_UPDATE_CHECK: '0' },
      registry: new RegistryCache('@open-mercato/cezar', stubFetch),
    });
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: RUNNING, selfUpdate });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
    if (prevHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = prevHome;
  });

  const apply = (version: string) =>
    apiRequest(app, '/api/v1/workspace/self-update/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
    });
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  it('answers the status with the running version and an install kind', async () => {
    const res = await apiRequest(app, '/api/v1/workspace/self-update');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; installKind: string; job: unknown };
    expect(body.version).toBe(RUNNING);
    expect(['managed', 'global-npm', 'npx', 'checkout', 'unknown']).toContain(body.installKind);
    expect(body.job).toBeNull();
  });

  it('keeps the branch check alive for a cockpit only — a probe reading health never touches it', async () => {
    const touch = vi.spyOn(selfUpdate, 'touch');
    expect((await apiRequest(app, '/api/v1/health')).status).toBe(200);
    expect(touch).not.toHaveBeenCalled();
    await apiRequest(app, '/api/v1/health', { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('rejects a body that is not a plain version string', async () => {
    for (const version of ['', 'https://evil.example/x.tgz', '../../etc', 'a'.repeat(65)]) {
      expect((await apply(version)).status).toBe(400);
    }
  });

  it('refuses an older or equal version in hosted mode', async () => {
    process.env.CEZ_REMOTE = '1';
    for (const target of ['0.11.1', '0.12.0', RUNNING, '0.11.1+local']) {
      const res = await apply(target);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('is not newer than the running');
    }
  });

  // The whole point of the publish-date check: semver order alone would wave this one through.
  it('refuses a semver-newer version that was published BEFORE the running one', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apply('0.13.0-nightly.20260901.3');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('was published before the running');
  });

  it('refuses a prerelease the registry cannot date, when the running version is a release', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apply('0.99.0-nightly.20260101.1');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('gave no publish date to check it against');
  });

  it('lets a genuinely newer version past the hosted guard', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apply('0.13.0');
    expect(res.status).toBe(409);
    // Past the forward-only guard: what refuses now is the install-kind capability, not it.
    const error = await errorOf(res);
    expect(error).not.toContain('can only update forward');
    expect(error).toMatch(/could not tell how it was installed|npx|npm -g|git checkout/);
  });

  // Spec 2026-10-23 §3.6: a branch build is dated by its commit, never by the registry.
  it('takes a hosted branch-build apply through the forward-only rule by commit date', async () => {
    process.env.CEZ_REMOTE = '1';
    const branchBuild = (id: string, version: string, at: string) => {
      const env = { ...process.env, CEZ_HOME: home };
      writeManifest(id, { version, source: 'branch', installedAt: at, commit: { sha: id.split('+')[1]!, subject: '', at, branch: 'brutus' } }, env);
      mkdirSync(join(versionEntry(id, env), '..'), { recursive: true });
      writeFileSync(versionEntry(id, env), '');
    };
    branchBuild('0.11.1+aaaaaaaa', '0.11.1', '2026-08-01T00:00:00.000Z');
    branchBuild('0.12.1+bbbbbbbb', '0.12.1', '2026-10-01T00:00:00.000Z');

    // Not on disk and no clone to date it from.
    let res = await apply('0.12.1+deadbeef');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain("cannot date 0.12.1+deadbeef's commit");
    // The running build carries no commit, so its version is the floor.
    res = await apply('0.11.1+aaaaaaaa');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('is older than the running 0.12.1');
    // Forward in time, but no clone whose branch tip reaches it: refused as not on the branch.
    res = await apply('0.12.1+bbbbbbbb');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('is not on');
  });

  it('runs the same hosted guard before scheduling an update for when idle', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apiRequest(app, '/api/v1/workspace/self-update/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.11.1', whenIdle: true }),
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('is not newer than the running');
  });

  it('cancels a scheduled update, answering the status', async () => {
    const res = await apiRequest(app, '/api/v1/workspace/self-update/scheduled', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scheduled: unknown }).scheduled).toBeNull();
  });

  it('never applies the forward-only rule to a local cockpit', async () => {
    for (const target of ['0.11.1', RUNNING, '0.13.0-nightly.20260901.3']) {
      const res = await apply(target);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).not.toContain('can only update forward');
    }
  });

  // Spec 2026-10-23 §3.7: a followed branch is code this server builds and runs, so the channel
  // is a trusted-operator write — the line agent-config writes draw.
  describe('the update channel', () => {
    const prevAuth = process.env.CEZ_AUTH;
    afterEach(() => {
      if (prevAuth === undefined) delete process.env.CEZ_AUTH;
      else process.env.CEZ_AUTH = prevAuth;
    });
    const put = (body: unknown) =>
      apiRequest(app, '/api/v1/workspace/self-update/channel', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const branch = { remote: 'https://github.com/open-mercato/cezar.git', branch: 'brutus' };

    it('follows a branch given with the channel, and reports it as editable', async () => {
      const res = await put({ channel: 'branch', branch });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { channel: string; channelEditable: boolean; branch?: { remote: string; branch: string } };
      expect(body.channel).toBe('branch');
      expect(body.channelEditable).toBe(true);
      expect(body.branch).toMatchObject(branch);
    });

    it('refuses the branch channel with nothing to follow, and a remote that is not a remote', async () => {
      expect((await put({ channel: 'branch' })).status).toBe(409);
      for (const remote of ['file:///srv/cezar', '/srv/cezar', '--upload-pack=touch /tmp/x']) {
        expect((await put({ channel: 'branch', branch: { remote, branch: 'main' } })).status).toBe(400);
      }
      expect((await put({ channel: 'branch', branch: { ...branch, branch: '--orphan' } })).status).toBe(400);
    });

    it('is not writable on a hosted cockpit without sign-in', async () => {
      process.env.CEZ_REMOTE = '1';
      process.env.CEZ_AUTH = '0';
      const res = await put({ channel: 'stable' });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('trusted operator');
    });
  });
});
