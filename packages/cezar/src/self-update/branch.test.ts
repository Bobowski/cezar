import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { parseUpdateBranch, processStartTicks, sourceLockHolder, sourceLockPath, takeOverStaleLock } from './branch.ts';
import { runSelfUpdateCommand } from './cli.ts';
import { activate, activeId, listInstalled, previousId, readManifest, versionEntry, writeManifest } from './layout.ts';
import { RegistryCache } from './registry.ts';
import { SelfUpdateService, type SelfUpdateDeps } from './service.ts';

/**
 * The `branch` channel (spec 2026-10-23 §3) against a real fixture repository: the remote the
 * service is configured with is an `https://` URL (the only shapes it accepts), rewritten to the
 * fixture through git's own `url.<base>.insteadOf` — so every fetch is real git, and none leaves
 * the machine. npm is stubbed: the build, pack and install are recorded, never run.
 */
const REMOTE = 'https://example.invalid/open-mercato/cezar.git';
const BRANCH = { remote: REMOTE, branch: 'brutus' };
const offline = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;

let root: string;
let home: string;
let remote: string;
let env: NodeJS.ProcessEnv;
const prevHome = process.env.CEZ_HOME;

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
}

/** Commit `files` on the fixture's current branch at `date`; returns the full sha. */
function commit(subject: string, date: string, files: Record<string, string> = {}): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(remote, path, '..'), { recursive: true });
    writeFileSync(join(remote, path), body);
  }
  writeFileSync(join(remote, 'log.txt'), `${subject}\n`);
  git(remote, ['add', '-A']);
  git(remote, ['commit', '-q', '-m', subject], date);
  return git(remote, ['rev-parse', 'HEAD']);
}

const pkg = (version = '0.17.0') => JSON.stringify({ name: '@open-mercato/cezar', version });

/** A complete install on disk, as the layout reads one. */
function fakeInstall(id: string, manifest: Parameters<typeof writeManifest>[1]): void {
  writeManifest(id, manifest, env);
  mkdirSync(join(versionEntry(id, env), '..'), { recursive: true });
  writeFileSync(versionEntry(id, env), '');
}

/** A running branch build of `sha`, through `current` like the launcher runs it. */
function runningBuild(sha: string, at: string): string {
  const id = `0.17.0+${sha.slice(0, 8)}`;
  fakeInstall(id, { version: '0.17.0', source: 'branch', installedAt: '2026-10-01T00:00:00.000Z', commit: { sha, subject: 'running', at, branch: 'brutus' } });
  activate(id, env);
  return id;
}

interface Recorded {
  calls: string[];
  deps: Partial<SelfUpdateDeps>;
}

/** npm and the build, recorded: pack writes a tarball, install writes the entry file. */
function stubs(opts: { failBuild?: boolean } = {}): Recorded {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      buildCheckout: async (checkout) => {
        calls.push(`build@${git(checkout.worktree, ['rev-parse', 'HEAD']).slice(0, 8)}`);
        if (opts.failBuild) throw new Error('npm run build:server failed (exit 2)');
      },
      runNpm: async (args, cwd) => {
        if (args[0] === 'pack') {
          calls.push('pack');
          writeFileSync(join(args[args.indexOf('--pack-destination') + 1]!, 'open-mercato-cezar-0.17.0.tgz'), '');
        } else if (args[0] === 'install') {
          calls.push('install');
          const staging = args[args.indexOf('--prefix') + 1]!;
          const entry = join(staging, 'node_modules', '@open-mercato', 'cezar', 'dist', 'index.js');
          mkdirSync(join(entry, '..'), { recursive: true });
          writeFileSync(entry, '');
        } else calls.push(args.join(' '));
        void cwd;
      },
    },
  };
}

function service(deps: Partial<SelfUpdateDeps> = {}): SelfUpdateService {
  return new SelfUpdateService({
    pkgName: '@open-mercato/cezar',
    version: '0.17.0',
    entry: join(home, 'versions', 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'index.js'),
    restart: () => {},
    env,
    registry: new RegistryCache('@open-mercato/cezar', offline),
    imageSourceFile: join(root, 'no-image-source.json'),
    ...deps,
  });
}

const followBranch = () =>
  mergeWriteWorkspaceConfig((config) => {
    config.updateChannel = 'branch';
    config.updateBranch = { ...BRANCH };
    config.updateChannelSource = 'user';
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-branch-'));
  home = join(root, 'home');
  remote = join(root, 'remote');
  mkdirSync(remote, { recursive: true });
  git(remote, ['init', '-q', '-b', 'brutus']);
  process.env.CEZ_HOME = home;
  const count = Number(process.env.GIT_CONFIG_COUNT ?? '0');
  env = {
    ...process.env,
    CEZ_HOME: home,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: `url.${remote.replace(/\\/g, '/')}.insteadOf`,
    [`GIT_CONFIG_VALUE_${count}`]: REMOTE,
  };
  delete env.CEZ_DRY_RUN;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.CEZ_HOME;
  else process.env.CEZ_HOME = prevHome;
});

describe('which branch the channel follows', () => {
  it('reads CEZ_UPDATE_BRANCH as <remote>#<branch>, and drops anything that is not a remote and a branch', () => {
    expect(parseUpdateBranch('https://github.com/open-mercato/cezar.git#brutus')).toEqual({ remote: 'https://github.com/open-mercato/cezar.git', branch: 'brutus' });
    expect(parseUpdateBranch('git@github.com:open-mercato/cezar.git#feat/x')).toEqual({ remote: 'git@github.com:open-mercato/cezar.git', branch: 'feat/x' });
    expect(parseUpdateBranch('ssh://git@host:2222/cezar.git#main')?.branch).toBe('main');
    for (const bad of ['file:///srv/cezar#main', '/srv/cezar#main', 'ssh://-oProxyCommand=x/y#main', 'git@-oProxyCommand:x#main', 'https://user:token@github.com/x/y.git#main', 'https://github.com/x/y.git#--upload-pack=x', 'https://github.com/x/y.git#a..b', 'https://github.com/x/y.git', '#main']) {
      expect(parseUpdateBranch(bad)).toBeNull();
    }
  });

  it('prefers the saved branch, then CEZ_UPDATE_BRANCH, then the image source', async () => {
    const imageSource = join(root, 'source.json');
    writeFileSync(imageSource, JSON.stringify({ commit: 'abc', branch: 'image-branch', remote: 'https://example.invalid/image.git', committedAt: '' }));
    const svc = (extra: NodeJS.ProcessEnv) => new SelfUpdateService({ ...{ pkgName: 'x', version: '0.17.0', entry: '/x', restart: () => {} }, env: { ...env, ...extra }, imageSourceFile: imageSource });
    expect(await svc({}).updateBranch()).toEqual({ remote: 'https://example.invalid/image.git', branch: 'image-branch' });
    // An invalid seed is dropped, never half-used.
    expect(await svc({ CEZ_UPDATE_BRANCH: 'file:///tmp/x#main' }).updateBranch()).toEqual({ remote: 'https://example.invalid/image.git', branch: 'image-branch' });
    expect(await svc({ CEZ_UPDATE_BRANCH: `${REMOTE}#env-branch` }).updateBranch()).toEqual({ remote: REMOTE, branch: 'env-branch' });
    await svc({}).setChannel('branch', { remote: REMOTE, branch: 'saved' });
    expect(await svc({ CEZ_UPDATE_BRANCH: `${REMOTE}#env-branch` }).updateBranch()).toEqual({ remote: REMOTE, branch: 'saved' });
  });

  it('takes the branch channel from CEZ_UPDATE_CHANNEL, and a saved channel over it', async () => {
    const svc = new SelfUpdateService({ pkgName: 'x', version: '0.17.0', entry: '/x', restart: () => {}, env: { ...env, CEZ_UPDATE_CHANNEL: 'branch' }, imageSourceFile: join(root, 'none.json') });
    expect(await svc.channel()).toBe('branch');
    await mergeWriteWorkspaceConfig((config) => {
      config.updateChannel = 'stable';
    });
    expect(await svc.channel()).toBe('stable');
  });

  // Spec §3.1: the user's save > CEZ_UPDATE_* > the image seed > an unmarked (seeded) save.
  describe('precedence, resolved at read time', () => {
    const IMAGE = { remote: 'https://example.invalid/image.git', branch: 'image-branch' };
    let imageSource: string;
    beforeEach(() => {
      imageSource = join(root, 'source.json');
      writeFileSync(imageSource, JSON.stringify({ commit: 'abc', committedAt: '', ...IMAGE }));
    });
    const svc = (extra: NodeJS.ProcessEnv = {}, file = imageSource) =>
      new SelfUpdateService({ pkgName: 'x', version: '0.17.0', entry: '/x', restart: () => {}, env: { ...env, ...extra }, imageSourceFile: file });
    /** What the pre-fix boot seed wrote: indistinguishable from a save, so it must not count as one. */
    const legacySeed = (branch: { remote: string; branch: string }) =>
      mergeWriteWorkspaceConfig((config) => {
        config.updateChannel = 'branch';
        config.updateBranch = { ...branch };
      });

    it.each([
      // [case, CEZ_UPDATE_CHANNEL, CEZ_UPDATE_BRANCH, image source present, expected channel, expected branch]
      ['the image alone', undefined, undefined, true, 'branch', 'image-branch'],
      ['env channel over the image', 'stable', undefined, true, 'stable', 'image-branch'],
      ['env branch over the image', undefined, `${REMOTE}#env-branch`, true, 'branch', 'env-branch'],
      ['no seed at all', undefined, undefined, false, 'stable', null],
    ] as const)('%s', async (_name, channel, branch, image, wantChannel, wantBranch) => {
      const extra: NodeJS.ProcessEnv = {};
      if (channel) extra.CEZ_UPDATE_CHANNEL = channel;
      else delete env.CEZ_UPDATE_CHANNEL;
      if (branch) extra.CEZ_UPDATE_BRANCH = branch;
      else delete env.CEZ_UPDATE_BRANCH;
      const service = svc(extra, image ? imageSource : join(root, 'none.json'));
      expect(await service.channel()).toBe(wantChannel);
      expect((await service.updateBranch())?.branch ?? null).toBe(wantBranch);
    });

    it('writes nothing at boot: a seed lives only as long as its env or image does', async () => {
      expect(await svc().channel()).toBe('branch');
      expect(existsSync(join(home, 'config.json'))).toBe(false);
    });

    it('an unmarked saved branch channel (an older boot seed) yields to a later env or image', async () => {
      await legacySeed({ remote: REMOTE, branch: 'old-seed' });
      expect(await svc({ CEZ_UPDATE_CHANNEL: 'stable' }).channel()).toBe('stable');
      expect((await svc({ CEZ_UPDATE_BRANCH: `${REMOTE}#new-env` }).updateBranch())?.branch).toBe('new-env');
      // An image rebuilt from another branch is followed.
      expect((await svc().updateBranch())?.branch).toBe('image-branch');
      // With no seed left it is still the only signal, so it is kept.
      const bare = svc({}, join(root, 'none.json'));
      expect(await bare.channel()).toBe('branch');
      expect((await bare.updateBranch())?.branch).toBe('old-seed');
    });

    it('a channel and branch the user saved outrank env and the image', async () => {
      await svc().setChannel('branch', { remote: REMOTE, branch: 'mine' });
      const overridden = svc({ CEZ_UPDATE_CHANNEL: 'stable', CEZ_UPDATE_BRANCH: `${REMOTE}#env-branch` });
      expect(await overridden.channel()).toBe('branch');
      expect((await overridden.updateBranch())?.branch).toBe('mine');
      await svc().setChannel('nightly');
      expect(await svc({ CEZ_UPDATE_CHANNEL: 'branch' }).channel()).toBe('nightly');
    });

    it('a bare channel save keeps following the seed, and drops a stale seeded branch', async () => {
      await legacySeed({ remote: REMOTE, branch: 'old-seed' });
      await svc().setChannel('branch');
      expect(await svc({ CEZ_UPDATE_CHANNEL: 'stable' }).channel()).toBe('branch');
      expect((await svc().updateBranch())?.branch).toBe('image-branch');
    });

    it('a stable/nightly/development save from before the marker still outranks env', async () => {
      await mergeWriteWorkspaceConfig((config) => {
        config.updateChannel = 'nightly';
      });
      expect(await svc({ CEZ_UPDATE_CHANNEL: 'branch' }).channel()).toBe('nightly');
    });
  });

  it('refuses the branch channel when there is no branch to follow', async () => {
    await expect(service().setChannel('branch')).rejects.toThrow(/needs a branch/);
    await service().setChannel('branch', BRANCH);
    expect(await service().updateBranch()).toEqual(BRANCH);
  });
});

describe('the branch status', () => {
  it('counts the commits the running build lacks, and names the docker/ paths they touch', async () => {
    const c1 = commit('feat: one', '2026-10-21T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    commit('build: the image', '2026-10-22T10:00:00Z', { 'docker/Dockerfile': 'FROM node:22\n' });
    const c3 = commit('fix: three', '2026-10-23T10:00:00Z');
    runningBuild(c1, '2026-10-21T10:00:00.000Z');
    await followBranch();
    const status = await service().status({ refresh: true });
    expect(status.channel).toBe('branch');
    expect(status.branch).toMatchObject({
      remote: REMOTE,
      branch: 'brutus',
      running: { sha: c1 },
      tip: { sha: c3, subject: 'fix: three', at: '2026-10-23T10:00:00.000Z' },
      behind: 2,
      fastForward: true,
      touchesImage: ['docker/Dockerfile'],
    });
    expect(status.branch?.fetchedAt).toBeTruthy();
    expect(status.updateAvailable).toBe(`0.17.0+${c3.slice(0, 8)}`);
    expect(status.checkedAt).toBe(status.branch?.fetchedAt);
  });

  it('is up to date on the tip, and reports a force-push as not a fast-forward', async () => {
    const c1 = commit('feat: one', '2026-10-21T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    runningBuild(c1, '2026-10-21T10:00:00.000Z');
    await followBranch();
    const up = await service().status({ refresh: true });
    expect(up.branch).toMatchObject({ behind: 0, fastForward: true, touchesImage: [] });
    expect(up.updateAvailable).toBeNull();

    // Rewrite the branch: a new root commit that does not descend from the running build.
    git(remote, ['checkout', '-q', '--orphan', 'rewritten']);
    commit('feat: rewritten', '2026-10-23T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    git(remote, ['branch', '-q', '-f', 'brutus', 'rewritten']);
    const rewritten = await service().status({ refresh: true });
    expect(rewritten.branch?.fastForward).toBe(false);
    expect(rewritten.branch?.behind).toBeGreaterThan(0);
    expect(rewritten.updateAvailable).toMatch(/^0\.17\.0\+[0-9a-f]{8}$/);
  });

  it('offers the tip as one step when the running build carries no commit', async () => {
    commit('feat: one', '2026-10-21T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    fakeInstall('0.16.0', { version: '0.16.0', source: 'registry', installedAt: '2026-10-01T00:00:00.000Z' });
    activate('0.16.0', env);
    await followBranch();
    const status = await service().status({ refresh: true });
    expect(status.branch).toMatchObject({ running: null, behind: 1, fastForward: false });
  });

  it('keeps the last view and says why when the fetch fails', async () => {
    const c1 = commit('feat: one', '2026-10-21T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    await followBranch();
    const svc = service();
    const before = await svc.status({ refresh: true });
    expect(before.branch?.tip?.sha).toBe(c1);
    rmSync(remote, { recursive: true, force: true }); // "offline", without leaving the machine
    const after = await svc.status({ refresh: true });
    expect(after.branch?.error).toBeTruthy();
    expect(after.branch?.tip?.sha).toBe(c1);
    expect(after.checkedAt).toBe(before.checkedAt);
  });

  it('says why when the branch was never fetched', async () => {
    rmSync(remote, { recursive: true, force: true });
    await followBranch();
    const status = await service().status({ refresh: true });
    expect(status.branch).toMatchObject({ tip: null, behind: 0, fetchedAt: null });
    expect(status.branch?.error).toBeTruthy();
    expect(status.checkedAt).toBeNull();
  });

  it('fetches in the background at most once per interval, and never with CEZ_SELF_UPDATE_CHECK=0', async () => {
    commit('feat: one', '2026-10-21T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    await followBranch();
    const off = new SelfUpdateService({ pkgName: 'x', version: '0.17.0', entry: '/x', restart: () => {}, env: { ...env, CEZ_SELF_UPDATE_CHECK: '0' } });
    off.touch();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(join(home, 'source'))).toBe(false);

    const onUpdateAvailable = vi.fn();
    const on = service({ onUpdateAvailable });
    on.touch();
    await vi.waitFor(() => expect(onUpdateAvailable).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    on.touch();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
  });
});

describe('forward-only on a hosted cockpit, by committer date', () => {
  it('refuses a build committed before the running one, allows a newer one off a rewritten branch the clone never had the running commit of', async () => {
    const c1 = commit('feat: old', '2026-10-20T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    const c2 = commit('feat: running', '2026-10-21T10:00:00Z');
    runningBuild(c2, '2026-10-21T10:00:00.000Z');
    // An older build already on disk, and a newer commit on a rewritten branch.
    fakeInstall(`0.17.0+${c1.slice(0, 8)}`, { version: '0.17.0', source: 'branch', installedAt: '2026-10-20T11:00:00.000Z', commit: { sha: c1, subject: 'feat: old', at: '2026-10-20T10:00:00.000Z', branch: 'brutus' } });
    git(remote, ['checkout', '-q', '--orphan', 'rewritten']);
    const c3 = commit('feat: newer, not a descendant', '2026-10-22T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    git(remote, ['branch', '-q', '-f', 'brutus', 'rewritten']);
    await followBranch();
    const svc = service();
    await svc.status({ refresh: true });
    expect(await svc.forwardOnlyRefusal(`0.17.0+${c1.slice(0, 8)}`)).toMatch(/committed before the running build/);
    expect(await svc.forwardOnlyRefusal(`0.17.0+${c3.slice(0, 8)}`)).toBeNull();
    expect(await svc.forwardOnlyRefusal('0.17.0+deadbeef')).toMatch(/cannot date/);
  });

  it('unknown running commit on hosted refuses an older commit, allows a newer', async () => {
    const older = commit('feat: before the install', '2026-10-20T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    const newer = commit('feat: after the install', '2026-10-22T10:00:00Z');
    // A registry release of the same version, installed between the two commits: no commit to date it by.
    fakeInstall('0.17.0', { version: '0.17.0', source: 'registry', installedAt: '2026-10-21T10:00:00.000Z' });
    activate('0.17.0', env);
    await followBranch();
    const svc = service();
    await svc.status({ refresh: true });
    expect(await svc.forwardOnlyRefusal(`0.17.0+${older.slice(0, 8)}`)).toMatch(/committed before the running 0\.17\.0 was installed/);
    expect(await svc.forwardOnlyRefusal(`0.17.0+${newer.slice(0, 8)}`)).toBeNull();
  });

  it('refuses a newer commit the branch tip does not reach, and one that does not descend from the running build', async () => {
    const c1 = commit('feat: running', '2026-10-21T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    const dropped = commit('feat: force-pushed away', '2026-10-22T10:00:00Z');
    runningBuild(c1, '2026-10-21T10:00:00.000Z');
    await followBranch();
    const svc = service();
    await svc.status({ refresh: true });
    // A rewrite: brutus restarts from an orphan; c1 and `dropped` stay as objects in the clone.
    git(remote, ['checkout', '-q', '--orphan', 'rewritten']);
    const rewritten = commit('feat: newer, not a descendant', '2026-10-23T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    git(remote, ['branch', '-q', '-f', 'brutus', 'rewritten']);
    await svc.status({ refresh: true });
    expect(await svc.forwardOnlyRefusal(`0.17.0+${dropped.slice(0, 8)}`)).toMatch(/is not on brutus/);
    expect(await svc.forwardOnlyRefusal(`0.17.0+${rewritten.slice(0, 8)}`)).toMatch(/does not descend from the running build/);
    // The date rule still comes first.
    git(remote, ['checkout', '-q', 'brutus']);
    const older = commit('feat: dated before the running build', '2026-10-20T10:00:00Z');
    await svc.status({ refresh: true });
    expect(await svc.forwardOnlyRefusal(`0.17.0+${older.slice(0, 8)}`)).toMatch(/committed before the running build/);
  });

  it('never builds a commit the branch tip does not reach, even on a local cockpit', async () => {
    const c1 = commit('feat: one', '2026-10-21T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    const dropped = commit('feat: force-pushed away', '2026-10-22T10:00:00Z');
    runningBuild(c1, '2026-10-21T10:00:00.000Z');
    await followBranch();
    const { calls, deps } = stubs();
    const svc = service(deps);
    await svc.status({ refresh: true });
    git(remote, ['reset', '-q', '--hard', 'HEAD~1']);
    await svc.status({ refresh: true });
    const target = `0.17.0+${dropped.slice(0, 8)}`;
    svc.apply(target);
    await vi.waitFor(async () => expect((await svc.status()).job?.status).toBe('failed'), { timeout: 15_000 });
    expect((await svc.status()).job?.error).toMatch(/is not on brutus/);
    expect(calls).toEqual([]);
  });
});

describe('cezar update on the branch channel', () => {
  it('--check reports the branch and changes nothing; update builds and activates without a restart', async () => {
    const c1 = commit('feat: one', '2026-10-21T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    const c2 = commit('fix: two', '2026-10-23T10:00:00Z');
    const running = runningBuild(c1, '2026-10-21T10:00:00.000Z');
    await followBranch();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void lines.push(String(line ?? '')));
    const { calls, deps } = stubs();
    const restart = vi.fn();
    const svc = service({ ...deps, restart });

    expect(await runSelfUpdateCommand('update', [], { service: svc, modifyPath: false, check: true })).toBe(0);
    expect(lines.join('\n')).toContain('1 commit behind');
    expect(activeId(env)).toBe(running);
    expect(calls).toEqual([]);

    expect(await runSelfUpdateCommand('update', [], { service: svc, modifyPath: false })).toBe(0);
    expect(activeId(env)).toBe(`0.17.0+${c2.slice(0, 8)}`);
    expect(calls).toEqual([`build@${c2.slice(0, 8)}`, 'pack', 'install']);
    expect(restart).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('applying a branch build', () => {
  async function prepared(): Promise<{ running: string; tip: string; target: string }> {
    const c1 = commit('feat: one', '2026-10-21T10:00:00Z', { 'packages/cezar/package.json': pkg() });
    const c2 = commit('fix: two', '2026-10-23T10:00:00Z');
    const running = runningBuild(c1, '2026-10-21T10:00:00.000Z');
    await followBranch();
    return { running, tip: c2, target: `0.17.0+${c2.slice(0, 8)}` };
  }

  it('checks out, builds, packs, installs and activates, in that order, then restarts', async () => {
    const { running, tip, target } = await prepared();
    const { calls, deps } = stubs();
    const restart = vi.fn();
    const svc = service({ ...deps, restart });
    expect((await svc.status({ refresh: true })).updateAvailable).toBe(target);
    svc.apply(target);
    await vi.waitFor(() => expect(restart).toHaveBeenCalled(), { timeout: 15_000 });
    expect(calls).toEqual([`build@${tip.slice(0, 8)}`, 'pack', 'install']);
    expect(activeId(env)).toBe(target);
    expect(previousId(env)).toBe(running);
    expect(readManifest(target, env)).toMatchObject({ source: 'branch', commit: { sha: tip, subject: 'fix: two', branch: 'brutus' } });
  });

  it('leaves current and previous untouched when the build fails', async () => {
    const { running, target } = await prepared();
    fakeInstall('0.16.0', { version: '0.16.0', source: 'registry', installedAt: '2026-09-01T00:00:00.000Z' });
    activate('0.16.0', env);
    activate(running, env); // previous → 0.16.0, current → the running build
    const { deps } = stubs({ failBuild: true });
    const restart = vi.fn();
    const svc = service({ ...deps, restart });
    svc.apply(target);
    await vi.waitFor(async () => expect((await svc.status()).job?.status).toBe('failed'), { timeout: 15_000 });
    expect((await svc.status()).job?.error).toMatch(/build:server failed/);
    expect(activeId(env)).toBe(running);
    expect(previousId(env)).toBe('0.16.0');
    expect(existsSync(join(home, 'versions', target))).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });

  it('keeps the three newest branch builds, never the one it rolls back to', async () => {
    const { running, target } = await prepared();
    // `running` is the OLDEST build on disk and becomes `previous`: it must survive the prune.
    for (const [n, day] of [
      ['11111111', '02'],
      ['22222222', '03'],
      ['33333333', '04'],
    ] as const) {
      fakeInstall(`0.17.0+${n}`, { version: '0.17.0', source: 'branch', installedAt: `2026-10-${day}T00:00:00.000Z`, commit: { sha: n, subject: '', at: `2026-10-${day}T00:00:00.000Z`, branch: 'brutus' } });
    }
    const { deps } = stubs();
    const restart = vi.fn();
    const svc = service({ ...deps, restart });
    svc.apply(target);
    await vi.waitFor(() => expect(restart).toHaveBeenCalled(), { timeout: 15_000 });
    const left = listInstalled(env).filter((entry) => entry.source === 'branch').map((entry) => entry.id);
    expect(left.sort()).toEqual([target, '0.17.0+22222222', '0.17.0+33333333', running].sort());
    expect(readdirSync(join(home, 'versions'))).not.toContain('0.17.0+11111111');
  });

  it('never prunes the build this server runs from, even when current moved under it', async () => {
    const { running, target } = await prepared();
    for (const [n, day] of [
      ['11111111', '02'],
      ['22222222', '03'],
      ['33333333', '04'],
    ] as const) {
      fakeInstall(`0.17.0+${n}`, { version: '0.17.0', source: 'branch', installedAt: `2026-10-${day}T00:00:00.000Z`, commit: { sha: n, subject: '', at: `2026-10-${day}T00:00:00.000Z`, branch: 'brutus' } });
    }
    const { deps } = stubs();
    const restart = vi.fn();
    const svc = service({ ...deps, restart });
    // `cezar use` from a shell while this server runs `running`: neither current nor previous is it.
    activate('0.17.0+33333333', env);
    activate('0.17.0+22222222', env);
    svc.apply(target);
    await vi.waitFor(() => expect(restart).toHaveBeenCalled(), { timeout: 15_000 });
    expect(readdirSync(join(home, 'versions'))).toContain(running);
  });

  it('never builds, or swaps the remote, while another process builds in the clone', async () => {
    const { running, target } = await prepared();
    const { calls, deps } = stubs();
    const svc = service({ ...deps });
    await svc.status({ refresh: true });
    // A live process that is not this one: `cezar update` in another terminal.
    writeFileSync(join(home, 'source.lock'), `${process.ppid}\n${Date.now()}\n`);
    svc.apply(target);
    await vi.waitFor(async () => expect((await svc.status()).job?.status).toBe('failed'), { timeout: 15_000 });
    expect((await svc.status()).job?.error).toMatch(/another cezar \(pid \d+\) is building/);
    expect(calls).toEqual([]);
    expect(activeId(env)).toBe(running);

    await mergeWriteWorkspaceConfig((config) => {
      config.updateBranch = { remote: 'https://example.invalid/someone-else/cezar.git', branch: 'brutus' };
    });
    const status = await svc.status({ refresh: true });
    expect(status.branch?.error).toMatch(/a build is running in the updater's clone/);
    expect(git(join(home, 'source'), ['config', '--get', 'remote.origin.url'])).toBe(REMOTE);
  });

  it('builds from a clean tree: an earlier build\'s output goes, node_modules stays', async () => {
    const { tip } = await prepared();
    const svc = service();
    await svc.status({ refresh: true });
    const clone = join(home, 'source');
    await svc.source.checkout(tip);
    for (const leftover of ['packages/cezar/dist/stale.js', 'node_modules/dep/index.js', 'packages/cezar/node_modules/dep/index.js']) {
      mkdirSync(join(clone, leftover, '..'), { recursive: true });
      writeFileSync(join(clone, leftover), '');
    }
    await svc.source.checkout(tip);
    expect(existsSync(join(clone, 'packages/cezar/dist/stale.js'))).toBe(false);
    expect(existsSync(join(clone, 'node_modules/dep/index.js'))).toBe(true);
    expect(existsSync(join(clone, 'packages/cezar/node_modules/dep/index.js'))).toBe(true);
  });

  it('takes over a lock its dead holder left behind', async () => {
    const { target } = await prepared();
    const { deps } = stubs();
    const restart = vi.fn();
    writeFileSync(join(home, 'source.lock'), `999999\n${Date.now()}\n`);
    service({ ...deps, restart }).apply(target);
    await vi.waitFor(() => expect(restart).toHaveBeenCalled(), { timeout: 15_000 });
    expect(activeId(env)).toBe(target);
    expect(existsSync(join(home, 'source.lock'))).toBe(false);
  });

  it('takes over a lock naming its own pid that an earlier process left (a container restart)', async () => {
    const { target } = await prepared();
    const { deps } = stubs();
    const restart = vi.fn();
    writeFileSync(join(home, 'source.lock'), `${process.pid}\n${Date.now()}\n`);
    service({ ...deps, restart }).apply(target);
    await vi.waitFor(() => expect(restart).toHaveBeenCalled(), { timeout: 15_000 });
    expect(activeId(env)).toBe(target);
  });

  it('counts its own lock as held, and only its own', () => {
    const release = service().source.lock(BRANCH);
    expect(sourceLockHolder(env)).toBe(process.pid);
    release();
    expect(sourceLockHolder(env)).toBeNull();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'source.lock'), `${process.pid}\n${Date.now()}\n\nsomeone-else\n`);
    expect(sourceLockHolder(env)).toBeNull();
  });

  it('takes a stale lock over atomically: one winner, and a fresh lock is never moved or removed', () => {
    mkdirSync(home, { recursive: true });
    const path = sourceLockPath(env);
    const stale = `999999
${Date.now()}
`;
    writeFileSync(path, stale);
    // Two processes judged it stale; the second finds it already moved and does nothing.
    takeOverStaleLock(path, stale);
    expect(existsSync(path)).toBe(false);
    expect(() => takeOverStaleLock(path, stale)).not.toThrow();
    // A winner's fresh lock, moved by a loser that read the stale one: it goes back.
    const fresh = `${process.ppid}
${Date.now()}

winner
`;
    writeFileSync(path, fresh);
    takeOverStaleLock(path, stale);
    expect(readFileSync(path, 'utf8')).toBe(fresh);
    expect(readdirSync(home).filter((name) => name.endsWith('.stale'))).toEqual([]);
    // Our release leaves a lock someone else holds now.
    rmSync(path);
    const release = service().source.lock(BRANCH);
    writeFileSync(path, fresh);
    release();
    expect(readFileSync(path, 'utf8')).toBe(fresh);
  });

  it.runIf(process.platform === 'linux')('treats a live pid that started at another time as a recycled pid', () => {
    mkdirSync(home, { recursive: true });
    const start = processStartTicks(process.ppid);
    writeFileSync(join(home, 'source.lock'), `${process.ppid}\n${Date.now()}\n${start}\nx\n`);
    expect(sourceLockHolder(env)).toBe(process.ppid);
    writeFileSync(join(home, 'source.lock'), `${process.ppid}\n${Date.now()}\n${Number(start) + 1}\nx\n`);
    expect(sourceLockHolder(env)).toBeNull();
  });

  it('builds at once but switches only when the workspace is idle', async () => {
    const { target } = await prepared();
    const { calls, deps } = stubs();
    const restart = vi.fn();
    let idle = false;
    const svc = service({ ...deps, restart, idlePollMs: 50, runs: { activeRuns: () => (idle ? 0 : 1), idle: () => idle } });
    svc.apply(target);
    await vi.waitFor(async () => expect((await svc.status()).scheduled?.target).toBe(target), { timeout: 15_000 });
    expect(calls).toContain('install');
    expect((await svc.status()).job).toBeNull();
    expect(restart).not.toHaveBeenCalled();
    idle = true;
    await vi.waitFor(() => expect(restart).toHaveBeenCalled(), { timeout: 5_000 });
    expect(activeId(env)).toBe(target);
  });
});
